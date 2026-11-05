import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mayAgentosLifecycleAdvance } from '@/lib/project-command'
import { runAegisReviews } from '@/lib/task-dispatch'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  activities: [] as unknown[][],
  gatewayMock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: (...args: unknown[]) => state.activities.push(args) },
}))

vi.mock('@/lib/openclaw-gateway', () => ({
  callOpenClawGateway: (...args: unknown[]) => state.gatewayMock(...args),
}))

const APPROVED_PAYLOAD = { result: { payloads: [{ text: 'VERDICT: APPROVED\nNOTES: looks good' }] } }

function seed(): void {
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, isolation TEXT NOT NULL DEFAULT 'shared');
    CREATE TABLE projects (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, ticket_prefix TEXT);
    CREATE TABLE gateways (status TEXT);
    CREATE TABLE agentos_project_command (
      project_id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL,
      state TEXT, updated_at INTEGER
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY, project_id INTEGER, workspace_id INTEGER,
      status TEXT, priority TEXT, title TEXT, description TEXT,
      resolution TEXT, assigned_to TEXT, project_ticket_no INTEGER,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      config TEXT, workspace_id INTEGER NOT NULL, UNIQUE(name, workspace_id)
    );
    CREATE TABLE quality_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
      reviewer TEXT NOT NULL, status TEXT NOT NULL, notes TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), workspace_id INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO workspaces (id, isolation) VALUES (1, 'shared');
    INSERT INTO projects (id, workspace_id) VALUES (10, 1), (11, 1), (12, 1);
    INSERT INTO gateways (status) VALUES ('healthy');
  `)
  state.activities = []
  state.gatewayMock = vi.fn(async () => APPROVED_PAYLOAD)
}

function setCommand(projectId: number, cmdState: string): void {
  state.db!.prepare(
    `INSERT INTO agentos_project_command (project_id, workspace_id, state, updated_at)
     VALUES (?, 1, ?, unixepoch())
     ON CONFLICT(project_id) DO UPDATE SET state = excluded.state, updated_at = unixepoch()`
  ).run(projectId, cmdState)
}

function addReviewTask(projectId: number | null, status = 'review', at = 1): number {
  const result = state.db!.prepare(
    `INSERT INTO tasks (project_id, workspace_id, status, priority, title, description,
       resolution, assigned_to, created_at, updated_at)
     VALUES (?, 1, ?, 'medium', 'task', 'desc', 'agent resolution text', 'agent', ?, ?)`
  ).run(projectId, status, at, at)
  return Number(result.lastInsertRowid)
}

beforeEach(() => {
  seed()
})

describe('mayAgentosLifecycleAdvance (shared command gate)', () => {
  it('allows unmanaged tasks (no project, no command record) — generic behavior preserved', () => {
    expect(mayAgentosLifecycleAdvance({ projectId: null, workspaceId: 1 })).toMatchObject({ allowed: true, managed: false })
    expect(mayAgentosLifecycleAdvance({ projectId: 12, workspaceId: 1 })).toMatchObject({ allowed: true, managed: false, state: null })
  })

  it('allows advancement only while an AgentOS-managed project is ACTIVE', () => {
    setCommand(10, 'active')
    const gate = mayAgentosLifecycleAdvance({ projectId: 10, workspaceId: 1 })
    expect(gate).toMatchObject({ allowed: true, managed: true, state: 'active' })
  })

  it('holds advancement for non-active AgentOS-managed states (paused/draft/blocked)', () => {
    for (const cmdState of ['paused', 'draft', 'blocked', 'ready']) {
      setCommand(10, cmdState)
      const gate = mayAgentosLifecycleAdvance({ projectId: 10, workspaceId: 1 })
      expect(gate.allowed).toBe(false)
      expect(gate.managed).toBe(true)
      expect(gate.state).toBe(cmdState)
      expect(gate.reason).toContain('ACTIVE')
    }
  })

  it('is project-scoped — a pause on one project never gates another', () => {
    setCommand(10, 'paused')
    expect(mayAgentosLifecycleAdvance({ projectId: 11, workspaceId: 1 }).allowed).toBe(true)
    expect(mayAgentosLifecycleAdvance({ projectId: 10, workspaceId: 1 }).allowed).toBe(false)
  })
})

describe('runAegisReviews honors AgentOS project command', () => {
  it('processes normally when the AgentOS project is ACTIVE', async () => {
    setCommand(10, 'active')
    const taskId = addReviewTask(10)
    const result = await runAegisReviews()
    expect(result.ok).toBe(true)
    expect(state.gatewayMock).toHaveBeenCalled()
    const task = state.db!.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
    expect(task.status).toBe('done')
    const review = state.db!.prepare('SELECT status FROM quality_reviews WHERE task_id = ?').get(taskId) as { status: string }
    expect(review.status).toBe('approved')
  })

  it('does not advance a review task when the AgentOS project is PAUSED', async () => {
    setCommand(10, 'paused')
    const taskId = addReviewTask(10)
    await runAegisReviews()
    const task = state.db!.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
    expect(task.status).toBe('review')
    expect(state.gatewayMock).not.toHaveBeenCalled()
    const count = (state.db!.prepare('SELECT COUNT(*) c FROM quality_reviews WHERE task_id = ?').get(taskId) as { c: number }).c
    expect(count).toBe(0)
    expect(state.activities.some((a) => String((a as unknown[])[0]).includes('agentos_aegis_held'))).toBe(true)
  })

  it('does not move a paused-project task already in quality_review anywhere', async () => {
    setCommand(10, 'paused')
    const taskId = addReviewTask(10, 'quality_review')
    await runAegisReviews()
    const task = state.db!.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
    expect(task.status).toBe('quality_review')
    expect(state.gatewayMock).not.toHaveBeenCalled()
  })

  it('holds a verdict when the project is paused mid-review (no done, no quality record)', async () => {
    setCommand(10, 'active')
    const taskId = addReviewTask(10)
    state.gatewayMock = vi.fn(async () => {
      // Project paused while the review agent is running.
      setCommand(10, 'paused')
      return APPROVED_PAYLOAD
    })
    await runAegisReviews()
    const task = state.db!.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
    expect(task.status).toBe('review') // held pending, NOT done
    const count = (state.db!.prepare('SELECT COUNT(*) c FROM quality_reviews WHERE task_id = ?').get(taskId) as { c: number }).c
    expect(count).toBe(0)
  })

  it('leaves generic non-AgentOS review tasks fully unchanged in behavior', async () => {
    const taskId = addReviewTask(12) // no agentos_project_command record
    await runAegisReviews()
    expect(state.gatewayMock).toHaveBeenCalled()
    const task = state.db!.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
    expect(task.status).toBe('done')
  })

  it('a paused AgentOS project does not block an ACTIVE AgentOS project in the same pass', async () => {
    setCommand(10, 'paused')
    setCommand(11, 'active')
    const pausedTask = addReviewTask(10, 'review', 1)
    const activeTask = addReviewTask(11, 'review', 2)
    await runAegisReviews()
    expect((state.db!.prepare('SELECT status FROM tasks WHERE id = ?').get(pausedTask) as { status: string }).status).toBe('review')
    expect((state.db!.prepare('SELECT status FROM tasks WHERE id = ?').get(activeTask) as { status: string }).status).toBe('done')
  })

  it('a paused AgentOS project does not block generic Mission Control reviews in the same pass', async () => {
    setCommand(10, 'paused')
    const pausedTask = addReviewTask(10, 'review', 1)
    const genericTask = addReviewTask(12, 'review', 2)
    await runAegisReviews()
    expect((state.db!.prepare('SELECT status FROM tasks WHERE id = ?').get(pausedTask) as { status: string }).status).toBe('review')
    expect((state.db!.prepare('SELECT status FROM tasks WHERE id = ?').get(genericTask) as { status: string }).status).toBe('done')
  })
})
