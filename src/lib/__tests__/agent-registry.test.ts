import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAgentRegistrySnapshot } from '@/lib/agent-registry'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  roster: [] as unknown[],
  rosterView: null as unknown,
  platoons: [] as unknown[],
  commanders: [] as unknown[],
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: () => {} },
}))

vi.mock('@/lib/global-agent-roster', () => ({
  getGlobalAgentRoster: () => state.roster,
}))

vi.mock('@/lib/agent-roster-sync', () => ({
  buildRosterView: () => state.rosterView,
  SYNCABLE_PLATOONS: new Set(['gamut', 'hermes', 'codex', 'claude']),
}))

vi.mock('@/lib/platoons', () => ({
  discoverPlatoons: () => state.platoons,
}))

vi.mock('@/lib/platoon-commanders', () => ({
  discoverPlatoonCommanders: () => state.commanders,
}))

function rosterAgent(partial: Record<string, unknown> & { id: string; name: string; platoonId: string }) {
  return {
    role: partial.role ?? partial.name,
    archetype: partial.archetype ?? partial.role ?? partial.name,
    availability: 'available',
    definitionPath: null,
    source: 'filesystem',
    capabilities: { tags: [], source: 'unrated' as const },
    performance: { tasks: 0, completed: 0, completionRate: null },
    provider: null,
    model: null,
    ...partial,
  }
}

const gamutChief = rosterAgent({
  id: 'pc:gamut:chief-of-staff', name: 'Chief of Staff', platoonId: 'gamut',
  role: 'Platoon Commander', availability: 'available',
  capabilities: { tags: ['orchestration'], source: 'declared' },
  provider: 'openrouter', model: 'sonnet',
})
const gamutEnemy = rosterAgent({
  id: 'pc:gamut:enemy-ai', name: 'Enemy AI Engineer', platoonId: 'gamut', availability: 'busy',
  capabilities: { tags: ['enemy-ai', 'game-development'], source: 'inferred' },
  provider: 'openrouter', model: 'sonnet',
})
const gamutUnregistered = rosterAgent({
  id: 'pc:gamut:curator', name: 'Knowledge Curator', platoonId: 'gamut', availability: 'available',
  capabilities: { tags: ['knowledge-curation'], source: 'declared' },
})
const hermesOrchestrator = rosterAgent({
  id: 'pc:hermes:orchestrator', name: 'orchestrator', platoonId: 'hermes', availability: 'offline',
  role: 'Platoon Commander', capabilities: { tags: ['orchestration'], source: 'declared' },
})
const hermesEstimator = rosterAgent({
  id: 'pc:hermes:estimator', name: 'estimator', platoonId: 'hermes', availability: 'offline',
  capabilities: { tags: ['construction-estimating'], source: 'declared' },
})
const claudeWriter = rosterAgent({
  id: 'fs:claude:writer', name: 'writer', platoonId: 'claude', availability: 'available',
  capabilities: { tags: ['documentation'], source: 'declared' },
})
const excludedMcAgent = rosterAgent({ id: 'mc:1', name: 'aegis', platoonId: 'local', availability: 'available' })
const excludedOpenclaw = rosterAgent({ id: 'fs:openclaw:helper', name: 'helper', platoonId: 'openclaw', availability: 'available' })

const workspaceId = 1

function seedSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, workspace_id INTEGER NOT NULL);
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, workspace_id INTEGER NOT NULL,
      source TEXT, last_seen INTEGER, UNIQUE(name, workspace_id)
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT,
      project_id INTEGER, assigned_to TEXT, workspace_id INTEGER,
      created_at INTEGER, updated_at INTEGER, metadata TEXT
    );
    CREATE TABLE agentos_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agentos_delegations (
      id TEXT PRIMARY KEY,
      task_id INTEGER NOT NULL,
      project_id INTEGER,
      workspace_id INTEGER NOT NULL,
      objective_id INTEGER,
      platoon_id TEXT,
      specialist_name TEXT,
      routing_agent_name TEXT,
      runtime_type TEXT,
      status TEXT NOT NULL DEFAULT 'claimed',
      native_session_id TEXT,
      native_run_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      result_summary TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER
    );
  `)
}

beforeEach(() => {
  state.db = new Database(':memory:')
  seedSchema(state.db)
  state.db.prepare('INSERT INTO workspaces (id, name) VALUES (1, ?)').run('One')
  state.db.prepare('INSERT INTO projects (id, name, workspace_id) VALUES (1, ?, 1)').run('AgentOS Ops')
  state.db.prepare('INSERT INTO projects (id, name, workspace_id) VALUES (8, ?, 1)').run('Game')
  state.roster = [gamutChief, gamutEnemy, gamutUnregistered, hermesOrchestrator, hermesEstimator, claudeWriter, excludedMcAgent, excludedOpenclaw]
  state.platoons = [
    { id: 'gamut', name: 'Gamut', installed: true, running: true, authenticated: true, authRequired: false, version: null, health: 'ready' },
    { id: 'hermes', name: 'Hermes', installed: true, running: false, authenticated: false, authRequired: true, version: null, health: 'degraded' },
    { id: 'claude', name: 'Claude', installed: true, running: true, authenticated: true, authRequired: false, version: null, health: 'ready' },
    { id: 'openclaw', name: 'OpenClaw', installed: true, running: true, authenticated: true, authRequired: false, version: null, health: 'ready' },
  ]
  state.commanders = [
    {
      platoonId: 'gamut',
      commanderName: 'Chief of Staff',
      commanderAvailable: true,
      blocked: false,
      blockReason: null,
      inventoryMode: 'native-profiles',
      agents: [
        { id: 'gamut:chief-of-staff', name: 'Chief of Staff', isCommander: true },
        { id: 'gamut:enemy-ai', name: 'Enemy AI Engineer', isCommander: false },
      ],
    },
    {
      platoonId: 'hermes',
      commanderName: 'orchestrator',
      commanderAvailable: false,
      blocked: true,
      blockReason: 'Hermes orchestrator ESTOP is active',
      inventoryMode: 'native-profiles',
      agents: [{ id: 'hermes:orchestrator', name: 'orchestrator', isCommander: true }],
    },
  ]
  state.rosterView = {
    discovered: 8,
    registered: 4,
    dispatchable: 2,
    unavailable: 2,
    classifications: { FREE_LOCAL: 0, PAID_ESTIMATED: 2, UNKNOWN_COST: 3 },
    agents: [
      { externalAgentId: gamutChief.id, name: gamutChief.name, platoonId: 'gamut', availability: 'available', registered: true, routingAgentName: 'agentos:gamut:chief-of-staff', runtimeType: 'gamut', provider: 'openrouter', model: 'sonnet', costClass: 'PAID_ESTIMATED', blocker: null },
      { externalAgentId: gamutEnemy.id, name: gamutEnemy.name, platoonId: 'gamut', availability: 'busy', registered: true, routingAgentName: 'agentos:gamut:enemy-ai', runtimeType: 'gamut', provider: 'openrouter', model: 'sonnet', costClass: 'PAID_ESTIMATED', blocker: null },
      { externalAgentId: hermesOrchestrator.id, name: hermesOrchestrator.name, platoonId: 'hermes', availability: 'offline', registered: true, routingAgentName: 'agentos:hermes:orchestrator', runtimeType: 'hermes', provider: null, model: null, costClass: 'UNKNOWN_COST', blocker: 'Not dispatchable — offline' },
      { externalAgentId: hermesEstimator.id, name: hermesEstimator.name, platoonId: 'hermes', availability: 'offline', registered: true, routingAgentName: 'agentos:hermes:estimator', runtimeType: 'hermes', provider: null, model: null, costClass: 'UNKNOWN_COST', blocker: 'Not dispatchable — offline' },
      { externalAgentId: claudeWriter.id, name: claudeWriter.name, platoonId: 'claude', availability: 'available', registered: true, routingAgentName: 'agentos:claude:writer', runtimeType: 'claude', provider: null, model: null, costClass: 'UNKNOWN_COST', blocker: null },
    ],
  }
})

afterEach(() => {
  state.db?.close()
  state.db = null
})

describe('buildAgentRegistrySnapshot', () => {
  it('maps discovered external specialists into ecosystem groups and excludes non-dispatch ecosystems', () => {
    const snapshot = buildAgentRegistrySnapshot(workspaceId)
    expect(snapshot.ecosystems.map(e => e.id)).toEqual(['gamut', 'hermes', 'claude'])
    expect(snapshot.totals.agents).toBe(6) // pc gamut x3, pc hermes x2, fs claude x1
    expect(snapshot.totals.ecosystems).toBe(3)
    const byId = new Map(snapshot.ecosystems.map(e => [e.id, e]))
    expect(byId.get('gamut')!.agents.map(a => a.name)).toContain('Enemy AI Engineer')
    expect(byId.get('hermes')!.dispatchPath).toContain('Hermes profile CLI')
    expect(byId.get('claude')!.dispatchPath).toContain('Claude Code session')
  })

  it('distinguishes dispatchable from discovered-only and unavailable agents', () => {
    const snapshot = buildAgentRegistrySnapshot(workspaceId)
    const gamut = snapshot.ecosystems.find(e => e.id === 'gamut')!
    const chief = gamut.agents.find(a => a.externalAgentId === gamutChief.id)!
    const enemy = gamut.agents.find(a => a.externalAgentId === gamutEnemy.id)!
    const curator = gamut.agents.find(a => a.externalAgentId === gamutUnregistered.id)!
    expect(chief.dispatchable).toBe(true)
    expect(enemy.dispatchable).toBe(true) // busy is still dispatchable
    expect(curator.dispatchable).toBe(false)
    expect(curator.blockReason).toContain('Reconcile & Bind')
    const hermes = snapshot.ecosystems.find(e => e.id === 'hermes')!
    const estimator = hermes.agents.find(a => a.externalAgentId === hermesEstimator.id)!
    expect(estimator.dispatchable).toBe(false)
    expect(estimator.blockReason).toContain('ESTOP') // orchestrator safety stop outranks per-agent state
    expect(estimator.hostReady).toBe(false)
    expect(snapshot.totals.dispatchable).toBe(3) // chief + enemy + claude writer
    expect(snapshot.totals.discoveredOnly).toBe(1) // curator
  })

  it('preserves ecosystem identity: orchestrator safety state and dispatch path', () => {
    const snapshot = buildAgentRegistrySnapshot(workspaceId)
    const hermes = snapshot.ecosystems.find(e => e.id === 'hermes')!
    expect(hermes.hostReady).toBe(false)
    expect(hermes.hostHealth).toBe('degraded')
    expect(hermes.orchestrator).toMatchObject({ blocked: true, blockReason: 'Hermes orchestrator ESTOP is active' })
    const gamut = snapshot.ecosystems.find(e => e.id === 'gamut')!
    expect(gamut.orchestrator?.name).toBe('Chief of Staff')
    expect(gamut.dispatchPath).toContain('Gamut desktop host API')
    // Orchestrator agents are flagged as commanders, never hidden among specialists.
    const chief = gamut.agents.find(a => a.externalAgentId === gamutChief.id)!
    expect(chief.isCommander).toBe(true)
    expect(gamut.agents.find(a => a.externalAgentId === gamutEnemy.id)!.isCommander).toBe(false)
  })

  it('treats current assignment as transient workload, separate from capabilities and ecosystem', () => {
    state.db!.prepare("INSERT INTO tasks (id, title, status, project_id, assigned_to, workspace_id, created_at, updated_at) VALUES (1, 'Build pack', 'in_progress', 8, 'agentos:gamut:chief-of-staff', 1, 0, 100)").run()
    const snapshot = buildAgentRegistrySnapshot(workspaceId)
    const gamut = snapshot.ecosystems.find(e => e.id === 'gamut')!
    const chief = gamut.agents.find(a => a.externalAgentId === gamutChief.id)!
    expect(chief.assignment).toEqual({
      projectId: 8,
      projectName: 'Game',
      taskId: 1,
      taskTitle: 'Build pack',
      taskStatus: 'in_progress',
    })
    // Identity fields are untouched by the assignment.
    expect(chief.ecosystem).toBe('gamut')
    expect(chief.capabilities).toEqual(['orchestration'])
    expect(chief.costClass).toBe('PAID_ESTIMATED')
    // A different agent with no active work reports idle.
    const enemy = gamut.agents.find(a => a.externalAgentId === gamutEnemy.id)!
    expect(enemy.assignment).toBeNull()
  })

  it('carries runtime identity and cost class into records, and tolerates missing optional fields', () => {
    const snapshot = buildAgentRegistrySnapshot(workspaceId)
    const gamut = snapshot.ecosystems.find(e => e.id === 'gamut')!
    const enemy = gamut.agents.find(a => a.externalAgentId === gamutEnemy.id)!
    expect(enemy.provider).toBe('openrouter')
    expect(enemy.model).toBe('sonnet')
    expect(enemy.costClass).toBe('PAID_ESTIMATED')
    // Claude writer has no view/cost/runtime metadata — record stays valid.
    const claude = snapshot.ecosystems.find(e => e.id === 'claude')!
    const writer = claude.agents[0]
    expect(writer.name).toBe('writer')
    expect(writer.provider).toBeNull()
    expect(writer.model).toBeNull()
    expect(writer.costClass).toBe('UNKNOWN_COST')
    expect(writer.capabilities).toEqual(['documentation'])
    expect(writer.lastSeen).toBeNull()
  })

  it('reports last-seen heartbeats for registered rows', () => {
    state.db!.prepare("INSERT INTO agents (name, workspace_id, source, last_seen) VALUES ('agentos:gamut:chief-of-staff', 1, 'agentos-external', 1234)").run()
    state.db!.prepare("INSERT INTO agents (name, workspace_id, source, last_seen) VALUES ('agentos:claude:writer', 1, 'agentos-external', 5678)").run()
    const snapshot = buildAgentRegistrySnapshot(workspaceId)
    const gamut = snapshot.ecosystems.find(e => e.id === 'gamut')!
    const chief = gamut.agents.find(a => a.externalAgentId === gamutChief.id)!
    expect(chief.lastSeen).toBe(1234)
  })

  it('embeds canonical recent executions per routing agent', () => {
    const db = state.db!
    db.prepare("INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (1, 1, 1, 'Ops objective', 'active')").run()
    db.prepare("INSERT INTO tasks (id, title, status, project_id, assigned_to, workspace_id, created_at, updated_at, metadata) VALUES (1, 'First mission', 'done', 1, 'agentos:gamut:chief-of-staff', 1, 900, 1200, '{}')").run()
    db.prepare("INSERT INTO tasks (id, title, status, project_id, assigned_to, workspace_id, created_at, updated_at, metadata) VALUES (2, 'Second mission', 'failed', 1, 'agentos:gamut:chief-of-staff', 1, 1300, 1600, '{}')").run()
    db.prepare("INSERT INTO tasks (id, title, status, project_id, assigned_to, workspace_id, created_at, updated_at, metadata) VALUES (3, 'Enemy mission', 'done', 1, 'agentos:gamut:enemy-ai', 1, 1000, 1100, '{}')").run()
    for (const row of [
      ['del-a', 1, 'agentos:gamut:chief-of-staff', 'completed', 900, 1200, 1200],
      ['del-b', 2, 'agentos:gamut:chief-of-staff', 'failed', 1300, 1600, 1600],
      ['del-c', 3, 'agentos:gamut:enemy-ai', 'completed', 1000, 1100, 1100],
    ] as const) {
      db.prepare(`
        INSERT INTO agentos_delegations (
          id, task_id, project_id, workspace_id, objective_id, platoon_id,
          routing_agent_name, status, attempt, created_at, updated_at, completed_at
        ) VALUES (?, ?, 1, 1, 1, 'gamut', ?, ?, 1, ?, ?, ?)
      `).run(row[0], row[1], row[2], row[3], row[4], row[5], row[6])
    }

    const snapshot = buildAgentRegistrySnapshot(workspaceId)
    const gamut = snapshot.ecosystems.find(e => e.id === 'gamut')!
    const chief = gamut.agents.find(a => a.externalAgentId === gamutChief.id)!
    // Newest first, capped at five, scoped to this routing agent only.
    expect(chief.recentRuns.map(run => run.delegationId)).toEqual(['del-b', 'del-a'])
    expect(chief.recentRuns[0].taskTitle).toBe('Second mission')
    expect(chief.recentRuns[0].state).toBe('FAILED')
    expect(chief.recentRuns[1].state).toBe('COMPLETED')
    expect(chief.recentRuns[0].projectName).toBe('AgentOS Ops')
    const enemy = gamut.agents.find(a => a.externalAgentId === gamutEnemy.id)!
    expect(enemy.recentRuns.map(run => run.delegationId)).toEqual(['del-c'])
  })
})
