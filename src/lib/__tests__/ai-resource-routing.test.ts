import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAgentosResourcesPromptSection } from '@/lib/task-dispatch'
import { toTaskResourceAttachment } from '@/lib/ai-resource-registry'

describe('AI vault routing integration', () => {
  const routing = readFileSync(join(process.cwd(), 'src/lib/project-task-routing.ts'), 'utf8')
  const dispatch = readFileSync(join(process.cwd(), 'src/lib/task-dispatch.ts'), 'utf8')
  const force = readFileSync(join(process.cwd(), 'src/lib/project-force-planning.ts'), 'utf8')

  it('attaches canonical agentos_resources metadata when a mission is routed', () => {
    expect(routing).toContain('recommendAiResources([')
    expect(routing).toContain('agentos_resources: resourceRecommendations.map(resource => toTaskResourceAttachment(resource))')
  })

  it('task metadata attachment carries the canonical snake_case shape', () => {
    const attachment = toTaskResourceAttachment({
      id: 'res-tactical-wesnoth-framework',
      name: 'Battle for Wesnoth (scenario framework)',
      path: 'D:\\AI\\00_INBOX\\wesnoth',
      type: 'engine',
      score: 83.5,
      status: 'keep-secondary',
      primaryCapability: 'tactical-encounters',
      capabilities: ['tactical-encounters', 'game-development'],
      preferredPlatoon: 'game-platoon',
      preferredSpecialistRole: 'tactical-battles-encounter-designer',
      integrationMode: 'external-runtime-integration',
      runtimeRequirements: ['C++ / SDL2'],
      authoritative: true,
      modifiedAt: 0,
      relativePath: '00_INBOX/wesnoth',
      parentId: null,
      description: '',
      gitRemote: null,
      signals: { readme: true, git: false, tests: false, skillManifest: false },
    })
    expect(Object.keys(attachment)).toEqual([
      'resource_id', 'name', 'type', 'path', 'score', 'audit_status', 'capabilities', 'primary_capability',
      'usage', 'preferred_platoon', 'preferred_specialist_role', 'integration_mode', 'runtime_requirements', 'authoritative',
    ])
    expect(attachment.audit_status).toBe('keep-secondary')
    expect(attachment.preferred_platoon).toBe('game-platoon')
    expect(attachment.runtime_requirements).toEqual(['C++ / SDL2'])
  })

  it('specialist dispatch prompt injects preferred resources through the shared builder', () => {
    expect(dispatch).toContain('buildAgentosResourcesPromptSection(')
    expect(dispatch).toContain('## AgentOS Preferred Resources')
  })

  it('prompt tells specialists to use resources only when accessible and to report access limitations', () => {
    const section = buildAgentosResourcesPromptSection([{
      name: 'OXCE',
      path: 'D:\\AI\\00_INBOX\\oxce',
      score: 79,
      capabilities: ['tactical-encounters'],
      manual_only: true,
    }])
    expect(section).toContain('## AgentOS Preferred Resources')
    expect(section).toContain('OXCE')
    expect(section).toContain('Do NOT claim to have used a resource your runtime cannot access')
    expect(section).toContain('report the access limitation')
    expect(section).toContain('Do NOT automatically use manual-only or reference resources')
  })

  it('prompt builder emits nothing when no resources are attached', () => {
    expect(buildAgentosResourcesPromptSection([])).toBe('')
    expect(buildAgentosResourcesPromptSection(null as unknown as unknown[])).toBe('')
  })

  it('exposes project-level resource recommendations through force planning', () => {
    expect(force).toContain('const resourceRecommendations = recommendAiResources')
    expect(force).toContain('resourceRecommendations,')
  })
})