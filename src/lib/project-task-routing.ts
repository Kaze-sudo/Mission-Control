import { getDatabase, db_helpers } from './db'
import { listExternalProjectBindings } from './external-project-bindings'
import { getGlobalAgentRoster } from './global-agent-roster'
import { rankAgentsForMission, type MissionRequirements } from './agent-selection'
import { getProjectCommand } from './project-command'
import { inferMissionIntent } from './mission-intent'
import { recommendAiResources, toTaskResourceAttachment } from './ai-resource-registry'

interface TaskRouteRow {
  id: number
  title: string
  description: string | null
  status: string
  assigned_to: string | null
  project_id: number | null
  metadata: string | null
}

export interface ProjectTaskRouteResult {
  routed: boolean
  reason?: string
  taskId: number
  projectId: number | null
  selected?: {
    externalAgentId: string
    agentName: string
    platoonId: string
    routingAgentName: string
    score: number
    reasons: string[]
  }
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}
function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function requirementsFromMetadata(metadata: Record<string, unknown>): MissionRequirements {
  const nested = metadata.agentos && typeof metadata.agentos === 'object'
    ? metadata.agentos as Record<string, unknown>
    : {}
  return {
    requiredCapabilities: arrayValue(nested.requiredCapabilities ?? metadata.agentos_required_capabilities),
    preferredCapabilities: arrayValue(nested.preferredCapabilities ?? metadata.agentos_preferred_capabilities),
    preferredPlatoons: arrayValue(nested.preferredPlatoons ?? metadata.agentos_preferred_platoons),
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function inputDefinesCapabilities(requirements: Partial<MissionRequirements> | undefined): boolean {
  return !!requirements && (hasOwn(requirements, 'requiredCapabilities') || hasOwn(requirements, 'preferredCapabilities'))
}

function metadataDisablesInference(metadata: Record<string, unknown>): boolean {
  const nested = metadata.agentos && typeof metadata.agentos === 'object'
    ? metadata.agentos as Record<string, unknown>
    : {}
  return nested.disableInference === true || metadata.agentos_disable_inference === true
}

function recordRoutingDecision(input: {
  db: ReturnType<typeof getDatabase>
  taskId: number
  projectId: number
  workspaceId: number
  status: 'selected' | 'no_candidate' | 'blocked'
  requirements: MissionRequirements
  candidates: ReturnType<typeof rankAgentsForMission>
  selectedExternalAgentId?: string | null
  selectedPlatoonId?: string | null
  selectedRoutingAgentName?: string | null
  reason?: string | null
  actor?: string | null
}) {
  const candidateSnapshot = input.candidates.map(candidate => ({
    externalAgentId: candidate.agent.id,
    name: candidate.agent.name,
    platoonId: candidate.agent.platoonId,
    eligible: candidate.eligible,
    score: candidate.score,
    matchedRequired: candidate.matchedRequired,
    missingRequired: candidate.missingRequired,
    matchedPreferred: candidate.matchedPreferred,
    reasons: candidate.reasons,
  }))
  input.db.prepare(`
    INSERT INTO agentos_routing_decisions (
      task_id, project_id, workspace_id, status, requirements_json, candidates_json,
      selected_external_agent_id, selected_platoon_id, selected_routing_agent_name, reason, actor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.taskId, input.projectId, input.workspaceId, input.status,
    JSON.stringify(input.requirements), JSON.stringify(candidateSnapshot),
    input.selectedExternalAgentId || null, input.selectedPlatoonId || null,
    input.selectedRoutingAgentName || null, input.reason || null, input.actor || null,
  )
}

export function routeTaskWithinProject(input: {
  taskId: number
  workspaceId: number
  actor?: string | null
  requirements?: Partial<MissionRequirements>
  allowReassign?: boolean
}): ProjectTaskRouteResult {
  const db = getDatabase()
  const task = db.prepare('SELECT id, title, description, status, assigned_to, project_id, metadata FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(input.taskId, input.workspaceId) as TaskRouteRow | undefined
  if (!task) return { routed: false, reason: 'Task not found', taskId: input.taskId, projectId: null }
  if (!task.project_id) return { routed: false, reason: 'Task has no project', taskId: task.id, projectId: null }
  if (['done', 'failed', 'quality_review', 'review'].includes(task.status)) {
    return { routed: false, reason: `Task status ${task.status} is not routable`, taskId: task.id, projectId: task.project_id }
  }
  const command = getProjectCommand(task.project_id, input.workspaceId)
  const canReassign = input.allowReassign ?? command.policy.allowReroute
  if (task.assigned_to && !canReassign) {
    return { routed: false, reason: 'Task is already assigned and project policy does not allow rerouting', taskId: task.id, projectId: task.project_id }
  }
  const metadata = parseMetadata(task.metadata)
  const fromMetadata = requirementsFromMetadata(metadata)
  const metadataDefinesCapabilities = fromMetadata.requiredCapabilities.length > 0
    || (fromMetadata.preferredCapabilities?.length || 0) > 0
  const shouldInferIntent = !inputDefinesCapabilities(input.requirements)
    && !metadataDefinesCapabilities
    && !metadataDisablesInference(metadata)
  const inferredIntent = shouldInferIntent
    ? inferMissionIntent(task.title, task.description || '')
    : null
  const requirements: MissionRequirements = {
    requiredCapabilities: input.requirements?.requiredCapabilities
      ?? (metadataDefinesCapabilities ? fromMetadata.requiredCapabilities : inferredIntent?.requirements.requiredCapabilities || []),
    preferredCapabilities: input.requirements?.preferredCapabilities
      ?? (metadataDefinesCapabilities ? fromMetadata.preferredCapabilities : inferredIntent?.requirements.preferredCapabilities || []),
    preferredPlatoons: input.requirements?.preferredPlatoons ?? fromMetadata.preferredPlatoons,
  }

  const bindings = listExternalProjectBindings(task.project_id, input.workspaceId)
  if (bindings.length === 0) {
    recordRoutingDecision({
      db, taskId: task.id, projectId: task.project_id, workspaceId: input.workspaceId,
      status: 'no_candidate', requirements, candidates: [],
      reason: 'Project has no external agent bindings', actor: input.actor,
    })
    return { routed: false, reason: 'Project has no external agent bindings', taskId: task.id, projectId: task.project_id }
  }

  const roster = getGlobalAgentRoster(input.workspaceId)
  const boundIds = new Set(bindings.map(binding => binding.externalAgentId))
  const allowed = new Set(command.policy.allowedPlatoons)
  const allowedRoster = roster.filter(agent => boundIds.has(agent.id) && (allowed.size === 0 || allowed.has(agent.platoonId.toLowerCase())))
  let candidates = rankAgentsForMission(allowedRoster, requirements)
  let winner = candidates.find(candidate => candidate.eligible)
  let fallbackUsed = false
  if (!winner && command.policy.fallbackBehavior === 'best_available') {
    candidates = rankAgentsForMission(allowedRoster, {
      requiredCapabilities: [],
      preferredCapabilities: [...requirements.requiredCapabilities, ...(requirements.preferredCapabilities || [])],
      preferredPlatoons: requirements.preferredPlatoons,
    })
    winner = candidates.find(candidate => candidate.eligible)
    fallbackUsed = !!winner
  }
  if (!winner) {
    const reason = command.policy.fallbackBehavior === 'manual'
      ? 'No eligible candidate; project fallback policy requires manual assignment'
      : 'No bound agent satisfies the mission requirements and availability gates'
    recordRoutingDecision({
      db, taskId: task.id, projectId: task.project_id, workspaceId: input.workspaceId,
      status: 'no_candidate', requirements, candidates, reason, actor: input.actor,
    })
    return { routed: false, reason, taskId: task.id, projectId: task.project_id }
  }

  const binding = bindings.find(item => item.externalAgentId === winner.agent.id)
  if (!binding?.routingAgentName) {
    const reason = 'Selected agent binding has no routing proxy'
    recordRoutingDecision({
      db, taskId: task.id, projectId: task.project_id, workspaceId: input.workspaceId,
      status: 'blocked', requirements, candidates,
      selectedExternalAgentId: winner.agent.id, selectedPlatoonId: winner.agent.platoonId,
      reason, actor: input.actor,
    })
    return { routed: false, reason, taskId: task.id, projectId: task.project_id }
  }
  const now = Math.floor(Date.now() / 1000)
  const resourceRecommendations = recommendAiResources([
    ...requirements.requiredCapabilities,
    ...(requirements.preferredCapabilities || []),
  ], 6)
  const nextMetadata = {
    ...metadata,
    agentos_routing: {
      externalAgentId: winner.agent.id,
      agentName: winner.agent.name,
      platoonId: winner.agent.platoonId,
      routingAgentName: binding.routingAgentName,
      score: winner.score,
      reasons: winner.reasons,
      fallbackUsed,
      intent: {
        source: inferredIntent ? 'inferred' : 'explicit',
        requiredCapabilities: requirements.requiredCapabilities,
        preferredCapabilities: requirements.preferredCapabilities || [],
        evidence: inferredIntent?.evidence || [],
      },
      routedAt: now,
    },
    agentos_resources: resourceRecommendations.map(resource => toTaskResourceAttachment(resource)),
  }

  db.prepare("UPDATE tasks SET assigned_to = ?, status = CASE WHEN status IN ('backlog', 'inbox') THEN 'assigned' ELSE status END, metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
    .run(binding.routingAgentName, JSON.stringify(nextMetadata), now, task.id, input.workspaceId)

  db_helpers.logActivity(
    'agentos_task_routed', 'task', task.id, input.actor || 'agentos',
    `AgentOS routed task to ${winner.agent.platoonId}/${winner.agent.name}`,
    { external_agent_id: winner.agent.id, routing_agent_name: binding.routingAgentName, score: winner.score },
    input.workspaceId,
  )

  recordRoutingDecision({
    db, taskId: task.id, projectId: task.project_id, workspaceId: input.workspaceId,
    status: 'selected', requirements, candidates,
    selectedExternalAgentId: winner.agent.id,
    selectedPlatoonId: winner.agent.platoonId,
    selectedRoutingAgentName: binding.routingAgentName,
    reason: `${fallbackUsed ? 'Best-available fallback used; ' : ''}${winner.reasons.join('; ')}`, actor: input.actor,
  })

  return {
    routed: true, taskId: task.id, projectId: task.project_id,
    selected: {
      externalAgentId: winner.agent.id, agentName: winner.agent.name,
      platoonId: winner.agent.platoonId, routingAgentName: binding.routingAgentName,
      score: winner.score, reasons: winner.reasons,
    },
  }
}