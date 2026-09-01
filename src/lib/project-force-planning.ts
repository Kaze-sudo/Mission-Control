import { getDatabase } from './db'
import { listExternalProjectBindings } from './external-project-bindings'
import { getGlobalAgentRoster, type GlobalRosterAgent } from './global-agent-roster'
import { rankAgentsForMission } from './agent-selection'
import { inferMissionIntent } from './mission-intent'

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
  capabilities: string[]
  externalAgentId: string
  name: string
  platoonId: string
  score: number
  availability: string
  reasons: string[]
}

export interface ProjectTaskCapabilityDemand {
  tasksAnalyzed: number
  requiredCapabilities: string[]
  preferredCapabilities: string[]
  byCapability: Array<{
    capability: string
    requiredTaskIds: number[]
    preferredTaskIds: number[]
  }>
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


interface ProjectTaskDemandRow {
  id: number
  title: string
  description: string | null
  metadata: string | null
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value as Record<string, unknown> : {}
  } catch { return {} }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? normalize(value.filter((item): item is string => typeof item === 'string'))
    : []
}

function taskCapabilityIntent(task: ProjectTaskDemandRow): { required: string[]; preferred: string[] } {
  const metadata = parseObject(task.metadata)
  const routing = metadata.agentos_routing && typeof metadata.agentos_routing === 'object'
    ? metadata.agentos_routing as Record<string, unknown>
    : {}
  const routedIntent = routing.intent && typeof routing.intent === 'object'
    ? routing.intent as Record<string, unknown>
    : {}
  const routedRequired = stringList(routedIntent.requiredCapabilities)
  const routedPreferred = stringList(routedIntent.preferredCapabilities)
  if (routedRequired.length > 0 || routedPreferred.length > 0) {
    return { required: routedRequired, preferred: routedPreferred }
  }

  const nested = metadata.agentos && typeof metadata.agentos === 'object'
    ? metadata.agentos as Record<string, unknown>
    : {}
  const explicitRequired = stringList(nested.requiredCapabilities ?? metadata.agentos_required_capabilities)
  const explicitPreferred = stringList(nested.preferredCapabilities ?? metadata.agentos_preferred_capabilities)
  if (explicitRequired.length > 0 || explicitPreferred.length > 0) {
    return { required: explicitRequired, preferred: explicitPreferred }
  }
  if (nested.disableInference === true || metadata.agentos_disable_inference === true) {
    return { required: [], preferred: [] }
  }

  const inferred = inferMissionIntent(task.title, task.description || '').requirements
  return {
    required: normalize(inferred.requiredCapabilities),
    preferred: normalize(inferred.preferredCapabilities || []),
  }
}

function deriveProjectTaskDemand(projectId: number, workspaceId: number): ProjectTaskCapabilityDemand {
  const db = getDatabase()
  const tasks = db.prepare(`
    SELECT id, title, description, metadata
    FROM tasks
    WHERE project_id = ? AND workspace_id = ?
      AND status NOT IN ('done', 'failed', 'cancelled')
    ORDER BY id
  `).all(projectId, workspaceId) as ProjectTaskDemandRow[]
  const required = new Set<string>()
  const preferred = new Set<string>()
  const byCapability = new Map<string, { requiredTaskIds: number[]; preferredTaskIds: number[] }>()

  for (const task of tasks) {
    const intent = taskCapabilityIntent(task)
    for (const capability of intent.required) {
      required.add(capability)
      preferred.delete(capability)
      const entry = byCapability.get(capability) || { requiredTaskIds: [], preferredTaskIds: [] }
      entry.requiredTaskIds.push(task.id)
      byCapability.set(capability, entry)
    }
    for (const capability of intent.preferred) {
      if (!required.has(capability)) preferred.add(capability)
      const entry = byCapability.get(capability) || { requiredTaskIds: [], preferredTaskIds: [] }
      entry.preferredTaskIds.push(task.id)
      byCapability.set(capability, entry)
    }
  }

  return {
    tasksAnalyzed: tasks.length,
    requiredCapabilities: [...required].sort(),
    preferredCapabilities: [...preferred].sort(),
    byCapability: [...byCapability.entries()]
      .map(([capability, refs]) => ({ capability, ...refs }))
      .sort((a, b) => a.capability.localeCompare(b.capability)),
  }
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
  const taskDemand = deriveProjectTaskDemand(projectId, workspaceId)
  const effectiveRequired = normalize([
    ...profile.requiredCapabilities,
    ...taskDemand.requiredCapabilities,
  ])
  const effectivePreferred = normalize([
    ...profile.preferredCapabilities,
    ...taskDemand.preferredCapabilities,
  ]).filter(capability => !effectiveRequired.includes(capability))

  const roster = getGlobalAgentRoster(workspaceId)
  const bindings = listExternalProjectBindings(projectId, workspaceId)
  const boundIds = new Set(bindings.map(binding => binding.externalAgentId))
  const boundAgents = roster.filter(agent => boundIds.has(agent.id))
  const coverage = effectiveRequired.map(capability => capabilityCoverage(capability, boundAgents))
  const missing = coverage.filter(item => !item.covered).map(item => item.capability)
  const blocked = coverage.filter(item => item.covered && !item.ready).map(item => item.capability)
  const outstanding = [...new Set([...missing, ...blocked])]
  const rawRecommendations: ForceRecommendation[] = []
  const unbound = roster.filter(agent => !boundIds.has(agent.id))

  for (const capability of outstanding) {
    const ranked = rankAgentsForMission(unbound, {
      requiredCapabilities: [capability],
      preferredCapabilities: effectivePreferred,
      preferredPlatoons: profile.preferredPlatoons,
    })
    const best = ranked.find(candidate => candidate.eligible)
    if (!best) continue
    rawRecommendations.push({
      capability,
      capabilities: [capability],
      externalAgentId: best.agent.id,
      name: best.agent.name,
      platoonId: best.agent.platoonId,
      score: best.score,
      availability: best.agent.availability,
      reasons: best.reasons,
    })
  }

  const grouped = new Map<string, ForceRecommendation>()
  for (const recommendation of rawRecommendations) {
    const existing = grouped.get(recommendation.externalAgentId)
    if (!existing) {
      grouped.set(recommendation.externalAgentId, { ...recommendation })
      continue
    }
    existing.capabilities = [...new Set([...existing.capabilities, ...recommendation.capabilities])].sort()
    existing.capability = existing.capabilities[0] || recommendation.capability
    existing.score = Math.max(existing.score, recommendation.score)
    existing.reasons = [...new Set([...existing.reasons, ...recommendation.reasons])]
  }

  const groupedRecommendations = [...grouped.values()].sort((a, b) =>
    b.capabilities.length - a.capabilities.length
    || b.score - a.score
    || a.name.localeCompare(b.name)
  )
  const slots = profile.maxTeamSize == null
    ? groupedRecommendations.length
    : Math.max(0, profile.maxTeamSize - boundAgents.length)
  const recommendations = groupedRecommendations.slice(0, slots)
  const recommendedCoverage = new Set(recommendations.flatMap(item => item.capabilities))
  const unfilledCapabilities = outstanding.filter(capability => !recommendedCoverage.has(capability))

  const readyCoverage = coverage.filter(item => item.ready).length
  return {
    profile,
    taskDemand,
    effectiveRequirements: {
      requiredCapabilities: effectiveRequired,
      preferredCapabilities: effectivePreferred,
    },
    team: boundAgents,
    bindings,
    coverage,
    missingCapabilities: missing,
    blockedCapabilities: blocked,
    recommendations,
    unfilledCapabilities,
    readiness: {
      required: effectiveRequired.length,
      ready: readyCoverage,
      percent: effectiveRequired.length
        ? Math.round((readyCoverage / effectiveRequired.length) * 100)
        : 100,
      status: missing.length ? 'gaps' : blocked.length ? 'blocked' : 'ready',
    },
  }
}
