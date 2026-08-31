import { getDatabase, db_helpers } from './db'
import { listExternalProjectBindings } from './external-project-bindings'
import { getGlobalAgentRoster } from './global-agent-roster'
import { rankAgentsForMission, type MissionRequirements } from './agent-selection'

interface TaskRouteRow {
  id: number
  title: string
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

export function routeTaskWithinProject(input: {
  taskId: number
  workspaceId: number
  actor?: string | null
  requirements?: Partial<MissionRequirements>
  allowReassign?: boolean
}): ProjectTaskRouteResult {
  const db = getDatabase()
  const task = db.prepare('SELECT id, title, status, assigned_to, project_id, metadata FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(input.taskId, input.workspaceId) as TaskRouteRow | undefined
  if (!task) return { routed: false, reason: 'Task not found', taskId: input.taskId, projectId: null }
  if (!task.project_id) return { routed: false, reason: 'Task has no project', taskId: task.id, projectId: null }
  if (['done', 'failed', 'quality_review', 'review'].includes(task.status)) {
    return { routed: false, reason: `Task status ${task.status} is not routable`, taskId: task.id, projectId: task.project_id }
  }
  if (task.assigned_to && !input.allowReassign) {
    return { routed: false, reason: 'Task is already assigned', taskId: task.id, projectId: task.project_id }
  }
  const metadata = parseMetadata(task.metadata)
  const fromMetadata = requirementsFromMetadata(metadata)
  const requirements: MissionRequirements = {
    requiredCapabilities: input.requirements?.requiredCapabilities ?? fromMetadata.requiredCapabilities,
    preferredCapabilities: input.requirements?.preferredCapabilities ?? fromMetadata.preferredCapabilities,
    preferredPlatoons: input.requirements?.preferredPlatoons ?? fromMetadata.preferredPlatoons,
  }

  const bindings = listExternalProjectBindings(task.project_id, input.workspaceId)
  if (bindings.length === 0) {
    return { routed: false, reason: 'Project has no external agent bindings', taskId: task.id, projectId: task.project_id }
  }

  const roster = getGlobalAgentRoster(input.workspaceId)
  const boundIds = new Set(bindings.map(binding => binding.externalAgentId))
  const candidates = rankAgentsForMission(
    roster.filter(agent => boundIds.has(agent.id)),
    requirements,
  )
  const winner = candidates.find(candidate => candidate.eligible)
  if (!winner) {
    return { routed: false, reason: 'No bound agent satisfies the mission requirements and availability gates', taskId: task.id, projectId: task.project_id }
  }

  const binding = bindings.find(item => item.externalAgentId === winner.agent.id)
  if (!binding?.routingAgentName) {
    return { routed: false, reason: 'Selected agent binding has no routing proxy', taskId: task.id, projectId: task.project_id }
  }
  const now = Math.floor(Date.now() / 1000)
  const nextMetadata = {
    ...metadata,
    agentos_routing: {
      externalAgentId: winner.agent.id,
      agentName: winner.agent.name,
      platoonId: winner.agent.platoonId,
      routingAgentName: binding.routingAgentName,
      score: winner.score,
      reasons: winner.reasons,
      routedAt: now,
    },
  }

  db.prepare("UPDATE tasks SET assigned_to = ?, status = CASE WHEN status IN ('backlog', 'inbox') THEN 'assigned' ELSE status END, metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
    .run(binding.routingAgentName, JSON.stringify(nextMetadata), now, task.id, input.workspaceId)

  db_helpers.logActivity(
    'agentos_task_routed', 'task', task.id, input.actor || 'agentos',
    `AgentOS routed task to ${winner.agent.platoonId}/${winner.agent.name}`,
    { external_agent_id: winner.agent.id, routing_agent_name: binding.routingAgentName, score: winner.score },
    input.workspaceId,
  )

  return {
    routed: true, taskId: task.id, projectId: task.project_id,
    selected: {
      externalAgentId: winner.agent.id, agentName: winner.agent.name,
      platoonId: winner.agent.platoonId, routingAgentName: binding.routingAgentName,
      score: winner.score, reasons: winner.reasons,
    },
  }
}