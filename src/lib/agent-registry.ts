/**
 * AgentOS Agent Registry — the operational answer to "what agents do I have
 * right now, where do they live, what can they do, and can AgentOS dispatch
 * work through them?"
 *
 * Model kept strictly hierarchical and separate from project workload:
 *
 *   CLI Ecosystem / Host → Orchestrator → Specialist Agents → Capabilities
 *   (dispatch path + runtime identity + cost class are agent characteristics)
 *
 * vs (transient workload, never identity):
 *
 *   Project → Task → Assignment
 *
 * An agent's current assignment is one data point in time. Its ecosystem,
 * capabilities, runtime identity, and dispatch path are persistent. Nothing
 * here infers permanent purpose from the project an agent currently serves.
 *
 * Discovery and registration truth (from the existing modules, never
 * duplicated here):
 *   - `getGlobalAgentRoster` — live discovered specialists with capability
 *     tags and host-aware availability;
 *   - `buildRosterView` — which discovered specialists are registered as
 *     live `agents` rows plus truthful cost classification;
 *   - `discoverPlatoons` / `discoverPlatoonCommanders` — host health and the
 *     orchestrator safety state that gates dispatch.
 *
 * `dispatchable` is intentionally narrower than "exists": an agent is
 * dispatchable only when its host/orchestrator is ready AND it is registered
 * (the dispatcher joins `tasks.assigned_to` against `agents` rows) AND it is
 * not offline. "Discovered but not reconciled" is shown as a distinct state —
 * the operator can reconcile it from Project Command.
 */
import { getDatabase } from './db'
import { discoverPlatoons } from './platoons'
import { discoverPlatoonCommanders } from './platoon-commanders'
import { getGlobalAgentRoster } from './global-agent-roster'
import { buildRosterView } from './agent-roster-sync'
import { SYNCABLE_PLATOONS } from './agent-roster-sync'
import { listRecentRunsForAgent } from './agentos-runs'
import type { AgentOSRun } from './agentos-runs'

/** Transport path AgentOS uses to execute work in each ecosystem. */
const DISPATCH_PATHS: Record<string, string> = {
  gamut: 'Gamut desktop host API (native sessions)',
  hermes: 'Hermes profile CLI (orchestrator-routed)',
  codex: 'Authenticated Codex CLI',
  claude: 'Claude Code session dispatch',
}

const ECOSYSTEM_ORDER = ['gamut', 'hermes', 'codex', 'claude']

export type RegistryAvailability = 'available' | 'busy' | 'offline' | 'error'

export interface AgentRegistryAssignment {
  projectId: number | null
  projectName: string | null
  taskId: number | null
  taskTitle: string | null
  taskStatus: string | null
}

export interface AgentRegistryRecord {
  /** Stable AgentOS roster id (e.g. `pc:gamut:<slug>`). */
  externalAgentId: string
  name: string
  role: string
  ecosystem: string
  availability: RegistryAvailability
  registered: boolean
  routingAgentName: string | null
  source: string
  isCommander: boolean
  capabilities: string[]
  capabilitySource: string
  provider: string | null
  model: string | null
  costClass: string | null
  /** Dispatchable right now: host/orchestrator ready + registered + online. */
  dispatchable: boolean
  /** Why this agent is not dispatchable, when it is not. */
  blockReason: string | null
  hostReady: boolean
  /** Transient workload — never an identity attribute. */
  assignment: AgentRegistryAssignment | null
  performance: { tasks: number; completed: number; completionRate: number | null }
  lastSeen: number | null
  /** Recent executions (delegations) for this agent, from the canonical run model. */
  recentRuns: AgentOSRun[]
}

export interface RegistryEcosystemStatus {
  id: string
  name: string
  hostReady: boolean
  hostHealth: string
  dispatchPath: string | null
  orchestrator: {
    name: string
    available: boolean
    blocked: boolean
    blockReason: string | null
  } | null
  agents: AgentRegistryRecord[]
}

export interface AgentRegistrySnapshot {
  asOf: number
  ecosystems: RegistryEcosystemStatus[]
  totals: {
    agents: number
    dispatchable: number
    registered: number
    discoveredOnly: number
    unavailable: number
    ecosystems: number
  }
}

const ACTIVE_TASK_STATUSES = new Set(['inbox', 'assigned', 'in_progress', 'review', 'awaiting_owner', 'backlog'])

function isExternalSpecialist(agent: { id: string; platoonId: string }): boolean {
  return (agent.id.startsWith('pc:') || agent.id.startsWith('fs:'))
    && SYNCABLE_PLATOONS.has(agent.platoonId.toLowerCase())
}

export function buildAgentRegistrySnapshot(
  workspaceId: number,
  inputs: {
    roster?: ReturnType<typeof getGlobalAgentRoster>
    rosterView?: ReturnType<typeof buildRosterView>
    platoons?: ReturnType<typeof discoverPlatoons>
    commanders?: ReturnType<typeof discoverPlatoonCommanders>
  } = {},
): AgentRegistrySnapshot {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)

  const roster = (inputs.roster ?? getGlobalAgentRoster(workspaceId))
    .filter(isExternalSpecialist)
  const rosterView = inputs.rosterView ?? buildRosterView({ workspaceId })
  const viewById = new Map(rosterView.agents.map(agent => [agent.externalAgentId, agent]))
  const platoons = inputs.platoons ?? discoverPlatoons()
  // Runtime ids are a fixed union at the source but roster platoon ids arrive
  // as free strings (filesystem/agentos rows) — key the map on String(id).
  const platoonById = new Map<string, (typeof platoons)[number]>(platoons.map(platoon => [String(platoon.id), platoon]))
  const commanders = inputs.commanders ?? discoverPlatoonCommanders()
  const commanderById = new Map(commanders.map(commander => [commander.platoonId, commander]))

  // Commander roster ids (pc: prefix over the descriptor id) so the
  // orchestrator agents can be flagged without over-claiming.
  const commanderRosterIds = new Set<string>()
  for (const commander of commanders) {
    for (const descriptor of commander.agents) {
      if (descriptor.isCommander) commanderRosterIds.add(`pc:${descriptor.id}`)
    }
  }

  // Project names for assignment context.
  const projectRows = db.prepare(
    'SELECT id, name FROM projects WHERE workspace_id = ?',
  ).all(workspaceId) as Array<{ id: number; name: string }>
  const projectNameById = new Map(projectRows.map(project => [project.id, project.name]))

  // Current (non-terminal) workload per routing agent — newest activity wins.
  const activeTasks = db.prepare(
    `SELECT id, title, status, project_id, assigned_to, updated_at
     FROM tasks
     WHERE workspace_id = ? AND assigned_to IS NOT NULL AND status IN ('inbox','assigned','in_progress','review','awaiting_owner','backlog')
     ORDER BY updated_at DESC, id DESC LIMIT 1000`,
  ).all(workspaceId) as Array<{
    id: number
    title: string
    status: string
    project_id: number | null
    assigned_to: string
    updated_at: number | null
  }>
  const assignmentByRoutingName = new Map<string, AgentRegistryAssignment>()
  for (const task of activeTasks) {
    if (assignmentByRoutingName.has(task.assigned_to)) continue
    assignmentByRoutingName.set(task.assigned_to, {
      projectId: task.project_id,
      projectName: task.project_id !== null ? (projectNameById.get(task.project_id) ?? null) : null,
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
    })
  }

  // Last heartbeat for registered rows.
  const agentSeenRows = db.prepare(
    'SELECT name, last_seen FROM agents WHERE workspace_id = ? AND source = ?',
  ).all(workspaceId, 'agentos-external') as Array<{ name: string; last_seen: number | null }>
  const lastSeenByName = new Map(agentSeenRows.map(row => [row.name, row.last_seen]))

  const byEcosystem = new Map<string, AgentRegistryRecord[]>()
  for (const agent of roster) {
    const view = viewById.get(agent.id)
    const platoon = platoonById.get(agent.platoonId)
    const commander = commanderById.get(agent.platoonId)

    const hostReady = platoon
      ? platoon.health === 'ready' && (commander ? commander.commanderAvailable : true)
      : commander
        ? commander.commanderAvailable
        : true
    const availability = agent.availability
    const registered = view?.registered === true
    const dispatchable = hostReady
      && (availability === 'available' || availability === 'busy')
      && registered

    let blockReason: string | null = null
    if (!hostReady) {
      blockReason = commander?.blocked
        ? (commander.blockReason || `${commander.commanderName} blocked — AgentOS will not dispatch to this ecosystem`)
        : platoon
          ? platoon.installed
            ? `Host ${platoon.name} is not ready (${platoon.health})`
            : `${platoon.name} is not installed on this station`
          : 'Host status unknown'
    } else if (availability !== 'available' && availability !== 'busy') {
      blockReason = view?.blocker || `Not dispatchable — ${availability}`
    } else if (!registered) {
      blockReason = 'Discovered but not reconciled — run Reconcile & Bind in Project Command to register a dispatch row'
    }

    const routingAgentName = view?.routingAgentName ?? null
    // Recent executions come from the canonical run read model — never a
    // second implementation. Guarded: absent delegation tables (e.g.
    // pre-migration fixtures) must never break the registry snapshot.
    let recentRuns: AgentOSRun[] = []
    if (routingAgentName) {
      try {
        recentRuns = listRecentRunsForAgent({ workspaceId, agentName: routingAgentName, limit: 5 })
      } catch {
        recentRuns = []
      }
    }
    const records = byEcosystem.get(agent.platoonId) ?? []
    records.push({
      externalAgentId: agent.id,
      name: agent.name,
      role: agent.role,
      ecosystem: agent.platoonId,
      availability,
      registered,
      routingAgentName,
      source: agent.source,
      isCommander: commanderRosterIds.has(agent.id),
      capabilities: agent.capabilities.tags,
      capabilitySource: agent.capabilities.source,
      provider: view?.provider ?? agent.provider ?? null,
      model: view?.model ?? agent.model ?? null,
      costClass: view?.costClass ?? null,
      dispatchable,
      blockReason,
      hostReady,
      assignment: routingAgentName ? (assignmentByRoutingName.get(routingAgentName) ?? null) : null,
      performance: agent.performance,
      lastSeen: routingAgentName ? (lastSeenByName.get(routingAgentName) ?? null) : null,
      // Consumer of the canonical run read model — never a second implementation.
      // Guarded: absent delegation tables (e.g. pre-migration fixtures) must
      // never break the registry snapshot.
      recentRuns,
    })
    byEcosystem.set(agent.platoonId, records)
  }

  const ecosystems: RegistryEcosystemStatus[] = []
  const orderedEcosystemIds = [...new Set([...ECOSYSTEM_ORDER, ...[...byEcosystem.keys()].sort()])]
  for (const ecosystemId of orderedEcosystemIds) {
    const agents = byEcosystem.get(ecosystemId)
    if (!agents || agents.length === 0) continue
    const platoon = platoonById.get(ecosystemId)
    const commander = commanderById.get(ecosystemId)
    const hostHealth = platoon
      ? platoon.installed
        ? platoon.health
        : 'not-installed'
      : commander
        ? commander.commanderAvailable
          ? 'ready'
          : 'degraded'
        : 'unknown'
    const hostReady = hostHealth === 'ready'
    ecosystems.push({
      id: ecosystemId,
      name: platoon?.name ?? ecosystemId,
      hostReady,
      hostHealth,
      dispatchPath: DISPATCH_PATHS[ecosystemId] ?? null,
      orchestrator: commander
        ? { name: commander.commanderName, available: commander.commanderAvailable, blocked: commander.blocked, blockReason: commander.blockReason }
        : null,
      agents: [...agents].sort((a, b) => Number(b.isCommander) - Number(a.isCommander) || a.name.localeCompare(b.name)),
    })
  }

  const allAgents = ecosystems.flatMap(ecosystem => ecosystem.agents)
  const totals = {
    agents: allAgents.length,
    dispatchable: allAgents.filter(agent => agent.dispatchable).length,
    registered: allAgents.filter(agent => agent.registered).length,
    discoveredOnly: allAgents.filter(agent => !agent.registered).length,
    unavailable: allAgents.filter(agent => agent.availability === 'offline' || agent.availability === 'error').length,
    ecosystems: ecosystems.length,
  }

  return { asOf: now, ecosystems, totals }
}
