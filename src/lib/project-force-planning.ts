import { getDatabase } from './db'
import { listExternalProjectBindings } from './external-project-bindings'
import { getGlobalAgentRoster, type GlobalRosterAgent } from './global-agent-roster'
import { rankAgentsForMission } from './agent-selection'

export interface ProjectForceProfile {
  projectId: number
  workspaceId: number
  requiredCapabilities: string[]
  preferredCapabilities: string[]
  preferredPlatoons: string[]
  maxTeamSize: number | null
  updatedBy: string | null
  updatedAt: number | null
}

export interface ForceCoverageItem {
  capability: string
  covered: boolean
  ready: boolean
  agents: Array<{ id: string; name: string; platoonId: string; availability: string }>
}

export interface ForceRecommendation {
  capability: string
  externalAgentId: string
  name: string
  platoonId: string
  score: number
  availability: string
  reasons: string[]
}
function normalize(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))]
}

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? normalize(value.filter((item): item is string => typeof item === 'string')) : []
  } catch { return [] }
}

function assertProject(projectId: number, workspaceId: number): void {
  const db = getDatabase()
  const row = db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?').get(projectId, workspaceId)
  if (!row) throw new Error('Project not found')
}

export function getProjectForceProfile(projectId: number, workspaceId: number): ProjectForceProfile {
  assertProject(projectId, workspaceId)
  const db = getDatabase()
  const row = db.prepare(`
    SELECT required_capabilities_json, preferred_capabilities_json, preferred_platoons_json,
           max_team_size, updated_by, updated_at
    FROM agentos_project_force_profiles WHERE project_id = ? AND workspace_id = ?
  `).get(projectId, workspaceId) as any
  return {
    projectId, workspaceId,
    requiredCapabilities: parseList(row?.required_capabilities_json),
    preferredCapabilities: parseList(row?.preferred_capabilities_json),
    preferredPlatoons: parseList(row?.preferred_platoons_json),
    maxTeamSize: typeof row?.max_team_size === 'number' ? row.max_team_size : null,
    updatedBy: row?.updated_by || null, updatedAt: row?.updated_at || null,
  }
}
export function updateProjectForceProfile(input: {
  projectId: number
  workspaceId: number
  requiredCapabilities: string[]
  preferredCapabilities: string[]
  preferredPlatoons: string[]
  maxTeamSize?: number | null
  actor?: string | null
}): ProjectForceProfile {
  assertProject(input.projectId, input.workspaceId)
  const required = normalize(input.requiredCapabilities)
  const preferred = normalize(input.preferredCapabilities)
  const platoons = normalize(input.preferredPlatoons)
  const maxTeamSize = input.maxTeamSize == null ? null : Math.max(1, Math.min(50, Math.trunc(input.maxTeamSize)))
  const db = getDatabase()
  db.prepare(`
    INSERT INTO agentos_project_force_profiles (
      project_id, workspace_id, required_capabilities_json, preferred_capabilities_json,
      preferred_platoons_json, max_team_size, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(project_id) DO UPDATE SET
      workspace_id = excluded.workspace_id, required_capabilities_json = excluded.required_capabilities_json,
      preferred_capabilities_json = excluded.preferred_capabilities_json,
      preferred_platoons_json = excluded.preferred_platoons_json, max_team_size = excluded.max_team_size,
      updated_by = excluded.updated_by, updated_at = unixepoch()
  `).run(input.projectId, input.workspaceId, JSON.stringify(required), JSON.stringify(preferred),
    JSON.stringify(platoons), maxTeamSize, input.actor || null)
  return getProjectForceProfile(input.projectId, input.workspaceId)
}
function capabilityCoverage(capability: string, agents: GlobalRosterAgent[]): ForceCoverageItem {
  const matching = agents.filter(agent => agent.capabilities.tags.includes(capability))
  return {
    capability,
    covered: matching.length > 0,
    ready: matching.some(agent => agent.availability === 'available' || agent.availability === 'busy'),
    agents: matching.map(agent => ({
      id: agent.id, name: agent.name, platoonId: agent.platoonId, availability: agent.availability,
    })),
  }
}

export function analyzeProjectForce(projectId: number, workspaceId: number) {
  const profile = getProjectForceProfile(projectId, workspaceId)
  const roster = getGlobalAgentRoster(workspaceId)
  const bindings = listExternalProjectBindings(projectId, workspaceId)
  const boundIds = new Set(bindings.map(binding => binding.externalAgentId))
  const boundAgents = roster.filter(agent => boundIds.has(agent.id))
  const coverage = profile.requiredCapabilities.map(capability => capabilityCoverage(capability, boundAgents))
  const missing = coverage.filter(item => !item.covered).map(item => item.capability)
  const blocked = coverage.filter(item => item.covered && !item.ready).map(item => item.capability)
  const recommendations: ForceRecommendation[] = []
  const unbound = roster.filter(agent => !boundIds.has(agent.id))

  for (const capability of [...missing, ...blocked]) {
    const ranked = rankAgentsForMission(unbound, {
      requiredCapabilities: [capability],
      preferredCapabilities: profile.preferredCapabilities,
      preferredPlatoons: profile.preferredPlatoons,
    })
    const best = ranked.find(candidate => candidate.eligible)
    if (!best) continue
    recommendations.push({
      capability, externalAgentId: best.agent.id, name: best.agent.name,
      platoonId: best.agent.platoonId, score: best.score, availability: best.agent.availability,
      reasons: best.reasons,
    })
  }
  const uniqueRecommendations = [...new Map(
    recommendations.map(item => [`${item.capability}:${item.externalAgentId}`, item])
  ).values()]
  const readyCoverage = coverage.filter(item => item.ready).length
  return {
    profile,
    team: boundAgents,
    bindings,
    coverage,
    missingCapabilities: missing,
    blockedCapabilities: blocked,
    recommendations: uniqueRecommendations,
    readiness: {
      required: profile.requiredCapabilities.length,
      ready: readyCoverage,
      percent: profile.requiredCapabilities.length
        ? Math.round((readyCoverage / profile.requiredCapabilities.length) * 100)
        : 100,
      status: missing.length ? 'gaps' : blocked.length ? 'blocked' : 'ready',
    },
  }
}
