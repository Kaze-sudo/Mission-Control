import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDatabase, db_helpers } from './db'
import { config } from './config'
import { getAiResourceRegistry, getAiReviewQueue, type AiReviewQueueItem } from './ai-resource-registry'
import { commitCatalogUpdates, readCatalogDoc } from './ai-resource-actions'
import { routeTaskWithinProject } from './project-task-routing'
import { getLatestDelegationForTask } from './delegation-ledger'
import { createObjectivePlan } from './objective-planning'
import { getOrCreateAgentOSOperationsProject } from './agentos-operations'
import {
  escalateTask,
  readTaskEscalation,
  resolveTaskEscalation,
  syncObjectiveEscalation,
  type EscalationReason,
} from './agentos-escalation'

/**
 * AgentOS resource deep-review delegation.
 *
 * Turns a queued AI Arsenal review request into a NORMAL AgentOS mission:
 * task creation → capability inference → reviewer routing through the standard
 * project/specialist selector → native runtime dispatch (existing scheduler) →
 * structured result ingestion validated against agentos-resource-review-v1 →
 * review queue updated → human approval via the existing atomic action model.
 *
 * AgentOS stays Company Commander. The reviewer is chosen dynamically from the
 * roster; no reviewer is hard-coded.
 */

export const RESOURCE_DEEP_REVIEW_CAPABILITY = 'resource-deep-review'
export const DEEP_REVIEW_OUTPUT_SCHEMA = 'agentos-resource-review-v1'
export const REVIEW_ENVELOPE_START = '---AGENTOS_REVIEW_RESULT_START---'
export const REVIEW_ENVELOPE_END = '---AGENTOS_REVIEW_RESULT_END---'

/** Retry / invalid-output thresholds before automation escalates to NEEDS_MANUAL. */
export const DEEP_REVIEW_MAX_RETRIES = 2
export const DEEP_REVIEW_MAX_INVALID_ATTEMPTS = 2

export const DEEP_REVIEW_STATES = [
  'QUEUED',
  'ROUTED',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'STALE',
  'NEEDS_MANUAL',
] as const
export type DeepReviewStatus = (typeof DEEP_REVIEW_STATES)[number]

const AUDIT_STATUSES = ['KEEP', 'KEEP-SECONDARY', 'REFERENCE', 'ARCHIVE-CANDIDATE', 'REJECT-CANDIDATE'] as const
const CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const

export interface AgentOSResourceReviewV1 {
  review_id: string
  resource_id: string | null
  review_status: 'COMPLETE'
  actual_type: string
  quality_score: number
  confidence: (typeof CONFIDENCES)[number]
  proven_capabilities: string[]
  rejected_capabilities: string[]
  primary_capability: string
  secondary_capabilities: string[]
  audit_status_recommendation: (typeof AUDIT_STATUSES)[number]
  auto_select_recommendation: boolean
  manual_only_recommendation: boolean
  preferred_platoon: string | null
  preferred_specialist_role: string | null
  integration_mode: string | null
  runtime_requirements: string[]
  move_risk: string | null
  path_sensitive: boolean
  overlap_findings: string[]
  supersession_findings: string[]
  capability_gap_effects: string[]
  strengths: string[]
  weaknesses: string[]
  evidence: string[]
  warnings: string[]
  proposed_registry_entry: Record<string, unknown>
  proposed_capability_index_changes: Record<string, unknown>
  proposed_overlap_policy_changes: Record<string, unknown>
  proposed_platoon_map_changes: Record<string, unknown>
}

export interface ReviewMissionRequirements {
  required: string[]
  preferred: string[]
}

export interface DeepReviewMissionResult {
  taskId: number
  reviewId: string
  workspaceId: number
  projectId: number | null
  objectiveId: number | null
  taskStatus: string
  routed: boolean
  reason?: string
  reviewer?: string | null
  fingerprint: string
}

export interface DeepReviewIngestResult {
  status: 'COMPLETE' | 'INVALID_RESULT' | 'STALE' | 'NO_RESULT' | 'QUEUE_ITEM_MISSING' | 'NOT_A_REVIEW_TASK' | 'TASK_NOT_FOUND'
  reviewId?: string
  value?: AgentOSResourceReviewV1
  errors?: string[]
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

function catalogOf(root: string): string {
  if (!root || !fs.existsSync(root)) throw new Error('AI vault root does not exist: ' + root)
  const catalog = path.join(root, '_CATALOG')
  if (!fs.existsSync(catalog)) throw new Error('AI vault catalog does not exist: ' + catalog)
  return catalog
}

function updateQueueItem(root: string, reviewId: string, updater: (item: Record<string, any>) => void): void {
  const catalog = catalogOf(root)
  const doc = readCatalogDoc(catalog, 'agentos_resource_review_queue.json')
  if (!doc || !Array.isArray(doc.items)) throw new Error('Review queue is missing or malformed')
  const item = doc.items.find(candidate => String(candidate?.review_id) === reviewId)
  if (!item) throw new Error('Review queue item not found: ' + reviewId)
  updater(item)
  const updates = new Map<string, string>()
  updates.set('agentos_resource_review_queue.json', JSON.stringify(doc, null, 2) + '\n')
  commitCatalogUpdates(catalog, updates)
}

function setQueueDeepReviewState(root: string, reviewId: string, status: DeepReviewStatus, patch: Record<string, unknown> = {}): void {
  updateQueueItem(root, reviewId, item => {
    item.deep_review = {
      ...(typeof item.deep_review === 'object' && item.deep_review !== null ? item.deep_review : {}),
      required_capability: RESOURCE_DEEP_REVIEW_CAPABILITY,
      status,
      ...patch,
    }
  })
}

// ---------------------------------------------------------------------------
// Reviewer selection inputs
// ---------------------------------------------------------------------------

/**
 * Phase 3 — reviewer domain affinity. Required capability is always
 * resource-deep-review; preferred capabilities come from the candidate's own
 * detected capabilities plus a declared type/domain map so a domain specialist
 * outranks a generic director without evidence.
 */
const DOMAIN_AFFINITY: Array<[RegExp, string[]]> = [
  [/game|unity|godot|unreal|wesnoth|oxce|tactical|combat|encounter|playtest/i, ['game-development', 'qa-release', 'architecture']],
  [/mcp|composio|integrat|sdk|api|tool/i, ['mcp', 'backend', 'security']],
  [/knowledge|research|catalog|treasure|skill|wiki/i, ['research', 'knowledge-management']],
  [/art|animation|vfx|sprite|render|film|film-skill|cinematic/i, ['art-animation', 'vfx-camera']],
  [/audio|music|sound|sfx|voice/i, ['audio']],
  [/database|postgres|sql|storage|schema|migration/i, ['data', 'backend']],
  [/security|auth|vulnerab|audit/i, ['security', 'testing-review']],
  [/3d|mesh|model|genlab|tripo/i, ['3d-generation']],
  [/engine|framework|library|platform/i, ['architecture', 'testing-review']],
]

export function inferReviewerRequirements(item: AiReviewQueueItem): ReviewMissionRequirements {
  const required = [RESOURCE_DEEP_REVIEW_CAPABILITY]
  const preferred = [
    ...item.detectedCapabilities,
    ...(item.inferredPrimaryCapability ? [item.inferredPrimaryCapability] : []),
    ...(item.coversCapabilityGaps || []),
  ]
  const haystack = [
    item.probableName,
    item.path,
    item.probableResourceType || '',
    item.inferredPrimaryCapability || '',
    item.recommendedAction || '',
    ...item.likelyOverlaps,
    ...item.detectedCapabilities,
  ].join(' ')
  for (const [pattern, tags] of DOMAIN_AFFINITY) {
    if (pattern.test(haystack)) preferred.push(...tags)
  }
  return {
    required,
    preferred: [...new Set(preferred.filter(tag => tag && tag !== RESOURCE_DEEP_REVIEW_CAPABILITY))],
  }
}

// ---------------------------------------------------------------------------
// Fingerprinting (Phase 9)
// ---------------------------------------------------------------------------

/**
 * Deterministic fingerprint of the candidate + any authoritative registry
 * entry. Computed at mission creation; recomputed at ingestion. A mismatch
 * means the resource changed during review → STALE, not ingested as truth.
 */
export function computeReviewFingerprint(root: string, item: AiReviewQueueItem): string {
  const registry = getAiResourceRegistry(root)
  const stableId = item.raw?.stable_id ? String(item.raw.stable_id) : null
  const entry = stableId ? registry.resources.find(resource => resource.id === stableId) : undefined
  const candidatePart = [
    item.reviewId,
    item.probableName,
    item.path,
    item.detectedState,
    [...item.detectedCapabilities].sort(),
    item.inferredPrimaryCapability || '',
    item.preliminaryQualityScore === null ? '' : String(item.preliminaryQualityScore),
    item.recommendedAction || '',
  ].join('|')
  const registryPart = entry
    ? JSON.stringify({
        id: entry.id,
        name: entry.name,
        score: entry.score,
        auditStatus: entry.auditStatus,
        capabilities: entry.capabilities,
        path: entry.path,
      })
    : ''
  return createHash('sha256').update(candidatePart + '::' + registryPart).digest('hex')
}

// ---------------------------------------------------------------------------
// Mission creation (Phase 4)
// ---------------------------------------------------------------------------

function reviewSequence(root: string, item: AiReviewQueueItem) {
  const registry = getAiResourceRegistry(root)
  const competing = new Set(item.currentCompetingResources || [])
  const filtered = registry.resources
    .filter(resource =>
      resource.id === String(item.raw?.stable_id || '') ||
      competing.has(resource.id) ||
      (item.inferredPrimaryCapability ? resource.capabilities.includes(item.inferredPrimaryCapability) : false),
    )
    .slice(0, 20)
    .map(resource => ({
      id: resource.id,
      name: resource.name,
      score: resource.score,
      auditStatus: resource.auditStatus,
      primaryCapability: resource.primaryCapability,
      capabilities: resource.capabilities,
      manualOnly: resource.manualOnly,
      autoSelectAllowed: resource.autoSelectAllowed,
      preferredPlatoon: resource.preferredPlatoon,
      preferredSpecialistRole: resource.preferredSpecialistRole,
    }))
  return {
    total: registry.resources.length,
    filtered,
    overlapPolicy: registry.overlapGroups.map(group => ({
      capability: group.capability,
      preferredId: group.preferredId,
      candidateIds: group.candidateIds,
    })),
  }
}

function findMissionTaskByReviewId(reviewId: string, workspaceId: number): { id: number; metadata: string | null } | null {
  const db = getDatabase()
  const row = db.prepare(
    `SELECT id, metadata FROM tasks WHERE workspace_id = ? AND metadata LIKE ? ORDER BY id DESC LIMIT 1`,
  ).get(workspaceId, `%"agentos_resource_review"%"review_id":"${reviewId}"%`) as { id: number; metadata: string | null } | undefined
  // LIKE with escaped characters can be fragile; double-check with a JSON parse.
  if (!row) return null
  const meta = parseMetadata(row.metadata)
  if (meta.agentos_resource_review?.review_id !== reviewId) return null
  return row
}

function buildReviewBrief(item: AiReviewQueueItem, reviewId: string, resourceId: string | null): string {
  return [
    `Inspect ONLY the target resource for the AgentOS AI Arsenal deep review. Do NOT modify, move, delete, or rename it.`,
    ``,
    `- Review ID: ${reviewId}`,
    `- Resource: ${item.probableName} (${item.path || 'path unknown'})`,
    ...(resourceId ? [`- Stable ID: ${resourceId}`] : []),
    `- Detected state: ${item.detectedState}`,
    ...(item.detectedCapabilities.length ? [`- Detected capabilities: ${item.detectedCapabilities.join(', ')}`] : []),
    ...(item.runtimePathRisks.length ? [`- Runtime/path risks to verify: ${item.runtimePathRisks.join(', ')}`] : []),
    ``,
    `Kind:`,
    `- Use source evidence, not README claims alone. Distinguish implemented capabilities from mentions.`,
    `- Compare against the current authoritative resources in the registry snapshot.`,
    `- Preserve existing manual-only / REJECT / ARCHIVE policy — never recommend auto-selecting something that must stay manual.`,
    `- Output ONLY the structured review result in the required envelope.`,
    ``,
    `Required output envelope — wrap your final structured answer in:`,
    REVIEW_ENVELOPE_START,
    `{ "review_id": "${reviewId}", ... }`,
    REVIEW_ENVELOPE_END,
    `Schema: ${DEEP_REVIEW_OUTPUT_SCHEMA}. Invalid JSON or a mismatched review_id will be rejected.`,
  ].join('\n')
}

/**
 * Find the objective backing a review: first via the mission task metadata
 * (agentos.objectiveId), then via the plan_json agentos_review_link marker.
 */
function findObjectiveByReview(reviewId: string, workspaceId: number): { objectiveId: number; taskId: number } | null {
  const db = getDatabase()
  const task = findMissionTaskByReviewId(reviewId, workspaceId)
  if (task) {
    const meta = parseMetadata(task.metadata)
    const objectiveId = typeof meta.agentos?.objectiveId === 'number'
      ? meta.agentos.objectiveId
      : typeof meta.agentos_resource_review?.objective_id === 'number'
        ? meta.agentos_resource_review.objective_id
        : null
    if (objectiveId !== null) return { objectiveId, taskId: task.id }
  }
  const rows = db.prepare(
    `SELECT id, plan_json FROM agentos_objectives
     WHERE workspace_id = ? AND plan_json LIKE '%"agentos_review_link"%' ORDER BY id DESC LIMIT 20`,
  ).all(workspaceId) as Array<{ id: number; plan_json: string }>
  for (const row of rows) {
    let plan: any
    try { plan = JSON.parse(row.plan_json) } catch { continue }
    const link = plan?.agentos_review_link
    if (link?.review_id !== reviewId) continue
    const taskId = (plan.missions || []).find((mission: any) => mission.key === (link.mission_key || 'm1'))?.taskId
    if (Number.isInteger(taskId)) return { objectiveId: row.id, taskId }
  }
  return null
}

/**
 * Phase 2/3/4 — internal AgentOS objective. Deep reviews live in the AgentOS
 * Operations project (or an explicitly chosen active project) as a normal
 * Company Commander objective with a single review mission. The objective is
 * deduplicated by review_id; a review never gets two missions or two
 * objectives. Routing goes through createObjectivePlan's normal path.
 */
function ensureDeepReviewObjective(input: {
  reviewId: string
  item: AiReviewQueueItem
  requirements: ReviewMissionRequirements
  projectId: number
  workspaceId: number
  actor: string
}): { objectiveId: number; taskId: number; routing: any | null } {
  const found = findObjectiveByReview(input.reviewId, input.workspaceId)
  if (found) {
    const db = getDatabase()
    const taskRow = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(found.taskId, input.workspaceId) as { metadata: string | null } | undefined
    const routing = taskRow ? (parseMetadata(taskRow.metadata).agentos_routing || null) : null
    return { ...found, routing }
  }

  const resourceId = input.item.raw?.stable_id ? String(input.item.raw.stable_id) : null
  const description = buildReviewBrief(input.item, input.reviewId, resourceId)
  const created = createObjectivePlan({
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    title: `Deep review: ${input.item.probableName}`,
    description,
    actor: input.actor,
    missions: [{
      key: 'm1',
      title: `Deep review: ${input.item.probableName}`,
      description,
      requiredCapabilities: input.requirements.required,
      preferredCapabilities: input.requirements.preferred,
    }],
  })
  const mission = created.missions[0]
  const db = getDatabase()
  const row = db.prepare('SELECT plan_json FROM agentos_objectives WHERE id = ? AND workspace_id = ?')
    .get(created.objectiveId, input.workspaceId) as { plan_json: string }
  let plan: any = {}
  try { plan = JSON.parse(row.plan_json || '{}') } catch { plan = {} }
  plan.agentos_review_link = {
    review_id: input.reviewId,
    resource_id: resourceId,
    mission_key: 'm1',
    task_id: mission.taskId,
    created_at: new Date().toISOString(),
  }
  db.prepare('UPDATE agentos_objectives SET plan_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(plan), Math.floor(Date.now() / 1000), created.objectiveId, input.workspaceId)

  return { objectiveId: created.objectiveId, taskId: mission.taskId, routing: (mission as any).routing || null }
}

export function createDeepReviewMission(input: {
  reviewId: string
  workspaceId: number
  projectId?: number | null
  actor?: string | null
  root?: string
  reviewer?: string | null
}): DeepReviewMissionResult {
  const root = input.root || config.aiVaultRoot
  catalogOf(root)
  const reviewId = input.reviewId
  const item = getAiReviewQueue(root).find(candidate => candidate.reviewId === reviewId)
  if (!item) throw new Error('Review queue item not found: ' + reviewId)

  const currentState = item.deepReview?.status || 'QUEUED'
  if (currentState === 'ROUTED' || currentState === 'RUNNING' || currentState === 'COMPLETE') {
    throw new Error(`Deep review already ${currentState.toLowerCase()} for ${reviewId} — retry only when failed/stale`)
  }
  const existing = findMissionTaskByReviewId(reviewId, input.workspaceId)
  if (existing) {
    // A mission task already exists (from a failed/stale/queued earlier request).
    // Reuse it instead of creating a duplicate review mission.
    return retryDeepReviewMission({
      reviewId,
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? undefined,
      actor: input.actor ?? undefined,
      root: input.root,
    })
  }

  const requirements = inferReviewerRequirements(item)
  const fingerprint = computeReviewFingerprint(root, item)
  const resourceId = item.raw?.stable_id ? String(item.raw.stable_id) : null
  const actor = input.actor || 'agentos'
  const priority = item.highPriorityGap || (item.coversCapabilityGaps || []).length > 0 ? 'high' : 'medium'
  const description = buildReviewBrief(item, reviewId, resourceId)

  // Phase 2 — internal operations objective. Explicit active-project overrides
  // are honored (manual authority); otherwise reviews attach to the AgentOS
  // Operations project, never to an arbitrary user project.
  const db = getDatabase()
  let projectId: number | null = null
  if (input.projectId) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND status = ?')
      .get(input.projectId, input.workspaceId, 'active') as { id: number } | undefined
    if (project) projectId = project.id
  }
  if (!projectId) projectId = getOrCreateAgentOSOperationsProject(input.workspaceId).id

  const { objectiveId, taskId, routing } = ensureDeepReviewObjective({
    reviewId,
    item,
    requirements,
    projectId,
    workspaceId: input.workspaceId,
    actor,
  })

  const routed = !!routing?.routed
  const reviewer = input.reviewer || item.deepReview?.reviewer || routing?.selected?.agentName || null
  const reason = routed ? undefined
    : (routing?.reason || 'No eligible reviewer yet (mission held for manual assignment)')

  // Patch the objective mission task with the review contract. The task is a
  // normal Company Commander objective mission (agentos.objectiveId set by
  // createObjectivePlan) now carrying the resource-review payload.
  const taskRow = db.prepare('SELECT metadata, tags FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(taskId, input.workspaceId) as { metadata: string | null; tags: string | null }
  const taskMetadata = parseMetadata(taskRow.metadata)
  taskMetadata.agentos_resource_review = {
    review_id: reviewId,
    resource_id: resourceId,
    resource_path: item.path,
    detected_state: item.detectedState,
    requested_action: 'deep-review',
    required_output_schema: DEEP_REVIEW_OUTPUT_SCHEMA,
    authoritative_registry_snapshot: reviewSequence(root, item),
    review_queue_snapshot: {
      review_id: reviewId,
      review_status: item.reviewStatus,
      recommended_action: item.recommendedAction,
      preliminary_quality_score: item.preliminaryQualityScore,
      suggested_platoon: item.suggestedPlatoon,
      suggested_specialist_role: item.suggestedSpecialistRole,
    },
    created_at: new Date().toISOString(),
    source: 'ai-arsenal',
    state: 'ROUTED',
    project_id: projectId,
    objective_id: objectiveId,
    fingerprint,
    reviewer,
  }
  taskMetadata.agentos = { ...(taskMetadata.agentos || {}), disableInference: true }
  if (routing?.selected && !taskMetadata.agentos_routing) {
    taskMetadata.agentos_routing = {
      externalAgentId: routing.selected.externalAgentId,
      agentName: routing.selected.agentName,
      platoonId: routing.selected.platoonId,
      routingAgentName: routing.selected.routingAgentName,
    }
  }
  let tags: string[] = []
  try { tags = JSON.parse(taskRow.tags || '[]') } catch { tags = [] }
  if (!tags.includes('agentos-resource-review')) tags.push('agentos-resource-review')
  db.prepare('UPDATE tasks SET metadata = ?, tags = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(taskMetadata), JSON.stringify(tags), Math.floor(Date.now() / 1000), taskId, input.workspaceId)

  const routingForQueue = routing?.selected ? {
    externalAgentId: routing.selected.externalAgentId,
    agentName: routing.selected.agentName,
    platoonId: routing.selected.platoonId,
    routingAgentName: routing.selected.routingAgentName,
  } : (taskMetadata.agentos_routing || null)

  setQueueDeepReviewState(root, reviewId, 'ROUTED', {
    requested_at: item.deepReview?.requestedAt || new Date().toISOString(),
    requested_by: item.deepReview?.requestedBy || actor,
    reviewer: reviewer || null,
    task_id: taskId,
    project_id: projectId,
    objective_id: objectiveId,
    fingerprint,
    retries: Number(item.deepReview?.retries || 0),
    routing: routingForQueue,
    routed_at: new Date().toISOString(),
  })

  db_helpers.logActivity('agentos_deep_review_routed', 'task', taskId, actor,
    `Deep-review mission ${reviewId} ${routed ? 'routed to ' + reviewer : 'created but held: ' + (reason || 'unassigned')}`,
    { review_id: reviewId, task_id: taskId, objective_id: objectiveId, routed }, input.workspaceId)

  return { taskId, reviewId, workspaceId: input.workspaceId, projectId, objectiveId, taskStatus: routed ? 'assigned' : 'inbox', routed, reason, reviewer, fingerprint }
}


// ---------------------------------------------------------------------------
// Structured output schema (Phase 5)
// ---------------------------------------------------------------------------

export function extractReviewEnvelope(text: string): string {
  const start = text.indexOf(REVIEW_ENVELOPE_START)
  const end = text.indexOf(REVIEW_ENVELOPE_END)
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start + REVIEW_ENVELOPE_START.length, end).trim()
  }
  const firstBrace = text.indexOf('{')
  if (firstBrace !== -1) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i]
      if (inString) {
        if (escape) escape = false
        else if (char === '\\') escape = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) return text.slice(firstBrace, i + 1).trim()
      }
    }
  }
  return text.trim()
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** Validate a parsed review result against agentos-resource-review-v1. */
export function validateReviewOutput(parsed: unknown, context: { reviewId: string; resourceId: string | null }): {
  ok: boolean
  value?: AgentOSResourceReviewV1
  errors: string[]
} {
  const errors: string[] = []
  if (!parsed || typeof parsed !== 'object') return { ok: false, errors: ['Result must be a JSON object'] }
  const value = parsed as Record<string, unknown>
  if (String(value.review_id || '') !== context.reviewId) errors.push(`review_id mismatch: expected ${context.reviewId}`)
  if (context.resourceId && String(value.resource_id || '') !== context.resourceId) {
    errors.push(`resource_id mismatch: expected ${context.resourceId}`)
  }
  if (String(value.review_status || '') !== 'COMPLETE') errors.push('review_status must be COMPLETE')
  if (typeof value.actual_type !== 'string' || !value.actual_type.trim()) errors.push('actual_type (string) is required')
  if (typeof value.quality_score !== 'number' || value.quality_score < 0 || value.quality_score > 100) {
    errors.push('quality_score must be a number between 0 and 100')
  }
  if (!CONFIDENCES.includes(String(value.confidence || '') as (typeof CONFIDENCES)[number])) {
    errors.push(`confidence must be one of ${CONFIDENCES.join('|')}`)
  }
  if (typeof value.primary_capability !== 'string' || !value.primary_capability.trim()) {
    errors.push('primary_capability (string) is required')
  }
  if (!AUDIT_STATUSES.includes(String(value.audit_status_recommendation || '') as (typeof AUDIT_STATUSES)[number])) {
    errors.push(`audit_status_recommendation must be one of ${AUDIT_STATUSES.join('|')}`)
  }
  if (typeof value.auto_select_recommendation !== 'boolean') errors.push('auto_select_recommendation must be boolean')
  if (typeof value.manual_only_recommendation !== 'boolean') errors.push('manual_only_recommendation must be boolean')
  if (value.manual_only_recommendation === true && value.auto_select_recommendation === true) {
    errors.push('manual_only_recommendation=true conflicts with auto_select_recommendation=true')
  }
  if (value.proposed_registry_entry !== undefined && (typeof value.proposed_registry_entry !== 'object' || value.proposed_registry_entry === null)) {
    errors.push('proposed_registry_entry must be an object')
  }
  if (errors.length > 0) return { ok: false, errors }

  const manualOnly = value.manual_only_recommendation === true
  const recommended = String(value.audit_status_recommendation || '')
  const rejectedAudit = recommended === 'REJECT-CANDIDATE' || recommended === 'ARCHIVE-CANDIDATE'
  if (manualOnly && !rejectedAudit && recommended !== 'REFERENCE') {
    errors.push('manual_only_recommendation=true requires audit_status_recommendation REFERENCE')
  }
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      review_id: String(value.review_id),
      resource_id: value.resource_id ? String(value.resource_id) : null,
      review_status: 'COMPLETE',
      actual_type: String(value.actual_type),
      quality_score: Number(value.quality_score),
      confidence: value.confidence as (typeof CONFIDENCES)[number],
      proven_capabilities: stringArray(value.proven_capabilities),
      rejected_capabilities: stringArray(value.rejected_capabilities),
      primary_capability: String(value.primary_capability),
      secondary_capabilities: stringArray(value.secondary_capabilities),
      audit_status_recommendation: recommended as (typeof AUDIT_STATUSES)[number],
      auto_select_recommendation: value.auto_select_recommendation === true,
      manual_only_recommendation: manualOnly,
      preferred_platoon: typeof value.preferred_platoon === 'string' ? value.preferred_platoon : null,
      preferred_specialist_role: typeof value.preferred_specialist_role === 'string' ? value.preferred_specialist_role : null,
      integration_mode: typeof value.integration_mode === 'string' ? value.integration_mode : null,
      runtime_requirements: stringArray(value.runtime_requirements),
      move_risk: typeof value.move_risk === 'string' ? value.move_risk : null,
      path_sensitive: value.path_sensitive === true,
      overlap_findings: stringArray(value.overlap_findings),
      supersession_findings: stringArray(value.supersession_findings),
      capability_gap_effects: stringArray(value.capability_gap_effects),
      strengths: stringArray(value.strengths),
      weaknesses: stringArray(value.weaknesses),
      evidence: stringArray(value.evidence),
      warnings: stringArray(value.warnings),
      proposed_registry_entry: value.proposed_registry_entry as Record<string, unknown> || {},
      proposed_capability_index_changes: value.proposed_capability_index_changes as Record<string, unknown> || {},
      proposed_overlap_policy_changes: value.proposed_overlap_policy_changes as Record<string, unknown> || {},
      proposed_platoon_map_changes: value.proposed_platoon_map_changes as Record<string, unknown> || {},
    },
    errors: [],
  }
}

export function parseAndValidateReviewOutput(text: string, context: { reviewId: string; resourceId: string | null }): {
  ok: boolean
  value?: AgentOSResourceReviewV1
  errors: string[]
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractReviewEnvelope(text))
  } catch {
    return { ok: false, errors: ['Review result is not valid JSON'] }
  }
  return validateReviewOutput(parsed, context)
}

// ---------------------------------------------------------------------------
// Result ingestion (Phase 7)
// ---------------------------------------------------------------------------

/** Objective id from the review block first, then the Company Commander agentos block. */
function objectiveIdOf(review: Record<string, any> | undefined, metadata: Record<string, any>): number | null {
  const fromReview = review?.objective_id
  if (typeof fromReview === 'number') return fromReview
  const fromAgentos = metadata?.agentos?.objectiveId
  return typeof fromAgentos === 'number' ? fromAgentos : null
}

function shortError(value: string): string {
  return value.length > 180 ? value.slice(0, 180) + '…' : value
}

/**
 * Phase 5/6/7 — escalate a deep-review task to NEEDS_MANUAL through the
 * generic escalation foundation: task metadata, activity trail, objective
 * mirror, and review-queue state. Idempotent per reason.
 */
function escalateDeepReview(input: {
  root: string
  workspaceId: number
  taskId: number
  reviewId: string
  objectiveId?: number | null
  delegationId?: string | null
  resourceId?: string | null
  reason: EscalationReason
  summary: string
  attempts?: number
  queueStatus?: DeepReviewStatus
  taskStatus?: DeepReviewStatus
}): void {
  const record = escalateTask({
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    reason: input.reason,
    summary: input.summary,
    objectiveId: input.objectiveId,
    delegationId: input.delegationId,
    resourceId: input.resourceId,
    attempts: input.attempts,
    actor: 'agentos',
  })
  if (input.objectiveId) syncObjectiveEscalation(input.workspaceId, input.objectiveId, record)
  // The result state (STALE / FAILED) is preserved on the review block; the
  // operational NEEDS_MANUAL state is carried by agentos_escalation.
  markTaskReviewState(getDatabase(), input.taskId, input.workspaceId, input.taskStatus || 'NEEDS_MANUAL', {
    escalated_reason: input.reason,
    escalated_at: record.created_at,
  })
  const queueStatus = input.queueStatus || 'NEEDS_MANUAL'
  try {
    setQueueDeepReviewState(input.root, input.reviewId, queueStatus, {
      escalated_reason: input.reason,
      escalated_at: record.created_at,
      escalation: record,
      error: input.summary.split('\n')[0],
    })
  } catch {
    // The queue item may have been decided concurrently — the task stays escalated.
  }
}

function markTaskReviewState(db: ReturnType<typeof getDatabase>, taskId: number, workspaceId: number, state: DeepReviewStatus, patch: Record<string, any> = {}): void {
  const row = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as { metadata: string | null } | undefined
  if (!row) return
  const metadata = parseMetadata(row.metadata)
  metadata.agentos_resource_review = {
    ...(metadata.agentos_resource_review || {}),
    state,
    ...patch,
  }
  db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(metadata), Math.floor(Date.now() / 1000), taskId, workspaceId)
}

export function ingestDeepReviewResult(input: {
  taskId: number
  workspaceId: number
  text?: string | null
  root?: string
}): DeepReviewIngestResult {
  const db = getDatabase()
  const root = input.root || config.aiVaultRoot
  const task = db.prepare('SELECT id, status, metadata FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(input.taskId, input.workspaceId) as { id: number; status: string; metadata: string | null } | undefined
  if (!task) return { status: 'TASK_NOT_FOUND' }
  const metadata = parseMetadata(task.metadata)
  const review = metadata.agentos_resource_review
  if (!review || typeof review !== 'object') return { status: 'NOT_A_REVIEW_TASK' }
  const reviewId = String(review.review_id)

  let text = input.text ?? null
  if (text === null || !text.trim()) {
    const comments = db.prepare(
      'SELECT content FROM comments WHERE task_id = ? AND workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 6',
    ).all(input.taskId, input.workspaceId) as Array<{ content: string }>
    text = comments.map(comment => comment.content).join('\n\n')
  }
  if (!text || !text.trim()) return { status: 'NO_RESULT' }

  const currentItem = getAiReviewQueue(root).find(item => item.reviewId === reviewId)
  if (!currentItem) return { status: 'QUEUE_ITEM_MISSING' }

  // Phase 9 — stale protection before any ingestion.
  const storedFingerprint = String(review.fingerprint || '')
  const fingerprintNow = computeReviewFingerprint(root, currentItem)
  if (storedFingerprint && fingerprintNow !== storedFingerprint) {
    setQueueDeepReviewState(root, reviewId, 'STALE', {
      error: 'Resource changed during review (fingerprint mismatch); result not ingested',
      stale_at: new Date().toISOString(),
    })
    markTaskReviewState(db, input.taskId, input.workspaceId, 'STALE')
    db_helpers.logActivity('agentos_deep_review_stale', 'task', input.taskId, 'agentos',
      `Deep review ${reviewId} marked STALE (resource changed during review)`, {}, input.workspaceId)
    escalateDeepReview({
      root,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      reviewId,
      objectiveId: objectiveIdOf(review, metadata),
      delegationId: metadata.agentos_delegation_id || null,
      resourceId: review.resource_id ? String(review.resource_id) : null,
      reason: 'stale_resource',
      summary: 'Resource changed during review (fingerprint mismatch); the result is not current truth',
      queueStatus: 'STALE',
      taskStatus: 'STALE',
    })
    return { status: 'STALE', reviewId }
  }

  const parsed = parseAndValidateReviewOutput(text, {
    reviewId,
    resourceId: review.resource_id ? String(review.resource_id) : null,
  })
  if (!parsed.ok || !parsed.value) {
    const errorText = parsed.errors.join('; ')
    const latestItem = getAiReviewQueue(root).find(item => item.reviewId === reviewId)
    const invalidAttempts = Number(latestItem?.deepReview?.invalidAttempts || 0) + 1
    db_helpers.logActivity('agentos_deep_review_failed', 'task', input.taskId, 'agentos',
      `Deep review ${reviewId} rejected: ${errorText}`, {}, input.workspaceId)
    if (invalidAttempts >= DEEP_REVIEW_MAX_INVALID_ATTEMPTS) {
      // Phase 6/7 — repeated invalid output exhausts the retry budget and
      // escalates to NEEDS_MANUAL instead of silently retrying forever.
      escalateDeepReview({
        root,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        reviewId,
        objectiveId: objectiveIdOf(review, metadata),
        delegationId: metadata.agentos_delegation_id || null,
        resourceId: review.resource_id ? String(review.resource_id) : null,
        reason: 'invalid_structured_output',
        summary: `Reviewer returned invalid structured output ${invalidAttempts} consecutive times: ${errorText}`,
        attempts: invalidAttempts,
      })
    } else {
      setQueueDeepReviewState(root, reviewId, 'FAILED', {
        error: errorText,
        failed_at: new Date().toISOString(),
        invalid_attempts: invalidAttempts,
      })
      markTaskReviewState(db, input.taskId, input.workspaceId, 'FAILED', { error: errorText })
    }
    return { status: 'INVALID_RESULT', reviewId, errors: parsed.errors }
  }
  const reviewValue = parsed.value

  // Phase 7 — REVIEW_COMPLETE: attach the structured proposal, do NOT auto-promote.
  setQueueDeepReviewState(root, reviewId, 'COMPLETE', {
    reviewer: metadata.agentos_resource_review.reviewer || null,
    result: reviewValue,
    proposal: {
      registry_entry: reviewValue.proposed_registry_entry,
      capability_index_changes: reviewValue.proposed_capability_index_changes,
      overlap_policy_changes: reviewValue.proposed_overlap_policy_changes,
      platoon_map_changes: reviewValue.proposed_platoon_map_changes,
    },
    review_completed_at: new Date().toISOString(),
  })
  markTaskReviewState(db, input.taskId, input.workspaceId, 'COMPLETE')
  // A valid result resolves any earlier escalation (retry lineage preserved).
  const afterRow = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(input.taskId, input.workspaceId) as { metadata: string | null }
  if (readTaskEscalation(afterRow.metadata)) {
    resolveTaskEscalation({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      actor: 'agentos',
      note: 'Deep review completed with a valid structured result',
    })
  }
  const objectiveId = objectiveIdOf(review, metadata)
  if (objectiveId) syncObjectiveEscalation(input.workspaceId, objectiveId, null)
  db_helpers.logActivity('agentos_deep_review_complete', 'task', input.taskId, 'agentos',
    `Deep review ${reviewId} complete: score ${reviewValue.quality_score}, recommendation ${reviewValue.audit_status_recommendation}`,
    { review_id: reviewId, objective_id: objectiveId }, input.workspaceId)

  return { status: 'COMPLETE', reviewId, value: reviewValue }
}

// ---------------------------------------------------------------------------
// Escalation policy (Phase 5/6/7) — retry vs escalate classification
// ---------------------------------------------------------------------------

interface EscalationDecision {
  reason?: EscalationReason
  summary?: string
  retryable?: boolean
}

/**
 * Classify a review mission's current state.
 *
 * RETRYABLE vs MANUAL_REQUIRED vs STALE vs WAITING_APPROVAL vs TERMINAL_FAILURE
 * is decided here; automation never escalates on a first transient failure.
 */
function decideEscalation(input: {
  task: { id: number; workspace_id: number; status: string; assigned_to: string | null }
  state: string
  retries: number
  invalidAttempts: number
}): EscalationDecision | null {
  const { task, state, retries, invalidAttempts } = input
  if (state === 'STALE') {
    return {
      reason: 'stale_resource',
      summary: 'Resource changed during review (fingerprint mismatch); the result is not current truth',
    }
  }
  if (state === 'FAILED') {
    if (invalidAttempts >= DEEP_REVIEW_MAX_INVALID_ATTEMPTS) {
      return {
        reason: 'invalid_structured_output',
        summary: `Reviewer returned invalid structured output ${invalidAttempts} consecutive times`,
      }
    }
    return { retryable: true, summary: 'One-off invalid review output — the retry policy still allows another attempt' }
  }
  if (state === 'NEEDS_MANUAL' && retries === 0 && invalidAttempts === 0) {
    // Queue is already escalated (e.g. inline on the invalid threshold) but the
    // task record predates escalation metadata — normalize it here.
    return { reason: 'invalid_structured_output', summary: 'Review requires manual intervention' }
  }
  if (task.status === 'failed') {
    const delegation = getLatestDelegationForTask(task.id, task.workspace_id)
    const error = String(delegation?.errorMessage || '')
    if (/not found|no such|missing|deleted|removed/i.test(error)) {
      return { reason: 'missing_resource', summary: `Reviewer could not find the resource: ${shortError(error)}` }
    }
    if (/inaccessible|permission|denied|eacces|unreadable|path/i.test(error)) {
      return { reason: 'inaccessible_resource_path', summary: `Reviewer could not access the resource path: ${shortError(error)}` }
    }
    if (retries >= DEEP_REVIEW_MAX_RETRIES) {
      return { reason: 'repeated_dispatch_failure', summary: `Dispatch/review failed after ${retries} retries` }
    }
    return { retryable: true, summary: 'Dispatch failure — retry allowed' }
  }
  if ((state === 'ROUTED' || state === 'RUNNING') && retries >= DEEP_REVIEW_MAX_RETRIES && !task.assigned_to) {
    const delegation = getLatestDelegationForTask(task.id, task.workspace_id)
    if (!delegation) {
      return { reason: 'reviewer_unavailable', summary: `No eligible reviewer after ${retries} attempts` }
    }
  }
  return null
}

/**
 * Sweep deep-review missions and apply the NEEDS_MANUAL escalation policy.
 * Runs alongside the other scheduler reconciles. Idempotent.
 */
export function applyDeepReviewEscalationPolicy(rootInput?: string): {
  escalated: Array<{ reviewId: string; taskId: number; reason: EscalationReason }>
  retryable: number
} {
  const root = rootInput || config.aiVaultRoot
  const db = getDatabase()
  const tasks = db.prepare(
    `SELECT id, workspace_id, status, assigned_to, metadata FROM tasks WHERE metadata LIKE '%"agentos_resource_review"%' ORDER BY id`,
  ).all() as Array<{ id: number; workspace_id: number; status: string; assigned_to: string | null; metadata: string | null }>

  const escalated: Array<{ reviewId: string; taskId: number; reason: EscalationReason }> = []
  let retryable = 0

  for (const task of tasks) {
    const metadata = parseMetadata(task.metadata)
    const review = metadata.agentos_resource_review
    if (!review || typeof review !== 'object') continue
    if (String(review.state || '') === 'COMPLETE') continue
    const reviewId = String(review.review_id)
    if (!reviewId) continue
    const item = getAiReviewQueue(root).find(candidate => candidate.reviewId === reviewId)
    if (!item) continue
    // Already escalated and unresolved — leave the record as-is.
    const current = readTaskEscalation(task.metadata)
    if (current) continue

    const state = String(item.deepReview?.status || '')
    const retries = Number(item.deepReview?.retries || 0)
    const invalidAttempts = Number(item.deepReview?.invalidAttempts || 0)
    const decision = decideEscalation({ task, state, retries, invalidAttempts })
    if (!decision) continue
    if (decision.retryable) {
      retryable++
      continue
    }

    escalateDeepReview({
      root,
      workspaceId: task.workspace_id,
      taskId: task.id,
      reviewId,
      objectiveId: objectiveIdOf(review, metadata),
      delegationId: metadata.agentos_delegation_id || null,
      resourceId: review.resource_id ? String(review.resource_id) : null,
      reason: decision.reason as EscalationReason,
      summary: decision.summary || 'Review requires manual intervention',
      attempts: Math.max(retries, invalidAttempts, 1),
      queueStatus: decision.reason === 'stale_resource' ? 'STALE' : 'NEEDS_MANUAL',
      taskStatus: decision.reason === 'stale_resource' ? 'STALE' : 'NEEDS_MANUAL',
    })
    escalated.push({ reviewId, taskId: task.id, reason: decision.reason as EscalationReason })
  }

  return { escalated, retryable }
}

// ---------------------------------------------------------------------------
// Reconciliation (Phase 8) — run from the scheduler alongside other reconciles
// ---------------------------------------------------------------------------

export function reconcileDeepReviewMissions(rootInput?: string): {
  ok: boolean
  message: string
  ingested: number
  stale: number
  invalid: number
  running: number
  escalated: number
  retryable: number
} {
  const root = rootInput || config.aiVaultRoot
  const db = getDatabase()
  const tasks = db.prepare(
    `SELECT id, workspace_id, metadata FROM tasks WHERE status = 'review' AND metadata LIKE '%"agentos_resource_review"%' ORDER BY id`,
  ).all() as Array<{ id: number; workspace_id: number; metadata: string | null }>

  let ingested = 0
  let stale = 0
  let invalid = 0
  let running = 0

  // Phase 8 — propagate ROUTED → RUNNING while a mission is executing.
  const inProgress = db.prepare(
    `SELECT id, workspace_id, metadata FROM tasks WHERE status = 'in_progress' AND metadata LIKE '%"agentos_resource_review"%'`,
  ).all() as Array<{ id: number; workspace_id: number; metadata: string | null }>
  for (const task of inProgress) {
    const review = parseMetadata(task.metadata).agentos_resource_review
    if (!review?.review_id) continue
    try {
      setQueueDeepReviewState(root, String(review.review_id), 'RUNNING')
      running++
    } catch {
      // queue item may have been decided in the meantime — ignore
    }
  }

  for (const task of tasks) {
    const review = parseMetadata(task.metadata).agentos_resource_review
    if (!review || !review.review_id) continue
    if (['COMPLETE', 'FAILED', 'STALE', 'NEEDS_MANUAL'].includes(String(review.state || ''))) continue
    try {
      const result = ingestDeepReviewResult({ taskId: task.id, workspaceId: task.workspace_id, root })
      if (result.status === 'COMPLETE') ingested++
      else if (result.status === 'STALE') stale++
      else if (result.status === 'INVALID_RESULT') invalid++
    } catch {
      // Keep the queue state intact; the task stays reviewable.
    }
  }
  const policy = applyDeepReviewEscalationPolicy(root)
  const parts = [
    ingested ? `${ingested} ingested` : null,
    stale ? `${stale} stale` : null,
    invalid ? `${invalid} invalid` : null,
    running ? `${running} running` : null,
    policy.escalated.length ? `${policy.escalated.length} escalated to needs-manual` : null,
    policy.retryable ? `${policy.retryable} retryable` : null,
  ].filter(Boolean)
  return {
    ok: true,
    message: parts.length ? 'Deep review reconcile: ' + parts.join(', ') : 'No deep-review results to reconcile',
    ingested,
    stale,
    invalid,
    running,
    escalated: policy.escalated.length,
    retryable: policy.retryable,
  }
}

// ---------------------------------------------------------------------------
// Retry (Phase 8)
// ---------------------------------------------------------------------------

export function retryDeepReviewMission(input: {
  reviewId: string
  workspaceId: number
  projectId?: number | null
  actor?: string | null
  root?: string
}): DeepReviewMissionResult {
  const root = input.root || config.aiVaultRoot
  catalogOf(root)
  const existing = findMissionTaskByReviewId(input.reviewId, input.workspaceId)
  if (!existing) return createDeepReviewMission({ ...input, reviewer: null })

  const db = getDatabase()
  const metadata = parseMetadata(existing.metadata)
  const item = getAiReviewQueue(root).find(candidate => candidate.reviewId === input.reviewId)
  const fingerprint = item ? computeReviewFingerprint(root, item) : String(metadata.agentos_resource_review?.fingerprint || '')
  const objectiveId = objectiveIdOf(metadata.agentos_resource_review, metadata)
  let projectId = input.projectId ?? metadata.agentos_resource_review?.project_id ?? null
  // The review objective lives in the internal operations project unless an
  // explicit active project was chosen — a retry never detaches from it.
  if (!projectId) projectId = getOrCreateAgentOSOperationsProject(input.workspaceId).id
  const now = Math.floor(Date.now() / 1000)
  const actor = input.actor || 'agentos'

  // Preserve the mission identity; drop stale routing/delegation leftovers
  // and resolve any previous NEEDS_MANUAL escalation (retry lineage kept).
  metadata.agentos_resource_review = {
    ...(metadata.agentos_resource_review || {}),
    state: 'ROUTED',
    fingerprint,
    retried_at: new Date().toISOString(),
  }
  delete metadata.agentos_routing
  delete metadata.agentos_delegation_id
  db.prepare('UPDATE tasks SET status = ?, assigned_to = NULL, resolution = NULL, outcome = NULL, metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run('inbox', JSON.stringify(metadata), now, existing.id, input.workspaceId)
  resolveTaskEscalation({
    workspaceId: input.workspaceId,
    taskId: existing.id,
    actor,
    note: `Deep review ${input.reviewId} retried`,
  })
  if (objectiveId) syncObjectiveEscalation(input.workspaceId, objectiveId, null)

  let routed = false
  let reason: string | undefined
  let reviewer: string | null = metadata.agentos_resource_review?.reviewer || null
  let routing: { externalAgentId?: string; agentName?: string; platoonId?: string; routingAgentName?: string } | null = null
  if (projectId) {
    try {
      const routeResult = routeTaskWithinProject({ taskId: existing.id, workspaceId: input.workspaceId, actor })
      routed = routeResult.routed
      if (routed && routeResult.selected) {
        reviewer = routeResult.selected.agentName || reviewer
        routing = {
          externalAgentId: routeResult.selected.externalAgentId,
          agentName: routeResult.selected.agentName,
          platoonId: routeResult.selected.platoonId,
          routingAgentName: routeResult.selected.routingAgentName,
        }
      } else {
        reason = routeResult.reason || 'No eligible reviewer yet'
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : 'Routing failed'
    }
  }

  const currentItem = item ?? getAiReviewQueue(root).find(candidate => candidate.reviewId === input.reviewId)
  const retries = Number(currentItem?.deepReview?.retries || 0) + 1
  setQueueDeepReviewState(root, input.reviewId, 'ROUTED', {
    reviewer: reviewer || null,
    task_id: existing.id,
    project_id: projectId,
    objective_id: objectiveId,
    fingerprint,
    retries,
    error: null,
    routing,
    escalated_reason: null,
    escalated_at: null,
    escalation: null,
    routed_at: new Date().toISOString(),
    retried_at: new Date().toISOString(),
  })
  db_helpers.logActivity('agentos_deep_review_retried', 'task', existing.id, actor,
    `Retried deep review ${input.reviewId}${routed ? ' routed to ' + reviewer : ' (held)'}`,
    { review_id: input.reviewId, objective_id: objectiveId, retries }, input.workspaceId)

  return { taskId: existing.id, reviewId: input.reviewId, workspaceId: input.workspaceId, projectId, objectiveId, taskStatus: routed ? 'assigned' : 'inbox', routed, reason, reviewer, fingerprint }
}

// ---------------------------------------------------------------------------
// Traceability (Phase 10) — review queue item → task → delegation
// ---------------------------------------------------------------------------

export interface DeepReviewMissionTrace {
  taskId: number
  reviewId: string
  title: string
  status: string
  assignedTo: string | null
  projectId: number | null
  objectiveId: number | null
  createdAt: number
  updatedAt: number
  reviewState: string | null
  fingerprint: string | null
  escalation: {
    reason: string | null
    category: string | null
    attempts: number | null
    summary: string | null
    recommendedActions: string[]
  } | null
  delegation: {
    id: string | null
    status: string | null
    nativeSessionId: string | null
    nativeRunId: string | null
    attempt: number | null
    runtimeType: string | null
    platoonId: string | null
    specialistName: string | null
    errorMessage: string | null
  } | null
}

export function listDeepReviewMissions(workspaceId: number, projectId?: number | null): DeepReviewMissionTrace[] {
  const db = getDatabase()
  const rows = db.prepare(
    `SELECT id, title, status, assigned_to, project_id, created_at, updated_at, metadata
     FROM tasks WHERE workspace_id = ? ${projectId ? 'AND project_id = ?' : ''}
     AND metadata LIKE '%"agentos_resource_review"%' ORDER BY id DESC LIMIT 100`,
  ).all(projectId ? [workspaceId, projectId] : [workspaceId]) as any[]
  return rows.map(row => {
    const meta = parseMetadata(row.metadata)
    const review = meta.agentos_resource_review || {}
    const delegation = getLatestDelegationForTask(row.id, workspaceId)
    const escalation = readTaskEscalation(row.metadata)
    return {
      taskId: row.id,
      reviewId: String(review.review_id || ''),
      title: row.title,
      status: row.status,
      assignedTo: row.assigned_to || null,
      projectId: row.project_id ?? null,
      objectiveId: objectiveIdOf(review, meta),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reviewState: review.state ? String(review.state) : null,
      fingerprint: review.fingerprint ? String(review.fingerprint) : null,
      escalation: escalation ? {
        reason: escalation.reason,
        category: escalation.category,
        attempts: escalation.attempts,
        summary: escalation.summary,
        recommendedActions: escalation.recommended_actions,
      } : null,
      delegation: delegation ? {
        id: delegation.id,
        status: delegation.status,
        nativeSessionId: delegation.nativeSessionId,
        nativeRunId: delegation.nativeRunId,
        attempt: delegation.attempt,
        runtimeType: delegation.runtimeType,
        platoonId: delegation.platoonId,
        specialistName: delegation.specialistName,
        errorMessage: delegation.errorMessage,
      } : null,
    }
  })
}