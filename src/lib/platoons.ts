import { detectAllRuntimes, getRuntimeCapabilities } from './agent-runtimes'
import type { RuntimeId } from './agent-runtimes'

export type PlatoonHealth = 'ready' | 'degraded' | 'offline'

export interface PlatoonRecord {
  id: RuntimeId
  name: string
  description: string
  commanderType: 'runtime-orchestrator'
  installed: boolean
  running: boolean
  authenticated: boolean
  authRequired: boolean
  version: string | null
  health: PlatoonHealth
  capabilities: ReturnType<typeof getRuntimeCapabilities>
}

function resolveHealth(runtime: {
  installed: boolean
  running: boolean
  authRequired: boolean
  authenticated: boolean
}): PlatoonHealth {
  if (!runtime.installed) return 'offline'
  if (!runtime.running) return 'degraded'
  if (runtime.authRequired && !runtime.authenticated) return 'degraded'
  return 'ready'
}

export function discoverPlatoons(): PlatoonRecord[] {
  return detectAllRuntimes().map((runtime) => ({
    id: runtime.id,
    name: runtime.name,
    description: runtime.description,
    commanderType: 'runtime-orchestrator' as const,
    installed: runtime.installed,
    running: runtime.running,
    authenticated: runtime.authenticated,
    authRequired: runtime.authRequired,
    version: runtime.version,
    health: resolveHealth(runtime),
    capabilities: getRuntimeCapabilities(runtime.id),
  }))
}
