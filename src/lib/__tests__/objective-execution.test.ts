import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  commandState: 'draft' as 'draft'|'ready'|'active'|'paused'|'blocked',
  allowedPlatoons: [] as string[],
  forceReady: false,
  routed: [] as number[],
  bound: [] as string[],
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: vi.fn() },
}))
vi.mock('@/lib/project-force-planning', () => ({
  analyzeProjectForce: () => ({
    recommendations: state.forceReady ? [] : [recommendation],
    readiness: readiness(),
  }),
}))
vi.mock('@/lib/external-project-bindings', () => ({
  bindExternalAgentToProject: (input: { externalAgentId: string }) => {
    state.bound.push(input.externalAgentId)
    state.forceReady = true
    return { externalAgentId: input.externalAgentId, agentName: 'Enemy AI Engineer', platoonId: 'gamut' }
  },
}))
function commandRecord(value = state.commandState) {
  return {
    state: value,
    policy: { allowedPlatoons: state.allowedPlatoons, allowReroute: false },
  }
}

vi.mock('@/lib/project-command', () => ({
  getProjectCommand: () => commandRecord(),
  updateProjectCommand: () => {
    state.commandState = 'active'
    return commandRecord('active')
  },
}))
vi.mock('@/lib/project-task-routing', () => ({
  routeTaskWithinProject: (input: { taskId: number }) => {
    state.routed.push(input.taskId)
    return { routed: true, taskId: input.taskId }
  },
}))

const recommendation = {
  externalAgentId: 'gamut:enemy-ai',
  name: 'Enemy AI Engineer',
  platoonId: 'gamut',
  capabilities: ['enemy-ai'],
}

function readiness() {
  return {
    required: 1,
    ready: state.forceReady ? 1 : 0,
    percent: state.forceReady ? 100 : 0,
    status: state.forceReady ? 'ready' : 'gaps',
  }
}
import { executeObjective } from '@/lib/objective-planning'

beforeEach(() => {
  state.commandState = 'draft'
  state.allowedPlatoons = []
  state.forceReady = false
  state.routed = []
  state.bound = []
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL);
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, isolation TEXT NOT NULL);
    CREATE TABLE agentos_objectives (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      status TEXT NOT NULL, plan_json TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      status TEXT NOT NULL, assigned_to TEXT, metadata TEXT, updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO projects (id, workspace_id) VALUES (3, 1);
    INSERT INTO workspaces (id, isolation) VALUES (1, 'shared');
  `)
  state.db.exec(`
    INSERT INTO tasks (id, project_id, workspace_id, status, assigned_to, metadata)
      VALUES (11, 3, 1, 'inbox', NULL, '{}');
    INSERT INTO agentos_objectives (id, project_id, workspace_id, status, plan_json)
      VALUES (7, 3, 1, 'planned', '{"missions":[{"taskId":11,"dependsOnTaskIds":[]}]}');
  `)
})

afterEach(() => {
  state.db?.close()
  state.db = null
})

describe('objective execution coordinator', () => {
  it('assembles force, activates a draft project, and routes ready missions', () => {
    const result = executeObjective({ objectiveId: 7, projectId: 3, workspaceId: 1, actor: 'operator' })

    expect(result.executed).toBe(true)
    expect(state.bound).toEqual(['gamut:enemy-ai'])
    expect(state.commandState).toBe('active')
    expect(state.routed).toEqual([11])
  })
  it('does not override a paused project', () => {
    state.commandState = 'paused'
    const result = executeObjective({ objectiveId: 7, projectId: 3, workspaceId: 1 })

    expect(result.executed).toBe(false)
    expect(result.held).toBe(true)
    expect(result.reason).toContain('paused')
    expect(state.commandState).toBe('paused')
    expect(state.routed).toEqual([])
  })

  it('skips recommendations from disallowed platoons', () => {
    state.allowedPlatoons = ['hermes']
    const result = executeObjective({ objectiveId: 7, projectId: 3, workspaceId: 1 })

    expect(result.executed).toBe(false)
    expect(result.held).toBe(true)
    expect(result.reason).toContain('not ready')
    expect(state.bound).toEqual([])
    expect(state.routed).toEqual([])
  })
})
