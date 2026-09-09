import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
}))

vi.mock('@/lib/project-force-planning', () => ({
  analyzeProjectForce: () => ({
    bindings: [{}],
    missingCapabilities: [],
    blockedCapabilities: [],
    readiness: { required: 1, ready: 1, percent: 100, status: 'ready' },
  }),
}))

import { checkAgentOSDispatchGuard } from '@/lib/project-command'

const PROJECT_ID = 10
const WORKSPACE_ID = 1
const AGENT = 'Combat Gameplay Engineer'
function setCommand(input: {
  state?: string
  allowed?: string[]
  project?: number
  platoon?: number
  agent?: number
} = {}) {
  state.db!.prepare(`
    INSERT OR REPLACE INTO agentos_project_command (
      project_id, workspace_id, state, auto_route, allow_reroute,
      fallback_behavior, allowed_platoons_json, max_project_concurrent,
      max_platoon_concurrent, max_agent_concurrent
    ) VALUES (?, ?, ?, 1, 1, 'hold', ?, ?, ?, ?)
  `).run(
    PROJECT_ID,
    WORKSPACE_ID,
    input.state || 'active',
    JSON.stringify(input.allowed || ['gamut']),
    input.project || 3,
    input.platoon || 2,
    input.agent || 1,
  )
}

function addTask(status: string, assignedTo: string, source = 'agentos-external', runtime = 'gamut') {
  state.db!.prepare(
    'INSERT INTO tasks (workspace_id, project_id, status, assigned_to) VALUES (?, ?, ?, ?)',
  ).run(WORKSPACE_ID, PROJECT_ID, status, assignedTo)
  state.db!.prepare(
    'INSERT OR IGNORE INTO agents (name, workspace_id, source, runtime_type) VALUES (?, ?, ?, ?)',
  ).run(assignedTo, WORKSPACE_ID, source, runtime)
}

function guard(agent = AGENT, platoonId = 'gamut') {
  return checkAgentOSDispatchGuard({
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    routingAgentName: agent,
    platoonId,
  })
}

beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL);
    CREATE TABLE agentos_project_command (
      project_id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL,
      state TEXT, auto_route INTEGER, allow_reroute INTEGER,
      fallback_behavior TEXT, allowed_platoons_json TEXT,
      max_project_concurrent INTEGER, max_platoon_concurrent INTEGER,
      max_agent_concurrent INTEGER, activated_at INTEGER,
      updated_by TEXT, updated_at INTEGER
    );
    CREATE TABLE agents (
      name TEXT, workspace_id INTEGER, source TEXT, runtime_type TEXT,
      UNIQUE(name, workspace_id)
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER,
      project_id INTEGER, status TEXT, assigned_to TEXT
    );
    INSERT INTO projects (id, workspace_id) VALUES (10, 1);
  `)
  addTask('assigned', AGENT)
})

afterEach(() => {
  state.db?.close()
  state.db = null
})

describe('AgentOS project command dispatch guard', () => {
  it('holds dispatch while the project is PAUSED', () => {
    setCommand({ state: 'paused' })
    expect(guard()).toMatchObject({
      allowed: false,
      state: 'paused',
      reason: expect.stringContaining('ACTIVE is required'),
    })
  })

  it('holds dispatch for a disallowed platoon', () => {
    setCommand({ allowed: ['hermes'] })
    expect(guard()).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('not allowed'),
    })
  })
  it('holds dispatch when project concurrency is full', () => {
    setCommand({ project: 1, platoon: 5, agent: 5 })
    addTask('in_progress', 'Other Gamut Agent')
    expect(guard()).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Project concurrency limit reached'),
      counts: expect.objectContaining({ project: 1 }),
    })
  })

  it('holds dispatch when platoon concurrency is full', () => {
    setCommand({ project: 5, platoon: 1, agent: 5 })
    addTask('in_progress', 'Other Gamut Agent')
    expect(guard()).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Platoon concurrency limit reached'),
      counts: expect.objectContaining({ platoon: 1 }),
    })
  })

  it('holds dispatch when agent concurrency is full', () => {
    setCommand({ project: 5, platoon: 5, agent: 1 })
    addTask('in_progress', AGENT)
    expect(guard()).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Agent concurrency limit reached'),
      counts: expect.objectContaining({ agent: 1 }),
    })
  })
  it('permits an ACTIVE project within all limits', () => {
    setCommand({ project: 3, platoon: 2, agent: 1 })
    expect(guard()).toMatchObject({
      allowed: true,
      state: 'active',
      reason: null,
      counts: { project: 0, platoon: 0, agent: 0 },
    })
  })
})

describe('dispatch guard integration contract', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/task-dispatch.ts'), 'utf8')
  const start = source.indexOf('export async function dispatchAssignedTasks()')
  const end = source.indexOf('// Auto-routing:', start)
  const dispatchLoop = source.slice(start, end)

  it('guards only AgentOS external agents before the atomic task claim', () => {
    const externalGate = dispatchLoop.indexOf("task.agent_source === 'agentos-external'")
    const guardCall = dispatchLoop.indexOf('checkAgentOSDispatchGuard({')
    const claim = dispatchLoop.indexOf("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'assigned'")

    expect(externalGate).toBeGreaterThan(-1)
    expect(guardCall).toBeGreaterThan(externalGate)
    expect(claim).toBeGreaterThan(guardCall)
  })

  it('leaves blocked tasks assigned and records a hold instead of dispatching', () => {
    const externalGate = dispatchLoop.indexOf("task.agent_source === 'agentos-external'")
    const claim = dispatchLoop.indexOf("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'assigned'")
    const guardedBlock = dispatchLoop.slice(externalGate, claim)

    expect(guardedBlock).toContain("if (!guard.allowed)")
    expect(guardedBlock).toContain("'agentos_dispatch_held'")
    expect(guardedBlock).toContain('continue')
    expect(guardedBlock).not.toContain("SET status = 'in_progress'")
  })

  it('preserves the atomic claim so concurrent dispatchers cannot double-dispatch', () => {
    expect(dispatchLoop).toContain("WHERE id = ? AND status = 'assigned'")
    expect(dispatchLoop).toContain('if (claim.changes === 0)')
  })

  it('selects agent source so native Mission Control agents bypass the AgentOS-only guard', () => {
    expect(dispatchLoop).toContain('a.source as agent_source')
    expect(dispatchLoop).toContain("task.agent_source === 'agentos-external'")
  })
})
