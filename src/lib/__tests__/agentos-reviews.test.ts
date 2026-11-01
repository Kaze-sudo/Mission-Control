import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listReviewableTasks } from '@/lib/agentos-reviews'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: () => {} },
}))

function seedSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT, isolation TEXT NOT NULL DEFAULT 'shared');
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      workspace_id INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
    CREATE TABLE quality_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      reviewer TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      workspace_id INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE agentos_execution_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL,
      task_id INTEGER,
      delegation_id TEXT,
      plan_id TEXT,
      approval_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('reserved','released','actual')),
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      input_tokens INTEGER,
      output_tokens INTEGER,
      provider_generation_id TEXT,
      note TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT,
      session_id TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL,
      agent_name TEXT,
      task_id INTEGER,
      workspace_id INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

function insertProject(db: InstanceType<typeof Database>, id: number, name: string): void {
  db.prepare('INSERT INTO projects (id, name, slug, workspace_id) VALUES (?, ?, ?, 1)').run(id, name, name.toLowerCase())
}

function insertObjective(db: InstanceType<typeof Database>, id: number, projectId: number, title: string): void {
  db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title) VALUES (?, ?, 1, ?)')
    .run(id, projectId, title)
}

function insertTask(
  db: InstanceType<typeof Database>,
  task: {
    id: number
    title: string
    status: string
    projectId: number | null
    workspaceId?: number
    metadata?: string | null
    updatedAt?: number
  },
): void {
  db.prepare(`
    INSERT INTO tasks (id, title, status, project_id, metadata, workspace_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id, task.title, task.status, task.projectId, task.metadata ?? null,
    task.workspaceId ?? 1, task.updatedAt ?? 1000, task.updatedAt ?? 1000,
  )
}

function insertDelegation(
  db: InstanceType<typeof Database>,
  d: {
    id: string
    taskId: number
    projectId: number | null
    objectiveId?: number | null
    specialistName?: string | null
    routingAgentName?: string | null
    runtimeType?: string | null
    status: string
    nativeSessionId?: string | null
    attempt?: number
    resultSummary?: string | null
    errorMessage?: string | null
    createdAt?: number
    completedAt?: number | null
  },
): void {
  db.prepare(`
    INSERT INTO agentos_delegations (
      id, task_id, project_id, workspace_id, objective_id, specialist_name,
      routing_agent_name, runtime_type, status, native_session_id,
      attempt, result_summary, error_message, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.id, d.taskId, d.projectId, d.objectiveId ?? null, d.specialistName ?? null,
    d.routingAgentName ?? null, d.runtimeType ?? null, d.status, d.nativeSessionId ?? null,
    d.attempt ?? 1, d.resultSummary ?? null, d.errorMessage ?? null,
    d.createdAt ?? 2000, d.createdAt ?? 2000, d.completedAt ?? null,
  )
}

function insertReview(
  db: InstanceType<typeof Database>,
  r: { taskId: number; reviewer: string; status: string; notes?: string | null; createdAt?: number | null },
): void {
  db.prepare('INSERT INTO quality_reviews (task_id, reviewer, status, notes, workspace_id, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(r.taskId, r.reviewer, r.status, r.notes ?? null, r.createdAt ?? 3000)
}

function missionMetadata(objectiveId: number): string {
  return JSON.stringify({ agentos: { objectiveId, objectiveMission: true, executionState: 'ready' } })
}

describe('listReviewableTasks', () => {
  beforeEach(() => {
    state.db = new Database(':memory:')
    seedSchema(state.db!)
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
  })

  it('lists tasks in review states with delegation identity', () => {
    const db = state.db!
    insertProject(db, 1, 'Probe')
    insertObjective(db, 1, 1, 'Verify the thing')
    insertTask(db, { id: 10, title: 'Executor output', status: 'review', projectId: 1, updatedAt: 5000 })
    insertDelegation(db, {
      id: 'del-1', taskId: 10, projectId: 1, objectiveId: 1,
      specialistName: 'QA Specialist', routingAgentName: 'Aegis', runtimeType: 'hermes',
      status: 'completed', nativeSessionId: 'sess-abc', attempt: 2,
      resultSummary: 'All checks pass', completedAt: 5100, createdAt: 4900,
    })

    const result = listReviewableTasks(1)

    expect(result.summary.total).toBe(1)
    expect(result.summary.awaitingHumanReview).toBe(1)
    expect(result.summary.aegisReviewing).toBe(0)
    const item = result.items[0]
    expect(item.taskId).toBe(10)
    expect(item.taskStatus).toBe('review')
    expect(item.projectName).toBe('Probe')
    expect(item.objectiveId).toBe(1)
    expect(item.objectiveTitle).toBe('Verify the thing')
    expect(item.delegation?.id).toBe('del-1')
    expect(item.delegation?.specialistName).toBe('QA Specialist')
    expect(item.delegation?.ecosystem).toBe('hermes')
    expect(item.delegation?.attempt).toBe(2)
    expect(item.delegation?.resultSummary).toBe('All checks pass')
    expect(item.delegation?.durationSeconds).toBe(200)
  })

  it('resolves objective from metadata when no delegation exists', () => {
    const db = state.db!
    insertProject(db, 2, 'Meta')
    insertObjective(db, 7, 2, 'Meta objective')
    insertTask(db, { id: 11, title: 'No delegation yet', status: 'quality_review', projectId: 2, metadata: missionMetadata(7) })

    const result = listReviewableTasks(1)

    expect(result.summary.total).toBe(1)
    expect(result.summary.aegisReviewing).toBe(1)
    expect(result.items[0].objectiveId).toBe(7)
    expect(result.items[0].objectiveTitle).toBe('Meta objective')
    expect(result.items[0].delegation).toBeNull()
  })

  it('picks the latest quality review record per task', () => {
    const db = state.db!
    insertProject(db, 3, 'Rev')
    insertTask(db, { id: 12, title: 'Reviewed task', status: 'review', projectId: 3 })
    insertReview(db, { taskId: 12, reviewer: 'aegis', status: 'rejected', notes: 'old verdict', createdAt: 3000 })
    insertReview(db, { taskId: 12, reviewer: 'aegis', status: 'approved', notes: 'new verdict', createdAt: 4000 })

    const result = listReviewableTasks(1)

    expect(result.items[0].review?.status).toBe('approved')
    expect(result.items[0].review?.reviewer).toBe('aegis')
    expect(result.items[0].review?.notes).toBe('new verdict')
  })

  it('excludes non-review states and other workspaces', () => {
    const db = state.db!
    insertProject(db, 4, 'Other')
    insertTask(db, { id: 20, title: 'Done task', status: 'done', projectId: 4 })
    insertTask(db, { id: 21, title: 'Failed task', status: 'failed', projectId: 4 })
    insertTask(db, { id: 22, title: 'Review in other workspace', status: 'review', projectId: 4, workspaceId: 9 })

    const result = listReviewableTasks(1)

    expect(result.summary.total).toBe(0)
    expect(result.items).toEqual([])
  })

  it('filters by project and respects the limit', () => {
    const db = state.db!
    insertProject(db, 5, 'A')
    insertProject(db, 6, 'B')
    insertTask(db, { id: 30, title: 'A review', status: 'review', projectId: 5 })
    insertTask(db, { id: 31, title: 'B review', status: 'review', projectId: 6 })

    const scoped = listReviewableTasks(1, { projectId: 5 })
    expect(scoped.summary.total).toBe(1)
    expect(scoped.items[0].taskId).toBe(30)

    const limited = listReviewableTasks(1, { limit: 1 })
    expect(limited.items.length).toBe(1)
    expect(limited.summary.total).toBe(2)
  })

  it('orders by most recently updated first', () => {
    const db = state.db!
    insertProject(db, 7, 'Ord')
    insertTask(db, { id: 40, title: 'Older', status: 'review', projectId: 7, updatedAt: 1000 })
    insertTask(db, { id: 41, title: 'Newer', status: 'review', projectId: 7, updatedAt: 9999 })

    const result = listReviewableTasks(1)

    expect(result.items.map(i => i.taskId)).toEqual([41, 40])
  })

  it('populates actual telemetry from agentos_execution_costs without double-counting', () => {
    const db = state.db!
    insertProject(db, 8, 'Costed')
    insertTask(db, {
      id: 50,
      title: 'Costed task',
      status: 'review',
      projectId: 8,
      metadata: JSON.stringify({ agentos_execution: { estimatedCost: 0.15 } }),
    })
    insertDelegation(db, {
      id: 'del-cost-1',
      taskId: 50,
      projectId: 8,
      status: 'completed',
    })

    // Insert reserved, released, and actual entries. Only 'actual' must be included in actualCost
    db.prepare(`
      INSERT INTO agentos_execution_costs (objective_id, workspace_id, task_id, delegation_id, kind, amount, currency, input_tokens, output_tokens)
      VALUES (1, 1, 50, 'del-cost-1', 'reserved', 0.20, 'USD', null, null)
    `).run()
    db.prepare(`
      INSERT INTO agentos_execution_costs (objective_id, workspace_id, task_id, delegation_id, kind, amount, currency, input_tokens, output_tokens)
      VALUES (1, 1, 50, 'del-cost-1', 'actual', 0.12, 'USD', 45000, 2500)
    `).run()
    db.prepare(`
      INSERT INTO agentos_execution_costs (objective_id, workspace_id, task_id, delegation_id, kind, amount, currency, input_tokens, output_tokens)
      VALUES (1, 1, 50, 'del-cost-1', 'released', 0.20, 'USD', null, null)
    `).run()

    // Also insert token_usage to verify deduplication (execution_costs takes precedence)
    db.prepare(`
      INSERT INTO token_usage (model, task_id, workspace_id, input_tokens, output_tokens, cost_usd)
      VALUES ('gpt-5.6', 50, 1, 99999, 99999, 5.00)
    `).run()

    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.telemetry.source).toBe('execution_ledger')
    expect(item.telemetry.actualCost).toBe(0.12)
    expect(item.telemetry.currency).toBe('USD')
    expect(item.telemetry.inputTokens).toBe(45000)
    expect(item.telemetry.outputTokens).toBe(2500)
    expect(item.telemetry.estimatedCost).toBe(0.15)
    expect(item.telemetry.costDelta).toBeNull()
    expect(item.telemetry.scope).toBe('attempt')
  })

  it('handles missing telemetry truthfully without inventing zeros', () => {
    const db = state.db!
    insertProject(db, 9, 'Uncosted')
    insertTask(db, { id: 60, title: 'No cost data', status: 'review', projectId: 9 })

    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.telemetry.source).toBe('none')
    expect(item.telemetry.actualCost).toBeNull()
    expect(item.telemetry.inputTokens).toBeNull()
    expect(item.telemetry.outputTokens).toBeNull()
    expect(item.telemetry.costDelta).toBeNull()
  })

  it('aggregates multiple model calls from token_usage when execution_costs is absent', () => {
    const db = state.db!
    insertProject(db, 10, 'TokenDriven')
    insertTask(db, { id: 70, title: 'Multi model task', status: 'review', projectId: 10 })

    db.prepare(`
      INSERT INTO token_usage (model, task_id, workspace_id, input_tokens, output_tokens, cost_usd)
      VALUES ('claude-3-haiku', 70, 1, 1000, 200, 0.01)
    `).run()
    db.prepare(`
      INSERT INTO token_usage (model, task_id, workspace_id, input_tokens, output_tokens, cost_usd)
      VALUES ('claude-sonnet-5', 70, 1, 5000, 1000, 0.08)
    `).run()

    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.telemetry.source).toBe('token_usage')
    expect(item.telemetry.actualCost).toBeCloseTo(0.09)
    expect(item.telemetry.inputTokens).toBe(6000)
    expect(item.telemetry.outputTokens).toBe(1200)
    expect(item.telemetry.scope).toBe('task_aggregate')
  })

  it('preserves workspace isolation for telemetry records', () => {
    const db = state.db!
    insertProject(db, 11, 'Iso')
    insertTask(db, { id: 80, title: 'Task in ws 1', status: 'review', projectId: 11, workspaceId: 1 })

    // Insert actual cost in workspace 2 for the same taskId
    db.prepare(`
      INSERT INTO agentos_execution_costs (objective_id, workspace_id, task_id, kind, amount, currency, input_tokens, output_tokens)
      VALUES (1, 2, 80, 'actual', 1.50, 'USD', 10000, 2000)
    `).run()

    const result = listReviewableTasks(1)
    expect(result.items[0].telemetry.actualCost).toBeNull()
    expect(result.items[0].telemetry.source).toBe('none')
  })
  it('keeps sub-cent costs and independent missing token fields with unknown completeness', () => {
    const db = state.db!
    insertTask(db, { id: 90, title: 'Tiny usage', status: 'review', projectId: null })
    db.exec(`INSERT INTO token_usage (task_id, workspace_id, input_tokens, output_tokens, cost_usd)
      VALUES (90, 1, NULL, 0, 0.00012)`)
    const telemetry = listReviewableTasks(1).items[0].telemetry
    expect(telemetry.actualCost).toBe(0.00012)
    expect(telemetry.inputTokens).toBeNull()
    expect(telemetry.outputTokens).toBe(0)
    expect(telemetry.completeness).toBe('partial')
    expect(telemetry.costDelta).toBeNull()
  })

  it('keeps multiple rows in the same latest delegation attempt-scoped', () => {
    const db = state.db!
    insertTask(db, { id: 91, title: 'Multiple calls', status: 'review', projectId: null })
    insertDelegation(db, { id: 'latest', taskId: 91, projectId: null, status: 'completed', attempt: 2 })
    db.exec(`INSERT INTO agentos_execution_costs (objective_id, workspace_id, task_id, delegation_id, kind, amount, currency, input_tokens, output_tokens)
      VALUES (1, 1, 91, 'latest', 'actual', 0.0001, 'USD', 1, 2),
             (1, 1, 91, 'latest', 'actual', 0.0002, 'USD', 3, 4)`)
    const telemetry = listReviewableTasks(1).items[0].telemetry
    expect(telemetry.scope).toBe('attempt')
    expect(telemetry.actualCost).toBeCloseTo(0.0003)
    expect(telemetry.inputTokens).toBe(4)
    expect(telemetry.completeness).toBe('unknown')
    expect(telemetry.costDelta).toBeNull()
  })

  it('does not attribute older attempts to the latest or sum mixed currencies', () => {
    const db = state.db!
    insertTask(db, { id: 92, title: 'Retries', status: 'review', projectId: null })
    insertDelegation(db, { id: 'new', taskId: 92, projectId: null, status: 'completed', attempt: 2 })
    db.exec(`INSERT INTO agentos_execution_costs (objective_id, workspace_id, task_id, delegation_id, kind, amount, currency, input_tokens, output_tokens)
      VALUES (1, 1, 92, 'old', 'actual', 1, 'USD', 10, NULL),
             (1, 1, 92, 'new', 'actual', 2, 'EUR', 20, 4)`)
    const telemetry = listReviewableTasks(1).items[0].telemetry
    expect(telemetry.scope).toBe('task_aggregate')
    expect(telemetry.actualCost).toBeNull()
    expect(telemetry.currency).toBeNull()
    expect(telemetry.mixedCurrencies).toBe(true)
    expect(telemetry.outputTokens).toBe(4)
    expect(telemetry.isPartial).toBe(true)
  })

  it('keeps ledger precedence when token fields are missing rather than adding fallback records', () => {
    const db = state.db!
    insertTask(db, { id: 93, title: 'Partial ledger', status: 'review', projectId: null })
    db.exec(`INSERT INTO agentos_execution_costs (objective_id, workspace_id, task_id, kind, amount)
      VALUES (1, 1, 93, 'actual', 0);
      INSERT INTO token_usage (task_id, workspace_id, input_tokens, output_tokens, cost_usd)
      VALUES (93, 1, 100, 100, 5), (93, 2, 900, 900, 9)`)
    const telemetry = listReviewableTasks(1).items[0].telemetry
    expect(telemetry.actualCost).toBe(0)
    expect(telemetry.inputTokens).toBeNull()
    expect(telemetry.outputTokens).toBeNull()
    expect(telemetry.source).toBe('execution_ledger')
    expect(telemetry.completeness).toBe('partial')
  })

  it('handles empty review queue (no tasks at all)', () => {
    const db = state.db!
    // No tasks inserted - empty queue
    const result = listReviewableTasks(1)
    expect(result.summary.total).toBe(0)
    expect(result.summary.awaitingHumanReview).toBe(0)
    expect(result.summary.aegisReviewing).toBe(0)
    expect(result.items).toEqual([])
  })

  it('handles task with null projectId and null projectName', () => {
    const db = state.db!
    insertProject(db, 14, 'NullProject')
    insertTask(db, { id: 94, title: 'No project', status: 'review', projectId: null })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.projectId).toBeNull()
    expect(item.projectName).toBeNull()
  })

  it('handles task with null/malformed metadata', () => {
    const db = state.db!
    insertProject(db, 15, 'BadMeta')
    insertTask(db, { id: 95, title: 'Bad metadata', status: 'review', projectId: 15, metadata: null })
    insertTask(db, { id: 96, title: 'Malformed metadata', status: 'review', projectId: 15, metadata: 'not json' })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(2)
    result.items.forEach(item => {
      expect(item.objectiveId).toBeNull()
      expect(item.objectiveTitle).toBeNull()
    })
  })

  it('handles review with null notes and null createdAt', () => {
      const db = state.db!
      insertProject(db, 16, 'NullReview')
      insertTask(db, { id: 97, title: 'Review with null fields', status: 'review', projectId: 16 })
      insertReview(db, { taskId: 97, reviewer: 'aegis', status: 'approved', notes: null })
      const result = listReviewableTasks(1)
      expect(result.items).toHaveLength(1)
      const item = result.items[0]
      expect(item.review).not.toBeNull()
      expect(item.review?.reviewer).toBe('aegis')
      expect(item.review?.status).toBe('approved')
      expect(item.review?.notes).toBeNull()
      expect(item.review?.createdAt).toBeNull()
    })

  it('handles delegation with all null optional fields', () => {
    const db = state.db!
    insertProject(db, 17, 'NullDelegation')
    insertTask(db, { id: 98, title: 'Null delegation', status: 'review', projectId: 17 })
    insertDelegation(db, {
      id: 'del-null',
      taskId: 98,
      projectId: 17,
      specialistName: null,
      routingAgentName: null,
      runtimeType: null,
      status: 'completed',
      nativeSessionId: null,
      attempt: 1,
      resultSummary: null,
      errorMessage: null,
      createdAt: 2000,
      completedAt: null,
    })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.delegation).not.toBeNull()
    expect(item.delegation?.id).toBe('del-null')
    expect(item.delegation?.specialistName).toBeNull()
    expect(item.delegation?.routingAgentName).toBeNull()
    expect(item.delegation?.ecosystem).toBeNull()
    expect(item.delegation?.nativeSessionId).toBeNull()
    expect(item.delegation?.resultSummary).toBeNull()
    expect(item.delegation?.errorMessage).toBeNull()
    expect(item.delegation?.completedAt).toBeNull()
    expect(item.delegation?.durationSeconds).toBeNull()
  })

  it('handles multiple delegations (latest attempt wins)', () => {
    const db = state.db!
    insertProject(db, 18, 'MultiDelegation')
    insertTask(db, { id: 99, title: 'Multiple delegations', status: 'review', projectId: 18 })
    insertDelegation(db, {
      id: 'del-attempt-1',
      taskId: 99,
      projectId: 18,
      status: 'completed',
      attempt: 1,
      resultSummary: 'First attempt',
      createdAt: 2000,
      completedAt: 2100,
    })
    insertDelegation(db, {
      id: 'del-attempt-2',
      taskId: 99,
      projectId: 18,
      status: 'completed',
      attempt: 2,
      resultSummary: 'Second attempt (latest)',
      createdAt: 2200,
      completedAt: 2300,
    })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.delegation?.id).toBe('del-attempt-2')
    expect(item.delegation?.attempt).toBe(2)
    expect(item.delegation?.resultSummary).toBe('Second attempt (latest)')
    expect(item.delegation?.durationSeconds).toBe(100)
  })

  it('handles multiple reviews (latest created_at wins)', () => {
    const db = state.db!
    insertProject(db, 19, 'MultiReview')
    insertTask(db, { id: 100, title: 'Multiple reviews', status: 'review', projectId: 19 })
    insertReview(db, { taskId: 100, reviewer: 'aegis', status: 'rejected', notes: 'First review', createdAt: 3000 })
    insertReview(db, { taskId: 100, reviewer: 'aegis', status: 'approved', notes: 'Second review (latest)', createdAt: 4000 })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.review?.status).toBe('approved')
    expect(item.review?.reviewer).toBe('aegis')
    expect(item.review?.notes).toBe('Second review (latest)')
    expect(item.review?.createdAt).toBe(4000)
  })

  it('handles pending review (no quality_review record)', () => {
    const db = state.db!
    insertProject(db, 20, 'PendingReview')
    insertTask(db, { id: 101, title: 'Pending review', status: 'review', projectId: 20 })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.taskStatus).toBe('review')
    expect(item.review).toBeNull()
  })

  it('handles Aegis review state (taskStatus: quality_review)', () => {
    const db = state.db!
    insertProject(db, 21, 'AegisReview')
    insertTask(db, { id: 102, title: 'Aegis review', status: 'quality_review', projectId: 21 })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.taskStatus).toBe('quality_review')
    expect(item.review).toBeNull()
    expect(result.summary.aegisReviewing).toBe(1)
    expect(result.summary.awaitingHumanReview).toBe(0)
  })

  it('handles human review state (taskStatus: review)', () => {
    const db = state.db!
    insertProject(db, 22, 'HumanReview')
    insertTask(db, { id: 103, title: 'Human review', status: 'review', projectId: 22 })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.taskStatus).toBe('review')
    expect(item.review).toBeNull()
    expect(result.summary.awaitingHumanReview).toBe(1)
    expect(result.summary.aegisReviewing).toBe(0)
  })

  it('handles approved review state', () => {
    const db = state.db!
    insertProject(db, 23, 'ApprovedReview')
    insertTask(db, { id: 104, title: 'Approved review', status: 'review', projectId: 23 })
    insertReview(db, { taskId: 104, reviewer: 'aegis', status: 'approved', notes: 'All good', createdAt: 5000 })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.review?.status).toBe('approved')
    expect(item.review?.reviewer).toBe('aegis')
    expect(item.review?.notes).toBe('All good')
  })

  it('handles rejected review state', () => {
    const db = state.db!
    insertProject(db, 24, 'RejectedReview')
    insertTask(db, { id: 105, title: 'Rejected review', status: 'review', projectId: 24 })
    insertReview(db, { taskId: 105, reviewer: 'aegis', status: 'rejected', notes: 'Needs rework', createdAt: 6000 })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.review?.status).toBe('rejected')
    expect(item.review?.reviewer).toBe('aegis')
    expect(item.review?.notes).toBe('Needs rework')
  })

  it('handles result summaries in delegation', () => {
    const db = state.db!
    insertProject(db, 25, 'ResultSummary')
    insertTask(db, { id: 106, title: 'Task with result summary', status: 'review', projectId: 25 })
    insertDelegation(db, {
      id: 'del-result',
      taskId: 106,
      projectId: 25,
      status: 'completed',
      resultSummary: 'Successfully completed all objectives',
      createdAt: 7000,
      completedAt: 7100,
    })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.delegation?.resultSummary).toBe('Successfully completed all objectives')
  })

  it('handles error/failure information in delegation', () => {
    const db = state.db!
    insertProject(db, 26, 'ErrorInfo')
    insertTask(db, { id: 107, title: 'Task with error', status: 'review', projectId: 26 })
    insertDelegation(db, {
      id: 'del-error',
      taskId: 107,
      projectId: 26,
      status: 'failed',
      errorMessage: 'Out of memory during execution',
      createdAt: 8000,
      completedAt: 8100,
    })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.delegation?.errorMessage).toBe('Out of memory during execution')
  })

  it('handles execution attempt IDs', () => {
    const db = state.db!
    insertProject(db, 27, 'AttemptId')
    insertTask(db, { id: 108, title: 'Task with attempt', status: 'review', projectId: 27 })
    insertDelegation(db, {
      id: 'del-attempt-123',
      taskId: 108,
      projectId: 27,
      status: 'completed',
      attempt: 3,
      createdAt: 9000,
      completedAt: 9100,
    })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.delegation?.id).toBe('del-attempt-123')
    expect(item.delegation?.attempt).toBe(3)
  })

  it('handles native run/session IDs', () => {
    const db = state.db!
    insertProject(db, 28, 'NativeSession')
    insertTask(db, { id: 109, title: 'Task with native session', status: 'review', projectId: 28 })
    insertDelegation(db, {
      id: 'del-native',
      taskId: 109,
      projectId: 28,
      status: 'completed',
      nativeSessionId: 'sess-abc-123',
      createdAt: 10000,
      completedAt: 10100,
    })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.delegation?.nativeSessionId).toBe('sess-abc-123')
  })

  it('handles duration calculation', () => {
    const db = state.db!
    insertProject(db, 29, 'Duration')
    insertTask(db, { id: 110, title: 'Task with duration', status: 'review', projectId: 29 })
    insertDelegation(db, {
      id: 'del-duration',
      taskId: 110,
      projectId: 29,
      status: 'completed',
      createdAt: 11000,
      completedAt: 11500,
    })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.delegation?.durationSeconds).toBe(500)
  })

  it('handles provider/model metadata (ecosystem)', () => {
    const db = state.db!
    insertProject(db, 30, 'ProviderMeta')
    insertTask(db, { id: 111, title: 'Task with provider', status: 'review', projectId: 30 })
    insertDelegation(db, {
      id: 'del-provider',
      taskId: 111,
      projectId: 30,
      status: 'completed',
      runtimeType: 'hermes',
      createdAt: 12000,
      completedAt: 12100,
    })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.delegation?.ecosystem).toBe('hermes')
  })

  it('handles cost/token telemetry fields', () => {
    const db = state.db!
    insertProject(db, 31, 'Telemetry')
    insertTask(db, { id: 112, title: 'Task with telemetry', status: 'review', projectId: 31 })
    insertDelegation(db, {
      id: 'del-telemetry',
      taskId: 112,
      projectId: 31,
      status: 'completed',
      createdAt: 13000,
      completedAt: 13100,
    })
    db.exec(`INSERT INTO agentos_execution_costs (objective_id, workspace_id, task_id, delegation_id, kind, amount, currency, input_tokens, output_tokens)
      VALUES (1, 1, 112, 'del-telemetry', 'actual', 0.15, 'USD', 5000, 1000)`)
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.telemetry.actualCost).toBe(0.15)
    expect(item.telemetry.currency).toBe('USD')
    expect(item.telemetry.inputTokens).toBe(5000)
    expect(item.telemetry.outputTokens).toBe(1000)
    expect(item.telemetry.source).toBe('execution_ledger')
    expect(item.telemetry.scope).toBe('attempt')
  })

  it('handles workspace/tenant isolation for telemetry', () => {
    const db = state.db!
    insertProject(db, 32, 'Isolation')
    insertTask(db, { id: 113, title: 'Isolation test', status: 'review', projectId: 32, workspaceId: 1 })
    // Insert telemetry in workspace 2 for the same taskId
    db.exec(`INSERT INTO agentos_execution_costs (objective_id, workspace_id, task_id, kind, amount, currency, input_tokens, output_tokens)
      VALUES (1, 2, 113, 'actual', 1.50, 'USD', 10000, 2000)`)
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.telemetry.actualCost).toBeNull()
    expect(item.telemetry.source).toBe('none')
  })

  it('handles deterministic ordering by updated_at DESC', () => {
    const db = state.db!
    insertProject(db, 33, 'OrderTest')
    insertTask(db, { id: 114, title: 'First', status: 'review', projectId: 33, updatedAt: 1000 })
    insertTask(db, { id: 115, title: 'Second', status: 'review', projectId: 33, updatedAt: 2000 })
    insertTask(db, { id: 116, title: 'Third', status: 'review', projectId: 33, updatedAt: 3000 })
    const result = listReviewableTasks(1)
    expect(result.items.map(i => i.taskId)).toEqual([116, 115, 114])
  })

  it('handles project filtering with null projectId', () => {
    const db = state.db!
    insertProject(db, 34, 'FilterTest')
    insertTask(db, { id: 117, title: 'No project', status: 'review', projectId: null })
    insertTask(db, { id: 118, title: 'With project', status: 'review', projectId: 34 })
    const result = listReviewableTasks(1)
    expect(result.items).toHaveLength(2)
    const noProject = result.items.find(i => i.projectId === null)
    const withProject = result.items.find(i => i.projectId === 34)
    expect(noProject).toBeDefined()
    expect(withProject).toBeDefined()
  })

})