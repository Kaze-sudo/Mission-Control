import { createHash } from 'node:crypto'
import { getDatabase } from './db'

/**
 * AgentOS execution planning — the PREVIEW → COST/RUNTIME RISK → APPROVAL →
 * DISPATCH AUTHORIZATION flow (generic foundation).
 *
 * A prepared objective (normal project objective, resource deep review,
 * knowledge curation, capability acquisition, cross-platoon work, future
 * autonomous follow-ons) is turned into an Execution Plan: every mission gets
 * an independent cost class derived ONLY from existing runtime/provider
 * metadata — never invented pricing. Plans fingerprint execution-relevant
 * fields so an approval stays bound to the exact snapshot; any material change
 * (different specialist/provider/model/runtime, new mission, changed cost
 * class) invalidates it.
 *
 * This module is pure classification + planning. Authorization policy and
 * approval records live in execution-authorization.ts.
 */

export type ExecutionCostClass =
  | 'FREE_LOCAL'
  | 'FREE_REMOTE'
  | 'PAID_KNOWN'
  | 'PAID_ESTIMATED'
  | 'UNKNOWN_COST'
  | 'MANUAL_EXTERNAL'
  | 'BLOCKED'

export const EXECUTION_COST_CLASSES: ExecutionCostClass[] = [
  'FREE_LOCAL',
  'FREE_REMOTE',
  'PAID_KNOWN',
  'PAID_ESTIMATED',
  'UNKNOWN_COST',
  'MANUAL_EXTERNAL',
  'BLOCKED',
]

export interface ExecutionPolicy {
  allowFreeLocalWithoutApproval: boolean
  allowFreeRemoteWithoutApproval: boolean
  allowPaidWithoutApproval: boolean
  maxApprovedEstimatedCost: number | null
  approvedProviders: string[]
  blockedProviders: string[]
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  // Safe defaults: local/free work may run automatically; anything that costs
  // money or whose cost is unknown waits for an explicit approval.
  allowFreeLocalWithoutApproval: true,
  allowFreeRemoteWithoutApproval: false,
  allowPaidWithoutApproval: false,
  maxApprovedEstimatedCost: null,
  approvedProviders: [],
  blockedProviders: [],
}

/** Project command policy columns map onto these (migration 065). */
export const EXECUTION_POLICY_COLUMNS = {
  allowFreeLocalWithoutApproval: 'allow_free_local_without_approval',
  allowFreeRemoteWithoutApproval: 'allow_free_remote_without_approval',
  allowPaidWithoutApproval: 'allow_paid_without_approval',
  maxApprovedEstimatedCost: 'max_approved_estimated_cost',
  approvedProviders: 'approved_providers_json',
  blockedProviders: 'blocked_providers_json',
} as const

/**
 * Unconditional local/free runtime tokens — MC-native execution with no
 * external model: a direct local LLM endpoint, builtin helpers, or file
 * system/registry work. These never need free-local evidence.
 */
const FREE_LOCAL_RUNTIMES = new Set(['local', 'builtin', 'filesystem', 'mission-control'])

/**
 * Host-orchestrated local runtimes — the desktop host runs the agent, but the
 * agent may invoke a configured remote/paid model. FREE_LOCAL only with
 * explicit free evidence (provider 'local' or agentos.cost.freeLocal); a
 * declared non-local provider is PAID_ESTIMATED; no evidence is UNKNOWN_COST.
 * A localhost host API never implies free by itself.
 */
const HOST_LOCAL_RUNTIMES = new Set(['gamut', 'superagent-host'])

const HOST_LOCAL_EVIDENCE_HINT: Record<string, string> = {
  gamut: 'Gamut host agent model/provider not declared — it may invoke a configured paid model',
  'superagent-host': 'SuperAgent host agent model/provider not declared — it may invoke a configured paid model',
}

/** Runtime tokens whose executor is an external orchestrator we cannot price. */
const UNKNOWN_RUNTIME_HINT: Record<string, string> = {
  hermes: 'Hermes profile may call remote/paid backends; no pricing metadata',
  codex: 'Authenticated Codex CLI bills the host account; no pricing metadata',
  claude: 'Claude Code session dispatch bills the host account; no pricing metadata',
  openclaw: 'OpenClaw host dispatch; no pricing metadata',
  gateway: 'Gateway dispatch; no pricing metadata',
  sandbox: 'Sandbox runtime; cost depends on provider configuration',
}

export interface ClassifiedExecution {
  costClass: ExecutionCostClass
  basis: string
  provider: string | null
  model: string | null
  estimatedCost: number | null
  warnings: string[]
}

export interface MissionRuntimeMeta {
  runtimeType: string | null
  provider?: string | null
  model?: string | null
  /** Explicit annotation (e.g. from an agent definition or objective creator). */
  costClassOverride?: ExecutionCostClass | null
  estimatedCost?: number | null
  /** Optional agent.config JSON with provider/model keys. */
  agentConfig?: Record<string, unknown> | null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Phase 2/4 — classify one routed mission. Rules:
 * - an explicit annotation is authoritative (manual override preserved);
 * - known FREE_LOCAL runtime tokens (local host API, builtin, filesystem);
 * - PAID_KNOWN only when an exact estimate is carried by existing metadata;
 * - PAID_ESTIMATED only when a provider/model is declared but no price;
 * - everything else without evidence stays UNKNOWN_COST (never guessed);
 * - missing runtime/assignment → BLOCKED;
 * - annotation MANUAL_EXTERNAL → manual operation.
 */
export function classifyExecutionCost(
  meta: MissionRuntimeMeta,
): ClassifiedExecution {
  const warnings: string[] = []
  const override = meta.costClassOverride
  if (override && EXECUTION_COST_CLASSES.includes(override)) {
    const basis = 'Explicit execution annotation (authoritative)'
    return {
      costClass: override,
      basis,
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      estimatedCost: typeof meta.estimatedCost === 'number' && Number.isFinite(meta.estimatedCost) ? meta.estimatedCost : null,
      warnings,
    }
  }

  const runtime = (meta.runtimeType || '').toLowerCase()
  if (!runtime) {
    return {
      costClass: 'BLOCKED',
      basis: 'No runtime assigned — cannot dispatch',
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      estimatedCost: null,
      warnings: ['Mission has no assigned runtime'],
    }
  }

  const config = meta.agentConfig || {}
  const provider = meta.provider ?? asString(config.provider) ?? null
  const model = meta.model ?? asString(config.model) ?? null

  if (FREE_LOCAL_RUNTIMES.has(runtime)) {
    const basis = `Runtime ${runtime} executes locally on the host (no paid provider)`
    return { costClass: 'FREE_LOCAL', basis, provider, model, estimatedCost: null, warnings }
  }

  if (HOST_LOCAL_RUNTIMES.has(runtime)) {
    const freeEvidence =
      provider === 'local'
      || (config.agentos && typeof config.agentos === 'object'
        && (config.agentos as Record<string, unknown>).cost
        && typeof (config.agentos as Record<string, unknown>).cost === 'object'
        && ((config.agentos as Record<string, unknown>).cost as Record<string, unknown>).freeLocal === true)
    if (freeEvidence) {
      return {
        costClass: 'FREE_LOCAL',
        basis: `Runtime ${runtime} executes locally on the host with declared free-local evidence (no paid provider)`,
        provider, model, estimatedCost: null, warnings,
      }
    }
    if (provider && provider !== 'local') {
      return {
        costClass: 'PAID_ESTIMATED',
        basis: `Host runtime ${runtime} declares provider ${provider}${model ? ` / model ${model}` : ''}; no pricing metadata — treated as paid, estimate unknown`,
        provider, model, estimatedCost: null, warnings: [],
      }
    }
    const hint = HOST_LOCAL_EVIDENCE_HINT[runtime]
    warnings.push(hint || `Host runtime ${runtime} has no free-local evidence`)
    return {
      costClass: 'UNKNOWN_COST',
      basis: hint || `No reliable pricing metadata available for host runtime ${runtime}`,
      provider: null, model: null, estimatedCost: null, warnings,
    }
  }

  const estimate = typeof meta.estimatedCost === 'number' && Number.isFinite(meta.estimatedCost) ? meta.estimatedCost : null
  if (estimate !== null && estimate >= 0) {
    return {
      costClass: 'PAID_KNOWN',
      basis: `Exact estimate carried in execution metadata (${estimate})`,
      provider,
      model,
      estimatedCost: estimate,
      warnings: [],
    }
  }
  if (provider) {
    return {
      costClass: model ? 'PAID_ESTIMATED' : 'PAID_ESTIMATED',
      basis: model
        ? `Provider ${provider} / model ${model} declared; no pricing metadata — treated as paid, estimate unknown`
        : `Provider ${provider} declared; no pricing metadata — treated as paid, estimate unknown`,
      provider,
      model,
      estimatedCost: null,
      warnings: [],
    }
  }

  const hint = UNKNOWN_RUNTIME_HINT[runtime]
  if (hint) {
    return {
      costClass: 'UNKNOWN_COST',
      basis: hint,
      provider: null,
      model: null,
      estimatedCost: null,
      warnings: ['Cost cannot be confirmed from existing metadata'],
    }
  }
  return {
    costClass: 'UNKNOWN_COST',
    basis: 'No reliable pricing metadata available',
    provider: null,
    model: null,
    estimatedCost: null,
    warnings: ['Unknown runtime — cost cannot be confirmed from existing metadata'],
  }
}

/**
 * Phase 5 — does this cost class require explicit approval under the policy?
 * FREE_LOCAL may run automatically when policy allows; FREE_REMOTE only when
 * explicitly allowed free; paid classes only when pre-authorized; UNKNOWN_COST
 * always requires approval. MANUAL_EXTERNAL always needs a human; BLOCKED can
 * never dispatch.
 */
export function costRequiresApproval(costClass: ExecutionCostClass, policy: ExecutionPolicy): boolean {
  switch (costClass) {
    case 'FREE_LOCAL':
      return policy.allowFreeLocalWithoutApproval !== true
    case 'FREE_REMOTE':
      return policy.allowFreeRemoteWithoutApproval !== true
    case 'PAID_KNOWN':
    case 'PAID_ESTIMATED':
      return policy.allowPaidWithoutApproval !== true
    case 'UNKNOWN_COST':
      return true
    case 'MANUAL_EXTERNAL':
      return true
    case 'BLOCKED':
      return true
    default:
      return true
  }
}

export function costClassLabel(costClass: ExecutionCostClass): string {
  return costClass
}

// ---------------------------------------------------------------------------
// Execution plan model (Phase 3)
// ---------------------------------------------------------------------------

export interface ExecutionPlanMission {
  taskId: number
  missionKey: string
  title: string
  status: string
  assignedTo: string | null
  platoon: string | null
  specialist: string | null
  runtimeType: string | null
  provider: string | null
  model: string | null
  costClass: ExecutionCostClass
  estimatedCost: number | null
  costBasis: string
  requiresApproval: boolean
  dependencies: string[]
  resources: Array<{ resourceId: string; name: string; manualOnly?: boolean }>
  runtimeAccess: string
  warnings: string[]
}

export interface ExecutionPlan {
  planId: string
  objectiveId: number
  projectId: number
  workspaceId: number
  createdAt: string
  status: 'PREVIEW' | 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'COMPLETE' | 'CANCELLED'
  missions: ExecutionPlanMission[]
  summary: {
    freeMissions: number
    paidMissions: number
    unknownCostMissions: number
    blockedMissions: number
    approvalRequired: boolean
    waves: string[][]
  }
  fingerprint: string
}

function parseMetadata(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function objectiveOf(metadata: Record<string, any>): number | null {
  const agentos = metadata.agentos
  if (agentos?.objectiveId !== undefined) {
    const value = Number(agentos.objectiveId)
    if (Number.isInteger(value) && value > 0) return value
  }
  const review = metadata.agentos_resource_review
  if (review && typeof review.objective_id === 'number') return review.objective_id
  const curation = metadata.agentos_knowledge_curation
  if (curation && typeof curation.objective_id === 'number') return curation.objective_id
  return null
}

/** Execution-relevant fingerprint (Phase 8) — stable across cosmetic changes. */
export function computeExecutionFingerprint(plan: Omit<ExecutionPlan, 'fingerprint'>): string {
  const missions = [...plan.missions]
    .sort((a, b) => a.taskId - b.taskId)
    .map(mission => ({
      taskId: mission.taskId,
      missionKey: mission.missionKey,
      dependencies: [...mission.dependencies].sort(),
      specialist: mission.specialist || null,
      platoon: mission.platoon || null,
      runtimeType: mission.runtimeType || null,
      provider: mission.provider || null,
      model: mission.model || null,
      costClass: mission.costClass,
      estimatedCost: mission.estimatedCost ?? null,
      resources: mission.resources.map(resource => resource.resourceId).sort(),
    }))
  const canonical = JSON.stringify({ objectiveId: plan.objectiveId, missions })
  return createHash('sha256').update(canonical).digest('hex')
}

/** Weak dependency waves: independent missions share an early wave. */
export function dependencyWaves(missions: Array<{ missionKey: string; dependencies: string[] }>): string[][] {
  const depth = new Map<string, number>()
  const order = [...missions]
  for (let pass = 0; pass <= order.length; pass++) {
    let changed = false
    for (const mission of order) {
      const depDepth = mission.dependencies
        .filter(key => depth.has(key))
        .reduce((max, key) => Math.max(max, depth.get(key)!), 0)
      const next = mission.dependencies.length === 0 ? 0 : depDepth + 1
      if ((depth.get(mission.missionKey) ?? -1) !== next) {
        depth.set(mission.missionKey, next)
        changed = true
      }
    }
    if (!changed) break
  }
  const groups = new Map<number, string[]>()
  for (const mission of order) {
    const level = depth.get(mission.missionKey) ?? 0
    const list = groups.get(level) || []
    list.push(mission.missionKey)
    groups.set(level, list)
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, keys]) => keys)
}

export function buildExecutionPlan(input: {
  objectiveId: number
  workspaceId: number
  policy: ExecutionPolicy
  actor?: string | null
}): ExecutionPlan {
  const db = getDatabase()
  const objective = db.prepare(
    'SELECT id, project_id, workspace_id, title, status, plan_json FROM agentos_objectives WHERE id = ? AND workspace_id = ?',
  ).get(input.objectiveId, input.workspaceId) as
    | { id: number; project_id: number; workspace_id: number; title: string; status: string; plan_json: string }
    | undefined
  if (!objective) throw new Error('Objective not found')

  let planRows: Array<{ key: string; title: string; taskId?: number; dependsOnKeys?: string[]; dependsOnTaskIds?: number[] }> = []
  try {
    const parsed = JSON.parse(objective.plan_json || '{}')
    planRows = Array.isArray(parsed.missions) ? parsed.missions : []
  } catch {
    planRows = []
  }
  if (planRows.length === 0) throw new Error('Objective has no planned missions — run Assemble first')

  const now = new Date().toISOString()
  const missions: ExecutionPlanMission[] = []
  let freeMissions = 0
  let paidMissions = 0
  let unknownCostMissions = 0
  let blockedMissions = 0

  for (const row of planRows) {
    const taskId = Number(row.taskId)
    const task = Number.isInteger(taskId)
      ? db.prepare('SELECT id, status, assigned_to, metadata FROM tasks WHERE id = ? AND workspace_id = ?')
        .get(taskId, objective.workspace_id) as { id: number; status: string; assigned_to: string | null; metadata: string | null } | undefined
      : undefined
    const metadata = parseMetadata(task?.metadata)
    const assignedTo = task?.assigned_to || null

    // Agent runtime/config lookup (real workspace).
    let agentRuntime: string | null = null
    let agentSource: string | null = null
    let agentConfig: Record<string, unknown> | null = null
    if (assignedTo) {
      const agent = db.prepare(
        'SELECT runtime_type, source, config FROM agents WHERE name = ? AND workspace_id = ?',
      ).get(assignedTo, objective.workspace_id) as { runtime_type: string | null; source: string | null; config: string | null } | undefined
      agentRuntime = agent?.runtime_type ?? null
      agentSource = agent?.source ?? null
      if (agent?.config) {
        try {
          const parsedConfig = JSON.parse(agent.config)
          if (parsedConfig && typeof parsedConfig === 'object') agentConfig = parsedConfig
        } catch {
          agentConfig = null
        }
      }
    }

    const annotation = metadata.agentos_execution && typeof metadata.agentos_execution === 'object' ? metadata.agentos_execution : {}
    const classified = classifyExecutionCost({
      runtimeType: agentRuntime,
      provider: typeof annotation.provider === 'string' ? annotation.provider : null,
      model: typeof annotation.model === 'string' ? annotation.model : null,
      costClassOverride: EXECUTION_COST_CLASSES.includes(annotation.costClass) ? annotation.costClass as ExecutionCostClass : null,
      estimatedCost: typeof annotation.estimatedCost === 'number' && Number.isFinite(annotation.estimatedCost) ? annotation.estimatedCost : null,
      agentConfig,
    })
    if (classified.costClass === 'FREE_LOCAL') freeMissions++
    else if (classified.costClass === 'PAID_KNOWN' || classified.costClass === 'PAID_ESTIMATED') paidMissions++
    else if (classified.costClass === 'UNKNOWN_COST') unknownCostMissions++
    else if (classified.costClass === 'BLOCKED') blockedMissions++

    const requiresApproval = costRequiresApproval(classified.costClass, input.policy)
    const resources = Array.isArray(metadata.agentos_resources)
      ? metadata.agentos_resources
        .filter((entry: unknown) => entry && typeof entry === 'object')
        .map((entry: any) => ({
          resourceId: String(entry.resource_id || entry.id || ''),
          name: String(entry.name || entry.resource_id || ''),
          manualOnly: entry.manual_only === true,
        }))
        .filter(resource => resource.resourceId)
      : []

    missions.push({
      taskId,
      missionKey: String(row.key || `m${missions.length + 1}`),
      title: task?.status ? row.title : `${row.title} (task missing)`,
      status: task?.status || 'missing',
      assignedTo,
      platoon: agentRuntime ? String(agentRuntime).toLowerCase() : null,
      specialist: assignedTo,
      runtimeType: agentRuntime,
      provider: classified.provider,
      model: classified.model,
      costClass: classified.costClass,
      estimatedCost: classified.estimatedCost,
      costBasis: classified.basis,
      requiresApproval,
      dependencies: (row.dependsOnKeys || []).map(String),
      resources,
      runtimeAccess: task
        ? (assignedTo && agentRuntime ? `assigned → ${agentRuntime}${agentSource ? ` (${agentSource})` : ''}` : 'unassigned')
        : 'task not found',
      warnings: classified.warnings,
    })
  }

  const waves = dependencyWaves(missions)
  const approvalRequired = missions.some(mission => mission.requiresApproval)
  const plan: Omit<ExecutionPlan, 'fingerprint'> = {
    planId: `exp-${objective.workspace_id}-${objective.id}`,
    objectiveId: objective.id,
    projectId: objective.project_id,
    workspaceId: objective.workspace_id,
    createdAt: now,
    status: 'PREVIEW',
    missions,
    summary: {
      freeMissions,
      paidMissions,
      unknownCostMissions,
      blockedMissions,
      approvalRequired,
      waves,
    },
  }
  return { ...plan, fingerprint: computeExecutionFingerprint(plan) }
}

export function isAgentOSGatedTask(metadata: Record<string, any> | string | null | undefined): boolean {
  const meta = typeof metadata === 'string' ? parseMetadata(metadata) : (metadata || {})
  if (objectiveOf(meta) !== null) return true
  if (meta.agentos_resource_review && typeof meta.agentos_resource_review === 'object') return true
  if (meta.agentos_knowledge_curation && typeof meta.agentos_knowledge_curation === 'object') return true
  return false
}

/** Objective id backing an AgentOS-gated task, if any. */
export function objectiveIdFromTaskMetadata(metadata: Record<string, any> | string | null | undefined): number | null {
  const meta = typeof metadata === 'string' ? parseMetadata(metadata) : (metadata || {})
  return objectiveOf(meta)
}

// ---------------------------------------------------------------------------
// Plan persistence (display cache; approvals are validated against regenerated
// fingerprints, never against this row)
// ---------------------------------------------------------------------------

export function saveExecutionPlanRow(plan: ExecutionPlan, status: ExecutionPlan['status'] = 'AWAITING_APPROVAL'): void {
  const now = Math.floor(Date.now() / 1000)
  getDatabase().prepare(`
    INSERT INTO agentos_execution_plans (
      objective_id, project_id, workspace_id, status, plan_json, fingerprint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(objective_id) DO UPDATE SET
      project_id = excluded.project_id, workspace_id = excluded.workspace_id,
      status = excluded.status, plan_json = excluded.plan_json,
      fingerprint = excluded.fingerprint, updated_at = excluded.updated_at
  `).run(
    plan.objectiveId, plan.projectId, plan.workspaceId, status,
    JSON.stringify(plan), plan.fingerprint, now, now,
  )
}

export function readExecutionPlanRow(objectiveId: number, workspaceId: number): {
  status: string
  plan: ExecutionPlan | null
} | null {
  const row = getDatabase().prepare(
    'SELECT status, plan_json FROM agentos_execution_plans WHERE objective_id = ? AND workspace_id = ?',
  ).get(objectiveId, workspaceId) as { status: string; plan_json: string } | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.plan_json)
    return { status: row.status, plan: parsed && typeof parsed === 'object' ? parsed as ExecutionPlan : null }
  } catch {
    return { status: row.status, plan: null }
  }
}
