import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncAgentRoster, type RosterSyncReport } from '@/lib/agent-roster-sync'
import { getGamutHostEffectiveRuntime, invalidateGamutEffectiveRuntimeCache } from '@/lib/gamut-host'
import { getPlatoonCommander } from '@/lib/platoon-commanders'
import { buildExecutionPlan, classifyExecutionCost, DEFAULT_EXECUTION_POLICY } from '@/lib/execution-planning'
import { agentosRoutingAgentName as stableName } from '@/lib/external-project-bindings'
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

const curator = rosterAgent({
  id: 'pc:gamut:p40nnujai8', name: 'Knowledge & Technical Synthesis Specialist', platoonId: 'gamut',
  role: 'Shared AgentOS specialist owning curation of approved reference material into reusable knowledge packs',
  capabilities: { tags: ['knowledge-curation', 'research', 'documentation', 'architecture'], source: 'declared' },
  provider: 'openrouter', model: 'sonnet',
})
const localCurator = rosterAgent({
  id: 'pc:gamut:local-test', name: 'Local Curator', platoonId: 'gamut',
  role: 'Local curator specialist',
  capabilities: { tags: ['knowledge-curation'], source: 'declared' },
  provider: 'local', model: 'qwen2.5-coder:7b',
})
const noMetaCurator = rosterAgent({
  id: 'pc:gamut:no-meta', name: 'No Meta Curator', platoonId: 'gamut',
  role: 'Curator without runtime evidence',
  capabilities: { tags: ['knowledge-curation'], source: 'declared' },
})
const hermesProfile = rosterAgent({
  id: 'pc:hermes:architect', name: 'architect', platoonId: 'hermes',
  availability: 'offline', role: 'Hermes profile',
  capabilities: { tags: ['architecture'], source: 'declared' },
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

describe('Gamut effective runtime resolution (settings file)', () => {
  let appData = ''
  const originalAppData = process.env.APPDATA

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'mc-gamut-rt-'))
    process.env.APPDATA = appData
    invalidateGamutEffectiveRuntimeCache()
  })

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true })
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    invalidateGamutEffectiveRuntimeCache()
  })

  it('resolves host-wide provider/model from settings.json (openrouter/sonnet)', () => {
    mkdirSync(join(appData, 'Superagent'), { recursive: true })
    writeFileSync(join(appData, 'Superagent', 'settings.json'), JSON.stringify({
      llmProvider: 'openrouter',
      models: { summarizerModel: 'haiku', agentModel: 'sonnet', browserModel: 'sonnet', agentEffort: 'medium' },
    }))
    const rt = getGamutHostEffectiveRuntime()
    expect(rt.provider).toBe('openrouter')
    expect(rt.model).toBe('sonnet')
    expect(rt.source).toBe('settings-file')
  })

  it('never leaks secrets from settings.json', () => {
    mkdirSync(join(appData, 'Superagent'), { recursive: true })
    writeFileSync(join(appData, 'Superagent', 'settings.json'), JSON.stringify({
      llmProvider: 'openrouter',
      models: { agentModel: 'sonnet' },
      apiKeys: { openrouter: 'sk-live-secret-value-12345' },
      auth: { token: 'super-secret-token' },
      platformAuth: 'another-secret',
    }))
    const rt = getGamutHostEffectiveRuntime()
    const dumped = JSON.stringify(rt)
    expect(dumped).not.toContain('sk-live-secret')
    expect(dumped).not.toContain('super-secret')
    expect(rt.provider).toBe('openrouter')
    expect(rt.model).toBe('sonnet')
  })

  it('reports none when no settings file exists', () => {
    const rt = getGamutHostEffectiveRuntime()
    expect(rt.provider).toBeNull()
    expect(rt.model).toBeNull()
    expect(rt.source).toBe('none')
  })

  it('Gamut discovery inherits provider/model onto every specialist descriptor', () => {
    mkdirSync(join(appData, 'Superagent', 'agents', 'p40nnujai8', 'workspace'), { recursive: true })
    writeFileSync(join(appData, 'Superagent', 'settings.json'), JSON.stringify({
      llmProvider: 'openrouter',
      models: { agentModel: 'sonnet' },
    }))
    writeFileSync(join(appData, 'Superagent', 'agents', 'p40nnujai8', 'workspace', 'CLAUDE.md'), [
      '---',
      'name: "Knowledge & Technical Synthesis Specialist"',
      'description: "Shared AgentOS specialist owning curation of approved reference material into reusable knowledge packs"',
      '---',
      'Mission: Turn approved sources into reusable, attributed AgentOS knowledge.',
      'Primary ownership: AgentOS knowledge curation, cross-source technical synthesis, technical writing.',
    ].join('\n'))
    const commander = getPlatoonCommander('gamut')
    const agent = commander?.agents.find(a => a.id === 'gamut:p40nnujai8')
    expect(agent).toBeTruthy()
    expect(agent?.provider).toBe('openrouter')
    expect(agent?.model).toBe('sonnet')
  })
})

describe('cost classification truthfulness', () => {
  it('localhost host runtime + remote paid provider → PAID_ESTIMATED, never FREE_LOCAL', () => {
    const classified = classifyExecutionCost({ runtimeType: 'gamut', provider: 'openrouter', model: 'sonnet' })
    expect(classified.costClass).toBe('PAID_ESTIMATED')
    expect(classified.provider).toBe('openrouter')
    expect(classified.model).toBe('sonnet')
    expect(classified.estimatedCost).toBeNull() // no invented pricing
  })

  it('declared local provider → FREE_LOCAL', () => {
    const classified = classifyExecutionCost({ runtimeType: 'gamut', provider: 'local', model: 'qwen2.5-coder:7b' })
    expect(classified.costClass).toBe('FREE_LOCAL')
  })

  it('host runtime with no provider/model → UNKNOWN_COST (never default-free)', () => {
    const classified = classifyExecutionCost({ runtimeType: 'gamut' })
    expect(classified.costClass).toBe('UNKNOWN_COST')
    expect(classified.warnings.length).toBeGreaterThan(0)
  })

  it('explicit freeLocal evidence on a host runtime → FREE_LOCAL', () => {
    const classified = classifyExecutionCost({
      runtimeType: 'gamut',
      agentConfig: { agentos: { cost: { freeLocal: true } } },
    })
    expect(classified.costClass).toBe('FREE_LOCAL')
  })
})

describe('roster sync propagation (discovery → registration → classification)', () => {
  let appData = ''
  const originalAppData = process.env.APPDATA

  function writeHostSettings(llmProvider: string, agentModel: string): void {
    mkdirSync(join(appData, 'Superagent'), { recursive: true })
    writeFileSync(join(appData, 'Superagent', 'settings.json'), JSON.stringify({
      llmProvider,
      models: { summarizerModel: 'haiku', agentModel, browserModel: 'sonnet', agentEffort: 'medium' },
    }))
    invalidateGamutEffectiveRuntimeCache()
  }

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'mc-gamut-roster-'))
    process.env.APPDATA = appData
    // The plan builder resolves the CURRENT host runtime (settings.json) for
    // gamut agents — give it a deterministic openrouter/sonnet host fixture so
    // plan assertions are hermetic regardless of the real machine's settings.
    writeHostSettings('openrouter', 'sonnet')
    state.db = new Database(':memory:')
    state.activities = []
    seedSchema(state.db)
    state.db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (1, ?, ?)').run('One', 'shared')
    state.db.prepare('INSERT INTO projects (id, name, slug, ticket_prefix, workspace_id, status) VALUES (8, ?, ?, ?, 1, ?)').run('Ops', 'agentos-operations', 'OPS', 'active')
    state.roster = [curator, localCurator, noMetaCurator, hermesProfile]
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    rmSync(appData, { recursive: true, force: true })
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    invalidateGamutEffectiveRuntimeCache()
  })

  it('writes inherited provider/model into registered agent config and classifies truthfully', () => {
    const report = syncAgentRoster({ workspaceId: 1, projectId: 8, actor: 'test' }) as RosterSyncReport
    const row = state.db!.prepare('SELECT config FROM agents WHERE name = ? AND workspace_id = 1').get(stableName(curator)) as { config: string }
    const config = JSON.parse(row.config)
    expect(config.provider).toBe('openrouter')
    expect(config.model).toBe('sonnet')
    expect(report.classifications.PAID_ESTIMATED).toBe(1)
    expect(report.classifications.FREE_LOCAL).toBe(1)
    expect(report.classifications.UNKNOWN_COST).toBe(2) // no-meta curator + hermes profile
    const curatorEntry = report.agents.find(a => a.externalAgentId === curator.id)
    expect(curatorEntry?.provider).toBe('openrouter')
    expect(curatorEntry?.model).toBe('sonnet')
    expect(curatorEntry?.costClass).toBe('PAID_ESTIMATED')
    const localEntry = report.agents.find(a => a.externalAgentId === localCurator.id)
    expect(localEntry?.costClass).toBe('FREE_LOCAL')
    const noMetaEntry = report.agents.find(a => a.externalAgentId === noMetaCurator.id)
    expect(noMetaEntry?.costClass).toBe('UNKNOWN_COST')
  })

  it('keeps stable identities and never duplicates on re-sync', () => {
    const first = syncAgentRoster({ workspaceId: 1, actor: 'test' })
    const second = syncAgentRoster({ workspaceId: 1, actor: 'test' })
    expect(second.added).toBe(0)
    expect(second.updated).toBe(0)
    const count = state.db!.prepare("SELECT COUNT(*) c FROM agents WHERE source = 'agentos-external' AND workspace_id = 1").get() as { c: number }
    expect(count.c).toBe(4)
    expect(first.registered).toBe(second.registered)
  })

  it('unrelated Hermes specialists are unaffected by Gamut metadata', () => {
    const report = syncAgentRoster({ workspaceId: 1, actor: 'test' })
    const hermesEntry = report.agents.find(a => a.externalAgentId === hermesProfile.id)
    expect(hermesEntry?.provider).toBeNull()
    expect(hermesEntry?.model).toBeNull()
    expect(hermesEntry?.costClass).toBe('UNKNOWN_COST')
    expect(hermesEntry?.availability).toBe('offline')
  })

  it('execution preview uses resolved runtime metadata from the registered agent config', () => {
    syncAgentRoster({ workspaceId: 1, actor: 'test' })
    const proxy = stableName(curator)
    const now = Math.floor(Date.now() / 1000)
    state.db!.prepare(`INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status, plan_json) VALUES (1, 8, 1, 'Suite', 'active', ?)`)
      .run(JSON.stringify({ missions: [{ key: 'm1', title: 'Curate: patterns', taskId: 9 }] }))
    state.db!.prepare(`INSERT INTO tasks (id, title, status, project_id, assigned_to, workspace_id, metadata) VALUES (9, 'Curate: patterns', 'assigned', 8, ?, 1, ?)`)
      .run(proxy, JSON.stringify({ agentos: { requiredCapabilities: ['knowledge-curation'] } }))
    const plan = buildExecutionPlan({ objectiveId: 1, workspaceId: 1, policy: DEFAULT_EXECUTION_POLICY, actor: 'test' })
    expect(plan.missions[0].provider).toBe('openrouter')
    expect(plan.missions[0].model).toBe('sonnet')
    expect(plan.missions[0].costClass).toBe('PAID_ESTIMATED')
    expect(plan.missions[0].requiresApproval).toBe(true) // paid work never auto-runs
    expect(plan.summary.paidMissions).toBe(1)
    expect(plan.summary.freeMissions).toBe(0)
  })
})