import { getDatabase } from '@/lib/db'
import {
  approvalStatusForPlan,
  latestApprovalForObjective,
  type ApprovalStatus,
} from '@/lib/execution-authorization'
import type { ExecutionPlan } from '@/lib/execution-planning'

/**
 * Canonical cross-project read model for the Approval Center.
 *
 * Lists every objective whose latest stored execution plan requires approval
 * and is not currently covered by a VALID approval. This is a display read
 * model only: the authoritative fingerprint re-check happens at approve time
 * inside `approveExecutionPlan` (the plan is regenerated there and a stale
 * request is refused), so the UI can never silently authorize a changed plan.
 *
 * Sources (real state only, never frontend assumptions):
 *   - `agentos_execution_plans` — latest stored plan row per objective
 *   - `agentos_execution_approvals` — latest unexpired approval per objective
 *   - `agentos_objectives` / `projects` — display identity
 */

export interface ApprovalMissionSummary {
  taskId: number
  title: string
  assignedTo: string | null
  specialist: string | null
  provider: string | null
  model: string | null
  costClass: string
  estimatedCost: number | null
}

export interface ApprovalCenterItem {
  objectiveId: number
  projectId: number
  projectName: string | null
  objectiveTitle: string | null
  objectiveStatus: string | null
  planStatus: string | null
  planId: string | null
  fingerprint: string | null
  approvalStatus: ApprovalStatus
  approvedBy: string | null
  approvedAt: number | null
  missionCounts: {
    total: number
    free: number
    paid: number
    unknownCost: number
    blocked: number
    requiresApproval: number
  }
  estimatedTotalCost: number | null
  maximumTotalExposure: number | null
  approvalRequiredMissions: ApprovalMissionSummary[]
  createdAt: number | null
  updatedAt: number | null
}

export interface ApprovalCenterSummary {
  total: number
  byStatus: Partial<Record<ApprovalStatus, number>>
}

export interface ApprovalCenterResult {
  items: ApprovalCenterItem[]
  summary: ApprovalCenterSummary
}

/** Ordering weight — the most dangerous states surface first. */
const STATUS_WEIGHT: Record<ApprovalStatus, number> = {
  STALE: 0,
  EXPIRED: 1,
  NONE: 2,
  VALID: 3,
}

export function listApprovalRequiredPlans(
  workspaceId: number,
  opts: { projectId?: number | null; limit?: number } = {},
): ApprovalCenterResult {
  const db = getDatabase()
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 250) : 100

  const projectFilter = opts.projectId != null && Number.isFinite(opts.projectId)
    ? ' AND p.project_id = ?'
    : ''
  const filterParams: number[] = opts.projectId != null && Number.isFinite(opts.projectId)
    ? [workspaceId, Number(opts.projectId)]
    : [workspaceId]

  // Latest stored plan row per objective (the table is upsert-per-objective,
  // so a plain scan is already the latest revision).
  const planRows = db.prepare(`
    SELECT p.objective_id, p.project_id, p.status AS plan_status, p.plan_json,
           p.fingerprint, p.created_at, p.updated_at,
           o.title AS objective_title, o.status AS objective_status,
           pr.name AS project_name
    FROM agentos_execution_plans p
    LEFT JOIN agentos_objectives o ON o.id = p.objective_id AND o.workspace_id = p.workspace_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    WHERE p.workspace_id = ?${projectFilter}
    ORDER BY p.updated_at DESC
  `).all(...filterParams) as Array<Record<string, unknown>>

  const items: ApprovalCenterItem[] = []

  for (const row of planRows) {
    let plan: ExecutionPlan | null = null
    try {
      const parsed = JSON.parse(String(row.plan_json || 'null')) as ExecutionPlan | null
      if (parsed && typeof parsed === 'object' && parsed.summary) plan = parsed
    } catch {
      // Unparseable display cache — skip; the authoritative path regenerates.
      continue
    }
    if (!plan) continue

    const storedStatus = String(row.plan_status || '')
    const approvalRequired = storedStatus === 'AWAITING_APPROVAL' || storedStatus === 'PREVIEW'
      || plan.summary?.approvalRequired === true
    if (!approvalRequired) continue

    const objectiveId = Number(row.objective_id)
    const approval = latestApprovalForObjective(objectiveId, workspaceId)
    const approvalStatus = approvalStatusForPlan(approval, plan)

    // A VALID approval already covers this plan — the work is authorized and
    // belongs to the runs/queued views, not the approval queue.
    if (approvalStatus === 'VALID') continue

    const missions = Array.isArray(plan.missions) ? plan.missions : []
    const missionCounts = {
      total: missions.length,
      free: missions.filter(m => m.costClass === 'FREE_LOCAL').length,
      paid: missions.filter(m => m.costClass === 'PAID_KNOWN' || m.costClass === 'PAID_ESTIMATED').length,
      unknownCost: missions.filter(m => m.costClass === 'UNKNOWN_COST').length,
      blocked: missions.filter(m => m.costClass === 'BLOCKED').length,
      requiresApproval: missions.filter(m => m.requiresApproval).length,
    }

    items.push({
      objectiveId,
      projectId: Number(row.project_id),
      projectName: row.project_name != null ? String(row.project_name) : null,
      objectiveTitle: row.objective_title != null ? String(row.objective_title) : null,
      objectiveStatus: row.objective_status != null ? String(row.objective_status) : null,
      planStatus: storedStatus || null,
      planId: plan.planId ?? null,
      fingerprint: plan.fingerprint || String(row.fingerprint || '') || null,
      approvalStatus,
      approvedBy: approval?.approvedBy ?? null,
      approvedAt: approval?.approvedAt ?? null,
      missionCounts,
      estimatedTotalCost: plan.summary?.estimatedTotalCost ?? null,
      maximumTotalExposure: plan.summary?.maximumTotalExposure ?? null,
      approvalRequiredMissions: missions
        .filter(m => m.requiresApproval)
        .map(m => ({
          taskId: m.taskId,
          title: m.title,
          assignedTo: m.assignedTo ?? null,
          specialist: m.specialist ?? null,
          provider: m.provider ?? null,
          model: m.modelResolved ?? m.model ?? null,
          costClass: m.costClass,
          estimatedCost: m.estimatedCost ?? null,
        })),
      createdAt: row.created_at != null ? Number(row.created_at) : null,
      updatedAt: row.updated_at != null ? Number(row.updated_at) : null,
    })
  }

  items.sort((a, b) => {
    const w = STATUS_WEIGHT[a.approvalStatus] - STATUS_WEIGHT[b.approvalStatus]
    if (w !== 0) return w
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })

  const byStatus: ApprovalCenterSummary['byStatus'] = {}
  for (const item of items) {
    byStatus[item.approvalStatus] = (byStatus[item.approvalStatus] || 0) + 1
  }

  return { items: items.slice(0, limit), summary: { total: items.length, byStatus } }
}
