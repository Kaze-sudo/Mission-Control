import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalOpenRouterModelId,
  parseOpenRouterModelsPayload,
  getModelPricing,
  refreshOpenRouterPricing,
  clearPricingMemoryCache,
} from '@/lib/model-pricing'
import { resolveGamutModelAlias } from '@/lib/gamut-host'
import {
  estimateMissionTokenEnvelope,
  estimateMissionCost,
  computeExecutionFingerprint,
  DEFAULT_EXECUTION_POLICY,
  buildExecutionPlan,
  type ExecutionPlan,
} from '@/lib/execution-planning'
import {
  createExecutionApproval,
  authorizeAgentOSTaskDispatch,
  reserveMissionCost,
  releaseReservationForTask,
  objectiveBudgetState,
} from '@/lib/execution-authorization'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  activities: [] as unknown[],
  routeMock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: (...args: unknown[]) => state.activities.push(args) },
}))

vi.mock('@/lib/project-task-routing', () => ({
  routeTaskWithinProject: (...args: unknown[]) => state.routeMock(...args),
}))

const workspaceId = 1
let root = ''
let cacheFile = ''

function seedDb(): void {
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, description TEXT, status TEXT, priority TEXT,
      project_id INTEGER, project_ticket_no INTEGER, assigned_to TEXT,
      created_by TEXT, created_at INTEGER, updated_at INTEGER,
      tags TEXT, metadata TEXT, workspace_id INTEGER,
      outcome TEXT, resolution TEXT, error_message TEXT, completed_at INTEGER
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT,
      ticket_prefix TEXT NOT NULL, ticket_counter INTEGER NOT NULL DEFAULT 0,
      workspace_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(workspace_id, slug)
    );
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY, name TEXT, isolation TEXT NOT NULL DEFAULT 'shared'
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, status TEXT,
      config TEXT, workspace_id INTEGER NOT NULL, source TEXT, workspace_path TEXT,
      hidden INTEGER NOT NULL DEFAULT 0, runtime_type TEXT, updated_at INTEGER
    );
    CREATE TABLE agentos_objectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      plan_json TEXT NOT NULL DEFAULT '{}', created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agentos_project_command (
      project_id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft',
      auto_route INTEGER NOT NULL DEFAULT 0,
      allow_reroute INTEGER NOT NULL DEFAULT 0,
      fallback_behavior TEXT NOT NULL DEFAULT 'hold',
      allowed_platoons_json TEXT NOT NULL DEFAULT '[]',
      max_project_concurrent INTEGER NOT NULL DEFAULT 3,
      max_platoon_concurrent INTEGER NOT NULL DEFAULT 2,
      max_agent_concurrent INTEGER NOT NULL DEFAULT 1,
      allow_free_local_without_approval INTEGER NOT NULL DEFAULT 1,
      allow_free_remote_without_approval INTEGER NOT NULL DEFAULT 0,
      allow_paid_without_approval INTEGER NOT NULL DEFAULT 0,
      max_approved_estimated_cost REAL,
      approved_providers_json TEXT NOT NULL DEFAULT '[]',
      blocked_providers_json TEXT NOT NULL DEFAULT '[]',
      activated_at INTEGER, updated_by TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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
    CREATE TABLE agentos_objectives_needs_manual (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      task_id INTEGER, workspace_id INTEGER NOT NULL,
      reason TEXT NOT NULL, summary TEXT, recommended_actions_json TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
  state.db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (?, ?, ?)').run(1, 'default', 'shared')
  state.db.prepare('INSERT INTO projects (id, name, slug, ticket_prefix, workspace_id) VALUES (?, ?, ?, ?, ?)')
    .run(8, 'AgentOS Operations', 'agentos-ops', 'OPS', 1)
  state.db.prepare(`INSERT INTO agentos_project_command
    (project_id, workspace_id, state, auto_route, allow_reroute, fallback_behavior, allowed_platoons_json,
     max_project_concurrent, max_platoon_concurrent, max_agent_concurrent,
     allow_free_local_without_approval, allow_free_remote_without_approval, allow_paid_without_approval,
     max_approved_estimated_cost, approved_providers_json, blocked_providers_json)
    VALUES (8, 1, 'active', 1, 0, 'hold', '[]', 3, 2, 1, 1, 0, 0, NULL, '[]', '[]')`).run()
}

function objectiveWithTasks(): { objectiveId: number; taskIds: number[] } {
  state.db!.prepare(`INSERT INTO agentos_objectives (project_id, workspace_id, title, description, status, plan_json)
    VALUES (8, 1, 'Tactical Knowledge Suite', 'test', 'active', ?)`).run(JSON.stringify({
    missions: [
      { key: 'm1', title: 'M1', taskId: 101, dependsOnKeys: [] },
      { key: 'm2', title: 'M2', taskId: 102, dependsOnKeys: ['m1'] },
      { key: 'm3', title: 'M3', taskId: 103, dependsOnKeys: ['m1', 'm2'] },
    ],
  }))
  const objectiveId = Number((state.db!.prepare('SELECT id FROM agentos_objectives ORDER BY id DESC LIMIT 1').get() as { id: number }).id)
  const taskIds = [101, 102, 103]
  for (const [index, taskId] of taskIds.entries()) {
    state.db!.prepare(`INSERT INTO tasks (id, title, status, project_id, assigned_to, metadata, workspace_id)
      VALUES (?, ?, 'assigned', 8, 'curator', ?, 1)`).run(taskId, `Task ${index + 1}`, JSON.stringify({
      agentos: { objectiveId, missionKey: `m${index + 1}` },
      agentos_knowledge_curation: { objective_id: objectiveId, pack_id: `pack-${index + 1}` },
      agentos_resources: [
        { resource_id: 'res-tactical-wesnoth-framework', name: 'Wesnoth', manual_only: false },
        { resource_id: 'res-tactical-oxce-reference', name: 'OXCE', manual_only: true },
      ],
      agentos_execution: { provider: 'openrouter', model: 'sonnet' },
    }))
  }
  state.db!.prepare(`INSERT INTO agents (name, role, status, config, workspace_id, source, runtime_type, updated_at)
    VALUES ('curator', 'Knowledge Curator', 'online', ?, 1, 'gamut', 'gamut', 0)`).run(JSON.stringify({
    provider: 'openrouter', model: 'sonnet',
  }))
  return { objectiveId, taskIds }
}

const OPENROUTER_FIXTURE = {
  data: [
    {
      id: 'anthropic/claude-sonnet-5',
      context_length: 1000000,
      pricing: {
        prompt: '0.000002', completion: '0.00001',
        input_cache_read: '0.0000002', input_cache_write: '0.0000025',
      },
    },
    {
      id: 'anthropic/claude-haiku-4-5',
      context_length: 1000000,
      pricing: { prompt: '0.000001', completion: '0.000005' },
    },
    {
      id: 'openai/gpt-5.4',
      context_length: 500000,
      pricing: { prompt: '0.0000025', completion: '0.000015' },
    },
  ],
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-test-'))
  cacheFile = path.join(root, 'pricing-cache.json')
  clearPricingMemoryCache()
  seedDb()
})

afterEach(() => {
  state.db?.close()
  state.db = null
  state.activities = []
  fs.rmSync(root, { recursive: true, force: true })
})

describe('exact model alias resolution (Phase 1)', () => {
  it('resolves the Gamut `sonnet` alias to the concrete catalog model claude-sonnet-5', () => {
    expect(resolveGamutModelAlias('sonnet')).toBe('claude-sonnet-5')
    expect(canonicalOpenRouterModelId('claude-sonnet-5')).toBe('anthropic/claude-sonnet-5')
  })

  it('passes unknown aliases through unchanged', () => {
    expect(resolveGamutModelAlias('custom-model')).toBe('custom-model')
    expect(resolveGamutModelAlias(null)).toBeNull()
  })

  it('normalizes provider-qualified ids without double-prefixing', () => {
    expect(canonicalOpenRouterModelId('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5')
  })
})

describe('pricing parsing + cache (Phase 2/3)', () => {
  it('parses OpenRouter live payload per-token prices into per-1M USD', () => {
    const entries = parseOpenRouterModelsPayload(OPENROUTER_FIXTURE)
    const sonnet = entries.find(entry => entry.canonicalModelId === 'anthropic/claude-sonnet-5')!
    expect(sonnet).toBeDefined()
    expect(sonnet.inputPerMillion).toBe(2)
    expect(sonnet.outputPerMillion).toBe(10)
    expect(sonnet.cachedInputPerMillion!).toBeCloseTo(0.2, 6)
    expect(sonnet.cachedInputWritePerMillion!).toBeCloseTo(2.5, 6)
    expect(sonnet.contextLength).toBe(1_000_000)
    expect(sonnet.pricingSource).toBe('openrouter-live')
  })

  it('falls back to the embedded Gamut catalog when no live/cache data exists (never pretends free)', async () => {
    const pricing = getModelPricing('openrouter', 'claude-sonnet-5', { cacheFile, ttlMs: 60_000 })
    expect(pricing).not.toBeNull()
    expect(pricing!.pricingSource).toBe('gamut-catalog-fallback')
    expect(pricing!.inputPerMillion).toBe(2)
    expect(pricing!.outputPerMillion).toBe(10)
  })

  it('refresh writes a TTL-bounded cache file and subsequent lookups read local-cache', async () => {
    const refresh = await refreshOpenRouterPricing({ cacheFile, fetchFn: (async () => ({
      ok: true,
      status: 200,
      json: async () => OPENROUTER_FIXTURE,
    })) as unknown as typeof fetch })
    expect(refresh.refreshed).toBe(true)
    expect(refresh.matched).toBe(3)
    expect(fs.existsSync(cacheFile)).toBe(true)

    clearPricingMemoryCache()
    const cached = getModelPricing('openrouter', 'claude-sonnet-5', { cacheFile, ttlMs: 60_000 })
    expect(cached!.pricingSource).toBe('local-cache')
    expect(cached!.inputPerMillion).toBe(2)
    // No secrets anywhere in the cache file.
    const raw = fs.readFileSync(cacheFile, 'utf8')
    expect(raw).not.toMatch(/key|token|secret/i)
  })

  it('lookup failure → null (caller must not claim a price)', async () => {
    expect(getModelPricing('openrouter', 'unknown/model-xyz', { cacheFile })).toBeNull()
    const refresh = await refreshOpenRouterPricing({ cacheFile, fetchFn: (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch })
    expect(refresh.refreshed).toBe(false)
  })
})

describe('token envelope + mission cost (Phase 4/5)', () => {
  it('builds a safe envelope per mission kind with ceilings above the estimate', () => {
    const envelope = estimateMissionTokenEnvelope({ agentos_knowledge_curation: {} }, 2)
    expect(envelope.estimatedInputTokens).toBeGreaterThan(0)
    expect(envelope.maximumAuthorizedInputTokens).toBeGreaterThan(envelope.estimatedInputTokens)
    expect(envelope.maximumAuthorizedOutputTokens).toBeGreaterThan(envelope.estimatedOutputTokens)
    expect(envelope.maxAttempts).toBe(3)
    expect(envelope.basis).toContain('knowledge-curation')
    expect(envelope.basis).toContain('2 attached resource(s)')
  })

  it('computes estimate, per-attempt ceiling and exposure from pricing', () => {
    const envelope = estimateMissionTokenEnvelope({ agentos_knowledge_curation: {} }, 0)
    const pricing = getModelPricing('openrouter', 'claude-sonnet-5', { cacheFile })!
    const estimate = estimateMissionCost(pricing, envelope)
    expect(estimate.estimatedCost).toBeGreaterThan(0)
    expect(estimate.maximumCostPerAttempt).toBeGreaterThan(estimate.estimatedCost)
    expect(estimate.maximumMissionExposure).toBe(estimate.maximumCostPerAttempt * envelope.maxAttempts)
  })
})

describe('plan budget + fingerprint (Phase 6/12)', () => {
  it('builds a plan with per-mission estimates, model resolution and a budget summary', () => {
    const { objectiveId } = objectiveWithTasks()
    const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'test' })
    expect(plan.missions).toHaveLength(3)
    for (const mission of plan.missions) {
      expect(mission.costClass).toBe('PAID_ESTIMATED')
      expect(mission.modelResolved).toBe('claude-sonnet-5')
      expect(mission.pricingSource).not.toBeNull()
      expect(mission.estimatedCost).not.toBeNull()
      expect(mission.maximumMissionExposure).not.toBeNull()
      expect(mission.estimatedInputTokens).not.toBeNull()
    }
    expect(plan.summary.estimatedTotalCost).not.toBeNull()
    expect(plan.summary.maximumTotalExposure).not.toBeNull()
    expect(plan.budget.currency).toBe('USD')
    expect(plan.budget.maximumAuthorizedCost).toBeNull()
  })

  it('fingerprint includes cost-critical fields — model/pricing changes stale the approval', () => {
    const { objectiveId } = objectiveWithTasks()
    const base = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'test' })
    const mutated: ExecutionPlan = {
      ...base,
      missions: base.missions.map((mission, index) => index === 0
        ? { ...mission, modelResolved: 'claude-sonnet-4-6', pricingSource: 'local-cache' }
        : mission),
    }
    expect(computeExecutionFingerprint(mutated)).not.toBe(base.fingerprint)
  })

  it('a budget-limited approval stays VALID for the same plan and budget-bound checks hold', () => {
    const { objectiveId, taskIds } = objectiveWithTasks()
    const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'test' })
    const result = createExecutionApproval({
      objectiveId, workspaceId, actor: 'operator',
      approveTaskIds: taskIds,
      maxAuthorizedAmount: 25,
    })
    expect(result.ok).toBe(true)
    expect(result.approval!.maxAuthorizedAmount).toBe(25)
    expect(result.approval!.fingerprint).toBe(plan.fingerprint)

    // Authorize the first mission — exposure must fit inside the 25 budget.
    const auth = authorizeAgentOSTaskDispatch({
      id: taskIds[0], project_id: 8, workspace_id: workspaceId, assigned_to: 'curator',
      metadata: JSON.stringify({ agentos: { objectiveId } }),
    })
    expect(auth.allowed).toBe(true)
  })
})

describe('hard budget guard + ledger (Phase 7/9/10)', () => {
  it('holds dispatch when mission exposure exceeds the remaining authorized budget', () => {
    const { objectiveId, taskIds } = objectiveWithTasks()
    const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'test' })
    const exposure = plan.missions[0].maximumMissionExposure!
    createExecutionApproval({
      objectiveId, workspaceId, actor: 'operator',
      approveTaskIds: taskIds,
      maxAuthorizedAmount: exposure - 0.01, // ceiling below first mission's exposure
    })
    const auth = authorizeAgentOSTaskDispatch({
      id: taskIds[0], project_id: 8, workspace_id: workspaceId, assigned_to: 'curator',
      metadata: JSON.stringify({ agentos: { objectiveId } }),
    })
    expect(auth.allowed).toBe(false)
    expect(auth.held).toBe(true)
    expect(auth.reason).toContain('Budget guard')
    const held = state.activities.some(entry => Array.isArray(entry) && entry[0] === 'agentos_execution_budget_held')
    expect(held).toBe(true)
  })

  it('reservation + release keeps the ledger honest and idempotent', () => {
    const { objectiveId, taskIds } = objectiveWithTasks()
    reserveMissionCost({ objectiveId, workspaceId, taskId: taskIds[0], amount: 5 })
    reserveMissionCost({ objectiveId, workspaceId, taskId: taskIds[0], amount: 3 })
    expect(objectiveBudgetState(objectiveId, workspaceId).reserved).toBe(8)
    expect(objectiveBudgetState(objectiveId, workspaceId).spentSoFar).toBe(8)

    releaseReservationForTask(taskIds[0], workspaceId)
    const after = objectiveBudgetState(objectiveId, workspaceId)
    expect(after.spentSoFar).toBe(0)
    // Second release is a no-op.
    releaseReservationForTask(taskIds[0], workspaceId)
    expect(objectiveBudgetState(objectiveId, workspaceId).spentSoFar).toBe(0)
  })

  it('records actual usage without fabrication and settles reservations', () => {
    const { objectiveId, taskIds } = objectiveWithTasks()
    reserveMissionCost({ objectiveId, workspaceId, taskId: taskIds[0], amount: 10 })
    // Actual usage reported by the native runtime (Phase 9) — never fabricated here.
    state.db!.prepare(`INSERT INTO agentos_execution_costs
      (objective_id, workspace_id, task_id, kind, amount, input_tokens, output_tokens, provider_generation_id, note, created_at)
      VALUES (?, 1, ?, 'actual', 0.42, 210000, 9000, 'gen_abc', 'actual usage recorded from native runtime', 0)`).run(objectiveId, taskIds[0])
    const budget = objectiveBudgetState(objectiveId, workspaceId)
    expect(budget.actual).toBe(0.42)
  })

  it('budget exhaustion blocks further missions while earlier ones are reserved', () => {
    const { objectiveId, taskIds } = objectiveWithTasks()
    const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'test' })
    const exposures = plan.missions.map(mission => mission.maximumMissionExposure!)
    // Budget covers the first mission plus nearly all of the second — reserving
    // the first leaves too little for the second.
    const budget = exposures[0] + exposures[1] - 0.01
    createExecutionApproval({ objectiveId, workspaceId, actor: 'operator', approveTaskIds: taskIds, maxAuthorizedAmount: budget })

    // First mission passes and reserves.
    expect(authorizeAgentOSTaskDispatch({
      id: taskIds[0], project_id: 8, workspace_id: workspaceId, assigned_to: 'curator',
      metadata: JSON.stringify({ agentos: { objectiveId } }),
    }).allowed).toBe(true)
    reserveMissionCost({ objectiveId, workspaceId, taskId: taskIds[0], amount: exposures[0] })

    // Remaining budget cannot fund the second mission.
    const remaining = objectiveBudgetState(objectiveId, workspaceId).remainingAuthorized!
    expect(remaining).toBeLessThan(exposures[1])
    const second = authorizeAgentOSTaskDispatch({
      id: taskIds[1], project_id: 8, workspace_id: workspaceId, assigned_to: 'curator',
      metadata: JSON.stringify({ agentos: { objectiveId } }),
    })
    expect(second.allowed).toBe(false)
    expect(second.reason).toContain('Budget guard')
  })

  it('partial approval excludes unapproved missions from dispatch', () => {
    const { objectiveId, taskIds } = objectiveWithTasks()
    createExecutionApproval({ objectiveId, workspaceId, actor: 'operator', approveTaskIds: [taskIds[0]], maxAuthorizedAmount: 100 })
    const first = authorizeAgentOSTaskDispatch({
      id: taskIds[0], project_id: 8, workspace_id: workspaceId, assigned_to: 'curator',
      metadata: JSON.stringify({ agentos: { objectiveId } }),
    })
    expect(first.allowed).toBe(true)
    const second = authorizeAgentOSTaskDispatch({
      id: taskIds[1], project_id: 8, workspace_id: workspaceId, assigned_to: 'curator',
      metadata: JSON.stringify({ agentos: { objectiveId } }),
    })
    expect(second.allowed).toBe(false)
    expect(second.reason).toContain('not approved')
  })

  it('workspace isolation — objective budget state never leaks across workspaces', () => {
    const { objectiveId, taskIds } = objectiveWithTasks()
    reserveMissionCost({ objectiveId, workspaceId, taskId: taskIds[0], amount: 7 })
    // Other workspace sees zero spend.
    const other = objectiveBudgetState(objectiveId, 99)
    expect(other.spentSoFar).toBe(0)
    expect(other.reserved).toBe(0)
  })
})

describe('preview mode never dispatches', () => {
  it('building a plan performs zero dispatch and creates zero reservations', () => {
    const { objectiveId } = objectiveWithTasks()
    const before = state.db!.prepare('SELECT COUNT(*) AS c FROM agentos_execution_costs').get() as { c: number }
    const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'test' })
    expect(plan.status).toBe('PREVIEW')
    const after = state.db!.prepare('SELECT COUNT(*) AS c FROM agentos_execution_costs').get() as { c: number }
    expect(after.c).toBe(before.c)
    expect(plan.summary.approvalRequired).toBe(true)
  })
})