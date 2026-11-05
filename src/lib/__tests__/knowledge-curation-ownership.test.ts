import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerRosterAgents, syncAgentRoster } from '@/lib/agent-roster-sync'
import { agentosRoutingAgentName as stableName } from '@/lib/external-project-bindings'
import { rankAgentsForMission } from '@/lib/agent-selection'
import { routeTaskWithinProject } from '@/lib/project-task-routing'
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

vi.mock('@/lib/ai-resource-registry', () => ({
  recommendAiResources: () => [],
  toTaskResourceAttachment: () => ({}),
}))

function rosterAgent(partial: Partial<GlobalRosterAgent> & { id: string; name: string; platoonId: string; caps: string[] }): GlobalRosterAgent {
  return {
    role: partial.role || partial.name,
    archetype: partial.role || partial.name,
    availability: 'available',
    definitionPath: `D:\\agents\\${partial.platoonId}\\${partial.name}`,
    source: 'filesystem',
    performance: { tasks: 0, completed: 0, completionRate: null },
    ...partial,
    capabilities: { tags: partial.caps, source: 'declared' },
  }
}

// Real ownership: these specialists carry knowledge-curation + a domain, as a
// genuine AgentOS curator definition would (evidence-based, not fabricated).
const tacticalCurator = rosterAgent({
  id: 'pc:gamut:curator-tac', name: 'Technical Writer & Tactical Knowledge Curator (AgentOS Ops)', platoonId: 'gamut',
  role: 'Owns curation of approved tactical reference material into AgentOS knowledge packs',
  caps: ['knowledge-curation', 'tactical-encounters', 'architecture', 'game-development'],
})
const aiCurator = rosterAgent({
  id: 'pc:gamut:curator-ai', name: 'Enemy AI Reference Curator (AgentOS Ops)', platoonId: 'gamut',
  role: 'Owns enemy-AI reference guides and knowledge pack authoring',
  caps: ['knowledge-curation', 'enemy-ai', 'tactical-encounters'],
})
const qaCurator = rosterAgent({
  id: 'pc:gamut:curator-qa', name: 'QA Release Evidence Curator (AgentOS Ops)', platoonId: 'gamut',
  role: 'Owns verification reference material and suite validation reports',
  caps: ['knowledge-curation', 'qa-release', 'testing-review'],
})
// Weak candidate: matches the tactical domain but has NO curation ownership.
const director = rosterAgent({
  id: 'pc:gamut:director2', name: 'Game Director & Systems Designer (DBZ Tactics)', platoonId: 'gamut',
  role: 'Game director — design authority only',
  caps: ['tactical-encounters', 'game-direction'],
})
const enemyEngineer = rosterAgent({
  id: 'pc:gamut:enemy', name: 'Enemy AI & Boss Engineer (DBZ Tactics)', platoonId: 'gamut',
  role: 'Enemy behavior engineer — no curation duty',
  caps: ['enemy-ai', 'tactical-encounters'],
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
    CREATE TABLE agentos_project_force_profiles (
      project_id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      required_capabilities_json TEXT NOT NULL DEFAULT '[]',
      preferred_capabilities_json TEXT NOT NULL DEFAULT '[]',
      preferred_platoons_json TEXT NOT NULL DEFAULT '[]',
      max_team_size INTEGER,
      updated_by TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agentos_routing_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL, project_id INTEGER, workspace_id INTEGER NOT NULL,
      status TEXT NOT NULL, requirements_json TEXT NOT NULL DEFAULT '{}',
      candidates_json TEXT NOT NULL DEFAULT '[]',
      selected_external_agent_id TEXT, selected_platoon_id TEXT,
      selected_routing_agent_name TEXT, reason TEXT, actor TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

let workspaceId = 1

function seedMissionTask(db: InstanceType<typeof Database>, id: number, title: string, required: string[], preferred: string[], status = 'inbox'): void {
  const metadata = JSON.stringify({
    agentos: {
      objectiveId: 1,
      objectiveMission: true,
      requiredCapabilities: required,
      preferredCapabilities: preferred,
    },
  })
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, project_id, assigned_to, workspace_id, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, 'medium', 1, NULL, 1, 0, 0, ?)
  `).run(id, title, title, status, metadata)
}

beforeEach(() => {
  state.db = new Database(':memory:')
  state.activities = []
  seedSchema(state.db)
  state.db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (1, ?, ?)').run('One', 'shared')
  state.db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (2, ?, ?)').run('Two', 'shared')
  state.db.prepare('INSERT INTO projects (id, name, slug, ticket_prefix, workspace_id, status) VALUES (1, ?, ?, ?, 1, ?)').run('Ops', 'agentos-operations', 'OPS', 'active')
  state.db.prepare("INSERT INTO agentos_project_command (project_id, workspace_id, state) VALUES (1, 1, 'active')").run()
  state.roster = [tacticalCurator, aiCurator, qaCurator, enemyEngineer, director]
})

afterEach(() => {
  state.db?.close()
  state.db = null
})

describe('curator ranking (domain-matched curator wins)', () => {
  it('a curated domain specialist outranks the domain engineer without curation when knowledge-curation is required', () => {
    const ranked = rankAgentsForMission(
      [tacticalCurator, enemyEngineer, aiCurator, director],
      { requiredCapabilities: ['knowledge-curation', 'tactical-encounters'], preferredCapabilities: ['architecture'] },
    )
    expect(ranked.find(c => c.agent.id === tacticalCurator.id)!.eligible).toBe(true)
    expect(ranked.find(c => c.agent.id === director.id)!.eligible).toBe(false)
    expect(ranked.find(c => c.agent.id === enemyEngineer.id)!.eligible).toBe(false)
    expect(ranked[0].agent.id).toBe(tacticalCurator.id)
  })

  it('different missions select different specialists by domain affinity', () => {
    const m1 = rankAgentsForMission(
      [tacticalCurator, aiCurator, qaCurator],
      { requiredCapabilities: ['knowledge-curation', 'tactical-encounters'], preferredCapabilities: ['architecture'] },
    )
    const m5 = rankAgentsForMission(
      [tacticalCurator, aiCurator, qaCurator],
      { requiredCapabilities: ['knowledge-curation', 'tactical-encounters'], preferredCapabilities: ['enemy-ai'] },
    )
    const m6 = rankAgentsForMission(
      [tacticalCurator, aiCurator, qaCurator],
      { requiredCapabilities: ['knowledge-curation'], preferredCapabilities: ['qa-release', 'testing-review'] },
    )
    expect(m1[0].agent.id).toBe(tacticalCurator.id)
    expect(m5[0].agent.id).toBe(aiCurator.id)
    expect(m6[0].agent.id).toBe(qaCurator.id)
  })
})

describe('roster reconciliation propagates curator ownership', () => {
  it('registers curators without duplicates and propagates the capability into the binding snapshot', () => {
    const first = syncAgentRoster({ workspaceId, projectId: 1, actor: 'test' })
    expect(first.registered).toBe(5)
    expect(first.boundAdded).toBe(5)
    const name = stableName(tacticalCurator)
    expect(state.db!.prepare("SELECT COUNT(*) c FROM agents WHERE name = ? AND workspace_id = 1").get(name) as any).toMatchObject({ c: 1 })
    const binding = state.db!.prepare("SELECT capability_snapshot FROM project_external_agent_bindings WHERE project_id = 1 AND external_agent_id = 'pc:gamut:curator-tac'").get() as any
    expect(JSON.parse(binding.capability_snapshot)).toEqual(expect.arrayContaining(['knowledge-curation', 'tactical-encounters']))
    const second = syncAgentRoster({ workspaceId, projectId: 1, actor: 'test' })
    expect(second.added).toBe(0)
    expect(second.boundAdded).toBe(0)
  })

  it('isolates registrations per workspace', () => {
    registerRosterAgents({ workspaceId: 1, actor: 'test' })
    registerRosterAgents({ workspaceId: 2, roster: [aiCurator], actor: 'test' })
    expect(state.db!.prepare("SELECT COUNT(*) c FROM agents WHERE workspace_id = 1 AND source = 'agentos-external'").get() as any).toMatchObject({ c: 5 })
    expect(state.db!.prepare("SELECT COUNT(*) c FROM agents WHERE workspace_id = 2 AND source = 'agentos-external'").get() as any).toMatchObject({ c: 1 })
    // Stable identity: same specialist maps to the same proxy name in both workspaces.
    expect(state.db!.prepare('SELECT name FROM agents WHERE workspace_id = 2 AND source = ?').get('agentos-external') as any).toMatchObject({ name: stableName(aiCurator) })
  })
})

describe('objective-1 style routing with qualified curators', () => {
  function seedMissions(): void {
    const db = state.db!
    seedMissionTask(db, 10, 'Curate: tactical-encounter-design-patterns (M1)', ['knowledge-curation', 'tactical-encounters'], ['architecture'])
    seedMissionTask(db, 11, 'Curate: deployment-and-spawn-schemas (M2)', ['knowledge-curation', 'tactical-encounters'], [])
    seedMissionTask(db, 12, 'Curate: terrain-and-movement-models (M3)', ['knowledge-curation', 'tactical-encounters'], ['game-development'])
    seedMissionTask(db, 13, 'Curate: tactical-ai-reference (M5)', ['knowledge-curation', 'tactical-encounters'], ['enemy-ai'])
    seedMissionTask(db, 14, 'Validate Tactical Knowledge Pack Suite (M6)', ['knowledge-curation'], ['testing-review', 'qa-release'], 'backlog')
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, plan_json, created_by) VALUES (1, 1, 1, ?, ?, ?)')
      .run('Build Tactical Encounter Knowledge Pack Suite', '{}', 'test')
    db.prepare("UPDATE agentos_objectives SET plan_json = ? WHERE id = 1").run(JSON.stringify({
      missions: [
        { key: 'm1', taskId: 10, dependsOnKeys: [] },
        { key: 'm2', taskId: 11, dependsOnKeys: [] },
        { key: 'm3', taskId: 12, dependsOnKeys: [] },
        { key: 'm5', taskId: 13, dependsOnKeys: [] },
        { key: 'm6', taskId: 14, dependsOnKeys: ['m1', 'm2', 'm3', 'm5'] },
      ],
    }))
  }

  it('routes M1/M3 to the tactical curator, M5 to the enemy-AI curator; M6 stays dependency-gated', () => {
    syncAgentRoster({ workspaceId, projectId: 1, roster: [tacticalCurator, aiCurator, qaCurator, enemyEngineer, director], actor: 'test' })
    seedMissions()

    const m1 = routeTaskWithinProject({ taskId: 10, workspaceId, actor: 'test' })
    expect(m1.routed).toBe(true)
    expect(m1.selected?.agentName).toBe(tacticalCurator.name)
    const m3 = routeTaskWithinProject({ taskId: 12, workspaceId, actor: 'test' })
    expect(m3.routed).toBe(true)
    expect(m3.selected?.agentName).toBe(tacticalCurator.name)
    const m5 = routeTaskWithinProject({ taskId: 13, workspaceId, actor: 'test' })
    expect(m5.routed).toBe(true)
    expect(m5.selected?.agentName).toBe(aiCurator.name)

    const m1Row = state.db!.prepare('SELECT status, assigned_to FROM tasks WHERE id = 10').get() as any
    expect(m1Row.status).toBe('assigned')
    expect(m1Row.assigned_to).toBe(stableName(tacticalCurator))

    // M6 is dependency-gated: it stays backlog and unassigned — only the
    // objective dependency promotion (covered by the objective-planning
    // suites) can release it, and only after M1–M5 are done.
    const m6Row = state.db!.prepare('SELECT status, assigned_to FROM tasks WHERE id = 14').get() as any
    expect(m6Row.status).toBe('backlog')
    expect(m6Row.assigned_to).toBeNull()
  })

  it('refuses to route when no bound curator owns knowledge-curation (no fabrication)', () => {
    syncAgentRoster({ workspaceId, projectId: 1, roster: [director, enemyEngineer], actor: 'test' })
    seedMissions()
    const m1 = routeTaskWithinProject({ taskId: 10, workspaceId, actor: 'test' })
    expect(m1.routed).toBe(false)
    expect(m1.reason).toMatch(/No bound agent satisfies/)
    expect((state.db!.prepare('SELECT status FROM tasks WHERE id = 10').get() as any).status).toBe('inbox')
  })

  it('keeps registered curators truthfully UNKNOWN_COST without free-local evidence', () => {
    const report = syncAgentRoster({ workspaceId, projectId: 1, actor: 'test' })
    expect(report.classifications.FREE_LOCAL).toBe(0)
    expect(report.classifications.UNKNOWN_COST).toBe(5)
    expect(classifyExecutionCost({ runtimeType: 'gamut' }).costClass).toBe('UNKNOWN_COST')
  })
})
