import { getDatabase } from '@/lib/db'
import { objectiveIdFromTaskMetadata } from '@/lib/execution-planning'

/**
 * Canonical cross-project read model for the Review Queue.
 *
 * Lists every task whose executor work has landed in a review state
 * (`review` / `quality_review`) together with its latest quality-review
 * record. This is a display read model only — it never mutates. Review
 * decisions go through the authoritative backend
 * (`POST /api/quality-review`), which persists the decision, auto-advances
 * the task (approved → done, rejected → in_progress with the notes as
 * error), and records activity.
 *
 * Sources (real state only, never frontend assumptions):
 *   - `tasks` in status 'review' | 'quality_review'
 *   - `quality_reviews` — latest record per task (reviewer/verdict/notes)
 *   - `agentos_delegations` — latest delegation identity for the task
 *   - `projects` / `agentos_objectives` — display identity
 */

export interface ReviewTaskTelemetry {
  /** Ledger actuals take precedence over token usage; the two are never added. */
  source: 'execution_ledger' | 'token_usage' | 'none'
  /** Actual settled cost recorded from native runtime/executor. Null = unrecorded/unavailable. */
  actualCost: number | null
  currency: string | null
  /** Input tokens reported. Null = unrecorded/unavailable. */
  inputTokens: number | null
  /** Output tokens reported. Null = unrecorded/unavailable. */
  outputTokens: number | null
  /** Estimated cost from task metadata/plan for comparison when same scope and currency. */
  estimatedCost: number | null
  estimatedCurrency: string | null
  /** Delta: actualCost - estimatedCost (positive = over estimate, negative = under). */
  costDelta: number | null
  /** True if only partial attempt or partial records are available. */
  isPartial: boolean
  /** No writer currently records a complete accounting boundary. */
  completeness: 'partial' | 'unknown'
  mixedCurrencies: boolean
  /** Whether telemetry is strictly attempt-bound (matched delegation_id) vs task-aggregate. */
  scope: 'attempt' | 'task_aggregate' | 'none'
}

export interface ReviewQueueItem {
  taskId: number
  taskTitle: string
  /** 'review' (executor output awaiting review) or 'quality_review' (Aegis review in flight). */
  taskStatus: 'review' | 'quality_review'
  projectId: number | null
  projectName: string | null
  objectiveId: number | null
  objectiveTitle: string | null
  /** Actual and estimated telemetry for the reviewable mission. */
  telemetry: ReviewTaskTelemetry
  /** Latest quality-review record, when one exists. */
  review: {
    reviewer: string
    status: string
    notes: string | null
    createdAt: number | null
  } | null
  /** Latest delegation identity for the task, when one exists. */
  delegation: {
    id: string
    status: string
    specialistName: string | null
    routingAgentName: string | null
    ecosystem: string | null
    attempt: number | null
    nativeSessionId: string | null
    resultSummary: string | null
    errorMessage: string | null
    completedAt: number | null
    durationSeconds: number | null
  } | null
  createdAt: number | null
  updatedAt: number | null
}

export interface ReviewQueueSummary {
  total: number
  awaitingHumanReview: number
  aegisReviewing: number
}

export interface ReviewQueueResult {
  items: ReviewQueueItem[]
  summary: ReviewQueueSummary
}

export function listReviewableTasks(
  workspaceId: number,
  opts: { projectId?: number | null; limit?: number } = {},
): ReviewQueueResult {
  const db = getDatabase()
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 250) : 100

  const projectFilter = opts.projectId != null && Number.isFinite(opts.projectId)
    ? ' AND t.project_id = ?'
    : ''
  const filterParams: number[] = opts.projectId != null && Number.isFinite(opts.projectId)
    ? [workspaceId, Number(opts.projectId)]
    : [workspaceId]

  const rows = db.prepare(`
    SELECT t.id, t.title, t.status, t.project_id, t.metadata, t.created_at, t.updated_at,
           pr.name AS project_name
    FROM tasks t
    LEFT JOIN projects pr ON pr.id = t.project_id
    WHERE t.workspace_id = ?
      AND t.status IN ('review', 'quality_review')${projectFilter}
    ORDER BY t.updated_at DESC
  `).all(...filterParams) as Array<Record<string, unknown>>

  const latestReviewStmt = db.prepare(`
    SELECT reviewer, status, notes, created_at
    FROM quality_reviews
    WHERE task_id = ? AND workspace_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)
  const latestDelegationStmt = db.prepare(`
    SELECT id, status, specialist_name, routing_agent_name, runtime_type, attempt,
           native_session_id, result_summary, error_message, completed_at, created_at, updated_at,
           objective_id
    FROM agentos_delegations
    WHERE task_id = ? AND workspace_id = ?
    ORDER BY attempt DESC, created_at DESC
    LIMIT 1
  `)
  const objectiveTitleStmt = db.prepare(`
    SELECT title FROM agentos_objectives WHERE id = ? AND workspace_id = ?
  `)

  // Fetch accounting once for the bounded visible page, never per review card.
  const visibleRows = rows.slice(0, limit)
  type AccountingRow = { task_id: number; amount: number | null; currency: string | null;
    input_tokens: number | null; output_tokens: number | null; delegation_id: string | null }
  const ledgerByTask = new Map<number, AccountingRow[]>()
  const tokensByTask = new Map<number, AccountingRow[]>()
  if (visibleRows.length) {
    const ids = visibleRows.map(row => Number(row.id))
    const placeholders = ids.map(() => '?').join(',')
    const ledger = db.prepare(`SELECT task_id, amount, currency, input_tokens, output_tokens, delegation_id
      FROM agentos_execution_costs WHERE workspace_id = ? AND kind = 'actual'
      AND task_id IN (${placeholders})`).all(workspaceId, ...ids) as AccountingRow[]
    const tokens = db.prepare(`SELECT task_id, cost_usd AS amount, 'USD' AS currency,
      input_tokens, output_tokens, NULL AS delegation_id FROM token_usage
      WHERE workspace_id = ? AND task_id IN (${placeholders})`).all(workspaceId, ...ids) as AccountingRow[]
    for (const [records, target] of [[ledger, ledgerByTask], [tokens, tokensByTask]] as const) {
      for (const record of records) target.set(record.task_id, [...(target.get(record.task_id) ?? []), record])
    }
  }

  const items: ReviewQueueItem[] = []
  for (const row of visibleRows) {
    const taskId = Number(row.id)
    const review = latestReviewStmt.get(taskId, workspaceId) as
      | { reviewer: string; status: string; notes: string | null; created_at: number | null }
      | undefined
    const delegationRow = latestDelegationStmt.get(taskId, workspaceId) as
      | Record<string, unknown>
      | undefined

    const delegation = delegationRow
      ? {
          id: String(delegationRow.id),
          status: String(delegationRow.status || ''),
          specialistName: delegationRow.specialist_name != null ? String(delegationRow.specialist_name) : null,
          routingAgentName: delegationRow.routing_agent_name != null ? String(delegationRow.routing_agent_name) : null,
          ecosystem: delegationRow.runtime_type != null ? String(delegationRow.runtime_type) : null,
          attempt: delegationRow.attempt != null ? Number(delegationRow.attempt) : null,
          nativeSessionId: delegationRow.native_session_id != null ? String(delegationRow.native_session_id) : null,
          resultSummary: delegationRow.result_summary != null ? String(delegationRow.result_summary) : null,
          errorMessage: delegationRow.error_message != null ? String(delegationRow.error_message) : null,
          completedAt: delegationRow.completed_at != null ? Number(delegationRow.completed_at) : null,
          durationSeconds: delegationRow.completed_at != null && delegationRow.created_at != null
            ? Math.max(0, Number(delegationRow.completed_at) - Number(delegationRow.created_at))
            : null,
        }
      : null

    // Objective linkage: the delegation ledger is authoritative when present;
    // otherwise fall back to the canonical metadata parser (never guess).
    let objectiveId: number | null = null
    let taskMetadata: Record<string, unknown> | null = null
    try {
      taskMetadata = typeof row.metadata === 'string'
        ? (JSON.parse(row.metadata || 'null') as Record<string, unknown> | null)
        : (row.metadata as Record<string, unknown> | null)
    } catch {
      taskMetadata = null
    }

    if (delegationRow?.objective_id != null && Number.isFinite(Number(delegationRow.objective_id))) {
      objectiveId = Number(delegationRow.objective_id)
    } else {
      objectiveId = objectiveIdFromTaskMetadata(taskMetadata)
    }
    const objectiveTitle = objectiveId != null
      ? ((objectiveTitleStmt.get(objectiveId, workspaceId) as { title?: string } | undefined)?.title ?? null)
      : null

    // Row presence does not prove all executor usage was reported. Keep recorded
    // subtotals, but never present an unproven estimate/actual comparison.
    const ledger = ledgerByTask.get(taskId) ?? []
    const records = ledger.length ? ledger : (tokensByTask.get(taskId) ?? [])
    const valid = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
    const sum = (key: 'amount' | 'input_tokens' | 'output_tokens'): number | null => {
      const values = records.map(row => row[key]).filter(valid)
      return values.length ? values.reduce((total, value) => total + value, 0) : null
    }
    const currencies = new Set(records.map(row => row.currency).filter((value): value is string => !!value))
    const mixedCurrencies = currencies.size > 1
    const currency = currencies.size === 1 && records.every(row => !!row.currency) ? [...currencies][0] : null
    const isPartial = records.some(row => !valid(row.amount) || !valid(row.input_tokens) || !valid(row.output_tokens) || !row.currency)
    const isAttemptBound = !!delegation && records.length > 0 && records.every(row => row.delegation_id === delegation.id)
    const execMeta = taskMetadata?.agentos_execution as Record<string, unknown> | undefined
    const estimatedCost = valid(execMeta?.estimatedCost) ? execMeta.estimatedCost : null
    const telemetry: ReviewTaskTelemetry = {
      source: ledger.length ? 'execution_ledger' : records.length ? 'token_usage' : 'none',
      actualCost: currency ? sum('amount') : null,
      currency,
      inputTokens: sum('input_tokens'),
      outputTokens: sum('output_tokens'),
      estimatedCost,
      estimatedCurrency: estimatedCost !== null ? 'USD' : null,
      costDelta: null,
      isPartial,
      completeness: isPartial ? 'partial' : 'unknown',
      mixedCurrencies,
      scope: !records.length ? 'none' : isAttemptBound ? 'attempt' : 'task_aggregate',
    }

    items.push({
      taskId,
      taskTitle: row.title != null ? String(row.title) : `Task ${taskId}`,
      taskStatus: String(row.status) as 'review' | 'quality_review',
      projectId: row.project_id != null ? Number(row.project_id) : null,
      projectName: row.project_name != null ? String(row.project_name) : null,
      objectiveId,
      objectiveTitle,
      telemetry,
      review: review
        ? {
            reviewer: review.reviewer,
            status: review.status,
            notes: review.notes != null ? String(review.notes) : null,
            createdAt: review.created_at != null ? Number(review.created_at) : null,
          }
        : null,
      delegation,
      createdAt: row.created_at != null ? Number(row.created_at) : null,
      updatedAt: row.updated_at != null ? Number(row.updated_at) : null,
    })
  }

  const awaitingHumanReview = rows.filter(row => row.status === 'review').length
  const aegisReviewing = rows.filter(row => row.status === 'quality_review').length

  return {
    items: items.slice(0, limit),
    summary: { total: rows.length, awaitingHumanReview, aegisReviewing },
  }
}
