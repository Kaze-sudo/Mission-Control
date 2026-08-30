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

export function PlatoonsPanel() {
  const [platoons, setPlatoons] = useState<PlatoonRuntime[]>([])
  const [agents, setAgents] = useState<RosterAgent[]>([])
  const [commanders, setCommanders] = useState<CommanderSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [platoonData, rosterData, commanderData] = await Promise.all([
        apiFetch<PlatoonResponse>('/api/platoons'),
        apiFetch<RosterResponse>('/api/roster'),
        apiFetch<CommanderResponse>('/api/platoon-commanders'),
      ])
      setPlatoons(platoonData.platoons || [])
      setAgents(rosterData.agents || [])
      setCommanders(commanderData.commanders || [])
    } catch {
      setError('Unable to discover CLI platoons.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

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
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-primary">Global Force Roster</p>
          <h2 className="text-xl font-semibold mt-1">Discovered Agents</h2>
          <p className="text-sm text-muted-foreground mt-1">
            AgentOS only lists real agent definitions here. Skills, project instruction files, and session history are not treated as agents.
          </p>
        </div>
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
