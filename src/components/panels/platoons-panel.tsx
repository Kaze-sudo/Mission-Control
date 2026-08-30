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

export function PlatoonsPanel() {
  const [platoons, setPlatoons] = useState<PlatoonRuntime[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<PlatoonResponse>('/api/platoons')
      setPlatoons(data.platoons || [])
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
          const ready = platoon.installed && platoon.running && (!platoon.authRequired || platoon.authenticated)
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
                <Metric label="Version" value={platoon.version || 'Unknown'} />
                <Metric label="Installed" value={platoon.installed ? 'Yes' : 'No'} />
                <Metric label="Auth" value={!platoon.authRequired ? 'Not required' : platoon.authenticated ? 'Ready' : 'Required'} />
              </div>
            </div>
          )
        })}
      </div>

      {!loading && platoons.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No CLI runtimes were discovered on this station.
        </div>
      )}

      <div className="rounded-xl border border-border bg-card/60 p-4 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Next layer:</span> platoon commander adapters, agent roster discovery, capability bids, and cross-CLI mission assignment. Gamut will be added after its filesystem configuration is repaired and its runtime contract is inspected.
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
