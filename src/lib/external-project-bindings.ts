import { createHash } from 'node:crypto'
import { getDatabase } from './db'
import { getGlobalAgentRoster, type GlobalRosterAgent } from './global-agent-roster'

export interface ExternalProjectBinding {
  id: number
  projectId: number
  workspaceId: number
  platoonId: string
  externalAgentId: string
  agentName: string
  role: string
  routingAgentName: string | null
  definitionPath: string | null
  capabilities: string[]
  boundBy: string | null
  boundAt: number
  updatedAt: number
  availability: GlobalRosterAgent['availability'] | 'unknown'
}

interface BindingRow {
  id: number
  project_id: number
  workspace_id: number
  platoon_id: string
  external_agent_id: string
  agent_name: string
  role: string
  routing_agent_name: string | null
  definition_path: string | null
  capability_snapshot: string | null
  bound_by: string | null
  bound_at: number
  updated_at: number
}

function parseCapabilities(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function assertProject(db: ReturnType<typeof getDatabase>, projectId: number, workspaceId: number): void {
  const project = db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?').get(projectId, workspaceId)
  if (!project) throw new Error('Project not found')
}

/**
 * Stable Mission Control routing identity for a discovered roster agent.
 *
 * Keyed on platoon + slugified display name + a short hash of the external
 * agent ID (never display name alone), so repeated registration/binding maps
 * the same specialist to the same agents row without duplicates.
 */
export function agentosRoutingAgentName(agent: {
  platoonId: string
  name: string
  id: string
}): string {
  const platoon = agent.platoonId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 24) || 'external'
  const name = agent.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 36) || 'agent'
  const hash = createHash('sha256').update(agent.id).digest('hex').slice(0, 8)
  return `agentos:${platoon}:${name}:${hash}`
}

function routingAgentName(agent: GlobalRosterAgent): string {
  return agentosRoutingAgentName(agent)
}

export function ensureRoutingProxy(db: ReturnType<typeof getDatabase>, agent: GlobalRosterAgent, workspaceId: number): string {
  const proxyName = routingAgentName(agent)
  const incoming: Record<string, unknown> = {
    agentos: { externalAgentId: agent.id, externalAgentName: agent.name, platoonId: agent.platoonId },
  }
  if (agent.platoonId === 'openclaw') incoming.openclawId = agent.name

  // Same-identity re-registration (roster sync, re-bind) must NOT wipe richer
  // metadata the sync layer stored on the row (truthful provider/model and
  // free-local cost evidence). Merge when the prior row points at the same
  // external agent; otherwise start from the fresh minimal config.
  let config = incoming
  const existing = db.prepare('SELECT config FROM agents WHERE name = ? AND workspace_id = ?')
    .get(proxyName, workspaceId) as { config: string | null } | undefined
  if (existing?.config) {
    try {
      const prior = JSON.parse(existing.config)
      if (prior && typeof prior === 'object' && (prior as Record<string, unknown>).agentos
        && typeof (prior as Record<string, unknown>).agentos === 'object') {
        const priorAgentos = (prior as Record<string, unknown>).agentos as Record<string, unknown>
        if (priorAgentos.externalAgentId === agent.id) {
          config = { ...prior, ...incoming }
          config.agentos = { ...priorAgentos, ...(incoming.agentos as Record<string, unknown>) }
          if (incoming.openclawId !== undefined) config.openclawId = incoming.openclawId
        }
      }
    } catch { /* malformed prior config — replace with minimal */ }
  }

  // Keep the exact row shape the roster sync writes, so repeated reconcile is a
  // stable no-op: role sliced to the same limit, and availability mapped the
  // same way (available/busy → online; error → error; else offline).
  const role = (agent.role || 'External Agent').slice(0, 200) || 'External Agent'
  const status = agent.availability === 'available' || agent.availability === 'busy'
    ? 'online'
    : agent.availability === 'error' ? 'error' : 'offline'
  db.prepare(`
    INSERT INTO agents (name, role, status, config, workspace_id, source, workspace_path, hidden, runtime_type, updated_at)
    VALUES (?, ?, ?, ?, ?, 'agentos-external', ?, 1, ?, unixepoch())
    ON CONFLICT(name, workspace_id) DO UPDATE SET
      role = excluded.role, status = excluded.status, config = excluded.config,
      source = excluded.source, workspace_path = excluded.workspace_path,
      hidden = 1, runtime_type = excluded.runtime_type, updated_at = unixepoch()
  `).run(proxyName, role, status, JSON.stringify(config), workspaceId, agent.definitionPath, agent.platoonId)
  return proxyName
}

export function listExternalProjectBindings(projectId: number, workspaceId: number): ExternalProjectBinding[] {
  const db = getDatabase()
  assertProject(db, projectId, workspaceId)
  const rows = db.prepare(`
    SELECT id, project_id, workspace_id, platoon_id, external_agent_id, agent_name,
           role, routing_agent_name, definition_path, capability_snapshot, bound_by, bound_at, updated_at
    FROM project_external_agent_bindings
    WHERE project_id = ? AND workspace_id = ?
    ORDER BY platoon_id COLLATE NOCASE, agent_name COLLATE NOCASE
  `).all(projectId, workspaceId) as BindingRow[]

  const availability = new Map(
    getGlobalAgentRoster(workspaceId).map(agent => [agent.id, agent.availability] as const)
  )

  return rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    platoonId: row.platoon_id,
    externalAgentId: row.external_agent_id,
    agentName: row.agent_name,
    role: row.role,
    routingAgentName: row.routing_agent_name,
    definitionPath: row.definition_path,
    capabilities: parseCapabilities(row.capability_snapshot),
    boundBy: row.bound_by,
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
    availability: availability.get(row.external_agent_id) || 'unknown',
  }))
}

export function bindExternalAgentToProject(input: {
  projectId: number
  workspaceId: number
  externalAgentId: string
  role?: string
  actor?: string | null
}): ExternalProjectBinding {
  const db = getDatabase()
  assertProject(db, input.projectId, input.workspaceId)

  const agent = getGlobalAgentRoster(input.workspaceId).find(candidate => candidate.id === input.externalAgentId)
  if (!agent) throw new Error('External agent is not currently discoverable')

  const role = input.role?.trim() || 'member'
  if (role.length > 80) throw new Error('Binding role is too long')
  const proxyName = ensureRoutingProxy(db, agent, input.workspaceId)

  db.prepare(`
    INSERT INTO project_external_agent_bindings (
      project_id, workspace_id, platoon_id, external_agent_id, agent_name, role,
      routing_agent_name, definition_path, capability_snapshot, bound_by, bound_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(project_id, platoon_id, external_agent_id) DO UPDATE SET
      agent_name = excluded.agent_name,
      role = excluded.role,
      routing_agent_name = excluded.routing_agent_name,
      definition_path = excluded.definition_path,
      capability_snapshot = excluded.capability_snapshot,
      bound_by = excluded.bound_by,
      updated_at = unixepoch()
  `).run(
    input.projectId,
    input.workspaceId,
    agent.platoonId,
    agent.id,
    agent.name,
    role,
    proxyName,
    agent.definitionPath,
    JSON.stringify(agent.capabilities.tags),
    input.actor || null,
  )

  const bindings = listExternalProjectBindings(input.projectId, input.workspaceId)
  const binding = bindings.find(candidate => candidate.externalAgentId === agent.id && candidate.platoonId === agent.platoonId)
  if (!binding) throw new Error('Failed to create external agent binding')
  return binding
}

export function unbindExternalAgentFromProject(input: {
  projectId: number
  workspaceId: number
  bindingId: number
}): boolean {
  const db = getDatabase()
  assertProject(db, input.projectId, input.workspaceId)
  const result = db.prepare(`
    DELETE FROM project_external_agent_bindings
    WHERE id = ? AND project_id = ? AND workspace_id = ?
  `).run(input.bindingId, input.projectId, input.workspaceId)
  return result.changes > 0
}
