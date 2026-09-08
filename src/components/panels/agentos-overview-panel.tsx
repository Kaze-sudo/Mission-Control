'use client'

import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { useNavigateToPanel, useNavigateToProjectCommand } from '@/lib/navigation'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { useRunEventPulse } from '@/lib/use-run-events'

/**
 * AgentOS System Status — the command-layer readout on the Overview page.
 *
 * Surfaces real AgentOS state (hosts, command state, roster dispatchability,
 * gated execution, orchestration errors) instead of leaving the home page
 * Mission Control-only. Read-only: navigation links point at the control
 * surfaces (Platoons, Project Command) where actions live.
 */

interface PlatoonStatus {
  id: string
  name: string
  installed: boolean
  running: boolean
  authenticated: boolean
  authRequired: boolean
  health: 'ready' | 'degraded' | 'offline' | 'not-installed'
  commander: { name: string; available: boolean; blocked: boolean; blockReason: string | null; agentCount: number } | null
  specialists: { total: number; available: number; unavailable: number }
}

interface CommandProject { id: number; name: string; state: string; updatedBy: string | null; updatedAt: number | null }
interface AttentionItem { id: string; kind: 'delegation' | 'objective'; level: 'error' | 'warn'; taskId: number | null; projectId: number | null; projectName: string | null; title: string; detail: string | null; at: number }

interface AgentOSStatus {
  asOf: number
  configured: boolean
  command: {
    totalProjects: number
    commanded: number
    states: Record<string, number>
    paused: CommandProject[]
    blocked: CommandProject[]
  }
  platoons: PlatoonStatus[]
  roster: {
    discovered: number
    registered: number
    dispatchable: number
    unavailable: number
    classifications: Record<string, number>
  }
  execution: {
    objectives: { total: number; byStatus: Record<string, number> }
    missions: { total: number; running: number; queued: number; held: number; review: number; done: number; failed: number; cancelled: number; other: number }
  }
  attention: AttentionItem[]
  timestamps: { lastRosterSeen: number | null; lastCommandUpdate: number | null; lastDelegation: number | null }
}

type OverallState = 'OPERATIONAL' | 'PAUSED' | 'DEGRADED' | 'BLOCKED' | 'IDLE'

function overallState(status: AgentOSStatus): OverallState {
  const blockedCommand = status.command.states['blocked'] ?? 0
  const anyBlockedCommander = status.platoons.some(platoon => platoon.commander?.blocked === true)
  if (blockedCommand > 0 || anyBlockedCommander) return 'BLOCKED'
  const anyHostDown = status.platoons.some(platoon => platoon.health === 'degraded' || platoon.health === 'offline')
  if (anyHostDown) return 'DEGRADED'
  const pausedCount = status.command.states['paused'] ?? 0
  const activeCount = status.command.states['active'] ?? 0
  const busy = status.execution.missions.running + status.execution.missions.queued + status.execution.missions.held > 0
  if (pausedCount > 0 && activeCount === 0) return 'PAUSED'
  if (busy || activeCount > 0) return 'OPERATIONAL'
  return 'IDLE'
}

function stateClass(state: OverallState): string {
  switch (state) {
    case 'OPERATIONAL': return 'text-emerald-400 bg-emerald-500/15 border-emerald-500/40'
    case 'PAUSED': return 'text-amber-300 bg-amber-500/15 border-amber-500/40'
    case 'DEGRADED': return 'text-amber-300 bg-amber-500/15 border-amber-500/40'
    case 'BLOCKED': return 'text-rose-400 bg-rose-500/15 border-rose-500/40'
    default: return 'text-muted-foreground bg-secondary border-border/60'
  }
}

function healthClass(health: PlatoonStatus['health']): { dot: string; label: string; text: string } {
  switch (health) {
    case 'ready': return { dot: 'bg-emerald-400', label: 'READY', text: 'text-emerald-400' }
    case 'degraded': return { dot: 'bg-amber-300', label: 'DEGRADED', text: 'text-amber-300' }
    case 'offline': return { dot: 'bg-rose-400', label: 'OFFLINE', text: 'text-rose-400' }
    default: return { dot: 'bg-muted-foreground/40', label: 'NOT INSTALLED', text: 'text-muted-foreground' }
  }
}

function formatTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return 'never'
  return new Date(unixSeconds * 1000).toLocaleTimeString()
}

function Chip({ children, tone = 'neutral', title }: { children: React.ReactNode; tone?: 'good' | 'warn' | 'bad' | 'neutral' | 'info'; title?: string }) {
  const tones: Record<string, string> = {
    good: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    bad: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    info: 'bg-primary/10 text-primary border-primary/30',
    neutral: 'bg-secondary/60 text-muted-foreground border-border/60',
  }
  return <span title={title} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tones[tone]}`}>{children}</span>
}

/** Compact deep-linkable operator queue card (Overview command center). */
function QueueCard({ label, value, tone, onClick }: { label: string; value: number; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral'; onClick: () => void }) {
  const tones: Record<string, string> = {
    good: 'text-emerald-400',
    warn: 'text-amber-300',
    bad: 'text-rose-400',
    info: 'text-primary',
    neutral: 'text-muted-foreground',
  }
  const highlight: Record<string, string> = {
    good: 'hover:border-emerald-500/40',
    warn: 'hover:border-amber-500/40',
    bad: 'hover:border-rose-500/40',
    info: 'hover:border-primary/40',
    neutral: 'hover:border-border',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-left transition-colors cursor-pointer ${highlight[tone]}`}
    >
      <div className={`text-xl font-semibold tabular-nums leading-tight ${tone === 'neutral' ? 'text-muted-foreground' : tones[tone]}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 truncate">{label}</div>
    </button>
  )
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className="text-lg font-semibold text-foreground leading-tight mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5 truncate" title={sub}>{sub}</div>}
    </div>
  )
}

interface RunSummary { summary?: { byState?: Record<string, number> } }

export function AgentOSOverviewPanel() {
  const navigateToPanel = useNavigateToPanel()
  const navigateToProject = useNavigateToProjectCommand()
  const [status, setStatus] = useState<AgentOSStatus | null>(null)
  const [runSummary, setRunSummary] = useState<Record<string, number>>({})
  const [approvalsWaiting, setApprovalsWaiting] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [statusData, runsData, approvalsData] = await Promise.all([
        apiFetch<{ status?: AgentOSStatus }>('/api/agentos/status'),
        apiFetch<RunSummary>('/api/agentos/runs?limit=250').catch(() => null),
        apiFetch<{ summary?: { total: number } }>('/api/agentos/approvals?limit=1').catch(() => null),
      ])
      setStatus(statusData.status || null)
      setError(null)
      // Operator queue strip — canonical run feed + approval queue summaries.
      const byState = runsData?.summary?.byState || {}
      setRunSummary({
        RUNNING: byState.RUNNING || 0,
        QUEUED: (byState.QUEUED || 0) + (byState.WAITING || 0),
        HELD: byState.HELD || 0,
        REVIEWING: (byState.REVIEWING || 0) + (byState.RETRYING || 0),
        FAILED: byState.FAILED || 0,
      })
      setApprovalsWaiting(approvalsData?.summary?.total ?? 0)
    } catch {
      setError('AgentOS status unavailable')
    } finally {
      setLoaded(true)
    }
  }, [])

  useSmartPoll(refresh, 30_000)
  // The SSE stream is live-only (no replay): state changed while disconnected
  // is gone from the stream, so converge immediately on reconnect instead of
  // waiting for the next 30s poll tick.
  useRunEventPulse(refresh, 60_000)

  if (!loaded && !status) return null
  if (!status) {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        AgentOS system status unavailable{error ? ` — ${error}` : ''}.
      </div>
    )
  }

  const state = overallState(status)
  const missions = status.execution.missions
  const objectives = status.execution.objectives
  const attentionErrors = status.attention.filter(item => item.level === 'error').length
  const attentionWarns = status.attention.length - attentionErrors
  const objectiveNeedsManual = objectives.byStatus['needs_manual'] ?? 0
  const objectiveActive = objectives.byStatus['active'] ?? 0

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-primary">AgentOS · Company Commander</p>
            <h2 className="text-base font-semibold text-foreground">System Status</h2>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${stateClass(state)}`}>
            {state}
          </span>
          {attentionErrors > 0 && (
            <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-rose-400">
              {attentionErrors} orchestration error{attentionErrors === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground/70">Updated {formatTime(status.asOf)}</span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>Refresh</Button>
          <Button size="sm" variant="ghost" onClick={() => navigateToPanel('platoons')}>Platoons</Button>
          <Button size="sm" variant="ghost" onClick={() => navigateToPanel('command')}>Project Command</Button>
        </div>
      </div>

      {error && <div className="border-b border-border/40 bg-rose-500/5 px-4 py-2 text-xs text-rose-400">{error}</div>}

      {!status.configured ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div className="text-xs text-muted-foreground">
            No AgentOS command layer configured yet — no CLI platoons, project command rows, or roster specialists discovered on this station.
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => navigateToPanel('platoons')}>Discover CLI Platoons</Button>
            <Button size="sm" variant="outline" onClick={() => navigateToPanel('command')}>Open Project Command</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 p-4 xl:grid-cols-2">
          {/* Operator queues — compact deep links (Phase 11: Overview as command center) */}
          <div className="xl:col-span-2 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <QueueCard label="Approvals waiting" value={approvalsWaiting} tone={approvalsWaiting > 0 ? 'info' : 'neutral'} onClick={() => navigateToPanel('approvals')} />
            <QueueCard label="Active runs" value={runSummary.RUNNING || 0} tone={runSummary.RUNNING ? 'good' : 'neutral'} onClick={() => navigateToPanel('runs')} />
            <QueueCard label="Queued" value={runSummary.QUEUED || 0} tone={(runSummary.QUEUED || 0) > 0 ? 'info' : 'neutral'} onClick={() => navigateToPanel('runs')} />
            <QueueCard label="Reviewing" value={runSummary.REVIEWING || 0} tone={(runSummary.REVIEWING || 0) > 0 ? 'info' : 'neutral'} onClick={() => navigateToPanel('reviews')} />
            <QueueCard label="Failed" value={runSummary.FAILED || 0} tone={(runSummary.FAILED || 0) > 0 ? 'bad' : 'neutral'} onClick={() => navigateToPanel('runs')} />
            <QueueCard
              label="Held / blocked"
              value={(runSummary.HELD || 0) + (status.command.states['paused'] ?? 0) + (status.command.states['blocked'] ?? 0)}
              tone={(runSummary.HELD || 0) + (status.command.states['paused'] ?? 0) + (status.command.states['blocked'] ?? 0) > 0 ? 'warn' : 'neutral'}
              onClick={() => navigateToPanel('runs')}
            />
          </div>
          {/* Column: hosts + command */}
          <div className="space-y-4">
            <div className="rounded-lg border border-border/50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">CLI hosts & providers</p>
                <span className="text-[10px] text-muted-foreground/70">{status.platoons.filter(p => p.health === 'ready').length} ready · {status.platoons.filter(p => p.health === 'degraded').length} degraded · {status.platoons.filter(p => p.health === 'offline').length} offline</span>
              </div>
              <div className="mt-2.5 grid gap-1.5 md:grid-cols-2">
                {status.platoons.map(platoon => {
                  const health = healthClass(platoon.health)
                  const blockedReason = platoon.commander?.blocked ? platoon.commander.blockReason : platoon.authRequired && !platoon.authenticated ? 'Authentication required' : null
                  return (
                    <div key={platoon.id} className="flex items-center justify-between gap-2 rounded border border-border/40 bg-background/30 px-2.5 py-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${health.dot} ${health.label === 'DEGRADED' || health.label === 'OFFLINE' ? 'animate-pulse' : ''}`} />
                        <span className="truncate text-xs font-medium text-foreground" title={`${platoon.name} · ${platoon.commander?.name || 'runtime native'}`}>{platoon.name}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {platoon.specialists.total > 0 && (
                          <span className={`text-[10px] ${platoon.specialists.available > 0 ? 'text-emerald-400' : 'text-muted-foreground'}`} title={`${platoon.specialists.available} of ${platoon.specialists.total} specialists available`}>
                            {platoon.specialists.available}/{platoon.specialists.total}
                          </span>
                        )}
                        <Chip tone={health.label === 'READY' ? 'good' : health.label === 'DEGRADED' ? 'warn' : health.label === 'OFFLINE' ? 'bad' : 'neutral'} title={blockedReason || `${platoon.name} host health: ${health.label.toLowerCase()}`}>
                          {health.label}
                        </Chip>
                      </div>
                    </div>
                  )
                })}
              </div>
              {status.attention.length > 0 && (
                <div className="mt-2.5 space-y-1.5">
                  {status.attention.slice(0, 5).map(item => {
                    const toneClass = item.level === 'error' ? 'border-rose-500/30 bg-rose-500/5 text-rose-300' : 'border-amber-500/30 bg-amber-500/5 text-amber-200'
                    const canLink = item.projectId !== null && item.projectId !== undefined
                    const inner = (
                      <>
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium">{item.title}</span>
                          <span className="shrink-0 text-[9px] uppercase text-muted-foreground/60">{formatTime(item.at)}</span>
                        </div>
                        {item.detail && <div className="mt-0.5 text-[11px] text-foreground/70 break-words">{item.detail}</div>}
                        {item.projectName && <div className="mt-0.5 text-[10px] text-muted-foreground">{item.projectName}{item.taskId ? ` · task #${item.taskId}` : ''}{canLink ? ' · open in Project Command →' : ''}</div>}
                      </>
                    )
                    return canLink
                      ? (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => navigateToProject(item.projectId!)}
                          title="Open this project in Project Command"
                          className={`w-full cursor-pointer rounded border px-2.5 py-1.5 text-left text-xs transition-colors hover:border-primary/50 hover:bg-primary/5 ${toneClass}`}
                        >
                          {inner}
                        </button>
                      )
                      : (
                        <div key={item.id} className={`rounded border px-2.5 py-1.5 text-xs ${toneClass}`}>
                          {inner}
                        </div>
                      )
                  })}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-lg border border-border/50 p-3">
                <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Commanded projects</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(status.command.states).length === 0 && <span className="text-[10px] text-muted-foreground">None</span>}
                  {Object.entries(status.command.states).map(([state, count]) => (
                    <Chip key={state} tone={state === 'paused' ? 'warn' : state === 'blocked' ? 'bad' : state === 'active' ? 'good' : 'info'}>{state} · {count}</Chip>
                  ))}
                </div>
                {(status.command.paused.length > 0 || status.command.blocked.length > 0) && (
                  <div className="mt-2 space-y-1">
                    {status.command.paused.map(project => (
                      <button key={`paused-${project.id}`} type="button" onClick={() => navigateToProject(project.id)} title="Open in Project Command" className="flex w-full cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-primary/5 hover:text-primary">
                        <span className="truncate text-foreground/80">⏸ {project.name}</span>
                        <span className="shrink-0 text-muted-foreground/60">{formatTime(project.updatedAt)}</span>
                      </button>
                    ))}
                    {status.command.blocked.map(project => (
                      <button key={`blocked-${project.id}`} type="button" onClick={() => navigateToProject(project.id)} title="Open in Project Command" className="flex w-full cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-primary/5 hover:text-primary">
                        <span className="truncate text-foreground/80">⛔ {project.name}</span>
                        <span className="shrink-0 text-muted-foreground/60">{formatTime(project.updatedAt)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-border/50 p-3">
                <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Roster specialists</p>
                <div className="mt-1.5 text-2xl font-semibold text-foreground">{status.roster.dispatchable}<span className="text-xs font-normal text-muted-foreground"> / {status.roster.discovered} dispatchable</span></div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {status.roster.unavailable > 0 && <Chip tone="bad">{status.roster.unavailable} unavailable</Chip>}
                  {Object.entries(status.roster.classifications).filter(([, count]) => (count as number) > 0).map(([klass, count]) => (
                    <Chip key={klass} tone={klass === 'FREE_LOCAL' ? 'good' : klass === 'UNKNOWN_COST' || klass === 'PAID_ESTIMATED' ? 'warn' : klass === 'BLOCKED' ? 'bad' : 'info'}>{klass.replace(/_/g, '-')} · {count}</Chip>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Column: execution */}
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Metric label="Running" value={missions.running} />
              <Metric label="Queued" value={missions.queued} sub={missions.held > 0 ? `${missions.held} held / waiting` : undefined} />
              <Metric label="Review" value={missions.review} />
              <Metric label="Failed" value={missions.failed} />
            </div>
            <div className="rounded-lg border border-border/50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Gated missions (objectives · reviews · curation)</p>
                <span className="text-[10px] text-muted-foreground/70">{missions.total} tracked</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {missions.done > 0 && <Chip tone="good">{missions.done} done</Chip>}
                {missions.queued > 0 && <Chip tone="info">{missions.queued} queued</Chip>}
                {missions.held > 0 && <Chip tone="warn">{missions.held} held</Chip>}
                {missions.running > 0 && <Chip tone="info">{missions.running} running</Chip>}
                {missions.cancelled > 0 && <Chip tone="neutral">{missions.cancelled} cancelled</Chip>}
                {missions.total === 0 && <span className="text-[10px] text-muted-foreground">No AgentOS missions yet</span>}
              </div>
            </div>
            <div className="rounded-lg border border-border/50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Objectives</p>
                <span className="text-[10px] text-muted-foreground/70">{objectives.total} total</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {objectiveActive > 0 && <Chip tone="good">{objectiveActive} active</Chip>}
                {(objectives.byStatus['planned'] ?? 0) > 0 && <Chip tone="info">{objectives.byStatus['planned']} planned</Chip>}
                {objectiveNeedsManual > 0 && <Chip tone="warn">{objectiveNeedsManual} need manual</Chip>}
                {(objectives.byStatus['failed'] ?? 0) > 0 && <Chip tone="bad">{objectives.byStatus['failed']} failed</Chip>}
                {(objectives.byStatus['completed'] ?? 0) > 0 && <Chip tone="good">{objectives.byStatus['completed']} completed</Chip>}
                {objectives.total === 0 && <span className="text-[10px] text-muted-foreground">No objectives planned</span>}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              <Metric label="Roster sync" value={status.timestamps.lastRosterSeen ? formatTime(status.timestamps.lastRosterSeen) : '—'} sub="last agent heartbeat" />
              <Metric label="Command update" value={status.timestamps.lastCommandUpdate ? formatTime(status.timestamps.lastCommandUpdate) : '—'} sub="last policy/state change" />
              <Metric label="Dispatch activity" value={status.timestamps.lastDelegation ? formatTime(status.timestamps.lastDelegation) : '—'} sub="last delegation attempt" />
            </div>
            {attentionWarns > 0 && (
              <div className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                {attentionWarns} additional attention item{attentionWarns === 1 ? '' : 's'} (escalated / needs-manual work). Open Project Command for the full delegation ledger and escalation queue.
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
