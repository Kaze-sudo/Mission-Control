/**
 * AgentOS status snapshot — a single read-only aggregation of the live
 * orchestration picture for the Overview surface.
 *
 * The Mission Control Overview previously had no AgentOS representation: it
 * showed Mission Control-native agents/tasks/sessions, while the AgentOS
 * command layer (platoons, project command state, roster specialists,
 * delegations, cost-bounded execution) lived only inside the Project Command
 * and Platoons panels. This module composes that state into one lightweight,
 * workspace-scoped snapshot so the operations-center home page can surface:
 *
 *   - CLI host/provider health (ready / degraded / offline) per platoon
 *   - project command state (active / paused / blocked …) with the paused
 *     and blocked projects named
 *   - live roster dispatchability (available specialists vs unavailable) and
 *     cost classification counts
 *   - AgentOS-gated execution: objectives by status + gated missions by
 *     state bucket (running / queued / held / review / done / failed)
 *   - recent orchestration errors — terminal delegation failures (including
 *     provider failures such as OpenRouter 402) and failed / needs-manual
 *     objectives — so execution problems are never buried in logs alone
 *
 * Pure read path: no writes, no activity logging. All external discovery
 * calls (platoons, commanders, roster) are delegated to the existing modules
 * so this stays a composition, not a second implementation.
 */
import { getDatabase } from './db'
import { discoverPlatoons } from './platoons'
import { discoverPlatoonCommanders } from './platoon-commanders'
import { buildRosterView } from './agent-roster-sync'
import type { ExecutionCostClass } from './execution-planning'

/** A gated mission is a task AgentOS created for an objective / review /
 *  curation mission. Mirrors execution-planning.isAgentOSGatedTask without
 *  importing the whole planning module here (keeps this aggregation cheap). */
function isAgentOSGatedTaskMetadata(metadata: Record<string, unknown>): boolean {
  if (!metadata || typeof metadata !== 'object') return false
  if (metadata.agentos && typeof metadata.agentos === 'object') return true
  if (metadata.agentos_resource_review && typeof metadata.agentos_resource_review === 'object') return true
  if (metadata.agentos_knowledge_curation && typeof metadata.agentos_knowledge_curation === 'object') return true
  return false
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export type PlatoonHealthLabel = 'ready' | 'degraded' | 'offline' | 'not-installed'

export interface AgentOSPlatoonStatus {
  id: string
  name: string
  installed: boolean
  running: boolean
  authenticated: boolean
  authRequired: boolean
  /** Resolved host health (offline when not installed). */
  health: PlatoonHealthLabel
  /** Platoon commander overlay (hermes/codex/gamut only) when one exists. */
  commander: {
    name: string
    available: boolean
    blocked: boolean
    blockReason: string | null
    agentCount: number
  } | null
  /** Live roster specialists discovered under this platoon. */
  specialists: { total: number; available: number; unavailable: number }
}

export interface AgentOSProjectCommandState {
  id: number
  name: string
  state: string
  updatedBy: string | null
  updatedAt: number | null
}

export interface AgentOSAttentionItem {
  id: string
  kind: 'delegation' | 'objective'
  level: 'error' | 'warn'
  taskId: number | null
  projectId: number | null
  projectName: string | null
  title: string
  detail: string | null
  at: number
}

export interface AgentOSStatusSnapshot {
  asOf: number
  /** True when any part of the AgentOS command layer is actually in use. */
  configured: boolean
  command: {
    totalProjects: number
    commanded: number
    states: Record<string, number>
    paused: AgentOSProjectCommandState[]
    blocked: AgentOSProjectCommandState[]
  }
  platoons: AgentOSPlatoonStatus[]
  roster: {
    discovered: number
    registered: number
    dispatchable: number
    unavailable: number
    classifications: Partial<Record<ExecutionCostClass, number>>
  }
  execution: {
    objectives: { total: number; byStatus: Record<string, number> }
    missions: { total: number; running: number; queued: number; held: number; review: number; done: number; failed: number; cancelled: number; other: number }
  }
  attention: AgentOSAttentionItem[]
  timestamps: {
    /** Newest roster registration/refresh activity (agents.last_seen). */
    lastRosterSeen: number | null
    /** Newest project command update. */
    lastCommandUpdate: number | null
    /** Newest delegation attempt of any kind. */
    lastDelegation: number | null
  }
}

function healthLabel(health: string, installed: boolean): PlatoonHealthLabel {
  if (!installed) return 'not-installed'
  return health as PlatoonHealthLabel
}

const MAX_ATTENTION_ITEMS = 10

/**
 * Build the current AgentOS status snapshot for a workspace.
 *
 * Optional discovery inputs exist only for hermetic testing; production call
 * sites omit them and the live discovery modules are used.
 */
export function buildAgentOSStatusSnapshot(
  workspaceId: number,
  inputs: {
    platoons?: ReturnType<typeof discoverPlatoons>
    commanders?: ReturnType<typeof discoverPlatoonCommanders>
    rosterView?: ReturnType<typeof buildRosterView>
  } = {},
): AgentOSStatusSnapshot {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)

  // --- Projects + project command state --------------------------------
  const projectRows = db.prepare(
    'SELECT id, name FROM projects WHERE workspace_id = ?',
  ).all(workspaceId) as Array<{ id: number; name: string }>
  const projectNameById = new Map(projectRows.map(project => [project.id, project.name]))

  const commandRows = db.prepare(
    `SELECT c.project_id, c.state, c.updated_by, c.updated_at, p.name
     FROM agentos_project_command c
     JOIN projects p ON p.id = c.project_id AND p.workspace_id = c.workspace_id
     WHERE c.workspace_id = ?`,
  ).all(workspaceId) as Array<{
    project_id: number
    state: string
    updated_by: string | null
    updated_at: number | null
    name: string
  }>
  const states: Record<string, number> = {}
  const paused: AgentOSProjectCommandState[] = []
  const blocked: AgentOSProjectCommandState[] = []
  let lastCommandUpdate: number | null = null
  for (const row of commandRows) {
    states[row.state] = (states[row.state] || 0) + 1
    const entry: AgentOSProjectCommandState = {
      id: row.project_id,
      name: row.name,
      state: row.state,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    }
    if (row.state === 'paused') paused.push(entry)
    if (row.state === 'blocked') blocked.push(entry)
    if (row.updated_at !== null && (lastCommandUpdate === null || row.updated_at > lastCommandUpdate)) {
      lastCommandUpdate = row.updated_at
    }
  }
  paused.sort((a, b) => a.name.localeCompare(b.name))
  blocked.sort((a, b) => a.name.localeCompare(b.name))

  // --- Objectives -------------------------------------------------------
  const objectiveRows = db.prepare(
    'SELECT status, project_id FROM agentos_objectives WHERE workspace_id = ?',
  ).all(workspaceId) as Array<{ status: string; project_id: number }>
  const objectiveByStatus: Record<string, number> = {}
  const failedObjectives: Array<{ status: string; project_id: number }> = []
  for (const row of objectiveRows) {
    objectiveByStatus[row.status] = (objectiveByStatus[row.status] || 0) + 1
    if (row.status === 'failed') failedObjectives.push(row)
  }

  // --- Gated missions (tasks carrying AgentOS metadata) -----------------
  const taskRows = db.prepare(
    'SELECT id, title, status, project_id, metadata FROM tasks WHERE workspace_id = ? ORDER BY id DESC LIMIT 1000',
  ).all(workspaceId) as Array<{ id: number; title: string; status: string; project_id: number | null; metadata: string | null }>
  const missionBuckets = {
    running: 0, queued: 0, held: 0, review: 0, done: 0, failed: 0, cancelled: 0, other: 0,
  }
  // Delegations are keyed by task id (many attempts per task).
  const gatedTasks = taskRows.filter((task) => isAgentOSGatedTaskMetadata(parseMetadata(task.metadata)))
  const gatedTotal = gatedTasks.length
  for (const task of gatedTasks) {
    switch (task.status) {
      case 'in_progress': missionBuckets.running++; break
      case 'assigned': missionBuckets.queued++; break
      case 'awaiting_owner':
      case 'backlog': missionBuckets.held++; break
      case 'review': missionBuckets.review++; break
      case 'done': missionBuckets.done++; break
      case 'failed': missionBuckets.failed++; break
      case 'cancelled': missionBuckets.cancelled++; break
      default: missionBuckets.other++; break
    }
  }

  // --- Delegations: recent terminal errors ------------------------------
  const delegationRows = db.prepare(
    `SELECT id, task_id, project_id, platoon_id, specialist_name, status, attempt,
            error_message, result_summary, created_at, updated_at
     FROM agentos_delegations WHERE workspace_id = ?
     ORDER BY updated_at DESC, created_at DESC LIMIT 200`,
  ).all(workspaceId) as Array<{
    id: string
    task_id: number
    project_id: number | null
    platoon_id: string | null
    specialist_name: string | null
    status: string
    attempt: number | null
    error_message: string | null
    result_summary: string | null
    created_at: number | null
    updated_at: number | null
  }>
  let lastDelegation: number | null = null
  for (const delegation of delegationRows) {
    const at = delegation.updated_at ?? delegation.created_at
    if (at !== null && (lastDelegation === null || at > lastDelegation)) lastDelegation = at
  }

  // One error item per task — the NEWEST terminal failed delegation wins.
  const delegationErrorByTask = new Map<number, AgentOSAttentionItem>()
  for (const delegation of delegationRows) {
    if (delegation.status !== 'failed' && delegation.status !== 'cancelled') continue
    if (!delegation.error_message) continue
    if (delegationErrorByTask.has(delegation.task_id)) continue
    delegationErrorByTask.set(delegation.task_id, {
      id: `del-${delegation.id}`,
      kind: 'delegation',
      level: 'error',
      taskId: delegation.task_id,
      projectId: delegation.project_id,
      projectName: delegation.project_id !== null ? (projectNameById.get(delegation.project_id) ?? null) : null,
      title: `Dispatch to ${delegation.specialist_name || delegation.platoon_id || 'specialist'} failed (attempt ${delegation.attempt ?? '?'})`,
      detail: delegation.error_message,
      at: delegation.updated_at ?? delegation.created_at ?? 0,
    })
  }

  // --- Attention list ---------------------------------------------------
  const attention: AgentOSAttentionItem[] = []
  for (const objective of failedObjectives) {
    attention.push({
      id: `objective-${objective.project_id}-failed`,
      kind: 'objective',
      level: 'error',
      taskId: null,
      projectId: objective.project_id,
      projectName: projectNameById.get(objective.project_id) ?? null,
      title: `Objective failed in ${projectNameById.get(objective.project_id) ?? 'project'}`,
      detail: null,
      at: 0,
    })
  }
  for (const [, item] of delegationErrorByTask) attention.push(item)
  // Objective-level failures have no event timestamp (at=0) so they sort last;
  // keep them visible by anchoring each failed objective at the newest
  // delegation timestamp when one exists for the same project.
  for (const item of attention) {
    if (item.kind === 'objective' && item.at === 0 && item.projectId !== null) {
      const newestForProject = delegationRows
        .filter(d => d.project_id === item.projectId && (d.updated_at ?? d.created_at) !== null)
        .reduce<number>((max, d) => Math.max(max, d.updated_at ?? d.created_at ?? 0), 0)
      if (newestForProject > 0) item.at = newestForProject
    }
  }
  attention.sort((a, b) => b.at - a.at)
  const cappedAttention = attention.slice(0, MAX_ATTENTION_ITEMS)

  // --- Platoon host health + commanders ---------------------------------
  const platoons = inputs.platoons ?? discoverPlatoons()
  const commanders = inputs.commanders ?? discoverPlatoonCommanders()
  const commanderById = new Map(commanders.map(commander => [commander.platoonId, commander]))

  // --- Roster specialists ------------------------------------------------
  const rosterView = inputs.rosterView ?? buildRosterView({ workspaceId })
  const specialistByPlatoon = new Map<string, { total: number; available: number; unavailable: number }>()
  let lastRosterSeen: number | null = null
  try {
    const seen = db.prepare(
      'SELECT MAX(last_seen) AS last_seen FROM agents WHERE workspace_id = ? AND source = ?',
    ).get(workspaceId, 'agentos-external') as { last_seen: number | null }
    lastRosterSeen = seen.last_seen ?? null
  } catch {
    lastRosterSeen = null
  }

  const platoonStatus: AgentOSPlatoonStatus[] = platoons.map((platoon) => {
    const commander = commanderById.get(platoon.id)
    const rosterAgents = rosterView.agents.filter(agent => agent.platoonId === platoon.id)
    const counts = { total: rosterAgents.length, available: 0, unavailable: 0 }
    for (const agent of rosterAgents) {
      if (agent.availability === 'available' || agent.availability === 'busy') counts.available++
      else counts.unavailable++
    }
    specialistByPlatoon.set(platoon.id, counts)
    return {
      id: platoon.id,
      name: platoon.name,
      installed: platoon.installed,
      running: platoon.running,
      authenticated: platoon.authenticated,
      authRequired: platoon.authRequired,
      health: healthLabel(platoon.health, platoon.installed),
      commander: commander
        ? {
            name: commander.commanderName,
            available: commander.commanderAvailable,
            blocked: commander.blocked,
            blockReason: commander.blockReason,
            agentCount: commander.agents.length,
          }
        : null,
      specialists: counts,
    }
  })

  const configured =
    commandRows.length > 0
    || objectiveRows.length > 0
    || gatedTotal > 0
    || delegationRows.length > 0
    || platoonStatus.some(platoon => platoon.specialists.total > 0 || platoon.commander?.agentCount)

  return {
    asOf: now,
    configured,
    command: {
      totalProjects: projectRows.length,
      commanded: commandRows.length,
      states,
      paused,
      blocked,
    },
    platoons: platoonStatus,
    roster: {
      discovered: rosterView.discovered,
      registered: rosterView.registered,
      dispatchable: rosterView.dispatchable,
      unavailable: rosterView.unavailable,
      classifications: { ...rosterView.classifications },
    },
    execution: {
      objectives: { total: objectiveRows.length, byStatus: objectiveByStatus },
      missions: { total: gatedTotal, ...missionBuckets },
    },
    attention: cappedAttention,
    timestamps: {
      lastRosterSeen,
      lastCommandUpdate,
      lastDelegation,
    },
  }
}
