'use client'

import { useCallback, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { useNavigateToPanel, useNavigateToProjectCommand } from '@/lib/navigation'
import { useSmartPoll } from '@/lib/use-smart-poll'

/**
 * Agent Registry — the operational inventory of real AgentOS specialists.
 *
 * Renders live discovery/registration state grouped by CLI ecosystem /
 * host → orchestrator → agents. It deliberately separates persistent agent
 * identity (ecosystem, capabilities, runtime, cost class, dispatch path)
 * from transient workload (current project/task assignment) and never marks
 * an agent as dispatchable just because it was discovered: dispatch requires
 * a ready host/orchestrator, a registered dispatch row, and online status.
 */

interface RegistryAgent {
  externalAgentId: string
  name: string
  role: string
  ecosystem: string
  availability: 'available' | 'busy' | 'offline' | 'error'
  registered: boolean
  routingAgentName: string | null
  source: string
  isCommander: boolean
  capabilities: string[]
  capabilitySource: string
  provider: string | null
  model: string | null
  costClass: string | null
  dispatchable: boolean
  blockReason: string | null
  hostReady: boolean
  assignment: {
    projectId: number | null
    projectName: string | null
    taskId: number | null
    taskTitle: string | null
    taskStatus: string | null
  } | null
  performance: { tasks: number; completed: number; completionRate: number | null }
  lastSeen: number | null
  recentRuns: Array<{
    id: string
    taskId: number
    taskTitle: string
    projectId: number | null
    projectName: string | null
    state: string
    ecosystem: string | null
    attempt: number | null
    delegationStatus: string | null
    taskStatus: string
    errorMessage: string | null
    createdAt: number | null
    updatedAt: number | null
    completedAt: number | null
    durationSeconds: number | null
  }>
}

interface EcosystemStatus {
  id: string
  name: string
  hostReady: boolean
  hostHealth: string
  dispatchPath: string | null
  orchestrator: { name: string; available: boolean; blocked: boolean; blockReason: string | null } | null
  agents: RegistryAgent[]
}

interface RegistrySnapshot {
  asOf: number
  ecosystems: EcosystemStatus[]
  totals: { agents: number; dispatchable: number; registered: number; discoveredOnly: number; unavailable: number; ecosystems: number }
}

function formatTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return 'never'
  return new Date(unixSeconds * 1000).toLocaleString()
}

function healthTone(health: string): { tone: 'good' | 'warn' | 'bad' | 'neutral'; label: string } {
  switch (health) {
    case 'ready': return { tone: 'good', label: 'READY' }
    case 'degraded': return { tone: 'warn', label: 'DEGRADED' }
    case 'not-installed': return { tone: 'neutral', label: 'NOT INSTALLED' }
    default: return { tone: 'bad', label: 'OFFLINE' }
  }
}

function Chip({ tone = 'neutral', title, children }: { tone?: 'good' | 'warn' | 'bad' | 'neutral' | 'info'; title?: string; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    good: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    bad: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    info: 'bg-primary/10 text-primary border-primary/30',
    neutral: 'bg-secondary/60 text-muted-foreground border-border/60',
  }
  return <span title={title} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tones[tone]}`}>{children}</span>
}

function availabilityTone(availability: RegistryAgent['availability']): 'good' | 'warn' | 'bad' | 'neutral' {
  if (availability === 'available') return 'good'
  if (availability === 'busy') return 'warn'
  if (availability === 'error') return 'bad'
  return 'neutral'
}

function runStateTone(state: string): 'good' | 'warn' | 'bad' | 'neutral' | 'info' {
  switch (state) {
    case 'COMPLETED': return 'good'
    case 'RUNNING':
    case 'REVIEWING': return 'info'
    case 'QUEUED':
    case 'HELD':
    case 'WAITING':
    case 'RETRYING': return 'warn'
    case 'FAILED': return 'bad'
    default: return 'neutral'
  }
}

function fmtDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function AgentRegistryPanel() {
  const navigateToPanel = useNavigateToPanel()
  const navigateToProject = useNavigateToProjectCommand()
  const [registry, setRegistry] = useState<RegistrySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [ecosystemFilter, setEcosystemFilter] = useState('all')
  const [availabilityFilter, setAvailabilityFilter] = useState('all')
  const [dispatchableOnly, setDispatchableOnly] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{ registry?: RegistrySnapshot }>('/api/agentos/registry')
      setRegistry(data.registry || null)
      setError(null)
    } catch {
      setError('Agent registry unavailable — discovery may be failing on this station')
    } finally {
      setLoaded(true)
    }
  }, [])

  useSmartPoll(refresh, 60_000)

  const toggleExpanded = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const filteredEcosystems = useMemo(() => {
    if (!registry) return []
    const needle = search.trim().toLowerCase()
    return registry.ecosystems
      .map(ecosystem => {
        const agents = ecosystem.agents.filter(agent => {
          if (ecosystemFilter !== 'all' && agent.ecosystem !== ecosystemFilter) return false
          if (availabilityFilter !== 'all' && agent.availability !== availabilityFilter) return false
          if (dispatchableOnly && !agent.dispatchable) return false
          if (!needle) return true
          const haystack = [agent.name, agent.role, agent.routingAgentName, agent.provider, agent.model, agent.costClass, ...agent.capabilities].filter(Boolean).join(' ').toLowerCase()
          return haystack.includes(needle)
        })
        return { ...ecosystem, agents }
      })
      .filter(ecosystem => ecosystem.agents.length > 0)
  }, [availabilityFilter, dispatchableOnly, ecosystemFilter, registry, search])

  const totals = registry?.totals
  const allEcosystems = registry?.ecosystems ?? []

  if (!loaded && !registry) return null
  if (!registry) {
    return (
      <div className="p-4 md:p-6">
        <div className="rounded-xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          Agent registry unavailable{error ? ` — ${error}` : ''}.
          <div className="mt-3"><Button size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button></div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-primary">AgentOS · CLI Ecosystems</p>
          <h1 className="text-2xl font-semibold mt-1">Agent Registry</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Live specialists by CLI ecosystem. Being <span className="text-foreground/80">discovered</span> is not the same as being <span className="text-emerald-400">dispatchable</span>: dispatch needs a ready host/orchestrator, a registered dispatch row, and an online agent. Current assignments are workload, not identity.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground/70">Updated {formatTime(registry.asOf)}</span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>Refresh</Button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}

      {/* Totals */}
      <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Specialists" value={totals?.agents ?? 0} />
        <Metric label="Dispatchable now" value={totals?.dispatchable ?? 0} tone="good" />
        <Metric label="Registered" value={totals?.registered ?? 0} />
        <Metric label="Discovered only" value={totals?.discoveredOnly ?? 0} tone="warn" />
        <Metric label="Offline / error" value={totals?.unavailable ?? 0} tone={totals?.unavailable ? 'bad' : 'neutral'} />
        <Metric label="Ecosystems" value={totals?.ecosystems ?? 0} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search name, capability, runtime…"
          className="min-w-52 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        />
        <select value={ecosystemFilter} onChange={event => setEcosystemFilter(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-xs">
          <option value="all">All ecosystems</option>
          {allEcosystems.map(ecosystem => (
            <option key={ecosystem.id} value={ecosystem.id}>{ecosystem.name}</option>
          ))}
        </select>
        <select value={availabilityFilter} onChange={event => setAvailabilityFilter(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-xs">
          <option value="all">Any availability</option>
          <option value="available">Available</option>
          <option value="busy">Busy</option>
          <option value="offline">Offline</option>
          <option value="error">Error</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={dispatchableOnly} onChange={event => setDispatchableOnly(event.target.checked)} />
          Dispatchable only
        </label>
      </div>

      {/* Ecosystem sections */}
      {filteredEcosystems.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {registry.ecosystems.length === 0
            ? 'No external specialists discovered yet — AgentOS has not found agent definitions under any CLI ecosystem on this station.'
            : 'No specialists match the current filters.'}
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={() => navigateToPanel('platoons')}>Open Platoons</Button>
          </div>
        </div>
      )}

      {filteredEcosystems.map(ecosystem => {
        const health = healthTone(ecosystem.hostHealth)
        const dispatchable = ecosystem.agents.filter(agent => agent.dispatchable).length
        return (
          <section key={ecosystem.id} className="rounded-xl border border-border bg-card overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <div>
                  <p className="text-[10px] font-mono uppercase tracking-wider text-primary">CLI ecosystem / host</p>
                  <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                    {ecosystem.name}
                    <span className="font-mono text-[10px] font-normal text-muted-foreground">{ecosystem.id}</span>
                  </h2>
                </div>
                <Chip tone={health.tone} title={ecosystem.hostReady ? 'Host ready' : 'Host not ready for dispatch'}>{health.label}</Chip>
                {ecosystem.orchestrator?.blocked && (
                  <Chip tone="bad" title={ecosystem.orchestrator.blockReason || undefined}>
                    {ecosystem.orchestrator.name} blocked
                  </Chip>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                {ecosystem.dispatchPath && <span className="rounded bg-background/60 border border-border/50 px-1.5 py-0.5 font-mono" title="Executor path AgentOS uses">{ecosystem.dispatchPath}</span>}
                {ecosystem.orchestrator && <span className="rounded bg-background/60 border border-border/50 px-1.5 py-0.5" title="Orchestrator agent for this ecosystem">Orchestrator: {ecosystem.orchestrator.name}</span>}
                <span className="rounded bg-background/60 border border-border/50 px-1.5 py-0.5">{ecosystem.agents.length} specialists · {dispatchable} dispatchable</span>
              </div>
            </header>
            {ecosystem.orchestrator?.blockReason && ecosystem.orchestrator.blocked && (
              <div className="border-b border-border/40 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">
                {ecosystem.orchestrator.name} safety stop: {ecosystem.orchestrator.blockReason}
              </div>
            )}
            <div className="divide-y divide-border/40">
              {ecosystem.agents.map(agent => {
                const isOpen = expanded.has(agent.externalAgentId)
                return (
                  <div key={agent.externalAgentId} className="px-4">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(agent.externalAgentId)}
                      className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-left"
                      title={isOpen ? 'Collapse details' : 'Expand details'}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${agent.availability === 'available' ? 'bg-emerald-400' : agent.availability === 'busy' ? 'bg-amber-300' : agent.availability === 'error' ? 'bg-rose-400' : 'bg-muted-foreground/40'}`} />
                      <div className="min-w-0 w-56">
                        <div className="truncate text-sm font-medium text-foreground">
                          {agent.name}
                          {agent.isCommander && <span className="ml-1.5 text-[9px] uppercase text-primary">orchestrator</span>}
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground" title={agent.role}>{agent.role}</div>
                      </div>
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        {agent.capabilities.slice(0, 3).map(capability => (
                          <span key={capability} className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{capability}</span>
                        ))}
                        {agent.capabilities.length > 3 && <span className="text-[10px] text-muted-foreground">+{agent.capabilities.length - 3}</span>}
                        {agent.capabilities.length === 0 && <span className="text-[10px] text-muted-foreground">capabilities unrated</span>}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {agent.dispatchable ? (
                          <Chip tone="good" title={agent.blockReason ?? undefined}>dispatchable</Chip>
                        ) : (
                          <Chip tone={agent.registered ? 'bad' : 'warn'} title={agent.blockReason ?? undefined}>
                            {agent.blockReason?.includes('Reconcile') ? 'reconcile needed' : agent.availability === 'offline' || agent.availability === 'error' ? agent.availability : 'not dispatchable'}
                          </Chip>
                        )}
                        <Chip tone={availabilityTone(agent.availability)}>{agent.availability}</Chip>
                        <span className="text-muted-foreground/50">{isOpen ? '▲' : '▼'}</span>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="grid gap-3 pb-3 md:grid-cols-2 xl:grid-cols-4 text-xs">
                        <div className="rounded-lg border border-border/40 bg-background/30 p-2.5">
                          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Identity</div>
                          <div className="mt-1 font-mono text-[10px] text-foreground/80 break-all">{agent.externalAgentId}</div>
                          <div className="mt-1 text-muted-foreground">Ecosystem {agent.ecosystem} · {agent.source === 'mission-control' ? 'Mission Control row' : 'filesystem definition'}</div>
                          {agent.routingAgentName && <div className="mt-1 text-muted-foreground">Route name: <span className="font-mono text-[10px]">{agent.routingAgentName}</span></div>}
                          {agent.lastSeen !== null && agent.lastSeen !== undefined && <div className="mt-1 text-muted-foreground">Last seen {formatTime(agent.lastSeen)}</div>}
                        </div>
                        <div className="rounded-lg border border-border/40 bg-background/30 p-2.5">
                          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Capabilities ({agent.capabilities.length})</div>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {agent.capabilities.length > 0 ? agent.capabilities.map(capability => (
                              <span key={capability} className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{capability}</span>
                            )) : <span className="text-muted-foreground">Not rated</span>}
                          </div>
                          <div className="mt-1 text-[9px] uppercase text-muted-foreground/60">Source: {agent.capabilitySource}</div>
                        </div>
                        <div className="rounded-lg border border-border/40 bg-background/30 p-2.5">
                          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Runtime · cost</div>
                          <div className="mt-1 space-y-1">
                            <div>Provider: <span className="font-mono text-[10px]">{agent.provider || 'not declared'}</span></div>
                            <div>Model: <span className="font-mono text-[10px]">{agent.model || 'inherits host'}</span></div>
                            <div>Cost class: <span className="font-mono text-[10px]">{agent.costClass || 'unclassified'}</span></div>
                            {ecosystem.dispatchPath && <div className="text-muted-foreground">Path: {ecosystem.dispatchPath}</div>}
                          </div>
                          {agent.performance.tasks > 0 && <div className="mt-1 text-muted-foreground">{agent.performance.completed}/{agent.performance.tasks} tasks completed</div>}
                        </div>
                        <div className="rounded-lg border border-border/40 bg-background/30 p-2.5">
                          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Current workload</div>
                          {agent.assignment ? (
                            <div className="mt-1 space-y-1">
                              <div>
                                Project:{' '}
                                {agent.assignment.projectId !== null && agent.assignment.projectId !== undefined ? (
                                  <button
                                    type="button"
                                    onClick={() => agent.assignment!.projectId !== null && agent.assignment!.projectId !== undefined && navigateToProject(agent.assignment!.projectId)}
                                    className="cursor-pointer text-primary underline-offset-2 hover:underline"
                                  >
                                    {agent.assignment.projectName || `#${agent.assignment.projectId}`}
                                  </button>
                                ) : (
                                  <span>{agent.assignment.projectName || 'none'}</span>
                                )}
                              </div>
                              {agent.assignment.taskId !== null && (
                                <div className="text-muted-foreground">Task #{agent.assignment.taskId} · {agent.assignment.taskStatus}: {agent.assignment.taskTitle}</div>
                              )}
                              <div className="text-[9px] uppercase text-muted-foreground/60">temporary assignment — not identity</div>
                            </div>
                          ) : (
                            <div className="mt-1 text-muted-foreground">Idle — no active assignment</div>
                          )}
                          {agent.blockReason && (
                            <div className={`mt-1.5 rounded border px-2 py-1 text-[10px] ${agent.dispatchable ? 'border-emerald-500/30 text-emerald-400' : 'border-amber-500/30 bg-amber-500/5 text-amber-200'}`}>
                              {agent.blockReason}
                            </div>
                          )}
                        </div>
                        <div className="md:col-span-2 xl:col-span-4 rounded-lg border border-border/40 bg-background/30 p-2.5">
                          <div className="flex items-center justify-between">
                            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Recent executions (canonical run ledger)</div>
                            {agent.recentRuns.length > 0 && <span className="text-[9px] text-muted-foreground">newest {agent.recentRuns.length} shown</span>}
                          </div>
                          {agent.recentRuns.length === 0 ? (
                            <div className="mt-1.5 text-muted-foreground">No executions traced for this agent yet.</div>
                          ) : (
                            <div className="mt-1.5 space-y-1">
                              {agent.recentRuns.map(run => (
                                <div key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded border border-border/40 bg-background/40 px-2 py-1">
                                  <Chip tone={runStateTone(run.state)}>{run.state}</Chip>
                                  <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/85" title={`Task #${run.taskId}: ${run.taskTitle}`}>
                                    Task #{run.taskId} · {run.taskTitle}
                                  </span>
                                  {run.projectId !== null && run.projectId !== undefined ? (
                                    <button
                                      type="button"
                                      onClick={() => navigateToProject(run.projectId!)}
                                      className="cursor-pointer text-[10px] text-primary underline-offset-2 hover:underline"
                                    >
                                      {run.projectName || `#${run.projectId}`}
                                    </button>
                                  ) : <span className="text-[10px] text-muted-foreground">no project</span>}
                                  {run.ecosystem && <span className="text-[10px] text-muted-foreground">{run.ecosystem}</span>}
                                  <span className="text-[10px] text-muted-foreground">{fmtDuration(run.durationSeconds)}</span>
                                  <span className="text-[10px] text-muted-foreground">{formatTime(run.updatedAt)}</span>
                                  {run.state === 'FAILED' && run.errorMessage && (
                                    <span className="w-full truncate text-[10px] text-rose-400/90" title={run.errorMessage}>{run.errorMessage}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: React.ReactNode; tone?: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const tones: Record<string, string> = { good: 'text-emerald-400', warn: 'text-amber-300', bad: 'text-rose-400', neutral: 'text-foreground' }
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold leading-tight mt-0.5 ${tones[tone]}`}>{value}</div>
    </div>
  )
}
