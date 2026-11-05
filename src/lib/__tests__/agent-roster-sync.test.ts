import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateGamutEffectiveRuntimeCache } from '@/lib/gamut-host'
import {
  registerRosterAgents,
  syncAgentRoster,
  buildRosterView,
} from '@/lib/agent-roster-sync'
import { agentosRoutingAgentName as stableName } from '@/lib/external-project-bindings'
import { rankAgentsForMission } from '@/lib/agent-selection'
import { authorizeAgentOSTaskDispatch } from '@/lib/execution-authorization'
import { classifyExecutionCost } from '@/lib/execution-planning'
import type { GlobalRosterAgent } from '@/lib/global-agent-roster'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  activities: [] as unknown[],
  roster: [] as GlobalRosterAgent[],
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: (...args: unknown[]) => state.activities.push(args) },
}))

vi.mock('@/lib/global-agent-roster', () => ({
  getGlobalAgentRoster: () => state.roster,
}))

function rosterAgent(partial: Partial<GlobalRosterAgent> & { id: string; name: string; platoonId: string }): GlobalRosterAgent {
  return {
    role: partial.role || partial.name,
    archetype: partial.archetype || partial.role || partial.name,
    availability: 'available',
    definitionPath: `D:\\agents\\${partial.platoonId}\\${partial.name}`,
    source: 'filesystem',
    capabilities: { tags: partial.capabilities?.tags || [], source: 'declared' },
    performance: { tasks: 0, completed: 0, completionRate: null },
    ...partial,
  }
}

const tacticalDesigner = rosterAgent({
  id: 'pc:gamut:w310613oew', name: 'Tactical Battles & Encounter Designer (DBZ Tactics)', platoonId: 'gamut',
  role: 'Permanent specialist owning battlefield rules and encounter design',
  capabilities: { tags: ['knowledge-curation', 'tactical-encounters', 'combat-systems', 'game-development'], source: 'declared' },
})
const gameDirector = rosterAgent({
  id: 'pc:gamut:synou3rydq', name: 'Game Director & Systems Designer (DBZ Tactics)', platoonId: 'gamut',
  role: 'Permanent specialist owning player experience and design acceptance',
  capabilities: { tags: ['knowledge-curation', 'tactical-encounters', 'game-direction'], source: 'declared' },
})
const enemyAiEngineer = rosterAgent({
  id: 'pc:gamut:0xi89wpqz2', name: 'Enemy AI & Boss Engineer (DBZ Tactics)', platoonId: 'gamut',
  role: 'Permanent specialist owning enemy behavior and boss phases',
  capabilities: { tags: ['knowledge-curation', 'enemy-ai', 'tactical-encounters'], source: 'declared' },
})
const qaLead = rosterAgent({
  id: 'pc:gamut:eewh8wz1tg', name: 'QA Playtest & Release Verification Lead (DBZ Tactics)', platoonId: 'gamut',
  role: 'Permanent independent verifier',
  capabilities: { tags: ['knowledge-curation', 'qa-release', 'testing-review'], source: 'declared' },
})
const offlineHermes = rosterAgent({
  id: 'pc:hermes:orchestrator', name: 'orchestrator', platoonId: 'hermes',
  availability: 'offline', role: 'Platoon Commander',
  capabilities: { tags: ['orchestration'], source: 'declared' },
})

function seedSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT, isolation TEXT NOT NULL DEFAULT 'shared');
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT,
      ticket_prefix TEXT NOT NULL, ticket_counter INTEGER NOT NULL DEFAULT 0,
      workspace_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(workspace_id, slug)
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, session_key TEXT,
      soul_content TEXT, status TEXT, last_seen INTEGER, last_activity INTEGER,
      created_at INTEGER, updated_at INTEGER, config TEXT, workspace_id INTEGER NOT NULL,
      source TEXT, content_hash TEXT, workspace_path TEXT, hidden INTEGER NOT NULL DEFAULT 0,
      working_memory TEXT, runtime_type TEXT,
      claude_base_session_id TEXT, claude_base_session_created_at INTEGER,
      UNIQUE(name, workspace_id)
    );
    CREATE TABLE project_external_agent_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      platoon_id TEXT NOT NULL, external_agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL, role TEXT, routing_agent_name TEXT,
      definition_path TEXT, capability_snapshot TEXT, bound_by TEXT,
      bound_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(project_id, platoon_id, external_agent_id)
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, status TEXT, priority TEXT,
      project_id INTEGER, project_ticket_no INTEGER, assigned_to TEXT,
      created_by TEXT, created_at INTEGER, updated_at INTEGER,
      tags TEXT, metadata TEXT, workspace_id INTEGER,
      outcome TEXT, resolution TEXT, error_message TEXT, completed_at INTEGER
    );
    CREATE TABLE agentos_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL DEFAULT '{}', created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agentos_project_command (
      project_id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft',
      auto_route INTEGER NOT NULL DEFAULT 0,
      allow_reroute INTEGER NOT NULL DEFAULT 0,
      fallback_behavior TEXT NOT NULL DEFAULT 'hold',
      allowed_platoons_json TEXT NOT NULL DEFAULT '[]',
      max_project_concurrent INTEGER NOT NULL DEFAULT 3,
      max_platoon_concurrent INTEGER NOT NULL DEFAULT 2,
      max_agent_concurrent INTEGER NOT NULL DEFAULT 1,
      allow_free_local_without_approval INTEGER NOT NULL DEFAULT 1,
      allow_free_remote_without_approval INTEGER NOT NULL DEFAULT 0,
      allow_paid_without_approval INTEGER NOT NULL DEFAULT 0,
      max_approved_estimated_cost REAL,
      approved_providers_json TEXT NOT NULL DEFAULT '[]',
      blocked_providers_json TEXT NOT NULL DEFAULT '[]',
      activated_at INTEGER, updated_by TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agentos_execution_plans (
      objective_id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PREVIEW',
      plan_json TEXT NOT NULL DEFAULT '{}', fingerprint TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agentos_execution_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id TEXT NOT NULL UNIQUE,
      objective_id INTEGER NOT NULL, project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      approved_by TEXT NOT NULL, approved_at INTEGER NOT NULL,
      approved_task_ids_json TEXT NOT NULL DEFAULT '[]',
      excluded_task_ids_json TEXT NOT NULL DEFAULT '[]',
      fingerprint TEXT NOT NULL, max_authorized_amount REAL, expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

let root = ''
let workspaceId = 1
let gamutAppData = ''
let originalAppData: string | undefined

beforeEach(() => {
  state.db = new Database(':memory:')
  state.activities = []
  seedSchema(state.db)
  state.db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (1, ?, ?)').run('One', 'shared')
  state.db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (2, ?, ?)').run('Two', 'shared')
  state.db.prepare('INSERT INTO projects (id, name, slug, ticket_prefix, workspace_id, status) VALUES (1, ?, ?, ?, 1, ?)').run('Ops', 'agentos-operations', 'OPS', 'active')
  state.db.prepare('INSERT INTO projects (id, name, slug, ticket_prefix, workspace_id, status) VALUES (2, ?, ?, ?, 1, ?)').run('Game', 'dbz-tactics', 'DBZ', 'active')
  state.roster = [tacticalDesigner, gameDirector, enemyAiEngineer, qaLead, offlineHermes]
  // Hermetic host runtime: gamut classification now consults the live
  // Superagent settings. Point APPDATA at an empty temp dir (no settings.json)
  // so host resolution is source 'none' and legacy annotation-only semantics
  // apply deterministically on any machine.
  gamutAppData = mkdtempSync(join(tmpdir(), 'mc-roster-sync-'))
  originalAppData = process.env.APPDATA
  process.env.APPDATA = gamutAppData
  invalidateGamutEffectiveRuntimeCache()
})

afterEach(() => {
  state.db?.close()
  state.db = null
  rmSync(gamutAppData, { recursive: true, force: true })
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  invalidateGamutEffectiveRuntimeCache()
})

describe('registration bridge (discovery → live agents rows)', () => {
  it('registers a discovered specialist as a stable agentos-external row, idempotently', () => {
    const first = registerRosterAgents({ workspaceId, actor: 'test' })
    expect(first.added).toBe(5) // gamut × 4 available + 1 offline hermes
    const name = stableName(tacticalDesigner)
    const row = state.db!.prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = 1').get(name) as any
    expect(row).toBeTruthy()
    expect(row.source).toBe('agentos-external')
    expect(row.hidden).toBe(1)
    expect(row.runtime_type).toBe('gamut')
    expect(row.status).toBe('online')
    const config = JSON.parse(row.config)
    expect(config.agentos.externalAgentId).toBe('pc:gamut:w310613oew')
    expect(config.agentos.externalAgentName).toBe(tacticalDesigner.name)
    expect(config.agentos.platoonId).toBe('gamut')

    // Offline specialist is marked offline, not skipped.
    const hermesRow = state.db!.prepare('SELECT status FROM agents WHERE name = ? AND workspace_id = 1').get(stableName(offlineHermes)) as any
    expect(hermesRow.status).toBe('offline')

    const second = registerRosterAgents({ workspaceId, actor: 'test' })
    expect(second.added).toBe(0)
    expect(second.updated).toBe(0)
    const count = state.db!.prepare("SELECT COUNT(*) c FROM agents WHERE source = 'agentos-external' AND workspace_id = 1").get() as { c: number }
    expect(count.c).toBe(5) // no duplicates
  })

  it('updates availability when a specialist comes back online and never deletes history', () => {
    registerRosterAgents({ workspaceId, actor: 'test' })
    // Specialist disappears from the roster (runtime offline): registration keeps the row.
    const name = stableName(offlineHermes)
    expect(state.db!.prepare('SELECT 1 FROM agents WHERE name = ? AND workspace_id = 1').get(name)).toBeTruthy()
    state.roster = state.roster.filter(a => a.id !== offlineHermes.id)
    registerRosterAgents({ workspaceId, actor: 'test' })
    expect(state.db!.prepare('SELECT 1 FROM agents WHERE name = ? AND workspace_id = 1').get(name)).toBeTruthy() // retained
    // ...and an unavailable agent flips to offline when its availability changes.
    state.roster = [tacticalDesigner, { ...gameDirector, availability: 'error' }]
    registerRosterAgents({ workspaceId, actor: 'test' })
    const directorRow = state.db!.prepare('SELECT status FROM agents WHERE name = ? AND workspace_id = 1').get(stableName(gameDirector)) as any
    expect(directorRow.status).toBe('error')
  })

  it('isolates registrations per workspace', () => {
    registerRosterAgents({ workspaceId: 1, actor: 'test' })
    expect(state.db!.prepare("SELECT COUNT(*) c FROM agents WHERE workspace_id = 1 AND source = 'agentos-external'").get() as any).toMatchObject({ c: 5 })
    expect(state.db!.prepare("SELECT COUNT(*) c FROM agents WHERE workspace_id = 2 AND source = 'agentos-external'").get() as any).toMatchObject({ c: 0 })
    registerRosterAgents({ workspaceId: 2, roster: [qaLead], actor: 'test' })
    expect(state.db!.prepare("SELECT COUNT(*) c FROM agents WHERE workspace_id = 2 AND source = 'agentos-external'").get() as any).toMatchObject({ c: 1 })
  })

  it('leaves native Mission Control agents untouched', () => {
    state.db!.prepare("INSERT INTO agents (name, role, status, workspace_id, source, runtime_type, hidden) VALUES ('aegis', 'reviewer', 'online', 1, 'mc', 'local', 0)").run()
    registerRosterAgents({ workspaceId, actor: 'test' })
    const native = state.db!.prepare("SELECT * FROM agents WHERE name = 'aegis' AND workspace_id = 1").get() as any
    expect(native.source).toBe('mc')
    expect(native.hidden).toBe(0)
    expect(state.db!.prepare("SELECT COUNT(*) c FROM agents WHERE workspace_id = 1").get() as any).toMatchObject({ c: 6 })
  })
})

describe('binding + capability routing', () => {
  it('binds available specialists to the project with capability snapshots (idempotent)', () => {
    const first = syncAgentRoster({ workspaceId, projectId: 1, actor: 'test' })
    expect(first.registered).toBe(5)
    expect(first.boundAdded).toBe(4) // hermes offline excluded
    const binding = state.db!.prepare(
      "SELECT * FROM project_external_agent_bindings WHERE project_id = 1 AND external_agent_id = 'pc:gamut:w310613oew'",
    ).get() as any
    expect(binding).toBeTruthy()
    expect(binding.routing_agent_name).toBe(stableName(tacticalDesigner))
    expect(JSON.parse(binding.capability_snapshot)).toEqual(expect.arrayContaining(['tactical-encounters', 'knowledge-curation']))

    const second = syncAgentRoster({ workspaceId, projectId: 1, actor: 'test' })
    expect(second.boundAdded).toBe(0)
    expect(second.boundUpdated).toBe(0)
    expect(state.db!.prepare('SELECT COUNT(*) c FROM project_external_agent_bindings WHERE project_id = 1').get() as any).toMatchObject({ c: 4 })
  })

  it('keeps specialist identity stable: same specialist maps to the same proxy across syncs', () => {
    const a = stableName(tacticalDesigner)
    registerRosterAgents({ workspaceId, actor: 'test' })
    state.roster = state.roster.map(agent => agent.id === tacticalDesigner.id ? { ...tacticalDesigner, name: `${tacticalDesigner.name} (renamed)` } : agent)
    registerRosterAgents({ workspaceId, actor: 'test' })
    const b = stableName({ ...tacticalDesigner, name: `${tacticalDesigner.name} (renamed)` })
    expect(b).toBe(a) // identity survives display-name changes — hash is on external id
  })

  it('Tactical Battles & Encounter Designer outranks the generic Game Director for tactical-encounters', () => {
    const ranked = rankAgentsForMission(
      [gameDirector, tacticalDesigner, enemyAiEngineer],
      { requiredCapabilities: ['knowledge-curation', 'tactical-encounters'] },
    )
    expect(ranked[0].eligible).toBe(true)
    expect(ranked[0].agent.id).toBe(tacticalDesigner.id)
    expect(ranked.find(c => c.agent.id === tacticalDesigner.id)!.score).toBeGreaterThan(
      ranked.find(c => c.agent.id === gameDirector.id)!.score,
    )
  })

  it('routing identity exists in the agents table so the dispatcher JOIN can find it', () => {
    syncAgentRoster({ workspaceId, projectId: 1, actor: 'test' })
    const proxy = stableName(qaLead)
    // The exact JOIN shape dispatchAssignedTasks relies on:
    const join = state.db!.prepare(`
      SELECT a.name, a.runtime_type, a.source, a.hidden FROM tasks t
      JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
      WHERE t.id = ?
    `)
    state.db!.prepare("INSERT INTO tasks (id, title, status, project_id, assigned_to, workspace_id, created_at, updated_at) VALUES (99, 'm', 'assigned', 1, ?, 1, 0, 0)").run(proxy)
    const row = join.get(99) as any
    expect(row).toBeTruthy()
    expect(row.runtime_type).toBe('gamut')
    expect(row.source).toBe('agentos-external')
  })
})

describe('truthful runtime/cost classification (no invented FREE_LOCAL)', () => {
  it('localhost host runtime without evidence is UNKNOWN_COST — not FREE_LOCAL', () => {
    const view = buildRosterView({ workspaceId })
    const gamut = view.agents.find(a => a.platoonId === 'gamut')!
    expect(gamut.costClass).toBe('UNKNOWN_COST')
    expect(gamut.blocker).toBeNull() // availability is fine — only cost evidence is missing
    expect(view.classifications.UNKNOWN_COST).toBe(5)
    expect(view.classifications.FREE_LOCAL).toBe(0)
    // Roster view is read-only — no rows written.
    expect(state.db!.prepare('SELECT COUNT(*) c FROM agents').get() as any).toMatchObject({ c: 0 })
  })

  it('explicit free-local evidence yields FREE_LOCAL; a declared provider yields PAID_ESTIMATED', () => {
    expect(classifyExecutionCost({ runtimeType: 'gamut', agentConfig: { agentos: { cost: { freeLocal: true } } } }).costClass).toBe('FREE_LOCAL')
    expect(classifyExecutionCost({ runtimeType: 'gamut', provider: 'openai', model: 'gpt-4o' }).costClass).toBe('PAID_ESTIMATED')
    const report = syncAgentRoster({ workspaceId, costMeta: { [qaLead.id]: { freeLocal: true } } })
    expect(report.classifications.FREE_LOCAL).toBe(1) // qaLead carries explicit evidence
    expect(report.classifications.UNKNOWN_COST).toBe(4) // the rest have no pricing evidence
    const paid = syncAgentRoster({
      workspaceId,
      roster: [enemyAiEngineer],
      costMeta: { [enemyAiEngineer.id]: { provider: 'anthropic', model: 'claude-sonnet' } },
    })
    expect(paid.agents.find(a => a.platoonId === 'gamut')!.costClass).toBe('PAID_ESTIMATED')
  })
})

describe('execution authorization integration with registered agents', () => {
  const FREE_CURATOR_ID = 'pc:gamut:free-local'

  function seedObjectiveWithTasks(): { objectiveId: number; tUnknown: number; tFree: number } {
    const db = state.db!
    const freeCurator = rosterAgent({
      id: FREE_CURATOR_ID, name: 'Free Local Curator (DBZ Tactics)', platoonId: 'gamut',
      capabilities: { tags: ['knowledge-curation', 'tactical-encounters'], source: 'declared' },
    })
    const roster2 = [tacticalDesigner, freeCurator]
    state.roster = roster2 // the bindings layer looks up the same live roster
    // Register tactical designer WITHOUT cost evidence and the curator WITH free evidence.
    syncAgentRoster({
      workspaceId,
      projectId: 1,
      roster: roster2,
      actor: 'test',
      costMeta: { [FREE_CURATOR_ID]: { provider: 'local', freeLocal: true } },
    })
    db.prepare("INSERT INTO agentos_project_command (project_id, workspace_id, state) VALUES (1, 1, 'active') ON CONFLICT(project_id) DO NOTHING").run()
    db.prepare("INSERT INTO agentos_objectives (id, project_id, workspace_id, title, plan_json, created_by) VALUES (1, 1, 1, 'obj', '{}', 'test')").run()
    const now = Math.floor(Date.now() / 1000)
    const ins = db.prepare(`
      INSERT INTO tasks (title, status, project_id, assigned_to, workspace_id, created_at, updated_at, metadata)
      VALUES (?, 'assigned', 1, ?, 1, ?, ?, ?)
    `)
    ins.run('m1', stableName(tacticalDesigner), now, now, JSON.stringify({ agentos: { objectiveId: 1 } }))
    const tUnknown = Number((db.prepare('SELECT last_insert_rowid() id').get() as any).id)
    ins.run('m2', stableName(freeCurator), now, now, JSON.stringify({ agentos: { objectiveId: 1 } }))
    const tFree = Number((db.prepare('SELECT last_insert_rowid() id').get() as any).id)
    db.prepare('UPDATE agentos_objectives SET plan_json = ? WHERE id = 1').run(JSON.stringify({
      missions: [
        { key: 'm1', taskId: tUnknown, dependsOnKeys: [] },
        { key: 'm2', taskId: tFree, dependsOnKeys: [] },
      ],
    }))
    return { objectiveId: 1, tUnknown, tFree }
  }

  function freeMeta(): string {
    return JSON.stringify({ agentos: { objectiveId: 1 } })
  }

  it('holds gamut missions without free evidence; dispatches evidence-backed free-local missions', () => {
    const { tUnknown, tFree } = seedObjectiveWithTasks()
    const held = authorizeAgentOSTaskDispatch({
      id: tUnknown, project_id: 1, workspace_id: 1, assigned_to: stableName(tacticalDesigner),
      metadata: freeMeta(),
    })
    expect(held.allowed).toBe(false)
    expect(held.held).toBe(true)
    expect(held.costClass).toBe('UNKNOWN_COST')

    const allowed = authorizeAgentOSTaskDispatch({
      id: tFree, project_id: 1, workspace_id: 1, assigned_to: stableName({ id: FREE_CURATOR_ID, name: 'Free Local Curator (DBZ Tactics)', platoonId: 'gamut' }),
      metadata: freeMeta(),
    })
    expect(allowed.allowed).toBe(true)
    expect(allowed.costClass).toBe('FREE_LOCAL')
    expect(state.activities.some((args: any) => args[0] === 'agentos_execution_approval_held')).toBe(true)
  })

  it('free-local remains gated when project policy disables free-local auto-approval', () => {
    const { tFree } = seedObjectiveWithTasks()
    state.db!.prepare('UPDATE agentos_project_command SET allow_free_local_without_approval = 0 WHERE project_id = 1').run()
    const held = authorizeAgentOSTaskDispatch({
      id: tFree, project_id: 1, workspace_id: 1, assigned_to: stableName({ id: FREE_CURATOR_ID, name: 'Free Local Curator (DBZ Tactics)', platoonId: 'gamut' }),
      metadata: freeMeta(),
    })
    expect(held.allowed).toBe(false)
    expect(held.costClass).toBe('FREE_LOCAL') // correctly classified, but policy requires approval
  })
})
