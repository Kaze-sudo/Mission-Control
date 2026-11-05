import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCanonicalVault, read, reviewQueueItems, rmRoot, tmpRoot, write } from './helpers/ai-arsenal-fixtures'
import { rankAgentsForMission } from '@/lib/agent-selection'
import type { GlobalRosterAgent } from '@/lib/global-agent-roster'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  activities: [] as unknown[],
  routeMock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: (...args: unknown[]) => state.activities.push(args) },
}))

vi.mock('@/lib/project-task-routing', () => ({
  routeTaskWithinProject: (...args: unknown[]) => state.routeMock(...args),
}))

import {
  createDeepReviewMission,
  retryDeepReviewMission,
  ingestDeepReviewResult,
  reconcileDeepReviewMissions,
  applyDeepReviewEscalationPolicy,
  listDeepReviewMissions,
  inferReviewerRequirements,
  parseAndValidateReviewOutput,
  computeReviewFingerprint,
  DEEP_REVIEW_OUTPUT_SCHEMA,
  REVIEW_ENVELOPE_START,
  REVIEW_ENVELOPE_END,
  type AgentOSResourceReviewV1,
} from '@/lib/resource-deep-review'
import { getAiReviewQueue, getAiResourceRegistry } from '@/lib/ai-resource-registry'
import { performArsenalAction } from '@/lib/ai-resource-actions'
import { getOrCreateAgentOSOperationsProject } from '@/lib/agentos-operations'
import { createDelegationForTask } from '@/lib/delegation-ledger'
import { reconcileObjectiveStatuses } from '@/lib/objective-planning'
import { classifyEscalation } from '@/lib/agentos-escalation'
import type { AiReviewQueueItem } from '@/lib/ai-resource-registry'

let root = ''
let workspaceId = 1

function seedDb(): void {
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, description TEXT, status TEXT, priority TEXT,
      project_id INTEGER, project_ticket_no INTEGER, assigned_to TEXT,
      created_by TEXT, created_at INTEGER, updated_at INTEGER,
      tags TEXT, metadata TEXT, workspace_id INTEGER,
      outcome TEXT, resolution TEXT, error_message TEXT, completed_at INTEGER
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER, author TEXT, content TEXT, created_at INTEGER, workspace_id INTEGER
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT,
      ticket_prefix TEXT NOT NULL, ticket_counter INTEGER NOT NULL DEFAULT 0,
      workspace_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(workspace_id, slug)
    );
    CREATE TABLE agentos_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL DEFAULT '{}', created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agentos_delegations (
      id TEXT PRIMARY KEY, task_id INTEGER, project_id INTEGER, workspace_id INTEGER, objective_id INTEGER,
      platoon_id TEXT, specialist_name TEXT, routing_agent_name TEXT, runtime_type TEXT, status TEXT,
      native_session_id TEXT, native_run_id TEXT, attempt INTEGER NOT NULL DEFAULT 1,
      result_summary TEXT, error_message TEXT, created_at INTEGER, updated_at INTEGER, completed_at INTEGER
    );
  `)
}

function latest() {
  return state.db!.prepare('SELECT id, title, status, project_id, assigned_to, metadata, workspace_id FROM tasks ORDER BY id DESC LIMIT 1').get() as any
}
function taskById(id: number) {
  return state.db!.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any
}
function addComment(taskId: number, content: string, author = 'reviewer-hermes') {
  state.db!.prepare('INSERT INTO comments (task_id, author, content, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, author, content, Math.floor(Date.now() / 1000), workspaceId)
}

function validReviewEnvelope(overrides: Record<string, unknown> = {}): string {
  const payload: Record<string, unknown> = {
    review_id: overrides.review_id ?? 'rq-pending-newlib',
    resource_id: null,
    review_status: 'COMPLETE',
    actual_type: 'engine',
    quality_score: 76,
    confidence: 'HIGH',
    proven_capabilities: ['tactical-encounters'],
    rejected_capabilities: [],
    primary_capability: 'tactical-encounters',
    secondary_capabilities: ['game-development'],
    audit_status_recommendation: 'KEEP',
    auto_select_recommendation: true,
    manual_only_recommendation: false,
    preferred_platoon: 'game-platoon',
    preferred_specialist_role: 'tactical-battles-encounter-designer',
    integration_mode: 'external-runtime-integration',
    runtime_requirements: ['C++ / SDL2'],
    move_risk: 'SAFE_TO_MOVE',
    path_sensitive: false,
    overlap_findings: ['overlaps grp-tactical-engines (complementary)'],
    supersession_findings: [],
    capability_gap_effects: [],
    strengths: ['proven encounter authoring'],
    weaknesses: ['hex only'],
    evidence: ['docs/DeepReview.md', 'src/ENCOUNTERS.md'],
    warnings: [],
    proposed_registry_entry: { name: 'newlib', audit_status: 'KEEP' },
    proposed_capability_index_changes: {},
    proposed_overlap_policy_changes: {},
    proposed_platoon_map_changes: {},
    ...overrides,
  }
  return `${REVIEW_ENVELOPE_START}\n${JSON.stringify(payload, null, 2)}\n${REVIEW_ENVELOPE_END}`
}

function queueItem(reviewId: string): any {
  return JSON.parse(read(root, '_CATALOG/agentos_resource_review_queue.json')).items.find((i: any) => i.review_id === reviewId)
}

function normalizedItem(reviewId: string): AiReviewQueueItem | undefined {
  return getAiReviewQueue(root).find(item => item.reviewId === reviewId)
}

beforeEach(() => {
  root = tmpRoot()
  buildCanonicalVault(root)
  workspaceId = 1
  seedDb()
  state.activities = []
  state.routeMock.mockReset()
  state.routeMock.mockReturnValue({ routed: false, reason: 'no bindings', taskId: 0, projectId: null })
})

afterEach(() => {
  state.db?.close()
  state.db = null
  rmRoot(root)
})

describe('resource-deep-review capability routing', () => {
  const agent = (over: Partial<Record<string, unknown>>) => ({
    id: 'a',
    name: 'Agent',
    platoonId: 'game-platoon',
    role: '',
    archetype: '',
    availability: 'available',
    definitionPath: null,
    source: 'mission-control' as const,
    capabilities: { tags: [] as string[], source: 'declared' as const },
    performance: { tasks: 1, completed: 1, completionRate: 100 },
    ...over,
  }) as GlobalRosterAgent

  it('requires resource-deep-review; a domain specialist outranks a generic director', () => {
    const reviewer = agent({ id: 'reviewer', name: 'Deep Reviewer', role: 'Deep Reviewer Specialist', capabilities: { tags: ['resource-deep-review', 'game-development'], source: 'declared' } })
    const generic = agent({ id: 'director', name: 'Director', role: 'Chief of Staff', capabilities: { tags: ['orchestration'], source: 'declared' } })
    const ranked = rankAgentsForMission([generic, reviewer], {
      requiredCapabilities: ['resource-deep-review'],
      preferredCapabilities: ['game-development'],
    })
    expect(ranked.find(c => c.agent.id === 'reviewer')?.eligible).toBe(true)
    expect(ranked.find(c => c.agent.id === 'director')?.eligible).toBe(false) // missing required capability
    expect(ranked[0].agent.id).toBe('reviewer')
  })

  it('prefers a deeper domain match over a plain resource-deep-review tag', () => {
    const deep = agent({ id: 'deep', name: 'Game Reviewer', platoonId: 'game-platoon', capabilities: { tags: ['resource-deep-review', 'game-development', 'qa-release'], source: 'declared' } })
    const shallow = agent({ id: 'shallow', name: 'Generic Reviewer', platoonId: 'other', capabilities: { tags: ['resource-deep-review'], source: 'declared' } })
    const ranked = rankAgentsForMission([shallow, deep], {
      requiredCapabilities: ['resource-deep-review'],
      preferredCapabilities: ['game-development', 'qa-release'],
    })
    expect(ranked[0].agent.id).toBe('deep')
  })

  it('infers domain reviewer requirements from the candidate (game / mcp / knowledge)', () => {
    const base: AiReviewQueueItem = {
      reviewId: 'rq-x', detectedState: 'NEW', path: 'Repositories/game-engine', probableName: 'game-engine',
      probableSourceRepo: null, probableResourceType: 'engine', detectedCapabilities: ['game-development'],
      inferredPrimaryCapability: 'game-development', coversCapabilityGaps: [], likelyOverlaps: [], runtimePathRisks: [],
      preliminaryQualityScore: 70, preliminaryAgentosRelevance: null, suggestedPlatoon: null, suggestedSpecialistRole: null,
      recommendedAction: 'NEEDS_DEEP_REVIEW', reviewStatus: 'PENDING', pending: true, promotionBatchId: null, approvedAt: null,
      finalApprovedDecision: null, currentCompetingResources: [], likelyDuplicates: [], highPriorityGap: null, readmeSnippet: null, raw: {},
    }
    const requirements = inferReviewerRequirements(base)
    expect(requirements.required).toEqual(['resource-deep-review'])
    expect(requirements.preferred).toContain('game-development')
    expect(requirements.preferred).toContain('qa-release')
    expect(requirements.preferred).not.toContain('resource-deep-review')
    const mcp = inferReviewerRequirements({ ...base, path: 'mcp/tool', detectedCapabilities: [], inferredPrimaryCapability: 'mcp' })
    expect(mcp.preferred).toEqual(expect.arrayContaining(['mcp', 'backend', 'security']))
    const knowledge = inferReviewerRequirements({ ...base, path: 'Knowledge Packets/research-pack', detectedCapabilities: ['knowledge-management'], inferredPrimaryCapability: 'knowledge-management' })
    expect(knowledge.preferred).toEqual(expect.arrayContaining(['research', 'knowledge-management']))
  })
})

describe('createDeepReviewMission', () => {
  it('creates a normal AgentOS review task with the canonical mission contract', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, actor: 'commander', root })
    expect(mission.taskId).toBeGreaterThan(0)
    expect(mission.routed).toBe(false)
    const task = taskById(mission.taskId)
    expect(task.status).toBe('inbox')
    // Phase 2 — the review belongs to the internal AgentOS Operations project,
    // never to an arbitrary user project, and is a normal objective mission.
    const ops = state.db!.prepare("SELECT id FROM projects WHERE slug = 'agentos-operations' AND workspace_id = 1").get() as any
    expect(ops).toBeTruthy()
    expect(task.project_id).toBe(ops.id)
    expect(JSON.parse(task.tags)).toContain('agentos-resource-review')
    const metadata = JSON.parse(task.metadata)
    const review = metadata.agentos_resource_review
    expect(review.review_id).toBe('rq-pending-newlib')
    expect(review.requested_action).toBe('deep-review')
    expect(review.required_output_schema).toBe(DEEP_REVIEW_OUTPUT_SCHEMA)
    expect(review.source).toBe('ai-arsenal')
    expect(review.state).toBe('ROUTED')
    expect(review.detected_state).toBe('NEW')
    expect(review.resource_path).toContain('new-tactical-lib')
    expect(review.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(review.objective_id).toBe(mission.objectiveId)
    expect(metadata.agentos.objectiveId).toBe(mission.objectiveId)
    expect(metadata.agentos.objectiveMission).toBe(true)
    expect(metadata.agentos.requiredCapabilities).toEqual(['resource-deep-review'])
    expect(metadata.agentos.preferredCapabilities.length).toBeGreaterThan(0)
    expect(metadata.agentos.disableInference).toBe(true)
    // Filtered registry snapshot, not the whole vault.
    expect(Array.isArray(review.authoritative_registry_snapshot.filtered)).toBe(true)
    expect(review.authoritative_registry_snapshot.total).toBe(4)
    // Objective row created through the normal Company Commander path + marker.
    const objective = state.db!.prepare('SELECT status, plan_json FROM agentos_objectives WHERE id = ?').get(mission.objectiveId!) as any
    expect(objective.status).toBe('planned')
    expect(JSON.parse(objective.plan_json).agentos_review_link.review_id).toBe('rq-pending-newlib')
    // Queue item linked to the mission + objective.
    const item = queueItem('rq-pending-newlib')
    expect(item.deep_review.status).toBe('ROUTED')
    expect(item.deep_review.task_id).toBe(mission.taskId)
    expect(item.deep_review.objective_id).toBe(mission.objectiveId)
    expect(item.deep_review.fingerprint).toBe(review.fingerprint)
  })

  it('routes through normal AgentOS project routing when an explicit active project is provided', () => {
    state.db!.prepare('INSERT INTO projects (id, name, slug, workspace_id, status, ticket_counter, ticket_prefix) VALUES (3, ?, ?, 1, ?, 40, ?)')
      .run('Review Project', 'review-project', 'active', 'REV')
    state.routeMock.mockReturnValue({
      routed: true, taskId: 0, projectId: 3,
      selected: { externalAgentId: 'ext-hermes', agentName: 'Hermes Reviewer', platoonId: 'hermes', routingAgentName: 'AgentOS Hermes Router', score: 87, reasons: ['Matched required: resource-deep-review'] },
    })
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, projectId: 3, actor: 'commander', root })
    expect(state.routeMock).toHaveBeenCalledWith(expect.objectContaining({ taskId: mission.taskId, workspaceId }))
    expect(mission.routed).toBe(true)
    expect(mission.projectId).toBe(3)
    const item = queueItem('rq-pending-newlib')
    expect(item.deep_review.routing.agentName).toBe('Hermes Reviewer')
    expect(item.deep_review.routing.platoonId).toBe('hermes')
    expect(item.deep_review.objective_id).toBe(mission.objectiveId)
    const task = taskById(mission.taskId)
    expect(task.project_id).toBe(3)
    expect(task.project_ticket_no).toBe(41)
    expect(task.status).toBe('inbox') // routing marks assigned_to; dispatch happens via scheduler
    const objective = state.db!.prepare('SELECT project_id FROM agentos_objectives WHERE id = ?').get(mission.objectiveId!) as any
    expect(objective.project_id).toBe(3)
  })

  it('refuses to spawn a duplicate mission while one is in flight', () => {
    createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    expect(() => createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root }))
      .toThrowError(/already routed/i)
    expect((state.db!.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c).toBe(1)
    expect((state.db!.prepare('SELECT COUNT(*) c FROM agentos_objectives').get() as any).c).toBe(1)
  })

  it('reuses the existing mission when retried after failure (no duplicate tasks)', () => {
    const first = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    // Simulate a failed review (invalid result ingestion).
    addComment(first.taskId, 'not json at all')
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(first.taskId)
    expect(ingestDeepReviewResult({ taskId: first.taskId, workspaceId, root }).status).toBe('INVALID_RESULT')
    const retried = retryDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    expect(retried.taskId).toBe(first.taskId)
    expect((state.db!.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c).toBe(1)
    const item = queueItem('rq-pending-newlib')
    expect(item.deep_review.status).toBe('ROUTED')
    expect(item.deep_review.retries).toBe(1)
    expect(item.deep_review.error).toBeNull()
  })
})

describe('structured output schema (agentos-resource-review-v1)', () => {
  it('parses a valid envelope with markers', () => {
    const parsed = parseAndValidateReviewOutput(validReviewEnvelope(), { reviewId: 'rq-pending-newlib', resourceId: null })
    expect(parsed.ok).toBe(true)
    expect(parsed.value?.quality_score).toBe(76)
    expect(parsed.value?.audit_status_recommendation).toBe('KEEP')
    expect(parsed.value?.auto_select_recommendation).toBe(true)
  })

  it('accepts a plain JSON object (no envelope markers)', () => {
    const json = JSON.stringify({ review_id: 'rq-pending-newlib', review_status: 'COMPLETE', actual_type: 'tool', quality_score: 50, confidence: 'MEDIUM', primary_capability: 'mcp', audit_status_recommendation: 'KEEP', auto_select_recommendation: true, manual_only_recommendation: false, proposed_registry_entry: {} })
    const parsed = parseAndValidateReviewOutput(json, { reviewId: 'rq-pending-newlib', resourceId: null })
    expect(parsed.ok).toBe(true)
  })

  it('rejects malformed JSON', () => {
    const parsed = parseAndValidateReviewOutput('this is not json', { reviewId: 'rq-pending-newlib', resourceId: null })
    expect(parsed.ok).toBe(false)
    expect(parsed.errors).toContain('Review result is not valid JSON')
  })

  it('rejects a mismatched review_id', () => {
    const parsed = parseAndValidateReviewOutput(validReviewEnvelope({ review_id: 'rq-someone-else' }), { reviewId: 'rq-pending-newlib', resourceId: null })
    expect(parsed.ok).toBe(false)
    expect(parsed.errors.some(e => e.includes('review_id mismatch'))).toBe(true)
  })

  it('rejects invalid enums and policy conflicts', () => {
    const badAudit = parseAndValidateReviewOutput(validReviewEnvelope({ audit_status_recommendation: 'MAYBE' }), { reviewId: 'rq-pending-newlib', resourceId: null })
    expect(badAudit.ok).toBe(false)
    const conflict = parseAndValidateReviewOutput(validReviewEnvelope({ manual_only_recommendation: true, auto_select_recommendation: true }), { reviewId: 'rq-pending-newlib', resourceId: null })
    expect(conflict.ok).toBe(false)
    const manualKeep = parseAndValidateReviewOutput(validReviewEnvelope({ manual_only_recommendation: true, audit_status_recommendation: 'KEEP', auto_select_recommendation: false }), { reviewId: 'rq-pending-newlib', resourceId: null })
    expect(manualKeep.ok).toBe(false) // manual-only requires REFERENCE audit status
  })
})

describe('ingestDeepReviewResult (Phase 7/9)', () => {
  it('ingests a valid review, marks the queue COMPLETE, and never auto-promotes', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    addComment(mission.taskId, validReviewEnvelope())
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(mission.taskId)

    const registryBefore = read(root, '_CATALOG/agentos_resource_registry.json')
    const result = ingestDeepReviewResult({ taskId: mission.taskId, workspaceId, root })
    expect(result.status).toBe('COMPLETE')
    expect(result.value?.primary_capability).toBe('tactical-encounters')

    const item = queueItem('rq-pending-newlib')
    expect(item.deep_review.status).toBe('COMPLETE')
    expect(item.deep_review.result.quality_score).toBe(76)
    expect(item.deep_review.proposal.registry_entry.name).toBe('newlib')
    // Still pending for the human — never promoted automatically.
    expect(item.review_status).toBe('PENDING')
    expect(item.pending).toBe(true)
    expect(read(root, '_CATALOG/agentos_resource_registry.json')).toBe(registryBefore)
    expect(getAiResourceRegistry(root).resources.length).toBe(4)

    // Task marked COMPLETE so reconcile won't reprocess it.
    const metadata = JSON.parse(taskById(mission.taskId).metadata)
    expect(metadata.agentos_resource_review.state).toBe('COMPLETE')
  })

  it('rejects malformed results and preserves the queue safely', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    addComment(mission.taskId, 'garbage')
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(mission.taskId)
    const registryBefore = read(root, '_CATALOG/agentos_resource_registry.json')
    const result = ingestDeepReviewResult({ taskId: mission.taskId, workspaceId, root })
    expect(result.status).toBe('INVALID_RESULT')
    expect(queueItem('rq-pending-newlib').deep_review.status).toBe('FAILED')
    expect(read(root, '_CATALOG/agentos_resource_registry.json')).toBe(registryBefore)
  })

  it('rejects a result from a different review (review_id mismatch at ingestion)', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    addComment(mission.taskId, validReviewEnvelope({ review_id: 'rq-other-review' }))
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(mission.taskId)
    const result = ingestDeepReviewResult({ taskId: mission.taskId, workspaceId, root })
    expect(result.status).toBe('INVALID_RESULT')
    expect(result.errors?.some(e => e.includes('review_id mismatch'))).toBe(true)
  })

  it('marks the review STALE when the resource changed during review (fingerprint)', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    addComment(mission.taskId, validReviewEnvelope())
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(mission.taskId)
    // Candidate changed mid-review: scanner now reports a different score/name.
    const queueDoc = JSON.parse(read(root, '_CATALOG/agentos_resource_review_queue.json'))
    const item = queueDoc.items.find((i: any) => i.review_id === 'rq-pending-newlib')
    item.probable_name = 'new-tactical-lib-v2'
    item.preliminary_quality_score = 88
    write(root, '_CATALOG/agentos_resource_review_queue.json', JSON.stringify(queueDoc, null, 2))

    const beforeFingerprint = normalizedItem('rq-pending-newlib')
    expect(computeReviewFingerprint(root, beforeFingerprint!)).not.toBe(JSON.parse(taskById(mission.taskId).metadata).agentos_resource_review.fingerprint)

    const result = ingestDeepReviewResult({ taskId: mission.taskId, workspaceId, root })
    expect(result.status).toBe('STALE')
    expect(queueItem('rq-pending-newlib').deep_review.status).toBe('STALE')
    expect(queueItem('rq-pending-newlib').deep_review.result).toBeUndefined()
    const metadata = JSON.parse(taskById(mission.taskId).metadata)
    expect(metadata.agentos_resource_review.state).toBe('STALE')
  })

  it('reconcile ingests completed reviews and ignores unrelated tasks', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    addComment(mission.taskId, validReviewEnvelope())
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(mission.taskId)
    // Unrelated native task in 'review' status must be untouched.
    state.db!.prepare("INSERT INTO tasks (title, status, metadata, workspace_id) VALUES (?, 'review', '{}', ?)")
      .run('plain native task', workspaceId)

    const result = reconcileDeepReviewMissions(root)
    expect(result.ingested).toBe(1)
    expect(queueItem('rq-pending-newlib').deep_review.status).toBe('COMPLETE')
    // Native Mission Control tasks are not review missions.
    expect(result.invalid).toBe(0)
  })

  it('sweeps running missions into RUNNING state', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    state.db!.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(mission.taskId)
    reconcileDeepReviewMissions(root)
    expect(queueItem('rq-pending-newlib').deep_review.status).toBe('RUNNING')
  })
})

describe('traceability + isolation', () => {
  it('links review queue item → task → delegation in the mission trace', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    state.db!.prepare(`INSERT INTO agentos_delegations (
      id, task_id, workspace_id, platoon_id, specialist_name, routing_agent_name, runtime_type,
      status, native_session_id, native_run_id, attempt, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, 1, 1700000000, 1700000000)`)
      .run('del-123', mission.taskId, workspaceId, 'hermes', 'Hermes Reviewer', 'AgentOS Hermes Router', 'hermes', 'sess-abc', 'run-xyz')

    const traces = listDeepReviewMissions(workspaceId)
    const trace = traces.find(t => t.reviewId === 'rq-pending-newlib')
    expect(trace).toBeTruthy()
    expect(trace?.delegation).toMatchObject({
      id: 'del-123',
      status: 'completed',
      runtimeType: 'hermes',
      nativeSessionId: 'sess-abc',
      nativeRunId: 'run-xyz',
      specialistName: 'Hermes Reviewer',
    })
  })

  it('keeps mission lists workspace-isolated', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId: 1, root })
    const metadata = JSON.parse(taskById(mission.taskId).metadata)
    metadata.agentos_resource_review.review_id = 'rq-other-workspace'
    state.db!.prepare('INSERT INTO tasks (title, status, metadata, workspace_id) VALUES (?, ?, ?, 2)')
      .run('Deep review: other', 'inbox', JSON.stringify(metadata))
    const inWorkspaceOne = listDeepReviewMissions(1)
    expect(inWorkspaceOne.some(t => t.reviewId === 'rq-other-workspace')).toBe(false)
  })

  it('preserves the human approval path after a completed review', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    addComment(mission.taskId, validReviewEnvelope())
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(mission.taskId)
    ingestDeepReviewResult({ taskId: mission.taskId, workspaceId, root })
    expect(queueItem('rq-pending-newlib').deep_review.status).toBe('COMPLETE')

    const result = performArsenalAction({
      action: 'approve',
      resourceId: 'rq-pending-newlib',
      root,
      actor: 'commander',
      payload: {
        promotion: {
          name: 'new-tactical-lib',
          primary_capability: 'tactical-encounters',
          quality_score: 76,
          audit_status: 'KEEP',
          auto_select_allowed: true,
          manual_only: false,
        },
      },
    })
    expect(result.ok).toBe(true)
    expect(queueItem('rq-pending-newlib').review_status).toBe('APPROVED')
    expect(getAiResourceRegistry(root).resources.some(r => r.id === 'res-new-tactical-lib')).toBe(true)
  })

  it('exposes review-queue items with the expanded deep-review state', () => {
    createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    const item = getAiReviewQueue(root).find(i => i.reviewId === 'rq-pending-newlib')
    expect(item?.deepReview?.status).toBe('ROUTED')
    expect(item?.deepReview?.taskId).toBeGreaterThan(0)
    expect(typeof item?.deepReview?.fingerprint).toBe('string')
  })
})

describe('deep-review objectives + NEEDS_MANUAL escalation (Company Commander lifecycle)', () => {
  const objectiveById = (id: number) => state.db!.prepare('SELECT * FROM agentos_objectives WHERE id = ?').get(id) as any
  const taskEscalation = (taskId: number) => {
    const record = JSON.parse(taskById(taskId).metadata).agentos_escalation || null
    return record?.resolved_at ? null : record
  }

  it('creates ONE internal AgentOS Operations project per workspace', () => {
    const first = getOrCreateAgentOSOperationsProject(1)
    const again = getOrCreateAgentOSOperationsProject(1)
    expect(again.id).toBe(first.id)
    const other = getOrCreateAgentOSOperationsProject(2)
    expect(other.id).not.toBe(first.id)
    expect(state.db!.prepare("SELECT COUNT(*) c FROM projects WHERE slug = 'agentos-operations'").get() as any).toEqual({ c: 2 })
  })

  it('links review queue item → internal objective → mission task → delegation (objective_id traced)', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    const delegation = createDelegationForTask({
      taskId: mission.taskId,
      projectId: mission.projectId,
      workspaceId,
      routingAgentName: 'AgentOS Router',
      runtimeType: 'hermes',
      metadata: taskById(mission.taskId).metadata,
    })
    expect(delegation.objectiveId).toBe(mission.objectiveId)
    const metadata = JSON.parse(taskById(mission.taskId).metadata)
    expect(metadata.agentos_delegation_id).toBe(delegation.id)
    const trace = listDeepReviewMissions(workspaceId).find(t => t.reviewId === 'rq-pending-newlib')
    expect(trace?.objectiveId).toBe(mission.objectiveId)
    expect(trace?.delegation?.id).toBe(delegation.id)
  })

  it('reconciles the objective to COMPLETED once the review mission completes', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    addComment(mission.taskId, validReviewEnvelope())
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(mission.taskId)
    expect(ingestDeepReviewResult({ taskId: mission.taskId, workspaceId, root }).status).toBe('COMPLETE')
    state.db!.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(mission.taskId)
    const changed = reconcileObjectiveStatuses({ workspaceId })
    expect(changed.some(c => c.objectiveId === mission.objectiveId && c.status === 'completed')).toBe(true)
    expect(objectiveById(mission.objectiveId!).status).toBe('completed')
  })

  it('a STALE review never counts as completed — the objective surfaces needs-manual', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    addComment(mission.taskId, validReviewEnvelope())
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(mission.taskId)
    // Resource changed mid-review (fingerprint mismatch).
    const queueDoc = JSON.parse(read(root, '_CATALOG/agentos_resource_review_queue.json'))
    const candidate = queueDoc.items.find((i: any) => i.review_id === 'rq-pending-newlib')
    candidate.probable_name = 'new-tactical-lib-v2'
    candidate.preliminary_quality_score = 88
    write(root, '_CATALOG/agentos_resource_review_queue.json', JSON.stringify(queueDoc, null, 2))

    expect(ingestDeepReviewResult({ taskId: mission.taskId, workspaceId, root }).status).toBe('STALE')
    const escalation = taskEscalation(mission.taskId)
    expect(escalation?.reason).toBe('stale_resource')
    expect(escalation?.category).toBe('STALE')
    expect(escalation?.recommended_actions).toContain('retry-review')
    expect(queueItem('rq-pending-newlib').deep_review.status).toBe('STALE') // result state preserved
    expect(queueItem('rq-pending-newlib').deep_review.escalation.reason).toBe('stale_resource')
    // Objective mirrored the escalation and will reconcile to needs_manual, not completed.
    expect(JSON.parse(objectiveById(mission.objectiveId!).plan_json).agentos_escalation.reason).toBe('stale_resource')
    reconcileObjectiveStatuses({ workspaceId })
    expect(objectiveById(mission.objectiveId!).status).toBe('needs_manual')
  })

  it('retries invalid output, then exhausts the budget → NEEDS_MANUAL → manual retry resolves it (same lineage)', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    const attemptInvalid = () => {
      addComment(mission.taskId, 'not json at all')
      state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(mission.taskId)
      return ingestDeepReviewResult({ taskId: mission.taskId, workspaceId, root }).status
    }
    expect(attemptInvalid()).toBe('INVALID_RESULT')
    expect(queueItem('rq-pending-newlib').deep_review.invalid_attempts).toBe(1)
    // One-off invalid output is retryable, not escalated.
    expect(applyDeepReviewEscalationPolicy(root).escalated).toHaveLength(0)

    const retried = retryDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    expect(retried.taskId).toBe(mission.taskId)
    expect(queueItem('rq-pending-newlib').deep_review.retries).toBe(1)

    // Second invalid output exhausts the retry budget.
    expect(attemptInvalid()).toBe('INVALID_RESULT')
    const item = queueItem('rq-pending-newlib')
    expect(item.deep_review.status).toBe('NEEDS_MANUAL')
    expect(item.deep_review.escalated_reason).toBe('invalid_structured_output')
    const escalation = taskEscalation(mission.taskId)
    expect(escalation?.reason).toBe('invalid_structured_output')
    expect(escalation?.attempts).toBe(2)
    expect(escalation?.recommended_actions).toEqual(expect.arrayContaining(['retry-review']))
    // Activity trail recorded with objective linkage.
    expect(state.activities.some((args: any) =>
      args[0] === 'agentos_escalation_needs_manual' && args[2] === mission.taskId && args[5]?.objective_id === mission.objectiveId)).toBe(true)
    // Objective visibly blocked/escalated, never completed.
    reconcileObjectiveStatuses({ workspaceId })
    expect(objectiveById(mission.objectiveId!).status).toBe('needs_manual')
    expect(JSON.parse(objectiveById(mission.objectiveId!).plan_json).agentos_escalation.state).toBe('NEEDS_MANUAL')

    // Manual retry preserves lineage, clears escalation, objective unblocks.
    const retriedAgain = retryDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root, actor: 'commander' })
    expect(retriedAgain.taskId).toBe(mission.taskId)
    const after = queueItem('rq-pending-newlib')
    expect(after.deep_review.status).toBe('ROUTED')
    expect(after.deep_review.escalated_reason).toBeNull()
    expect(taskEscalation(mission.taskId)).toBeNull()
    expect(state.activities.some((args: any) => args[0] === 'agentos_escalation_resolved')).toBe(true)
    reconcileObjectiveStatuses({ workspaceId })
    expect(objectiveById(mission.objectiveId!).status).not.toBe('needs_manual')
  })

  it('classifies failures into retryable / manual-required / stale / waiting-approval / terminal', () => {
    expect(classifyEscalation('concurrency_blocked_too_long')).toBe('RETRYABLE')
    expect(classifyEscalation('invalid_structured_output')).toBe('MANUAL_REQUIRED')
    expect(classifyEscalation('stale_resource')).toBe('STALE')
    expect(classifyEscalation('approval_required')).toBe('WAITING_APPROVAL')
    expect(classifyEscalation('unsupported_action')).toBe('TERMINAL_FAILURE')
  })

  it('escalates a failed dispatch with a missing-resource error immediately (NEEDS_MANUAL)', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    state.db!.prepare(`INSERT INTO agentos_delegations (id, task_id, workspace_id, status, error_message, created_at, updated_at, attempt)
      VALUES ('del-fail', ?, ?, 'failed', 'workdir not found for resource', 1700000000, 1700000000, 1)`).run(mission.taskId, workspaceId)
    state.db!.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(mission.taskId)
    const result = reconcileDeepReviewMissions(root)
    expect(result.escalated).toBe(1)
    expect(queueItem('rq-pending-newlib').deep_review.status).toBe('NEEDS_MANUAL')
    expect(queueItem('rq-pending-newlib').deep_review.escalated_reason).toBe('missing_resource')
    expect(JSON.parse(taskById(mission.taskId).metadata).agentos_escalation.reason).toBe('missing_resource')
  })

  it('keeps a one-off dispatch failure retryable without escalating', () => {
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, root })
    state.db!.prepare(`INSERT INTO agentos_delegations (id, task_id, workspace_id, status, error_message, created_at, updated_at, attempt)
      VALUES ('del-fail2', ?, ?, 'failed', 'timeout after 30s', 1700000000, 1700000000, 1)`).run(mission.taskId, workspaceId)
    state.db!.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(mission.taskId)
    const policy = applyDeepReviewEscalationPolicy(root)
    expect(policy.escalated).toHaveLength(0)
    expect(policy.retryable).toBe(1)
    expect(queueItem('rq-pending-newlib').deep_review.status).toBe('ROUTED')
  })

  it('keeps review objectives and operations projects workspace-isolated', () => {
    createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId: 1, root })
    const other = createDeepReviewMission({ reviewId: 'rq-pending-weak-skill', workspaceId: 2, root })
    expect(other.objectiveId).not.toBeNull()
    expect((state.db!.prepare('SELECT COUNT(*) c FROM agentos_objectives WHERE workspace_id = 1').get() as any).c).toBe(1)
    expect((state.db!.prepare('SELECT COUNT(*) c FROM agentos_objectives WHERE workspace_id = 2').get() as any).c).toBe(1)
    expect((state.db!.prepare("SELECT COUNT(*) c FROM projects WHERE slug='agentos-operations' AND workspace_id=1").get() as any).c).toBe(1)
    expect((state.db!.prepare("SELECT COUNT(*) c FROM projects WHERE slug='agentos-operations' AND workspace_id=2").get() as any).c).toBe(1)
    const traces1 = listDeepReviewMissions(1)
    expect(traces1.some(t => t.reviewId === 'rq-pending-weak-skill')).toBe(false)
    const traces2 = listDeepReviewMissions(2)
    expect(traces2.some(t => t.reviewId === 'rq-pending-newlib')).toBe(false)
  })

  it('honors an explicit active-project override (manual authority preserved)', () => {
    state.db!.prepare("INSERT INTO projects (id, name, slug, workspace_id, status, ticket_counter, ticket_prefix) VALUES (9, 'User Game', 'user-game', 1, 'active', 5, 'UG')").run()
    const mission = createDeepReviewMission({ reviewId: 'rq-pending-newlib', workspaceId, projectId: 9, root })
    expect(mission.projectId).toBe(9)
    expect(taskById(mission.taskId).project_id).toBe(9)
    expect(objectiveById(mission.objectiveId!).project_id).toBe(9)
  })
})
