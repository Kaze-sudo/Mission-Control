import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  routedTaskIds: [] as number[],
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: vi.fn() },
}))

vi.mock('@/lib/project-task-routing', () => ({
  routeTaskWithinProject: (input: { taskId: number }) => {
    state.routedTaskIds.push(input.taskId)
    return { routed: true, taskId: input.taskId }
  },
}))

import { decomposeObjective, promoteReadyObjectiveMissions } from '@/lib/objective-planning'

beforeEach(() => {
  state.routedTaskIds = []
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, isolation TEXT NOT NULL);
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      assigned_to TEXT,
      metadata TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO workspaces (id, isolation) VALUES (1, 'shared'), (2, 'strict');
  `)
})

afterEach(() => {
  state.db?.close()
  state.db = null
})

describe('objective decomposition', () => {
  it('turns natural-language mission lines into capability-aware work', () => {
    const plan = decomposeObjective({
      title: 'Stabilize the DBZ battle slice',
      description: [
        '- Fix boss AI phase transitions',
        '- Repair CI and Unity meta handling',
        'Then validate regression tests',
      ].join('\n'),
    })

    expect(plan.source).toBe('inferred')
    expect(plan.missions).toHaveLength(3)
    expect(plan.missions[0].requiredCapabilities).toContain('enemy-ai')
    expect(plan.missions[1].requiredCapabilities).toContain('build-repository')
    expect(plan.missions[2].requiredCapabilities).toContain('testing-review')
    expect(plan.missions[2].dependsOnKeys).toEqual(['m2'])
  })
  it('keeps independent mission lines parallel by default', () => {
    const plan = decomposeObjective({
      title: 'Parallel improvements',
      description: '- Fix boss AI\n- Fix combat camera shake',
    })

    expect(plan.missions[0].dependsOnKeys).toEqual([])
    expect(plan.missions[1].dependsOnKeys).toEqual([])
    expect(plan.missions[1].requiredCapabilities).toEqual(
      expect.arrayContaining(['combat-systems', 'vfx-camera']),
    )
  })

  it('preserves explicit manual capability overrides', () => {
    const plan = decomposeObjective({
      title: 'Manual plan',
      missions: [{
        key: 'verify',
        title: 'Fix boss AI',
        requiredCapabilities: ['qa-release'],
        preferredCapabilities: [],
      }],
    })

    expect(plan.source).toBe('manual')
    expect(plan.missions[0].requiredCapabilities).toEqual(['qa-release'])
    expect(plan.missions[0].preferredCapabilities).toEqual([])
  })

  it('rejects unknown manual dependencies', () => {
    expect(() => decomposeObjective({
      title: 'Bad graph',
      missions: [{ key: 'b', title: 'Second', dependsOn: ['missing'] }],
    })).toThrow('Unknown mission dependency')
  })
})
describe('objective dependency promotion', () => {
  function addTask(status: string, metadata: unknown, workspaceId = 1): number {
    const result = state.db!.prepare(
      'INSERT INTO tasks (workspace_id, status, assigned_to, metadata) VALUES (?, ?, NULL, ?)',
    ).run(workspaceId, status, JSON.stringify(metadata))
    return Number(result.lastInsertRowid)
  }

  it('promotes and routes a mission only after every dependency is done', () => {
    const dependencyId = addTask('done', {})
    const missionId = addTask('backlog', {
      agentos: {
        objectiveMission: true,
        objectiveId: 7,
        dependsOnTaskIds: [dependencyId],
        executionState: 'blocked',
      },
    })

    expect(promoteReadyObjectiveMissions()).toEqual({
      promoted: [missionId],
      stillBlocked: [],
    })
    const row = state.db!.prepare('SELECT status, metadata FROM tasks WHERE id = ?')
      .get(missionId) as { status: string; metadata: string }
    expect(row.status).toBe('inbox')
    expect(JSON.parse(row.metadata).agentos.executionState).toBe('ready')
    expect(state.routedTaskIds).toEqual([missionId])
  })
  it('keeps a mission blocked while a dependency is unfinished', () => {
    const dependencyId = addTask('in_progress', {})
    const missionId = addTask('backlog', {
      agentos: {
        objectiveMission: true,
        objectiveId: 7,
        dependsOnTaskIds: [dependencyId],
        executionState: 'blocked',
      },
    })

    expect(promoteReadyObjectiveMissions()).toEqual({
      promoted: [],
      stillBlocked: [missionId],
    })
    expect(state.routedTaskIds).toEqual([])
  })

  it('does not promote strict-workspace missions in the shared dispatcher', () => {
    const dependencyId = addTask('done', {}, 2)
    addTask('backlog', {
      agentos: {
        objectiveMission: true,
        objectiveId: 8,
        dependsOnTaskIds: [dependencyId],
        executionState: 'blocked',
      },
    }, 2)

    expect(promoteReadyObjectiveMissions()).toEqual({
      promoted: [],
      stillBlocked: [],
    })
  })
})

describe('objective dispatcher integration', () => {
  it('unlocks dependencies before assigned-task selection', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/task-dispatch.ts'), 'utf8')
    const start = source.indexOf('export async function dispatchAssignedTasks()')
    const end = source.indexOf('// Auto-routing:', start)
    const body = source.slice(start, end)
    const promote = body.indexOf('promoteReadyObjectiveMissions()')
    const select = body.indexOf('SELECT t.*, a.name as agent_name')

    expect(promote).toBeGreaterThan(-1)
    expect(select).toBeGreaterThan(promote)
  })

  it('includes the AgentOS objective migration', () => {
    const migrations = readFileSync(join(process.cwd(), 'src/lib/migrations.ts'), 'utf8')
    expect(migrations).toContain("id: '062_agentos_objectives'")
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS agentos_objectives')
  })
})
