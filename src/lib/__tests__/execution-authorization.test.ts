import fs from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCanonicalVault, rmRoot, tmpRoot } from './helpers/ai-arsenal-fixtures'
import {
  classifyExecutionCost,
  costRequiresApproval,
  computeExecutionFingerprint,
  dependencyWaves,
  DEFAULT_EXECUTION_POLICY,
  buildExecutionPlan,
  saveExecutionPlanRow,
  isAgentOSGatedTask,
  type ExecutionCostClass,
  type ExecutionPlan,
  type ExecutionPolicy,
} from '@/lib/execution-planning'
import {
  createExecutionApproval,
  latestApprovalForObjective,
  approvalStatusForPlan,
  authorizeAgentOSTaskDispatch,
  executionPolicyOf,
} from '@/lib/execution-authorization'
import { createKnowledgeSuiteObjective } from '@/lib/knowledge-curation'
import { getOrCreateAgentOSOperationsProject } from '@/lib/agentos-operations'

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

let root = ''
const workspaceId = 1

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
  `)
  state.db.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (1, ?, ?)').run('One', 'shared')
}

function taskById(id: number): any {
  return state.db!.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
}
function commandRow(projectId: number, workspaceId = 1): void {
  state.db!.prepare(`
    INSERT INTO agentos_project_command (project_id, workspace_id, state)
    VALUES (?, ?, 'active')
    ON CONFLICT(project_id) DO NOTHING
  `).run(projectId, workspaceId)
}
function addAgent(name: string, runtimeType: string | null, config: Record<string, unknown> = {}): void {
  state.db!.prepare('INSERT INTO agents (name, role, status, config, workspace_id, source, runtime_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(name, 'specialist', 'available', JSON.stringify(config), 1, 'agentos-external', runtimeType, 0)
}
function assign(taskId: number, agentName: string): void {
  state.db!.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(agentName, taskId)
}
function annotate(taskId: number, annotation: Record<string, unknown>): void {
  const metadata = JSON.parse(taskById(taskId).metadata)
  metadata.agentos_execution = { ...(metadata.agentos_execution || {}), ...annotation }
  state.db!.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), taskId)
}

beforeEach(() => {
  root = tmpRoot()
  buildCanonicalVault(root)
  seedDb()
  state.activities = []
  state.routeMock.mockReset()
  state.routeMock.mockReturnValue({ routed: false, reason: 'no bindings', taskId: 0, projectId: null })
})

afterEach(() => {
  state.db?.close()
  state.db = null
  rmRoot(root)
})

describe('execution cost classification', () => {
  it('classifies host-orchestrated runtimes FREE_LOCAL only with free-local evidence', () => {
    // A localhost Gamut/SuperAgent host does NOT imply free by itself — the
    // agent may invoke a configured paid model. Evidence is required.
    const unknown = classifyExecutionCost({ runtimeType: 'gamut' })
    expect(unknown.costClass).toBe('UNKNOWN_COST')
    expect(unknown.estimatedCost).toBeNull()
    expect(classifyExecutionCost({ runtimeType: 'superagent-host' }).costClass).toBe('UNKNOWN_COST')

    const freeLocal = classifyExecutionCost({ runtimeType: 'gamut', agentConfig: { agentos: { cost: { freeLocal: true } } } })
    expect(freeLocal.costClass).toBe('FREE_LOCAL')
    expect(freeLocal.basis).toContain('locally on the host')
    // Declared non-local provider on a host runtime is treated as paid.
    const paid = classifyExecutionCost({ runtimeType: 'gamut', provider: 'openai', model: 'gpt-4o' })
    expect(paid.costClass).toBe('PAID_ESTIMATED')
    // MC-native local tokens stay FREE_LOCAL unconditionally.
    expect(classifyExecutionCost({ runtimeType: 'builtin' }).costClass).toBe('FREE_LOCAL')
    expect(classifyExecutionCost({ runtimeType: 'local' }).costClass).toBe('FREE_LOCAL')
  })

  it('keeps unverifiable runtimes UNKNOWN_COST — never guesses a price', () => {
    expect(classifyExecutionCost({ runtimeType: 'hermes' }).costClass).toBe('UNKNOWN_COST')
    expect(classifyExecutionCost({ runtimeType: 'codex' }).costClass).toBe('UNKNOWN_COST')
    const unknown = classifyExecutionCost({ runtimeType: 'custom-rt' })
    expect(unknown.costClass).toBe('UNKNOWN_COST')
    expect(unknown.estimatedCost).toBeNull()
  })

  it('classifies PAID_ESTIMATED with provider metadata and PAID_KNOWN with an exact estimate', () => {
    const estimated = classifyExecutionCost({ runtimeType: 'codex', provider: 'anthropic', model: 'claude-sonnet' })
    expect(estimated.costClass).toBe('PAID_ESTIMATED')
    expect(estimated.provider).toBe('anthropic')
    const known = classifyExecutionCost({ runtimeType: 'hermes', provider: 'openai', estimatedCost: 1.25 })
    expect(known.costClass).toBe('PAID_KNOWN')
    expect(known.estimatedCost).toBe(1.25)
  })

  it('respects an explicit annotation override (manual override authoritative)', () => {
    const manual = classifyExecutionCost({ runtimeType: 'hermes', costClassOverride: 'MANUAL_EXTERNAL' })
    expect(manual.costClass).toBe('MANUAL_EXTERNAL')
    const free = classifyExecutionCost({ runtimeType: 'hermes', costClassOverride: 'FREE_LOCAL' })
    expect(free.costClass).toBe('FREE_LOCAL')
  })

  it('BLOCKED when no runtime is assigned', () => {
    const blocked = classifyExecutionCost({ runtimeType: null })
    expect(blocked.costClass).toBe('BLOCKED')
  })

  it('approval requirement follows policy defaults', () => {
    expect(costRequiresApproval('FREE_LOCAL', DEFAULT_EXECUTION_POLICY)).toBe(false)
    expect(costRequiresApproval('FREE_REMOTE', DEFAULT_EXECUTION_POLICY)).toBe(true)
    expect(costRequiresApproval('PAID_KNOWN', DEFAULT_EXECUTION_POLICY)).toBe(true)
    expect(costRequiresApproval('PAID_ESTIMATED', DEFAULT_EXECUTION_POLICY)).toBe(true)
    expect(costRequiresApproval('UNKNOWN_COST', DEFAULT_EXECUTION_POLICY)).toBe(true)
    expect(costRequiresApproval('MANUAL_EXTERNAL', DEFAULT_EXECUTION_POLICY)).toBe(true)
    expect(costRequiresApproval('BLOCKED', DEFAULT_EXECUTION_POLICY)).toBe(true)
    const allowPaid: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, allowPaidWithoutApproval: true }
    expect(costRequiresApproval('PAID_ESTIMATED', allowPaid)).toBe(false)
    expect(costRequiresApproval('UNKNOWN_COST', allowPaid)).toBe(true) // unknown never auto-runs
  })
})

describe('execution plan + fingerprint', () => {
  function suiteObjective(): { objectiveId: number; projectId: number; tasks: Record<string, number> } {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    return { objectiveId: suite.objectiveId, projectId: suite.projectId, tasks: Object.fromEntries(suite.missions.map(m => [m.key, m.taskId])) }
  }

  it('generates a knowledge-suite preview: M1–M5 free-local (with evidence), M6 unknown-cost, M6 blocked until approved', () => {
    addAgent('gamut-curator', 'gamut', { agentos: { cost: { freeLocal: true } } })
    addAgent('hermes-reviewer', 'hermes')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    for (const key of ['m1', 'm2', 'm3', 'm4', 'm5']) assign(tasks[key], 'gamut-curator')
    assign(tasks.m6, 'hermes-reviewer')

    const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'commander' })
    expect(plan.summary.freeMissions).toBe(5)
    expect(plan.summary.paidMissions).toBe(0)
    expect(plan.summary.unknownCostMissions).toBe(1)
    expect(plan.summary.blockedMissions).toBe(0)
    expect(plan.summary.approvalRequired).toBe(true)
    expect(plan.summary.waves).toEqual([['m1', 'm2', 'm3', 'm4', 'm5'], ['m6']])
    const m1 = plan.missions.find(m => m.missionKey === 'm1')!
    expect(m1.costClass).toBe('FREE_LOCAL')
    expect(m1.requiresApproval).toBe(false)
    expect(m1.resources.length).toBeGreaterThan(0)
    const m6 = plan.missions.find(m => m.missionKey === 'm6')!
    expect(m6.costClass).toBe('UNKNOWN_COST')
    expect(m6.requiresApproval).toBe(true)
    expect(m6.dependencies).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
  })

  it('fingerprint is stable across identical builds and changes when routing changes', () => {
    addAgent('a1', 'gamut')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    assign(tasks.m1, 'a1')
    assign(tasks.m2, 'a1')
    const first = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'x' })
    const second = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'y' })
    expect(second.fingerprint).toBe(first.fingerprint)
    // Material routing change (different specialist) invalidates the fingerprint.
    addAgent('a2', 'hermes')
    assign(tasks.m2, 'a2')
    const changed = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'x' })
    expect(changed.fingerprint).not.toBe(first.fingerprint)
    expect(computeExecutionFingerprint(changed)).toBe(changed.fingerprint)
  })

  it('dependency waves separate parallel M1–M5 from gated M6', () => {
    const waves = dependencyWaves([
      { missionKey: 'm6', dependencies: ['m1', 'm2', 'm3', 'm4', 'm5'] },
      { missionKey: 'm1', dependencies: [] },
      { missionKey: 'm5', dependencies: [] },
      { missionKey: 'm3', dependencies: [] },
      { missionKey: 'm2', dependencies: [] },
      { missionKey: 'm4', dependencies: [] },
    ])
    expect(waves).toEqual([['m1', 'm5', 'm3', 'm2', 'm4'], ['m6']])
  })

  it('persists plan rows for the UI cache', () => {
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    addAgent('a1', 'gamut')
    assign(tasks.m1, 'a1')
    const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'x' })
    saveExecutionPlanRow(plan, 'AWAITING_APPROVAL')
    const row = state.db!.prepare('SELECT status FROM agentos_execution_plans WHERE objective_id = ?').get(objectiveId) as any
    expect(row.status).toBe('AWAITING_APPROVAL')
  })

  it('identifies only AgentOS-gated tasks for authorization', () => {
    expect(isAgentOSGatedTask({ agentos: { objectiveId: 4 } })).toBe(true)
    expect(isAgentOSGatedTask({ agentos_resource_review: { review_id: 'x' } })).toBe(true)
    expect(isAgentOSGatedTask({ agentos_knowledge_curation: { pack_id: 'p' } })).toBe(true)
    expect(isAgentOSGatedTask({})).toBe(false)
  })
})

describe('approval + dispatch authorization', () => {
  function suiteObjective(): { objectiveId: number; projectId: number; tasks: Record<string, number> } {
    const suite = createKnowledgeSuiteObjective({ workspaceId, root })
    return { objectiveId: suite.objectiveId, projectId: suite.projectId, tasks: Object.fromEntries(suite.missions.map(m => [m.key, m.taskId])) }
  }
  function gate(taskId: number, agentName: string, projectId: number): { objectiveId: number } {
    const metadata = JSON.parse(taskById(taskId).metadata)
    const objectiveId = metadata.agentos.objectiveId
    return { objectiveId }
  }

  it('free-local missions dispatch without approval; hermes mission is held until approved', () => {
    addAgent('gamut-free', 'gamut', { agentos: { cost: { freeLocal: true } } })
    addAgent('hermes-cost', 'hermes')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    const target = gate(tasks.m1, 'gamut-free', projectId)
    assign(tasks.m1, 'gamut-free')
    assign(tasks.m2, 'hermes-cost')

    const freeAuth = authorizeAgentOSTaskDispatch({
      id: tasks.m1, project_id: projectId, workspace_id: workspaceId, assigned_to: 'gamut-free', metadata: taskById(tasks.m1).metadata,
    })
    expect(freeAuth.allowed).toBe(true)
    expect(freeAuth.costClass).toBe('FREE_LOCAL')
    // No status mutation when allowed-free or held — held stays 'assigned'.
    expect(taskById(tasks.m1).status).toBe('inbox')

    const held = authorizeAgentOSTaskDispatch({
      id: tasks.m2, project_id: projectId, workspace_id: workspaceId, assigned_to: 'hermes-cost', metadata: taskById(tasks.m2).metadata,
    })
    expect(held.allowed).toBe(false)
    expect(held.held).toBe(true)
    expect(held.costClass).toBe('UNKNOWN_COST')
    expect(held.reason).toMatch(/no valid approval/i)
    expect(state.activities.some((args: any) => args[0] === 'agentos_execution_approval_held' && args[5]?.task_id === tasks.m2)).toBe(true)

    // Approve the whole objective — fingerprint binds approval to this snapshot.
    const approval = createExecutionApproval({ objectiveId, workspaceId, actor: 'commander', approveTaskIds: 'all-eligible' })
    expect(approval.ok).toBe(true)
    expect(approval.approved).toContain(tasks.m2)
    const approvedAuth = authorizeAgentOSTaskDispatch({
      id: tasks.m2, project_id: projectId, workspace_id: workspaceId, assigned_to: 'hermes-cost', metadata: taskById(tasks.m2).metadata,
    })
    expect(approvedAuth.allowed).toBe(true)
    expect(approvedAuth.approvalStatus).toBe('VALID')
    expect(target.objectiveId).toBe(objectiveId)
  })

  it('partial approval: only selected missions pass; excluded ones stay held', () => {
    addAgent('hermes-a', 'hermes')
    addAgent('hermes-b', 'hermes')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    // All six missions routed to hermes (unknown cost) → every one needs approval.
    for (const key of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) assign(tasks[key], 'hermes-a')
    const approval = createExecutionApproval({ objectiveId, workspaceId, actor: 'commander', approveTaskIds: [tasks.m1, tasks.m2, tasks.m3] })
    expect(approval.ok).toBe(true)
    expect(approval.partiallyApproved).toBe(true)
    expect(approval.approved).toEqual(expect.arrayContaining([tasks.m1, tasks.m2, tasks.m3]))
    const authorize = (id: number) => authorizeAgentOSTaskDispatch({
      id, project_id: projectId, workspace_id: workspaceId, assigned_to: 'hermes-a', metadata: taskById(id).metadata,
    })
    expect(authorize(tasks.m1).allowed).toBe(true)
    expect(authorize(tasks.m4).allowed).toBe(false) // not in the approval snapshot
    expect(authorize(tasks.m4).reason).toMatch(/not approved/)
    // M6 depends on M1–M5: it was not requested, so it is naturally held too.
    expect(authorize(tasks.m6).allowed).toBe(false)
  })

  it('a dependency-gated mission cannot be approved alone (held by dependency)', () => {
    addAgent('hermes-a', 'hermes')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    for (const key of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) assign(tasks[key], 'hermes-a')
    const onlyM6 = createExecutionApproval({ objectiveId, workspaceId, actor: 'commander', approveTaskIds: [tasks.m6] })
    expect(onlyM6.ok).toBe(false)
    expect(onlyM6.heldByDependency).toContain(tasks.m6)
  })

  it('routing changes after approval make the approval STALE and re-hold the mission', () => {
    addAgent('hermes-a', 'hermes')
    addAgent('hermes-b', 'hermes')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    assign(tasks.m1, 'hermes-a')
    const approval = createExecutionApproval({ objectiveId, workspaceId, actor: 'commander', approveTaskIds: 'all-eligible' })
    expect(approval.ok).toBe(true)
    // Re-route M1 to a different specialist — materially different plan.
    assign(tasks.m1, 'hermes-b')
    const auth = authorizeAgentOSTaskDispatch({
      id: tasks.m1, project_id: projectId, workspace_id: workspaceId, assigned_to: 'hermes-b', metadata: taskById(tasks.m1).metadata,
    })
    expect(auth.allowed).toBe(false)
    expect(auth.approvalStatus).toBe('STALE')
    expect(auth.reason).toMatch(/stale/i)
    const stored = latestApprovalForObjective(objectiveId, workspaceId)!
    const rebuilt = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'x' })
    expect(approvalStatusForPlan(stored, rebuilt)).toBe('STALE')
  })

  it('policy: disabling free-local auto-approval holds even gamut missions', () => {
    addAgent('gamut-free', 'gamut', { agentos: { cost: { freeLocal: true } } })
    const { objectiveId, projectId, tasks } = suiteObjective()
    state.db!.prepare(`
      INSERT INTO agentos_project_command (project_id, workspace_id, state, allow_free_local_without_approval)
      VALUES (?, ?, 'active', 0) ON CONFLICT(project_id) DO UPDATE SET allow_free_local_without_approval = 0
    `).run(projectId, workspaceId)
    assign(tasks.m1, 'gamut-free')
    const auth = authorizeAgentOSTaskDispatch({
      id: tasks.m1, project_id: projectId, workspace_id: workspaceId, assigned_to: 'gamut-free', metadata: taskById(tasks.m1).metadata,
    })
    expect(auth.allowed).toBe(false)
    expect(auth.costClass).toBe('FREE_LOCAL')
    expect(auth.reason).toMatch(/requires approval/i)
    expect(executionPolicyOf(projectId, workspaceId).allowFreeLocalWithoutApproval).toBe(false)
  })

  it('blocked providers hold missions even with an approval on file', () => {
    addAgent('codex-a', 'codex')
    const { objectiveId, projectId, tasks } = suiteObjective()
    state.db!.prepare(`
      INSERT INTO agentos_project_command (project_id, workspace_id, state, blocked_providers_json)
      VALUES (?, ?, 'active', '["codex"]') ON CONFLICT(project_id) DO NOTHING
    `).run(projectId, workspaceId)
    assign(tasks.m1, 'codex-a')
    annotate(tasks.m1, { provider: 'codex' })
    const approval = createExecutionApproval({ objectiveId, workspaceId, actor: 'commander', approveTaskIds: 'all-eligible' })
    expect(approval.ok).toBe(true)
    const auth = authorizeAgentOSTaskDispatch({
      id: tasks.m1, project_id: projectId, workspace_id: workspaceId, assigned_to: 'codex-a', metadata: taskById(tasks.m1).metadata,
    })
    expect(auth.allowed).toBe(false)
    expect(auth.reason).toMatch(/blocked by project execution policy/i)
  })

  it('manual override annotation can force FREE_LOCAL on an unknown runtime', () => {
    addAgent('hermes-local', 'hermes')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    assign(tasks.m1, 'hermes-local')
    annotate(tasks.m1, { costClass: 'FREE_LOCAL' })
    const auth = authorizeAgentOSTaskDispatch({
      id: tasks.m1, project_id: projectId, workspace_id: workspaceId, assigned_to: 'hermes-local', metadata: taskById(tasks.m1).metadata,
    })
    expect(auth.allowed).toBe(true)
    expect(auth.costClass).toBe('FREE_LOCAL')
  })

  it('non-AgentOS tasks and gated tasks without project context are untouched / safe', () => {
    const plain = authorizeAgentOSTaskDispatch({
      id: 1, project_id: 5, workspace_id: workspaceId, assigned_to: 'agent', metadata: JSON.stringify({ agentos_auto_route: true }),
    })
    expect(plain.allowed).toBe(true)
    const noProject = authorizeAgentOSTaskDispatch({
      id: 2, project_id: null, workspace_id: workspaceId, assigned_to: 'agent', metadata: JSON.stringify({ agentos: { objectiveId: 9 } }),
    })
    expect(noProject.allowed).toBe(false)
    expect(noProject.reason).toMatch(/no project context/i)
  })

  it('workspace isolation: approvals in one workspace never authorize another', () => {
    state.db!.prepare('INSERT INTO workspaces (id, name, isolation) VALUES (2, ?, ?)').run('Two', 'shared')
    addAgent('hermes-a', 'hermes')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    assign(tasks.m1, 'hermes-a')
    const approval = createExecutionApproval({ objectiveId, workspaceId, actor: 'commander', approveTaskIds: 'all-eligible' })
    expect(approval.ok).toBe(true)
    expect(latestApprovalForObjective(objectiveId, 2)).toBeNull()
    const auth = authorizeAgentOSTaskDispatch({
      id: tasks.m1, project_id: projectId, workspace_id: 2, assigned_to: 'hermes-a', metadata: taskById(tasks.m1).metadata,
    })
    expect(auth.allowed).toBe(false) // no approval in workspace 2
  })

  it('records the full audit trail (preview save + hold + approval)', () => {
    addAgent('gamut-free', 'gamut')
    addAgent('hermes-cost', 'hermes')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    assign(tasks.m1, 'gamut-free')
    assign(tasks.m2, 'hermes-cost')
    const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'commander' })
    saveExecutionPlanRow(plan, plan.summary.approvalRequired ? 'AWAITING_APPROVAL' : 'APPROVED')
    authorizeAgentOSTaskDispatch({
      id: tasks.m2, project_id: projectId, workspace_id: workspaceId, assigned_to: 'hermes-cost', metadata: taskById(tasks.m2).metadata,
    })
    expect(state.activities.some((args: any) => args[0] === 'agentos_execution_approval_held')).toBe(true)
    // Held missions stay untouched — never claimed, never delegated.
    expect(taskById(tasks.m2).status).toBe('inbox')
    const approval = createExecutionApproval({ objectiveId, workspaceId, actor: 'commander', approveTaskIds: 'all-eligible' })
    expect(approval.ok).toBe(true)
    expect(state.activities.some((args: any) => args[0] === 'execution_approved')).toBe(true)
  })

  it('knowledge-suite preview is cost-safe by default: no objective row ever dispatches without approval for unknown runtimes', () => {
    addAgent('hermes-reviewer', 'hermes')
    const { objectiveId, projectId, tasks } = suiteObjective()
    commandRow(projectId)
    assign(tasks.m6, 'hermes-reviewer')
    const plan: ExecutionPlan = buildExecutionPlan({ objectiveId, workspaceId, policy: DEFAULT_EXECUTION_POLICY, actor: 'x' })
    expect(plan.summary.approvalRequired).toBe(true)
    const m6 = plan.missions.find(mission => mission.missionKey === 'm6')!
    const block = createExecutionApproval({ objectiveId, workspaceId, actor: 'commander', approveTaskIds: [] })
    expect(block.ok).toBe(false) // nothing eligible approved
    expect(block.message).toMatch(/Nothing to approve/)
  })
})
