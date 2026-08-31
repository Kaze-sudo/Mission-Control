import { getDatabase, db_helpers } from './db'
import { listExternalProjectBindings } from './external-project-bindings'
import { routeTaskWithinProject } from './project-task-routing'

export interface AgentOSHandoff {
  id: number
  projectId: number
  workspaceId: number
  fromTaskId: number
  toTaskId: number | null
  fromRoutingAgentName: string | null
  toExternalAgentId: string | null
  toPlatoonId: string | null
  requestedCapabilities: string[]
  instructions: string | null
  status: 'pending' | 'accepted' | 'completed' | 'blocked' | 'cancelled'
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

function parseList(raw: string | null): string[] {
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] }
  catch { return [] }
}

function rowToHandoff(row: any): AgentOSHandoff {
  return {
    id: row.id, projectId: row.project_id, workspaceId: row.workspace_id,
    fromTaskId: row.from_task_id, toTaskId: row.to_task_id ?? null,
    fromRoutingAgentName: row.from_routing_agent_name || null,
    toExternalAgentId: row.to_external_agent_id || null, toPlatoonId: row.to_platoon_id || null,
    requestedCapabilities: parseList(row.requested_capabilities_json), instructions: row.instructions || null,
    status: row.status, createdBy: row.created_by || null, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
export function listProjectHandoffs(projectId: number, workspaceId: number): AgentOSHandoff[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT * FROM agentos_task_handoffs WHERE project_id = ? AND workspace_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 100
  `).all(projectId, workspaceId) as any[]
  return rows.map(rowToHandoff)
}

export function createHandoff(input: {
  projectId: number
  workspaceId: number
  fromTaskId: number
  toExternalAgentId?: string | null
  requestedCapabilities?: string[]
  instructions?: string | null
  actor?: string | null
}): AgentOSHandoff {
  const db = getDatabase()
  const source = db.prepare(`
    SELECT id, assigned_to, project_id FROM tasks
    WHERE id = ? AND workspace_id = ? AND project_id = ?
  `).get(input.fromTaskId, input.workspaceId, input.projectId) as any
  if (!source) throw new Error('Source task not found in project')
  let toPlatoonId: string | null = null
  if (input.toExternalAgentId) {
    const binding = listExternalProjectBindings(input.projectId, input.workspaceId)
      .find(item => item.externalAgentId === input.toExternalAgentId)
    if (!binding) throw new Error('Target agent is not bound to this project')
    toPlatoonId = binding.platoonId
  }
  const caps = [...new Set((input.requestedCapabilities || []).map(v => v.trim().toLowerCase()).filter(Boolean))]
  const result = db.prepare(`
    INSERT INTO agentos_task_handoffs (
      project_id, workspace_id, from_task_id, from_routing_agent_name,
      to_external_agent_id, to_platoon_id, requested_capabilities_json, instructions, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(input.projectId, input.workspaceId, input.fromTaskId, source.assigned_to || null,
    input.toExternalAgentId || null, toPlatoonId, JSON.stringify(caps), input.instructions || null, input.actor || null)
  const row = db.prepare('SELECT * FROM agentos_task_handoffs WHERE id = ?').get(result.lastInsertRowid) as any
  db_helpers.logActivity('agentos_handoff_created', 'task', input.fromTaskId, input.actor || 'agentos',
    'Created AgentOS task handoff', { handoff_id: Number(result.lastInsertRowid), to_external_agent_id: input.toExternalAgentId || null, requested_capabilities: caps }, input.workspaceId)
  return rowToHandoff(row)
}
export function acceptHandoff(input: {
  handoffId: number
  workspaceId: number
  actor?: string | null
}): AgentOSHandoff {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM agentos_task_handoffs WHERE id = ? AND workspace_id = ?').get(input.handoffId, input.workspaceId) as any
  if (!row) throw new Error('Handoff not found')
  if (row.status !== 'pending') throw new Error(`Handoff is ${row.status}`)
  const source = db.prepare('SELECT id, title, priority FROM tasks WHERE id = ? AND workspace_id = ?').get(row.from_task_id, input.workspaceId) as any
  if (!source) throw new Error('Source task no longer exists')
  const metadata = {
    agentos_handoff: { handoffId: row.id, fromTaskId: row.from_task_id, acceptedBy: input.actor || 'agentos' },
  }
  const result = db.prepare(`
    INSERT INTO tasks (title, description, status, priority, created_by, metadata, workspace_id, project_id)
    VALUES (?, ?, 'awaiting_owner', ?, ?, ?, ?, ?)
  `).run(`Handoff: ${source.title}`, row.instructions || 'Continue work from the previous task handoff.',
    source.priority || 'medium', input.actor || 'agentos', JSON.stringify(metadata), input.workspaceId, row.project_id)
  const toTaskId = Number(result.lastInsertRowid)

  let routed = false
  let routeReason: string | undefined
  if (row.to_external_agent_id) {
    const binding = listExternalProjectBindings(row.project_id, input.workspaceId)
      .find(item => item.externalAgentId === row.to_external_agent_id)
    if (binding?.routingAgentName) {
      db.prepare('UPDATE tasks SET assigned_to = ?, updated_at = unixepoch() WHERE id = ? AND workspace_id = ?')
        .run(binding.routingAgentName, toTaskId, input.workspaceId)
      routed = true
    } else {
      routeReason = 'Target agent binding has no routing proxy'
    }
  } else {
    const route = routeTaskWithinProject({
      taskId: toTaskId, workspaceId: input.workspaceId, actor: input.actor,
      requirements: { requiredCapabilities: parseList(row.requested_capabilities_json) },
    })
    routed = route.routed
    routeReason = route.reason
  }

  const nextStatus = routed ? 'accepted' : 'blocked'
  db.prepare(`UPDATE agentos_task_handoffs SET to_task_id = ?, status = ?, updated_at = unixepoch() WHERE id = ? AND workspace_id = ?`)
    .run(toTaskId, nextStatus, row.id, input.workspaceId)
  db_helpers.logActivity('agentos_handoff_accepted', 'task', row.from_task_id, input.actor || 'agentos',
    routed ? `Accepted handoff into task ${toTaskId}` : `Handoff blocked: ${routeReason || 'no eligible route'}`,
    { handoff_id: row.id, to_task_id: toTaskId, routed, reason: routeReason || null }, input.workspaceId)
  const updated = db.prepare('SELECT * FROM agentos_task_handoffs WHERE id = ?').get(row.id) as any
  return rowToHandoff(updated)
}

export function cancelHandoff(handoffId: number, workspaceId: number): boolean {
  const db = getDatabase()
  const result = db.prepare(`
    UPDATE agentos_task_handoffs SET status = 'cancelled', updated_at = unixepoch()
    WHERE id = ? AND workspace_id = ? AND status IN ('pending','blocked')
  `).run(handoffId, workspaceId)
  return result.changes > 0
}
