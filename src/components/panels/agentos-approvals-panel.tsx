'use client'

import { useCallback, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ApiError, apiFetch } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { useRunEventPulse } from '@/lib/use-run-events'
import { objectiveCommandHref } from '@/lib/project-link'

/**
 * Approval Center — first-class operator surface for AgentOS execution plans
 * waiting for approval across all projects.
 *
 * Read model: GET /api/agentos/approvals (shared lib: agentos-approvals.ts).
 * Mutations go through the authoritative per-project backend
 * (POST /api/projects/[id]/agentos-execution, actions approve/deny) — this
 * panel never fakes state and never bypasses fingerprint binding: the backend
 * regenerates the plan at approve time and refuses a stale fingerprint, so a
 * STALE item can never silently authorize dispatch.
 */

interface ApprovalMission {
  taskId: number
  title: string
  assignedTo: string | null
  specialist: string | null
  provider: string | null
  model: string | null
  costClass: string
  estimatedCost: number | null
}

interface ApprovalItem {
  objectiveId: number
  projectId: number
  projectName: string | null
  objectiveTitle: string | null
  objectiveStatus: string | null
  planStatus: string | null
  planId: string | null
  fingerprint: string | null
  approvalStatus: 'NONE' | 'VALID' | 'STALE' | 'EXPIRED'
  approvedBy: string | null
  approvedAt: number | null
  missionCounts: { total: number; free: number; paid: number; unknownCost: number; blocked: number; requiresApproval: number }
  estimatedTotalCost: number | null
  maximumTotalExposure: number | null
  approvalRequiredMissions: ApprovalMission[]
  createdAt: number | null
  updatedAt: number | null
}

interface ApprovalsResponse {
  items?: ApprovalItem[]
  summary?: { total: number; byStatus: Partial<Record<ApprovalItem['approvalStatus'], number>> }
  error?: string
}

const STATUS_CHIP: Record<ApprovalItem['approvalStatus'], { chip: string; label: string }> = {
  STALE: { chip: 'bg-amber-500/15 text-amber-300 border-amber-500/40', label: 'STALE — RE-APPROVAL REQUIRED' },
  EXPIRED: { chip: 'bg-orange-500/15 text-orange-300 border-orange-500/40', label: 'EXPIRED — RE-APPROVAL REQUIRED' },
  NONE: { chip: 'bg-sky-500/15 text-sky-300 border-sky-500/40', label: 'APPROVAL REQUIRED' },
  VALID: { chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', label: 'APPROVED' },
}

const COST_CHIP: Record<string, string> = {
  FREE_LOCAL: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  PAID_KNOWN: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  PAID_ESTIMATED: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  UNKNOWN_COST: 'bg-orange-500/10 text-orange-300 border-orange-500/30',
  BLOCKED: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
}

function fmtMoney(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`
}

function fmtEpoch(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function shortFp(fp: string | null): string {
  if (!fp) return '—'
  return fp.length > 12 ? fp.slice(0, 10) + '…' : fp
}

export function AgentOSApprovalsPanel() {
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [summary, setSummary] = useState<ApprovalsResponse['summary'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<ApprovalsResponse>('/api/agentos/approvals?limit=200')
      setItems(data.items || [])
      if (data.summary) setSummary(data.summary)
      if (data.error) setError(data.error)
      setLastRefreshed(Math.floor(Date.now() / 1000))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals')
    } finally {
      setLoading(false)
    }
  }, [])

  useSmartPoll(load, items.length > 0 ? 8_000 : 30_000)
  useRunEventPulse(load)

  const filtered = useMemo(() => (
    statusFilter === 'ALL' ? items : items.filter(i => i.approvalStatus === statusFilter)
  ), [items, statusFilter])

  /** Extract the structured refusal message from an ApiError payload. */
  const refusalMessage = (err: unknown): string | null => {
    if (err instanceof ApiError && err.payload && typeof err.payload === 'object') {
      const payload = err.payload as Record<string, unknown>
      if (typeof payload.reason === 'string' && payload.reason) return payload.reason
      if (typeof payload.error === 'string' && payload.error) return payload.error
    }
    return err instanceof Error ? err.message : null
  }

  const approve = useCallback(async (item: ApprovalItem) => {
    setBusy(item.objectiveId)
    setError(null)
    setNotice(null)
    try {
      const data = await apiFetch<{ ok?: boolean; approvalStatus?: string; error?: string }>(
        `/api/projects/${item.projectId}/agentos-execution`,
        { method: 'POST', body: JSON.stringify({ objectiveId: item.objectiveId, action: 'approve', approveTaskIds: 'all-eligible' }) },
      )
      if (data.ok) setNotice(`Approved objective #${item.objectiveId} — authorization is fingerprint-bound; dispatch-time gates still apply.`)
      else setNotice(data.error || 'Approval was not recorded')
      await load()
    } catch (err) {
      // The backend refuses stale/changed plans — surface the real refusal.
      setError(refusalMessage(err) || 'Approval failed')
    } finally {
      setBusy(null)
    }
  }, [load])

  const deny = useCallback(async (item: ApprovalItem) => {
    const reason = window.prompt(`Deny reason for objective #${item.objectiveId} (stored with the decision):`)
    if (reason === null) return
    setBusy(item.objectiveId)
    setError(null)
    setNotice(null)
    try {
      const data = await apiFetch<{ ok?: boolean; message?: string; error?: string }>(
        `/api/projects/${item.projectId}/agentos-execution`,
        { method: 'POST', body: JSON.stringify({ objectiveId: item.objectiveId, action: 'deny', reason: reason || null }) },
      )
      if (data.ok) setNotice(`Denied objective #${item.objectiveId}.`)
      else setNotice(data.error || 'Deny was not recorded')
      await load()
    } catch (err) {
      setError(refusalMessage(err) || 'Deny failed')
    } finally {
      setBusy(null)
    }
  }, [load])

  const counts = summary?.byStatus || {}
  const staleCount = (counts.STALE || 0) + (counts.EXPIRED || 0)

  return (
    <div className="m-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">Approvals</h2>
          {summary && summary.total > 0 && (
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${staleCount > 0 ? 'bg-amber-500/20 text-amber-300 animate-pulse' : 'bg-sky-500/20 text-sky-300'}`}>
              {summary.total} waiting{staleCount > 0 ? ` · ${staleCount} stale/expired` : ''}
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
        {(['ALL', 'STALE', 'EXPIRED', 'NONE'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setStatusFilter(tab)}
            className={`px-2.5 py-1 text-xs rounded transition-colors ${
              statusFilter === tab ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab === 'ALL' ? 'All' : tab === 'NONE' ? 'Pending' : tab === 'STALE' ? 'Stale' : 'Expired'}
            {tab !== 'ALL' && counts[tab] ? ` (${counts[tab]})` : ''}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading approvals…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {items.length === 0
            ? 'No work is waiting for approval. Plans requiring approval will appear here.'
            : `No items match the "${statusFilter}" filter.`}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(item => (
            <ApprovalCard
              key={item.objectiveId}
              item={item}
              busy={busy === item.objectiveId}
              onApprove={() => void approve(item)}
              onDeny={() => void deny(item)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ApprovalCard({ item, busy, onApprove, onDeny }: {
  item: ApprovalItem
  busy: boolean
  onApprove: () => void
  onDeny: () => void
}) {
  const status = STATUS_CHIP[item.approvalStatus]
  const isStale = item.approvalStatus === 'STALE' || item.approvalStatus === 'EXPIRED'
  const commandHref = objectiveCommandHref(item.projectId, item.objectiveId)

  return (
    <div className={`rounded-lg border bg-card p-4 ${isStale ? 'border-amber-500/40' : 'border-border'}`}>
      {/* Header: identity + status */}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-foreground truncate">
              {item.objectiveTitle || `Objective #${item.objectiveId}`}
            </span>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border ${status.chip}`}>
              {status.label}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {item.projectName || `Project #${item.projectId}`}
            {' · '}created {fmtEpoch(item.createdAt)}
            {item.approvedBy && <> · last approved by <span className="text-foreground/80">{item.approvedBy}</span> {fmtEpoch(item.approvedAt)}</>}
          </div>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground shrink-0" title={item.fingerprint || undefined}>
          fp {shortFp(item.fingerprint)}
        </span>
      </div>

      {/* Stale explanation */}
      {isStale && (
        <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90">
          The plan changed after the last approval (fingerprint mismatch). The old approval can no longer
          authorize dispatch — review and re-approve the current plan.
        </div>
      )}

      {/* Mission summary */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px]">
        <span className="rounded border border-border bg-secondary/40 px-1.5 py-0.5 text-muted-foreground">
          {item.missionCounts.total} mission{item.missionCounts.total !== 1 ? 's' : ''}
        </span>
        {item.missionCounts.free > 0 && <Chip cls="bg-emerald-500/10 text-emerald-300 border-emerald-500/30">{item.missionCounts.free} free</Chip>}
        {item.missionCounts.paid > 0 && <Chip cls="bg-amber-500/10 text-amber-300 border-amber-500/30">{item.missionCounts.paid} paid</Chip>}
        {item.missionCounts.unknownCost > 0 && <Chip cls="bg-orange-500/10 text-orange-300 border-orange-500/30">{item.missionCounts.unknownCost} unknown cost</Chip>}
        {item.missionCounts.blocked > 0 && <Chip cls="bg-rose-500/10 text-rose-300 border-rose-500/30">{item.missionCounts.blocked} blocked</Chip>}
        <span className="text-muted-foreground">
          est. {fmtMoney(item.estimatedTotalCost)}
          {item.maximumTotalExposure !== null && <> · max exposure {fmtMoney(item.maximumTotalExposure)}</>}
        </span>
      </div>

      {/* Missions requiring approval — real routing identity from the plan */}
      {item.approvalRequiredMissions.length > 0 && (
        <div className="rounded-md border border-border/50 bg-background/30 divide-y divide-border/40 mb-3">
          {item.approvalRequiredMissions.slice(0, 6).map(m => (
            <div key={m.taskId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
              <span className="text-foreground/90 truncate min-w-0 flex-1">{m.title}</span>
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${COST_CHIP[m.costClass] || 'border-border text-muted-foreground'}`}>
                {m.costClass}{m.estimatedCost !== null ? ` ${fmtMoney(m.estimatedCost)}` : ''}
              </span>
              <span className="text-muted-foreground font-mono text-[10px] truncate max-w-[260px]" title={[m.assignedTo, m.provider, m.model].filter(Boolean).join(' · ')}>
                {m.specialist || m.assignedTo || 'unassigned'}
                {m.model ? ` · ${m.provider || '?'}/${m.model}` : ''}
              </span>
            </div>
          ))}
          {item.approvalRequiredMissions.length > 6 && (
            <div className="px-3 py-1.5 text-[10px] text-muted-foreground">
              +{item.approvalRequiredMissions.length - 6} more missions — inspect the full plan in Project Command
            </div>
          )}
        </div>
      )}

      {/* Actions — real backend only */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={busy} onClick={onApprove}>
          {busy ? 'Approving…' : 'Approve plan'}
        </Button>
        <Button size="sm" variant="outline" className="border-red-500/40 text-red-400 hover:bg-red-500/10" disabled={busy} onClick={onDeny}>
          Deny
        </Button>
        <a href={commandHref}>
          <Button size="sm" variant="outline">Open in Project Command</Button>
        </a>
        <span className="text-[10px] text-muted-foreground ml-auto">
          Approval binds to fingerprint {shortFp(item.fingerprint)} — any material plan change voids it.
        </span>
      </div>
    </div>
  )
}

function Chip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`rounded border px-1.5 py-0.5 ${cls}`}>{children}</span>
}
