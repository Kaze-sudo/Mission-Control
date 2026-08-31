import { getDatabase } from './db'
import { analyzeProjectForce } from './project-force-planning'

export type ProjectCommandState = 'draft' | 'ready' | 'active' | 'paused' | 'blocked'
export type FallbackBehavior = 'hold' | 'manual' | 'best_available'

export interface ProjectRoutingPolicy {
  autoRoute: boolean
  allowReroute: boolean
  fallbackBehavior: FallbackBehavior
  allowedPlatoons: string[]
  maxProjectConcurrent: number
  maxPlatoonConcurrent: number
  maxAgentConcurrent: number
}

export interface ProjectCommandRecord {
  projectId: number
  workspaceId: number
  state: ProjectCommandState
  policy: ProjectRoutingPolicy
  activatedAt: number | null
  updatedBy: string | null
  updatedAt: number | null
  readiness: { required: number; ready: number; percent: number; status: string }
  activationBlockers: string[]
}

const DEFAULT_POLICY: ProjectRoutingPolicy = {
  autoRoute: false,
  allowReroute: false,
  fallbackBehavior: 'hold',
  allowedPlatoons: [],
  maxProjectConcurrent: 3,
  maxPlatoonConcurrent: 2,
  maxAgentConcurrent: 1,
}

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value)
      ? [...new Set(value.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(Boolean))]
      : []
  } catch { return [] }
}

function clamp(value: number | null | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(value as number)))
}

function ensureProject(projectId: number, workspaceId: number): void {
  const db = getDatabase()
  const row = db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?').get(projectId, workspaceId)
  if (!row) throw new Error('Project not found')
}

function computeBlockers(force: ReturnType<typeof analyzeProjectForce>): string[] {
  const blockers: string[] = []
  if (force.bindings.length === 0) blockers.push('No agents are bound to the project')
  if (force.missingCapabilities.length > 0) blockers.push(`Missing capabilities: ${force.missingCapabilities.join(', ')}`)
  if (force.blockedCapabilities.length > 0) blockers.push(`Capabilities blocked by unavailable agents/platoons: ${force.blockedCapabilities.join(', ')}`)
  return blockers
}

export function getProjectCommand(projectId: number, workspaceId: number): ProjectCommandRecord {
  ensureProject(projectId, workspaceId)
  const db = getDatabase()
  const row = db.prepare(`
    SELECT state, auto_route, allow_reroute, fallback_behavior, allowed_platoons_json,
           max_project_concurrent, max_platoon_concurrent, max_agent_concurrent,
           activated_at, updated_by, updated_at
    FROM agentos_project_command WHERE project_id = ? AND workspace_id = ?
  `).get(projectId, workspaceId) as any
  const force = analyzeProjectForce(projectId, workspaceId)
  return {
    projectId,
    workspaceId,
    state: (row?.state || 'draft') as ProjectCommandState,
    policy: {
      autoRoute: row ? !!row.auto_route : DEFAULT_POLICY.autoRoute,
      allowReroute: row ? !!row.allow_reroute : DEFAULT_POLICY.allowReroute,
      fallbackBehavior: (row?.fallback_behavior || DEFAULT_POLICY.fallbackBehavior) as FallbackBehavior,
      allowedPlatoons: row ? parseList(row.allowed_platoons_json) : [],
      maxProjectConcurrent: clamp(row?.max_project_concurrent, DEFAULT_POLICY.maxProjectConcurrent, 50),
      maxPlatoonConcurrent: clamp(row?.max_platoon_concurrent, DEFAULT_POLICY.maxPlatoonConcurrent, 20),
      maxAgentConcurrent: clamp(row?.max_agent_concurrent, DEFAULT_POLICY.maxAgentConcurrent, 10),
    },
    activatedAt: row?.activated_at ?? null,
    updatedBy: row?.updated_by || null,
    updatedAt: row?.updated_at ?? null,
    readiness: force.readiness,
    activationBlockers: computeBlockers(force),
  }
}

export function updateProjectCommand(input: {
  projectId: number
  workspaceId: number
  state?: ProjectCommandState
  policy?: Partial<ProjectRoutingPolicy>
  actor?: string | null
}): ProjectCommandRecord {
  const current = getProjectCommand(input.projectId, input.workspaceId)
  const nextState = input.state || current.state
  const nextPolicy: ProjectRoutingPolicy = {
    autoRoute: input.policy?.autoRoute ?? current.policy.autoRoute,
    allowReroute: input.policy?.allowReroute ?? current.policy.allowReroute,
    fallbackBehavior: input.policy?.fallbackBehavior ?? current.policy.fallbackBehavior,
    allowedPlatoons: input.policy?.allowedPlatoons ? parseList(JSON.stringify(input.policy.allowedPlatoons)) : current.policy.allowedPlatoons,
    maxProjectConcurrent: clamp(input.policy?.maxProjectConcurrent, current.policy.maxProjectConcurrent, 50),
    maxPlatoonConcurrent: clamp(input.policy?.maxPlatoonConcurrent, current.policy.maxPlatoonConcurrent, 20),
    maxAgentConcurrent: clamp(input.policy?.maxAgentConcurrent, current.policy.maxAgentConcurrent, 10),
  }
  if (nextState === 'active') {
    const force = analyzeProjectForce(input.projectId, input.workspaceId)
    const blockers = computeBlockers(force)
    if (blockers.length > 0) throw new Error(`Project cannot activate: ${blockers.join('; ')}`)
  }
  const now = Math.floor(Date.now() / 1000)
  const activatedAt = nextState === 'active' ? (current.activatedAt || now) : current.activatedAt
  const db = getDatabase()
  db.prepare(`
    INSERT INTO agentos_project_command (
      project_id, workspace_id, state, auto_route, allow_reroute, fallback_behavior,
      allowed_platoons_json, max_project_concurrent, max_platoon_concurrent,
      max_agent_concurrent, activated_at, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      workspace_id = excluded.workspace_id, state = excluded.state,
      auto_route = excluded.auto_route, allow_reroute = excluded.allow_reroute,
      fallback_behavior = excluded.fallback_behavior,
      allowed_platoons_json = excluded.allowed_platoons_json,
      max_project_concurrent = excluded.max_project_concurrent,
      max_platoon_concurrent = excluded.max_platoon_concurrent,
      max_agent_concurrent = excluded.max_agent_concurrent,
      activated_at = excluded.activated_at, updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(
    input.projectId, input.workspaceId, nextState,
    nextPolicy.autoRoute ? 1 : 0, nextPolicy.allowReroute ? 1 : 0,
    nextPolicy.fallbackBehavior, JSON.stringify(nextPolicy.allowedPlatoons),
    nextPolicy.maxProjectConcurrent, nextPolicy.maxPlatoonConcurrent,
    nextPolicy.maxAgentConcurrent, activatedAt, input.actor || null, now,
  )
  return getProjectCommand(input.projectId, input.workspaceId)
}

export interface DispatchGuardResult {
  allowed: boolean
  reason: string | null
  state: ProjectCommandState | null
  counts: { project: number; platoon: number; agent: number }
  limits: { project: number; platoon: number; agent: number }
}

export function checkAgentOSDispatchGuard(input: {
  projectId: number | null
  workspaceId: number
  routingAgentName: string
  platoonId: string
}): DispatchGuardResult {
  const zero = { project: 0, platoon: 0, agent: 0 }
  const defaults = { project: DEFAULT_POLICY.maxProjectConcurrent, platoon: DEFAULT_POLICY.maxPlatoonConcurrent, agent: DEFAULT_POLICY.maxAgentConcurrent }
  if (!input.projectId) return { allowed: false, reason: 'AgentOS-routed task has no project', state: null, counts: zero, limits: defaults }
  const command = getProjectCommand(input.projectId, input.workspaceId)
  const limits = { project: command.policy.maxProjectConcurrent, platoon: command.policy.maxPlatoonConcurrent, agent: command.policy.maxAgentConcurrent }
  if (command.state !== 'active') {
    return { allowed: false, reason: `Project command state is ${command.state}; ACTIVE is required for dispatch`, state: command.state, counts: zero, limits }
  }
  if (command.policy.allowedPlatoons.length > 0 && !command.policy.allowedPlatoons.includes(input.platoonId.toLowerCase())) {
    return { allowed: false, reason: `Platoon ${input.platoonId} is not allowed by project routing policy`, state: command.state, counts: zero, limits }
  }
  const db = getDatabase()
  const projectCount = Number((db.prepare("SELECT COUNT(*) c FROM tasks WHERE workspace_id = ? AND project_id = ? AND status = 'in_progress'").get(input.workspaceId, input.projectId) as any)?.c || 0)
  const platoonCount = Number((db.prepare("SELECT COUNT(*) c FROM tasks t JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id WHERE t.workspace_id = ? AND t.project_id = ? AND t.status = 'in_progress' AND a.source = 'agentos-external' AND lower(COALESCE(a.runtime_type,'')) = lower(?)").get(input.workspaceId, input.projectId, input.platoonId) as any)?.c || 0)
  const agentCount = Number((db.prepare("SELECT COUNT(*) c FROM tasks WHERE workspace_id = ? AND project_id = ? AND status = 'in_progress' AND assigned_to = ?").get(input.workspaceId, input.projectId, input.routingAgentName) as any)?.c || 0)
  const counts = { project: projectCount, platoon: platoonCount, agent: agentCount }
  if (projectCount >= limits.project) return { allowed: false, reason: `Project concurrency limit reached (${projectCount}/${limits.project})`, state: command.state, counts, limits }
  if (platoonCount >= limits.platoon) return { allowed: false, reason: `Platoon concurrency limit reached (${platoonCount}/${limits.platoon})`, state: command.state, counts, limits }
  if (agentCount >= limits.agent) return { allowed: false, reason: `Agent concurrency limit reached (${agentCount}/${limits.agent})`, state: command.state, counts, limits }
  return { allowed: true, reason: null, state: command.state, counts, limits }
}
