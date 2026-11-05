import { getDatabase, db_helpers } from './db'

/**
 * Generic AgentOS escalation foundation.
 *
 * Work that automation cannot safely finish gets a normalized NEEDS_MANUAL
 * escalation instead of a generic failed state. Any AgentOS workflow can use
 * this service: resource deep reviews, project objectives, cross-platoon
 * missions, failed native-runtime work, knowledge curation, capability
 * acquisition. Domain adapters (e.g. resource-deep-review.ts) stay thin and
 * only decide WHEN to escalate; this module decides WHAT an escalation is.
 */

export const ESCALATION_REASONS = [
  'reviewer_unavailable',
  'repeated_dispatch_failure',
  'invalid_structured_output',
  'stale_resource',
  'inaccessible_resource_path',
  'runtime_incompatible',
  'policy_conflict',
  'approval_required',
  'ambiguous_capability',
  'registry_validation_failure',
  'concurrency_blocked_too_long',
  'missing_resource',
  'unsupported_action',
] as const
export type EscalationReason = (typeof ESCALATION_REASONS)[number]

export type EscalationCategory =
  | 'RETRYABLE'        // transient; retry before escalating
  | 'MANUAL_REQUIRED'  // a human must decide
  | 'STALE'            // the work's subject changed; fresh work required
  | 'WAITING_APPROVAL' // not an error — awaiting a human decision
  | 'TERMINAL_FAILURE' // the work cannot ever succeed

export const REASON_CATEGORY: Record<EscalationReason, EscalationCategory> = {
  reviewer_unavailable: 'MANUAL_REQUIRED',
  repeated_dispatch_failure: 'MANUAL_REQUIRED',
  invalid_structured_output: 'MANUAL_REQUIRED',
  stale_resource: 'STALE',
  inaccessible_resource_path: 'MANUAL_REQUIRED',
  runtime_incompatible: 'MANUAL_REQUIRED',
  policy_conflict: 'MANUAL_REQUIRED',
  approval_required: 'WAITING_APPROVAL',
  ambiguous_capability: 'MANUAL_REQUIRED',
  registry_validation_failure: 'MANUAL_REQUIRED',
  concurrency_blocked_too_long: 'RETRYABLE',
  missing_resource: 'MANUAL_REQUIRED',
  unsupported_action: 'TERMINAL_FAILURE',
}

/** Safe follow-on actions AgentOS may OFFER for a reason. Never auto-executed. */
export const REASON_RECOMMENDED_ACTIONS: Record<EscalationReason, string[]> = {
  reviewer_unavailable: ['retry-review', 'select-different-reviewer'],
  repeated_dispatch_failure: ['retry-review', 'select-different-reviewer'],
  invalid_structured_output: ['retry-review', 'request-new-review'],
  stale_resource: ['retry-review', 'request-new-review'],
  inaccessible_resource_path: ['open-resource', 'rescan-resource', 'mark-manual-only'],
  runtime_incompatible: ['open-resource', 'mark-manual-only', 'reject-candidate'],
  policy_conflict: ['resolve-policy-conflict', 'approve-anyway', 'reject-candidate'],
  approval_required: ['approve', 'reject', 'mark-manual-only'],
  ambiguous_capability: ['request-new-review', 'select-different-reviewer'],
  registry_validation_failure: ['resolve-policy-conflict', 'rescan-resource'],
  concurrency_blocked_too_long: ['retry-review'],
  missing_resource: ['rescan-resource', 'dismiss-duplicate', 'reject-candidate'],
  unsupported_action: ['reject-candidate', 'dismiss-duplicate'],
}

export function classifyEscalation(reason: EscalationReason): EscalationCategory {
  return REASON_CATEGORY[reason] || 'MANUAL_REQUIRED'
}

export interface AgentOSEscalationRecord {
  state: 'NEEDS_MANUAL'
  category: EscalationCategory
  reason: EscalationReason
  summary: string
  recommended_actions: string[]
  created_at: string
  last_attempt_at: string
  attempts: number
  task_id: number | null
  objective_id: number | null
  delegation_id: string | null
  resource_id: string | null
  resolved_at: string | null
}

function parseMetadata(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Read the escalation record from a task's metadata (null when not escalated). */
export function readTaskEscalation(taskMetadata: string | null | undefined): AgentOSEscalationRecord | null {
  const meta = parseMetadata(taskMetadata)
  const escalation = meta.agentos_escalation
  if (!escalation || typeof escalation !== 'object') return null
  if (escalation.resolved_at) return null
  return escalation as AgentOSEscalationRecord
}

export function escalateTask(input: {
  workspaceId: number
  taskId: number
  reason: EscalationReason
  summary: string
  objectiveId?: number | null
  delegationId?: string | null
  resourceId?: string | null
  attempts?: number
  actor?: string | null
}): AgentOSEscalationRecord {
  const db = getDatabase()
  const row = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(input.taskId, input.workspaceId) as { metadata: string | null } | undefined
  if (!row) throw new Error(`Task ${input.taskId} not found`)
  const metadata = parseMetadata(row.metadata)
  const existing = metadata.agentos_escalation as Record<string, unknown> | undefined
  // Idempotent: keep the original escalation rather than resetting attempts/timestamps.
  if (existing && existing.state === 'NEEDS_MANUAL' && existing.reason === input.reason) {
    return existing as unknown as AgentOSEscalationRecord
  }
  const now = new Date().toISOString()
  const record: AgentOSEscalationRecord = {
    state: 'NEEDS_MANUAL',
    category: classifyEscalation(input.reason),
    reason: input.reason,
    summary: input.summary,
    recommended_actions: REASON_RECOMMENDED_ACTIONS[input.reason],
    created_at: existing?.created_at ? String(existing.created_at) : now,
    last_attempt_at: now,
    attempts: Math.max(1, input.attempts ?? Number(existing?.attempts || 0)),
    task_id: input.taskId,
    objective_id: input.objectiveId ?? null,
    delegation_id: input.delegationId ?? null,
    resource_id: input.resourceId ?? null,
    resolved_at: null,
  }
  metadata.agentos_escalation = record
  db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(metadata), Math.floor(Date.now() / 1000), input.taskId, input.workspaceId)
  db_helpers.logActivity(
    'agentos_escalation_needs_manual',
    'task',
    input.taskId,
    input.actor || 'agentos',
    `Escalated to NEEDS_MANUAL (${input.reason}): ${input.summary}`,
    {
      escalation_reason: input.reason,
      escalation_category: record.category,
      objective_id: record.objective_id,
      delegation_id: record.delegation_id,
      resource_id: record.resource_id,
    },
    input.workspaceId,
  )
  return record
}

/** Clear a task's escalation. Returns true when an escalation was actually cleared. */
export function resolveTaskEscalation(input: {
  workspaceId: number
  taskId: number
  actor?: string | null
  note?: string | null
}): boolean {
  const db = getDatabase()
  const row = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(input.taskId, input.workspaceId) as { metadata: string | null } | undefined
  if (!row) return false
  const metadata = parseMetadata(row.metadata)
  const existing = metadata.agentos_escalation as AgentOSEscalationRecord | undefined
  if (!existing || existing.state !== 'NEEDS_MANUAL') return false
  existing.resolved_at = new Date().toISOString()
  metadata.agentos_escalation = existing
  db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(metadata), Math.floor(Date.now() / 1000), input.taskId, input.workspaceId)
  db_helpers.logActivity(
    'agentos_escalation_resolved',
    'task',
    input.taskId,
    input.actor || 'agentos',
    input.note || `Escalation resolved (was ${existing.reason})`,
    {
      escalation_reason: existing.reason,
      objective_id: existing.objective_id,
      delegation_id: existing.delegation_id,
    },
    input.workspaceId,
  )
  return true
}

/**
 * Mirror an escalation (or its absence) onto an objective's plan_json so the
 * objective lifecycle surfaces it without re-reading every mission task.
 */
export function syncObjectiveEscalation(
  workspaceId: number,
  objectiveId: number,
  escalation: object | null,
): void {
  const db = getDatabase()
  const row = db.prepare('SELECT plan_json FROM agentos_objectives WHERE id = ? AND workspace_id = ?')
    .get(objectiveId, workspaceId) as { plan_json: string } | undefined
  if (!row) return
  let plan: Record<string, unknown> = {}
  try { plan = JSON.parse(row.plan_json || '{}') } catch { plan = {} }
  if (escalation === null) {
    if (!plan.agentos_escalation) return
    delete plan.agentos_escalation
  } else {
    plan.agentos_escalation = escalation
  }
  db.prepare('UPDATE agentos_objectives SET plan_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(plan), Math.floor(Date.now() / 1000), objectiveId, workspaceId)
}