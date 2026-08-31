'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'

interface PlatoonRuntime {
  id: string
  name: string
  description: string
  installed: boolean
  version: string | null
  running: boolean
  authRequired: boolean
  authenticated: boolean
  capabilities?: Record<string, unknown>
}

interface PlatoonResponse {
  platoons?: PlatoonRuntime[]
}

interface RosterAgent {
  id: string
  name: string
  platoonId: string
  role: string
  archetype: string
  availability: 'available' | 'busy' | 'offline' | 'error'
  source: 'mission-control' | 'filesystem'
  capabilities: { tags: string[]; source: 'declared' | 'inferred' | 'unrated' }
  performance: { tasks: number; completed: number; completionRate: number | null }
}

interface RosterResponse {
  agents?: RosterAgent[]
}

interface CommanderSnapshot {
  platoonId: string
  commanderName: string
  commanderAvailable: boolean
  blocked: boolean
  blockReason: string | null
  inventoryMode: 'native-profiles' | 'config-profiles' | 'runtime-only'
  agents: Array<{ id: string; name: string; isCommander: boolean }>
  notes: string[]
}

interface CommanderResponse {
  commanders?: CommanderSnapshot[]
}

interface ProjectSummary {
  id: number
  name: string
  slug: string
}

interface ProjectResponse {
  projects?: ProjectSummary[]
}

interface ExternalBinding {
  id: number
  projectId: number
  platoonId: string
  externalAgentId: string
  agentName: string
  role: string
  capabilities: string[]
  availability: string
}

interface BindingResponse {
  bindings?: ExternalBinding[]
}

interface ForcePlan {
  profile: {
    requiredCapabilities: string[]
    preferredCapabilities: string[]
    preferredPlatoons: string[]
    maxTeamSize: number | null
  }
  coverage: Array<{ capability: string; covered: boolean; ready: boolean; agents: Array<{ id: string; name: string; platoonId: string; availability: string }> }>
  missingCapabilities: string[]
  blockedCapabilities: string[]
  recommendations: Array<{ capability: string; externalAgentId: string; name: string; platoonId: string; score: number; availability: string; reasons: string[] }>
  readiness: { required: number; ready: number; percent: number; status: string }
}

export function PlatoonsPanel() {
  const [platoons, setPlatoons] = useState<PlatoonRuntime[]>([])
  const [agents, setAgents] = useState<RosterAgent[]>([])
  const [commanders, setCommanders] = useState<CommanderSnapshot[]>([])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [bindings, setBindings] = useState<ExternalBinding[]>([])
  const [forcePlan, setForcePlan] = useState<ForcePlan | null>(null)
  const [forceRequired, setForceRequired] = useState('')
  const [forcePreferred, setForcePreferred] = useState('')
  const [forcePlatoons, setForcePlatoons] = useState('')
  const [forceSaving, setForceSaving] = useState(false)
  const [bindingBusy, setBindingBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [platoonData, rosterData, commanderData, projectData] = await Promise.all([
        apiFetch<PlatoonResponse>('/api/platoons'),
        apiFetch<RosterResponse>('/api/roster'),
        apiFetch<CommanderResponse>('/api/platoon-commanders'),
        apiFetch<ProjectResponse>('/api/projects'),
      ])
      setPlatoons(platoonData.platoons || [])
      setAgents(rosterData.agents || [])
      setCommanders(commanderData.commanders || [])
      const nextProjects = projectData.projects || []
      setProjects(nextProjects)
      setSelectedProjectId(current => current ?? nextProjects[0]?.id ?? null)
    } catch {
      setError('Unable to discover CLI platoons.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const refreshProjectContext = useCallback(async (projectId: number | null) => {
    if (!projectId) { setBindings([]); setForcePlan(null); return }
    try {
      const [bindingData, planData] = await Promise.all([
        apiFetch<BindingResponse>(`/api/projects/${projectId}/external-agents`),
        apiFetch<ForcePlan>(`/api/projects/${projectId}/agentos-force-plan`),
      ])
      setBindings(bindingData.bindings || [])
      setForcePlan(planData)
      setForceRequired(planData.profile.requiredCapabilities.join(', '))
      setForcePreferred(planData.profile.preferredCapabilities.join(', '))
      setForcePlatoons(planData.profile.preferredPlatoons.join(', '))
    } catch {
      setBindings([])
      setForcePlan(null)
    }
  }, [])

  useEffect(() => { void refreshProjectContext(selectedProjectId) }, [refreshProjectContext, selectedProjectId])

  const saveForcePlan = useCallback(async () => {
    if (!selectedProjectId) return
    const csv = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean)
    setForceSaving(true)
    setError(null)
    try {
      const plan = await apiFetch<ForcePlan>(`/api/projects/${selectedProjectId}/agentos-force-plan`, {
        method: 'PUT',
        body: JSON.stringify({
          requiredCapabilities: csv(forceRequired),
          preferredCapabilities: csv(forcePreferred),
          preferredPlatoons: csv(forcePlatoons),
          maxTeamSize: forcePlan?.profile.maxTeamSize ?? null,
        }),
      })
      setForcePlan(plan)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save AgentOS force plan.')
    } finally {
      setForceSaving(false)
    }
  }, [forcePlan?.profile.maxTeamSize, forcePlatoons, forcePreferred, forceRequired, selectedProjectId])

  const toggleBinding = useCallback(async (agent: RosterAgent) => {
    if (!selectedProjectId) return
    const existing = bindings.find(binding => binding.externalAgentId === agent.id)
    setBindingBusy(agent.id)
    setError(null)
    try {
      if (existing) {
        await apiFetch(`/api/projects/${selectedProjectId}/external-agents?bindingId=${existing.id}`, { method: 'DELETE' })
      } else {
        await apiFetch(`/api/projects/${selectedProjectId}/external-agents`, {
          method: 'POST',
          body: JSON.stringify({ externalAgentId: agent.id, role: agent.role }),
        })
      }
      await refreshProjectContext(selectedProjectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update project agent binding.')
    } finally {
      setBindingBusy(null)
    }
  }, [bindings, refreshProjectContext, selectedProjectId])

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-primary">AgentOS Command Structure</p>
          <h1 className="text-2xl font-semibold mt-1">Platoons</h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-3xl">
            Each CLI runtime is a platoon boundary. AgentOS will query its platoon commander, discover available agents and capabilities, then route missions to the best-qualified force.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>Refresh</Button>
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {platoons.map((platoon) => {
          const commander = commanders.find(item => item.platoonId === platoon.id)
          const runtimeReady = platoon.installed && platoon.running && (!platoon.authRequired || platoon.authenticated)
          const ready = commander ? commander.commanderAvailable && !commander.blocked : runtimeReady
          return (
            <div key={platoon.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{platoon.name}</h2>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">{platoon.id}</p>
                </div>
                <span className={`text-xs rounded-full px-2 py-1 ${ready ? 'bg-emerald-500/15 text-emerald-400' : platoon.installed ? 'bg-amber-500/15 text-amber-400' : 'bg-muted text-muted-foreground'}`}>
                  {ready ? 'READY' : platoon.installed ? 'DEGRADED' : 'NOT INSTALLED'}
                </span>
              </div>
              <p className="text-sm text-muted-foreground mt-3 min-h-10">{platoon.description}</p>
              <div className="grid grid-cols-2 gap-2 mt-4 text-xs">
                <Metric label="Runtime" value={platoon.running ? 'Running' : 'Stopped'} />
                <Metric label="Commander" value={commander?.commanderName || 'Runtime native'} />
                <Metric label="Version" value={platoon.version || 'Unknown'} />
                <Metric label="Agents" value={commander ? String(commander.agents.length) : '—'} />
                <Metric label="Installed" value={platoon.installed ? 'Yes' : 'No'} />
                <Metric label="Auth" value={!platoon.authRequired ? 'Not required' : platoon.authenticated ? 'Ready' : 'Required'} />
              </div>
              {commander?.blocked && (
                <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Dispatch blocked by platoon commander safety stop.
                </div>
              )}
            </div>
          )
        })}
      </div>

      {!loading && platoons.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No CLI runtimes were discovered on this station.
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.18em] text-primary">Global Force Roster</p>
            <h2 className="text-xl font-semibold mt-1">Discovered Agents</h2>
            <p className="text-sm text-muted-foreground mt-1">
              AgentOS only lists real agent definitions here. Skills, project instruction files, and session history are not treated as agents.
            </p>
          </div>
          <label className="text-xs text-muted-foreground min-w-56">
            Project assignment
            <select
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              value={selectedProjectId ?? ''}
              onChange={event => setSelectedProjectId(event.target.value ? Number(event.target.value) : null)}
            >
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
        </div>

        {selectedProjectId && (
          <div className="rounded-xl border border-border bg-card/70 p-4 space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-mono uppercase tracking-[0.18em] text-primary">Company Commander Force Plan</p>
                <h3 className="text-lg font-semibold mt-1">Project capability coverage</h3>
                <p className="text-xs text-muted-foreground mt-1">Define what this project needs. AgentOS measures the bound team and recommends available agents to close gaps.</p>
              </div>
              {forcePlan && (
                <div className="min-w-32 rounded-lg bg-secondary/50 px-3 py-2 text-center">
                  <div className="text-2xl font-semibold">{forcePlan.readiness.percent}%</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Ready coverage</div>
                </div>
              )}
            </div>

            <div className="grid gap-2 md:grid-cols-3">
              <input value={forceRequired} onChange={e => setForceRequired(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Required: backend, security, testing-review" />
              <input value={forcePreferred} onChange={e => setForcePreferred(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Preferred capabilities" />
              <input value={forcePlatoons} onChange={e => setForcePlatoons(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Preferred platoons: codex, hermes" />
            </div>
            <Button size="sm" onClick={() => void saveForcePlan()} disabled={forceSaving}>{forceSaving ? 'Saving…' : 'Save Force Plan'}</Button>

            {forcePlan && forcePlan.coverage.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Required capability coverage</div>
                <div className="flex flex-wrap gap-2">
                  {forcePlan.coverage.map(item => (
                    <span key={item.capability} className={`text-xs rounded-md px-2.5 py-1.5 ${item.ready ? 'bg-emerald-500/15 text-emerald-400' : item.covered ? 'bg-amber-500/15 text-amber-400' : 'bg-destructive/10 text-destructive'}`}>
                      {item.capability} · {item.ready ? 'READY' : item.covered ? 'BLOCKED' : 'GAP'}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {forcePlan && forcePlan.recommendations.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Recommended reinforcements</div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {forcePlan.recommendations.map(rec => {
                    const candidate = agents.find(agent => agent.id === rec.externalAgentId)
                    return (
                      <div key={`${rec.capability}-${rec.externalAgentId}`} className="rounded-lg border border-border/60 bg-background/50 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div><div className="text-sm font-medium">{rec.name}</div><div className="text-[10px] text-muted-foreground">{rec.platoonId} · covers {rec.capability}</div></div>
                          <span className="text-xs font-mono text-primary">{rec.score}</span>
                        </div>
                        <Button className="mt-2 w-full" size="sm" variant="outline" disabled={!candidate || bindingBusy === rec.externalAgentId} onClick={() => candidate && void toggleBinding(candidate)}>
                          Add to Project
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.map(agent => (
            <div key={agent.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{agent.name}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{agent.role}</p>
                </div>
                <span className="text-xs rounded-full px-2 py-1 bg-secondary text-secondary-foreground">
                  {agent.platoonId}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {agent.capabilities.tags.length > 0 ? agent.capabilities.tags.map(tag => (
                  <span key={tag} className="text-[11px] rounded-md bg-primary/10 text-primary px-2 py-1">{tag}</span>
                )) : (
                  <span className="text-xs text-muted-foreground">Capabilities not rated yet</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-4 text-xs">
                <Metric label="Availability" value={agent.availability} />
                <Metric label="Archetype" value={agent.archetype} />
                <Metric label="Source" value={agent.source} />
                <Metric label="Tasks" value={agent.performance.tasks ? `${agent.performance.completed}/${agent.performance.tasks}` : 'No history'} />
              </div>
              <Button
                className="mt-3 w-full"
                variant={bindings.some(binding => binding.externalAgentId === agent.id) ? 'outline' : 'default'}
                size="sm"
                disabled={!selectedProjectId || bindingBusy === agent.id}
                onClick={() => void toggleBinding(agent)}
              >
                {bindings.some(binding => binding.externalAgentId === agent.id) ? 'Remove from Project' : 'Assign to Project'}
              </Button>
            </div>
          ))}
        </div>
        {!loading && agents.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No agent definitions discovered yet. Platoon runtimes can still be online while their agent rosters are empty.
          </div>
        )}
      </section>

      <div className="rounded-xl border border-border bg-card/60 p-4 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Next layer:</span> capability bids, guarded cross-CLI mission assignment, and project-level team assembly. Gamut will be added after its filesystem configuration is repaired and its runtime contract is inspected.
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-secondary/50 px-2.5 py-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-foreground mt-0.5 truncate">{value}</div>
    </div>
  )
}
