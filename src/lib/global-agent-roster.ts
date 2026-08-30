import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDatabase } from './db'
import { discoverPlatoons } from './platoons'

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

const CAPABILITY_KEYWORDS: Array<[RegExp, string]> = [
  [/architect|system design/i, 'architecture'],
  [/backend|api|server/i, 'backend'],
  [/database|postgres|sql|data/i, 'data'],
  [/frontend|react|web/i, 'frontend'],
  [/ui|ux|design/i, 'ui-ux'],
  [/security|audit|hardening/i, 'security'],
  [/test|qa|review|verif/i, 'testing-review'],
  [/research|analysis/i, 'research'],
  [/devops|docker|deploy|infra/i, 'devops'],
  [/unity|gameplay|game/i, 'game-development'],
  [/construct|estimat/i, 'construction-estimating'],
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
    ['hermes', path.join(home, '.hermes', 'profiles')],
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

export function getGlobalAgentRoster(workspaceId: number): GlobalRosterAgent[] {
  const db = getDatabase()
  const platoonReady = new Map(discoverPlatoons().map(p => [p.id, p.health === 'ready']))
  const dbAgents = db.prepare(
    'SELECT id, name, role, status, config, runtime_type, workspace_path FROM agents WHERE workspace_id = ? AND hidden = 0'
  ).all(workspaceId) as DbAgentRow[]

  const taskRows = db.prepare(
    `SELECT assigned_to, COUNT(*) total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) completed
     FROM tasks WHERE workspace_id = ? AND assigned_to IS NOT NULL GROUP BY assigned_to`
  ).all(workspaceId) as Array<{ assigned_to: string; total: number; completed: number }>
  const taskMap = new Map(taskRows.map(row => [row.assigned_to, row]))
  const roster = new Map<string, GlobalRosterAgent>()

  for (const agent of dbAgents) {
    const config = parseConfig(agent.config)
    const platoonId = agent.runtime_type || 'unassigned'
    const task = taskMap.get(agent.name)
    roster.set(`${platoonId}:${agent.name.toLowerCase()}`, {
      id: `mc:${agent.id}`, name: agent.name, platoonId, role: agent.role,
      archetype: agent.role || 'Generalist',
      availability: normalizeAvailability(agent.status, platoonReady.get(platoonId as never) === true),
      definitionPath: agent.workspace_path, source: 'mission-control',
      capabilities: capabilitiesFor(agent.role, config),
      performance: { tasks: task?.total || 0, completed: task?.completed || 0,
        completionRate: task?.total ? Math.round((task.completed / task.total) * 100) : null },
    })
  }

  for (const discovered of discoverFilesystemAgents()) {
    const key = `${discovered.platoonId}:${discovered.name.toLowerCase()}`
    if (roster.has(key)) continue
    const roleMatch = discovered.identity.match(/^(?:role|description)\s*:\s*(.+)$/im)
    const role = roleMatch?.[1]?.trim() || (discovered.name === 'main' ? 'Platoon Commander' : 'Agent')
    roster.set(key, {
      id: `fs:${discovered.platoonId}:${discovered.name}`, name: discovered.name,
      platoonId: discovered.platoonId, role, archetype: role,
      availability: normalizeAvailability(undefined, platoonReady.get(discovered.platoonId as never) === true),
      definitionPath: discovered.definitionPath, source: 'filesystem',
      capabilities: capabilitiesFor(role, {}, discovered.identity),
      performance: { tasks: 0, completed: 0, completionRate: null },
    })
  }

  return [...roster.values()].sort((a, b) =>
    a.platoonId.localeCompare(b.platoonId) || a.name.localeCompare(b.name)
  )
}
