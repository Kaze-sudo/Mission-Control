'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { useNavigateToProjectCommand } from '@/lib/navigation'

type RunState =
  | 'QUEUED' | 'HELD' | 'WAITING' | 'RUNNING' | 'REVIEWING'
  | 'RETRYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

interface AgentOSRun {
  id: string
  kind: 'delegation' | 'task'
  taskId: number
  taskTitle: string
  projectId: number | null
  projectName: string | null
  objectiveId: number | null
  objectiveTitle: string | null
  objectiveStatus: string | null
  delegationId: string | null
  delegationStatus: string | null
  taskStatus: string
  state: RunState
  ecosystem: string | null
  routingAgentName: string | null
  specialistName: string | null
  attempt: number | null
  nativeSessionId: string | null
  nativeRunId: string | null
  errorClass: string | null
  errorMessage: string | null
  resultSummary: string | null
  createdAt: number | null
  updatedAt: number | null
  completedAt: number | null
  durationSeconds: number | null
}

interface RunsResponse {
  runs?: AgentOSRun[]
  summary?: { total: number; byState: Partial<Record<RunState, number>> }
  error?: string
}

interface ProjectOption { id: number; name: string }

const ACTIVE_STATES = new Set<RunState>(['QUEUED', 'HELD', 'WAITING', 'RUNNING', 'REVIEWING', 'RETRYING'])

function stateTone(state: RunState): { text: string; chip: string; label: string } {
  switch (state) {
    case 'RUNNING': return { text: 'text-sky-400', chip: 'bg-sky-500/10 text-sky-300 border-sky-500/30', label: 'RUNNING' }
    case 'QUEUED': return { text: 'text-slate-400', chip: 'bg-slate-500/10 text-slate-300 border-slate-500/30', label: 'QUEUED' }
    case 'HELD': return { text: 'text-amber-400', chip: 'bg-amber-500/10 text-amber-300 border-amber-500/30', label: 'HELD' }
    case 'WAITING': return { text: 'text-violet-400', chip: 'bg-violet-500/10 text-violet-300 border-violet-500/30', label: 'WAITING' }
    case 'REVIEWING': return { text: 'text-sky-400', chip: 'bg-sky-500/10 text-sky-300 border-sky-500/30', label: 'REVIEWING' }
    case 'RETRYING': return { text: 'text-amber-400', chip: 'bg-amber-500/10 text-amber-300 border-amber-500/30', label: 'RETRYING' }
    case 'COMPLETED': return { text: 'text-emerald-400', chip: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', label: 'COMPLETED' }
    case 'FAILED': return { text: 'text-rose-400', chip: 'bg-rose-500/10 text-rose-300 border-rose-500/30', label: 'FAILED' }
    case 'CANCELLED': return { text: 'text-muted-foreground', chip: 'bg-muted/30 text-muted-foreground border-border', label: 'CANCELLED' }
  }
}

function fmtEpoch(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

const ERROR_CLASS_LABELS: Record<string, string> = {
  insufficient_balance: 'Insufficient provider balance',
  authentication: 'Provider authentication failure',
  timeout: 'Execution timed out',
  host_connection: 'Host connection failure',
  model_unavailable: 'Model unavailable',
  dispatch_rejected: 'Dispatch rejected / no candidate',
}

export function AgentOSRunsPanel() {
  const navigateToProject = useNavigateToProjectCommand()
  const [runs, setRuns] = useState<AgentOSRun[]>([])
  const [summary, setSummary] = useState<{ total: number; byState: Partial<Record<RunState, number>> } | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectFilter, setProjectFilter] = useState<string>('')
  const [ecosystemFilter, setEcosystemFilter] = useState<string>('')
  const [stateFilter, setStateFilter] = useState<string>('ALL')
  const [agentQuery, setAgentQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [retryBusy, setRetryBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (projectFilter) params.set('project_id', projectFilter)
      if (ecosystemFilter) params.set('ecosystem', ecosystemFilter)
      if (stateFilter !== 'ALL') params.set('state', stateFilter)
      if (agentQuery.trim()) params.set('agent', agentQuery.trim())
      params.set('limit', '150')
      const data = await apiFetch<RunsResponse>(`/api/agentos/runs?${params.toString()}`)
      if (data.runs) setRuns(data.runs)
      if (data.summary) setSummary(data.summary)
      if (data.error) setError(data.error)
      setLastRefreshed(Math.floor(Date.now() / 1000))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runs')
    } finally {
      setLoading(false)
    }
  }, [agentQuery, ecosystemFilter, projectFilter, stateFilter])

  const hasActive = useMemo(() => runs.some(run => ACTIVE_STATES.has(run.state)), [runs])
  useSmartPoll(load, hasActive ? 5_000 : 30_000)

  const loadProjects = useCallback(async () => {
    try {
      const data = await apiFetch<{ projects?: ProjectOption[] }>('/api/projects')
      setProjects(data.projects || [])
    } catch {
      // Project filter is optional; the run feed works without it.
    }
  }, [])
  useEffect(() => { void loadProjects() }, [loadProjects])

  const ecosystems = useMemo(() => {
    const found = new Set<string>()
    for (const run of runs) {
      if (run.ecosystem) found.add(run.ecosystem)
    }
    return [...found].sort()
  }, [runs])

  const counts = useMemo(() => {
    const by = summary?.byState || {}
    const running = (by.RUNNING || 0)
    const queued = (by.QUEUED || 0) + (by.HELD || 0) + (by.WAITING || 0)
    const reviewing = (by.REVIEWING || 0) + (by.RETRYING || 0)
    return {
      running, queued, reviewing,
      completed: by.COMPLETED || 0,
      failed: by.FAILED || 0,
      cancelled: by.CANCELLED || 0,
      active: running + queued + reviewing,
    }
  }, [summary])

  const toggleExpanded = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const retryRun = useCallback(async (run: AgentOSRun) => {
    setRetryBusy(run.id)
    setError(null)
    setNotice(null)
    try {
      const body = run.delegationId
        ? { action: 'retry', delegationId: run.delegationId }
        : { action: 'retry', taskId: run.taskId }
      const data = await apiFetch<{ ok?: boolean; scheduled?: boolean; held?: boolean; reason?: string; error?: string }>(
        '/api/agentos/runs',
        { method: 'POST', body: JSON.stringify(body) },
      )
      if (data.ok && data.scheduled) {
        setNotice(`Retry scheduled — task #${run.taskId} re-entered AgentOS routing and dispatch.`)
      } else {
        setNotice(data.reason || data.error || 'Retry was not scheduled')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setRetryBusy(null)
    }
  }, [load])

  const retryable = (run: AgentOSRun): boolean => run.state === 'FAILED'

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-primary">AgentOS Live Run Control</p>
          <h1 className="text-2xl font-semibold mt-1">Runs &amp; Execution</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Watch AgentOS dispatch through the live delegation ledger — queued, running, reviewing, completed, and failed executions across every CLI ecosystem.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{lastRefreshed ? `Updated ${fmtEpoch(lastRefreshed)}` : '—'}</span>
          {hasActive && <span className="flex items-center gap-1.5 text-sky-400"><span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />live (5s)</span>}
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
      {notice && <div className={`rounded-lg border px-4 py-3 text-sm ${notice.startsWith('Retry scheduled') ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>{notice}</div>}

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Active" value={counts.active} tone={counts.active > 0 ? 'text-sky-400' : 'text-muted-foreground'} />
        <Metric label="Running" value={counts.running} tone="text-sky-400" />
        <Metric label="Queued / Held" value={counts.queued} tone="text-amber-300" />
        <Metric label="Reviewing" value={counts.reviewing} tone="text-violet-300" />
        <Metric label="Completed" value={counts.completed} tone="text-emerald-400" />
        <Metric label="Failed" value={counts.failed} tone={counts.failed > 0 ? 'text-rose-400' : 'text-muted-foreground'} />
      </div>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {(['ALL', 'ACTIVE', 'FAILED', 'COMPLETED', 'CANCELLED'] as const).map(label => (
              <button
                key={label}
                onClick={() => setStateFilter(label)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${stateFilter === label ? 'bg-primary text-primary-foreground' : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'}`}
              >
                {label === 'ALL' ? 'All states' : label[0] + label.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select value={projectFilter} onChange={e => setProjectFilter(e.target.value)} className="rounded border border-border bg-background px-2 py-1.5 text-xs">
              <option value="">All projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select value={ecosystemFilter} onChange={e => setEcosystemFilter(e.target.value)} className="rounded border border-border bg-background px-2 py-1.5 text-xs">
              <option value="">All ecosystems</option>
              {ecosystems.map(eco => <option key={eco} value={eco}>{eco}</option>)}
            </select>
            <input
              value={agentQuery}
              onChange={e => setAgentQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void load() }}
              className="w-56 rounded border border-border bg-background px-2 py-1.5 text-xs"
              placeholder="Search routing agent / specialist…"
            />
          </div>
        </div>

        {loading && runs.length === 0 ? (
          <div className="text-sm text-muted-foreground">Loading execution runs…</div>
        ) : runs.length === 0 ? (
          <div className="text-sm text-muted-foreground">No AgentOS runs match the current view. Plan and execute an objective from Project Command to see live execution here.</div>
        ) : (
          <div className="space-y-2">
            {runs.map(run => {
              const tone = stateTone(run.state)
              const isOpen = expanded.has(run.id)
              const who = run.specialistName || run.routingAgentName || 'unassigned'
              return (
                <div key={run.id} className={`rounded-lg border border-border/50 bg-background/40 ${isOpen ? 'ring-1 ring-border' : ''}`}>
                  <button
                    type="button"
                    onClick={() => toggleExpanded(run.id)}
                    className="flex w-full flex-col gap-2 px-3 py-2.5 text-left hover:bg-primary/[0.03]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {run.taskTitle}
                          <span className="ml-2 text-[10px] font-normal text-muted-foreground">{run.kind === 'delegation' ? `attempt ${run.attempt ?? '?'}` : 'not yet claimed'}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          Task #{run.taskId}{run.projectName ? ` · ${run.projectName}` : ''}{run.ecosystem ? ` · ${run.ecosystem}` : ''} · {who}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className={`rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase ${tone.chip}`}>{tone.label}</span>
                        <span className="text-muted-foreground text-[10px]">{isOpen ? '▾' : '▸'}</span>
                      </div>
                    </div>
                    {run.state === 'FAILED' && run.errorMessage && (
                      <div className="line-clamp-1 text-xs text-rose-400/90">{run.errorClass ? `[${ERROR_CLASS_LABELS[run.errorClass] || run.errorClass}] ` : ''}{run.errorMessage}</div>
                    )}
                  </button>

                  {isOpen && (
                    <div className="border-t border-border/50 px-3 py-3 space-y-3">
                      <div className="grid gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-2 xl:grid-cols-3">
                        <Field label="Objective" value={run.objectiveTitle ? `${run.objectiveTitle} (${run.objectiveStatus || '?'})` : run.objectiveId ? `Objective #${run.objectiveId}` : '—'} />
                        <Field label="Project" value={run.projectName || (run.projectId ? `Project #${run.projectId}` : '—')} />
                        <Field label="Ecosystem" value={run.ecosystem || '—'} />
                        <Field label="Routing agent" value={run.routingAgentName || '—'} />
                        <Field label="Specialist" value={run.specialistName || '—'} />
                        <Field label="Delegation" value={run.delegationId ? `${shortId(run.delegationId)} (${run.delegationStatus || '?'})` : 'none — queued before claim'} />
                        {run.kind === 'delegation' && (
                          <>
                            <Field label="Native session" value={run.nativeSessionId || '—'} />
                            <Field label="Native run" value={run.nativeRunId || '—'} />
                            <Field label="Duration" value={fmtDuration(run.durationSeconds)} />
                          </>
                        )}
                        <Field label="Created" value={fmtEpoch(run.createdAt)} />
                        <Field label="Updated" value={fmtEpoch(run.updatedAt)} />
                        <Field label="Completed" value={fmtEpoch(run.completedAt)} />
                      </div>

                      {run.projectId !== null && (
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" onClick={() => navigateToProject(run.projectId!)}>Open Project Command</Button>
                          {retryable(run) && (
                            <Button
                              size="sm"
                              disabled={retryBusy === run.id}
                              onClick={() => void retryRun(run)}
                            >
                              {retryBusy === run.id ? 'Retrying…' : 'Retry (new attempt)'}
                            </Button>
                          )}
                        </div>
                      )}
                      {retryable(run) && (
                        <p className="text-[10px] text-muted-foreground">
                          Retry preserves the failed delegation as history and re-enters this task through current AgentOS routing; authorization/cost gates re-run at dispatch. Paused or blocked projects refuse retry until resumed in Project Command.
                        </p>
                      )}

                      {run.errorMessage && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                          <div className="mb-1 text-[10px] font-mono uppercase tracking-wider text-rose-400">
                            {run.errorClass ? ERROR_CLASS_LABELS[run.errorClass] || run.errorClass : 'Error'}
                          </div>
                          <pre className="whitespace-pre-wrap font-mono text-[11px] text-rose-300/90">{run.errorMessage}</pre>
                        </div>
                      )}
                      {run.resultSummary && (
                        <div className="rounded-md border border-border/40 bg-background/30 px-3 py-2">
                          <div className="mb-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Result</div>
                          <pre className="whitespace-pre-wrap font-mono text-[11px] text-foreground/80 line-clamp-6">{run.resultSummary}</pre>
                        </div>
                      )}
                      <div className="grid gap-1 text-[10px] font-mono text-muted-foreground">
                        <div>Task status: {run.taskStatus}{run.kind === 'task' && run.state === 'WAITING' ? ' — dependency-gated mission' : ''}</div>
                        {run.delegationId && <div>Run key: {run.id}</div>}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="mt-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="font-mono uppercase tracking-wider text-muted-foreground block">{label}</span>
      <span className="truncate block text-foreground/85" title={value}>{value}</span>
    </div>
  )
}
