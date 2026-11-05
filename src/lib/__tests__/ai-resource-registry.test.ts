import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getAiArsenalState,
  getAiCapabilityCoverage,
  getAiPromotionHistory,
  getAiResourceChanges,
  getAiResourceRegistry,
  isResourceAutoSelectable,
  recommendAiResources,
  scanAiVault,
  toTaskResourceAttachment,
  KNOWLEDGE_PACK_BACKLOG,
} from '@/lib/ai-resource-registry'
import { buildCanonicalVault, read, tmpRoot, rmRoot } from './helpers/ai-arsenal-fixtures'

let root = ''
function writeFile(rel: string, content: string) {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

describe('AI resource scanner', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-ai-vault-'))
    fs.mkdirSync(path.join(root, 'Repositories'), { recursive: true })
    fs.mkdirSync(path.join(root, 'Knowledge Packets'), { recursive: true })
  })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it('catalogs repositories and nested skills with stable capability metadata', () => {
    writeFile('Repositories/Lux/README.md', '# Lux\nStructured Unity security and QA skill library.')
    writeFile('Repositories/Lux/.git/config', '[remote "origin"]\n  url = https://example.test/lux.git\n')
    writeFile('Repositories/Lux/skills/security/SKILL.md', '# Security Audit\nSecurity audit and vulnerability review workflow.')
    writeFile('Repositories/Lux/skills/security/README.md', '# Security Audit\nReusable security audit skill.')
    const source = writeFile('Repositories/Lux/source.txt', 'do not modify me')

    const first = scanAiVault(root, true)
    const second = scanAiVault(root, false)
    const skill = first.resources.find(r => r.type === 'skill' && r.name === 'security')

    expect(first.summary.repositories).toBe(1)
    expect(first.summary.skills).toBe(1)
    expect(skill?.capabilities).toContain('security')
    expect(skill?.parentId).toBeTruthy()
    expect(second.resources.find(r => r.relativePath === skill?.relativePath)?.id).toBe(skill?.id)
    expect(fs.readFileSync(source, 'utf8')).toBe('do not modify me')
  })

  it('groups overlapping skills and prefers the higher-ranked candidate', () => {
    writeFile('Repositories/Strong/README.md', '# Strong\nSecurity audit and vulnerability review toolkit.')
    writeFile('Repositories/Strong/security/SKILL.md', '# Security Pro\nSecurity audit and vulnerability review.')
    writeFile('Repositories/Strong/security/README.md', '# Security Pro\nWell documented security audit workflow.')
    fs.mkdirSync(path.join(root, 'Repositories', 'Strong', 'security', 'tests'), { recursive: true })
    writeFile('Repositories/Weak/README.md', '# Weak\nSecurity helpers.')
    writeFile('Repositories/Weak/security/SKILL.md', '# Security Basic\nSecurity audit helper.')

    const registry = scanAiVault(root, true)
    const group = registry.overlapGroups.find(g => g.capability === 'security')
    const recommendations = recommendAiResources(['security'], 4, root)

    expect(group).toBeTruthy()
    expect(group?.candidateIds.length).toBe(2)
    expect(recommendations[0]?.score).toBeGreaterThan(recommendations[1]?.score || 0)
  })

  it('scanner reports never touch canonical audit files', () => {
    const fixture = tmpRoot()
    buildCanonicalVault(fixture)
    const canonicalPath = path.join(fixture, '_CATALOG', 'agentos_resource_registry.json')
    const before = fs.readFileSync(canonicalPath, 'utf8')
    scanAiVault(fixture, true)
    expect(fs.readFileSync(canonicalPath, 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(fixture, '_CATALOG', 'scanner_registry.json'))).toBe(true)
    expect(fs.existsSync(path.join(fixture, '_CATALOG', 'scanner_overlap_groups.json'))).toBe(true)
    rmRoot(fixture)
  })
})

describe('Authoritative AI Arsenal registry adapter', () => {
  afterEach(() => { if (root) rmRoot(root) })
  beforeEach(() => {
    root = tmpRoot()
    buildCanonicalVault(root)
  })

  it('reads 20 canonical resources and normalizes audit metadata (canonical beats heuristic)', () => {
    const registry = getAiResourceRegistry(root)
    const wesnoth = registry.resources.find(r => r.id === 'res-tactical-wesnoth-framework')
    expect(registry.resources.length).toBe(4)
    expect(registry.summary.total).toBe(4)
    expect(wesnoth?.score).toBe(83.5)
    expect(wesnoth?.auditStatus).toBe('KEEP-SECONDARY')
    expect(wesnoth?.status).toBe('keep-secondary')
    expect(wesnoth?.autoSelectAllowed).toBe(true)
    expect(wesnoth?.preferredPlatoon).toBe('game-platoon')
    expect(wesnoth?.preferredSpecialistRole).toBe('tactical-battles-encounter-designer')
    expect(wesnoth?.moveRisk).toContain('SAFE_TO_MOVE')
    expect(wesnoth?.pathSensitive).toBe(false)
    expect(wesnoth?.authoritative).toBe(true)
  })

  it('normalizes overlap policy groups and move/path risk fields', () => {
    const registry = getAiResourceRegistry(root)
    const group = registry.overlapGroups.find(g => g.capability === 'tactical engines')
    expect(group?.preferredId).toBe('res-tactical-wesnoth-framework')
    expect(group?.candidateIds).toContain('res-tactical-boardgame-io')
    const risky = registry.resources.filter(r => r.pathSensitive)
    expect(risky.map(r => r.id)).toContain('res-gdev-ai')
  })

  it('REJECT and manual-only resources are never auto-selectable; KEEP/KEEP-SECONDARY are', () => {
    const registry = getAiResourceRegistry(root)
    const byId = (id: string) => registry.resources.find(r => r.id === id)!
    expect(isResourceAutoSelectable(byId('res-gdev-ai'))).toBe(false) // REJECT-CANDIDATE
    expect(isResourceAutoSelectable(byId('res-tactical-oxce-reference'))).toBe(false) // REFERENCE / manual-only
    expect(isResourceAutoSelectable(byId('res-tactical-wesnoth-framework'))).toBe(true) // KEEP-SECONDARY auto
    expect(isResourceAutoSelectable(byId('res-tactical-boardgame-io'))).toBe(true) // KEEP auto
  })

  it('tactical-encounters selects Wesnoth and never boardgame.io or OXCE', () => {
    const tactical = recommendAiResources(['tactical-encounters'], 6, root)
    expect(tactical.map(r => r.id)).toEqual(['res-tactical-wesnoth-framework'])
    expect(tactical.some(r => r.id === 'res-tactical-oxce-reference')).toBe(false) // manual-only gate
    expect(tactical.some(r => r.id === 'res-tactical-boardgame-io')).toBe(false) // never a provider
  })

  it('boardgame.io is selected for turn-state-engine', () => {
    const turnState = recommendAiResources(['turn-state-engine'], 6, root)
    expect(turnState.map(r => r.id)).toContain('res-tactical-boardgame-io')
  })

  it('REJECT-only capability yields no recommendations', () => {
    expect(recommendAiResources(['enemy-ai'], 6, root)).toEqual([])
  })

  it('ranks a shared capability request using canonical index order + score', () => {
    const both = recommendAiResources(['game-development', 'tactical-encounters'], 6, root)
    // Wesnoth covers both tactical-encounters (preferred) and game-development → ranks first.
    expect(both[0]?.id).toBe('res-tactical-wesnoth-framework')
  })

  it('PARTIALLY_COVERED survives normalization with correct preferred/reference/not-provider', () => {
    const coverage = getAiCapabilityCoverage(root)
    const tactical = coverage.find(c => c.capability === 'tactical-encounters')
    expect(tactical?.status).toBe('PARTIALLY_COVERED')
    expect(tactical?.preferred.map(e => e.name)[0]).toContain('Wesnoth')
    const oxce = tactical?.reference.find(e => e.resourceId === 'res-tactical-oxce-reference')
    expect(oxce?.manualOnly).toBe(true)
    expect(tactical?.notProviders.join(' ')).toContain('boardgame.io')
    expect(tactical?.note).toContain('do NOT mark FILLED')
  })

  it('coverage summary counts FILLED / PARTIALLY_COVERED / OPEN from canonical files', () => {
    const summary = getAiArsenalState(root).summary
    expect(summary.partiallyCovered).toBe(1)
    expect(summary.open).toBe(2) // local-llm + browser-automation gaps
    expect(summary.filled).toBe(2) // turn-state-engine + enemy-ai
    expect(summary.capabilities).toBe(5)
    expect(summary.resources).toBe(4)
  })

  it('parses the New/Changed snapshot without mutating the canonical registry', () => {
    const beforeRegistry = read(root, '_CATALOG/agentos_resource_registry.json')
    const changes = getAiResourceChanges(root)
    expect(changes?.scanId).toBe('scan-test-001')
    expect(changes?.new).toEqual(['res-tactical-boardgame-io'])
    expect(changes?.promoted).toEqual([])
    expect(read(root, '_CATALOG/agentos_resource_registry.json')).toBe(beforeRegistry)
  })

  it('parses promotion history with prior/new state and warnings', () => {
    const history = getAiPromotionHistory(root)
    expect(history.length).toBe(1)
    expect(history[0].promotionBatchId).toBe('promo-test-01')
    expect(history[0].approvedResources).toEqual(['res-project-tactics', 'res-didactic-octo-happiness'])
    expect(history[0].previousState?.registry_total).toBe(17)
    expect(history[0].newState?.capabilities).toBe(59)
    expect(history[0].warnings).toEqual(['tactical-encounters gap remains OPEN'])
  })

  it('builds the canonical agentos_resources task-metadata attachment shape', () => {
    const registry = getAiResourceRegistry(root)
    const wesnoth = registry.resources.find(r => r.id === 'res-tactical-wesnoth-framework')!
    const attachment = toTaskResourceAttachment(wesnoth)
    expect(attachment).toMatchObject({
      resource_id: 'res-tactical-wesnoth-framework',
      name: wesnoth.name,
      type: 'engine',
      score: 83.5,
      audit_status: 'KEEP-SECONDARY',
      primary_capability: 'tactical-encounters',
      preferred_platoon: 'game-platoon',
      preferred_specialist_role: 'tactical-battles-encounter-designer',
      integration_mode: 'external-runtime-integration',
      authoritative: true,
    })
    expect(Array.isArray(attachment.runtime_requirements)).toBe(true)
    expect(Array.isArray(attachment.capabilities)).toBe(true)
    expect(attachment.path).toContain('wesnoth')
  })

  it('exposes the knowledge-pack backlog as proposed (future) missions only', () => {
    expect(KNOWLEDGE_PACK_BACKLOG.length).toBe(5)
    expect(KNOWLEDGE_PACK_BACKLOG.map(p => p.id)).toContain('kp-tactical-encounter-design-patterns')
    expect(KNOWLEDGE_PACK_BACKLOG.every(p => p.status === 'proposed')).toBe(true)
  })
})