import { randomUUID } from 'node:crypto'
import { getDatabase, db_helpers } from './db'
import { releaseReservationForTask } from './execution-authorization'
import { eventBus } from './event-bus'

export type AgentOSDelegationStatus =
  | 'claimed'
  | 'accepted'
  | 'pending'
  | 'completed'
  | 'retrying'
  | 'failed'
  | 'cancelled'

export interface AgentOSDelegation {
  id: string
  taskId: number
  projectId: number | null
  workspaceId: number
  objectiveId: number | null
  platoonId: string | null
  specialistName: string | null
  routingAgentName: string | null
  runtimeType: string | null
  status: AgentOSDelegationStatus
  nativeSessionId: string | null
  nativeRunId: string | null
  attempt: number
  resultSummary: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
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

function rowToDelegation(row: any): AgentOSDelegation {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id ?? null,
    workspaceId: row.workspace_id,
    objectiveId: row.objective_id ?? null,
    platoonId: row.platoon_id || null,
    specialistName: row.specialist_name || null,
    routingAgentName: row.routing_agent_name || null,
    runtimeType: row.runtime_type || null,
    status: row.status,
    nativeSessionId: row.native_session_id || null,
    nativeRunId: row.native_run_id || null,
    attempt: row.attempt,
    resultSummary: row.result_summary || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  }
}

export function getDelegation(id: string, workspaceId: number): AgentOSDelegation | null {
  const row = getDatabase().prepare(
    'SELECT * FROM agentos_delegations WHERE id = ? AND workspace_id = ?',
  ).get(id, workspaceId) as any
  return row ? rowToDelegation(row) : null
}
export function createDelegationForTask(input: {
  taskId: number
  projectId: number | null
  workspaceId: number
  routingAgentName: string
  runtimeType?: string | null
  metadata?: string | null
  attempt?: number
}): AgentOSDelegation {
  const db = getDatabase()
  const metadata = parseMetadata(input.metadata)
  const routing = metadata.agentos_routing && typeof metadata.agentos_routing === 'object'
    ? metadata.agentos_routing
    : {}
  const objective = metadata.agentos && typeof metadata.agentos === 'object'
    ? metadata.agentos
    : {}
  const now = Math.floor(Date.now() / 1000)
  const existing = getLatestDelegationForTask(input.taskId, input.workspaceId)
  if (existing && existing.status === 'retrying') {
    db.prepare(`
      UPDATE agentos_delegations
      SET status = 'claimed', attempt = ?, error_message = NULL, updated_at = ?, completed_at = NULL
      WHERE id = ? AND workspace_id = ?
    `).run(Math.max(existing.attempt + 1, input.attempt || 1), now, existing.id, input.workspaceId)
    const nextMetadata = { ...metadata, agentos_delegation_id: existing.id }
    db.prepare(
      'UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    ).run(JSON.stringify(nextMetadata), now, input.taskId, input.workspaceId)
    eventBus.broadcast('delegation.updated', {
      workspace_id: input.workspaceId,
      id: existing.id,
      task_id: input.taskId,
      status: 'claimed',
      attempt: Math.max(existing.attempt + 1, input.attempt || 1),
      updated_at: now,
    })
    return getDelegation(existing.id, input.workspaceId)!
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO agentos_delegations (
      id, task_id, project_id, workspace_id, objective_id, platoon_id,
      specialist_name, routing_agent_name, runtime_type, status, attempt,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?)
  `).run(
    id,
    input.taskId,
    input.projectId,
    input.workspaceId,
    typeof objective.objectiveId === 'number' ? objective.objectiveId : null,
    typeof routing.platoonId === 'string' ? routing.platoonId : input.runtimeType || null,
    typeof routing.agentName === 'string' ? routing.agentName : null,
    input.routingAgentName,
    input.runtimeType || null,
    Math.max(1, input.attempt || 1),
    now,
    now,
  )

  const nextMetadata = {
    ...metadata,
    agentos_delegation_id: id,
  }
  db.prepare(
    'UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
  ).run(JSON.stringify(nextMetadata), now, input.taskId, input.workspaceId)
  db_helpers.logActivity(
    'agentos_delegation_created',
    'task',
    input.taskId,
    'agentos',
    `Created AgentOS delegation ${id}`,
    {
      delegation_id: id,
      platoon_id: typeof routing.platoonId === 'string' ? routing.platoonId : input.runtimeType || null,
      specialist_name: typeof routing.agentName === 'string' ? routing.agentName : null,
      routing_agent_name: input.routingAgentName,
    },
    input.workspaceId,
  )
  eventBus.broadcast('delegation.created', {
    workspace_id: input.workspaceId,
    id,
    task_id: input.taskId,
    project_id: input.projectId ?? null,
    objective_id: typeof objective.objectiveId === 'number' ? objective.objectiveId : null,
    platoon_id: typeof routing.platoonId === 'string' ? routing.platoonId : input.runtimeType || null,
    routing_agent_name: input.routingAgentName,
    status: 'claimed',
    attempt: Math.max(1, input.attempt || 1),
    created_at: now,
  })

  return getDelegation(id, input.workspaceId)!
}

export function getLatestDelegationForTask(
  taskId: number,
  workspaceId: number,
): AgentOSDelegation | null {
  const row = getDatabase().prepare(`
    SELECT * FROM agentos_delegations
    WHERE task_id = ? AND workspace_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(taskId, workspaceId) as any
  return row ? rowToDelegation(row) : null
}

export function updateDelegation(
  id: string,
  workspaceId: number,
  patch: {
    status?: AgentOSDelegationStatus
    nativeSessionId?: string | null
    nativeRunId?: string | null
    resultSummary?: string | null
    errorMessage?: string | null
    completed?: boolean
  },
): AgentOSDelegation | null {
  const current = getDelegation(id, workspaceId)
  if (!current) return null
  const now = Math.floor(Date.now() / 1000)
  const status = patch.status || current.status
  const completedAt = patch.completed || status === 'completed' || status === 'failed'
    ? (current.completedAt || now)
    : current.completedAt
  getDatabase().prepare(`
    UPDATE agentos_delegations
    SET status = ?,
        native_session_id = ?,
        native_run_id = ?,
        result_summary = ?,
        error_message = ?,
        updated_at = ?,
        completed_at = ?
    WHERE id = ? AND workspace_id = ?
  `).run(
    status,
    patch.nativeSessionId !== undefined ? patch.nativeSessionId : current.nativeSessionId,
    patch.nativeRunId !== undefined ? patch.nativeRunId : current.nativeRunId,
    patch.resultSummary !== undefined ? patch.resultSummary : current.resultSummary,
    patch.errorMessage !== undefined ? patch.errorMessage : current.errorMessage,
    now,
    completedAt,
    id,
    workspaceId,
  )

  // Budget guard: a terminal delegation releases its reservation so committed
  // spend reflects reality (Phase 9/10). Never throws.
  if (status === 'completed' || status === 'failed') {
    try {
      releaseReservationForTask(current.taskId, workspaceId)
    } catch {
      // release must never break delegation updates
    }
  }

  eventBus.broadcast('delegation.updated', {
    workspace_id: workspaceId,
    id,
    task_id: current.taskId,
    project_id: current.projectId ?? null,
    objective_id: current.objectiveId ?? null,
    status,
    attempt: current.attempt,
    native_session_id: patch.nativeSessionId !== undefined ? patch.nativeSessionId : current.nativeSessionId,
    native_run_id: patch.nativeRunId !== undefined ? patch.nativeRunId : current.nativeRunId,
    updated_at: now,
    completed_at: completedAt,
  })

  return getDelegation(id, workspaceId)
}
export function listProjectDelegations(
  projectId: number,
  workspaceId: number,
): AgentOSDelegation[] {
  const rows = getDatabase().prepare(`
    SELECT * FROM agentos_delegations
    WHERE project_id = ? AND workspace_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 250
  `).all(projectId, workspaceId) as any[]
  return rows.map(rowToDelegation)
}
