'use client'

import { useCallback, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ApiError, apiFetch } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { useRunEventPulse } from '@/lib/use-run-events'
import { objectiveCommandHref } from '@/lib/project-link'
import { useMissionControl } from '@/store'

/**
 * Review Queue — first-class operator surface for AgentOS work that an
 * executor finished and routed into review ('review' awaiting human/Aegis
 * review, 'quality_review' Aegis review in flight).
 *
 * Read model: GET /api/agentos/reviews (shared lib: agentos-reviews.ts).
 * Mutations go through the authoritative backend POST /api/quality-review —
 * the only two real verdicts are exposed:
 *   - Approve    → status 'approved'   → task auto-advances to done
 *   - Reject     → status 'rejected'   → task returns to in_progress with the
 *                                        notes recorded as the rejection reason
 * No other actions exist in AgentOS, so none are shown.
 */

interface ReviewDelegation {
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
}

interface ReviewRecord {
  reviewer: string
  status: string
  notes: string | null
  createdAt: number | null
}

interface ReviewItem {
  taskId: number
  taskTitle: string
  taskStatus: 'review' | 'quality_review'
  projectId: number | null
  projectName: string | null
  objectiveId: number | null
  objectiveTitle: string | null
  review: ReviewRecord | null
  delegation: ReviewDelegation | null
  createdAt: number | null
  updatedAt: number | null
}

interface ReviewsResponse {
  items?: ReviewItem[]
  summary?: { total: number; awaitingHumanReview: number; aegisReviewing: number }
  error?: string
}

function fmtEpoch(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return `${m}m ${Math.round(seconds % 60)}s`
}

function shortId(id: string | null): string {
  if (!id) return '—'
  return id.length > 12 ? id.slice(0, 12) + '…' : id
}

export function AgentOSReviewsPanel() {
  const { currentUser } = useMissionControl()
  const [items, setItems] = useState<ReviewItem[]>([])
  const [summary, setSummary] = useState<ReviewsResponse['summary'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<ReviewsResponse>('/api/agentos/reviews?limit=200')
      setItems(data.items || [])
      if (data.summary) setSummary(data.summary)
      if (data.error) setError(data.error)
      setLastRefreshed(Math.floor(Date.now() / 1000))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load review queue')
    } finally {
      setLoading(false)
    }
  }, [])

  useSmartPoll(load, items.length > 0 ? 8_000 : 30_000)
  useRunEventPulse(load)

  const filtered = useMemo(() => (
    statusFilter === 'ALL' ? items : items.filter(i => i.taskStatus === statusFilter)
  ), [items, statusFilter])

  const reviewerName = currentUser?.username || currentUser?.display_name || 'operator'

  const refusalMessage = (err: unknown): string | null => {
    if (err instanceof ApiError && err.payload && typeof err.payload === 'object') {
      const payload = err.payload as Record<string, unknown>
      if (typeof payload.error === 'string' && payload.error) return payload.error
      if (typeof payload.reason === 'string' && payload.reason) return payload.reason
    }
    return err instanceof Error ? err.message : null
  }

  const submitReview = useCallback(async (item: ReviewItem, status: 'approved' | 'rejected', notes: string) => {
    setBusy(item.taskId)
    setError(null)
    setNotice(null)
    try {
      const data = await apiFetch<{ success?: boolean; error?: string }>(
        '/api/quality-review',
        {
          method: 'POST',
          body: JSON.stringify({ taskId: item.taskId, reviewer: reviewerName, status, notes }),
        },
      )
      if (data.success) {
        setNotice(status === 'approved'
          ? `Approved task #${item.taskId} — review recorded, task advanced to done.`
          : `Rejected task #${item.taskId} — review recorded, task returned to in_progress.`)
      } else {
        setNotice(data.error || 'Review was not recorded')
      }
      await load()
    } catch (err) {
      setError(refusalMessage(err) || 'Review submission failed')
    } finally {
      setBusy(null)
    }
  }, [load, reviewerName])

  const approve = useCallback(async (item: ReviewItem) => {
    const notes = window.prompt(`Approval note for task #${item.taskId} (recorded with the review):`, 'Approved via Mission Control review queue')
    if (notes === null) return
    await submitReview(item, 'approved', notes.trim() || 'Approved via Mission Control review queue')
  }, [submitReview])

  const reject = useCallback(async (item: ReviewItem) => {
    const notes = window.prompt(`Rejection reason for task #${item.taskId} (sent back to the executor with this reason):`)
    if (notes === null) return
    const trimmed = notes.trim()
    if (!trimmed) {
      setError('A rejection reason is required — the executor receives it as the rework instruction.')
      return
    }
    await submitReview(item, 'rejected', trimmed)
  }, [submitReview])

  const counts = summary || { total: 0, awaitingHumanReview: 0, aegisReviewing: 0 }

  return (
    <div className="m-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">Review Queue</h2>
          {summary && summary.total > 0 && (
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-sky-500/20 text-sky-300">
              {summary.total} in review{summary.awaitingHumanReview > 0 ? ` · ${summary.awaitingHumanReview} awaiting review` : ''}
            </span>
          )}
        </div>
        {lastRefreshed !== null && (
          <span className="text-xs text-muted-foreground">refreshed {new Date(lastRefreshed * 1000).toLocaleTimeString()}</span>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">{notice}</div>
      )}

      {/* Status filter */}
      <div className="flex flex-wrap gap-1 mb-4">
        {(['ALL', 'review', 'quality_review'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setStatusFilter(tab)}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${
              statusFilter === tab ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab === 'ALL' ? 'All' : tab === 'review' ? 'Awaiting review' : 'Aegis review'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading review queue…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {items.length === 0
            ? 'No work is awaiting review. Executor output routed into review will appear here.'
            : `No items match the "${statusFilter}" filter.`}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(item => (
            <ReviewCard
              key={item.taskId}
              item={item}
              busy={busy === item.taskId}
              onApprove={() => void approve(item)}
              onReject={() => void reject(item)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ReviewCard({ item, busy, onApprove, onReject }: {
  item: ReviewItem
  busy: boolean
  onApprove: () => void
  onReject: () => void
}) {
  const isQualityReview = item.taskStatus === 'quality_review'
  const commandHref = item.objectiveId != null && item.projectId != null
    ? objectiveCommandHref(item.projectId, item.objectiveId)
    : null
  const d = item.delegation

  return (
    <div className={`rounded-lg border bg-card p-4 ${isQualityReview ? 'border-violet-500/40' : 'border-sky-500/30'}`}>
      {/* Header: identity + status */}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-foreground truncate">{item.taskTitle}</span>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
              isQualityReview
                ? 'bg-violet-500/15 text-violet-300 border-violet-500/40'
                : 'bg-sky-500/15 text-sky-300 border-sky-500/40'
            }`}>
              {isQualityReview ? 'AEGIS REVIEW' : 'AWAITING REVIEW'}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {item.projectName || `Project #${item.projectId ?? '?'}`}
            {item.objectiveTitle && <> · <span className="text-foreground/80">{item.objectiveTitle}</span></>}
            {' · '}updated {fmtEpoch(item.updatedAt)}
          </div>
        </div>
        {d && (
          <span className="font-mono text-[10px] text-muted-foreground shrink-0" title={d.id}>
            delegation {shortId(d.id)}
          </span>
        )}
      </div>

      {/* Execution identity */}
      {d && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px]">
          {d.specialistName && <Chip cls="border-border bg-secondary/40 text-muted-foreground">{d.specialistName}</Chip>}
          {d.ecosystem && <Chip cls="border-border bg-secondary/40 text-muted-foreground">{d.ecosystem}</Chip>}
          {d.attempt != null && <Chip cls="border-border bg-secondary/40 text-muted-foreground">attempt {d.attempt}</Chip>}
          <span className="text-muted-foreground font-mono text-[10px]">
            {d.nativeSessionId ? `session ${shortId(d.nativeSessionId)}` : ''}
          </span>
          <span className="text-muted-foreground">
            {d.durationSeconds != null ? ` · ${fmtDuration(d.durationSeconds)}` : ''}
          </span>
        </div>
      )}

      {/* Result summary / output */}
      {(d?.resultSummary || d?.errorMessage) && (
        <div className="rounded-md border border-border/50 bg-background/30 px-3 py-2 mb-2 text-xs whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
          {d?.errorMessage ? (
            <span className="text-red-400">{d.errorMessage}</span>
          ) : (
            <span className="text-foreground/90">{d.resultSummary}</span>
          )}
        </div>
      )}

      {/* Latest review record */}
      {item.review && (
        <div className="rounded-md border border-border/50 bg-background/30 px-3 py-1.5 mb-2 text-[11px] text-muted-foreground">
          Latest review: <span className="text-foreground/80">{item.review.reviewer}</span> ·{' '}
          <span className={item.review.status === 'approved' ? 'text-emerald-300' : item.review.status === 'rejected' ? 'text-red-400' : 'text-amber-300'}>
            {item.review.status}
          </span>
          {item.review.notes && <> · {item.review.notes}</>}
          {' · '}{fmtEpoch(item.review.createdAt)}
        </div>
      )}

      {/* Actions — the only two real verdicts AgentOS supports */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={busy} onClick={onApprove}>
          {busy ? 'Submitting…' : 'Approve'}
        </Button>
        <Button size="sm" variant="outline" className="border-amber-500/40 text-amber-400 hover:bg-amber-500/10" disabled={busy} onClick={onReject}>
          Reject &amp; send back
        </Button>
        {commandHref && (
          <a href={commandHref}>
            <Button size="sm" variant="outline">Open in Project Command</Button>
          </a>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto">
          Approve completes the task; reject sends it back to the executor with your reason.
        </span>
      </div>
    </div>
  )
}

function Chip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`rounded border px-1.5 py-0.5 ${cls}`}>{children}</span>
}