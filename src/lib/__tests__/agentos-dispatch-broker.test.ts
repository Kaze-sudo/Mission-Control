import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brokerAgentOSDispatchQueue } from '@/lib/agentos-dispatch-broker'
import { eventBus } from '@/lib/event-bus'

/**
 * Live-state contract for the AgentOS dispatch broker (docs/cli-agent-control.md):
 * every OBSERVABLE task status transition the broker makes must be broadcast as
 * `task.status_changed` so SSE-connected operator surfaces (Runs, Overview)
 * converge instantly. The broker parks (awaiting_owner) and releases (assigned)
 * work on every scheduler tick, so hold+release within a single pass — and
 * steady-state re-holds of already-parked work — must stay silent, or the feed
 * drowns operators in events that carry no state change.
 */

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  commandState: 'active' as string,
  maxProjectConcurrent: 5,
  maxPlatoonConcurrent: 5,
  maxAgentConcurrent: 5,
  allowedPlatoons: [] as string[],
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: () => {} },
}))

vi.mock('@/lib/project-command', () => ({
  getProjectCommand: () => ({
    state: state.commandState,
    policy: {
      allowedPlatoons: state.allowedPlatoons,
      maxProjectConcurrent: state.maxProjectConcurrent,
      maxPlatoonConcurrent: state.maxPlatoonConcurrent,
      maxAgentConcurrent: state.maxAgentConcurrent,
    },
  }),
}))

function seedSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT,
      priority TEXT DEFAULT 'medium', project_id INTEGER, assigned_to TEXT,
      created_at INTEGER, updated_at INTEGER, workspace_id INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      workspace_id INTEGER NOT NULL, source TEXT, runtime_type TEXT
    );
  `)
}

function insertAgent(db: InstanceType<typeof Database>, name: string, runtimeType: string): void {
  db.prepare('INSERT INTO agents (name, workspace_id, source, runtime_type) VALUES (?, 1, ?, ?)')
    .run(name, 'agentos-external', runtimeType)
}

function insertTask(db: InstanceType<typeof Database>, id: number, status: string): void {
  db.prepare('INSERT INTO tasks (id, title, status, project_id, assigned_to, created_at, updated_at, workspace_id) VALUES (?, ?, ?, 1, ?, 1000, 1000, 1)')
    .run(id, `Task ${id}`, status, 'gamut:worker')
}

function statusEvents(spy: ReturnType<typeof vi.spyOn>): Array<{ status: string; previous_status: string; reason?: string; workspace_id: number; id: number }> {
  const calls = spy.mock.calls as unknown as Array<[string, Record<string, unknown>]>
  return calls
    .filter((call) => call[0] === 'task.status_changed')
    .map((call) => call[1] as { status: string; previous_status: string; reason?: string; workspace_id: number; id: number })
}

describe('brokerAgentOSDispatchQueue live-state broadcasts', () => {
  let broadcastSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    state.db = new Database(':memory:')
    seedSchema(state.db)
    insertAgent(state.db, 'gamut:worker', 'gamut')
    state.commandState = 'active'
    state.maxProjectConcurrent = 5
    state.maxPlatoonConcurrent = 5
    state.maxAgentConcurrent = 5
    state.allowedPlatoons = []
    broadcastSpy = vi.spyOn(eventBus, 'broadcast')
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    broadcastSpy.mockRestore()
  })

  it('broadcasts one hold transition for newly assigned work parked by the broker', () => {
    const db = state.db!
    insertTask(db, 1, 'assigned')
    state.maxProjectConcurrent = 0 // never released — stays HELD

    const result = brokerAgentOSDispatchQueue()

    expect(result.held).toBe(1)
    expect(result.released).toBe(0)
    const events = statusEvents(broadcastSpy)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      workspace_id: 1,
      id: 1,
      status: 'awaiting_owner',
      previous_status: 'assigned',
      reason: 'agentos_dispatch_broker_hold',
    })
  })

  it('broadcasts a release transition when previously-parked work is released', () => {
    const db = state.db!
    insertTask(db, 2, 'awaiting_owner') // parked by a previous pass

    const result = brokerAgentOSDispatchQueue()

    expect(result.released).toBe(1)
    const events = statusEvents(broadcastSpy)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      workspace_id: 1,
      id: 2,
      status: 'assigned',
      previous_status: 'awaiting_owner',
      reason: 'agentos_dispatch_broker_release',
    })
  })

  it('stays silent when work is held and released within the same pass (no net transition)', () => {
    const db = state.db!
    insertTask(db, 3, 'assigned') // capacity available → held then released this pass

    const result = brokerAgentOSDispatchQueue()

    expect(result.held).toBe(1)
    expect(result.released).toBe(1)
    expect(statusEvents(broadcastSpy)).toHaveLength(0)
  })

  it('emits nothing on steady-state passes with no observable change', () => {
    const db = state.db!
    insertTask(db, 4, 'assigned')
    state.maxProjectConcurrent = 0

    brokerAgentOSDispatchQueue() // pass 1: hold broadcast (covered above)
    expect(statusEvents(broadcastSpy)).toHaveLength(1)
    broadcastSpy.mockClear()

    brokerAgentOSDispatchQueue() // pass 2: already parked, nothing changed
    brokerAgentOSDispatchQueue() // pass 3: still parked, still silent
    expect(statusEvents(broadcastSpy)).toHaveLength(0)
  })

  it('broadcasts hold and release events with the task workspace for SSE scoping', () => {
    const db = state.db!
    db.prepare('INSERT INTO tasks (id, title, status, project_id, assigned_to, created_at, updated_at, workspace_id) VALUES (11, ?, ?, 1, ?, 1000, 1000, 7)')
      .run('WS task', 'assigned', 'gamut:worker')
    db.prepare('INSERT INTO agents (name, workspace_id, source, runtime_type) VALUES (?, 7, ?, ?)')
      .run('gamut:worker', 'agentos-external', 'gamut')
    state.maxProjectConcurrent = 0

    brokerAgentOSDispatchQueue()

    const events = statusEvents(broadcastSpy)
    expect(events).toHaveLength(1)
    expect(events[0].workspace_id).toBe(7)
    expect(events[0].id).toBe(11)
  })
})
