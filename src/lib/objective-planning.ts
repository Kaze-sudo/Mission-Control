import { getDatabase, db_helpers } from './db'
import { inferMissionIntent } from './mission-intent'
import { routeTaskWithinProject } from './project-task-routing'
import { analyzeProjectForce } from './project-force-planning'
import { bindExternalAgentToProject } from './external-project-bindings'
import { getProjectCommand, updateProjectCommand } from './project-command'

export interface ObjectiveMissionInput {
  key?: string
  title: string
  description?: string
  dependsOn?: string[]
  priority?: 'low' | 'medium' | 'high' | 'urgent'
  requiredCapabilities?: string[]
  preferredCapabilities?: string[]
}

export interface ObjectiveMissionPlan {
  key: string
  title: string
  description: string
  dependsOnKeys: string[]
  priority: 'low' | 'medium' | 'high' | 'urgent'
  requiredCapabilities: string[]
  preferredCapabilities: string[]
  evidence: Array<{ capability: string; source: 'title' | 'description'; phrase: string }>
}

export interface ObjectivePlan {
  title: string
  description: string
  source: 'inferred' | 'manual'
  missions: ObjectiveMissionPlan[]
}
export interface CreatedObjectivePlan {
  objectiveId: number
  projectId: number
  workspaceId: number
  title: string
  description: string
  status: string
  missions: Array<ObjectiveMissionPlan & {
    taskId: number
    dependsOnTaskIds: number[]
    routing?: unknown
  }>
}

function unique(values: string[] | undefined): string[] {
  return [...new Set((values || []).map(value => value.trim().toLowerCase()).filter(Boolean))]
}

function cleanMissionText(value: string): string {
  return value
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/^\s*(?:then|next|finally)\s*[:,;-]?\s*/i, '')
    .trim()
}

function splitObjectiveText(title: string, description: string): string[] {
  const source = description.trim() || title.trim()
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length > 1) return lines

  const sentences = source
    .split(/(?<=[.!?;])\s+/)
    .map(item => item.trim())
    .filter(Boolean)
  return sentences.length > 1 ? sentences : [source]
}

function hasSequentialCue(value: string): boolean {
  return /^\s*(?:then|next|finally|after\b|once\b)/i.test(value)
}
function manualMissionPlan(mission: ObjectiveMissionInput, index: number): ObjectiveMissionPlan {
  const title = cleanMissionText(mission.title)
  const inferred = inferMissionIntent(title, mission.description || '')
  const explicitRequired = mission.requiredCapabilities !== undefined
  const explicitPreferred = mission.preferredCapabilities !== undefined
  return {
    key: mission.key?.trim() || `m${index + 1}`,
    title,
    description: mission.description?.trim() || '',
    dependsOnKeys: [...new Set(mission.dependsOn || [])],
    priority: mission.priority || 'medium',
    requiredCapabilities: explicitRequired
      ? unique(mission.requiredCapabilities)
      : inferred.requirements.requiredCapabilities,
    preferredCapabilities: explicitPreferred
      ? unique(mission.preferredCapabilities)
      : inferred.requirements.preferredCapabilities || [],
    evidence: inferred.evidence,
  }
}

export function decomposeObjective(input: {
  title: string
  description?: string
  missions?: ObjectiveMissionInput[]
}): ObjectivePlan {
  const title = input.title.trim()
  const description = input.description?.trim() || ''
  if (!title) throw new Error('Objective title is required')

  if (input.missions?.length) {
    const missions = input.missions.map(manualMissionPlan)
    const keys = new Set(missions.map(mission => mission.key))
    if (keys.size !== missions.length) throw new Error('Objective mission keys must be unique')
    for (const mission of missions) {
      for (const dependency of mission.dependsOnKeys) {
        if (!keys.has(dependency)) throw new Error(`Unknown mission dependency: ${dependency}`)
        if (dependency === mission.key) throw new Error(`Mission ${mission.key} cannot depend on itself`)
      }
    }
    return { title, description, source: 'manual', missions }
  }

  const parts = splitObjectiveText(title, description)
  const missions = parts.map((raw, index) => {
    const missionTitle = cleanMissionText(raw).replace(/[.;]+$/, '').trim()
    const intent = inferMissionIntent(missionTitle)
    return {
      key: `m${index + 1}`,
      title: missionTitle || title,
      description: '',
      dependsOnKeys: index > 0 && hasSequentialCue(raw) ? [`m${index}`] : [],
      priority: 'medium' as const,
      requiredCapabilities: intent.requirements.requiredCapabilities,
      preferredCapabilities: intent.requirements.preferredCapabilities || [],
      evidence: intent.evidence,
    }
  })

  return { title, description, source: 'inferred', missions }
}

function assertProject(projectId: number, workspaceId: number): void {
  const db = getDatabase()
  const row = db.prepare(
    'SELECT id FROM projects WHERE id = ? AND workspace_id = ?',
  ).get(projectId, workspaceId)
  if (!row) throw new Error('Project not found')
}

function missionMetadata(
  objectiveId: number,
  objectiveTitle: string,
  mission: ObjectiveMissionPlan,
  dependencyTaskIds: number[],
) {
  return {
    agentos_auto_route: true,
    agentos: {
      autoRoute: true,
      objectiveId,
      objectiveTitle,
      objectiveMission: true,
      missionKey: mission.key,
      dependsOnMissionKeys: mission.dependsOnKeys,
      dependsOnTaskIds: dependencyTaskIds,
      executionState: dependencyTaskIds.length > 0 ? 'blocked' : 'ready',
      requiredCapabilities: mission.requiredCapabilities,
      preferredCapabilities: mission.preferredCapabilities,
    },
  }
}

export function createObjectivePlan(input: {
  projectId: number
  workspaceId: number
  title: string
  description?: string
  actor?: string | null
  missions?: ObjectiveMissionInput[]
}): CreatedObjectivePlan {
  assertProject(input.projectId, input.workspaceId)
  const plan = decomposeObjective(input)
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const actor = input.actor || 'agentos'

  const created = db.transaction(() => {
    const objectiveResult = db.prepare(`
      INSERT INTO agentos_objectives (
        project_id, workspace_id, title, description, status, plan_json,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'planned', '{}', ?, ?, ?)
    `).run(
      input.projectId, input.workspaceId, plan.title, plan.description,
      actor, now, now,
    )
    const objectiveId = Number(objectiveResult.lastInsertRowid)
    const taskIds = new Map<string, number>()
    const rows: Array<ObjectiveMissionPlan & { taskId: number; dependsOnTaskIds: number[] }> = []

    for (const mission of plan.missions) {
      db.prepare(`
        UPDATE projects SET ticket_counter = ticket_counter + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ?
      `).run(now, input.projectId, input.workspaceId)
      const ticket = db.prepare(
        'SELECT ticket_counter FROM projects WHERE id = ? AND workspace_id = ?',
      ).get(input.projectId, input.workspaceId) as { ticket_counter: number } | undefined
      if (!ticket?.ticket_counter) throw new Error('Failed to allocate project ticket number')

      const dependencyTaskIds = mission.dependsOnKeys
        .map(key => taskIds.get(key))
        .filter((value): value is number => typeof value === 'number')
      if (dependencyTaskIds.length !== mission.dependsOnKeys.length) {
        throw new Error(`Mission dependencies must reference earlier missions: ${mission.key}`)
      }
      const metadata = missionMetadata(objectiveId, plan.title, mission, dependencyTaskIds)
      const status = dependencyTaskIds.length > 0 ? 'backlog' : 'inbox'
      const result = db.prepare(`
        INSERT INTO tasks (
          title, description, status, priority, project_id, project_ticket_no,
          assigned_to, created_by, created_at, updated_at, tags, metadata, workspace_id
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        mission.title,
        mission.description || plan.description,
        status,
        mission.priority,
        input.projectId,
        ticket.ticket_counter,
        actor,
        now,
        now,
        JSON.stringify(['agentos-objective']),
        JSON.stringify(metadata),
        input.workspaceId,
      )
      const taskId = Number(result.lastInsertRowid)
      taskIds.set(mission.key, taskId)
      rows.push({ ...mission, taskId, dependsOnTaskIds: dependencyTaskIds })
      db_helpers.logActivity(
        'agentos_objective_mission_created', 'task', taskId, actor,
        `Created objective mission: ${mission.title}`,
        { objective_id: objectiveId, mission_key: mission.key, depends_on_task_ids: dependencyTaskIds },
        input.workspaceId,
      )
    }

    const storedPlan = {
      ...plan,
      missions: rows.map(row => ({
        ...row,
        taskId: row.taskId,
        dependsOnTaskIds: row.dependsOnTaskIds,
      })),
    }
    db.prepare(
      'UPDATE agentos_objectives SET plan_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    ).run(JSON.stringify(storedPlan), now, objectiveId, input.workspaceId)
    db_helpers.logActivity(
      'agentos_objective_planned', 'project', input.projectId, actor,
      `AgentOS planned objective: ${plan.title}`,
      { objective_id: objectiveId, mission_count: rows.length },
      input.workspaceId,
    )
    return { objectiveId, rows }
  })()

  const missions = created.rows.map(row => {
    if (row.dependsOnTaskIds.length > 0) return row
    try {
      const routing = routeTaskWithinProject({
        taskId: row.taskId,
        workspaceId: input.workspaceId,
        actor,
      })
      return { ...row, routing }
    } catch {
      return row
    }
  })

  return {
    objectiveId: created.objectiveId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    title: plan.title,
    description: plan.description,
    status: 'planned',
    missions,
  }
}

interface ObjectiveTaskMetadata {
  agentos?: {
    objectiveId?: number
    objectiveMission?: boolean
    dependsOnTaskIds?: number[]
    executionState?: string
  }
}
function parseMetadata(raw: string | null): ObjectiveTaskMetadata {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value as ObjectiveTaskMetadata : {}
  } catch {
    return {}
  }
}

export function promoteReadyObjectiveMissions(): {
  promoted: number[]
  stillBlocked: number[]
} {
  const db = getDatabase()
  const candidates = db.prepare(`
    SELECT t.id, t.workspace_id, t.metadata
    FROM tasks t
    JOIN workspaces w ON w.id = t.workspace_id
    WHERE w.isolation = 'shared'
      AND t.status = 'backlog'
      AND t.assigned_to IS NULL
      AND t.metadata LIKE '%"objectiveMission":true%'
  `).all() as Array<{ id: number; workspace_id: number; metadata: string | null }>

  const promoted: number[] = []
  const stillBlocked: number[] = []
  const now = Math.floor(Date.now() / 1000)

  for (const task of candidates) {
    const metadata = parseMetadata(task.metadata)
    const agentos = metadata.agentos
    if (!agentos?.objectiveMission || agentos.executionState !== 'blocked') continue
    const dependencies = Array.isArray(agentos.dependsOnTaskIds)
      ? agentos.dependsOnTaskIds.filter(Number.isInteger)
      : []
    if (dependencies.length === 0) continue
    const placeholders = dependencies.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id, status FROM tasks WHERE workspace_id = ? AND id IN (${placeholders})`,
    ).all(task.workspace_id, ...dependencies) as Array<{ id: number; status: string }>
    const done = new Set(rows.filter(row => row.status === 'done').map(row => row.id))
    if (dependencies.some(id => !done.has(id))) {
      stillBlocked.push(task.id)
      continue
    }

    const nextMetadata = {
      ...metadata,
      agentos: {
        ...agentos,
        executionState: 'ready',
        dependenciesSatisfiedAt: now,
      },
    }
    db.prepare(
      "UPDATE tasks SET status = 'inbox', metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'backlog'",
    ).run(JSON.stringify(nextMetadata), now, task.id, task.workspace_id)

    try {
      routeTaskWithinProject({
        taskId: task.id,
        workspaceId: task.workspace_id,
        actor: 'agentos',
      })
    } catch {
      // Leave the mission ready/inbox if no route is currently available.
    }
    promoted.push(task.id)
  }

  return { promoted, stillBlocked }
}
export function listProjectObjectives(projectId: number, workspaceId: number) {
  assertProject(projectId, workspaceId)
  const db = getDatabase()
  return (db.prepare(`
    SELECT id, project_id, workspace_id, title, description, status,
           plan_json, created_by, created_at, updated_at
    FROM agentos_objectives
    WHERE project_id = ? AND workspace_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(projectId, workspaceId) as Array<Record<string, unknown>>).map(row => {
    let plan: unknown = {}
    try { plan = JSON.parse(String(row.plan_json || '{}')) } catch {}
    return { ...row, plan, plan_json: undefined }
  })
}
export function executeObjective(input: {
  objectiveId: number
  projectId: number
  workspaceId: number
  actor?: string | null
}) {
  assertProject(input.projectId, input.workspaceId)
  const db = getDatabase()
  const objective = db.prepare(`
    SELECT id, status, plan_json
    FROM agentos_objectives
    WHERE id = ? AND project_id = ? AND workspace_id = ?
  `).get(input.objectiveId, input.projectId, input.workspaceId) as
    | { id: number; status: string; plan_json: string }
    | undefined
  if (!objective) throw new Error('Objective not found')
  if (objective.status === 'cancelled') throw new Error('Cancelled objective cannot execute')
  if (objective.status === 'completed') {
    return {
      executed: false,
      reason: 'Objective is already completed',
      objectiveId: objective.id,
      added: [],
      routes: [],
    }
  }

  let plan: { missions?: Array<{ taskId?: number; dependsOnTaskIds?: number[] }> } = {}
  try { plan = JSON.parse(objective.plan_json || '{}') } catch {}

  const commandBefore = getProjectCommand(input.projectId, input.workspaceId)
  const allowed = new Set(commandBefore.policy.allowedPlatoons.map(value => value.toLowerCase()))
  const before = analyzeProjectForce(input.projectId, input.workspaceId)
  const added: Array<{ externalAgentId: string; agentName: string; platoonId: string }> = []
  const assemblyErrors: Array<{ externalAgentId: string; agentName: string; error: string }> = []

  for (const recommendation of before.recommendations) {
    if (allowed.size > 0 && !allowed.has(recommendation.platoonId.toLowerCase())) continue
    try {
      const binding = bindExternalAgentToProject({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        externalAgentId: recommendation.externalAgentId,
        role: recommendation.capabilities.join(', ') || 'objective-force',
        actor: input.actor || 'agentos',
      })
      added.push({
        externalAgentId: binding.externalAgentId,
        agentName: binding.agentName,
        platoonId: binding.platoonId,
      })
    } catch (error) {
      assemblyErrors.push({
        externalAgentId: recommendation.externalAgentId,
        agentName: recommendation.name,
        error: error instanceof Error ? error.message : 'Failed to bind recommended agent',
      })
    }
  }

  const force = analyzeProjectForce(input.projectId, input.workspaceId)
  const command = getProjectCommand(input.projectId, input.workspaceId)
  if (command.state === 'paused' || command.state === 'blocked') {
    return {
      executed: false,
      held: true,
      reason: `Project command state is ${command.state}; AgentOS will not override it`,
      objectiveId: objective.id,
      added,
      assemblyErrors,
      force,
      command,
      routes: [],
    }
  }
  if (force.readiness.status !== 'ready') {
    return {
      executed: false,
      held: true,
      reason: `Project force is not ready: ${force.readiness.status}`,
      objectiveId: objective.id,
      added,
      assemblyErrors,
      force,
      command,
      routes: [],
    }
  }

  const activeCommand = command.state === 'active'
    ? command
    : updateProjectCommand({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        state: 'active',
        actor: input.actor || 'agentos',
      })

  promoteReadyObjectiveMissions()
  const routes: Array<{ taskId: number; routed: boolean; reason?: string }> = []
  for (const mission of plan.missions || []) {
    if (!Number.isInteger(mission.taskId)) continue
    const taskId = Number(mission.taskId)
    const task = db.prepare(`
      SELECT id, status, assigned_to
      FROM tasks
      WHERE id = ? AND project_id = ? AND workspace_id = ?
    `).get(taskId, input.projectId, input.workspaceId) as
      | { id: number; status: string; assigned_to: string | null }
      | undefined
    if (!task) continue
    if (['done', 'failed', 'review', 'quality_review', 'in_progress'].includes(task.status)) continue
    if (task.status === 'backlog') continue
    try {
      const result = routeTaskWithinProject({
        taskId,
        workspaceId: input.workspaceId,
        actor: input.actor || 'agentos',
        allowReassign: activeCommand.policy.allowReroute,
      })
      routes.push({ taskId, routed: result.routed, ...(result.reason ? { reason: result.reason } : {}) })
    } catch (error) {
      routes.push({
        taskId,
        routed: false,
        reason: error instanceof Error ? error.message : 'Routing failed',
      })
    }
  }

  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    UPDATE agentos_objectives
    SET status = 'active', updated_at = ?
    WHERE id = ? AND project_id = ? AND workspace_id = ?
  `).run(now, objective.id, input.projectId, input.workspaceId)

  db_helpers.logActivity(
    'agentos_objective_activated',
    'project',
    input.projectId,
    input.actor || 'agentos',
    `AgentOS activated objective ${objective.id}`,
    {
      objective_id: objective.id,
      agents_added: added.length,
      routes,
      assembly_errors: assemblyErrors,
    },
    input.workspaceId,
  )

  return {
    executed: true,
    objectiveId: objective.id,
    added,
    assemblyErrors,
    force,
    command: activeCommand,
    routes,
  }
}
