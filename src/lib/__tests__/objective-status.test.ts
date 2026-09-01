import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as InstanceType<typeof Database> | null }))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: vi.fn() },
}))
vi.mock('@/lib/project-task-routing', () => ({ routeTaskWithinProject: vi.fn() }))
vi.mock('@/lib/project-force-planning', () => ({ analyzeProjectForce: vi.fn() }))
vi.mock('@/lib/external-project-bindings', () => ({ bindExternalAgentToProject: vi.fn() }))
vi.mock('@/lib/project-command', () => ({ getProjectCommand: vi.fn(), updateProjectCommand: vi.fn() }))

import { reconcileObjectiveStatuses } from '@/lib/objective-planning'

beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE agentos_objectives (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      status TEXT NOT NULL, plan_json TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `)
})

afterEach(() => {
  state.db?.close()
  state.db = null
})

function addObjective(status: string, taskStatuses: string[]) {
  const missionPlan = { missions: taskStatuses.map((_, index) => ({ taskId: index + 1 })) }
  state.db!.prepare(
    'INSERT INTO agentos_objectives (id, project_id, workspace_id, status, plan_json) VALUES (7, 3, 1, ?, ?)',
  ).run(status, JSON.stringify(missionPlan))
  const insert = state.db!.prepare(
    'INSERT INTO tasks (id, project_id, workspace_id, status) VALUES (?, 3, 1, ?)',
  )
  taskStatuses.forEach((taskStatus, index) => insert.run(index + 1, taskStatus))
}

function status() {
  return (state.db!.prepare('SELECT status FROM agentos_objectives WHERE id = 7').get() as any).status
}
describe('objective status reconciliation', () => {
  it('marks a planned objective active when mission execution has started', () => {
    addObjective('planned', ['assigned', 'backlog'])
    expect(reconcileObjectiveStatuses()).toEqual([{ objectiveId: 7, previous: 'planned', status: 'active' }])
    expect(status()).toBe('active')
  })

  it('marks an objective completed only when every mission is done', () => {
    addObjective('active', ['done', 'done'])
    reconcileObjectiveStatuses()
    expect(status()).toBe('completed')
  })

  it('marks an objective failed when a mission reaches terminal failure', () => {
    addObjective('active', ['done', 'failed'])
    reconcileObjectiveStatuses()
    expect(status()).toBe('failed')
  })

  it('does not rewrite completed objectives', () => {
    addObjective('completed', ['failed'])
    expect(reconcileObjectiveStatuses()).toEqual([])
    expect(status()).toBe('completed')
  })
})
