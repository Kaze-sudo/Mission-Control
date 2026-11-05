import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  activities: [] as unknown[],
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: {
    logActivity: (...args: unknown[]) => state.activities.push(args),
  },
}))

import {
  createDelegationForTask,
  getDelegation,
  getLatestDelegationForTask,
  updateDelegation,
} from '@/lib/delegation-ledger'

beforeEach(() => {
  state.activities = []
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      metadata TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
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
      status TEXT NOT NULL,
      native_session_id TEXT,
      native_run_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      result_summary TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    INSERT INTO tasks (id, workspace_id, metadata) VALUES (
      42, 1,
      '{"agentos":{"objectiveId":7},"agentos_routing":{"platoonId":"gamut","agentName":"Enemy AI & Boss Engineer"}}'
    );
  `)
})

afterEach(() => {
  state.db?.close()
  state.db = null
})

describe('AgentOS delegation ledger', () => {
  it('creates a traceable delegation and attaches its ID to task metadata', () => {
    const task = state.db!.prepare('SELECT metadata FROM tasks WHERE id = 42').get() as { metadata: string }
    const created = createDelegationForTask({
      taskId: 42,
      projectId: 3,
      workspaceId: 1,
      routingAgentName: 'AgentOS Gamut Router',
      runtimeType: 'gamut',
      metadata: task.metadata,
      attempt: 1,
    })

    expect(created).toMatchObject({
      taskId: 42,
      projectId: 3,
      objectiveId: 7,
      platoonId: 'gamut',
      specialistName: 'Enemy AI & Boss Engineer',
      runtimeType: 'gamut',
      status: 'claimed',
      attempt: 1,
    })
    const metadata = JSON.parse((state.db!.prepare('SELECT metadata FROM tasks WHERE id = 42').get() as any).metadata)
    expect(metadata.agentos_delegation_id).toBe(created.id)
  })

  it('records native IDs and completion results', () => {
    const created = createDelegationForTask({
      taskId: 42, projectId: 3, workspaceId: 1,
      routingAgentName: 'router', runtimeType: 'gamut',
      metadata: (state.db!.prepare('SELECT metadata FROM tasks WHERE id = 42').get() as any).metadata,
    })
    updateDelegation(created.id, 1, {
      status: 'pending',
      nativeSessionId: 'gamut-session-9',
      nativeRunId: 'run-4',
    })
    const completed = updateDelegation(created.id, 1, {
      status: 'completed',
      resultSummary: 'Boss phase transitions repaired.',
      completed: true,
    })

    expect(completed).toMatchObject({
      status: 'completed',
      nativeSessionId: 'gamut-session-9',
      nativeRunId: 'run-4',
      resultSummary: 'Boss phase transitions repaired.',
    })
    expect(completed?.completedAt).not.toBeNull()
  })

  it('reuses the same delegation ID when a retry is claimed', () => {
    const metadata = (state.db!.prepare('SELECT metadata FROM tasks WHERE id = 42').get() as any).metadata
    const first = createDelegationForTask({
      taskId: 42, projectId: 3, workspaceId: 1,
      routingAgentName: 'router', runtimeType: 'gamut', metadata,
    })
    updateDelegation(first.id, 1, {
      status: 'retrying',
      errorMessage: 'temporary host failure',
    })
    const currentMetadata = (state.db!.prepare('SELECT metadata FROM tasks WHERE id = 42').get() as any).metadata
    const retried = createDelegationForTask({
      taskId: 42, projectId: 3, workspaceId: 1,
      routingAgentName: 'router', runtimeType: 'gamut', metadata: currentMetadata,
      attempt: 2,
    })

    expect(retried.id).toBe(first.id)
    expect(retried.status).toBe('claimed')
    expect(retried.attempt).toBe(2)
    expect(retried.errorMessage).toBeNull()
    expect(getLatestDelegationForTask(42, 1)?.id).toBe(first.id)
    expect(getDelegation(first.id, 1)?.id).toBe(first.id)
  })
})

describe('dispatcher delegation integration contract', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/task-dispatch.ts'), 'utf8')
  const start = source.indexOf('export async function dispatchAssignedTasks()')
  const end = source.indexOf('// Auto-routing:', start)
  const body = source.slice(start, end)

  it('creates delegations only for AgentOS external tasks after the atomic claim', () => {
    const claim = body.indexOf("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'assigned'")
    const gate = body.indexOf("task.agent_source === 'agentos-external'", claim)
    const create = body.indexOf('createDelegationForTask({', gate)
    expect(claim).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(claim)
    expect(create).toBeGreaterThan(gate)
  })

  it('tracks pending, completed, retrying, and failed transitions', () => {
    expect(body).toContain("status: dispatchRunId ? 'pending' : 'accepted'")
    expect(body).toContain("status: 'completed'")
    expect(body).toContain("status: 'retrying'")
    expect(body).toContain("status: 'failed'")
  })
})
