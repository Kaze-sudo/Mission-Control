/**
 * AgentOS canonical run read model + operator retry.
 *
 * Every AgentOS execution funnels through the existing delegation ledger
 * (`agentos_delegations`, written by the scheduler's `dispatchAssignedTasks`
 * at claim time) which already carries the ecosystem, specialist, routing
 * agent, native run/session ids, attempts, result summaries, and errors.
 * Mission tasks that AgentOS has planned but not yet claimed (queued/held by
 * command state, concurrency policy, or dependency gating) have no delegation
 * row yet — they are still real runs-in-waiting an operator must see.
 *
 * This module is the single normalized read surface for both views:
 *
 *   - Runs / Live Run Control (workspace + per-project activity)
 *   - Agent Registry recent execution history (per routing agent)
 *
 * It performs no discovery and no host checks — only lightweight DB reads —
 * so active-run polling never multiplies the expensive host-detection work.
 *
 * State derivation only maps REAL task + delegation statuses to a display
 * bucket. A run is never reported completed from a dispatch accept; it must
 * reach the terminal statuses the executor/reconciler actually wrote.
 *
 * Mutations live at this service boundary, not in React:
 *
 *   - `retryAgentOSRun` re-enters a terminal FAILED run through current
 *     project routing (fresh specialist selection) and the existing
 *     dispatch-time authorization gate re-runs before anything can execute.
 *     It never bypasses project pause state.
 *
 *   - `cancelAgentOSRun` cancels queued work as a pure DB transition, and
 *     cancels active Gamut runs by terminating the live host session first —
 *     other executors are refused truthfully when they lack a supported
 *     termination path.
 */
import { getDatabase, db_helpers } from './db'
import { getProjectCommand } from './project-command'
import { routeTaskWithinProject } from './project-task-routing'
import { releaseReservationForTask } from './execution-authorization'
import { terminateGamutSession } from './gamut-host'
import { getDelegation, getLatestDelegationForTask, updateDelegation } from './delegation-ledger'
import type { AgentOSDelegation } from './delegation-ledger'

/** Presentation buckets derived from real task/delegation status pairs. */
export type AgentOSRunDisplayState =
  | 'QUEUED'      // assigned/inbox, not yet claimed by a dispatcher
  | 'HELD'        // awaiting_owner — held by command/concurrency policy
  | 'WAITING'     // backlog — dependency-gated mission, deps not done
  | 'RUNNING'     // claimed + executing in the native runtime
  | 'REVIEWING'   // executor returned; quality/review pipeline in progress
  | 'RETRYING'    // a transient dispatch failure is being auto-retried
  | 'COMPLETED'   // task done / delegation completed — real completion only
  | 'FAILED'      // terminal execution or dispatch failure
  | 'CANCELLED'   // delegation cancelled (ledger truth)

export interface AgentOSRun {
  /** Stable run key: delegation uuid, or `task:<id>` for not-yet-claimed work. */
  id: string
  kind: 'delegation' | 'task'
  taskId: number
  taskTitle: string
  projectId: number | null
  projectName: string | null
  objectiveId: number | null
  objectiveTitle: string | null
  objectiveStatus: string | null
  delegationId: string | null
  delegationStatus: string | null
  taskStatus: string
  /** Presentation bucket — derived, never stored. */
  state: AgentOSRunDisplayState
  /** CLI ecosystem / platoon (gamut | hermes | codex | claude | …). */
  ecosystem: string | null
  routingAgentName: string | null
  specialistName: string | null
  attempt: number | null
  nativeSessionId: string | null
  nativeRunId: string | null
  errorClass: string | null
  errorMessage: string | null
  resultSummary: string | null
  createdAt: number | null
  updatedAt: number | null
  completedAt: number | null
  /** Seconds between delegation creation (claim) and completion, when terminal. */
  durationSeconds: number | null
  /** Why a non-running, non-terminal run is not executing (real-state derived). */
  holdReason: string | null
}

export interface AgentOSRunSummary {
  total: number
  byState: Partial<Record<AgentOSRunDisplayState, number>>
}

interface RunTaskRow {
  id: number
  title: string
  status: string
  project_id: number | null
  workspace_id: number
  assigned_to: string | null
  metadata: string | null
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

function objectiveMissionMetadata(metadata: Record<string, any>): {
  objectiveId: number | null
  blocked: boolean
} {
  const agentos = metadata.agentos && typeof metadata.agentos === 'object' ? metadata.agentos : {}
  const objectiveId = typeof agentos.objectiveId === 'number' ? agentos.objectiveId : null
  const blocked = agentos.executionState === 'blocked'
  return { objectiveId, blocked }
}

function durationSeconds(createdAt: number | null, completedAt: number | null): number | null {
  if (createdAt === null || completedAt === null) return null
  if (completedAt < createdAt) return null
  return Math.max(0, completedAt - createdAt)
}

/** Pure mapping: real task + delegation status → presentation bucket. */
export function deriveRunDisplayState(
  taskStatus: string | null | undefined,
  delegationStatus: string | null | undefined,
  options: { dependencyGated?: boolean } = {},
): AgentOSRunDisplayState {
  if (delegationStatus === 'cancelled') return 'CANCELLED'
  if (delegationStatus === 'failed') return 'FAILED'
  switch (taskStatus) {
    case 'done': return 'COMPLETED'
    case 'review':
    case 'quality_review': return 'REVIEWING'
    case 'in_progress': return delegationStatus === 'pending' || delegationStatus === 'accepted'
      ? 'RUNNING'
      : delegationStatus === 'retrying'
        ? 'RETRYING'
        : delegationStatus === 'completed'
          ? 'REVIEWING'
          : 'RUNNING'
    case 'backlog': return options.dependencyGated ? 'WAITING' : 'HELD'
    case 'awaiting_owner': return delegationStatus === 'retrying' ? 'RETRYING' : 'HELD'
    case 'assigned':
    case 'inbox':
      return delegationStatus === 'retrying' ? 'RETRYING' : 'QUEUED'
    case 'failed': return 'FAILED'
    case 'cancelled': return 'CANCELLED'
    default: return delegationStatus === 'completed' ? 'COMPLETED' : 'QUEUED'
  }
}

const ACTIVE_DISPLAY_STATES = new Set<AgentOSRunDisplayState>([
  'QUEUED', 'HELD', 'WAITING', 'RUNNING', 'REVIEWING', 'RETRYING',
])

/** Heuristic error classification over the raw executor diagnostic. */
export function classifyRunError(message: string | null | undefined): string | null {
  if (!message) return null
  const text = String(message).toLowerCase()
  if (text.includes('402') || text.includes('insufficient balance') || text.includes('exhausted credit') || text.includes('billing')) return 'insufficient_balance'
  if (text.includes('401') || text.includes('unauthorized') || text.includes('api key') || text.includes('authentication') || text.includes('invalid api')) return 'authentication'
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout'
  if (text.includes('econnrefused') || text.includes('econnreset') || text.includes('host connection') || text.includes('cannot reach') || text.includes('offline')) return 'host_connection'
  if (text.includes('model not found') || text.includes('model unavailable') || text.includes('no model')) return 'model_unavailable'
  if (text.includes('dispatch failed') || text.includes('not routable') || text.includes('no eligible candidate') || text.includes('no_candidate')) return 'dispatch_rejected'
  return null
}

function toDelegationRun(
  row: any,
  task: RunTaskRow | undefined,
  projectName: string | null,
  objective: { id: number; title: string; status: string } | undefined,
): AgentOSRun {
  const taskStatus = task?.status ?? 'unknown'
  const state = deriveRunDisplayState(taskStatus, row.status)
  const createdAt = row.created_at ?? null
  const completedAt = row.completed_at ?? null
  const errorMessage = row.error_message ?? null
  return {
    id: row.id,
    kind: 'delegation',
    taskId: task ? task.id : row.task_id,
    taskTitle: task?.title ?? `Task ${row.task_id}`,
    projectId: row.project_id ?? null,
    projectName,
    objectiveId: objective?.id ?? row.objective_id ?? null,
    objectiveTitle: objective?.title ?? null,
    objectiveStatus: objective?.status ?? null,
    delegationId: row.id,
    delegationStatus: row.status,
    taskStatus,
    state,
    ecosystem: row.platoon_id ?? row.runtime_type ?? null,
    routingAgentName: row.routing_agent_name ?? null,
    specialistName: row.specialist_name ?? null,
    attempt: row.attempt ?? null,
    nativeSessionId: row.native_session_id ?? null,
    nativeRunId: row.native_run_id ?? null,
    errorClass: classifyRunError(errorMessage),
    errorMessage,
    resultSummary: row.result_summary ?? null,
    createdAt,
    updatedAt: row.updated_at ?? createdAt,
    completedAt,
    durationSeconds: durationSeconds(createdAt, completedAt),
    holdReason: null,
  }
}

function toQueuedTaskRun(
  task: RunTaskRow,
  projectName: string | null,
  objective: { id: number; title: string; status: string } | undefined,
  timestamps: { createdAt: number | null; updatedAt: number | null } = { createdAt: null, updatedAt: null },
): AgentOSRun {
  const metadata = parseMetadata(task.metadata)
  const { objectiveId, blocked } = objectiveMissionMetadata(metadata)
  const routing = metadata.agentos_routing && typeof metadata.agentos_routing === 'object'
    ? metadata.agentos_routing
    : {}
  const state = deriveRunDisplayState(task.status, null, { dependencyGated: blocked })
  return {
    id: `task:${task.id}`,
    kind: 'task',
    taskId: task.id,
    taskTitle: task.title,
    projectId: task.project_id ?? null,
    projectName,
    objectiveId: objective?.id ?? objectiveId,
    objectiveTitle: objective?.title ?? null,
    objectiveStatus: objective?.status ?? null,
    delegationId: null,
    delegationStatus: null,
    taskStatus: task.status,
    state,
    ecosystem: typeof routing.platoonId === 'string' ? routing.platoonId : null,
    routingAgentName: typeof routing.routingAgentName === 'string' ? routing.routingAgentName : task.assigned_to,
    specialistName: typeof routing.agentName === 'string' ? routing.agentName : null,
    attempt: null,
    nativeSessionId: null,
    nativeRunId: null,
    errorClass: null,
    errorMessage: null,
    resultSummary: null,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt ?? timestamps.createdAt,
    completedAt: null,
    durationSeconds: null,
    holdReason: null,
  }
}

/**
 * Workspace run list: every delegation joined to its task/project/objective
 * plus AgentOS mission tasks that have not yet produced a delegation
 * (queued/held/waiting) so an operator sees the whole dispatch pipeline.
 * Lightweight DB-only reads — safe to poll.
 */
export function listAgentOSRuns(input: {
  workspaceId: number
  projectId?: number | null
  /** Narrow by display state bucket(s), e.g. 'RUNNING' or ['QUEUED','HELD']. */
  states?: AgentOSRunDisplayState[] | null
  /** Narrow by routing agent name or specialist name (substring). */
  agent?: string | null
  /** Narrow by ecosystem / platoon id. */
  ecosystem?: string | null
  includeQueued?: boolean
  limit?: number
}): { runs: AgentOSRun[]; summary: AgentOSRunSummary } {
  const db = getDatabase()
  const workspaceId = input.workspaceId
  const projectId = input.projectId ?? null
  const limit = Math.min(250, Math.max(1, input.limit ?? 100))

  const baseWhere = ['d.workspace_id = ?']
  const baseParams: Array<number | string> = [workspaceId]
  if (projectId !== null) {
    baseWhere.push('d.project_id = ?')
    baseParams.push(projectId)
  }
  if (input.ecosystem) {
    baseWhere.push('(LOWER(d.platoon_id) = ? OR LOWER(d.runtime_type) = ?)')
    baseParams.push(input.ecosystem.toLowerCase(), input.ecosystem.toLowerCase())
  }
  if (input.agent) {
    baseWhere.push('(d.routing_agent_name LIKE ? OR d.specialist_name LIKE ?)')
    baseParams.push(`%${input.agent}%`, `%${input.agent}%`)
  }

  const delegationRows = db.prepare(`
    SELECT d.id, d.task_id, d.project_id, d.workspace_id, d.objective_id, d.platoon_id,
           d.specialist_name, d.routing_agent_name, d.runtime_type, d.status,
           d.native_session_id, d.native_run_id, d.attempt, d.result_summary,
           d.error_message, d.created_at, d.updated_at, d.completed_at,
           t.title AS task_title, t.status AS task_status, t.metadata AS task_metadata,
           p.name AS project_name,
           o.title AS objective_title, o.status AS objective_status
    FROM agentos_delegations d
    LEFT JOIN tasks t ON t.id = d.task_id AND t.workspace_id = d.workspace_id
    LEFT JOIN projects p ON p.id = d.project_id AND p.workspace_id = d.workspace_id
    LEFT JOIN agentos_objectives o ON o.id = d.objective_id AND o.workspace_id = d.workspace_id
    WHERE ${baseWhere.join(' AND ')}
    ORDER BY d.updated_at DESC, d.created_at DESC, d.rowid DESC
    LIMIT 500
  `).all(...baseParams) as any[]

  const runs: AgentOSRun[] = delegationRows.map((row) => {
    const task: RunTaskRow | undefined = row.task_id !== undefined && row.task_id !== null
      ? {
          id: row.task_id,
          title: row.task_title ?? `Task ${row.task_id}`,
          status: row.task_status ?? 'unknown',
          project_id: row.project_id,
          workspace_id: row.workspace_id,
          assigned_to: null,
          metadata: row.task_metadata ?? null,
        }
      : undefined
    const objective = row.objective_title !== undefined && row.objective_title !== null
      ? { id: row.objective_id, title: row.objective_title, status: row.objective_status ?? 'unknown' }
      : undefined
    return toDelegationRun(row, task, row.project_name ?? null, objective)
  })

  if (input.includeQueued !== false) {
    const queuedWhere = [
      't.workspace_id = ?',
      "t.status IN ('inbox','assigned','awaiting_owner','backlog','in_progress','review')",
      `(
        t.metadata LIKE '%"objectiveMission":true%'
        OR EXISTS (
          SELECT 1 FROM agents a
          WHERE a.name = t.assigned_to AND a.workspace_id = t.workspace_id
            AND a.source = 'agentos-external'
        )
      )`,
      'NOT EXISTS (SELECT 1 FROM agentos_delegations ad WHERE ad.task_id = t.id AND ad.workspace_id = t.workspace_id)',
    ]
    const queuedParams: Array<number | string> = [workspaceId]
    if (projectId !== null) {
      queuedWhere.push('t.project_id = ?')
      queuedParams.push(projectId)
    }
    const queuedRows = db.prepare(`
      SELECT t.id, t.title, t.status, t.project_id, t.workspace_id, t.assigned_to, t.metadata,
             t.created_at, t.updated_at,
             p.name AS project_name,
             o.id AS objective_id, o.title AS objective_title, o.status AS objective_status
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
      LEFT JOIN agentos_objectives o ON o.id = json_extract(t.metadata, '$.agentos.objectiveId')
        AND o.workspace_id = t.workspace_id
      WHERE ${queuedWhere.join(' AND ')}
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ${Math.min(200, Math.max(1, limit * 2))}
    `).all(...queuedParams) as Array<{
      id: number
      title: string
      status: string
      project_id: number | null
      workspace_id: number
      assigned_to: string | null
      metadata: string | null
      created_at: number | null
      updated_at: number | null
      project_name: string | null
      objective_id: number | null
      objective_title: string | null
      objective_status: string | null
    }>

    // Ecosystem/agent/state filters apply to queued tasks too (best-effort via metadata).
    for (const row of queuedRows) {
      const task: RunTaskRow = {
        id: row.id,
        title: row.title,
        status: row.status,
        project_id: row.project_id,
        workspace_id: row.workspace_id,
        assigned_to: row.assigned_to,
        metadata: row.metadata,
      }
      const objective = row.objective_title !== null && row.objective_title !== undefined && typeof row.objective_id === 'number'
        ? { id: row.objective_id, title: row.objective_title, status: row.objective_status ?? 'unknown' }
        : undefined
      const run = toQueuedTaskRun(
        task,
        row.project_name ?? null,
        objective,
        { createdAt: row.created_at ?? null, updatedAt: row.updated_at ?? null },
      )
      if (input.ecosystem && !(run.ecosystem && run.ecosystem.toLowerCase() === input.ecosystem.toLowerCase())) continue
      if (input.agent && !(run.routingAgentName && run.routingAgentName.toLowerCase().includes(input.agent.toLowerCase()))) continue
      runs.push(run)
    }
  }

  // Newest activity first across both delegation runs and queued missions.
  runs.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))

  // Attach real-state hold reasons (why each non-running run is not executing).
  const holdContext = buildRunHoldContext(workspaceId, runs)
  for (const run of runs) {
    run.holdReason = runHoldReason({
      state: run.state,
      workspaceId,
      projectId: run.projectId,
      objectiveId: run.objectiveId,
      taskStatus: run.taskStatus,
      delegationStatus: run.delegationStatus,
      errorMessage: run.errorMessage,
    }, holdContext)
  }

  let filtered = runs
  if (input.states && input.states.length > 0) {
    const wanted = new Set(input.states)
    filtered = runs.filter(run => wanted.has(run.state))
  }
  filtered = filtered.slice(0, limit)

  const byState: Partial<Record<AgentOSRunDisplayState, number>> = {}
  for (const run of runs) {
    byState[run.state] = (byState[run.state] || 0) + 1
  }
  return { runs: filtered, summary: { total: runs.length, byState } }
}

/** True when the project command state blocks new AgentOS work. */
export function commandStateBlocksDispatch(state: string | null | undefined): boolean {
  return state === 'paused' || state === 'blocked'
}

export interface RunHoldContext {
  /** Precomputed project command state lookup (avoids per-run DB reads). */
  commandStateOf?: (projectId: number) => string | null
  /** Precomputed stored-plan approval lookup per objective. */
  planApprovalOf?: (objectiveId: number) => { approvalRequired: boolean; hasApproval: boolean } | null
}

/**
 * Why is this run not executing right now? Derived from real state only:
 * project command state, the delegation/task ledger, and the stored execution
 * plan + approval rows — never frontend assumptions. Returns null for
 * states that need no explanation (running, reviewing, completed, cancelled)
 * and for plain queued work that is simply waiting for the next tick.
 */
export function runHoldReason(run: {
  state: AgentOSRunDisplayState
  workspaceId: number
  projectId: number | null
  objectiveId: number | null
  taskStatus: string | null | undefined
  delegationStatus: string | null | undefined
  errorMessage: string | null | undefined
}, context: RunHoldContext = {}): string | null {
  if (run.state === 'RUNNING' || run.state === 'REVIEWING' || run.state === 'RETRYING'
    || run.state === 'COMPLETED' || run.state === 'CANCELLED') {
    return null
  }
  if (run.state === 'FAILED') {
    switch (classifyRunError(run.errorMessage)) {
      case 'insufficient_balance': return 'Insufficient provider balance (HTTP 402) — the provider blocked this execution'
      case 'authentication': return 'Provider authentication failure'
      case 'timeout': return 'Execution timed out'
      case 'host_connection': return 'Host connection failure'
      case 'model_unavailable': return 'Model unavailable'
      case 'dispatch_rejected': return 'Dispatch rejected — no eligible candidate at dispatch time'
      default: return null
    }
  }

  const db = getDatabase()
  const reasons: string[] = []

  if (run.projectId !== null) {
    const state = context.commandStateOf
      ? context.commandStateOf(run.projectId)
      : (() => { try { return getProjectCommand(run.projectId!, run.workspaceId).state } catch { return null } })()
    if (state === 'paused') reasons.push('Project is paused — resume it in Project Command to allow dispatch')
    else if (state === 'blocked') reasons.push('Project is blocked — resolve activation blockers in Project Command')
    else if (state === 'draft' || state === 'ready') reasons.push(`Project command state is ${state} — activate the project to allow dispatch`)
  }

  if (run.taskStatus === 'awaiting_owner') {
    reasons.push('Held by command policy — waiting behind concurrency / platoon limits')
  }

  if (run.objectiveId !== null) {
    let planInfo = context.planApprovalOf ? context.planApprovalOf(run.objectiveId) : null
    if (planInfo === undefined) planInfo = null
    if (planInfo === null) {
      try {
        const planRow = db.prepare(
          'SELECT status, plan_json FROM agentos_execution_plans WHERE objective_id = ? AND workspace_id = ?',
        ).get(run.objectiveId, run.workspaceId) as { status: string; plan_json: string } | undefined
        if (planRow) {
          let approvalRequired = planRow.status === 'AWAITING_APPROVAL' || planRow.status === 'PREVIEW'
          if (!approvalRequired) {
            try {
              approvalRequired = (JSON.parse(planRow.plan_json) as { summary?: { approvalRequired?: boolean } })?.summary?.approvalRequired === true
            } catch { /* unparseable plan_json */ }
          }
          const hasApproval = !!db.prepare(
            'SELECT id FROM agentos_execution_approvals WHERE objective_id = ? AND workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
          ).get(run.objectiveId, run.workspaceId)
          planInfo = { approvalRequired, hasApproval }
        }
      } catch {
        // Plan/approval tables absent in this environment — skip approval reasoning.
      }
    }
    if (planInfo?.approvalRequired) {
      reasons.push(planInfo.hasApproval
        ? 'Cost approval exists but the run is still held — the plan may be stale; refresh and re-approve in Project Command'
        : 'Awaiting cost approval — approve the exact execution plan in Project Command')
    }
  }

  if (reasons.length === 0 && (run.taskStatus === 'assigned' || run.taskStatus === 'inbox')) {
    reasons.push('Queued for dispatch — the next scheduler tick claims approved work')
  }
  return reasons.length > 0 ? reasons.join(' · ') : null
}

/** Build per-project command state + per-objective plan/approval lookups once. */
function buildRunHoldContext(workspaceId: number, runs: AgentOSRun[]): RunHoldContext {
  const commandStates = new Map<number, string>()
  try {
    const rows = getDatabase().prepare(
      'SELECT project_id, state FROM agentos_project_command WHERE workspace_id = ?',
    ).all(workspaceId) as Array<{ project_id: number; state: string }>
    for (const row of rows) commandStates.set(row.project_id, row.state)
  } catch { /* command table absent */ }

  const objectiveIds = [...new Set(runs.map(r => r.objectiveId).filter((id): id is number => id !== null))]
  const planInfo = new Map<number, { approvalRequired: boolean; hasApproval: boolean }>()
  if (objectiveIds.length > 0) {
    try {
      const placeholders = objectiveIds.map(() => '?').join(',')
      const planRows = getDatabase().prepare(
        `SELECT objective_id, status, plan_json FROM agentos_execution_plans WHERE workspace_id = ? AND objective_id IN (${placeholders})`,
      ).all(workspaceId, ...objectiveIds) as Array<{ objective_id: number; status: string; plan_json: string }>
      const approvalIds = new Set(
        (getDatabase().prepare(
          `SELECT objective_id FROM agentos_execution_approvals WHERE workspace_id = ? AND objective_id IN (${placeholders})
           GROUP BY objective_id HAVING MAX(created_at)`,
        ).all(workspaceId, ...objectiveIds) as Array<{ objective_id: number }>).map(r => r.objective_id),
      )
      for (const row of planRows) {
        let approvalRequired = row.status === 'AWAITING_APPROVAL' || row.status === 'PREVIEW'
        if (!approvalRequired) {
          try {
            approvalRequired = (JSON.parse(row.plan_json) as { summary?: { approvalRequired?: boolean } })?.summary?.approvalRequired === true
          } catch { /* unparseable */ }
        }
        planInfo.set(row.objective_id, { approvalRequired, hasApproval: approvalIds.has(row.objective_id) })
      }
    } catch { /* plan tables absent */ }
  }

  return {
    commandStateOf: (projectId) => commandStates.get(projectId) ?? null,
    planApprovalOf: (objectiveId) => planInfo.get(objectiveId) ?? null,
  }
}

/**
 * Operator retry of a terminal FAILED run. Creates a fresh attempt through the
 * existing pipeline — the failed delegation is preserved as history, the task
 * is re-entered through current project routing (new specialist selection),
 * and dispatch-time execution authorization re-runs before any execution.
 *
 * Guards, in order:
 *   1. task/delegation exist and belong to this workspace;
 *   2. the run is genuinely terminal-failed (task `failed`, or a failed/
 *      cancelled delegation);
 *   3. the project command state is not paused/blocked — retry is new work
 *      and must never bypass the pause gate.
 *
 * Never throws for guard failures: returns `{ ok:false, held:true, reason }`
 * so the UI can show why the retry was refused.
 */
export function retryAgentOSRun(input: {
  workspaceId: number
  actor?: string | null
  delegationId?: string | null
  taskId?: number | null
}): {
  ok: boolean
  scheduled?: boolean
  held?: boolean
  reason?: string
  taskId?: number
  delegationId?: string | null
} {
  const db = getDatabase()
  const workspaceId = input.workspaceId
  if (!input.delegationId && !input.taskId) {
    return { ok: false, reason: 'delegationId or taskId is required' }
  }

  let delegationId: string | null = input.delegationId ?? null
  if (delegationId) {
    const delegation = db.prepare(
      'SELECT task_id FROM agentos_delegations WHERE id = ? AND workspace_id = ?',
    ).get(delegationId, workspaceId) as { task_id: number } | undefined
    if (!delegation) return { ok: false, reason: 'Delegation not found in this workspace' }
    input.taskId = delegation.task_id
  }
  const taskId = input.taskId
  if (!taskId) return { ok: false, reason: 'Task not found' }

  const task = db.prepare(
    'SELECT id, title, status, project_id, workspace_id, error_message FROM tasks WHERE id = ? AND workspace_id = ?',
  ).get(taskId, workspaceId) as
    | { id: number; title: string; status: string; project_id: number | null; workspace_id: number; error_message: string | null }
    | undefined
  if (!task) return { ok: false, reason: 'Task not found in this workspace' }

  const latestDelegation = db.prepare(`
    SELECT id, status FROM agentos_delegations
    WHERE task_id = ? AND workspace_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(taskId, workspaceId) as { id: string; status: string } | undefined
  const delegationStatus = latestDelegation?.status ?? null

  const retryable = task.status === 'failed'
    || delegationStatus === 'failed'
    || delegationStatus === 'cancelled'
  if (!retryable) {
    return {
      ok: false,
      reason: `Run is not in a terminal failed state (task ${task.status}${delegationStatus ? `, delegation ${delegationStatus}` : ''})`,
    }
  }

  if (task.project_id !== null) {
    let commandState: string | null = null
    try {
      commandState = getProjectCommand(task.project_id, workspaceId).state
    } catch {
      commandState = null
    }
    if (commandStateBlocksDispatch(commandState)) {
      return {
        ok: false,
        held: true,
        reason: `Project command state is ${commandState ?? 'unknown'} — retry is new work and will not bypass it. Resume the project in Project Command first.`,
      }
    }
  }

  const actor = input.actor || 'operator'
  const now = Math.floor(Date.now() / 1000)

  const outcome = db.transaction((): { ok: boolean; scheduled: boolean; held?: boolean; reason?: string } => {
    // Preserve history: do NOT touch the failed delegation. Re-enter the task
    // through routing so a fresh (possibly different) specialist is selected.
    db.prepare(
      "UPDATE tasks SET status = 'inbox', error_message = NULL, dispatch_attempts = 0, updated_at = ? WHERE id = ? AND workspace_id = ?",
    ).run(now, taskId, workspaceId)

    const routing = routeTaskWithinProject({
      taskId,
      workspaceId,
      actor,
      allowReassign: true,
    })

    if (!routing.routed) {
      const reason = routing.reason || 'No dispatchable agent available for retry'
      // Leave the run visible in its failed state with the hold reason rather
      // than stranding it in an unrouted inbox.
      db.prepare(
        "UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      ).run(`Retry held: ${reason}`, now, taskId, workspaceId)
      return { ok: true, scheduled: false, held: true, reason }
    }
    return { ok: true, scheduled: true }
  })()

  if (outcome.scheduled) {
    db_helpers.logActivity(
      'agentos_retry_scheduled', 'task', taskId, actor,
      `AgentOS retry scheduled for task ${taskId} (new attempt via fresh routing)`,
      { delegation_id: delegationId, task_id: taskId },
      workspaceId,
    )
  } else {
    db_helpers.logActivity(
      'agentos_retry_held', 'task', taskId, actor,
      `AgentOS retry for task ${taskId} held: ${outcome.reason || 'no candidate'}`,
      { delegation_id: delegationId, task_id: taskId },
      workspaceId,
    )
  }

  return {
    ok: outcome.ok,
    scheduled: outcome.scheduled,
    ...(outcome.held ? { held: true } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    taskId,
    delegationId: delegationId ?? latestDelegation?.id ?? null,
  }
}

/**
 * Operator cancel of an AgentOS run. Two distinct, truthful scopes:
 *
 *   queued — the task has not been claimed yet (no delegation row). Cancelling
 *     is a pure DB transition on the task row; the dispatcher only claims
 *     `assigned` tasks, so a cancelled task can never start. This works for
 *     every ecosystem.
 *
 *   active — a delegation exists and may be executing in the native runtime.
 *     Only Gamut supports host-side termination today (DELETE session on the
 *     live host API). For other executors there is no supported termination
 *     path, so active cancellation is refused with the reason rather than
 *     faked. A delegation that has been claimed but not yet attached to a
 *     native session/run has nothing executing remotely and is cancelled
 *     directly (the in-flight claim is orphaned; dispatch only acts on
 *     non-cancelled tasks).
 *
 * Never throws for guard failures: returns `{ ok:false, reason }` so the UI
 * shows why cancellation was refused.
 */
export async function cancelAgentOSRun(input: {
  workspaceId: number
  actor?: string | null
  delegationId?: string | null
  taskId?: number | null
}): Promise<{
  ok: boolean
  cancelled?: boolean
  scope?: 'queued' | 'active'
  terminated?: boolean
  alreadyEnded?: boolean
  reason?: string
  taskId?: number
  delegationId?: string | null
}> {
  const db = getDatabase()
  const workspaceId = input.workspaceId
  if (!input.delegationId && !input.taskId) {
    return { ok: false, reason: 'delegationId or taskId is required' }
  }

  let delegationId: string | null = input.delegationId ?? null
  let delegation: AgentOSDelegation | null = null
  if (delegationId) {
    delegation = getDelegation(delegationId, workspaceId)
    if (!delegation) return { ok: false, reason: 'Delegation not found in this workspace' }
  }
  const taskId = input.taskId ?? delegation?.taskId
  if (!taskId) return { ok: false, reason: 'Task not found' }

  const task = db.prepare(
    'SELECT id, title, status, project_id, workspace_id FROM tasks WHERE id = ? AND workspace_id = ?',
  ).get(taskId, workspaceId) as
    | { id: number; title: string; status: string; project_id: number | null; workspace_id: number }
    | undefined
  if (!task) return { ok: false, reason: 'Task not found in this workspace' }

  if (!delegation) {
    delegation = getLatestDelegationForTask(taskId, workspaceId)
    delegationId = delegation?.id ?? null
  } else {
    delegationId = delegation.id
  }

  const actor = input.actor || 'operator'
  const now = Math.floor(Date.now() / 1000)

  const markCancelled = (scope: 'queued' | 'active'): { ok: boolean; cancelled: boolean; scope: 'queued' | 'active'; taskId: number; delegationId: string | null } => {
    db.prepare(
      "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND workspace_id = ?",
    ).run(now, taskId, workspaceId)
    if (delegation) {
      updateDelegation(delegation.id, workspaceId, {
        status: 'cancelled',
        completed: true,
        errorMessage: 'Cancelled by operator',
      })
      try {
        releaseReservationForTask(taskId, workspaceId)
      } catch {
        // Reservation release is best-effort and must never break cancellation.
      }
      db_helpers.logActivity(
        'agentos_cancelled', 'task', taskId, actor,
        `Cancelled AgentOS run ${delegation.id} (${scope}) — native session ${delegation.nativeSessionId ? 'terminated' : 'never started'}`,
        { delegation_id: delegation.id, task_id: taskId, scope },
        workspaceId,
      )
      return { ok: true, cancelled: true, scope, taskId, delegationId: delegation.id }
    }
    db_helpers.logActivity(
      'agentos_cancelled', 'task', taskId, actor,
      `Cancelled queued AgentOS task ${taskId} before claim (${scope})`,
      { task_id: taskId, scope },
      workspaceId,
    )
    return { ok: true, cancelled: true, scope, taskId, delegationId: null }
  }

  // Case A — not yet claimed: pure queued cancel, safe for every ecosystem.
  if (!delegation) {
    if (!['inbox', 'assigned', 'awaiting_owner', 'backlog'].includes(task.status)) {
      return { ok: false, reason: `Task is ${task.status} with no delegation row — nothing to cancel` }
    }
    return markCancelled('queued')
  }

  // Case B — delegation exists; only active (non-terminal) runs are cancellable.
  if (!['claimed', 'accepted', 'pending', 'retrying'].includes(delegation.status)) {
    return { ok: false, reason: `Run is already ${delegation.status} — only active runs can be cancelled` }
  }

  // No native session/run attached yet: nothing is executing remotely.
  if (!delegation.nativeSessionId && !delegation.nativeRunId) {
    return markCancelled('active')
  }

  const ecosystem = (delegation.platoonId || delegation.runtimeType || '').toLowerCase()
  if (ecosystem !== 'gamut') {
    return {
      ok: false,
      reason: `Active termination is not supported for the ${ecosystem || 'current'} executor — the run is executing in a native session Mission Control cannot stop. Cancel it from its own CLI, or cancel while queued before dispatch.`,
    }
  }

  // Gamut: terminate the live host session, then record the cancellation only
  // if the host confirms (or reports the session already ended). A refused
  // termination must NOT leave a running session reported as cancelled.
  const slug = resolveGamutAgentSlug({ workspaceId, delegation })
  if (!slug || !delegation.nativeSessionId) {
    return { ok: false, reason: 'Gamut native agent slug is not resolvable from the roster — cannot terminate the host session' }
  }
  let termination: { terminated: boolean; alreadyEnded: boolean }
  try {
    termination = await terminateGamutSession(slug, delegation.nativeSessionId)
  } catch (error) {
    return {
      ok: false,
      reason: `Gamut host refused session termination: ${error instanceof Error ? error.message : 'unknown host error'} — the run is still active.`,
    }
  }
  const outcome = markCancelled('active')
  return { ...outcome, terminated: termination.terminated, alreadyEnded: termination.alreadyEnded }
}

/**
 * Resolve the native Gamut host slug for a delegation's agent from the
 * synchronized roster (`pc:gamut:<slug>` external ids stored in agent
 * config), matching by routing agent or specialist name.
 */
function resolveGamutAgentSlug(input: {
  workspaceId: number
  delegation: AgentOSDelegation
}): string | null {
  const names = [input.delegation.routingAgentName, input.delegation.specialistName]
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
  if (names.length === 0) return null
  const placeholders = names.map(() => '?').join(',')
  const rows = getDatabase().prepare(`
    SELECT config FROM agents
    WHERE workspace_id = ? AND source = 'agentos-external' AND name IN (${placeholders})
    LIMIT 5
  `).all(input.workspaceId, ...names) as Array<{ config: string | null }>
  for (const row of rows) {
    if (!row.config) continue
    try {
      const cfg = JSON.parse(row.config)
      const agentos = cfg.agentos && typeof cfg.agentos === 'object' ? cfg.agentos : null
      const externalId = agentos && typeof agentos.externalAgentId === 'string' ? agentos.externalAgentId : null
      if (!externalId) continue
      const slug = externalId.startsWith('pc:gamut:') ? externalId.slice('pc:gamut:'.length) : null
      if (slug) return slug
    } catch {
      // Malformed config on this agent — try the next match.
    }
  }
  return null
}

/**
 * Recent executed runs for one routing agent (or specialist), used by the
 * Agent Registry detail — a consumer of the canonical run model, not a second
 * implementation. Delegation rows only: an "execution" requires a claim.
 */
export function listRecentRunsForAgent(input: {
  workspaceId: number
  agentName: string
  limit?: number
}): AgentOSRun[] {
  const db = getDatabase()
  const limit = Math.min(10, Math.max(1, input.limit ?? 5))
  const rows = db.prepare(`
    SELECT d.id, d.task_id, d.project_id, d.workspace_id, d.objective_id, d.platoon_id,
           d.specialist_name, d.routing_agent_name, d.runtime_type, d.status,
           d.native_session_id, d.native_run_id, d.attempt, d.result_summary,
           d.error_message, d.created_at, d.updated_at, d.completed_at,
           t.title AS task_title, t.status AS task_status, t.metadata AS task_metadata,
           p.name AS project_name,
           o.title AS objective_title, o.status AS objective_status
    FROM agentos_delegations d
    LEFT JOIN tasks t ON t.id = d.task_id AND t.workspace_id = d.workspace_id
    LEFT JOIN projects p ON p.id = d.project_id AND p.workspace_id = d.workspace_id
    LEFT JOIN agentos_objectives o ON o.id = d.objective_id AND o.workspace_id = d.workspace_id
    WHERE d.workspace_id = ?
      AND (LOWER(d.routing_agent_name) = LOWER(?) OR LOWER(d.specialist_name) = LOWER(?))
    ORDER BY d.updated_at DESC, d.created_at DESC, d.rowid DESC
    LIMIT ?
  `).all(input.workspaceId, input.agentName, input.agentName, limit) as any[]

  const runs = rows.map((row) => {
    const task: RunTaskRow | undefined = {
      id: row.task_id,
      title: row.task_title ?? `Task ${row.task_id}`,
      status: row.task_status ?? 'unknown',
      project_id: row.project_id,
      workspace_id: row.workspace_id,
      assigned_to: null,
      metadata: row.task_metadata ?? null,
    }
    const objective = row.objective_title !== null && row.objective_title !== undefined
      ? { id: row.objective_id, title: row.objective_title, status: row.objective_status ?? 'unknown' }
      : undefined
    return toDelegationRun(row, task, row.project_name ?? null, objective)
  })

  const holdContext = buildRunHoldContext(input.workspaceId, runs)
  for (const run of runs) {
    run.holdReason = runHoldReason({
      state: run.state,
      workspaceId: input.workspaceId,
      projectId: run.projectId,
      objectiveId: run.objectiveId,
      taskStatus: run.taskStatus,
      delegationStatus: run.delegationStatus,
      errorMessage: run.errorMessage,
    }, holdContext)
  }
  return runs
}

/** Re-exported for callers that type against the ledger directly. */
export type { AgentOSDelegation }
