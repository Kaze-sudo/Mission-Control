import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDatabase } from './db'
import { discoverPlatoons } from './platoons'
import { discoverPlatoonCommanders } from './platoon-commanders'

export type RosterAvailability = 'available' | 'busy' | 'offline' | 'error'

export interface CapabilityProfile {
  tags: string[]
  source: 'declared' | 'inferred' | 'unrated'
}

export interface GlobalRosterAgent {
  id: string
  name: string
  platoonId: string
  role: string
  archetype: string
  availability: RosterAvailability
  definitionPath: string | null
  source: 'mission-control' | 'filesystem'
  capabilities: CapabilityProfile
  performance: { tasks: number; completed: number; completionRate: number | null }
}

interface DbAgentRow {
  id: number
  name: string
  role: string
  status: string
  config: string | null
  runtime_type: string | null
  workspace_path: string | null
}

interface DiscoveryCacheEntry {
  at: number
  platoons: ReturnType<typeof discoverPlatoons>
  commanders: ReturnType<typeof discoverPlatoonCommanders>
}

let discoveryCache: DiscoveryCacheEntry | null = null

function discoveryCacheMs(): number {
  const raw = Number(process.env.AGENTOS_DISCOVERY_CACHE_MS || 5000)
  return Number.isFinite(raw) ? Math.max(0, Math.min(60000, Math.trunc(raw))) : 5000
}

function getDiscoverySnapshot(): DiscoveryCacheEntry {
  const now = Date.now()
  const ttl = discoveryCacheMs()
  if (discoveryCache && ttl > 0 && now - discoveryCache.at < ttl) return discoveryCache
  discoveryCache = { at: now, platoons: discoverPlatoons(), commanders: discoverPlatoonCommanders() }
  return discoveryCache
}

export function invalidateAgentDiscoveryCache(): void {
  discoveryCache = null
}

const CAPABILITY_KEYWORDS: Array<[RegExp, string]> = [
  [/orchestrat|delegat|worker assignment|kanban coordination/i, 'orchestration'],
  [/architect|system design/i, 'architecture'],
  [/backend|api|server action/i, 'backend'],
  [/database|postgres|prisma|sql|rls/i, 'data'],
  [/frontend|react|web interface/i, 'frontend'],
  [/\bui\b|\bux\b|responsive|touch interaction/i, 'ui-ux'],
  [/security|authorization|authentication|tenant isolation|secrets/i, 'security'],
  [/test|\bqa\b|review|verif|playwright|vitest|acceptance/i, 'testing-review'],
  [/research|analysis/i, 'research'],
  [/devops|docker|infrastructure/i, 'devops'],
  [/ci\/cd|deployment|release|vercel|production smoke/i, 'release-engineering'],
  [/mobile|tablet|jobsite|field capture|inspection|camera-oriented/i, 'field-operations'],
  [/unity|gameplay|game systems/i, 'game-development'],
  [/game director|systems designer|design pillars|game vision/i, 'game-direction'],
  [/combat gameplay|attacks|melee|beam|guard|parry|counter|hitstun|knockback|clash/i, 'combat-systems'],
  [/tactical battles|encounter|battlefield|action economy|terrain|hazards|enemy placement/i, 'tactical-encounters'],
  [/enemy ai|boss engineer|decision-making|aggression|boss phases|behavior/i, 'enemy-ai'],
  [/progression|transformation|stats|experience|unlocks|loadouts|ki\/stamina/i, 'progression-transformations'],
  [/narrative|world|quest|dialogue|story|lore|content design/i, 'narrative-content'],
  [/art|animation|technical art|sprite|shader|rig|animator/i, 'art-animation'],
  [/vfx|camera|cinematic|combat presentation|screen shake|post-processing/i, 'vfx-camera'],
  [/audio|music|sound|sfx|voice|mixing/i, 'audio'],
  [/accessibility|input|remap|controller|keyboard\/mouse|hud|menu navigation/i, 'ui-input-accessibility'],
  [/save|serialization|persistence|migration|developer tools|content data|catalog/i, 'save-data-tools'],
  [/performance|profil|optimization|frame time|memory|platform/i, 'performance-platform'],
  [/repository|git|build reproducibility|continuous integration|github actions|unity metadata|\.meta/i, 'build-repository'],
  [/multiplayer|network|online|netcode|authority|replication/i, 'multiplayer-networking'],
  [/playtest|release verification|quality assurance|regression|acceptance/i, 'qa-release'],
  [/estimating|takeoff|pricebook|xactimate|freebuff|material quantities/i, 'construction-estimating'],
  [/deep review|resource review|arsenal|registry audit|resource audit|curator/i, 'resource-deep-review'],
  [/jobs|clients|schedules|crews|subcontractors|suppliers|job packets/i, 'construction-operations'],
  [/document|docs|writer/i, 'documentation'],
]

function parseConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function capabilitiesFor(role: string, config: Record<string, unknown>, identity = ''): CapabilityProfile {
  const agentos = config.agentos && typeof config.agentos === 'object'
    ? config.agentos as Record<string, unknown>
    : null
  const declared = agentos?.capabilities ?? config.capabilities
  if (Array.isArray(declared)) {
    const tags = declared.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (tags.length > 0) return { tags: [...new Set(tags.map(tag => tag.trim().toLowerCase()))], source: 'declared' }
  }

  const haystack = `${role}\n${identity}`
  const tags = CAPABILITY_KEYWORDS.filter(([pattern]) => pattern.test(haystack)).map(([, tag]) => tag)
  return tags.length > 0 ? { tags: [...new Set(tags)], source: 'inferred' } : { tags: [], source: 'unrated' }
}

function readIdentity(agentPath: string): string {
  const candidates = ['AGENT.md', 'agent.md', 'SOUL.md', 'soul.md', 'identity.md']
  for (const file of candidates) {
    const fullPath = path.join(agentPath, file)
    if (!existsSync(fullPath)) continue
    try { return readFileSync(fullPath, 'utf8').slice(0, 12000) } catch { /* ignore unreadable identity */ }
  }
  return ''
}

function discoverFilesystemAgents(): Array<{ name: string; platoonId: string; definitionPath: string; identity: string }> {
  const home = os.homedir()
  const roots: Array<[string, string]> = [
    ['openclaw', path.join(home, '.openclaw', 'agents')],
    ['codex', path.join(home, '.codex', 'agents')],
    ['claude', path.join(home, '.claude', 'agents')],
    ['generic', path.join(home, '.agents')],
  ]
  const results: Array<{ name: string; platoonId: string; definitionPath: string; identity: string }> = []

  for (const [platoonId, root] of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      if (entry === 'skills') continue
      const fullPath = path.join(root, entry)
      let stat
      try { stat = statSync(fullPath) } catch { continue }
      if (!stat.isDirectory()) continue

      // OpenClaw agent directories are authoritative even without markdown identity files.
      const identity = readIdentity(fullPath)
      const hasDefinition = platoonId === 'openclaw' || identity.length > 0 || existsSync(path.join(fullPath, 'config.json'))
      if (!hasDefinition) continue
      results.push({ name: entry, platoonId, definitionPath: fullPath, identity })
    }
  }
  return results
}

function normalizeAvailability(status: string | undefined, platoonReady: boolean): RosterAvailability {
  if (!platoonReady) return 'offline'
  if (status === 'busy') return 'busy'
  if (status === 'error') return 'error'
  if (status === 'offline') return 'offline'
  return 'available'
}

function loadExternalPerformance(db: ReturnType<typeof getDatabase>, workspaceId: number) {
  const rows = db.prepare(`
    SELECT a.config, COUNT(t.id) total,
           SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) completed
    FROM agents a
    LEFT JOIN tasks t ON t.workspace_id = a.workspace_id AND t.assigned_to = a.name
    WHERE a.workspace_id = ? AND a.source = 'agentos-external'
    GROUP BY a.id, a.config
  `).all(workspaceId) as Array<{ config: string | null; total: number; completed: number | null }>

  const result = new Map<string, { tasks: number; completed: number; completionRate: number | null }>()
  for (const row of rows) {
    const config = parseConfig(row.config)
    const agentos = config.agentos && typeof config.agentos === 'object'
      ? config.agentos as Record<string, unknown>
      : null
    const externalAgentId = typeof agentos?.externalAgentId === 'string' ? agentos.externalAgentId : null
    if (!externalAgentId) continue
    const completed = row.completed || 0
    result.set(externalAgentId, {
      tasks: row.total || 0,
      completed,
      completionRate: row.total ? Math.round((completed / row.total) * 100) : null,
    })
  }
  return result
}

export function getGlobalAgentRoster(workspaceId: number): GlobalRosterAgent[] {
  const db = getDatabase()
  const discovery = getDiscoverySnapshot()
  const platoonReady = new Map<string, boolean>(discovery.platoons.map(p => [p.id, p.health === 'ready']))
  const commanderSnapshots = discovery.commanders
  for (const snapshot of commanderSnapshots) {
    if (snapshot.commanderAvailable) platoonReady.set(snapshot.platoonId, true)
  }
  const dbAgents = db.prepare(
    'SELECT id, name, role, status, config, runtime_type, workspace_path FROM agents WHERE workspace_id = ? AND hidden = 0'
  ).all(workspaceId) as DbAgentRow[]

  const taskRows = db.prepare(
    `SELECT assigned_to, COUNT(*) total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) completed
     FROM tasks WHERE workspace_id = ? AND assigned_to IS NOT NULL GROUP BY assigned_to`
  ).all(workspaceId) as Array<{ assigned_to: string; total: number; completed: number }>
  const taskMap = new Map(taskRows.map(row => [row.assigned_to, row]))
  const externalPerformance = loadExternalPerformance(db, workspaceId)
  const roster = new Map<string, GlobalRosterAgent>()

  for (const agent of dbAgents) {
    const config = parseConfig(agent.config)
    const platoonId = agent.runtime_type || 'unassigned'
    const task = taskMap.get(agent.name)
    roster.set(`${platoonId}:${agent.name.toLowerCase()}`, {
      id: `mc:${agent.id}`, name: agent.name, platoonId, role: agent.role,
      archetype: agent.role || 'Generalist',
      availability: normalizeAvailability(agent.status, platoonReady.get(platoonId) === true),
      definitionPath: agent.workspace_path, source: 'mission-control',
      capabilities: capabilitiesFor(agent.role, config),
      performance: { tasks: task?.total || 0, completed: task?.completed || 0,
        completionRate: task?.total ? Math.round((task.completed / task.total) * 100) : null },
    })
  }

  for (const snapshot of commanderSnapshots) {
    for (const discovered of snapshot.agents) {
      const key = `${snapshot.platoonId}:${discovered.name.toLowerCase()}`
      if (roster.has(key)) continue
      const role = discovered.role || (discovered.isCommander ? 'Platoon Commander' : 'Agent')
      roster.set(key, {
        id: `pc:${discovered.id}`, name: discovered.name,
        platoonId: snapshot.platoonId, role, archetype: role,
        availability: normalizeAvailability(undefined, snapshot.commanderAvailable),
        definitionPath: discovered.definitionPath, source: 'filesystem',
        capabilities: capabilitiesFor(role, {}, discovered.identity),
        performance: externalPerformance.get(`pc:${discovered.id}`) || { tasks: 0, completed: 0, completionRate: null },
      })
    }
  }

  for (const discovered of discoverFilesystemAgents()) {
    const key = `${discovered.platoonId}:${discovered.name.toLowerCase()}`
    if (roster.has(key)) continue
    const roleMatch = discovered.identity.match(/^(?:role|description)\s*:\s*(.+)$/im)
    const role = roleMatch?.[1]?.trim() || (discovered.name === 'main' ? 'Platoon Commander' : 'Agent')
    roster.set(key, {
      id: `fs:${discovered.platoonId}:${discovered.name}`, name: discovered.name,
      platoonId: discovered.platoonId, role, archetype: role,
      availability: normalizeAvailability(undefined, platoonReady.get(discovered.platoonId) === true),
      definitionPath: discovered.definitionPath, source: 'filesystem',
      capabilities: capabilitiesFor(role, {}, discovered.identity),
      performance: externalPerformance.get(`fs:${discovered.platoonId}:${discovered.name}`) || { tasks: 0, completed: 0, completionRate: null },
    })
  }

  return [...roster.values()].sort((a, b) =>
    a.platoonId.localeCompare(b.platoonId) || a.name.localeCompare(b.name)
  )
}
