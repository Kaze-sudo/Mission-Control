import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAgentOSStatusSnapshot } from '@/lib/agentos-status'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  platoons: [] as unknown[],
  commanders: [] as unknown[],
  rosterView: null as unknown,
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: () => {} },
}))

vi.mock('@/lib/platoons', () => ({
  discoverPlatoons: () => state.platoons,
}))

vi.mock('@/lib/platoon-commanders', () => ({
  discoverPlatoonCommanders: () => state.commanders,
}))

vi.mock('@/lib/agent-roster-sync', () => ({
  buildRosterView: () => state.rosterView,
}))

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
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, status TEXT,
      last_seen INTEGER, workspace_id INTEGER NOT NULL, source TEXT, hidden INTEGER NOT NULL DEFAULT 1,
      runtime_type TEXT, UNIQUE(name, workspace_id)
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT, priority TEXT,
      project_id INTEGER, assigned_to TEXT, created_at INTEGER, updated_at INTEGER,
      metadata TEXT, workspace_id INTEGER
    );
    CREATE TABLE agentos_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
    CREATE TABLE agentos_delegations (
      id TEXT PRIMARY KEY,
      task_id INTEGER NOT NULL,
      project_id INTEGER,
      workspace_id INTEGER NOT NULL,
      platoon_id TEXT,
      specialist_name TEXT,
      status TEXT NOT NULL DEFAULT 'claimed',
      attempt INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      result_summary TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

function gamutPlatoonFixture() {
  return {
    id: 'gamut',
    name: 'Gamut',
    description: 'Gamut desktop agents',
    commanderType: 'runtime-orchestrator',
    installed: true,
    running: true,
    authenticated: true,
    authRequired: false,
    version: '1.0',
    health: 'ready',
    capabilities: {},
  }
}

function hermesPlatoonFixture() {
  return {
    id: 'hermes',
    name: 'Hermes',
    description: 'Hermes CLI profiles',
    commanderType: 'runtime-orchestrator',
    installed: true,
    running: false,
    authenticated: false,
    authRequired: true,
    version: null,
    health: 'degraded',
    capabilities: {},
  }
}

function codexPlatoonFixture() {
  return {
    id: 'codex',
    name: 'Codex',
    description: 'Codex CLI',
    commanderType: 'runtime-orchestrator',
    installed: false,
    running: false,
    authenticated: false,
    authRequired: true,
    version: null,
    health: 'offline',
    capabilities: {},
  }
}

const rosterViewFixture = {
  discovered: 5,
  registered: 4,
  dispatchable: 3,
  unavailable: 2,
  classifications: { FREE_LOCAL: 1, UNKNOWN_COST: 4 },
  agents: [
    { externalAgentId: 'pc:gamut:a', name: 'Alpha', platoonId: 'gamut', availability: 'available' },
    { externalAgentId: 'pc:gamut:b', name: 'Beta', platoonId: 'gamut', availability: 'busy' },
    { externalAgentId: 'pc:gamut:c', name: 'Gamma', platoonId: 'gamut', availability: 'error' },
    { externalAgentId: 'pc:hermes:d', name: 'Delta', platoonId: 'hermes', availability: 'offline' },
    { externalAgentId: 'pc:hermes:e', name: 'Epsilon', platoonId: 'hermes', availability: 'available' },
  ],
}

const workspaceId = 1

beforeEach(() => {
  state.db = new Database(':memory:')
  seedSchema(state.db)
  const db = state.db
  db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (1, ?, ?)').run('One', 'shared')
  db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (2, ?, ?)').run('Two', 'shared')
  db.prepare('INSERT INTO projects (id, name, slug, ticket_prefix, workspace_id, status) VALUES (1, ?, ?, ?, 1, ?)').run('AgentOS Ops', 'agentos-ops', 'AOP', 'active')
  db.prepare('INSERT INTO projects (id, name, slug, ticket_prefix, workspace_id, status) VALUES (2, ?, ?, ?, 1, ?)').run('Game', 'game', 'GME', 'active')
  db.prepare('INSERT INTO projects (id, name, slug, ticket_prefix, workspace_id, status) VALUES (9, ?, ?, ?, 2, ?)').run('Other WS', 'other-ws', 'OWS', 'active')
  state.platoons = [gamutPlatoonFixture(), hermesPlatoonFixture(), codexPlatoonFixture()]
  state.commanders = [
    {
      platoonId: 'gamut',
      commanderName: 'Chief of Staff',
      commanderAvailable: true,
      blocked: false,
      blockReason: null,
      inventoryMode: 'native-profiles',
      agents: [{ id: 'gamut:a', name: 'Alpha' }, { id: 'gamut:b', name: 'Beta' }, { id: 'gamut:c', name: 'Gamma' }],
      notes: [],
    },
    {
      platoonId: 'hermes',
      commanderName: 'orchestrator',
      commanderAvailable: false,
      blocked: true,
      blockReason: 'Hermes orchestrator ESTOP is active',
      inventoryMode: 'native-profiles',
      agents: [],
      notes: [],
    },
  ]
  state.rosterView = rosterViewFixture
})

afterEach(() => {
  state.db?.close()
  state.db = null
  state.platoons = []
  state.commanders = []
  state.rosterView = null
})

describe('buildAgentOSStatusSnapshot', () => {
  it('reports an unconfigured station when no command layer rows or discovered agents exist', () => {
    state.platoons = []
    state.commanders = []
    state.rosterView = { discovered: 0, registered: 0, dispatchable: 0, unavailable: 0, classifications: {}, agents: [] }
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    expect(snapshot.configured).toBe(false)
    expect(snapshot.command.commanded).toBe(0)
    expect(snapshot.execution.missions.total).toBe(0)
    expect(snapshot.command.paused).toEqual([])
    expect(snapshot.platoons).toEqual([])
  })

  it('composes project command state with paused/blocked projects named', () => {
    const db = state.db!
    db.prepare("INSERT INTO agentos_project_command (project_id, workspace_id, state, updated_by, updated_at) VALUES (1, 1, 'paused', 'operator', 1700)").run()
    db.prepare("INSERT INTO agentos_project_command (project_id, workspace_id, state, updated_by, updated_at) VALUES (2, 1, 'active', 'operator', 1800)").run()
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    expect(snapshot.configured).toBe(true)
    expect(snapshot.command.commanded).toBe(2)
    expect(snapshot.command.states).toMatchObject({ paused: 1, active: 1 })
    expect(snapshot.command.paused).toEqual([{ id: 1, name: 'AgentOS Ops', state: 'paused', updatedBy: 'operator', updatedAt: 1700 }])
    expect(snapshot.command.blocked).toEqual([])
    expect(snapshot.timestamps.lastCommandUpdate).toBe(1800)
  })

  it('isolates project command state per workspace', () => {
    state.db!.prepare("INSERT INTO agentos_project_command (project_id, workspace_id, state) VALUES (9, 2, 'paused')").run()
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    expect(snapshot.command.commanded).toBe(0)
    const other = buildAgentOSStatusSnapshot(2)
    expect(other.command.commanded).toBe(1)
    expect(other.command.paused[0].name).toBe('Other WS')
  })

  it('buckets gated missions by task status and ignores non-gated tasks', () => {
    const db = state.db!
    const now = Math.floor(Date.now() / 1000)
    const insert = (id: number, title: string, status: string, metadata: string | null, projectId = 1) => {
      db.prepare('INSERT INTO tasks (id, title, status, project_id, workspace_id, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, title, status, projectId, workspaceId, now, now, metadata)
    }
    insert(1, 'm1', 'assigned', JSON.stringify({ agentos: { objectiveId: 1 } }))
    insert(2, 'm2', 'in_progress', JSON.stringify({ agentos: { objectiveId: 1 } }))
    insert(3, 'm3', 'awaiting_owner', JSON.stringify({ agentos_knowledge_curation: { objective_id: 1 } }))
    insert(4, 'm4', 'done', JSON.stringify({ agentos: { objectiveId: 1 } }))
    insert(5, 'm5', 'failed', JSON.stringify({ agentos_resource_review: { objective_id: 2 } }))
    insert(6, 'plain task', 'assigned', null)
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    expect(snapshot.execution.missions.total).toBe(5)
    expect(snapshot.execution.missions).toMatchObject({ queued: 1, running: 1, held: 1, done: 1, failed: 1 })
    expect(snapshot.configured).toBe(true)
  })

  it('reports per-platoon specialist availability and roster summary', () => {
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    expect(snapshot.roster.dispatchable).toBe(3)
    expect(snapshot.roster.unavailable).toBe(2)
    const gamut = snapshot.platoons.find(p => p.id === 'gamut')!
    expect(gamut.specialists).toEqual({ total: 3, available: 2, unavailable: 1 })
    const hermes = snapshot.platoons.find(p => p.id === 'hermes')!
    expect(hermes.specialists).toEqual({ total: 2, available: 1, unavailable: 1 })
  })

  it('maps platoon host health and merges commander safety state', () => {
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    const byId = new Map(snapshot.platoons.map(p => [p.id, p]))
    expect(byId.get('gamut')!.health).toBe('ready')
    expect(byId.get('hermes')!.health).toBe('degraded')
    expect(byId.get('codex')!.health).toBe('not-installed')
    const hermes = byId.get('hermes')!
    expect(hermes.commander).toMatchObject({ blocked: true, blockReason: 'Hermes orchestrator ESTOP is active', available: false })
  })

  it('surfaces one attention item per task from the newest failed delegation, with project context', () => {
    const db = state.db!
    const now = 5000
    db.prepare(`INSERT INTO agentos_delegations (id, task_id, project_id, workspace_id, platoon_id, specialist_name, status, attempt, error_message, created_at, updated_at)
                VALUES ('d1', 1, 1, 1, 'gamut', 'Alpha', 'failed', 2, 'API Error: 402 Workspace has insufficient balance', 100, 100)`).run()
    db.prepare(`INSERT INTO agentos_delegations (id, task_id, project_id, workspace_id, platoon_id, specialist_name, status, attempt, error_message, created_at, updated_at)
                VALUES ('d2', 1, 1, 1, 'gamut', 'Alpha', 'failed', 3, 'API Error: 402 Workspace has insufficient balance', 200, 200)`).run()
    db.prepare(`INSERT INTO agentos_delegations (id, task_id, project_id, workspace_id, platoon_id, specialist_name, status, attempt, error_message, created_at, updated_at)
                VALUES ('d3', 2, 1, 1, 'hermes', 'Delta', 'failed', 1, 'Host API is unavailable', 300, 300)`).run()
    db.prepare(`INSERT INTO agentos_delegations (id, task_id, project_id, workspace_id, platoon_id, specialist_name, status, attempt, error_message, created_at, updated_at)
                VALUES ('d4', 3, 1, 1, 'gamut', 'Beta', 'completed', 1, NULL, 400, 400)`).run()
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    const delegationItems = snapshot.attention.filter(a => a.kind === 'delegation')
    expect(delegationItems).toHaveLength(2) // one per failed task; completed d4 excluded
    const task1 = delegationItems.find(a => a.taskId === 1)!
    expect(task1.detail).toContain('402')
    expect(task1.title).toContain('attempt 3') // newest attempt wins
    expect(task1.projectName).toBe('AgentOS Ops')
    expect(snapshot.timestamps.lastDelegation).toBe(400)
  })

  it('includes failed and needs-manual objectives in the picture', () => {
    const db = state.db!
    db.prepare("INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (1, 1, 1, 'Suite A', 'failed')").run()
    db.prepare("INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (2, 1, 1, 'Suite B', 'needs_manual')").run()
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    expect(snapshot.execution.objectives.byStatus).toMatchObject({ failed: 1, needs_manual: 1 })
    expect(snapshot.attention.some(a => a.kind === 'objective' && a.level === 'error' && a.title.includes('Objective failed'))).toBe(true)
    expect(snapshot.attention.some(a => a.kind === 'objective' && a.projectName === 'AgentOS Ops')).toBe(true)
  })

  it('reports last roster heartbeat from agentos-external rows', () => {
    state.db!.prepare("INSERT INTO agents (name, role, status, last_seen, workspace_id, source, runtime_type, hidden) VALUES ('agentos:gamut:a', 'r', 'online', 1234, 1, 'agentos-external', 'gamut', 1)").run()
    state.db!.prepare("INSERT INTO agents (name, role, status, last_seen, workspace_id, source, runtime_type, hidden) VALUES ('native', 'r', 'online', 9999, 1, 'mc', 'local', 0)").run()
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    expect(snapshot.timestamps.lastRosterSeen).toBe(1234) // native row ignored
  })
})
