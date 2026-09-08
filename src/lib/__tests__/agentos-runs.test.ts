import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelAgentOSRun,
  classifyRunError,
  deriveRunDisplayState,
  listAgentOSRuns,
  listRecentRunsForAgent,
  retryAgentOSRun,
  runHoldDetails,
  runHoldReason,
} from '@/lib/agentos-runs'
import { useRunEventPulse } from '@/lib/use-run-events'
import { act, renderHook } from '@testing-library/react'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  routeResult: null as unknown,
  commandState: 'active' as string,
  terminateResult: { terminated: true, alreadyEnded: false } as { terminated: boolean; alreadyEnded: boolean },
  terminateThrows: null as string | null,
}))

vi.mock('@/lib/gamut-host', () => ({
  terminateGamutSession: () => {
    if (state.terminateThrows) return Promise.reject(new Error(state.terminateThrows))
    return Promise.resolve(state.terminateResult)
  },
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: () => {} },
}))

vi.mock('@/lib/project-command', () => ({
  getProjectCommand: () => ({ state: state.commandState }),
}))

vi.mock('@/lib/project-task-routing', () => ({
  routeTaskWithinProject: () => state.routeResult,
}))

function seedSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT, isolation TEXT NOT NULL DEFAULT 'shared');
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      workspace_id INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, workspace_id INTEGER NOT NULL,
      source TEXT, runtime_type TEXT, config TEXT
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, status TEXT,
      priority TEXT, project_id INTEGER, assigned_to TEXT, error_message TEXT,
      dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      metadata TEXT, created_at INTEGER, updated_at INTEGER, workspace_id INTEGER
    );
    CREATE TABLE agentos_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
    CREATE TABLE agentos_execution_plans (
      objective_id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PREVIEW',
      plan_json TEXT NOT NULL DEFAULT '{}',
      fingerprint TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agentos_execution_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id TEXT NOT NULL UNIQUE,
      objective_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      approved_task_ids_json TEXT NOT NULL DEFAULT '[]',
      excluded_task_ids_json TEXT NOT NULL DEFAULT '[]',
      fingerprint TEXT NOT NULL,
      max_authorized_amount REAL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

function insertProject(db: InstanceType<typeof Database>, id: number, name: string): void {
  db.prepare('INSERT INTO projects (id, name, slug, workspace_id) VALUES (?, ?, ?, 1)').run(id, name, name.toLowerCase())
}

function insertObjective(db: InstanceType<typeof Database>, id: number, projectId: number, title: string, status = 'active'): void {
  db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (?, ?, 1, ?, ?)')
    .run(id, projectId, title, status)
}

function insertTask(
  db: InstanceType<typeof Database>,
  task: {
    id: number
    title: string
    status: string
    projectId: number | null
    assignedTo?: string | null
    metadata?: string | null
    updatedAt?: number
  },
): void {
  db.prepare(`
    INSERT INTO tasks (id, title, status, project_id, assigned_to, metadata, workspace_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(task.id, task.title, task.status, task.projectId, task.assignedTo ?? null, task.metadata ?? null, task.updatedAt ?? 1000, task.updatedAt ?? 1000)
}

function insertDelegation(
  db: InstanceType<typeof Database>,
  d: {
    id: string
    taskId: number
    projectId: number | null
    objectiveId?: number | null
    platoonId?: string | null
    specialistName?: string | null
    routingAgentName?: string | null
    runtimeType?: string | null
    status: string
    nativeSessionId?: string | null
    nativeRunId?: string | null
    attempt?: number
    resultSummary?: string | null
    errorMessage?: string | null
    createdAt?: number
    updatedAt?: number
    completedAt?: number | null
  },
): void {
  db.prepare(`
    INSERT INTO agentos_delegations (
      id, task_id, project_id, workspace_id, objective_id, platoon_id, specialist_name,
      routing_agent_name, runtime_type, status, native_session_id, native_run_id,
      attempt, result_summary, error_message, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.id, d.taskId, d.projectId, d.objectiveId ?? null, d.platoonId ?? null, d.specialistName ?? null,
    d.routingAgentName ?? null, d.runtimeType ?? null, d.status, d.nativeSessionId ?? null,
    d.nativeRunId ?? null, d.attempt ?? 1, d.resultSummary ?? null, d.errorMessage ?? null,
    d.createdAt ?? 2000, d.updatedAt ?? 2000, d.completedAt ?? null,
  )
}

function missionMetadata(objectiveId: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ agentos: { objectiveId, objectiveMission: true, executionState: 'ready', ...extra } })
}

const gamutAgent = { name: 'gamut:superagent', workspace_id: 1, source: 'agentos-external', runtime_type: 'gamut' }
const hermesAgent = { name: 'hermes:scribe', workspace_id: 1, source: 'agentos-external', runtime_type: 'hermes' }

beforeEach(() => {
  state.db = new Database(':memory:')
  seedSchema(state.db)
  const db = state.db
  insertProject(db, 1, 'Alpha')
  insertProject(db, 2, 'Beta')
  db.prepare('INSERT INTO agents (name, workspace_id, source, runtime_type, config) VALUES (?, 1, ?, ?, ?)').run(
    gamutAgent.name, gamutAgent.source, gamutAgent.runtime_type,
    JSON.stringify({ agentos: { externalAgentId: 'pc:gamut:sluggie' } }),
  )
  db.prepare('INSERT INTO agents (name, workspace_id, source, runtime_type) VALUES (?, 1, ?, ?)').run(hermesAgent.name, hermesAgent.source, hermesAgent.runtime_type)
})

afterEach(() => {
  state.db?.close()
  state.db = null
  state.routeResult = null
  state.commandState = 'active'
  state.terminateResult = { terminated: true, alreadyEnded: false }
  state.terminateThrows = null
})

describe('deriveRunDisplayState', () => {
  it('reports COMPLETED only from real completion, never a dispatch accept', () => {
    expect(deriveRunDisplayState('done', null)).toBe('COMPLETED')
    expect(deriveRunDisplayState('done', 'pending')).toBe('COMPLETED')
    // In-flight accept is RUNNING, not completed.
    expect(deriveRunDisplayState('in_progress', 'pending')).toBe('RUNNING')
    expect(deriveRunDisplayState('in_progress', 'accepted')).toBe('RUNNING')
  })

  it('maps review, held, queued, and waiting states from real statuses', () => {
    expect(deriveRunDisplayState('review', 'completed')).toBe('REVIEWING')
    expect(deriveRunDisplayState('awaiting_owner', null)).toBe('HELD')
    expect(deriveRunDisplayState('backlog', null, { dependencyGated: true })).toBe('WAITING')
    expect(deriveRunDisplayState('backlog', null)).toBe('HELD')
    expect(deriveRunDisplayState('assigned', 'claimed')).toBe('QUEUED')
    expect(deriveRunDisplayState('inbox', null)).toBe('QUEUED')
  })

  it('lets terminal delegation truth outrank task status', () => {
    expect(deriveRunDisplayState('in_progress', 'failed')).toBe('FAILED')
    expect(deriveRunDisplayState('assigned', 'retrying')).toBe('RETRYING')
    expect(deriveRunDisplayState('in_progress', 'cancelled')).toBe('CANCELLED')
  })
})

describe('classifyRunError', () => {
  it('classifies provider, auth, timeout, and host failures distinctly', () => {
    expect(classifyRunError('API Error: 402 Workspace has insufficient balance')).toBe('insufficient_balance')
    expect(classifyRunError('authentication failed: invalid api key')).toBe('authentication')
    expect(classifyRunError('request timed out after 120s')).toBe('timeout')
    expect(classifyRunError('ECONNREFUSED 127.0.0.1:47891')).toBe('host_connection')
    expect(classifyRunError('model not found: gpt-4-unknown')).toBe('model_unavailable')
    expect(classifyRunError('no eligible candidate for mission')).toBe('dispatch_rejected')
  })

  it('returns null for unknown or absent diagnostics', () => {
    expect(classifyRunError(null)).toBeNull()
    expect(classifyRunError('')).toBeNull()
    expect(classifyRunError('some unrelated message')).toBeNull()
  })
})

describe('listAgentOSRuns', () => {
  it('joins delegation runs to task/project/objective identity', () => {
    const db = state.db!
    insertObjective(db, 10, 1, 'Shore up backend')
    insertTask(db, { id: 100, title: 'Fix auth bug', status: 'done', projectId: 1, metadata: missionMetadata(10), updatedAt: 3000 })
    insertDelegation(db, {
      id: 'del-1', taskId: 100, projectId: 1, objectiveId: 10, platoonId: 'gamut',
      specialistName: 'Backend Specialist', routingAgentName: gamutAgent.name, runtimeType: 'gamut',
      status: 'completed', nativeRunId: 'run-abc', attempt: 2,
      resultSummary: 'Fixed the auth bug.', createdAt: 1000, updatedAt: 3000, completedAt: 2900,
    })

    const { runs, summary } = listAgentOSRuns({ workspaceId: 1 })
    const run = runs.find(r => r.id === 'del-1')
    expect(run).toBeDefined()
    expect(run!.taskTitle).toBe('Fix auth bug')
    expect(run!.projectName).toBe('Alpha')
    expect(run!.objectiveTitle).toBe('Shore up backend')
    expect(run!.objectiveStatus).toBe('active')
    expect(run!.ecosystem).toBe('gamut')
    expect(run!.routingAgentName).toBe(gamutAgent.name)
    expect(run!.specialistName).toBe('Backend Specialist')
    expect(run!.state).toBe('COMPLETED')
    expect(run!.durationSeconds).toBe(1900)
    expect(summary.byState.COMPLETED).toBeGreaterThan(0)
  })

  it('classifies failed provider diagnostics and keeps native identity', () => {
    const db = state.db!
    insertTask(db, { id: 101, title: 'Query the API', status: 'failed', projectId: 1, metadata: missionMetadata(10), updatedAt: 4000 })
    insertDelegation(db, {
      id: 'del-2', taskId: 101, projectId: 1, objectiveId: 10, platoonId: 'hermes',
      routingAgentName: hermesAgent.name, status: 'failed',
      errorMessage: 'API Error: 402 Workspace has insufficient balance', attempt: 4,
      nativeSessionId: 'sess-1', createdAt: 3000, updatedAt: 4000, completedAt: 4000,
    })

    const { runs } = listAgentOSRuns({ workspaceId: 1 })
    const run = runs.find(r => r.id === 'del-2')
    expect(run!.state).toBe('FAILED')
    expect(run!.errorClass).toBe('insufficient_balance')
    expect(run!.nativeSessionId).toBe('sess-1')
    expect(run!.attempt).toBe(4)
  })

  it('includes queued objective missions that have not produced a delegation', () => {
    const db = state.db!
    insertObjective(db, 11, 1, 'Ship the dashboard')
    insertTask(db, {
      id: 102, title: 'Build chart view', status: 'assigned', projectId: 1,
      assignedTo: gamutAgent.name,
      metadata: JSON.stringify({
        agentos: { objectiveId: 11, objectiveMission: true, executionState: 'ready' },
        agentos_routing: { platoonId: 'gamut', routingAgentName: gamutAgent.name, agentName: 'Chart Specialist' },
      }),
      updatedAt: 2500,
    })

    const { runs } = listAgentOSRuns({ workspaceId: 1 })
    const queued = runs.find(r => r.id === 'task:102')
    expect(queued).toBeDefined()
    expect(queued!.kind).toBe('task')
    expect(queued!.state).toBe('QUEUED')
    expect(queued!.taskStatus).toBe('assigned')
    expect(queued!.ecosystem).toBe('gamut')
    expect(queued!.objectiveTitle).toBe('Ship the dashboard')
    expect(queued!.delegationId).toBeNull()
  })

  it('survives missing optional runtime fields', () => {
    const db = state.db!
    insertTask(db, { id: 103, title: 'Bare run', status: 'review', projectId: null, updatedAt: 3500 })
    insertDelegation(db, { id: 'del-3', taskId: 103, projectId: null, status: 'completed' })
    const { runs } = listAgentOSRuns({ workspaceId: 1 })
    const run = runs.find(r => r.id === 'del-3')
    expect(run!.state).toBe('REVIEWING')
    expect(run!.ecosystem).toBeNull()
    expect(run!.specialistName).toBeNull()
    expect(run!.nativeRunId).toBeNull()
    expect(run!.errorClass).toBeNull()
    expect(run!.projectName).toBeNull()
  })

  it('filters by project, display state, ecosystem, and agent', () => {
    const db = state.db!
    insertObjective(db, 12, 2, 'Beta objective')
    insertTask(db, { id: 104, title: 'Beta task', status: 'done', projectId: 2, metadata: missionMetadata(12), updatedAt: 5000 })
    insertDelegation(db, {
      id: 'del-4', taskId: 104, projectId: 2, objectiveId: 12, platoonId: 'hermes',
      routingAgentName: hermesAgent.name, status: 'completed', createdAt: 4000, updatedAt: 5000, completedAt: 5000,
    })

    const projectFiltered = listAgentOSRuns({ workspaceId: 1, projectId: 2 })
    expect(projectFiltered.runs.map(r => r.id)).toEqual(['del-4'])

    const stateFiltered = listAgentOSRuns({ workspaceId: 1, states: ['QUEUED'] })
    expect(stateFiltered.runs.some(r => r.state === 'COMPLETED')).toBe(false)

    const ecoFiltered = listAgentOSRuns({ workspaceId: 1, ecosystem: 'hermes' })
    expect(ecoFiltered.runs.some(r => r.id === 'del-4')).toBe(true)
    expect(ecoFiltered.runs.some(r => r.id === 'del-1' || r.id === 'del-2')).toBe(false)

    const agentFiltered = listAgentOSRuns({ workspaceId: 1, agent: hermesAgent.name })
    expect(agentFiltered.runs.map(r => r.id)).toEqual(['del-4'])
  })
})

describe('retryAgentOSRun', () => {
  it('refuses runs that are not in a terminal failed state', () => {
    const db = state.db!
    insertTask(db, { id: 200, title: 'Live task', status: 'assigned', projectId: 1 })
    insertDelegation(db, { id: 'del-200', taskId: 200, projectId: 1, routingAgentName: gamutAgent.name, status: 'claimed' })

    const result = retryAgentOSRun({ workspaceId: 1, taskId: 200, actor: 'tester' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not in a terminal failed state')
    const task = db.prepare('SELECT status FROM tasks WHERE id = 200').get() as { status: string }
    expect(task.status).toBe('assigned')
  })

  it('honors project pause state and never bypasses it', () => {
    const db = state.db!
    state.commandState = 'paused'
    insertTask(db, { id: 201, title: 'Paused project task', status: 'failed', projectId: 1 })
    insertDelegation(db, { id: 'del-201', taskId: 201, projectId: 1, routingAgentName: gamutAgent.name, status: 'failed' })

    const result = retryAgentOSRun({ workspaceId: 1, taskId: 201 })
    expect(result.ok).toBe(false)
    expect(result.held).toBe(true)
    expect(result.reason).toContain('paused')
    // The failed task and its history are untouched.
    const task = db.prepare('SELECT status FROM tasks WHERE id = 201').get() as { status: string }
    expect(task.status).toBe('failed')
    const delegation = db.prepare('SELECT status FROM agentos_delegations WHERE id = ?').get('del-201') as { status: string }
    expect(delegation.status).toBe('failed')
  })

  it('re-enters a failed run through routing and preserves the failed delegation as history', () => {
    const db = state.db!
    state.routeResult = { routed: true, taskId: 202 }
    insertTask(db, { id: 202, title: 'Retry me', status: 'failed', projectId: 1 })
    insertDelegation(db, { id: 'del-202', taskId: 202, projectId: 1, routingAgentName: gamutAgent.name, status: 'failed', attempt: 3 })

    const result = retryAgentOSRun({ workspaceId: 1, delegationId: 'del-202', actor: 'tester' })
    expect(result.ok).toBe(true)
    expect(result.scheduled).toBe(true)
    expect(result.taskId).toBe(202)

    const task = db.prepare('SELECT status, error_message, dispatch_attempts FROM tasks WHERE id = 202').get() as {
      status: string; error_message: string | null; dispatch_attempts: number
    }
    expect(task.status).toBe('inbox')
    expect(task.error_message).toBeNull()
    expect(task.dispatch_attempts).toBe(0)
    // History preserved: the failed delegation row is untouched.
    const delegation = db.prepare('SELECT status, attempt FROM agentos_delegations WHERE id = ?').get('del-202') as { status: string; attempt: number }
    expect(delegation.status).toBe('failed')
    expect(delegation.attempt).toBe(3)
  })

  it('holds the retry with the routing reason when no candidate can be found', () => {
    const db = state.db!
    state.routeResult = { routed: false, reason: 'No bound agent satisfies the mission requirements' }
    insertTask(db, { id: 203, title: 'No candidate', status: 'failed', projectId: 1 })
    insertDelegation(db, { id: 'del-203', taskId: 203, projectId: 1, routingAgentName: gamutAgent.name, status: 'failed' })

    const result = retryAgentOSRun({ workspaceId: 1, taskId: 203 })
    expect(result.ok).toBe(true)
    expect(result.scheduled).toBe(false)
    expect(result.held).toBe(true)
    expect(result.reason).toContain('No bound agent')
    const task = db.prepare('SELECT status, error_message FROM tasks WHERE id = 203').get() as { status: string; error_message: string | null }
    expect(task.status).toBe('failed')
    expect(task.error_message).toContain('Retry held')
  })

  it('rejects a delegation from another workspace', () => {
    const db = state.db!
    insertTask(db, { id: 204, title: 'Other ws', status: 'failed', projectId: 1 })
    insertDelegation(db, { id: 'del-204', taskId: 204, projectId: 1, routingAgentName: gamutAgent.name, status: 'failed' })
    const result = retryAgentOSRun({ workspaceId: 2, delegationId: 'del-204' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not found')
  })
})

describe('cancelAgentOSRun', () => {
  it('cancels a queued task before claim — pure DB transition, any ecosystem', async () => {
    const db = state.db!
    insertTask(db, { id: 400, title: 'Queued mission', status: 'assigned', projectId: 1, metadata: missionMetadata(10), updatedAt: 6000 })

    const result = await cancelAgentOSRun({ workspaceId: 1, taskId: 400, actor: 'tester' })
    expect(result.ok).toBe(true)
    expect(result.cancelled).toBe(true)
    expect(result.scope).toBe('queued')
    const task = db.prepare('SELECT status FROM tasks WHERE id = 400').get() as { status: string }
    expect(task.status).toBe('cancelled')
  })

  it('refuses cancellation of a terminal run', async () => {
    const db = state.db!
    insertTask(db, { id: 401, title: 'Finished mission', status: 'done', projectId: 1, metadata: missionMetadata(10), updatedAt: 6000 })
    insertDelegation(db, { id: 'del-401', taskId: 401, projectId: 1, platoonId: 'gamut', routingAgentName: gamutAgent.name, status: 'completed', createdAt: 5000, updatedAt: 6000, completedAt: 6000 })

    const result = await cancelAgentOSRun({ workspaceId: 1, delegationId: 'del-401' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('already completed')
  })

  it('terminates an active Gamut session at the host and records cancellation', async () => {
    const db = state.db!
    insertTask(db, { id: 402, title: 'Live gamut mission', status: 'in_progress', projectId: 1, metadata: missionMetadata(10), updatedAt: 6000 })
    insertDelegation(db, {
      id: 'del-402', taskId: 402, projectId: 1, platoonId: 'gamut',
      routingAgentName: gamutAgent.name, specialistName: 'Gamut Specialist', runtimeType: 'gamut',
      status: 'claimed', nativeSessionId: 'sess-live', createdAt: 5500, updatedAt: 6000,
    })

    const result = await cancelAgentOSRun({ workspaceId: 1, delegationId: 'del-402', actor: 'tester' })
    expect(result.ok).toBe(true)
    expect(result.cancelled).toBe(true)
    expect(result.scope).toBe('active')
    expect(result.terminated).toBe(true)
    const delegation = db.prepare('SELECT status, error_message, completed_at FROM agentos_delegations WHERE id = ?').get('del-402') as { status: string; error_message: string | null; completed_at: number | null }
    expect(delegation.status).toBe('cancelled')
    expect(delegation.completed_at).not.toBeNull()
    const task = db.prepare('SELECT status FROM tasks WHERE id = 402').get() as { status: string }
    expect(task.status).toBe('cancelled')
  })

  it('refuses to cancel when the Gamut host rejects termination — run stays active', async () => {
    const db = state.db!
    state.terminateThrows = 'Gamut host refused session termination (HTTP 500)'
    insertTask(db, { id: 403, title: 'Host-down mission', status: 'in_progress', projectId: 1, metadata: missionMetadata(10), updatedAt: 6000 })
    insertDelegation(db, {
      id: 'del-403', taskId: 403, projectId: 1, platoonId: 'gamut',
      routingAgentName: gamutAgent.name, status: 'accepted', nativeSessionId: 'sess-host-down', createdAt: 5500, updatedAt: 6000,
    })

    const result = await cancelAgentOSRun({ workspaceId: 1, delegationId: 'del-403' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('refused')
    const delegation = db.prepare('SELECT status FROM agentos_delegations WHERE id = ?').get('del-403') as { status: string }
    expect(delegation.status).toBe('accepted')
    const task = db.prepare('SELECT status FROM tasks WHERE id = 403').get() as { status: string }
    expect(task.status).toBe('in_progress')
  })

  it('refuses active cancellation for executors without a termination path', async () => {
    const db = state.db!
    insertTask(db, { id: 404, title: 'Hermes live', status: 'in_progress', projectId: 1, metadata: missionMetadata(10), updatedAt: 6000 })
    insertDelegation(db, {
      id: 'del-404', taskId: 404, projectId: 1, platoonId: 'hermes',
      routingAgentName: hermesAgent.name, status: 'pending', nativeRunId: 'hermes-run-1', createdAt: 5500, updatedAt: 6000,
    })

    const result = await cancelAgentOSRun({ workspaceId: 1, delegationId: 'del-404' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not supported')
    const delegation = db.prepare('SELECT status FROM agentos_delegations WHERE id = ?').get('del-404') as { status: string }
    expect(delegation.status).toBe('pending')
  })

  it('cancels a claimed delegation that never attached a native session (nothing running remotely)', async () => {
    const db = state.db!
    insertTask(db, { id: 405, title: 'Claimed, pre-execution', status: 'assigned', projectId: 1, metadata: missionMetadata(10), updatedAt: 6000 })
    insertDelegation(db, {
      id: 'del-405', taskId: 405, projectId: 1, platoonId: 'hermes',
      routingAgentName: hermesAgent.name, status: 'claimed', createdAt: 5500, updatedAt: 6000,
    })

    const result = await cancelAgentOSRun({ workspaceId: 1, delegationId: 'del-405' })
    expect(result.ok).toBe(true)
    expect(result.scope).toBe('active')
    const delegation = db.prepare('SELECT status FROM agentos_delegations WHERE id = ?').get('del-405') as { status: string }
    expect(delegation.status).toBe('cancelled')
  })
})

describe('runHoldReason', () => {
  const base = {
    workspaceId: 1, projectId: 1, objectiveId: 10,
    taskStatus: 'assigned', delegationStatus: null, errorMessage: null,
  }

  it('returns null for running, terminal, and completed states', () => {
    expect(runHoldReason({ ...base, state: 'RUNNING' })).toBeNull()
    expect(runHoldReason({ ...base, state: 'REVIEWING' })).toBeNull()
    expect(runHoldReason({ ...base, state: 'COMPLETED' })).toBeNull()
    expect(runHoldReason({ ...base, state: 'CANCELLED' })).toBeNull()
  })

  it('explains a paused project', () => {
    const reason = runHoldReason({ ...base, state: 'QUEUED' }, { commandStateOf: () => 'paused' })
    expect(reason).toContain('paused')
  })

  it('explains a command-policy concurrency hold', () => {
    const reason = runHoldReason({ ...base, state: 'HELD', taskStatus: 'awaiting_owner' })
    expect(reason).toContain('concurrency')
  })

  it('flags awaiting cost approval when the stored plan requires it and none exists', () => {
    const reason = runHoldReason(
      { ...base, state: 'HELD' },
      { planApprovalOf: () => ({ approvalRequired: true, hasApproval: false }) },
    )
    expect(reason).toContain('Awaiting cost approval')
  })

  it('flags a possibly-stale approval when an approval exists but the run is still held', () => {
    const reason = runHoldReason(
      { ...base, state: 'HELD' },
      { planApprovalOf: () => ({ approvalRequired: true, hasApproval: true }) },
    )
    expect(reason).toContain('stale')
  })

  it('classifies a failed provider balance as an HTTP 402 hold/failure', () => {
    const reason = runHoldReason({ ...base, state: 'FAILED', errorMessage: 'API Error: 402 insufficient balance' })
    expect(reason).toContain('402')
  })

  it('exposes stable machine-readable holdCodes so the UI can offer the right next action', () => {
    expect(runHoldDetails({ ...base, state: 'HELD' }, { commandStateOf: () => 'paused' }).code).toBe('project_paused')
    expect(runHoldDetails({ ...base, state: 'HELD' }, { planApprovalOf: () => ({ approvalRequired: true, hasApproval: false }) }).code).toBe('approval_required')
    expect(runHoldDetails({ ...base, state: 'HELD' }, { planApprovalOf: () => ({ approvalRequired: true, hasApproval: true }) }).code).toBe('approval_stale')
    expect(runHoldDetails({ ...base, state: 'FAILED', errorMessage: 'API Error: 402 insufficient balance' }).code).toBe('provider_402')
    expect(runHoldDetails({ ...base, state: 'FAILED', errorMessage: 'connect ECONNREFUSED 127.0.0.1:47891' }).code).toBe('host_connection')
    expect(runHoldDetails({ ...base, state: 'HELD' }, { commandStateOf: () => 'active', planApprovalOf: () => null }).code).toBe('queued_dispatch')
  })

  it('never classifies active or terminal states as held', () => {
    for (const state of ['RUNNING', 'REVIEWING', 'COMPLETED', 'CANCELLED'] as const) {
      expect(runHoldDetails({ ...base, state }).code).toBeNull()
    }
  })

  it('explains plain queued work as waiting for the next scheduler tick', () => {
    const reason = runHoldReason({ ...base, state: 'QUEUED' })
    expect(reason).toContain('Queued for dispatch')
  })
})

describe('listAgentOSRuns hold-reason integration', () => {
  it('attaches approval holds from stored plan rows', () => {
    const db = state.db!
    insertObjective(db, 10, 1, 'Held objective')
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json) VALUES (?, 1, 1, ?, ?)')
      .run(10, 'AWAITING_APPROVAL', JSON.stringify({ summary: { approvalRequired: true } }))
    insertTask(db, { id: 410, title: 'Held mission', status: 'assigned', projectId: 1, metadata: missionMetadata(10), updatedAt: 6000 })

    const { runs } = listAgentOSRuns({ workspaceId: 1, states: ['QUEUED'] })
    const run = runs.find(r => r.id === 'task:410')
    expect(run).toBeDefined()
    expect(run!.holdReason).toContain('Awaiting cost approval')
  })

  it('classifies held runs with a machine-readable holdCode and leaves terminal runs unclassified', () => {
    const db = state.db!
    insertObjective(db, 11, 1, 'Stale objective')
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json) VALUES (?, 1, 1, ?, ?)')
      .run(11, 'AWAITING_APPROVAL', JSON.stringify({ summary: { approvalRequired: true } }))
    insertTask(db, { id: 411, title: 'Stale mission', status: 'assigned', projectId: 1, metadata: missionMetadata(11), updatedAt: 6100 })
    insertTask(db, { id: 900, title: 'Done mission', status: 'done', projectId: 1, updatedAt: 6300 })
    insertDelegation(db, { id: 'del-900', taskId: 900, projectId: 1, routingAgentName: gamutAgent.name, status: 'completed', resultSummary: 'done', updatedAt: 6300, completedAt: 6300 })

    const held = listAgentOSRuns({ workspaceId: 1, states: ['QUEUED'] }).runs.find(r => r.id === 'task:411')
    expect(held).toBeDefined()
    expect(held!.holdCode).toBe('approval_required')
    expect(held!.holdReason).toContain('Awaiting cost approval')

    // Terminal delegation truth: completed work is never misclassified as held.
    const done = listAgentOSRuns({ workspaceId: 1, states: ['COMPLETED'] }).runs.find(r => r.id === 'del-900')
    expect(done).toBeDefined()
    expect(done!.holdCode).toBeNull()
    expect(done!.holdReason).toBeNull()
  })

  it('preserves native run identity and keeps attempts distinct in the feed', () => {
    const db = state.db!
    insertTask(db, { id: 910, title: 'Attempted mission', status: 'done', projectId: 1, updatedAt: 7000 })
    insertDelegation(db, { id: 'del-910-a', taskId: 910, projectId: 1, routingAgentName: hermesAgent.name, status: 'failed', nativeSessionId: 'sess-aaa', nativeRunId: 'run-aaa', attempt: 1, errorMessage: 'boom', updatedAt: 6900, completedAt: 6900 })
    insertDelegation(db, { id: 'del-910-b', taskId: 910, projectId: 1, routingAgentName: hermesAgent.name, status: 'completed', nativeSessionId: 'sess-bbb', nativeRunId: 'run-bbb', attempt: 2, resultSummary: 'recovered', updatedAt: 7000, completedAt: 7000 })

    const runs = listAgentOSRuns({ workspaceId: 1, states: ['FAILED', 'COMPLETED'] }).runs
    const first = runs.find(r => r.id === 'del-910-a')
    const second = runs.find(r => r.id === 'del-910-b')
    expect(first!.attempt).toBe(1)
    expect(first!.nativeSessionId).toBe('sess-aaa')
    expect(first!.state).toBe('FAILED')
    expect(second!.attempt).toBe(2)
    expect(second!.nativeSessionId).toBe('sess-bbb')
    expect(second!.resultSummary).toBe('recovered')
  })
})

describe('useRunEventPulse (SSE refresh dedup)', () => {
  it('debounces a burst of duplicate SSE events into a single refresh', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      renderHook(() => useRunEventPulse(refresh, 250))
      act(() => {
        // At-least-once delivery: the same state change can arrive 3x.
        window.dispatchEvent(new Event('mc:run-events'))
        window.dispatchEvent(new Event('mc:run-events'))
        window.dispatchEvent(new Event('mc:run-events'))
      })
      expect(refresh).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(300) })
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops listening after unmount so duplicate late events cause no refresh', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      const { unmount } = renderHook(() => useRunEventPulse(refresh, 50))
      unmount()
      act(() => {
        window.dispatchEvent(new Event('mc:run-events'))
        vi.advanceTimersByTime(100)
      })
      expect(refresh).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('listRecentRunsForAgent', () => {
  it('returns only that agent\u2019s runs, newest first, capped by limit', () => {
    const db = state.db!
    insertObjective(db, 13, 1, 'Alpha work')
    insertTask(db, { id: 300, title: 'A1', status: 'done', projectId: 1, metadata: missionMetadata(13), updatedAt: 7000 })
    insertTask(db, { id: 301, title: 'A2', status: 'done', projectId: 1, metadata: missionMetadata(13), updatedAt: 8000 })
    insertTask(db, { id: 302, title: 'A3', status: 'done', projectId: 1, metadata: missionMetadata(13), updatedAt: 9000 })
    insertTask(db, { id: 303, title: 'B1', status: 'failed', projectId: 1, metadata: missionMetadata(13), updatedAt: 9500 })
    for (const [id, taskId, agent, at] of [
      ['r-300', 300, gamutAgent.name, 7000],
      ['r-301', 301, gamutAgent.name, 8000],
      ['r-302', 302, gamutAgent.name, 9000],
      ['r-303', 303, hermesAgent.name, 9500],
    ] as const) {
      insertDelegation(db, {
        id, taskId, projectId: 1, objectiveId: 13, platoonId: agent.split(':')[0],
        routingAgentName: agent, status: 'completed', createdAt: at - 100, updatedAt: at, completedAt: at,
      })
    }

    const runs = listRecentRunsForAgent({ workspaceId: 1, agentName: gamutAgent.name, limit: 2 })
    expect(runs).toHaveLength(2)
    expect(runs.map(r => r.taskId)).toEqual([302, 301])
    expect(runs.every(r => r.routingAgentName === gamutAgent.name)).toBe(true)
  })
})
