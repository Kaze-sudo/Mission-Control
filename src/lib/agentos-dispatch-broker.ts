import { getDatabase, db_helpers } from './db'
import { getProjectCommand } from './project-command'
import { eventBus } from './event-bus'

interface QueueTask {
  id: number
  project_id: number | null
  workspace_id: number
  assigned_to: string
  priority: string
  created_at: number
  platoon_id: string | null
}

interface CountState {
  project: Map<string, number>
  platoon: Map<string, number>
  agent: Map<string, number>
}

function key(...parts: Array<string | number | null>): string { return parts.join(':') }

function activeCounts(workspaceId?: number): CountState {
  const db = getDatabase()
  const where = workspaceId ? 'AND t.workspace_id = ?' : ''
  const params = workspaceId ? [workspaceId] : []
  const rows = db.prepare(`
    SELECT t.workspace_id, t.project_id, t.assigned_to, a.runtime_type as platoon_id
    FROM tasks t JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'in_progress' AND a.source = 'agentos-external' ${where}
  `).all(...params) as Array<{ workspace_id: number; project_id: number | null; assigned_to: string; platoon_id: string | null }>
  const state: CountState = { project: new Map(), platoon: new Map(), agent: new Map() }
  for (const row of rows) {
    if (!row.project_id) continue
    const p = key(row.workspace_id, row.project_id)
    const pl = key(row.workspace_id, row.project_id, row.platoon_id || 'unknown')
    const a = key(row.workspace_id, row.project_id, row.assigned_to)
    state.project.set(p, (state.project.get(p) || 0) + 1)
    state.platoon.set(pl, (state.platoon.get(pl) || 0) + 1)
    state.agent.set(a, (state.agent.get(a) || 0) + 1)
  }
  return state
}
export function brokerAgentOSDispatchQueue(workspaceId?: number): { ok: boolean; message: string; held: number; released: number } {
  const db = getDatabase()
  const wsFilter = workspaceId ? 'AND t.workspace_id = ?' : ''
  const wsParams = workspaceId ? [workspaceId] : []

  const assigned = db.prepare(`
    SELECT t.id, t.project_id, t.workspace_id, t.assigned_to, t.priority, t.created_at, a.runtime_type as platoon_id
    FROM tasks t JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'assigned' AND a.source = 'agentos-external' ${wsFilter}
  `).all(...wsParams) as QueueTask[]

  // Tasks already parked from a previous pass: releasing one of these is a
  // real awaiting_owner → assigned transition operators can observe. A task
  // held AND released within this same pass never observably changed state,
  // so it must stay silent — otherwise every scheduler tick would emit two
  // spurious events per flowing task and erode trust in the live feed.
  const preHeldIds = new Set(
    (db.prepare(`
      SELECT t.id
      FROM tasks t JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
      WHERE t.status = 'awaiting_owner' AND a.source = 'agentos-external' ${wsFilter}
    `).all(...wsParams) as Array<{ id: number }>).map(row => row.id),
  )

  let held = 0
  const now = Math.floor(Date.now() / 1000)
  const holdStmt = db.prepare("UPDATE tasks SET status = 'awaiting_owner', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'assigned'")
  const heldThisTick: QueueTask[] = []
  for (const task of assigned) {
    const result = holdStmt.run(now, task.id, task.workspace_id)
    if (result.changes === 0) continue
    held++
    heldThisTick.push(task)
  }

  const waiting = db.prepare(`
    SELECT t.id, t.project_id, t.workspace_id, t.assigned_to, t.priority, t.created_at, a.runtime_type as platoon_id
    FROM tasks t JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'awaiting_owner' AND a.source = 'agentos-external' ${wsFilter}
    ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at ASC
  `).all(...wsParams) as QueueTask[]

  const counts = activeCounts(workspaceId)
  let released = 0
  const releaseStmt = db.prepare("UPDATE tasks SET status = 'assigned', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'awaiting_owner'")
  const releasedIds = new Set<number>()

  for (const task of waiting) {
    if (!task.project_id) continue
    let command
    try { command = getProjectCommand(task.project_id, task.workspace_id) } catch { continue }
    if (command.state !== 'active') continue
    const platoon = (task.platoon_id || 'unknown').toLowerCase()
    if (command.policy.allowedPlatoons.length > 0 && !command.policy.allowedPlatoons.includes(platoon)) continue

    const projectKey = key(task.workspace_id, task.project_id)
    const platoonKey = key(task.workspace_id, task.project_id, platoon)
    const agentKey = key(task.workspace_id, task.project_id, task.assigned_to)
    const projectCount = counts.project.get(projectKey) || 0
    const platoonCount = counts.platoon.get(platoonKey) || 0
    const agentCount = counts.agent.get(agentKey) || 0
    if (projectCount >= command.policy.maxProjectConcurrent) continue
    if (platoonCount >= command.policy.maxPlatoonConcurrent) continue
    if (agentCount >= command.policy.maxAgentConcurrent) continue

    const result = releaseStmt.run(now, task.id, task.workspace_id)
    if (!result.changes) continue
    released++
    releasedIds.add(task.id)
    counts.project.set(projectKey, projectCount + 1)
    counts.platoon.set(platoonKey, platoonCount + 1)
    counts.agent.set(agentKey, agentCount + 1)
    db_helpers.logActivity('agentos_dispatch_released', 'task', task.id, 'agentos', `AgentOS released task to ${platoon} within project concurrency limits`, { routing_agent_name: task.assigned_to }, task.workspace_id)
    // Release is the operator-visible "work is about to run" moment. Only a
    // release of previously-parked work is observable; same-pass hold+release
    // stays silent above.
    if (preHeldIds.has(task.id)) {
      eventBus.broadcast('task.status_changed', {
        workspace_id: task.workspace_id,
        id: task.id,
        status: 'assigned',
        previous_status: 'awaiting_owner',
        reason: 'agentos_dispatch_broker_release',
        platoon_id: platoon,
      })
    }
  }

  // Live-state contract (docs/cli-agent-control.md): every observable
  // dispatcher status transition is broadcast so SSE-connected operator
  // surfaces (Runs, Overview) converge instantly instead of showing QUEUED
  // work the broker has already parked as HELD until the next poll tick.
  // Held-and-released-in-the-same-pass work had no net transition — silent.
  for (const task of heldThisTick) {
    if (releasedIds.has(task.id)) continue
    eventBus.broadcast('task.status_changed', {
      workspace_id: task.workspace_id,
      id: task.id,
      status: 'awaiting_owner',
      previous_status: 'assigned',
      reason: 'agentos_dispatch_broker_hold',
    })
  }

  return { ok: true, held, released, message: `AgentOS broker held ${held} queued task(s) and released ${released} within policy limits` }
}
