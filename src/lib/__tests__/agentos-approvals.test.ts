import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listApprovalRequiredPlans } from '@/lib/agentos-approvals'
import type { ExecutionPlan } from '@/lib/execution-planning'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: () => {} },
}))

let fingerprintSeq = 0

function planJson(overrides: {
  objectiveId?: number
  fingerprint?: string
  approvalRequired?: boolean
  missions?: ExecutionPlan['missions']
  estimatedTotalCost?: number | null
} = {}): string {
  const objectiveId = overrides.objectiveId ?? 10
  const missions: ExecutionPlan['missions'] = overrides.missions ?? [
    {
      taskId: 401,
      missionKey: 'm1',
      title: 'Write the thing',
      status: 'assigned',
      assignedTo: 'gamut:superagent',
      platoon: 'build',
      specialist: 'builder',
      runtimeType: 'gamut',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      modelResolved: 'gpt-5.6-terra',
      pricingSource: 'gamut-catalog-fallback',
      costClass: 'PAID_KNOWN',
      estimatedCost: 0.04,
      estimatedInputTokens: null,
      estimatedOutputTokens: null,
      maximumAuthorizedInputTokens: null,
      maximumAuthorizedOutputTokens: null,
      maximumCostPerAttempt: 0.02,
      maxAttempts: 3,
      maximumMissionExposure: 0.08,
      retriesIncluded: true,
      costBasis: 'catalog-estimate',
      requiresApproval: true,
      dependencies: [],
      resources: [],
      runtimeAccess: 'host-api',
      warnings: [],
    },
  ]
  const plan: ExecutionPlan = {
    planId: `pln-obj${objectiveId}`,
    objectiveId,
    projectId: 1,
    workspaceId: 1,
    createdAt: new Date().toISOString(),
    status: 'AWAITING_APPROVAL',
    missions,
    summary: {
      freeMissions: 0,
      paidMissions: 1,
      unknownCostMissions: 0,
      blockedMissions: 0,
      approvalRequired: overrides.approvalRequired ?? true,
      waves: [['m1']],
      estimatedTotalCost: overrides.estimatedTotalCost ?? 0.04,
      maximumTotalExposure: 0.08,
    },
    fingerprint: overrides.fingerprint ?? `fp-${++fingerprintSeq}`,
    budget: {
      currency: 'USD',
      estimatedCost: 0.04,
      maximumAuthorizedCost: null,
      spentSoFar: 0,
      remainingAuthorized: null,
    },
  }
  return JSON.stringify(plan)
}

function seedSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      workspace_id INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agentos_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT (unixepoch())
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

function seedApproval(db: InstanceType<typeof Database>, approval: {
  objectiveId: number
  fingerprint: string
  expiresInSeconds?: number | null
  approvedBy?: string
}): void {
  db.prepare(`
    INSERT INTO agentos_execution_approvals (
      approval_id, objective_id, project_id, workspace_id, approved_by, approved_at,
      approved_task_ids_json, excluded_task_ids_json, fingerprint, max_authorized_amount, expires_at, created_at
    ) VALUES (?, ?, 1, 1, ?, unixepoch(), '[]', '[]', ?, NULL, ?, unixepoch())
  `).run(
    `apv-${approval.objectiveId}-${Math.random().toString(36).slice(2, 8)}`,
    approval.objectiveId,
    approval.approvedBy ?? 'commander',
    approval.fingerprint,
    approval.expiresInSeconds === undefined || approval.expiresInSeconds === null
      ? null
      : Math.floor(Date.now() / 1000) + approval.expiresInSeconds,
  )
}

beforeEach(() => {
  state.db = new Database(':memory:')
  seedSchema(state.db)
  state.db.prepare('INSERT INTO projects (id, name, slug, workspace_id) VALUES (1, ?, ?, 1)').run('Alpha', 'alpha')
})

afterEach(() => {
  state.db?.close()
  state.db = null
})

describe('listApprovalRequiredPlans', () => {
  it('lists an AWAITING_APPROVAL plan with no approval as NONE and maps mission identity', () => {
    const db = state.db!
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (10, 1, 1, ?, ?)')
      .run('Ship the release', 'active')
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint, updated_at) VALUES (10, 1, 1, ?, ?, ?, 5000)')
      .run('AWAITING_APPROVAL', planJson({ objectiveId: 10 }), 'fp-none')

    const result = listApprovalRequiredPlans(1)
    expect(result.summary.total).toBe(1)
    expect(result.summary.byStatus.NONE).toBe(1)
    const item = result.items[0]
    expect(item.objectiveId).toBe(10)
    expect(item.projectId).toBe(1)
    expect(item.projectName).toBe('Alpha')
    expect(item.objectiveTitle).toBe('Ship the release')
    expect(item.planStatus).toBe('AWAITING_APPROVAL')
    expect(item.approvalStatus).toBe('NONE')
    expect(item.fingerprint).toBe('fp-1')
    expect(item.approvedBy).toBeNull()
    expect(item.missionCounts.total).toBe(1)
    expect(item.missionCounts.paid).toBe(1)
    expect(item.missionCounts.requiresApproval).toBe(1)
    expect(item.estimatedTotalCost).toBeCloseTo(0.04)
    expect(item.approvalRequiredMissions).toHaveLength(1)
    const mission = item.approvalRequiredMissions[0]
    expect(mission.taskId).toBe(401)
    expect(mission.assignedTo).toBe('gamut:superagent')
    expect(mission.provider).toBe('openai')
    expect(mission.model).toBe('gpt-5.6-terra')
    expect(mission.costClass).toBe('PAID_KNOWN')
  })

  it('excludes VALID-approved plans from the queue — they are authorized, not pending', () => {
    const db = state.db!
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (10, 1, 1, ?, ?)')
      .run('Approved work', 'active')
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint) VALUES (10, 1, 1, ?, ?, ?)')
      .run('AWAITING_APPROVAL', planJson({ objectiveId: 10, fingerprint: 'fp-good' }), 'fp-good')
    seedApproval(db, { objectiveId: 10, fingerprint: 'fp-good' })

    const result = listApprovalRequiredPlans(1)
    expect(result.summary.total).toBe(0)
    expect(result.items).toHaveLength(0)
  })

  it('surfaces a STALE approval when the plan fingerprint changed and sorts it first', () => {
    const db = state.db!
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (10, 1, 1, ?, ?)')
      .run('Changed plan', 'active')
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (11, 1, 1, ?, ?)')
      .run('Fresh plan', 'active')
    // The plan JSON carries fingerprint fp-new; the stored approval was granted
    // for the OLD fingerprint fp-old — the plan changed since.
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint, updated_at) VALUES (10, 1, 1, ?, ?, ?, 5000)')
      .run('AWAITING_APPROVAL', planJson({ objectiveId: 10, fingerprint: 'fp-new' }), 'fp-new')
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint, updated_at) VALUES (11, 1, 1, ?, ?, ?, 6000)')
      .run('AWAITING_APPROVAL', planJson({ objectiveId: 11, fingerprint: 'fp-fresh' }), 'fp-fresh')
    seedApproval(db, { objectiveId: 10, fingerprint: 'fp-old' })

    const result = listApprovalRequiredPlans(1)
    expect(result.summary.total).toBe(2)
    expect(result.summary.byStatus.STALE).toBe(1)
    expect(result.summary.byStatus.NONE).toBe(1)
    // STALE (weight 0) sorts before NONE (weight 2) even though it is older.
    expect(result.items[0].objectiveId).toBe(10)
    expect(result.items[0].approvalStatus).toBe('STALE')
    expect(result.items[0].approvedBy).toBe('commander')
    expect(result.items[1].approvalStatus).toBe('NONE')
  })

  it('treats an expired approval as absent — the objective stays pending, never silently authorized', () => {
    const db = state.db!
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (10, 1, 1, ?, ?)')
      .run('Expired approval', 'active')
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint) VALUES (10, 1, 1, ?, ?, ?)')
      .run('AWAITING_APPROVAL', planJson({ objectiveId: 10, fingerprint: 'fp-x' }), 'fp-x')
    seedApproval(db, { objectiveId: 10, fingerprint: 'fp-x', expiresInSeconds: -60 })

    const result = listApprovalRequiredPlans(1)
    // latestApprovalForObjective skips expired rows, so the read model sees NONE
    // and the objective stays in the queue — matching the dispatch gate, which
    // also refuses expired approvals.
    expect(result.summary.byStatus.NONE).toBe(1)
    expect(result.items[0].approvalStatus).toBe('NONE')
    // The expired record is not surfaced as authority (latestApprovalForObjective
    // skips expired rows) — no approver identity is shown for it.
    expect(result.items[0].approvedBy).toBeNull()
  })

  it('skips non-approval-required and unparseable plan rows instead of inventing work', () => {
    const db = state.db!
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (10, 1, 1, ?, ?)')
      .run('Clean plan', 'active')
    // APPROVED status, approval not required → not pending.
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint) VALUES (10, 1, 1, ?, ?, ?)')
      .run('APPROVED', planJson({ objectiveId: 10, approvalRequired: false }), 'fp-clean')
    // Unparseable plan_json → display cache unusable; skipped (the authoritative path regenerates).
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint) VALUES (11, 1, 1, ?, ?, ?)')
      .run('AWAITING_APPROVAL', '{not json', null)

    const result = listApprovalRequiredPlans(1)
    expect(result.summary.total).toBe(0)
    expect(result.items).toHaveLength(0)
  })

  it('requires approval when the stored status is APPROVED but the plan summary demands it', () => {
    const db = state.db!
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (10, 1, 1, ?, ?)')
      .run('Summary-gated plan', 'active')
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint) VALUES (10, 1, 1, ?, ?, ?)')
      .run('APPROVED', planJson({ objectiveId: 10, approvalRequired: true }), 'fp-gated')

    const result = listApprovalRequiredPlans(1)
    expect(result.summary.total).toBe(1)
    expect(result.items[0].approvalStatus).toBe('NONE')
  })

  it('filters by project and never crosses workspace boundaries', () => {
    const db = state.db!
    db.prepare("INSERT INTO projects (id, name, slug, workspace_id) VALUES (2, 'Beta', 'beta', 1)").run()
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (10, 1, 1, ?, ?)')
      .run('Alpha plan', 'active')
    db.prepare('INSERT INTO agentos_objectives (id, project_id, workspace_id, title, status) VALUES (11, 2, 1, ?, ?)')
      .run('Beta plan', 'active')
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint) VALUES (10, 1, 1, ?, ?, ?)')
      .run('AWAITING_APPROVAL', planJson({ objectiveId: 10 }), 'fp-a')
    db.prepare('INSERT INTO agentos_execution_plans (objective_id, project_id, workspace_id, status, plan_json, fingerprint) VALUES (11, 2, 1, ?, ?, ?)')
      .run('AWAITING_APPROVAL', planJson({ objectiveId: 11 }), 'fp-b')

    const alphaOnly = listApprovalRequiredPlans(1, { projectId: 1 })
    expect(alphaOnly.items.map(i => i.objectiveId)).toEqual([10])

    // Workspace 2 sees nothing, even though workspace 1 has pending plans.
    expect(listApprovalRequiredPlans(2).summary.total).toBe(0)
  })
})
