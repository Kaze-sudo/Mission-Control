import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCanonicalVault, read, rmRoot, tmpRoot, write } from './helpers/ai-arsenal-fixtures'
import { rankAgentsForMission } from '@/lib/agent-selection'
import { inferMissionIntent } from '@/lib/mission-intent'
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
  createKnowledgeSuiteObjective,
  ingestKnowledgeMissionResult,
  retryKnowledgeMission,
  reconcileKnowledgeCuration,
  getKnowledgeSuiteState,
  KNOWLEDGE_SUITE_ID,
  KNOWLEDGE_PACK_OUTPUT_SCHEMA,
  KNOWLEDGE_VALIDATION_OUTPUT_SCHEMA,
  PACK_ENVELOPE_START,
  PACK_ENVELOPE_END,
  VALIDATION_ENVELOPE_START,
  VALIDATION_ENVELOPE_END,
  KNOWLEDGE_PACK_SPECS,
  choosePackSourceAttachments,
  chooseSourceAttachments,
  findClaimViolations,
  verbatimCodeRatio,
  KNOWLEDGE_CURATION_CAPABILITY,
  defaultStagingDir,
  defaultOutputDir,
  type AgentOSKnowledgePackV1,
  type AgentOSKnowledgeValidationV1,
} from '@/lib/knowledge-curation'
import { getAiResourceRegistry } from '@/lib/ai-resource-registry'
import { getOrCreateAgentOSOperationsProject } from '@/lib/agentos-operations'
import { createDelegationForTask, updateDelegation } from '@/lib/delegation-ledger'
import { promoteReadyObjectiveMissions, reconcileObjectiveStatuses } from '@/lib/objective-planning'

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
    CREATE TABLE agentos_project_command (
      project_id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL,
      state TEXT, updated_at INTEGER
    );
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY, name TEXT, isolation TEXT NOT NULL DEFAULT 'shared'
    );
  `)
  state.db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (?, ?, ?)').run(1, 'One', 'shared')
  state.db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (?, ?, ?)').run(2, 'Two', 'shared')
}

function taskById(id: number): any {
  return state.db!.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
}
function setProjectCommand(projectId: number, cmdState: string, wsId = workspaceId): void {
  state.db!.prepare(
    `INSERT INTO agentos_project_command (project_id, workspace_id, state, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(project_id) DO UPDATE SET state = excluded.state, updated_at = unixepoch()`
  ).run(projectId, wsId, cmdState)
}
function addComment(taskId: number, content: string, author = 'specialist-gamut') {
  state.db!.prepare('INSERT INTO comments (task_id, author, content, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, author, content, Math.floor(Date.now() / 1000), workspaceId)
}

/**
 * Binds a delegation to the task's current execution attempt (as the normal
 * dispatch claim does via createDelegationForTask) and completes it with the
 * given output. Automatic reconcileKnowledgeCuration only ever consumes the
 * completed delegation bound to the CURRENT attempt — comments and older
 * delegations are audit history, not result input.
 */
function bindCompletedDelegation(taskId: number, projectId: number | null, text: string, wsId = workspaceId): string {
  const row = state.db!.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, wsId) as { metadata: string | null }
  const delegation = createDelegationForTask({
    taskId,
    projectId,
    workspaceId: wsId,
    routingAgentName: 'AgentOS Router',
    runtimeType: 'hermes',
    metadata: row.metadata,
  })
  updateDelegation(delegation.id, wsId, { status: 'completed', resultSummary: text, completed: true })
  return delegation.id
}

/** Valid original content that avoids factual/verbatim violations. */
const GOOD_CONTENT = [
  '## Encounter anatomy',
  'A tactical encounter is authored around a lifecycle: the setup phase defines sides, deployment zones and',
  'the turn model before play begins. During resolution the tactical state carries unit positions, action',
  'budgets and side order. Victory and defeat conditions are evaluated after each turn against the scenario',
  'objective rather than on a fixed timer, which keeps pacing in the hands of the designer.',
  '',
  '### Reinforcement pacing',
  'Reinforcements should be budgeted against a difficulty curve: early waves arrive when the player still holds',
  'the initiative, later waves appear only after objective progress. An orchestration layer can gate waves on',
  'state transitions such as capturing a flag or losing a key unit, which produces readable encounter',
  'progression without scripted timers.',
  '',
  '### Balancing inputs',
  'Expose difficulty inputs as data: unit budgets, recruit lists, and terrain composition. A designer tunes an',
  'encounter by adjusting those budgets rather than editing individual AI routines. This separation keeps the',
  'authoring surface small and the tactical state legible to tooling and tests alike.',
].join('\n')

function validPackEnvelope(packId: string, overrides: Record<string, unknown> = {}): string {
  const payload: Record<string, unknown> = {
    schema: KNOWLEDGE_PACK_OUTPUT_SCHEMA,
    pack_id: packId,
    title: overrides.title ?? 'Knowledge pack',
    purpose: 'Reusable patterns for tactical encounter authoring derived from approved AgentOS resources.',
    capabilities: ['tactical-encounters', 'game-development'],
    intended_specialist_roles: ['tactical-battles-encounter-designer'],
    source_claims: overrides.source_claims ?? [
      { resource_id: 'res-tactical-wesnoth-framework', accessed: false, usage: 'reference-summary', notes: 'registry summary + prior deep review' },
      { resource_id: 'res-tactical-oxce-reference', accessed: false, usage: 'reference-only', notes: 'audit notes; original assets not required for curation' },
    ],
    content_markdown: overrides.content_markdown ?? GOOD_CONTENT,
    provenance: overrides.provenance ?? {
      reviewed_sources: ['registry entry res-tactical-wesnoth-framework', 'capability index tactical-encounters'],
      generated_by: 'Gamut specialist',
    },
    limitations: overrides.limitations ?? ['Wesnoth is hex-based and does not provide true cover/elevation/LOS', 'OXCE is reference/manual-only and not an automatic runtime dependency'],
    warnings: [],
    ...overrides,
  }
  return `${PACK_ENVELOPE_START}\n${JSON.stringify(payload, null, 2)}\n${PACK_ENVELOPE_END}`
}

const PACK_IDS = KNOWLEDGE_PACK_SPECS.filter(spec => spec.key !== 'm6').map(spec => spec.packId)

function validValidationEnvelope(overrides: Record<string, unknown> = {}): string {
  const payload: Record<string, unknown> = {
    schema: KNOWLEDGE_VALIDATION_OUTPUT_SCHEMA,
    suite_id: KNOWLEDGE_SUITE_ID,
    suite_verdict: 'PASS',
    per_pack_verdicts: PACK_IDS.map(packId => ({ pack_id: packId, verdict: 'PASS', issues: [] })),
    report_markdown:
      'Suite validation read all five staged packs. Formatting is consistent, internal cross-links resolve, ' +
      'source attribution is present in every pack, limitations match the authoritative audit (Wesnoth hex-only, ' +
      'OXCE manual reference), and no large verbatim source blocks were found. The packs are usable by AgentOS ' +
      'specialists as reference material.',
    warnings: [],
    ...overrides,
  }
  return `${VALIDATION_ENVELOPE_START}\n${JSON.stringify(payload, null, 2)}\n${VALIDATION_ENVELOPE_END}`
}

function completePack(packId: string, taskId: number, text?: string): void {
  addComment(taskId, text ?? validPackEnvelope(packId))
  expect(ingestKnowledgeMissionResult({ taskId, workspaceId, root }).status).toBe('COMPLETE')
  state.db!.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId)
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

describe('knowledge-curation capability routing', () => {
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

  it('requires knowledge-curation; a tactical domain specialist outranks a generic writer', () => {
    const curator = agent({ id: 'curator', name: 'Encounter Curator', role: 'Tactical Knowledge Curator', capabilities: { tags: ['knowledge-curation', 'tactical-encounters', 'game-development'], source: 'declared' } })
    const generic = agent({ id: 'writer', name: 'Generic Writer', role: 'Documentation writer', capabilities: { tags: ['documentation'], source: 'declared' } })
    const ranked = rankAgentsForMission([generic, curator], {
      requiredCapabilities: ['knowledge-curation'],
      preferredCapabilities: ['tactical-encounters', 'game-development'],
    })
    expect(ranked.find(c => c.agent.id === 'curator')?.eligible).toBe(true)
    expect(ranked.find(c => c.agent.id === 'writer')?.eligible).toBe(false)
    expect(ranked[0].agent.id).toBe('curator')
  })

  it('matches knowledge-curation through roster keyword + intent inference', () => {
    expect(inferMissionIntent('Curate knowledge pack for tactical encounters').requirements.requiredCapabilities)
      .toContain(KNOWLEDGE_CURATION_CAPABILITY)
    expect(inferMissionIntent('Build a reference knowledge base on enemy AI').requirements.requiredCapabilities)
      .toContain(KNOWLEDGE_CURATION_CAPABILITY)
  })
})

describe('createKnowledgeSuiteObjective', () => {
  it('creates the internal ops objective with M1–M6; M6 depends on M1–M5 and stays backlog', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, actor: 'commander', root })
    expect(suite.suiteId).toBe(KNOWLEDGE_SUITE_ID)
    expect(suite.missions).toHaveLength(6)
    const ops = state.db!.prepare("SELECT id FROM projects WHERE slug = 'agentos-operations' AND workspace_id = 1").get() as any
    expect(ops).toBeTruthy()
    expect(suite.projectId).toBe(ops.id)
    expect((state.db!.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c).toBe(6)

    for (const key of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      const mission = suite.missions.find(m => m.key === key)!
      const task = taskById(mission.taskId)
      expect(task.status).toBe('inbox')
      expect(task.project_id).toBe(ops.id)
      const metadata = JSON.parse(task.metadata)
      expect(metadata.agentos.requiredCapabilities).toContain(KNOWLEDGE_CURATION_CAPABILITY)
      expect(metadata.agentos_knowledge_curation.suite_id).toBe(KNOWLEDGE_SUITE_ID)
      expect(metadata.agentos_knowledge_curation.schema).toBe(KNOWLEDGE_PACK_OUTPUT_SCHEMA)
      expect(metadata.agentos_knowledge_curation.objective_id).toBe(suite.objectiveId)
      expect(metadata.agentos_resources.length).toBeGreaterThan(0)
    }
    const m6 = suite.missions.find(m => m.key === 'm6')!
    expect(m6.dependsOnKeys).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    const m6Task = taskById(m6.taskId)
    expect(m6Task.status).toBe('backlog')
    const m6Metadata = JSON.parse(m6Task.metadata)
    expect(m6Metadata.agentos.dependsOnTaskIds).toHaveLength(5)
    expect(m6Metadata.agentos.executionState).toBe('blocked')
    expect(m6Metadata.agentos_knowledge_curation.schema).toBe(KNOWLEDGE_VALIDATION_OUTPUT_SCHEMA)
    expect(m6Metadata.agentos_knowledge_curation.pack_id).toBe('kp-suite-validation')

    const objective = state.db!.prepare('SELECT plan_json FROM agentos_objectives WHERE id = ?').get(suite.objectiveId) as any
    const plan = JSON.parse(objective.plan_json)
    expect(plan.agentos_knowledge_suite.suite_id).toBe(KNOWLEDGE_SUITE_ID)
    expect(plan.agentos_knowledge_suite.state).toBe('PLANNED')
    expect(plan.agentos_knowledge_suite.missions).toHaveLength(6)
    expect(plan.missions.find((m: any) => m.key === 'm6').dependsOnKeys).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
  })

  it('refuses a duplicate suite objective (one objective, six tasks)', () => {
    createKnowledgeSuiteObjective({ workspaceId, root })
    expect(() => createKnowledgeSuiteObjective({ workspaceId, root })).toThrowError(/already exists/i)
    expect((state.db!.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c).toBe(6)
    expect((state.db!.prepare('SELECT COUNT(*) c FROM agentos_objectives').get() as any).c).toBe(1)
  })

  it('routes M1–M5 through normal project routing with the knowledge-curation demand', () => {
    state.db!.prepare("INSERT INTO projects (id, name, slug, workspace_id, status, ticket_counter, ticket_prefix) VALUES (3, 'User Project', 'user-proj', 1, 'active', 20, 'UP')").run()
    state.routeMock.mockReturnValue({
      routed: true, taskId: 0, projectId: 3,
      selected: { externalAgentId: 'ext-curator', agentName: 'Hermes Curator', platoonId: 'knowledge', routingAgentName: 'AgentOS Hermes Router', score: 90, reasons: ['Matched required: knowledge-curation'] },
    })
    const suite = createKnowledgeSuiteObjective({ workspaceId, projectId: 3, root })
    expect(suite.projectId).toBe(3)
    expect(state.routeMock).toHaveBeenCalledWith(expect.objectContaining({ taskId: suite.missions[0].taskId, workspaceId }))
    // The mission task carries the knowledge-curation demand for the router.
    expect(JSON.parse(taskById(suite.missions[0].taskId).metadata).agentos.requiredCapabilities).toContain(KNOWLEDGE_CURATION_CAPABILITY)
    expect(taskById(suite.missions[0].taskId).project_id).toBe(3)
    expect((state.db!.prepare('SELECT project_id FROM agentos_objectives WHERE id = ?').get(suite.objectiveId) as any).project_id).toBe(3)
  })

  it('keeps suite objectives workspace-isolated', () => {
    const one = createKnowledgeSuiteObjective({ workspaceId: 1, root })
    const two = createKnowledgeSuiteObjective({ workspaceId: 2, root })
    expect(two.objectiveId).not.toBe(one.objectiveId)
    expect((state.db!.prepare('SELECT COUNT(*) c FROM tasks WHERE workspace_id = 1').get() as any).c).toBe(6)
    expect((state.db!.prepare('SELECT COUNT(*) c FROM tasks WHERE workspace_id = 2').get() as any).c).toBe(6)
    expect(getKnowledgeSuiteState(1).missions).toHaveLength(6)
    expect(getKnowledgeSuiteState(1).missions.some(m => m.objectiveId === two.objectiveId)).toBe(false)
    expect((state.db!.prepare("SELECT COUNT(*) c FROM projects WHERE slug='agentos-operations' AND workspace_id=1").get() as any).c).toBe(1)
    expect((state.db!.prepare("SELECT COUNT(*) c FROM projects WHERE slug='agentos-operations' AND workspace_id=2").get() as any).c).toBe(1)
  })
})

describe('source-resource policy', () => {
  it('auto-selects Wesnoth for tactical-encounters and never auto-selects OXCE', () => {
    const attachments = chooseSourceAttachments(['tactical-encounters'], root)
    const ids = attachments.map(a => a.resource_id)
    expect(ids).toContain('res-tactical-wesnoth-framework')
    expect(ids).not.toContain('res-tactical-oxce-reference')
    expect(attachments.find(a => a.resource_id === 'res-tactical-wesnoth-framework')?.manual_only).toBe(false)
  })

  it('attaches OXCE only through an explicit reference allowlist and keeps it manual-only', () => {
    const automatic = chooseSourceAttachments(['tactical-encounters', 'turn-state-engine'], root)
    expect(automatic.map(a => a.resource_id)).toEqual(expect.arrayContaining(['res-tactical-wesnoth-framework', 'res-tactical-boardgame-io']))
    expect(automatic.map(a => a.resource_id)).not.toContain('res-tactical-oxce-reference')
    const explicit = chooseSourceAttachments(['tactical-encounters'], root, { referenceResourceIds: ['res-tactical-oxce-reference'] })
    const oxce = explicit.find(a => a.resource_id === 'res-tactical-oxce-reference')!
    expect(oxce).toBeTruthy()
    expect(oxce.manual_only).toBe(true)
    expect(oxce.explicitly_selected).toBe(true)
    expect(oxce.usage).toBe('reference-only')
    // The global gate is untouched.
    expect(getAiResourceRegistry(root).resources.find(r => r.id === 'res-tactical-oxce-reference')?.autoSelectAllowed).toBe(false)
  })

  it('never attaches a REJECT resource even when explicitly referenced', () => {
    const attachments = chooseSourceAttachments(['enemy-ai'], root, { referenceResourceIds: ['res-gdev-ai'] })
    expect(attachments.map(a => a.resource_id)).not.toContain('res-gdev-ai')
  })

  it('per-pack curation sources include the pack reference allowlist', () => {
    const m1 = KNOWLEDGE_PACK_SPECS.find(spec => spec.key === 'm1')!
    const m2 = KNOWLEDGE_PACK_SPECS.find(spec => spec.key === 'm2')!
    const pack1 = choosePackSourceAttachments(m1, root)
    expect(pack1.map(a => a.resource_id)).toEqual(expect.arrayContaining(['res-tactical-wesnoth-framework', 'res-tactical-oxce-reference']))
    const pack2 = choosePackSourceAttachments(m2, root)
    expect(pack2.map(a => a.resource_id)).toEqual(expect.arrayContaining(['res-tactical-boardgame-io']))
  })
})

describe('content + claim validation', () => {
  it('flags unsupported claims: Wesnoth cover/elevation/LOS, OXCE auto-runtime, boardgame.io as provider', () => {
    expect(findClaimViolations('Wesnoth provides true cover and elevation modeling for encounter authoring.')).toHaveLength(1)
    expect(findClaimViolations('OXCE can be wired up as an automatic runtime dependency for new encounters.')).toHaveLength(1)
    expect(findClaimViolations('boardgame.io implements tactical-encounters maps and terrain natively.')).toHaveLength(1)
    // Negated statements are fine.
    expect(findClaimViolations('Wesnoth does not provide true cover or line-of-sight; it is hex-based.')).toHaveLength(0)
    expect(findClaimViolations('OXCE is reference-only and is not an automatic runtime dependency.')).toHaveLength(0)
  })

  it('measures verbatim code reproduction', () => {
    const prose = GOOD_CONTENT
    expect(verbatimCodeRatio(prose)).toBeLessThanOrEqual(0.4)
    const copy = ['```cpp', '#include <iostream>', 'int main() { return 0; }', '```', '```cpp', 'int main() { return 0; }', '```'].join('\n')
    expect(verbatimCodeRatio(copy)).toBeGreaterThan(0.4)
  })
})

describe('ingestKnowledgeMissionResult', () => {
  it('validates + stages a pack (M1) and never writes to the final output or registry', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m1 = suite.missions.find(m => m.key === 'm1')!
    addComment(m1.taskId, validPackEnvelope(m1.packId))
    const registryBefore = read(root, '_CATALOG/agentos_resource_registry.json')

    const result = ingestKnowledgeMissionResult({ taskId: m1.taskId, workspaceId, root })
    expect(result.status).toBe('COMPLETE')
    expect(result.stagedPath).toBeTruthy()
    const stagingDir = defaultStagingDir(root)
    expect(fs.existsSync(path.join(stagingDir, 'tactical-encounter-design-patterns.md'))).toBe(true)
    const written = fs.readFileSync(path.join(stagingDir, 'tactical-encounter-design-patterns.md'), 'utf8')
    expect(written).toContain('# Knowledge pack')
    expect(written).toContain(`objective_id: ${suite.objectiveId}`)
    expect(written).toContain('res-tactical-wesnoth-framework')
    // Finalization only happens at M6 — no final dir yet.
    expect(fs.existsSync(path.join(defaultOutputDir(root), 'manifest.json'))).toBe(false)
    expect(read(root, '_CATALOG/agentos_resource_registry.json')).toBe(registryBefore)
    const metadata = JSON.parse(taskById(m1.taskId).metadata)
    expect(metadata.agentos_knowledge_curation.state).toBe('COMPLETE')
    expect(metadata.agentos_knowledge_curation.staged_path).toContain('tactical-encounter-design-patterns.md')
  })

  it('rejects malformed JSON and mismatched pack_id safely', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m2 = suite.missions.find(m => m.key === 'm2')!
    addComment(m2.taskId, 'not json at all')
    expect(ingestKnowledgeMissionResult({ taskId: m2.taskId, workspaceId, root }).status).toBe('INVALID_RESULT')
    expect(JSON.parse(taskById(m2.taskId).metadata).agentos_knowledge_curation.state).toBe('FAILED')

    addComment(m2.taskId, validPackEnvelope('kp-someone-else'))
    const mismatch = ingestKnowledgeMissionResult({ taskId: m2.taskId, workspaceId, root })
    expect(mismatch.status).toBe('INVALID_RESULT')
    expect(mismatch.errors?.some(e => e.includes('pack_id mismatch'))).toBe(true)
  })

  it('rejects an inaccessible-source claim (accessed true on a path that does not exist)', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m3 = suite.missions.find(m => m.key === 'm3')!
    addComment(m3.taskId, validPackEnvelope(m3.packId, {
      source_claims: [{ resource_id: 'res-tactical-wesnoth-framework', accessed: true, usage: 'reference-summary' }],
    }))
    const result = ingestKnowledgeMissionResult({ taskId: m3.taskId, workspaceId, root })
    expect(result.status).toBe('INVALID_RESULT')
    expect(result.errors?.some(e => e.includes('path is inaccessible'))).toBe(true)
  })

  it('rejects content that contradicts authoritative limitations', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m3 = suite.missions.find(m => m.key === 'm3')!
    addComment(m3.taskId, validPackEnvelope(m3.packId, {
      content_markdown: GOOD_CONTENT + '\n\nWesnoth provides full cover and elevation line-of-sight simulation, so no other engine is needed.\n',
    }))
    const result = ingestKnowledgeMissionResult({ taskId: m3.taskId, workspaceId, root })
    expect(result.status).toBe('INVALID_RESULT')
    expect(result.errors?.some(e => e.includes('Wesnoth provides true cover'))).toBe(true)
  })

  it('rejects wholesale verbatim reproduction', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m4 = suite.missions.find(m => m.key === 'm4')!
    const leakedSourceLines = [
      '#include "map.hpp"',
      'void Terrain::render() { for (auto& t : tiles) { draw(t); } }',
      'void Terrain::update() { for (auto& t : tiles) { t.tick(dt); } }',
      'struct SpawnPoint { int x; int y; SideId side; };',
      'void Spawner::emit_wave(int wave, const WaveDef& def) {',
      '  for (const auto& entry : def.entries) {',
      '    place(entry.unit, entry.point);',
      '  }',
      '}',
      'int MovementCost(Terrain t) { return table[t.kind]; }',
      'bool LOS(Unit a, Unit b) { return raytrace(a.pos, b.pos); }',
      'void AiThinker::plan() { score_targets(); choose_move(); }',
      'class TurnState { SideId current; int phase; };',
    ]
    const leaked = [
      '## Brief context',
      'The original implementation exposes these structures; the full module is far larger.',
      '```cpp',
      ...leakedSourceLines,
      '```',
      '',
      'And again wholesale:',
      '```cpp',
      ...leakedSourceLines,
      '```',
      '',
      '## Verbatim section',
      '```cpp',
      ...leakedSourceLines,
      '```',
    ].join('\n')
    addComment(m4.taskId, validPackEnvelope(m4.packId, { content_markdown: leaked }))
    const result = ingestKnowledgeMissionResult({ taskId: m4.taskId, workspaceId, root })
    expect(result.status).toBe('INVALID_RESULT')
    expect(result.errors?.some(e => e.includes('verbatim'))).toBe(true)
  })

  it('does not ingest for unrelated native tasks', () => {
    const inserted = state.db!.prepare("INSERT INTO tasks (title, status, metadata, workspace_id) VALUES (?, 'review', '{}', ?)").run('plain native task', workspaceId)
    expect(ingestKnowledgeMissionResult({ taskId: Number(inserted.lastInsertRowid), workspaceId, root }).status).toBe('NOT_A_CURATION_TASK')
  })
})

describe('retry vs escalate', () => {
  it('escalates repeated invalid output to NEEDS_MANUAL, then a manual retry resolves it on the same task', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m5 = suite.missions.find(m => m.key === 'm5')!
    const attemptInvalid = () => {
      addComment(m5.taskId, 'this is not structured output')
      return ingestKnowledgeMissionResult({ taskId: m5.taskId, workspaceId, root }).status
    }
    expect(attemptInvalid()).toBe('INVALID_RESULT')
    expect(JSON.parse(taskById(m5.taskId).metadata).agentos_knowledge_curation.invalid_attempts).toBe(1)
    // One-off invalid output is retryable — no escalation yet.
    expect(reconcileKnowledgeCuration(root).escalated).toBe(0)

    expect(attemptInvalid()).toBe('INVALID_RESULT')
    const block = JSON.parse(taskById(m5.taskId).metadata).agentos_knowledge_curation
    expect(block.state).toBe('NEEDS_MANUAL')
    expect(block.escalated_reason).toBe('invalid_structured_output')
    const escalation = JSON.parse(taskById(m5.taskId).metadata).agentos_escalation
    expect(escalation.reason).toBe('invalid_structured_output')
    expect(escalation.recommended_actions).toContain('retry-review')
    expect(state.activities.some((args: any) => args[0] === 'agentos_escalation_needs_manual' && args[5]?.objective_id === suite.objectiveId)).toBe(true)
    // Objective surfaces needs-manual — never completed.
    reconcileObjectiveStatuses({ workspaceId })
    expect((state.db!.prepare('SELECT status FROM agentos_objectives WHERE id = ?').get(suite.objectiveId) as any).status).toBe('needs_manual')

    // Manual retry — same lineage, escalation cleared.
    const retried = retryKnowledgeMission({ packId: m5.packId, workspaceId, root, actor: 'commander' })
    expect(retried.taskId).toBe(m5.taskId)
    expect(retried.objectiveId).toBe(suite.objectiveId)
    const afterRetry = JSON.parse(taskById(m5.taskId).metadata)
    expect(afterRetry.agentos_knowledge_curation.state).toBe('ROUTED')
    expect(afterRetry.agentos_escalation?.resolved_at).toBeTruthy()
    expect(state.activities.some((args: any) => args[0] === 'agentos_escalation_resolved')).toBe(true)

    // Successful result resolves and completes the pack.
    completePack(m5.packId, m5.taskId)
    expect(JSON.parse(taskById(m5.taskId).metadata).agentos_knowledge_curation.state).toBe('COMPLETE')
    reconcileObjectiveStatuses({ workspaceId })
    expect((state.db!.prepare('SELECT status FROM agentos_objectives WHERE id = ?').get(suite.objectiveId) as any).status).not.toBe('needs_manual')
  })

  it('keeps a one-off dispatch failure retryable without escalating', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m1 = suite.missions.find(m => m.key === 'm1')!
    state.db!.prepare(`INSERT INTO agentos_delegations (id, task_id, workspace_id, status, error_message, created_at, updated_at, attempt)
      VALUES ('del-timeout', ?, ?, 'failed', 'timeout after 30s', 1700000000, 1700000000, 1)`).run(m1.taskId, workspaceId)
    state.db!.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(m1.taskId)
    const policy = reconcileKnowledgeCuration(root)
    expect(policy.escalated).toBe(0)
    expect(policy.retryable).toBeGreaterThan(0)
    expect(JSON.parse(taskById(m1.taskId).metadata).agentos_knowledge_curation.state).toBe('ROUTED')
  })

  it('escalates missing-resource dispatch failure immediately', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m2 = suite.missions.find(m => m.key === 'm2')!
    state.db!.prepare(`INSERT INTO agentos_delegations (id, task_id, workspace_id, status, error_message, created_at, updated_at, attempt)
      VALUES ('del-missing', ?, ?, 'failed', 'source path not found for resource', 1700000000, 1700000000, 1)`).run(m2.taskId, workspaceId)
    state.db!.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(m2.taskId)
    const result = reconcileKnowledgeCuration(root)
    expect(result.escalated).toBe(1)
    const escalation = JSON.parse(taskById(m2.taskId).metadata).agentos_escalation
    expect(escalation.reason).toBe('missing_resource')
    expect(escalation.category).toBe('MANUAL_REQUIRED')
    expect(escalation.recommended_actions).toEqual(expect.arrayContaining(['rescan-resource']))
    expect(JSON.parse(taskById(m2.taskId).metadata).agentos_knowledge_curation.state).toBe('NEEDS_MANUAL')
  })
})

describe('M6 finalization gate + manifest', () => {
  function suiteWithFivePacks(): { objectiveId: number; tasks: Record<string, number> } {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const tasks: Record<string, number> = {}
    for (const mission of suite.missions) {
      tasks[mission.key] = mission.taskId
      if (mission.key !== 'm6') {
        const delegation = createDelegationForTask({
          taskId: mission.taskId,
          projectId: suite.projectId,
          workspaceId,
          routingAgentName: 'AgentOS Router',
          runtimeType: 'hermes',
          metadata: taskById(mission.taskId).metadata,
        })
        expect(delegation.objectiveId).toBe(suite.objectiveId)
        completePack(mission.packId, mission.taskId)
      }
    }
    return { objectiveId: suite.objectiveId, tasks }
  }

  it('keeps M6 backlog until all five packs are done, then promotes it', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m6 = suite.missions.find(m => m.key === 'm6')!
    expect(taskById(m6.taskId).status).toBe('backlog')
    const promotion = promoteReadyObjectiveMissions()
    expect(promotion.promoted).not.toContain(m6.taskId)
    for (const mission of suite.missions) {
      if (mission.key === 'm6') continue
      state.db!.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(mission.taskId)
    }
    const after = promoteReadyObjectiveMissions()
    expect(after.promoted).toContain(m6.taskId)
    expect(taskById(m6.taskId).status).toBe('inbox')
    expect(JSON.parse(taskById(m6.taskId).metadata).agentos.executionState).toBe('ready')
  })

  it('finalizes only after M6 passes; writes final packs + manifest; objective completes; registry untouched', () => {
    const registryBefore = read(root, '_CATALOG/agentos_resource_registry.json')
    const queueBefore = read(root, '_CATALOG/agentos_resource_review_queue.json')
    const { objectiveId, tasks } = suiteWithFivePacks()

    // M6 is unblocked by the standard dependency promotion.
    const promotion = promoteReadyObjectiveMissions()
    expect(promotion.promoted).toContain(tasks.m6)

    addComment(tasks.m6, validValidationEnvelope())
    const result = ingestKnowledgeMissionResult({ taskId: tasks.m6, workspaceId, root })
    expect(result.status).toBe('COMPLETE')
    expect(result.finalized).toBe(true)

    const stagingDir = defaultStagingDir(root)
    const outputDir = defaultOutputDir(root)
    // Final artifacts written (duplicate-safe) + manifest.
    for (const spec of KNOWLEDGE_PACK_SPECS) {
      if (spec.key === 'm6') continue
      expect(fs.existsSync(path.join(outputDir, spec.file))).toBe(true)
    }
    expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(true)
    expect(fs.existsSync(path.join(outputDir, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(stagingDir, 'README.md'))).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
    expect(manifest.suite_id).toBe(KNOWLEDGE_SUITE_ID)
    expect(manifest.objective_id).toBe(objectiveId)
    expect(manifest.files).toHaveLength(5)
    expect(manifest.source_resource_ids).toEqual(expect.arrayContaining(['res-tactical-oxce-reference']))
    expect(manifest.validation_result.verdict).toBe('PASS')
    expect(Object.keys(manifest.mission_task_ids)).toHaveLength(6)
    expect(manifest.delegation_ids.length).toBe(5)

    // Objective plan marks the suite FINALIZED; completing M6 completes the objective.
    const objectivePlan = JSON.parse((state.db!.prepare('SELECT plan_json FROM agentos_objectives WHERE id = ?').get(objectiveId) as any).plan_json)
    expect(objectivePlan.agentos_knowledge_suite.state).toBe('FINALIZED')
    state.db!.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(tasks.m6)
    reconcileObjectiveStatuses({ workspaceId })
    expect((state.db!.prepare('SELECT status FROM agentos_objectives WHERE id = ?').get(objectiveId) as any).status).toBe('completed')

    // No auto-promotion anywhere: registry + queue untouched (scanner not run by AgentOS).
    expect(read(root, '_CATALOG/agentos_resource_registry.json')).toBe(registryBefore)
    expect(read(root, '_CATALOG/agentos_resource_review_queue.json')).toBe(queueBefore)
    expect(getAiResourceRegistry(root).resources.length).toBe(4)
  })

  it('blocks finalization when M6 reports a FAIL verdict', () => {
    suiteWithFivePacks()
    const suite = getKnowledgeSuiteState(workspaceId)
    const m6 = suite.missions.find(m => m.missionKey === 'm6')!
    promoteReadyObjectiveMissions()
    addComment(m6.taskId, validValidationEnvelope({
      suite_verdict: 'FAIL',
      per_pack_verdicts: PACK_IDS.map((packId, index) => ({ pack_id: packId, verdict: index === 0 ? 'FAIL' : 'PASS', issues: index === 0 ? ['unsupported claim in terrain section'] : [] })),
    }))
    const result = ingestKnowledgeMissionResult({ taskId: m6.taskId, workspaceId, root })
    expect(result.status).toBe('INVALID_RESULT')
    const block = JSON.parse(taskById(m6.taskId).metadata).agentos_knowledge_curation
    expect(block.state).toBe('NEEDS_MANUAL')
    expect(block.escalated_reason).toBe('policy_conflict')
    expect(fs.existsSync(path.join(defaultOutputDir(root), 'manifest.json'))).toBe(false)
  })

  it('blocks finalization when staged packs are incomplete even with a PASS verdict', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m6 = suite.missions.find(m => m.key === 'm6')!
    promoteReadyObjectiveMissions()
    addComment(m6.taskId, validValidationEnvelope())
    const result = ingestKnowledgeMissionResult({ taskId: m6.taskId, workspaceId, root })
    expect(result.status).toBe('INVALID_RESULT')
    expect(JSON.parse(taskById(m6.taskId).metadata).agentos_knowledge_curation.state).toBe('NEEDS_MANUAL')
    expect(fs.existsSync(path.join(defaultOutputDir(root), 'manifest.json'))).toBe(false)
  })

  it('reconcile ignores unrelated native tasks and stays workspace-scoped', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m1 = suite.missions.find(m => m.key === 'm1')!
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(m1.taskId)
    bindCompletedDelegation(m1.taskId, suite.projectId, validPackEnvelope(m1.packId))
    state.db!.prepare("INSERT INTO tasks (title, status, metadata, workspace_id) VALUES ('plain', 'review', '{}', ?)").run(workspaceId)
    const other = createKnowledgeSuiteObjective({ workspaceId: 2, root })
    const otherM1 = other.missions.find(m => m.key === 'm1')!

    const result = reconcileKnowledgeCuration(root)
    expect(result.ingested).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(taskById(m1.taskId).metadata).agentos_knowledge_curation.state).toBe('COMPLETE')
    expect(JSON.parse(taskById(otherM1.taskId).metadata).agentos_knowledge_curation.state).not.toBe('COMPLETE')
  })
})

describe('reconcileKnowledgeCuration honors AgentOS project command', () => {
  function suiteWithReviewableM1(cmdState: string): { projectId: number; taskId: number; packId: string } {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m1 = suite.missions.find(m => m.key === 'm1')!
    setProjectCommand(suite.projectId, cmdState)
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(m1.taskId)
    return { projectId: suite.projectId, taskId: m1.taskId, packId: m1.packId }
  }

  it('ACTIVE: reconciliation ingests a valid current result normally', () => {
    const { taskId, packId, projectId } = suiteWithReviewableM1('active')
    // The specialist's output arrives through a completed delegation bound to
    // the current attempt — a bare comment is never automatic result input.
    bindCompletedDelegation(taskId, projectId, validPackEnvelope(packId))
    const result = reconcileKnowledgeCuration(root)
    expect(result.ingested).toBe(1)
    const block = JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation
    expect(block.state).toBe('COMPLETE')
    expect(block.consumed_delegation_id).toBeTruthy()
    expect(state.activities.some(a => String((a as unknown[])[0]).includes('agentos_knowledge_reconcile_held'))).toBe(false)
  })

  it('PAUSED: reconciliation does not ingest results — mission state, attempts and staging untouched', () => {
    const { taskId, packId, projectId } = suiteWithReviewableM1('paused')
    // Even an eligible completed delegation on the current attempt is held.
    bindCompletedDelegation(taskId, projectId, validPackEnvelope(packId))
    const result = reconcileKnowledgeCuration(root)
    expect(result.ingested).toBe(0)
    const block = JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation
    expect(block.state).toBe('ROUTED')
    expect(block.invalid_attempts ?? 0).toBe(0)
    expect(block.staged_path ?? null).toBeNull()
    expect(block.consumed_delegation_id ?? null).toBeNull()
    expect(state.activities.some(a => String((a as unknown[])[0]).includes('agentos_knowledge_reconcile_held'))).toBe(true)
  })

  it('PAUSED: malformed historical residue must not flip the mission to FAILED', () => {
    const { taskId, projectId } = suiteWithReviewableM1('paused')
    const residue = 'API Error: 402 Workspace has insufficient balance. Top up to continue.'
    // Provider-failure residue preserved as a historical completed record and a
    // task comment from the pre-fix era. PAUSED holds before lineage is even
    // consulted — the mission cannot flip to FAILED from residue.
    bindCompletedDelegation(taskId, projectId, residue)
    addComment(taskId, residue)
    const result = reconcileKnowledgeCuration(root)
    expect(result.invalid).toBe(0)
    const block = JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation
    expect(block.state).toBe('ROUTED')
    expect(block.invalid_attempts ?? 0).toBe(0)
  })

  it('PAUSED: an in_progress mission is not advanced to RUNNING', () => {
    const { taskId } = suiteWithReviewableM1('paused')
    state.db!.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId)
    const result = reconcileKnowledgeCuration(root)
    expect(result.running).toBe(0)
    expect(JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation.state).toBe('ROUTED')
  })

  it('unmanaged project (no command record) preserves existing reconciliation behavior', () => {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m1 = suite.missions.find(m => m.key === 'm1')!
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(m1.taskId)
    bindCompletedDelegation(m1.taskId, suite.projectId, validPackEnvelope(m1.packId))
    const result = reconcileKnowledgeCuration(root)
    expect(result.ingested).toBe(1)
    expect(JSON.parse(taskById(m1.taskId).metadata).agentos_knowledge_curation.state).toBe('COMPLETE')
  })

  it('a paused AgentOS project does not block ingestion for another workspace/project', () => {
    const held = createKnowledgeSuiteObjective({ workspaceId: 1, root })
    const heldM1 = held.missions.find(m => m.key === 'm1')!
    setProjectCommand(held.projectId, 'paused', 1)
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(heldM1.taskId)
    bindCompletedDelegation(heldM1.taskId, held.projectId, validPackEnvelope(heldM1.packId), 1)

    const other = createKnowledgeSuiteObjective({ workspaceId: 2, root })
    const otherM1 = other.missions.find(m => m.key === 'm1')!
    state.db!.prepare('UPDATE tasks SET status = ? WHERE id = ? AND workspace_id = ?').run('review', otherM1.taskId, 2)
    bindCompletedDelegation(otherM1.taskId, other.projectId, validPackEnvelope(otherM1.packId), 2)

    const result = reconcileKnowledgeCuration(root)
    expect(result.ingested).toBe(1)
    expect(JSON.parse(taskById(heldM1.taskId).metadata).agentos_knowledge_curation.state).toBe('ROUTED')
    expect(JSON.parse(taskById(otherM1.taskId).metadata).agentos_knowledge_curation.state).toBe('COMPLETE')
  })
})

describe('knowledge execution-attempt lineage (reconcile provenance)', () => {
  const RESIDUE = 'API Error: 402 Workspace has insufficient balance. Top up to continue.'

  function reviewableSuite(): { projectId: number; taskId: number; packId: string } {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    const m1 = suite.missions.find(m => m.key === 'm1')!
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(m1.taskId)
    return { projectId: suite.projectId, taskId: m1.taskId, packId: m1.packId }
  }

  it('exact 402 retry regression: a retried mission never re-ingests generation-A residue', () => {
    const { projectId, taskId, packId } = reviewableSuite()

    // Generation A: the pre-fix world — a completed delegation carrying the 402
    // diagnostic was ingested as an (invalid) result and the mission FAILED.
    const delA = bindCompletedDelegation(taskId, projectId, RESIDUE)
    addComment(taskId, RESIDUE)
    expect(ingestKnowledgeMissionResult({ taskId, workspaceId, root, text: RESIDUE, delegationId: delA }).status).toBe('INVALID_RESULT')
    expect(JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation.state).toBe('FAILED')

    // Generation B begins: retry resets to ROUTED and clears the result binding.
    const retried = retryKnowledgeMission({ packId, workspaceId, root })
    expect(retried.taskId).toBe(taskId)
    const afterRetry = JSON.parse(taskById(taskId).metadata)
    expect(afterRetry.agentos_knowledge_curation.state).toBe('ROUTED')
    expect(afterRetry.agentos_delegation_id ?? null).toBeNull()
    expect(afterRetry.agentos_knowledge_curation.consumed_delegation_id ?? null).toBeNull()
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(taskId)

    // Reconcile runs BEFORE delegation B exists: generation-A delegation,
    // comment and 402 diagnostic must all be ignored — the mission stays ROUTED.
    // Generation A legitimately logged one invalid-result event as history; the
    // held reconcile must not add any NEW one.
    const invalidHistory = state.activities.filter((a: unknown) => String((a as unknown[])[0]) === 'agentos_knowledge_invalid_result').length
    const held1 = reconcileKnowledgeCuration(root)
    expect(held1.ingested).toBe(0)
    expect(held1.message).toContain('held awaiting current attempt')
    const blockHeld = JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation
    expect(blockHeld.state).toBe('ROUTED')
    expect(blockHeld.invalid_attempts ?? 0).toBe(0)
    expect(state.activities.filter((a: unknown) => String((a as unknown[])[0]) === 'agentos_knowledge_invalid_result').length).toBe(invalidHistory)

    // Delegation B is created but still running: reconcile still does nothing.
    const row = state.db!.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as { metadata: string | null }
    const delBRunning = createDelegationForTask({
      taskId, projectId, workspaceId, routingAgentName: 'AgentOS Router', runtimeType: 'hermes', metadata: row.metadata,
    })
    expect(String(JSON.parse(taskById(taskId).metadata).agentos_delegation_id)).toBe(delBRunning.id)
    const held2 = reconcileKnowledgeCuration(root)
    expect(held2.ingested).toBe(0)
    expect(JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation.state).toBe('ROUTED')

    // Delegation B completes with valid output: only B is consumed.
    updateDelegation(delBRunning.id, workspaceId, { status: 'completed', resultSummary: validPackEnvelope(packId), completed: true })
    const consumed = reconcileKnowledgeCuration(root)
    expect(consumed.ingested).toBe(1)
    const blockDone = JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation
    expect(blockDone.state).toBe('COMPLETE')
    expect(blockDone.consumed_delegation_id).toBe(delBRunning.id)

    // A duplicate reconcile pass is idempotent — no double ingestion.
    const dup = reconcileKnowledgeCuration(root)
    expect(dup.ingested).toBe(0)
    expect(dup.message).not.toContain('held')
  })

  it('a failed current delegation (provider diagnostic) never becomes authored output', () => {
    const { projectId, taskId } = reviewableSuite()
    const row = state.db!.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as { metadata: string | null }
    const delegation = createDelegationForTask({
      taskId, projectId, workspaceId, routingAgentName: 'AgentOS Router', runtimeType: 'gamut', metadata: row.metadata,
    })
    updateDelegation(delegation.id, workspaceId, { status: 'failed', errorMessage: RESIDUE })
    const result = reconcileKnowledgeCuration(root)
    expect(result.ingested).toBe(0)
    expect(result.invalid).toBe(0)
    const block = JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation
    expect(block.state).toBe('ROUTED')
    expect(block.invalid_attempts ?? 0).toBe(0)
    expect(state.activities.some((a: unknown) => String((a as unknown[])[0]) === 'agentos_knowledge_invalid_result')).toBe(false)
  })

  it('only the current generation delegation is consumed after a successful historical generation', () => {
    const { projectId, taskId, packId } = reviewableSuite()

    // Generation A completes successfully and is consumed.
    bindCompletedDelegation(taskId, projectId, validPackEnvelope(packId))
    expect(reconcileKnowledgeCuration(root).ingested).toBe(1)
    expect(JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation.state).toBe('COMPLETE')

    // Retry opens generation B; A stays as a completed historical delegation.
    retryKnowledgeMission({ packId, workspaceId, root })
    state.db!.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(taskId)
    expect(reconcileKnowledgeCuration(root).ingested).toBe(0)
    expect(JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation.state).toBe('ROUTED')

    // Generation B completes: only B's output is eligible, and B is recorded.
    const delB = bindCompletedDelegation(taskId, projectId, validPackEnvelope(packId))
    expect(reconcileKnowledgeCuration(root).ingested).toBe(1)
    const block = JSON.parse(taskById(taskId).metadata).agentos_knowledge_curation
    expect(block.consumed_delegation_id).toBe(delB)
    expect(block.state).toBe('COMPLETE')
  })

  it('retry clears the current delegation binding and all derived result state', () => {
    const { projectId, taskId, packId } = reviewableSuite()
    bindCompletedDelegation(taskId, projectId, validPackEnvelope(packId))
    expect(ingestKnowledgeMissionResult({ taskId, workspaceId, root }).status).toBe('COMPLETE')
    const before = JSON.parse(taskById(taskId).metadata)
    expect(before.agentos_knowledge_curation.staged_path).toBeTruthy()
    expect(before.agentos_knowledge_curation.result).toBeTruthy()
    expect(before.agentos_delegation_id).toBeTruthy()

    retryKnowledgeMission({ packId, workspaceId, root })
    const after = JSON.parse(taskById(taskId).metadata)
    expect(after.agentos_knowledge_curation.state).toBe('ROUTED')
    expect(after.agentos_delegation_id ?? null).toBeNull()
    const block = after.agentos_knowledge_curation
    for (const key of ['result', 'staged_path', 'staged_at', 'delegation_id', 'consumed_delegation_id', 'validation', 'suite_verdict', 'finalized']) {
      expect(block[key] ?? null).toBeNull()
    }
  })
})

const liveScannerAvailable = fs.existsSync('D:/AI/_CATALOG/scan.mjs')
describe('scanner discovery of generated packs (NEW, never auto-promoted)', () => {
  it.skipIf(!liveScannerAvailable)('registers the staged suite as a NEW resource after a real vault scan', () => {
    const { objectiveId } = suiteWithFivePacksHelper()
    expect(objectiveId).toBeGreaterThan(0)
    // M6 finalize writes the scan-visible staging container.
    const m6Task = getKnowledgeSuiteState(workspaceId).missions.find(m => m.missionKey === 'm6')!.taskId
    promoteReadyObjectiveMissions()
    addComment(m6Task, validValidationEnvelope())
    expect(ingestKnowledgeMissionResult({ taskId: m6Task, workspaceId, root }).status).toBe('COMPLETE')
    expect(fs.existsSync(path.join(defaultStagingDir(root), 'README.md'))).toBe(true)

    // Run the REAL vault scanner against a root-patched temp copy (never D:\AI).
    const source = fs.readFileSync('D:/AI/_CATALOG/scan.mjs', 'utf8')
    const patched = source.replace('const ROOT = "D:/AI";', `const ROOT = ${JSON.stringify(root.replace(/\\\\/g, '/'))};`)
    const scanCopy = path.join(root, '_CATALOG', 'scan-copy.mjs')
    fs.writeFileSync(scanCopy, patched)
    const run = spawnSync(process.execPath, [scanCopy], { encoding: 'utf8', timeout: 60000 })
    expect(run.status).toBe(0)

    const changes = JSON.parse(read(root, '_CATALOG/agentos_resource_changes.json'))
    const rel = changes.new.find((entry: string) => entry.includes('generated-knowledge'))
    expect(rel).toBeTruthy()
    const queue = JSON.parse(read(root, '_CATALOG/agentos_resource_review_queue.json'))
    const item = queue.items.find((entry: any) => String(entry.path || '').includes('generated-knowledge'))
    expect(item).toBeTruthy()
    expect(item.detected_state).toBe('NEW')
    expect(item.pending).not.toBe(false)
    // Scanner never mutated the authoritative registry.
    const registry = JSON.parse(read(root, '_CATALOG/agentos_resource_registry.json'))
    expect(registry.resources.length).toBe(4)
  })
})

function suiteWithFivePacksHelper(): { objectiveId: number } {
  const suite = createKnowledgeSuiteObjective({ workspaceId, root })
  for (const mission of suite.missions) {
    if (mission.key === 'm6') continue
    createDelegationForTask({
      taskId: mission.taskId,
      projectId: suite.projectId,
      workspaceId,
      routingAgentName: 'AgentOS Router',
      runtimeType: 'hermes',
      metadata: taskById(mission.taskId).metadata,
    })
    completePack(mission.packId, mission.taskId)
  }
  return { objectiveId: suite.objectiveId }
}
