import fs from 'node:fs'
import path from 'node:path'
import { getDatabase, db_helpers } from './db'
import { config } from './config'
import { getAiResourceRegistry, recommendAiResources, type AiResourceRecord } from './ai-resource-registry'
import { routeTaskWithinProject } from './project-task-routing'
import { getLatestDelegationForTask, getDelegation } from './delegation-ledger'
import { createObjectivePlan, promoteReadyObjectiveMissions } from './objective-planning'
import { getOrCreateAgentOSOperationsProject } from './agentos-operations'
import { mayAgentosLifecycleAdvance } from './project-command'
import {
  escalateTask,
  readTaskEscalation,
  resolveTaskEscalation,
  syncObjectiveEscalation,
  type EscalationReason,
} from './agentos-escalation'

/**
 * AgentOS knowledge curation — the first Company Commander proof using the
 * full objective → mission graph → routing → delegation → result → follow-on
 * stack on REAL generated artifacts.
 *
 * A designated internal AgentOS objective ("Build Tactical Encounter Knowledge
 * Pack Suite") decomposes into five independent curation missions (M1–M5) plus
 * a validation/integration mission (M6) that depends on all five. Each mission
 * is a normal objective mission task routed through the standard specialist
 * selector with knowledge-curation + domain capability requirements and the
 * approved AI Arsenal source-resource policy attached. Validated pack results
 * are staged under 00_INBOX/generated-knowledge (scan-visible); only a passing
 * M6 finalizes them into the Knowledge Packets output directory with a
 * manifest. Nothing is auto-promoted and the vault scanner is never run by
 * AgentOS — the generated suite is discovered as NEW by the next scan.
 */

export const KNOWLEDGE_CURATION_CAPABILITY = 'knowledge-curation'
export const KNOWLEDGE_PACK_OUTPUT_SCHEMA = 'agentos-knowledge-pack-v1'
export const KNOWLEDGE_VALIDATION_OUTPUT_SCHEMA = 'agentos-knowledge-validation-v1'
export const PACK_ENVELOPE_START = '---AGENTOS_KNOWLEDGE_PACK_START---'
export const PACK_ENVELOPE_END = '---AGENTOS_KNOWLEDGE_PACK_END---'
export const VALIDATION_ENVELOPE_START = '---AGENTOS_KNOWLEDGE_VALIDATION_START---'
export const VALIDATION_ENVELOPE_END = '---AGENTOS_KNOWLEDGE_VALIDATION_END---'

export const KNOWLEDGE_SUITE_ID = 'kp-suite-tactical-encounters'
export const KNOWLEDGE_SUITE_TITLE = 'Build Tactical Encounter Knowledge Pack Suite'
export const KNOWLEDGE_SUITE_DESCRIPTION =
  'AgentOS must curate five approved tactical-encounter knowledge packs from approved AI Arsenal source resources ' +
  '(Wesnoth as the preferred automatic source; OXCE as an explicitly selected manual/reference source), stage them, ' +
  'validate the suite, and register the generated packs for review through the normal vault lifecycle.'

/** Repeated invalid-output threshold before automation escalates to NEEDS_MANUAL. */
export const KNOWLEDGE_MAX_INVALID_ATTEMPTS = 2

/** Content validation limits (defense against wholesale source reproduction). */
export const KNOWLEDGE_MAX_VERBATIM_RATIO = 0.4
export const KNOWLEDGE_MIN_CONTENT_CHARS = 400

export const KNOWLEDGE_MISSION_STATES = [
  'ROUTED',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'NEEDS_MANUAL',
] as const
export type KnowledgeMissionStatus = (typeof KNOWLEDGE_MISSION_STATES)[number]

export interface KnowledgePackSpec {
  key: string
  packId: string
  missionTitle: string
  file: string
  requiredCapabilities: string[]
  preferredCapabilities: string[]
  /** Approved resources to attach as explicit manual/reference selections for this pack. */
  referenceResourceIds: string[]
  coverage: string
}

export const KNOWLEDGE_PACK_SPECS: KnowledgePackSpec[] = [
  {
    key: 'm1',
    packId: 'kp-tactical-encounter-design-patterns',
    missionTitle: 'Curate: tactical-encounter-design-patterns',
    file: 'tactical-encounter-design-patterns.md',
    // The REQUIRED execution role is knowledge-curation. Domain expertise is
    // PREFERRED, never required: a general curator must be routable for any
    // pack — the domain comes from approved Arsenal resources (Wesnoth/OXCE)
    // and preferred-capability scoring, not from the curator pretending to be
    // a tactical implementation specialist.
    requiredCapabilities: [KNOWLEDGE_CURATION_CAPABILITY],
    preferredCapabilities: ['tactical-encounters', 'architecture', 'game-development', 'narrative-content'],
    referenceResourceIds: ['res-tactical-oxce-reference'],
    coverage: [
      'encounter lifecycle', 'setup', 'tactical state', 'victory/defeat', 'map/scenario boundaries',
      'turn model', 'encounter progression', 'reinforcement patterns', 'extraction/evacuation patterns',
      'difficulty/balancing inputs', 'encounter orchestration',
    ].join(', '),
  },
  {
    key: 'm2',
    packId: 'kp-deployment-and-spawn-schemas',
    missionTitle: 'Curate: deployment-and-spawn-schemas',
    file: 'deployment-and-spawn-schemas.md',
    requiredCapabilities: [KNOWLEDGE_CURATION_CAPABILITY],
    preferredCapabilities: ['tactical-encounters', 'game-development', 'turn-state-engine', 'save-data-tools'],
    referenceResourceIds: ['res-tactical-oxce-reference', 'res-tactical-boardgame-io'],
    coverage: [
      'player deployment', 'enemy deployment', 'deployment zones', 'start locations', 'spawn tables',
      'waves', 'reinforcements', 'faction/side definitions', 'entry points', 'spawn conditions',
      'placement constraints', 'mission initialization',
    ].join(', '),
  },
  {
    key: 'm3',
    packId: 'kp-terrain-and-movement-models',
    missionTitle: 'Curate: terrain-and-movement-models',
    file: 'terrain-and-movement-models.md',
    requiredCapabilities: [KNOWLEDGE_CURATION_CAPABILITY],
    preferredCapabilities: ['tactical-encounters', 'game-development', 'architecture', 'combat-systems'],
    referenceResourceIds: ['res-tactical-oxce-reference'],
    coverage: [
      'grids/hexes', 'movement costs', 'terrain modifiers', 'blocked tiles', 'traversal', 'pathing',
      'LOS where supported', 'elevation where supported', 'cover where supported', 'map metadata',
      'tactical movement constraints',
    ].join(', '),
  },
  {
    key: 'm4',
    packId: 'kp-scenario-objective-patterns',
    missionTitle: 'Curate: scenario-objective-patterns',
    file: 'scenario-objective-patterns.md',
    requiredCapabilities: [KNOWLEDGE_CURATION_CAPABILITY],
    preferredCapabilities: ['tactical-encounters', 'narrative-content', 'architecture', 'game-development'],
    referenceResourceIds: ['res-tactical-oxce-reference'],
    coverage: [
      'scenario definitions', 'objectives', 'optional objectives', 'victory', 'defeat', 'turn limits',
      'scripted events', 'state transitions', 'triggers', 'reinforcements', 'campaign/mission chaining',
      'success/failure outcomes',
    ].join(', '),
  },
  {
    key: 'm5',
    packId: 'kp-tactical-ai-reference',
    missionTitle: 'Curate: tactical-ai-reference',
    file: 'tactical-ai-reference.md',
    requiredCapabilities: [KNOWLEDGE_CURATION_CAPABILITY],
    preferredCapabilities: ['tactical-encounters', 'enemy-ai', 'game-development', 'architecture'],
    referenceResourceIds: ['res-tactical-oxce-reference'],
    coverage: [
      'tactical decision layers', 'movement/positioning', 'target selection', 'threat evaluation',
      'action economy', 'scenario-aware AI', 'tactical goals', 'reinforcement behavior',
      'retreat/extraction behavior where supported', 'state/context inputs', 'AI integration points',
    ].join(', '),
  },
  {
    key: 'm6',
    packId: 'kp-suite-validation',
    missionTitle: 'Validate Tactical Knowledge Pack Suite',
    file: 'suite-validation-report.md',
    requiredCapabilities: [KNOWLEDGE_CURATION_CAPABILITY],
    preferredCapabilities: ['testing-review', 'qa-release', 'knowledge-management', 'architecture'],
    referenceResourceIds: [],
    coverage: [
      'format consistency', 'no unsupported claims', 'no large copyrighted source reproduction',
      'internal cross-links', 'source/resource attribution', 'coverage gaps', 'AgentOS usability',
    ].join(', '),
  },
]

const PACK_BY_KEY = new Map(KNOWLEDGE_PACK_SPECS.map(spec => [spec.key, spec]))
const PACK_BY_ID = new Map(KNOWLEDGE_PACK_SPECS.map(spec => [spec.packId, spec]))
export const CURATION_PACK_KEYS = KNOWLEDGE_PACK_SPECS.slice(0, 5).map(spec => spec.key)
export const VALIDATION_PACK_KEY = 'm6'

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function parseMetadata(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function resolveVaultPath(root: string, target: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, '')
  if (path.isAbsolute(target)) {
    const normalizedTarget = target.replace(/[\\/]+$/, '')
    if (normalizedTarget.toLowerCase() === normalizedRoot.toLowerCase() ||
        normalizedTarget.toLowerCase().startsWith(normalizedRoot.toLowerCase() + path.sep)) {
      return normalizedTarget
    }
    // Absolute path outside the vault (e.g. a D:\\AI mirror while AgentOS runs
    // against a different vault root): AgentOS cannot verify real access, so
    // resolve it as a vault-relative path for the claim check.
    return path.join(root, target.replace(/^[A-Za-z]:[\\/]+/, '').replace(/^[\\/]+/, ''))
  }
  return path.join(root, target)
}

function catalogOf(root: string): string {
  if (!root || !fs.existsSync(root)) throw new Error('AI vault root does not exist: ' + root)
  const catalog = path.join(root, '_CATALOG')
  if (!fs.existsSync(catalog)) throw new Error('AI vault catalog does not exist: ' + catalog)
  return catalog
}

/** Default scan-visible staging container: D:/AI/00_INBOX/generated-knowledge */
export function defaultStagingDir(root: string): string {
  return path.join(root, '00_INBOX', 'generated-knowledge')
}

/** Default final output directory: D:/AI/Knowledge Packets/Tactical Encounters */
export function defaultOutputDir(root: string): string {
  return path.join(root, 'Knowledge Packets', 'Tactical Encounters')
}

// ---------------------------------------------------------------------------
// Source-resource policy (Phase 5)
// ---------------------------------------------------------------------------

export interface KnowledgeSourceAttachment {
  resource_id: string
  name: string
  type: string | null
  path: string
  score: number | null
  audit_status: string | null
  capabilities: string[]
  primary_capability: string | null
  usage: string
  preferred_platoon: string | null
  preferred_specialist_role: string | null
  integration_mode: string | null
  runtime_requirements: string[]
  authoritative: boolean
  /** Manual/reference-only resources are never auto-selected; they appear only when explicitly allowed. */
  manual_only: boolean
  explicitly_selected: boolean
}

function toSourceAttachment(resource: AiResourceRecord, usage: string, explicitlySelected: boolean): KnowledgeSourceAttachment {
  return {
    resource_id: resource.id,
    name: resource.name,
    type: resource.type || null,
    path: resource.path,
    score: resource.score,
    audit_status: resource.auditStatus || resource.status || null,
    capabilities: resource.capabilities,
    primary_capability: resource.primaryCapability || null,
    usage,
    preferred_platoon: resource.preferredPlatoon || null,
    preferred_specialist_role: resource.preferredSpecialistRole || null,
    integration_mode: resource.integrationMode || null,
    runtime_requirements: resource.runtimeRequirements || [],
    authoritative: resource.authoritative === true,
    manual_only: resource.manualOnly === true || resource.autoSelectAllowed === false,
    explicitly_selected: explicitlySelected,
  }
}

/**
 * Attach the best approved sources for a mission.
 *
 * Auto-selection goes through the real Arsenal policy (recommendAiResources:
 * audit status, quality score, capability match — REJECT/archive/manual-only
 * are never auto-selected). Manual/reference resources such as OXCE may only
 * be attached through an explicit objective-level allowlist and keep their
 * manual_only flag — the global gate is never weakened. Unapproved/REJECT
 * resources can never be attached at all.
 */
export function chooseSourceAttachments(
  capabilities: string[],
  root: string,
  options: { referenceResourceIds?: string[] } = {},
): KnowledgeSourceAttachment[] {
  const registry = getAiResourceRegistry(root)
  const byId = new Map(registry.resources.map(resource => [resource.id, resource]))
  const seen = new Set<string>()
  const attachments: KnowledgeSourceAttachment[] = []

  const auto = recommendAiResources(capabilities, 8, root)
  for (const resource of auto) {
    if (seen.has(resource.id)) continue
    seen.add(resource.id)
    attachments.push(toSourceAttachment(resource, 'preferred', false))
  }

  for (const resourceId of options.referenceResourceIds || []) {
    const resource = byId.get(resourceId)
    if (!resource) continue
    if (seen.has(resource.id)) continue
    if (resource.auditStatus && String(resource.auditStatus).toUpperCase().startsWith('REJECT')) continue
    seen.add(resource.id)
    attachments.push(toSourceAttachment(resource, resource.manualOnly ? 'reference-only' : 'supporting', true))
  }

  return attachments
}

export function choosePackSourceAttachments(spec: KnowledgePackSpec, root: string): KnowledgeSourceAttachment[] {
  return chooseSourceAttachments([...spec.requiredCapabilities, ...spec.preferredCapabilities], root, {
    referenceResourceIds: spec.referenceResourceIds,
  })
}

// ---------------------------------------------------------------------------
// Objective + mission creation (Phases 2–4)
// ---------------------------------------------------------------------------

function packBrief(spec: KnowledgePackSpec, schema: string, envelopeStart: string, envelopeEnd: string): string {
  const sources = spec.referenceResourceIds.length
    ? `References allowed by objective (manual/reference only — never auto): ${spec.referenceResourceIds.join(', ')}.`
    : ''
  const rules = spec.key === 'm6'
    ? [
        'Read the five staged knowledge packs (do not modify them).',
        'Verify format consistency, internal cross-links, source/resource attribution and coverage gaps.',
        'Verify no unsupported claims and no large verbatim source reproduction.',
        'Verify the packs are usable by AgentOS specialists.',
      ]
    : [
        'Cover: ' + spec.coverage + '.',
        'Use ONLY the approved AgentOS source resources attached to this mission.',
        'Do NOT claim to use a resource the runtime cannot actually access — report access limitations instead.',
        'Do NOT auto-use manual-only/reference resources (OXCE) as if they were automatic runtime dependencies.',
        'Do NOT reproduce large verbatim source excerpts — prefer summaries, schemas, text diagrams and pseudocode.',
        'Clearly separate implemented/verified source behavior from recommended generalized patterns.',
      ]
  return [
    `AgentOS knowledge-curation mission (${spec.key}). Produce pack ${spec.packId}.`,
    ...rules,
    sources,
    'Output ONLY the structured result in the required envelope:',
    envelopeStart,
    `{ "schema": "${schema}", "pack_id": "${spec.packId}", ... }`,
    envelopeEnd,
    `Invalid JSON, a mismatched pack_id, or content that violates the source/limitation rules will be rejected.`,
  ].join('\n')
}

function findObjectiveBySuite(workspaceId: number, suiteId: string): { objectiveId: number } | null {
  const db = getDatabase()
  const rows = db.prepare(
    `SELECT id, plan_json FROM agentos_objectives
     WHERE workspace_id = ? AND plan_json LIKE '%"agentos_knowledge_suite"%' ORDER BY id DESC LIMIT 20`,
  ).all(workspaceId) as Array<{ id: number; plan_json: string }>
  for (const row of rows) {
    try {
      const plan = JSON.parse(row.plan_json)
      if (plan.agentos_knowledge_suite?.suite_id === suiteId) return { objectiveId: row.id }
    } catch {
      // malformed plan — skip
    }
  }
  return null
}

function findMissionTaskByPackId(packId: string, workspaceId: number): { id: number; metadata: string | null } | null {
  const db = getDatabase()
  const row = db.prepare(
    'SELECT id, metadata FROM tasks WHERE workspace_id = ? AND metadata LIKE ? ORDER BY id DESC LIMIT 1',
  ).get(workspaceId, `%\"agentos_knowledge_curation\"%\"pack_id\":\"${packId}\"%`) as { id: number; metadata: string | null } | undefined
  if (!row) return null
  const meta = parseMetadata(row.metadata)
  if (meta.agentos_knowledge_curation?.pack_id !== packId) return null
  return row
}

export interface KnowledgeSuiteMission {
  key: string
  packId: string
  taskId: number
  dependsOnKeys: string[]
}

export interface KnowledgeSuiteCreation {
  suiteId: string
  objectiveId: number
  projectId: number
  workspaceId: number
  status: string
  missions: KnowledgeSuiteMission[]
  stagingDir: string
  outputDir: string
}

/**
 * Create the real AgentOS objective for the tactical knowledge-pack suite:
 * five independent curation missions (M1–M5) plus M6 (validation) that depends
 * on all five. Lives in the AgentOS Operations internal project (or an
 * explicitly chosen active project — manual authority). One objective per
 * suite; duplicate creation is refused.
 */
export function createKnowledgeSuiteObjective(input: {
  workspaceId: number
  projectId?: number | null
  actor?: string | null
  root?: string
  stagingDir?: string
  outputDir?: string
}): KnowledgeSuiteCreation {
  const root = input.root || config.aiVaultRoot
  catalogOf(root)
  const workspaceId = input.workspaceId
  const existing = findObjectiveBySuite(workspaceId, KNOWLEDGE_SUITE_ID)
  if (existing) {
    const row = getDatabase().prepare('SELECT status FROM agentos_objectives WHERE id = ? AND workspace_id = ?')
      .get(existing.objectiveId, workspaceId) as { status: string }
    throw new Error(`Knowledge suite objective already exists (objective ${existing.objectiveId}, status ${row.status})`)
  }

  const db = getDatabase()
  let projectId: number | null = null
  if (input.projectId) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND status = ?')
      .get(input.projectId, workspaceId, 'active') as { id: number } | undefined
    if (project) projectId = project.id
  }
  if (!projectId) projectId = getOrCreateAgentOSOperationsProject(workspaceId).id

  const actor = input.actor || 'agentos'
  const stagingDir = input.stagingDir || defaultStagingDir(root)
  const outputDir = input.outputDir || defaultOutputDir(root)

  const missions = KNOWLEDGE_PACK_SPECS.map(spec => {
    const schema = spec.key === VALIDATION_PACK_KEY ? KNOWLEDGE_VALIDATION_OUTPUT_SCHEMA : KNOWLEDGE_PACK_OUTPUT_SCHEMA
    const envelope = spec.key === VALIDATION_PACK_KEY
      ? [VALIDATION_ENVELOPE_START, VALIDATION_ENVELOPE_END]
      : [PACK_ENVELOPE_START, PACK_ENVELOPE_END]
    return {
      key: spec.key,
      title: spec.missionTitle,
      description: packBrief(spec, schema, envelope[0], envelope[1]),
      dependsOn: spec.key === VALIDATION_PACK_KEY ? CURATION_PACK_KEYS : [],
      requiredCapabilities: spec.requiredCapabilities,
      preferredCapabilities: spec.preferredCapabilities,
    }
  })

  const created = createObjectivePlan({
    projectId,
    workspaceId,
    title: KNOWLEDGE_SUITE_TITLE,
    description: KNOWLEDGE_SUITE_DESCRIPTION,
    actor,
    missions,
  })

  const objectiveId = created.objectiveId
  const now = Math.floor(Date.now() / 1000)

  const createdMissionKeys = new Map<string, { taskId: number; dependsOnKeys: string[] }>()
  for (const mission of created.missions) {
    const spec = PACK_BY_KEY.get(mission.key)
    if (!spec) continue
    createdMissionKeys.set(mission.key, { taskId: mission.taskId, dependsOnKeys: mission.dependsOnKeys })
  }

  // Per-mission curation contract + curated source attachments.
  for (const spec of KNOWLEDGE_PACK_SPECS) {
    const taskId = createdMissionKeys.get(spec.key)?.taskId
    if (!taskId) throw new Error('Missing mission task for ' + spec.key)
    const taskRow = db.prepare('SELECT metadata, tags FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(taskId, workspaceId) as { metadata: string | null; tags: string | null }
    const metadata = parseMetadata(taskRow.metadata)
    const attachments = choosePackSourceAttachments(spec, root)
    const schema = spec.key === VALIDATION_PACK_KEY ? KNOWLEDGE_VALIDATION_OUTPUT_SCHEMA : KNOWLEDGE_PACK_OUTPUT_SCHEMA
    metadata.agentos_knowledge_curation = {
      suite_id: KNOWLEDGE_SUITE_ID,
      pack_id: spec.packId,
      mission_key: spec.key,
      file: spec.file,
      schema,
      state: 'ROUTED',
      created_at: new Date().toISOString(),
      task_id: taskId,
      objective_id: objectiveId,
      project_id: projectId,
      attachments,
      source_resource_ids: attachments.map(attachment => attachment.resource_id),
      staging_dir: stagingDir,
      output_dir: outputDir,
    }
    // Canonical agentos_resources metadata (merged with the router's own picks)
    // so the native prompt lists these approved sources with the manual flag.
    const merged = [...(metadata.agentos_resources || [])]
    for (const attachment of attachments) {
      if (merged.some((entry: Record<string, unknown>) => entry.resource_id === attachment.resource_id)) continue
      merged.push({
        resource_id: attachment.resource_id,
        name: attachment.name,
        type: attachment.type,
        path: attachment.path,
        score: attachment.score,
        audit_status: attachment.audit_status,
        capabilities: attachment.capabilities,
        usage: attachment.usage,
        preferred_platoon: attachment.preferred_platoon,
        preferred_specialist_role: attachment.preferred_specialist_role,
        integration_mode: attachment.integration_mode,
        runtime_requirements: attachment.runtime_requirements,
        authoritative: attachment.authoritative,
        manual_only: attachment.manual_only,
        explicitly_selected: attachment.explicitly_selected,
      })
    }
    metadata.agentos_resources = merged
    let tags: string[] = []
    try { tags = JSON.parse(taskRow.tags || '[]') } catch { tags = [] }
    if (!tags.includes('agentos-knowledge-curation')) tags.push('agentos-knowledge-curation')
    db.prepare('UPDATE tasks SET metadata = ?, tags = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run(JSON.stringify(metadata), JSON.stringify(tags), now, taskId, workspaceId)
    db_helpers.logActivity('agentos_knowledge_mission_created', 'task', taskId, actor,
      `Created knowledge-curation mission ${spec.key} (${spec.packId})`,
      { objective_id: objectiveId, pack_id: spec.packId, source_resource_ids: spec.referenceResourceIds },
      workspaceId,
    )
  }

  // Suite marker on the objective plan.
  const planRow = db.prepare('SELECT plan_json FROM agentos_objectives WHERE id = ? AND workspace_id = ?')
    .get(objectiveId, workspaceId) as { plan_json: string }
  let plan: Record<string, any> = {}
  try { plan = JSON.parse(planRow.plan_json || '{}') } catch { plan = {} }
  plan.agentos_knowledge_suite = {
    suite_id: KNOWLEDGE_SUITE_ID,
    title: KNOWLEDGE_SUITE_TITLE,
    state: 'PLANNED',
    staging_dir: stagingDir,
    output_dir: outputDir,
    packs: KNOWLEDGE_PACK_SPECS.map(spec => ({
      key: spec.key,
      pack_id: spec.packId,
      file: spec.file,
      mission_key: spec.key,
      required_capabilities: spec.requiredCapabilities,
      preferred_capabilities: spec.preferredCapabilities,
      source_resource_ids: spec.referenceResourceIds,
    })),
    missions: [...createdMissionKeys.entries()].map(([key, value]) => ({ key, task_id: value.taskId, depends_on_keys: value.dependsOnKeys })),
    created_at: new Date().toISOString(),
    created_by: actor,
  }
  db.prepare('UPDATE agentos_objectives SET plan_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(plan), now, objectiveId, workspaceId)
  db_helpers.logActivity('agentos_knowledge_suite_planned', 'project', projectId, actor,
    `AgentOS planned knowledge suite ${KNOWLEDGE_SUITE_ID} (${KNOWLEDGE_PACK_SPECS.length} missions)`,
    { objective_id: objectiveId, suite_id: KNOWLEDGE_SUITE_ID },
    workspaceId,
  )

  return {
    suiteId: KNOWLEDGE_SUITE_ID,
    objectiveId,
    projectId,
    workspaceId,
    status: 'planned',
    missions: [...createdMissionKeys.entries()].map(([key, value]) => ({
      key,
      packId: PACK_BY_KEY.get(key)?.packId || key,
      taskId: value.taskId,
      dependsOnKeys: value.dependsOnKeys,
    })),
    stagingDir,
    outputDir,
  }
}

// ---------------------------------------------------------------------------
// Factual claim + verbatim-source validation (Phase 7/13)
// ---------------------------------------------------------------------------

export interface ClaimRule {
  label: string
  subject: RegExp
  capability: RegExp
  message: string
}

/**
 * Authoritative-limitation guard for the tactical suite. These assertions are
 * about the AUDITED facts of the approved resources — a curated pack must not
 * claim capabilities the authority explicitly denies.
 */
export const TACTICAL_CLAIM_RULES: ClaimRule[] = [
  {
    label: 'wesnoth-cover-elevation-los',
    subject: /wesnoth/i,
    capability: /\b(cover|elevation|line[- ]of[- ]sight|\blos\b)\b/i,
    message: 'Claims Wesnoth provides true cover/elevation/LOS — the authoritative audit says hex-based with NO true cover/elevation/LOS',
  },
  {
    label: 'oxce-auto-runtime',
    subject: /\boxce\b|openxcom/i,
    capability: /(auto[- ]?select|automatic|runtime dependen|drop[- ]?in|default (engine|provider)|automatic (runtime|provider|dependency))/i,
    message: 'Claims OXCE is an automatic runtime dependency — OXCE is REFERENCE/manual-only and never an automatic runtime dependency',
  },
  {
    label: 'boardgame-io-tactical-provider',
    subject: /boardgame/,
    capability: /(tactical[- ]encounters|encounter provider|map|terrain|deployment probe)/i,
    message: 'Confuses boardgame.io with a tactical-encounters provider — boardgame.io is a turn-state-engine supporting library, NOT a tactical-encounters provider',
  },
]

/**
 * Sentence-level scan: does this sentence ASSERT the subject has the capability?
 * Only text BEFORE the capability word may negate it ("Wesnoth does not provide
 * cover") — trailing context like "no other engine is needed" does not.
 */
const NEGATION_BEFORE_CAPABILITY = /\b(?:no|not|never|without|lacks?|missing|unavailable|unable|beyond|excludes?|doesn'?t|isn'?t|can'?t|cannot|don'?t)\b/i
function assertsCapability(sentence: string, subject: RegExp, capability: RegExp): boolean {
  const subjectMatch = sentence.match(subject)
  const capabilityMatch = sentence.match(capability)
  if (!subjectMatch?.[0] || !capabilityMatch?.[0]) return false
  if (capabilityMatch.index === undefined) return false
  const before = sentence.slice(Math.max(0, capabilityMatch.index - 90), capabilityMatch.index)
  return !NEGATION_BEFORE_CAPABILITY.test(before)
}

/** Returns violation messages for the pack content against authoritative claim rules. */
export function findClaimViolations(contentMarkdown: string, rules: ClaimRule[] = TACTICAL_CLAIM_RULES): string[] {
  const sentences = contentMarkdown
    .split(/\r?\n/)
    .map(line => line.replace(/^#{1,6}\s*/, ''))
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim().toLowerCase())
    .filter(Boolean)
  const violations: string[] = []
  for (const rule of rules) {
    for (const sentence of sentences) {
      if (assertsCapability(sentence, rule.subject, rule.capability)) {
        violations.push(rule.message)
        break
      }
    }
  }
  return [...new Set(violations)]
}

/** Rough verbatim-source guard: fraction of content inside code fences / indented blocks. */
export function verbatimCodeRatio(markdown: string): number {
  const lines = markdown.split(/\r?\n/)
  const total = lines.filter(line => line.trim().length > 0).length
  if (total === 0) return 0
  let fenced = 0
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence || /^( {4}|\t)/.test(line)) fenced++
  }
  return fenced / total
}

// ---------------------------------------------------------------------------
// Structured output schemas (Phase 6)
// ---------------------------------------------------------------------------

export interface KnowledgeSourceClaim {
  resource_id: string
  accessed: boolean
  usage?: string
  notes?: string
}

export interface AgentOSKnowledgePackV1 {
  schema: string
  pack_id: string
  title: string
  purpose: string
  capabilities: string[]
  intended_specialist_roles: string[]
  source_claims: KnowledgeSourceClaim[]
  content_markdown: string
  provenance: {
    reviewed_sources: string[]
    generated_by: string
  }
  limitations: string[]
  warnings: string[]
}

export interface KnowledgePackVerdict {
  pack_id: string
  verdict: 'PASS' | 'FAIL' | 'WARN'
  issues: string[]
}

export interface AgentOSKnowledgeValidationV1 {
  schema: string
  suite_id: string
  suite_verdict: 'PASS' | 'FAIL' | 'WARN'
  per_pack_verdicts: KnowledgePackVerdict[]
  report_markdown: string
  warnings: string[]
}

export function extractKnowledgeEnvelope(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start)
  const endIndex = text.indexOf(end)
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    return text.slice(startIndex + start.length, endIndex).trim()
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

export interface PackValidationContext {
  packId: string
  suiteId: string
  attachments: KnowledgeSourceAttachment[]
  root: string
  claimRules?: ClaimRule[]
}

/**
 * Validate a pack result against agentos-knowledge-pack-v1. Checks schema /
 * pack identity, structured fields, source-claim policy (only approved source
 * ids; no inaccessible-access claims), authoritative factual limits, and
 * verbatim-source reproduction.
 */
export function validateKnowledgePackOutput(
  parsed: unknown,
  context: PackValidationContext,
): { ok: boolean; value?: AgentOSKnowledgePackV1; errors: string[] } {
  const errors: string[] = []
  if (!parsed || typeof parsed !== 'object') return { ok: false, errors: ['Result must be a JSON object'] }
  const value = parsed as Record<string, unknown>
  if (String(value.schema || '') !== KNOWLEDGE_PACK_OUTPUT_SCHEMA) errors.push(`schema must be ${KNOWLEDGE_PACK_OUTPUT_SCHEMA}`)
  if (String(value.pack_id || '') !== context.packId) errors.push(`pack_id mismatch: expected ${context.packId}`)
  if (typeof value.title !== 'string' || !value.title.trim()) errors.push('title (string) is required')
  if (typeof value.purpose !== 'string' || !value.purpose.trim()) errors.push('purpose (string) is required')
  if (typeof value.content_markdown !== 'string' || value.content_markdown.trim().length < KNOWLEDGE_MIN_CONTENT_CHARS) {
    errors.push(`content_markdown must be at least ${KNOWLEDGE_MIN_CONTENT_CHARS} characters of original prose`)
  }
  const provenance = value.provenance
  if (!provenance || typeof provenance !== 'object') {
    errors.push('provenance (object with reviewed_sources) is required')
  } else {
    const reviewed = stringArray((provenance as Record<string, unknown>).reviewed_sources)
    if (reviewed.length === 0) errors.push('provenance.reviewed_sources must list the files/sources actually examined')
    if (typeof (provenance as Record<string, unknown>).generated_by !== 'string' || !String((provenance as Record<string, unknown>).generated_by).trim()) {
      errors.push('provenance.generated_by (reviewer identity) is required')
    }
  }
  if (!Array.isArray(value.limitations)) errors.push('limitations must be an array')
  if (errors.length > 0) return { ok: false, errors }

  // Source-claim policy: approved ids only; manual/reference never auto; no inaccessible-access claims.
  const allowedIds = new Set(context.attachments.map(attachment => attachment.resource_id))
  const byId = new Map(context.attachments.map(attachment => [attachment.resource_id, attachment]))
  const claims = Array.isArray(value.source_claims) ? value.source_claims : []
  if (claims.length === 0) {
    errors.push('source_claims must list which approved sources the pack draws on')
    return { ok: false, errors }
  }
  for (const rawClaim of claims) {
    const claim = (rawClaim && typeof rawClaim === 'object' ? rawClaim : {}) as Record<string, unknown>
    const resourceId = String(claim.resource_id || '')
    if (!allowedIds.has(resourceId)) {
      errors.push(`source_claim ${resourceId || '(empty)'} is not an approved attachment for this mission`)
      continue
    }
    const attachment = byId.get(resourceId)!
    if (attachment.manual_only && claim.usage === 'preferred') {
      errors.push(`manual-only source ${resourceId} cannot be claimed as a preferred/automatic source`)
    }
    if (claim.accessed === true) {
      const full = resolveVaultPath(context.root, attachment.path)
      if (!fs.existsSync(full)) {
        errors.push(`source_claim ${resourceId} was marked accessed but its path is inaccessible from AgentOS (${attachment.path})`)
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const content = String(value.content_markdown)
  const ratio = verbatimCodeRatio(content)
  if (ratio > KNOWLEDGE_MAX_VERBATIM_RATIO) {
    errors.push(`content_markdown looks like wholesale source reproduction (${Math.round(ratio * 100)}% verbatim code blocks > ${Math.round(KNOWLEDGE_MAX_VERBATIM_RATIO * 100)}%)`)
  }
  const violations = findClaimViolations(content, context.claimRules)
  errors.push(...violations)
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      schema: KNOWLEDGE_PACK_OUTPUT_SCHEMA,
      pack_id: String(value.pack_id),
      title: String(value.title),
      purpose: String(value.purpose),
      capabilities: stringArray(value.capabilities),
      intended_specialist_roles: stringArray(value.intended_specialist_roles),
      source_claims: claims.map(raw => {
        const claim = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
        return {
          resource_id: String(claim.resource_id || ''),
          accessed: claim.accessed === true,
          usage: typeof claim.usage === 'string' ? claim.usage : undefined,
          notes: typeof claim.notes === 'string' ? claim.notes : undefined,
        }
      }),
      content_markdown: content,
      provenance: {
        reviewed_sources: stringArray((value.provenance as Record<string, unknown>).reviewed_sources),
        generated_by: String((value.provenance as Record<string, unknown>).generated_by),
      },
      limitations: stringArray(value.limitations),
      warnings: stringArray(value.warnings),
    },
    errors: [],
  }
}

export function parseAndValidateKnowledgePackOutput(
  text: string,
  context: PackValidationContext,
): { ok: boolean; value?: AgentOSKnowledgePackV1; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractKnowledgeEnvelope(text, PACK_ENVELOPE_START, PACK_ENVELOPE_END))
  } catch {
    return { ok: false, errors: ['Pack result is not valid JSON'] }
  }
  return validateKnowledgePackOutput(parsed, context)
}

const CURATION_PACK_IDS = CURATION_PACK_KEYS.map(key => PACK_BY_KEY.get(key)!.packId)

export function validateKnowledgeValidationOutput(
  parsed: unknown,
  context: { suiteId: string },
): { ok: boolean; value?: AgentOSKnowledgeValidationV1; errors: string[] } {
  const errors: string[] = []
  if (!parsed || typeof parsed !== 'object') return { ok: false, errors: ['Result must be a JSON object'] }
  const value = parsed as Record<string, unknown>
  if (String(value.schema || '') !== KNOWLEDGE_VALIDATION_OUTPUT_SCHEMA) errors.push(`schema must be ${KNOWLEDGE_VALIDATION_OUTPUT_SCHEMA}`)
  if (String(value.suite_id || '') !== context.suiteId) errors.push(`suite_id mismatch: expected ${context.suiteId}`)
  const verdicts = Array.isArray(value.per_pack_verdicts) ? value.per_pack_verdicts : []
  const verdictPackIds = new Set<string>()
  for (const rawVerdict of verdicts) {
    const verdict = (rawVerdict && typeof rawVerdict === 'object' ? rawVerdict : {}) as Record<string, unknown>
    const packId = String(verdict.pack_id || '')
    verdictPackIds.add(packId)
    if (!CURATION_PACK_IDS.includes(packId)) errors.push(`validation verdict references unknown pack ${packId}`)
    if (!['PASS', 'FAIL', 'WARN'].includes(String(verdict.verdict || ''))) {
      errors.push(`verdict for ${packId} must be PASS|FAIL|WARN`)
    }
  }
  for (const packId of CURATION_PACK_IDS) {
    if (!verdictPackIds.has(packId)) errors.push(`validation missing verdict for ${packId}`)
  }
  if (String(value.suite_verdict || '') === 'PASS' && [...verdicts].some(verdict => (verdict as Record<string, unknown>).verdict === 'FAIL')) {
    errors.push('suite_verdict PASS conflicts with a FAIL pack verdict')
  }
  if (typeof value.report_markdown !== 'string' || value.report_markdown.trim().length < 120) {
    errors.push('report_markdown must describe the validation findings (>= 120 chars)')
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      schema: KNOWLEDGE_VALIDATION_OUTPUT_SCHEMA,
      suite_id: String(value.suite_id),
      suite_verdict: String(value.suite_verdict) as 'PASS' | 'FAIL' | 'WARN',
      per_pack_verdicts: verdicts.map(rawVerdict => {
        const verdict = rawVerdict as Record<string, unknown>
        return {
          pack_id: String(verdict.pack_id),
          verdict: String(verdict.verdict) as 'PASS' | 'FAIL' | 'WARN',
          issues: stringArray(verdict.issues),
        }
      }),
      report_markdown: String(value.report_markdown),
      warnings: stringArray(value.warnings),
    },
    errors: [],
  }
}

export function parseAndValidateKnowledgeValidationOutput(
  text: string,
  context: { suiteId: string },
): { ok: boolean; value?: AgentOSKnowledgeValidationV1; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractKnowledgeEnvelope(text, VALIDATION_ENVELOPE_START, VALIDATION_ENVELOPE_END))
  } catch {
    return { ok: false, errors: ['Validation result is not valid JSON'] }
  }
  return validateKnowledgeValidationOutput(parsed, context)
}

// ---------------------------------------------------------------------------
// Pack file writing (staging, Phase 12)
// ---------------------------------------------------------------------------

function frontMatterLines(block: Record<string, any>, value: AgentOSKnowledgePackV1): string[] {
  const delegation = block.delegation_id || null
  return [
    `# ${value.title}`,
    '',
    `> AgentOS knowledge pack · \`${value.schema}\` · pack \`${value.pack_id}\` · suite \`${block.suite_id}\``,
    '',
    `**Purpose:** ${value.purpose}`,
    '',
    `**Capabilities covered:** ${value.capabilities.join(', ') || '(unspecified)'}`,
    `**Intended specialist roles:** ${value.intended_specialist_roles.join(', ') || '(unspecified)'}`,
    `**Generated by:** ${value.provenance.generated_by || 'unknown reviewer'}`,
    '',
    '---',
    '',
  ]
}

function provenanceFooter(block: Record<string, any>, value: AgentOSKnowledgePackV1): string[] {
  const delegation = block.delegation_id || null
  const sources = value.source_claims
    .map(claim => {
      const attachment = (block.attachments || []).find((entry: KnowledgeSourceAttachment) => entry.resource_id === claim.resource_id)
      return `- \`${claim.resource_id}\` (${attachment?.name || claim.resource_id}) — ${claim.usage || attachment?.usage || 'used'} — accessed: ${claim.accessed}${claim.notes ? ' — ' + claim.notes : ''}`
    })
    .join('\n')
  return [
    '---',
    '',
    '## Sources',
    sources || '- (none claimed)',
    '',
    '## Declared limitations',
    (value.limitations.length ? value.limitations.map(limitation => '- ' + limitation).join('\n') : '- (none declared)'),
    '',
    '## Provenance',
    '',
    `- generated_at: ${new Date().toISOString()}`,
    `- generated_by: ${value.provenance.generated_by}`,
    `- suite_id: ${block.suite_id}`,
    `- pack_id: ${value.pack_id}`,
    `- schema: ${value.schema}`,
    `- objective_id: ${block.objective_id ?? 'null'}`,
    `- task_id: ${block.task_id ?? 'null'}`,
    `- mission_key: ${block.mission_key ?? 'null'}`,
    `- delegation_id: ${delegation ?? 'null'}`,
    '',
    ...(value.warnings.length ? ['## Warnings', ...value.warnings.map(warning => '- ' + warning), ''] : []),
    '',
  ]
}

export function buildPackMarkdown(block: Record<string, any>, value: AgentOSKnowledgePackV1): string {
  return [...frontMatterLines(block, value), value.content_markdown.trim(), '', ...provenanceFooter(block, value)].join('\n')
}

export function writeFileDeduped(directory: string, fileName: string, content: string): string {
  fs.mkdirSync(directory, { recursive: true })
  const target = path.join(directory, fileName)
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8')
    if (existing === content) return target
    const extension = path.extname(fileName)
    const base = path.basename(fileName, extension)
    for (let version = 2; ; version++) {
      const candidate = path.join(directory, `${base}-v${version}${extension}`)
      if (!fs.existsSync(candidate)) {
        fs.writeFileSync(candidate, content)
        return candidate
      }
    }
  }
  fs.writeFileSync(target, content)
  return target
}

// ---------------------------------------------------------------------------
// Mission state helpers + escalation
// ---------------------------------------------------------------------------

function invalidAttemptsOf(block: Record<string, any>): number {
  const value = block.invalidAttempts ?? block.invalid_attempts ?? 0
  return Number(value) || 0
}

function markKnowledgeMissionState(
  db: ReturnType<typeof getDatabase>,
  taskId: number,
  workspaceId: number,
  state: KnowledgeMissionStatus,
  patch: Record<string, any> = {},
): void {
  const row = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as { metadata: string | null } | undefined
  if (!row) return
  const metadata = parseMetadata(row.metadata)
  metadata.agentos_knowledge_curation = {
    ...(metadata.agentos_knowledge_curation || {}),
    state,
    ...patch,
  }
  db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(metadata), Math.floor(Date.now() / 1000), taskId, workspaceId)
}

function escalateKnowledgeMission(input: {
  workspaceId: number
  taskId: number
  reason: EscalationReason
  summary: string
  objectiveId?: number | null
  delegationId?: string | null
  attempts?: number
}): void {
  const record = escalateTask({
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    reason: input.reason,
    summary: input.summary,
    objectiveId: input.objectiveId,
    delegationId: input.delegationId,
    attempts: input.attempts,
    actor: 'agentos',
  })
  if (input.objectiveId) syncObjectiveEscalation(input.workspaceId, input.objectiveId, record)
  markKnowledgeMissionState(getDatabase(), input.taskId, input.workspaceId, 'NEEDS_MANUAL', {
    escalated_reason: input.reason,
    escalated_at: record.created_at,
    escalation: record,
    error: input.summary.split('\n')[0],
  })
}

// ---------------------------------------------------------------------------
// Result ingestion (Phase 13) + M6 finalization gate (Phase 14)
// ---------------------------------------------------------------------------

export interface KnowledgeIngestResult {
  status: 'COMPLETE' | 'INVALID_RESULT' | 'NO_RESULT' | 'NOT_A_CURATION_TASK' | 'TASK_NOT_FOUND' | 'STAGED'
  packId?: string
  value?: AgentOSKnowledgePackV1 | AgentOSKnowledgeValidationV1
  errors?: string[]
  stagedPath?: string
  finalized?: boolean
}

/**
 * Execution-attempt lineage for a knowledge mission.
 *
 * The ONLY result that automatic reconciliation may consume for a mission is
 * the output of the delegation bound to the CURRENT execution attempt — the
 * delegation id stored on the task metadata by createDelegationForTask at
 * claim time and cleared by retryKnowledgeMission. Older delegations, task
 * resolutions and comments belong to earlier generations: they are preserved
 * as audit history but are never automatic result input.
 */
function currentMissionDelegationResult(
  taskId: number,
  workspaceId: number,
): { id: string; resultSummary: string } | null {
  const row = getDatabase().prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(taskId, workspaceId) as { metadata: string | null } | undefined
  if (!row) return null
  const metadata = parseMetadata(row.metadata)
  const delegationId = metadata.agentos_delegation_id
  if (typeof delegationId !== 'string' || !delegationId) return null
  const delegation = getDelegation(delegationId, workspaceId)
  if (!delegation || delegation.taskId !== taskId) return null
  if (delegation.status !== 'completed') return null
  const resultSummary = String(delegation.resultSummary || '').trim()
  if (!resultSummary) return null
  return { id: delegation.id, resultSummary }
}

function readMissionComments(taskId: number, workspaceId: number): string {
  const rows = getDatabase().prepare(
    'SELECT content FROM comments WHERE task_id = ? AND workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 6',
  ).all(taskId, workspaceId) as Array<{ content: string }>
  return rows.map(row => row.content).join('\n\n')
}

function stagingFilesPresent(stagingDir: string): boolean {
  for (const spec of KNOWLEDGE_PACK_SPECS) {
    if (spec.key === VALIDATION_PACK_KEY) continue
    if (!fs.existsSync(path.join(stagingDir, spec.file))) return false
  }
  return true
}

/**
 * M6 finalization gate — only a validated M6 may write the final suite.
 * Copies the validated staged packs into the output directory (duplicate-safe,
 * never silently overwriting), writes the suite README + manifest, and records
 * the scan-visible suite container for the next vault scan.
 */
export function finalizeKnowledgeSuite(input: {
  workspaceId: number
  objectiveId: number
  suiteId: string
  stagingDir: string
  outputDir: string
  root: string
  report: string
  warnings?: string[]
  actor?: string | null
}): { ok: boolean; written: Array<{ file: string; path: string }>; manifest: Record<string, unknown>; message?: string } {
  if (!stagingFilesPresent(input.stagingDir)) {
    return { ok: false, written: [], manifest: {}, message: 'Finalization blocked: not all five staged packs exist yet' }
  }
  const db = getDatabase()
  const dbTasks = db.prepare(
    `SELECT id, metadata FROM tasks WHERE workspace_id = ? AND metadata LIKE '%"agentos_knowledge_curation"%'`,
  ).all(input.workspaceId) as Array<{ id: number; metadata: string | null }>

  const packRows: Record<string, Record<string, any>> = {}
  for (const task of dbTasks) {
    const block = parseMetadata(task.metadata).agentos_knowledge_curation
    if (!block?.pack_id) continue
    packRows[String(block.pack_id)] = { ...block, taskId: task.id }
  }
  for (const spec of KNOWLEDGE_PACK_SPECS) {
    if (spec.key === VALIDATION_PACK_KEY) continue
    const block = packRows[spec.packId]
    if (!block || String(block.state || '') !== 'COMPLETE') {
      return { ok: false, written: [], manifest: {}, message: `Finalization blocked: pack ${spec.packId} mission is not COMPLETE` }
    }
    if (!fs.existsSync(path.join(input.stagingDir, spec.file))) {
      return { ok: false, written: [], manifest: {}, message: `Finalization blocked: staged file ${spec.file} is missing` }
    }
  }

  const written: Array<{ file: string; path: string }> = []
  for (const spec of KNOWLEDGE_PACK_SPECS) {
    if (spec.key === VALIDATION_PACK_KEY) continue
    const content = fs.readFileSync(path.join(input.stagingDir, spec.file), 'utf8')
    const finalPath = writeFileDeduped(input.outputDir, spec.file, content)
    written.push({ file: spec.file, path: finalPath })
  }

  const delegationIds: string[] = []
  const missionTaskIds: Record<string, number> = {}
  for (const spec of KNOWLEDGE_PACK_SPECS) {
    const block = packRows[spec.packId]
    if (!block) continue
    missionTaskIds[spec.packId] = Number(block.taskId ?? block.task_id)
    const delegation = getLatestDelegationForTask(Number(block.taskId ?? block.task_id), input.workspaceId)
    if (delegation?.id) delegationIds.push(delegation.id)
  }

  const generatedAt = new Date().toISOString()
  const capabilityUnion = [...new Set(
    KNOWLEDGE_PACK_SPECS.flatMap(spec => [...spec.requiredCapabilities, ...spec.preferredCapabilities]),
  )].sort()
  const sourceResourceIds = [...new Set(KNOWLEDGE_PACK_SPECS.flatMap(spec => spec.referenceResourceIds))].sort()
  const files = KNOWLEDGE_PACK_SPECS
    .filter(spec => spec.key !== VALIDATION_PACK_KEY)
    .map(spec => spec.file)

  const manifest: Record<string, unknown> = {
    suite_id: input.suiteId,
    title: KNOWLEDGE_SUITE_TITLE,
    generated_at: generatedAt,
    files,
    capabilities: capabilityUnion,
    source_resource_ids: sourceResourceIds,
    objective_id: input.objectiveId,
    mission_task_ids: missionTaskIds,
    delegation_ids: delegationIds,
    validation_result: {
      verdict: 'PASS',
      report: input.report.slice(0, 500),
      warnings: input.warnings || [],
    },
    final_output_dir: input.outputDir,
    staged_dir: input.stagingDir,
    scan_note: 'Generated by AgentOS knowledge curation. Not yet registered in the authoritative registry — the next vault scan will surface this suite as NEW for review. Do not auto-promote.',
  }

  const manifestJson = JSON.stringify(manifest, null, 2) + '\n'
  const suiteReadme = [
    `# ${KNOWLEDGE_SUITE_TITLE}`,
    '',
    `Generated by AgentOS knowledge curation (objective ${input.objectiveId}, suite ${input.suiteId}).`,
    '',
    `Sources: ${sourceResourceIds.join(', ') || '(none)'}`,
    '',
    `Packs in this suite:`,
    ...files.map(file => `- ${file}`),
    '',
    'These packs are staged for review and must pass the normal NEW → Review Queue → approval lifecycle before promotion.',
    '',
  ].join('\n')

  // Final directory artifacts.
  writeFileDeduped(input.outputDir, 'manifest.json', manifestJson)
  writeFileDeduped(input.outputDir, 'README.md', suiteReadme)
  // Scan-visible staging container (00_INBOX/generated-knowledge) gets the same
  // suite README + manifest so the vault scanner registers it as a NEW resource.
  writeFileDeduped(input.stagingDir, 'README.md', suiteReadme)
  writeFileDeduped(input.stagingDir, 'manifest.json', manifestJson)

  const now = Math.floor(Date.now() / 1000)
  const planRow = db.prepare('SELECT plan_json FROM agentos_objectives WHERE id = ? AND workspace_id = ?')
    .get(input.objectiveId, input.workspaceId) as { plan_json: string }
  let plan: Record<string, any> = {}
  try { plan = JSON.parse(planRow.plan_json || '{}') } catch { plan = {} }
  plan.agentos_knowledge_suite = {
    ...(plan.agentos_knowledge_suite || {}),
    state: 'FINALIZED',
    finalized_at: generatedAt,
    output_dir: input.outputDir,
    files,
    manifest: {
      objective_id: input.objectiveId,
      mission_task_ids: missionTaskIds,
      delegation_ids: delegationIds,
    },
  }
  db.prepare('UPDATE agentos_objectives SET plan_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(JSON.stringify(plan), now, input.objectiveId, input.workspaceId)
  db_helpers.logActivity('agentos_knowledge_suite_finalized', 'project', input.objectiveId, input.actor || 'agentos',
    `Knowledge suite ${input.suiteId} finalized: ${written.length} packs written to ${input.outputDir}`,
    { objective_id: input.objectiveId, suite_id: input.suiteId, files, delegation_ids: delegationIds },
    input.workspaceId,
  )

  return { ok: true, written, manifest }
}

/**
 * Ingest a mission result (pack M1–M5 or validation M6). Validated pack
 * results are written to the staged directory only; only a validated M6 with
 * all five packs COMPLETE triggers finalization. Never auto-promotes.
 */
export function ingestKnowledgeMissionResult(input: {
  taskId: number
  workspaceId: number
  text?: string | null
  root?: string
  actor?: string | null
  /** The delegation whose output is being consumed (execution-attempt provenance). */
  delegationId?: string | null
}): KnowledgeIngestResult {
  const db = getDatabase()
  const root = input.root || config.aiVaultRoot
  const task = db.prepare('SELECT id, status, metadata FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(input.taskId, input.workspaceId) as { id: number; status: string; metadata: string | null } | undefined
  if (!task) return { status: 'TASK_NOT_FOUND' }
  const metadata = parseMetadata(task.metadata)
  const block = metadata.agentos_knowledge_curation
  if (!block || typeof block !== 'object') return { status: 'NOT_A_CURATION_TASK' }
  const packId = String(block.pack_id)
  const spec = PACK_BY_ID.get(packId)
  if (!spec) return { status: 'NOT_A_CURATION_TASK' }
  const actor = input.actor || 'agentos'
  // The execution whose output is being consumed: an explicitly supplied
  // delegation (automatic reconcile always supplies one) or the delegation
  // bound to this task's current attempt. Historical delegations are never
  // eligible output for a newer retry generation (retry clears the binding).
  const delegationId = input.delegationId
    ?? (typeof metadata.agentos_delegation_id === 'string' && metadata.agentos_delegation_id ? metadata.agentos_delegation_id : null)
    ?? null

  let text = input.text ?? null
  if (text === null || !text.trim()) {
    // Execution-attempt authority: when a delegation is bound to the current
    // attempt, its completed result_summary is the only eligible text — task
    // comments are audit history, not automatic output. readMissionComments
    // remains a fallback only when no current delegation output exists
    // (manual/legacy ingestion paths).
    if (delegationId) {
      const delegation = getDelegation(delegationId, input.workspaceId)
      if (delegation?.status === 'completed') {
        const summary = String(delegation.resultSummary || '').trim()
        if (summary) text = summary
      }
    }
    if (text === null || !text.trim()) {
      text = readMissionComments(task.id, input.workspaceId)
    }
  }
  if (!text || !text.trim()) return { status: 'NO_RESULT' }

  const isValidation = spec.key === VALIDATION_PACK_KEY
  if (isValidation) {
    const parsed = parseAndValidateKnowledgeValidationOutput(text, { suiteId: KNOWLEDGE_SUITE_ID })
    if (!parsed.ok || !parsed.value) {
      const errorText = parsed.errors.join('; ')
      const invalidAttempts = invalidAttemptsOf(block) + 1
      db_helpers.logActivity('agentos_knowledge_invalid_result', 'task', task.id, actor,
        `Validation mission ${packId} rejected: ${errorText}`, {}, input.workspaceId)
      if (invalidAttempts >= KNOWLEDGE_MAX_INVALID_ATTEMPTS) {
        escalateKnowledgeMission({
          workspaceId: input.workspaceId,
          taskId: task.id,
          reason: 'invalid_structured_output',
          summary: `Validation returned invalid structured output ${invalidAttempts} consecutive times: ${errorText}`,
          objectiveId: block.objective_id ?? null,
          delegationId: metadata.agentos_delegation_id || null,
          attempts: invalidAttempts,
        })
      } else {
        markKnowledgeMissionState(db, task.id, input.workspaceId, 'FAILED', {
          error: errorText,
          invalid_attempts: invalidAttempts,
          ...(delegationId ? { delegation_id: delegationId, consumed_delegation_id: delegationId } : {}),
        })
      }
      return { status: 'INVALID_RESULT', packId, errors: parsed.errors }
    }
    const value = parsed.value
    if (value.suite_verdict === 'FAIL') {
      const failed = value.per_pack_verdicts.filter(verdict => verdict.verdict === 'FAIL')
      const issues = failed.flatMap(verdict => verdict.issues)
      escalateKnowledgeMission({
        workspaceId: input.workspaceId,
        taskId: task.id,
        reason: 'policy_conflict',
        summary: `Suite validation FAILED: ${failed.length} pack(s) did not pass — ${issues.join('; ')}`,
        objectiveId: block.objective_id ?? null,
        delegationId: delegationId || metadata.agentos_delegation_id || null,
      })
      db_helpers.logActivity('agentos_knowledge_validation_failed', 'task', task.id, actor,
        `Suite validation FAILED for ${packId}`, { suite_id: KNOWLEDGE_SUITE_ID }, input.workspaceId)
      return { status: 'INVALID_RESULT', packId, errors: issues }
    }

    const stagedDir = String(block.staging_dir || defaultStagingDir(root))
    const outputDir = String(block.output_dir || defaultOutputDir(root))
    const finalized = finalizeKnowledgeSuite({
      workspaceId: input.workspaceId,
      objectiveId: Number(block.objective_id ?? 0),
      suiteId: KNOWLEDGE_SUITE_ID,
      stagingDir: stagedDir,
      outputDir,
      root,
      report: value.report_markdown,
      warnings: value.warnings,
      actor,
    })
    if (!finalized.ok) {
      // The verdict passed but the finalization gate is not satisfied — treat
      // as an escalation (e.g. a pack task is not COMPLETE or files missing).
      escalateKnowledgeMission({
        workspaceId: input.workspaceId,
        taskId: task.id,
        reason: 'approval_required',
        summary: finalized.message || 'Suite validation passed but finalization is blocked',
        objectiveId: block.objective_id ?? null,
        delegationId: metadata.agentos_delegation_id || null,
      })
      return { status: 'INVALID_RESULT', packId, errors: [finalized.message || 'Finalization blocked'] }
    }
    markKnowledgeMissionState(db, task.id, input.workspaceId, 'COMPLETE', {
      validation: value,
      suite_verdict: value.suite_verdict,
      finalized: true,
      output_dir: outputDir,
      validation_completed_at: new Date().toISOString(),
      ...(delegationId ? { delegation_id: delegationId, consumed_delegation_id: delegationId } : {}),
    })
    db_helpers.logActivity('agentos_knowledge_suite_validated', 'task', task.id, actor,
      `Knowledge suite ${KNOWLEDGE_SUITE_ID} validated PASS and finalized (${finalized.written.length} packs)`,
      { suite_id: KNOWLEDGE_SUITE_ID, objective_id: block.objective_id ?? null }, input.workspaceId)
    return { status: 'COMPLETE', packId, value, finalized: true }
  }

  // Pack mission (M1–M5)
  const attachments: KnowledgeSourceAttachment[] = Array.isArray(block.attachments) ? block.attachments : []
  const context: PackValidationContext = {
    packId,
    suiteId: KNOWLEDGE_SUITE_ID,
    attachments,
    root,
  }
  const parsed = parseAndValidateKnowledgePackOutput(text, context)
  if (!parsed.ok || !parsed.value) {
    const errorText = parsed.errors.join('; ')
    const invalidAttempts = invalidAttemptsOf(block) + 1
    db_helpers.logActivity('agentos_knowledge_invalid_result', 'task', task.id, actor,
        `Pack mission ${packId} rejected: ${errorText}`, { pack_id: packId }, input.workspaceId)
    if (invalidAttempts >= KNOWLEDGE_MAX_INVALID_ATTEMPTS) {
      escalateKnowledgeMission({
        workspaceId: input.workspaceId,
        taskId: task.id,
        reason: 'invalid_structured_output',
        summary: `Reviewer returned invalid structured output ${invalidAttempts} consecutive times: ${errorText}`,
        objectiveId: block.objective_id ?? null,
        delegationId: metadata.agentos_delegation_id || null,
        attempts: invalidAttempts,
      })
    } else {
      markKnowledgeMissionState(db, task.id, input.workspaceId, 'FAILED', {
        error: errorText,
        invalid_attempts: invalidAttempts,
        ...(delegationId ? { delegation_id: delegationId, consumed_delegation_id: delegationId } : {}),
      })
    }
    return { status: 'INVALID_RESULT', packId, errors: parsed.errors }
  }
  const value = parsed.value

  const stagedDir = String(block.staging_dir || defaultStagingDir(root))
  const content = buildPackMarkdown(block, value)
  const stagedPath = writeFileDeduped(stagedDir, spec.file, content)
  markKnowledgeMissionState(db, task.id, input.workspaceId, 'COMPLETE', {
    result: value,
    staged_path: stagedPath,
    staged_at: new Date().toISOString(),
    capabilities: value.capabilities,
    limitations: value.limitations,
    warnings: value.warnings,
    ...(delegationId ? { delegation_id: delegationId, consumed_delegation_id: delegationId } : {}),
  })
  // A valid result resolves any earlier escalation for this mission.
  const afterRow = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
    .get(task.id, input.workspaceId) as { metadata: string | null }
  if (readTaskEscalation(afterRow.metadata)) {
    resolveTaskEscalation({ workspaceId: input.workspaceId, taskId: task.id, actor, note: `Knowledge pack ${packId} produced a valid result` })
  }
  const objectiveId = block.objective_id ?? null
  if (objectiveId) syncObjectiveEscalation(input.workspaceId, objectiveId, null)
  db_helpers.logActivity('agentos_knowledge_pack_validated', 'task', task.id, actor,
    `Knowledge pack ${packId} validated and staged to ${stagedPath}`,
    { pack_id: packId, objective_id: objectiveId }, input.workspaceId)

  return { status: 'COMPLETE', packId, value, stagedPath }
}

// ---------------------------------------------------------------------------
// Retry (Phase 6/7 — retry vs escalate)
// ---------------------------------------------------------------------------

export function retryKnowledgeMission(input: {
  packId: string
  workspaceId: number
  projectId?: number | null
  actor?: string | null
  root?: string
}): { taskId: number; packId: string; workspaceId: number; projectId: number | null; objectiveId: number | null; routed: boolean; reason?: string } {
  const existing = findMissionTaskByPackId(input.packId, input.workspaceId)
  if (!existing) throw new Error('Knowledge mission not found for pack ' + input.packId)
  const db = getDatabase()
  const root = input.root || config.aiVaultRoot
  const metadata = parseMetadata(existing.metadata)
  const block = metadata.agentos_knowledge_curation || {}
  const objectiveId = Number(block.objective_id ?? 0) || null
  let projectId = input.projectId ?? block.project_id ?? null
  if (!projectId) projectId = getOrCreateAgentOSOperationsProject(input.workspaceId).id
  const actor = input.actor || 'agentos'
  const now = Math.floor(Date.now() / 1000)

  metadata.agentos_knowledge_curation = {
    ...block,
    state: 'ROUTED',
    invalid_attempts: 0,
    invalidAttempts: 0,
    error: null,
    retried_at: new Date().toISOString(),
  }
  // A retry opens a NEW execution generation. Derived output from a previous
  // generation (staged path, result, consumed-delegation marker, validation
  // artifacts) is not eligible for the new attempt — it stays in the vault and
  // delegation/comments as history, but the live mission block must not
  // present it as the current result. The delegation binding on the task is
  // also cleared so automatic reconciliation cannot consume an old delegation.
  delete metadata.agentos_routing
  delete metadata.agentos_delegation_id
  for (const key of [
    'result', 'staged_path', 'staged_at', 'capabilities', 'limitations', 'warnings',
    'validation', 'suite_verdict', 'finalized', 'output_dir', 'validation_completed_at',
    'delegation_id', 'consumed_delegation_id',
  ]) {
    delete metadata.agentos_knowledge_curation[key]
  }
  db.prepare('UPDATE tasks SET status = ?, assigned_to = NULL, resolution = NULL, outcome = NULL, metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run('inbox', JSON.stringify(metadata), now, existing.id, input.workspaceId)
  resolveTaskEscalation({ workspaceId: input.workspaceId, taskId: existing.id, actor, note: `Knowledge mission ${input.packId} retried` })
  if (objectiveId) syncObjectiveEscalation(input.workspaceId, objectiveId, null)

  let routed = false
  let reason: string | undefined
  if (projectId) {
    try {
      const routeResult = routeTaskWithinProject({ taskId: existing.id, workspaceId: input.workspaceId, actor })
      routed = routeResult.routed
      if (routed && routeResult.selected) {
        metadata.agentos_routing = {
          externalAgentId: routeResult.selected.externalAgentId,
          agentName: routeResult.selected.agentName,
          platoonId: routeResult.selected.platoonId,
          routingAgentName: routeResult.selected.routingAgentName,
        }
        db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
          .run(JSON.stringify(metadata), now, existing.id, input.workspaceId)
      } else {
        reason = routeResult.reason || 'No eligible specialist yet'
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : 'Routing failed'
    }
  }
  db_helpers.logActivity('agentos_knowledge_retried', 'task', existing.id, actor,
    `Retried knowledge mission ${input.packId}${routed ? ' routed to specialist' : ' (held)'}`,
    { pack_id: input.packId, objective_id: objectiveId }, input.workspaceId)

  return { taskId: existing.id, packId: input.packId, workspaceId: input.workspaceId, projectId, objectiveId, routed, reason }
}

// ---------------------------------------------------------------------------
// Escalation policy sweep (Phase 6/7)
// ---------------------------------------------------------------------------

export function applyKnowledgeCurationEscalationPolicy(rootInput?: string): {
  escalated: Array<{ packId: string; taskId: number; reason: EscalationReason }>
  retryable: number
} {
  const db = getDatabase()
  const tasks = db.prepare(
    `SELECT id, workspace_id, status, assigned_to, metadata FROM tasks WHERE metadata LIKE '%"agentos_knowledge_curation"%' ORDER BY id`,
  ).all() as Array<{ id: number; workspace_id: number; status: string; assigned_to: string | null; metadata: string | null }>

  const escalated: Array<{ packId: string; taskId: number; reason: EscalationReason }> = []
  let retryable = 0

  for (const task of tasks) {
    const metadata = parseMetadata(task.metadata)
    const block = metadata.agentos_knowledge_curation
    if (!block || typeof block !== 'object') continue
    if (String(block.state || '') === 'COMPLETE') continue
    if (readTaskEscalation(task.metadata)) continue
    const packId = String(block.pack_id)
    const invalidAttempts = invalidAttemptsOf(block)

    if (invalidAttempts >= KNOWLEDGE_MAX_INVALID_ATTEMPTS) {
      escalateKnowledgeMission({
        workspaceId: task.workspace_id,
        taskId: task.id,
        reason: 'invalid_structured_output',
        summary: `Knowledge mission returned invalid structured output ${invalidAttempts} consecutive times`,
        objectiveId: Number(block.objective_id ?? 0) || null,
        delegationId: metadata.agentos_delegation_id || null,
        attempts: invalidAttempts,
      })
      escalated.push({ packId, taskId: task.id, reason: 'invalid_structured_output' })
      continue
    }

    if (task.status === 'failed') {
      const delegation = getLatestDelegationForTask(task.id, task.workspace_id)
      const error = String(delegation?.errorMessage || '')
      let reason: EscalationReason | null = null
      if (/not found|no such|missing|deleted|removed/i.test(error)) reason = 'missing_resource'
      else if (/inaccessible|permission|denied|eacces|unreadable|path/i.test(error)) reason = 'inaccessible_resource_path'
      if (reason) {
        escalateKnowledgeMission({
          workspaceId: task.workspace_id,
          taskId: task.id,
          reason,
          summary: `Knowledge mission could not reach its source material: ${error.slice(0, 180)}`,
          objectiveId: Number(block.objective_id ?? 0) || null,
          delegationId: delegation?.id || null,
        })
        escalated.push({ packId, taskId: task.id, reason })
        continue
      }
      retryable++
    }
  }

  return { escalated, retryable }
}

// ---------------------------------------------------------------------------
// Reconcile (runs from the scheduler alongside other AgentOS reconciles)
// ---------------------------------------------------------------------------

/**
 * Refresh capability requirements on existing suite mission tasks from the
 * current KNOWLEDGE_PACK_SPECS (spec versioning). Suite objectives created
 * before a spec change keep working: their metadata heals to the versioned
 * contract instead of being hand-edited. No-op when already aligned.
 */
export function refreshSuiteMissionCapabilityMetadata(input: {
  workspaceId?: number
  actor?: string | null
}): { refreshed: number } {
  const db = getDatabase()
  const wsFilter = Number.isInteger(input.workspaceId)
    ? 'AND workspace_id = ?'
    : ''
  const args: Array<number> = Number.isInteger(input.workspaceId) ? [input.workspaceId as number] : []
  const rows = db.prepare(`
    SELECT id, workspace_id, plan_json FROM agentos_objectives
    WHERE plan_json LIKE '%"agentos_knowledge_suite"%' ${wsFilter}
    ORDER BY id DESC LIMIT 50
  `).all(...args) as Array<{ id: number; workspace_id: number; plan_json: string }>
  let refreshed = 0
  for (const row of rows) {
    let plan: Record<string, any>
    try { plan = JSON.parse(row.plan_json) } catch { continue }
    const suite = plan.agentos_knowledge_suite
    if (!suite || !Array.isArray(suite.missions)) continue
    for (const mission of suite.missions) {
      const taskId = Number(mission.task_id)
      if (!Number.isInteger(taskId)) continue
      const spec = PACK_BY_KEY.get(String(mission.key))
      if (!spec) continue
      const taskRow = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')
        .get(taskId, row.workspace_id) as { metadata: string | null } | undefined
      if (!taskRow) continue
      const metadata = parseMetadata(taskRow.metadata)
      const agentos = metadata.agentos && typeof metadata.agentos === 'object' ? metadata.agentos as Record<string, unknown> : {}
      const currentRequired = Array.isArray(agentos.requiredCapabilities) ? agentos.requiredCapabilities : []
      const currentPreferred = Array.isArray(agentos.preferredCapabilities) ? agentos.preferredCapabilities : []
      const nextRequired = spec.requiredCapabilities
      const nextPreferred = spec.preferredCapabilities
      const requiredSame = JSON.stringify(currentRequired) === JSON.stringify(nextRequired)
      const preferredSame = JSON.stringify(currentPreferred) === JSON.stringify(nextPreferred)
      if (requiredSame && preferredSame) continue
      agentos.requiredCapabilities = nextRequired
      agentos.preferredCapabilities = nextPreferred
      metadata.agentos = agentos
      db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
        .run(JSON.stringify(metadata), Math.floor(Date.now() / 1000), taskId, row.workspace_id)
      refreshed++
    }
  }
  if (refreshed > 0) {
    db_helpers.logActivity(
      'agentos_knowledge_suite_requirements_refreshed', 'workspace', input.workspaceId ?? 0, input.actor || 'agentos',
      `Refreshed capability requirements on ${refreshed} suite mission task(s) to the current spec`,
      { refreshed },
      input.workspaceId ?? 0,
    )
  }
  return { refreshed }
}

export function reconcileKnowledgeCuration(rootInput?: string): {
  ok: boolean
  message: string
  ingested: number
  invalid: number
  running: number
  promotedValidation: number
  escalated: number
  retryable: number
} {
  const root = rootInput || config.aiVaultRoot
  const db = getDatabase()
  // Version the mission contract: existing suite tasks heal to the current
  // KNOWLEDGE_PACK_SPECS (required execution role vs preferred domains).
  refreshSuiteMissionCapabilityMetadata({ actor: 'agentos' })
  const tasks = db.prepare(
    `SELECT id, workspace_id, project_id, metadata FROM tasks WHERE metadata LIKE '%"agentos_knowledge_curation"%' ORDER BY id`,
  ).all() as Array<{ id: number; workspace_id: number; project_id: number | null; metadata: string | null }>

  let ingested = 0
  let invalid = 0
  let running = 0
  let lineageHeld = 0

  // AgentOS is the Company Commander: while an AgentOS-managed project is not
  // ACTIVE, its automated lifecycle must not advance — that includes result
  // consumption, mission-state mutation, staging and finalization. These gates
  // use the same shared command check as dispatch/Aegis; projects without an
  // agentos_project_command record are unmanaged and are never gated here.
  const isHeld = (task: { id: number; workspace_id: number; project_id: number | null }): boolean => {
    const gate = mayAgentosLifecycleAdvance({ projectId: task.project_id, workspaceId: task.workspace_id })
    if (gate.allowed) return false
    db_helpers.logActivity(
      'agentos_knowledge_reconcile_held',
      'task',
      task.id,
      'agentos',
      `Knowledge reconcile held: ${gate.reason}`,
      { project_id: task.project_id, state: gate.state },
      task.workspace_id,
    )
    return true
  }

  const inProgress = tasks.filter(task => {
    const row = db.prepare('SELECT status FROM tasks WHERE id = ? AND workspace_id = ?').get(task.id, task.workspace_id) as { status: string }
    return row.status === 'in_progress'
  })
  for (const task of inProgress) {
    const block = parseMetadata(task.metadata).agentos_knowledge_curation
    if (!block?.pack_id) continue
    if (isHeld(task)) continue
    markKnowledgeMissionState(db, task.id, task.workspace_id, 'RUNNING')
    running++
  }

  for (const task of tasks) {
    const row = db.prepare('SELECT status, metadata FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(task.id, task.workspace_id) as { status: string; metadata: string | null }
    if (row.status === 'inbox' || row.status === 'backlog' || row.status === 'done' || row.status === 'failed') continue
    const block = parseMetadata(row.metadata).agentos_knowledge_curation
    if (!block?.pack_id) continue
    if (['COMPLETE', 'FAILED', 'NEEDS_MANUAL'].includes(String(block.state || ''))) continue
    if (isHeld(task)) continue

    // Execution-attempt lineage: automatic ingestion only ever consumes the
    // output of the delegation bound to the CURRENT execution attempt. That
    // binding is set at dispatch claim (agentos_delegation_id) and cleared by
    // retryKnowledgeMission, so historical comments / older delegations are
    // audit history — they can never become eligible output for a newer retry
    // generation. A mission with no current completed delegation stays exactly
    // as it is (ROUTED) until the current attempt actually produces output.
    const current = currentMissionDelegationResult(task.id, task.workspace_id)
    if (!current) {
      lineageHeld++
      continue
    }
    if (String(block.consumed_delegation_id || '') === current.id) continue
    try {
      const result = ingestKnowledgeMissionResult({
        taskId: task.id,
        workspaceId: task.workspace_id,
        root,
        text: current.resultSummary,
        delegationId: current.id,
      })
      if (result.status === 'COMPLETE') ingested++
      else if (result.status === 'INVALID_RESULT') invalid++
    } catch {
      // Keep the mission state intact.
    }
  }

  // M6 unblocks through the standard objective dependency promotion once its
  // M1–M5 dependencies reach 'done' (shared workspaces).
  const promotion = promoteReadyObjectiveMissions()

  const policy = applyKnowledgeCurationEscalationPolicy(root)
  const parts = [
    ingested ? `${ingested} validated` : null,
    invalid ? `${invalid} invalid` : null,
    running ? `${running} running` : null,
    lineageHeld ? `${lineageHeld} held awaiting current attempt` : null,
    promotion.promoted.length ? `${promotion.promoted.length} dependency mission(s) promoted` : null,
    policy.escalated.length ? `${policy.escalated.length} escalated to needs-manual` : null,
    policy.retryable ? `${policy.retryable} retryable` : null,
  ].filter(Boolean)
  return {
    ok: true,
    message: parts.length ? 'Knowledge curation reconcile: ' + parts.join(', ') : 'No knowledge-curation results to reconcile',
    ingested,
    invalid,
    running,
    promotedValidation: promotion.promoted.length,
    escalated: policy.escalated.length,
    retryable: policy.retryable,
  }
}

// ---------------------------------------------------------------------------
// Traceability + suite state (Phase 10/16)
// ---------------------------------------------------------------------------

export interface KnowledgeMissionTrace {
  taskId: number
  packId: string
  missionKey: string
  file: string
  schema: string
  title: string
  status: string
  assignedTo: string | null
  projectId: number | null
  objectiveId: number | null
  dependsOnKeys: string[]
  createdAt: number
  updatedAt: number
  state: string | null
  stagedPath: string | null
  invalidAttempts: number
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
  resultSummary: Record<string, unknown> | null
}

export function listKnowledgeSuiteMissions(workspaceId: number, projectId?: number | null): KnowledgeMissionTrace[] {
  const db = getDatabase()
  const rows = db.prepare(
    `SELECT id, title, status, assigned_to, project_id, created_at, updated_at, metadata
     FROM tasks WHERE workspace_id = ? ${projectId ? 'AND project_id = ?' : ''}
     AND metadata LIKE '%"agentos_knowledge_curation"%' ORDER BY id DESC LIMIT 100`,
  ).all(projectId ? [workspaceId, projectId] : [workspaceId]) as any[]
  return rows.map(row => {
    const meta = parseMetadata(row.metadata)
    const block = meta.agentos_knowledge_curation || {}
    const delegation = getLatestDelegationForTask(row.id, workspaceId)
    const escalation = readTaskEscalation(row.metadata)
    return {
      taskId: row.id,
      packId: String(block.pack_id || ''),
      missionKey: String(block.mission_key || ''),
      file: String(block.file || ''),
      schema: String(block.schema || ''),
      title: row.title,
      status: row.status,
      assignedTo: row.assigned_to || null,
      projectId: row.project_id ?? null,
      objectiveId: typeof block.objective_id === 'number' ? block.objective_id : null,
      dependsOnKeys: Array.isArray(block.depends_on_keys) ? block.depends_on_keys : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: block.state ? String(block.state) : null,
      stagedPath: block.staged_path ? String(block.staged_path) : null,
      invalidAttempts: invalidAttemptsOf(block),
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
      resultSummary: block.result && typeof block.result === 'object'
        ? {
            title: block.result.title || null,
            capabilities: block.result.capabilities || null,
            source_claims: block.result.source_claims || null,
            limitations: block.result.limitations || null,
          }
        : null,
    }
  })
}

export interface KnowledgeSuiteState {
  objective: {
    id: number
    projectId: number
    title: string
    status: string
    plan: Record<string, unknown> | null
  } | null
  missions: KnowledgeMissionTrace[]
}

export function getKnowledgeSuiteState(workspaceId: number): KnowledgeSuiteState {
  const found = findObjectiveBySuite(workspaceId, KNOWLEDGE_SUITE_ID)
  if (!found) return { objective: null, missions: [] }
  const row = getDatabase().prepare(
    'SELECT id, project_id, title, status, plan_json FROM agentos_objectives WHERE id = ? AND workspace_id = ?',
  ).get(found.objectiveId, workspaceId) as any
  let plan: Record<string, unknown> | null = null
  try { plan = JSON.parse(row.plan_json || '{}') } catch { plan = null }
  const missions = listKnowledgeSuiteMissions(workspaceId).filter(mission => mission.objectiveId === found.objectiveId)
  return {
    objective: {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      plan,
    },
    missions: missions.sort((a, b) => (a.missionKey < b.missionKey ? -1 : a.missionKey > b.missionKey ? 1 : 0)),
  }
}
