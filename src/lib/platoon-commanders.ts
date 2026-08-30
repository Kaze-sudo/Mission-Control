import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface PlatoonAgentDescriptor {
  id: string
  name: string
  role: string
  definitionPath: string | null
  identity: string
  model: string | null
  isCommander: boolean
}

export interface PlatoonCommanderSnapshot {
  platoonId: string
  commanderName: string
  commanderAvailable: boolean
  blocked: boolean
  blockReason: string | null
  inventoryMode: 'native-profiles' | 'config-profiles' | 'runtime-only'
  agents: PlatoonAgentDescriptor[]
  notes: string[]
}

export interface PlatoonCommanderAdapter {
  readonly platoonId: string
  discover(): PlatoonCommanderSnapshot
}

function readText(file: string): string {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

function yamlScalar(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') || null
}

function markdownSection(content: string, heading: string): string {
  const pattern = new RegExp(`^${heading}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n[A-Z][A-Z /&()-]{2,}\\r?\\n|$)`, 'mi')
  return content.match(pattern)?.[1]?.trim() || ''
}

function hermesCapabilityText(identity: string, profile: string): string {
  const description = yamlScalar(profile, 'description') || ''
  const role = markdownSection(identity, 'ROLE')
  const primary = markdownSection(identity, 'PRIMARY SCOPE')
  const duties = markdownSection(identity, 'WHAT YOU DO')
  const tools = markdownSection(identity, 'TOOLS')
  return [description, role, primary, duties, tools].filter(Boolean).join('\n')
}

class HermesCommanderAdapter implements PlatoonCommanderAdapter {
  readonly platoonId = 'hermes'

  discover(): PlatoonCommanderSnapshot {
    const root = process.env.HERMES_PROFILES_DIR
      || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes', 'profiles')
    const agents: PlatoonAgentDescriptor[] = []
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const dir = path.join(root, name)
        try { if (!statSync(dir).isDirectory()) continue } catch { continue }
        const identity = readText(path.join(dir, 'SOUL.md'))
        const profile = readText(path.join(dir, 'profile.yaml'))
        const config = readText(path.join(dir, 'config.yaml'))
        if (!identity && !profile && !config) continue
        const description = yamlScalar(profile, 'description')
        const model = yamlScalar(config, 'model')
        const roleLine = identity.match(/^ROLE\s*\r?\n-\s*(.+)$/im)?.[1]?.trim()
        const role = roleLine || description || (name === 'orchestrator' ? 'Platoon Commander' : 'Hermes Agent')
        agents.push({ id: `hermes:${name}`, name, role, definitionPath: dir, identity: hermesCapabilityText(identity, profile), model, isCommander: name === 'orchestrator' })
      }
    }
    const commander = agents.find(agent => agent.isCommander)
    const estopPath = commander?.definitionPath ? path.join(commander.definitionPath, 'ESTOP') : null
    const blocked = !!(estopPath && existsSync(estopPath))
    const blockReason = blocked ? readText(estopPath!).trim() || 'Hermes orchestrator emergency stop is active' : null
    return {
      platoonId: this.platoonId,
      commanderName: commander?.name || 'hermes',
      commanderAvailable: agents.length > 0 && !blocked,
      blocked,
      blockReason,
      inventoryMode: 'native-profiles',
      agents,
      notes: blocked ? ['Hermes orchestrator ESTOP is active; AgentOS will not dispatch to this platoon.'] : agents.length ? [] : ['No Hermes profiles discovered'],
    }
  }
}

function findCodexBinary(): string | null {
  const home = os.homedir()
  const candidates = [
    process.env.CODEX_BIN,
    path.join(home, '.codex', 'plugins', '.plugin-appserver', 'codex.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
    'codex',
  ].filter(Boolean) as string[]
  for (const candidate of candidates) {
    if (candidate === 'codex') return candidate
    if (existsSync(candidate)) return candidate
  }
  return null
}

class CodexCommanderAdapter implements PlatoonCommanderAdapter {
  readonly platoonId = 'codex'

  discover(): PlatoonCommanderSnapshot {
    const home = os.homedir()
    const root = path.join(home, '.codex')
    const agents: PlatoonAgentDescriptor[] = []
    if (existsSync(root)) {
      for (const file of readdirSync(root)) {
        if (!file.endsWith('.config.toml') || file === 'config.toml') continue
        const name = file.replace(/\.config\.toml$/, '')
        const fullPath = path.join(root, file)
        const config = readText(fullPath)
        const model = config.match(/^model\s*=\s*["']([^"']+)/m)?.[1] || null
        agents.push({ id: `codex:${name}`, name, role: 'Codex Profile', definitionPath: fullPath, identity: config, model, isCommander: false })
      }
    }
    const codexBin = findCodexBinary()
    return {
      platoonId: this.platoonId,
      commanderName: 'codex',
      commanderAvailable: codexBin !== null,
      blocked: false,
      blockReason: null,
      inventoryMode: agents.length ? 'config-profiles' : 'runtime-only',
      agents,
      notes: agents.length ? [] : ['Codex CLI is available, but no persistent named Codex agent profiles were found. Sessions are task instances, not roster agents.'],
    }
  }
}

const ADAPTERS: PlatoonCommanderAdapter[] = [new HermesCommanderAdapter(), new CodexCommanderAdapter()]

export function discoverPlatoonCommanders(): PlatoonCommanderSnapshot[] {
  return ADAPTERS.map(adapter => adapter.discover())
}

export function getPlatoonCommander(platoonId: string): PlatoonCommanderSnapshot | null {
  const adapter = ADAPTERS.find(candidate => candidate.platoonId === platoonId)
  return adapter ? adapter.discover() : null
}
