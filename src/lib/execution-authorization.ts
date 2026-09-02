import { createHash } from 'node:crypto'
import { getDatabase, db_helpers } from './db'
import type { ProjectRoutingPolicy } from './project-command'
import {
  DEFAULT_EXECUTION_POLICY,
  buildExecutionPlan,
  classifyExecutionCost,
  costRequiresApproval,
  isAgentOSGatedTask,
  type ExecutionCostClass,
  type ExecutionPlan,
  type ExecutionPolicy,
} from './execution-planning'

/**
 * AgentOS execution authorization — durable approvals bound to an exact
 * execution-plan fingerprint.
 *
 * Approval applies ONLY to the snapshot that was reviewed. If routing changes
 * materially afterwards (different specialist/provider/model/runtime, a new
 * mission, or a changed cost class) the fingerprint no longer matches and the
 * approval is STALE — cost-bearing work stays held and a fresh preview is
 * required. FREE_LOCAL missions allowed by project policy continue normally.
 *
 * The scheduler/background dispatcher calls authorizeAgentOSTaskDispatch in the
 * real claim path; this is not a UI-only guard.
 */

export const EXECUTION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000 // default 24h

export interface ExecutionApprovalRecord {
  id: number
  approvalId: string
  objectiveId: number
  projectId: number
  workspaceId: number
  approvedBy: string
  approvedAt: number
  approvedTaskIds: number[]
  excludedTaskIds: number[]
  fingerprint: string
  maxAuthorizedAmount: number | null
  expiresAt: number | null
  createdAt: number
}

// ---------------------------------------------------------------------------
// Policy read/write (Phase 6)
// ---------------------------------------------------------------------------

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value)
      ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim().toLowerCase()).filter(Boolean))]
      : []
  } catch {
    return []
  }
}

export function executionPolicyOf(projectId: number, workspaceId: number): ExecutionPolicy {
  const db = getDatabase()
  const row = db.prepare(
    `SELECT allow_free_local_without_approval, allow_free_remote_without_approval,
            allow_paid_without_approval, max_approved_estimated_cost,
            approved_providers_json, blocked_providers_json
     FROM agentos_project_command WHERE project_id = ? AND workspace_id = ?`,
  ).get(projectId, workspaceId) as Record<string, unknown> | undefined
  if (!row) return { ...DEFAULT_EXECUTION_POLICY }
  return {
    allowFreeLocalWithoutApproval: row.allow_free_local_without_approval === 1 || row.allow_free_local_without_approval === true,
    allowFreeRemoteWithoutApproval: row.allow_free_remote_without_approval === 1 || row.allow_free_remote_without_approval === true,
    allowPaidWithoutApproval: row.allow_paid_without_approval === 1 || row.allow_paid_without_approval === true,
    maxApprovedEstimatedCost: row.max_approved_estimated_cost === null || row.max_approved_estimated_cost === undefined
      ? null
      : Number(row.max_approved_estimated_cost),
    approvedProviders: parseList(row.approved_providers_json as string | null | undefined),
    blockedProviders: parseList(row.blocked_providers_json as string | null | undefined),
  }
}

export function mergeExecutionPolicy(
  command: ProjectRoutingPolicy,
  patch: Partial<ExecutionPolicy>,
): ProjectRoutingPolicy {
  return {
    ...command,
    allowFreeLocalWithoutApproval: patch.allowFreeLocalWithoutApproval ?? command.allowFreeLocalWithoutApproval ?? true,
    allowFreeRemoteWithoutApproval: patch.allowFreeRemoteWithoutApproval ?? command.allowFreeRemoteWithoutApproval ?? false,
    allowPaidWithoutApproval: patch.allowPaidWithoutApproval ?? command.allowPaidWithoutApproval ?? false,
    maxApprovedEstimatedCost: patch.maxApprovedEstimatedCost === undefined ? (command.maxApprovedEstimatedCost ?? null) : patch.maxApprovedEstimatedCost,
    approvedProviders: patch.approvedProviders ? [...new Set(patch.approvedProviders)] : (command.approvedProviders || []),
    blockedProviders: patch.blockedProviders ? [...new Set(patch.blockedProviders)] : (command.blockedProviders || []),
  }
}



// ---------------------------------------------------------------------------
// Approval records (Phase 7)
// ---------------------------------------------------------------------------

export function latestApprovalForObjective(objectiveId: number, workspaceId: number): ExecutionApprovalRecord | null {
  const rows = getDatabase().prepare(
    `SELECT * FROM agentos_execution_approvals
     WHERE objective_id = ? AND workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 5`,
  ).all(objectiveId, workspaceId) as Array<Record<string, unknown>>
  const now = Date.now()
  for (const row of rows) {
    const expiresAt = row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at)
    if (expiresAt !== null && now > expiresAt * 1000) continue
    return rowToApproval(row)
  }
  return null
}

function rowToApproval(row: Record<string, unknown>): ExecutionApprovalRecord {
  const parseIds = (raw: unknown): number[] => {
    try {
      const value = JSON.parse(String(raw || '[]'))
      return Array.isArray(value) ? value.map(Number).filter(Number.isInteger) : []
    } catch {
      return []
    }
  }
  return {
    id: Number(row.id),
    approvalId: String(row.approval_id),
    objectiveId: Number(row.objective_id),
    projectId: Number(row.project_id),
    workspaceId: Number(row.workspace_id),
    approvedBy: String(row.approved_by),
    approvedAt: Number(row.approved_at),
    approvedTaskIds: parseIds(row.approved_task_ids_json),
    excludedTaskIds: parseIds(row.excluded_task_ids_json),
    fingerprint: String(row.fingerprint),
    maxAuthorizedAmount: row.max_authorized_amount === null || row.max_authorized_amount === undefined
      ? null
      : Number(row.max_authorized_amount),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at) * 1000,
    createdAt: Number(row.created_at),
  }
}

export type ApprovalStatus =
  | 'NONE'
  | 'VALID'
  | 'STALE'
  | 'EXPIRED'

export function approvalStatusForPlan(approval: ExecutionApprovalRecord | null, currentPlan: ExecutionPlan): ApprovalStatus {
  if (!approval) return 'NONE'
  const now = Date.now()
  if (approval.expiresAt !== null && now > approval.expiresAt) return 'EXPIRED'
  if (approval.fingerprint !== currentPlan.fingerprint) return 'STALE'
  return 'VALID'
}

// ---------------------------------------------------------------------------
// Creating an approval (Phase 7/10)
// ---------------------------------------------------------------------------

function objectiveRow(objectiveId: number, workspaceId: number): { project_id: number; status: string } | null {
  const row = getDatabase().prepare(
    'SELECT project_id, status FROM agentos_objectives WHERE id = ? AND workspace_id = ?',
  ).get(objectiveId, workspaceId) as { project_id: number; status: string } | undefined
  return row || null
}

export interface ApproveExecutionInput {
  objectiveId: number
  workspaceId: number
  actor: string
  /** 'all-eligible' approves every mission that needs approval under policy; otherwise explicit task id list. */
  approveTaskIds?: number[] | 'all-eligible'
  /** Missions deliberately excluded (partial approval). */
  excludeTaskIds?: number[]
  expiresInHours?: number
  maxAuthorizedAmount?: number | null
}

export interface ApproveExecutionResult {
  ok: boolean
  approval?: ExecutionApprovalRecord
  plan?: ExecutionPlan
  errors?: string[]
  approved: number[]
  excluded: number[]
  heldByDependency: number[]
  partiallyApproved: boolean
  message: string
}

/**
 * Approve (optionally a subset of) missions of an objective. The approval is
 * bound to the fingerprint of the plan computed at approval time — any later
 * material routing change invalidates it (Phase 8). Missions whose cost class
 * is FREE_LOCAL and allowed by policy never need an approval entry.
 */
export function createExecutionApproval(input: ApproveExecutionInput): ApproveExecutionResult {
  const errors: string[] = []
  const objective = objectiveRow(input.objectiveId, input.workspaceId)
  if (!objective) return { ok: false, errors: ['Objective not found'], approved: [], excluded: [], heldByDependency: [], partiallyApproved: false, message: 'Objective not found' }
  if (objective.status === 'completed' || objective.status === 'cancelled') {
    return { ok: false, errors: [`Objective is ${objective.status}`], approved: [], excluded: [], heldByDependency: [], partiallyApproved: false, message: 'Cannot approve a finished objective' }
  }

  const policy = executionPolicyOf(objective.project_id, input.workspaceId)
  const plan = buildExecutionPlan({ objectiveId: input.objectiveId, workspaceId: input.workspaceId, policy, actor: input.actor })

  const needsApproval = plan.missions.filter(mission => mission.requiresApproval)
  const eligibleIds = needsApproval.map(mission => mission.taskId)
  const excludeSet = new Set((input.excludeTaskIds || []).map(Number))
  const requested = input.approveTaskIds === 'all-eligible'
    ? eligibleIds
    : (input.approveTaskIds || []).map(Number)

  const approved: number[] = []
  const heldByDependency: number[] = []
  const approvedKeys = new Set<string>()
  for (const mission of plan.missions) {
    if (!mission.requiresApproval) continue
    if (!requested.includes(mission.taskId)) continue
    if (excludeSet.has(mission.taskId)) continue
    // Dependencies: a mission whose dependencies are NOT approved cannot be
    // meaningfully approved — hold it (Phase 10).
    const depsApproved = mission.dependencies.every(key => {
      const depMission = plan.missions.find(candidate => candidate.missionKey === key)
      if (!depMission) return true
      if (!depMission.requiresApproval) return true
      return approved.includes(depMission.taskId) || requested.includes(depMission.taskId)
    })
    if (!depsApproved) {
      heldByDependency.push(mission.taskId)
      continue
    }
    approved.push(mission.taskId)
    approvedKeys.add(mission.missionKey)
  }
  if (approved.length === 0) {
    return {
      ok: false,
      errors: ['No missions selected for approval (all remaining missions are either free/local under policy or were excluded)'],
      approved: [],
      excluded: [...excludeSet],
      heldByDependency,
      partiallyApproved: false,
      message: 'Nothing to approve',
    }
  }

  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const approvalId = `apv-${createHash('sha256').update(`${input.objectiveId}|${input.workspaceId}|${now}|${Math.random()}`).digest('hex').slice(0, 12)}`
  const expiresAt = input.expiresInHours ? now + Math.round(input.expiresInHours * 3600) : now + Math.round(EXECUTION_APPROVAL_TTL_MS / 1000)
  const excluded = [...excludeSet].filter(id => eligibleIds.includes(id))
  db.prepare(`
    INSERT INTO agentos_execution_approvals (
      approval_id, objective_id, project_id, workspace_id, approved_by, approved_at,
      approved_task_ids_json, excluded_task_ids_json, fingerprint,
      max_authorized_amount, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    approvalId,
    input.objectiveId,
    objective.project_id,
    input.workspaceId,
    input.actor,
    now,
    JSON.stringify(approved),
    JSON.stringify(excluded),
    plan.fingerprint,
    input.maxAuthorizedAmount ?? null,
    expiresAt,
    now,
  )
  const approval = latestApprovalForObjective(input.objectiveId, input.workspaceId)!
  const partiallyApproved = approved.length < eligibleIds.length
  db_helpers.logActivity(
    partiallyApproved ? 'execution_partially_approved' : 'execution_approved',
    'project',
    objective.project_id,
    input.actor,
    `${partiallyApproved ? 'Partially approved' : 'Approved'} execution for objective ${input.objectiveId} (${approved.length}/${plan.missions.length} missions)`,
    {
      objective_id: input.objectiveId,
      approval_id: approvalId,
      approved_task_ids: approved,
      excluded_task_ids: excluded,
      fingerprint: plan.fingerprint,
      cost_classes: Object.fromEntries(plan.missions.map(mission => [String(mission.taskId), mission.costClass])),
    },
    input.workspaceId,
  )
  return {
    ok: true,
    approval,
    plan,
    errors: [],
    approved,
    excluded,
    heldByDependency,
    partiallyApproved,
    message: partiallyApproved
      ? `Approved ${approved.length} mission(s); ${eligibleIds.length - approved.length} still require approval`
      : `Approved all ${approved.length} mission(s)`,
  }
}

export function denyExecutionPlan(input: {
  objectiveId: number
  workspaceId: number
  actor: string
  reason?: string | null
}): { ok: boolean; message: string } {
  const objective = objectiveRow(input.objectiveId, input.workspaceId)
  if (!objective) return { ok: false, message: 'Objective not found' }
  db_helpers.logActivity('execution_approval_denied', 'project', objective.project_id, input.actor,
    input.reason ? `Execution denied for objective ${input.objectiveId}: ${input.reason}` : `Execution denied for objective ${input.objectiveId}`,
    { objective_id: input.objectiveId },
    input.workspaceId,
  )
  return { ok: true, message: 'Execution plan denied (recorded); no dispatch will occur' }
}

// ---------------------------------------------------------------------------
// Dispatch authorization (Phase 9) — called from the real claim path
// ---------------------------------------------------------------------------

export interface DispatchAuthorization {
  allowed: boolean
  held?: boolean
  reason?: string
  costClass?: ExecutionCostClass
  approvalStatus?: ApprovalStatus
  approvalId?: string | null
}

export interface DispatchTaskLike {
  id: number
  project_id: number | null
  workspace_id: number
  assigned_to: string | null
  metadata: string | null
}

/**
 * Authorization guard for the dispatcher. Ordering is preserved by the caller:
 * project command guard → concurrency guard → THIS execution authorization →
 * atomic claim → delegation → native dispatch.
 *
 * Only AgentOS-gated work (objective missions incl. deep reviews, knowledge
 * curation) is checked. FREE_LOCAL missions allowed by project policy pass
 * through untouched. PAID/UNKNOWN-cost missions pass only with a VALID,
 * fingerprint-matching approval covering the task; otherwise they stay safely
 * 'assigned' (never claimed / never in_progress) and the hold is logged.
 */
export function authorizeAgentOSTaskDispatch(
  task: DispatchTaskLike,
  db = getDatabase(),
): DispatchAuthorization {
  const metadata = (() => {
    try {
      const parsed = JSON.parse(task.metadata || '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  })()
  if (!isAgentOSGatedTask(metadata)) return { allowed: true }

  const projectId = task.project_id
  if (!projectId) {
    // No project context — cannot evaluate policy; hold to stay safe.
    return { allowed: false, held: true, reason: 'AgentOS-gated task has no project context for execution policy' }
  }
  const policy = executionPolicyOf(projectId, task.workspace_id)

  const objectiveId = (() => {
    const agentos = metadata.agentos
    if (typeof agentos?.objectiveId === 'number') return agentos.objectiveId
    if (typeof metadata.agentos_resource_review?.objective_id === 'number') return metadata.agentos_resource_review.objective_id
    if (typeof metadata.agentos_knowledge_curation?.objective_id === 'number') return metadata.agentos_knowledge_curation.objective_id
    return null
  })()
  if (objectiveId === null) return { allowed: true }

  // Runtime metadata from the assigned agent row.
  let agentRuntime: string | null = null
  let agentConfig: Record<string, unknown> | null = null
  if (task.assigned_to) {
    const agent = db.prepare('SELECT runtime_type, config FROM agents WHERE name = ? AND workspace_id = ?')
      .get(task.assigned_to, task.workspace_id) as { runtime_type: string | null; config: string | null } | undefined
    agentRuntime = agent?.runtime_type ?? null
    if (agent?.config) {
      try {
        const parsed = JSON.parse(agent.config)
        if (parsed && typeof parsed === 'object') agentConfig = parsed
      } catch { agentConfig = null }
    }
  }

  const annotation = metadata.agentos_execution && typeof metadata.agentos_execution === 'object' ? metadata.agentos_execution : {}
  const classified = classifyExecutionCost({
    runtimeType: agentRuntime,
    provider: typeof annotation.provider === 'string' ? annotation.provider : null,
    model: typeof annotation.model === 'string' ? annotation.model : null,
    costClassOverride: typeof annotation.costClass === 'string' ? annotation.costClass as ExecutionCostClass : null,
    estimatedCost: typeof annotation.estimatedCost === 'number' && Number.isFinite(annotation.estimatedCost) ? annotation.estimatedCost : null,
    agentConfig,
  })
  const { costClass } = classified
  const provider = (classified.provider || '').toLowerCase()

  if (policy.blockedProviders.includes(provider)) {
    return {
      allowed: false,
      held: true,
      reason: `Provider ${provider} is blocked by project execution policy`,
      costClass,
      approvalStatus: 'NONE',
    }
  }
  const providerPreapproved = provider !== '' && policy.approvedProviders.includes(provider)

  if (!costRequiresApproval(costClass, policy) || providerPreapproved) {
    return { allowed: true, costClass, approvalStatus: 'NONE' }
  }

  const approval = latestApprovalForObjective(objectiveId, task.workspace_id)
  let plan: ExecutionPlan | null = null
  try {
    plan = buildExecutionPlan({ objectiveId, workspaceId: task.workspace_id, policy, actor: 'agentos' })
  } catch {
    // Objective plan could not be rebuilt — treat as held to avoid unapproved spend.
  }
  if (!approval || !plan) {
    logExecutionHeld(task, costClass, approval, 'No valid execution approval for cost-bearing mission', db)
    return { allowed: false, held: true, reason: `Mission requires approval (${costClass}) — no valid approval on file`, costClass, approvalStatus: 'NONE' }
  }
  const status = approvalStatusForPlan(approval, plan)
  if (status !== 'VALID') {
    logExecutionHeld(task, costClass, approval, status === 'EXPIRED' ? 'Approval has expired' : 'Approval stale — routing changed; regenerate the execution preview', db)
    return {
      allowed: false,
      held: true,
      reason: status === 'EXPIRED' ? 'Approval expired — request a new one' : 'Approval stale — routing changed; regenerate the execution preview',
      costClass,
      approvalStatus: status,
      approvalId: approval.approvalId,
    }
  }
  if (!approval.approvedTaskIds.includes(task.id)) {
    logExecutionHeld(task, costClass, approval, 'Mission not included in the approved execution snapshot', db)
    return {
      allowed: false,
      held: true,
      reason: 'This mission was not approved in the execution snapshot',
      costClass,
      approvalStatus: 'VALID',
      approvalId: approval.approvalId,
    }
  }
  if (approval.maxAuthorizedAmount !== null && classified.estimatedCost !== null && classified.estimatedCost > approval.maxAuthorizedAmount) {
    logExecutionHeld(task, costClass, approval, 'Estimated cost exceeds the approved maximum', db)
    return {
      allowed: false,
      held: true,
      reason: `Estimated cost ${classified.estimatedCost} exceeds approved maximum ${approval.maxAuthorizedAmount}`,
      costClass,
      approvalStatus: 'VALID',
      approvalId: approval.approvalId,
    }
  }
  return { allowed: true, costClass, approvalStatus: 'VALID', approvalId: approval.approvalId }
}

function logExecutionHeld(
  task: DispatchTaskLike,
  costClass: ExecutionCostClass,
  approval: ExecutionApprovalRecord | null,
  reason: string,
  db: ReturnType<typeof getDatabase>,
): void {
  try {
    db_helpers.logActivity('agentos_execution_approval_held', 'task', task.id, 'agentos',
      `Execution held (${costClass}): ${reason}`,
      {
        objective_id: approval?.objectiveId ?? null,
        task_id: task.id,
        cost_class: costClass,
        approval_id: approval?.approvalId ?? null,
      },
      task.workspace_id,
    )
  } catch {
    // Activity logging must never break dispatch.
  }
}
