/**
 * AgentOS Roster Sync — register discovered external specialists as live
 * Mission Control roster agents and bind them to projects.
 *
 * The missing bridge: AgentOS *discovers* Gamut/Hermes/Codex specialists via
 * the platoon-commander adapters (global roster), but the normal dispatcher
 * ultimately dispatches tasks joined against `agents` rows. This module makes
 * that join possible by upserting one stable, idempotent `agentos-external`
 * agent row per discovered specialist (same identity scheme as project
 * bindings) and — when a project is supplied — ensuring that project's
 * bindings exist so capability routing can select them.
 *
 * Hard rules:
 *  - idempotent: repeated sync never duplicates (stable name = platoon +
 *    slugified display name + hash of the external agent ID);
 *  - never deletes: unavailable specialists are marked offline/error, and
 *    historical rows survive a temporarily-down runtime;
 *  - truthful cost metadata: provider/model are stored only when actually
 *    known. A localhost host runtime with no model/provider evidence must
 *    classify UNKNOWN_COST, never FREE_LOCAL (see execution-planning).
 */
import { getDatabase, db_helpers } from './db'
import { getGlobalAgentRoster, type GlobalRosterAgent } from './global-agent-roster'
import { agentosRoutingAgentName, bindExternalAgentToProject, listExternalProjectBindings, ensureRoutingProxy } from './external-project-bindings'
import { classifyExecutionCost, type ExecutionCostClass } from './execution-planning'
import { getOrCreateAgentOSOperationsProject } from './agentos-operations'
import { logger } from './logger'

/** Platoons with a native AgentOS dispatch adapter (task-dispatch runtime switch). */
export const SYNCABLE_PLATOONS = new Set(['gamut', 'hermes', 'codex', 'claude'])

export type AgentAvailability = GlobalRosterAgent['availability']

/** Optional truthful provider/model evidence discovered for a roster agent. */
export interface RosterAgentCostMeta {
  provider?: string | null
  model?: string | null
  /** Explicit free-local evidence (e.g. a definition-declared local model). */
  freeLocal?: boolean
}

export interface RosterSyncReport {
  workspaceId: number
  projectId?: number | null
  discovered: number
  registered: number
  added: number
  updated: number
  markedOffline: number
  boundAdded: number
  boundUpdated: number
  dispatchable: number
  unavailable: number
  classifications: Record<ExecutionCostClass, number>
  agents: Array<{
    externalAgentId: string
    name: string
    platoonId: string
    availability: AgentAvailability
    registered: boolean
    routingAgentName: string | null
    runtimeType: string | null
    provider: string | null
    model: string | null
    costClass: ExecutionCostClass | null
    blocker: string | null
  }>
}

interface AgentRow {
  id: number
  name: string
  role: string
  status: string
  config: string | null
  workspace_path: string | null
  runtime_type: string | null
  source: string | null
  hidden: number | null
  last_seen: number | null
}

function statusFor(availability: AgentAvailability): 'online' | 'offline' | 'error' {
  if (availability === 'error') return 'error'
  if (availability === 'available' || availability === 'busy') return 'online'
  return 'offline'
}

function configFor(agent: GlobalRosterAgent, meta?: RosterAgentCostMeta): string {
  const config: Record<string, unknown> = {
    agentos: {
      externalAgentId: agent.id,
      externalAgentName: agent.name,
      platoonId: agent.platoonId,
    },
  }
  if (meta?.provider) config.provider = meta.provider
  if (meta?.model) config.model = meta.model
  if (meta?.freeLocal === true) {
    config.agentos = {
      ...(config.agentos as Record<string, unknown>),
      cost: { freeLocal: true },
    }
  }
  return JSON.stringify(config)
}

/**
 * Cost metadata for a roster agent: an explicit caller override wins;
 * otherwise the agent's own inherited provider/model (from platoon/host
 * discovery) is used so classification is truthful without manual input.
 */
function effectiveCostMeta(agent: GlobalRosterAgent, override?: RosterAgentCostMeta): RosterAgentCostMeta | undefined {
  if (override) return override
  if (agent.provider || agent.model) return { provider: agent.provider ?? null, model: agent.model ?? null }
  return undefined
}

function isExternalDiscovered(agent: GlobalRosterAgent): boolean {
  // Mission Control rows (mc:*) are already registered by definition. We
  // register the platoon-discovered specialists (pc: commanders adapters and
  // fs: filesystem agents) that a native AgentOS dispatch adapter can run.
  return (agent.id.startsWith('pc:') || agent.id.startsWith('fs:'))
    && SYNCABLE_PLATOONS.has(agent.platoonId.toLowerCase())
}

function normalizeRole(agent: GlobalRosterAgent): string {
  return (agent.role || agent.archetype || 'External Agent').slice(0, 200) || 'External Agent'
}

/** Register discovered roster agents as live `agents` rows (idempotent). */
export function registerRosterAgents(input: {
  workspaceId: number
  roster?: GlobalRosterAgent[]
  costMeta?: Record<string, RosterAgentCostMeta>
  actor?: string | null
}): { added: number; updated: number; markedOffline: number; registered: number } {
  const db = getDatabase()
  const roster = input.roster ?? getGlobalAgentRoster(input.workspaceId)
  const now = Math.floor(Date.now() / 1000)
  let added = 0
  let updated = 0
  let markedOffline = 0
  let registered = 0

  const findStmt = db.prepare('SELECT id, name, role, status, config, workspace_path, runtime_type, source, hidden, last_seen FROM agents WHERE name = ? AND workspace_id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO agents (name, role, status, config, workspace_id, source, workspace_path, hidden, runtime_type, created_at, updated_at, last_seen)
    VALUES (?, ?, ?, ?, ?, 'agentos-external', ?, 1, ?, ?, ?, ?)
  `)
  const updateStmt = db.prepare(`
    UPDATE agents SET role = ?, status = ?, config = ?, workspace_path = ?, runtime_type = ?, updated_at = ?, last_seen = ?
    WHERE id = ? AND workspace_id = ?
  `)
  const refreshSeenStmt = db.prepare('UPDATE agents SET last_seen = ? WHERE id = ? AND workspace_id = ?')

  for (const agent of roster) {
    if (!isExternalDiscovered(agent)) continue
    const name = agentosRoutingAgentName(agent)
    const status = statusFor(agent.availability)
    const configJson = configFor(agent, effectiveCostMeta(agent, input.costMeta?.[agent.id]))
    const role = normalizeRole(agent)

    const existing = findStmt.get(name, input.workspaceId) as AgentRow | undefined
    if (!existing) {
      insertStmt.run(name, role, status, configJson, input.workspaceId, agent.definitionPath, agent.platoonId, now, now, now)
      added++
      registered++
      continue
    }
    registered++
    const existingConfig = (() => {
      try { return existing.config ? JSON.parse(existing.config) : {} } catch { return {} }
    })()
    const newConfig = (() => {
      try { return JSON.parse(configJson) } catch { return {} }
    })()
    const changed = existing.role !== role
      || existing.status !== status
      || existing.runtime_type !== agent.platoonId
      || existing.workspace_path !== agent.definitionPath
      || JSON.stringify(existingConfig) !== JSON.stringify(newConfig)
    if (changed) {
      updateStmt.run(role, status, configJson, agent.definitionPath, agent.platoonId, now, now, existing.id, input.workspaceId)
      if (status !== 'online') markedOffline++
      else updated++
      continue
    }
    // Liveness: agentos-external rows have no native heartbeat channel, so the
    // roster sync cadence keeps available rows fresh against the MC heartbeat
    // check (which marks rows offline after the timeout). Refresh last_seen only
    // when stale, so steady-state sync stays a cheap no-op.
    if (status === 'online' && (existing.last_seen === null || now - existing.last_seen > 120)) {
      refreshSeenStmt.run(now, existing.id, input.workspaceId)
      updated++
    }
  }
  if (added > 0 || updated > 0 || markedOffline > 0) {
    db_helpers.logActivity(
      'agentos_roster_registered', 'workspace', input.workspaceId, input.actor || 'agentos',
      `Roster registration: ${added} added, ${updated} updated, ${markedOffline} marked offline`,
      { added, updated, markedOffline, total: roster.length },
      input.workspaceId,
    )
  }
  return { added, updated, markedOffline, registered }
}

/** Ensure every registered, available external specialist is bound to a project. */
export function bindAvailableRosterToProject(input: {
  workspaceId: number
  projectId: number
  roster?: GlobalRosterAgent[]
  actor?: string | null
}): { boundAdded: number; boundUpdated: number; bound: number; unavailable: number } {
  const roster = input.roster ?? getGlobalAgentRoster(input.workspaceId)
  const existing = listExternalProjectBindings(input.projectId, input.workspaceId)
  const existingById = new Map(existing.map(binding => [`${binding.platoonId}:${binding.externalAgentId}`, binding]))
  let boundAdded = 0
  let boundUpdated = 0
  let bound = 0
  let unavailable = 0

  for (const agent of roster) {
    if (!isExternalDiscovered(agent)) continue
    if (agent.availability !== 'available' && agent.availability !== 'busy') {
      unavailable++
      continue
    }
    const key = `${agent.platoonId}:${agent.id}`
    const current = existingById.get(key)
    const caps = agent.capabilities.tags
    const capsEqual = current && JSON.stringify(current.capabilities) === JSON.stringify(caps)
    if (current && current.agentName === agent.name && capsEqual) {
      bound++
      continue
    }
    bindExternalAgentToProject({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      externalAgentId: agent.id,
      actor: input.actor || 'agentos',
    })
    if (current) boundUpdated++
    else boundAdded++
    bound++
  }
  if (boundAdded > 0 || boundUpdated > 0) {
    db_helpers.logActivity(
      'agentos_roster_bound', 'project', input.projectId, input.actor || 'agentos',
      `Roster bindings reconciled: ${boundAdded} added, ${boundUpdated} updated`,
      { boundAdded, boundUpdated, project_id: input.projectId },
      input.workspaceId,
    )
  }
  return { boundAdded, boundUpdated, bound, unavailable }
}

function classificationOf(agent: GlobalRosterAgent, meta?: RosterAgentCostMeta) {
  const provider = meta?.provider ?? null
  const model = meta?.model ?? null
  const agentConfig = meta?.freeLocal
    ? { agentos: { cost: { freeLocal: true } } }
    : meta?.provider || meta?.model
      ? { provider, model }
      : {}
  return classifyExecutionCost({
    runtimeType: agent.platoonId,
    provider,
    model,
    agentConfig: Object.keys(agentConfig).length ? agentConfig as Record<string, unknown> : null,
  })
}

/**
 * One-shot reconcile: register discovered specialists (+ optional project
 * binding) and produce a report with truthful runtime/cost classification.
 */
export function syncAgentRoster(input: {
  workspaceId: number
  projectId?: number | null
  roster?: GlobalRosterAgent[]
  costMeta?: Record<string, RosterAgentCostMeta>
  actor?: string | null
}): RosterSyncReport {
  const roster = input.roster ?? getGlobalAgentRoster(input.workspaceId)
  const registration = registerRosterAgents({
    workspaceId: input.workspaceId,
    roster,
    costMeta: input.costMeta,
    actor: input.actor,
  })
  let binding: { boundAdded: number; boundUpdated: number; bound: number; unavailable: number } | null = null
  if (input.projectId) {
    binding = bindAvailableRosterToProject({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      roster,
      actor: input.actor,
    })
  }

  const classifications: Record<ExecutionCostClass, number> = {
    FREE_LOCAL: 0, FREE_REMOTE: 0, PAID_KNOWN: 0, PAID_ESTIMATED: 0,
    UNKNOWN_COST: 0, MANUAL_EXTERNAL: 0, BLOCKED: 0,
  }
  let dispatchable = 0
  let unavailable = 0

  const agents = roster
    .filter(isExternalDiscovered)
    .map(agent => {
      const classified = classificationOf(agent, effectiveCostMeta(agent, input.costMeta?.[agent.id]))
      classifications[classified.costClass]++
      const blocker = agent.availability === 'available' || agent.availability === 'busy'
        ? null
        : `Not dispatchable — ${agent.availability}`
      if (agent.availability === 'available' || agent.availability === 'busy') dispatchable++
      else unavailable++
      return {
        externalAgentId: agent.id,
        name: agent.name,
        platoonId: agent.platoonId,
        availability: agent.availability,
        registered: true,
        routingAgentName: agentosRoutingAgentName(agent),
        runtimeType: agent.platoonId,
        provider: classified.provider,
        model: classified.model,
        costClass: classified.costClass,
        blocker,
      }
    })

  const report: RosterSyncReport = {
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    discovered: roster.length,
    registered: registration.registered,
    added: registration.added,
    updated: registration.updated,
    markedOffline: registration.markedOffline,
    boundAdded: binding?.boundAdded ?? 0,
    boundUpdated: binding?.boundUpdated ?? 0,
    dispatchable,
    unavailable,
    classifications,
    agents,
  }

  logger.info({ ...report, agents: undefined }, 'AgentOS roster sync complete')
  db_helpers.logActivity(
    'agentos_roster_reconciled', 'workspace', input.workspaceId, input.actor || 'agentos',
    `Roster reconcile: ${registration.registered} registered (${registration.added} added), ${report.dispatchable} dispatchable, ${report.unavailable} unavailable`,
    { added: registration.added, dispatchable: report.dispatchable, unavailable: report.unavailable },
    input.workspaceId,
  )
  return report
}

/**
 * Read-only roster view — no writes, no activity. For each discovered
 * external specialist report whether a live registration row exists and the
 * cost class dispatch would apply. Used by GET endpoints and the UI.
 */
export function buildRosterView(input: {
  workspaceId: number
  roster?: GlobalRosterAgent[]
  costMeta?: Record<string, RosterAgentCostMeta>
}): {
  discovered: number
  registered: number
  dispatchable: number
  unavailable: number
  classifications: Record<ExecutionCostClass, number>
  agents: RosterSyncReport['agents']
} {
  const roster = input.roster ?? getGlobalAgentRoster(input.workspaceId)
  const db = getDatabase()
  const classifications: Record<ExecutionCostClass, number> = {
    FREE_LOCAL: 0, FREE_REMOTE: 0, PAID_KNOWN: 0, PAID_ESTIMATED: 0,
    UNKNOWN_COST: 0, MANUAL_EXTERNAL: 0, BLOCKED: 0,
  }
  let dispatchable = 0
  let unavailable = 0
  let registered = 0
  const agents = roster
    .filter(isExternalDiscovered)
    .map(agent => {
      const name = agentosRoutingAgentName(agent)
      const row = db.prepare('SELECT name FROM agents WHERE name = ? AND workspace_id = ?')
        .get(name, input.workspaceId) as { name: string } | undefined
      const isRegistered = !!row
      if (isRegistered) registered++
      const classified = classificationOf(agent, effectiveCostMeta(agent, input.costMeta?.[agent.id]))
      classifications[classified.costClass]++
      const canRun = agent.availability === 'available' || agent.availability === 'busy'
      if (canRun) dispatchable++
      else unavailable++
      return {
        externalAgentId: agent.id,
        name: agent.name,
        platoonId: agent.platoonId,
        availability: agent.availability,
        registered: isRegistered,
        routingAgentName: isRegistered ? name : null,
        runtimeType: agent.platoonId,
        provider: classified.provider,
        model: classified.model,
        costClass: classified.costClass,
        blocker: canRun ? null : `Not dispatchable — ${agent.availability}`,
      }
    })
  return { discovered: roster.length, registered, dispatchable, unavailable, classifications, agents }
}

/** Convenience: reconcile and bind the per-workspace AgentOS Operations project. */
export function reconcileOpsProjectRoster(input: {
  workspaceId: number
  actor?: string | null
}): RosterSyncReport {
  const ops = getOrCreateAgentOSOperationsProject(input.workspaceId)
  return syncAgentRoster({
    workspaceId: input.workspaceId,
    projectId: ops.id,
    actor: input.actor,
  })
}
