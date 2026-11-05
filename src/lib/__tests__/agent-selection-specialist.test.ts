import { describe, expect, it } from 'vitest'
import { rankAgentsForMission } from '../agent-selection'
import type { GlobalRosterAgent } from '../global-agent-roster'

function agent(name: string, role: string, capabilities: string[], availability: GlobalRosterAgent['availability'] = 'available'): GlobalRosterAgent {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name, platoonId: 'gamut', role, archetype: role, availability,
    definitionPath: null, source: 'filesystem',
    capabilities: { tags: capabilities, source: 'declared' },
    performance: { tasks: 0, completed: 0, completionRate: null },
  }
}

describe('specialist affinity routing', () => {
  it('prefers the domain owner when multiple agents satisfy the same capability', () => {
    const director = agent('Game Director & Systems Designer', 'Game Director', ['tactical-encounters'])
    const tactical = agent('Tactical Battles & Encounter Designer', 'Encounter Designer', ['tactical-encounters'])
    const ranked = rankAgentsForMission([director, tactical], { requiredCapabilities: ['tactical-encounters'] })
    expect(ranked[0].agent.name).toBe('Tactical Battles & Encounter Designer')
    expect(ranked[0].reasons).toContain('Specialist owner: tactical-encounters')
  })

  it('does not let specialist affinity bypass missing required capabilities', () => {
    const combat = agent('Combat Gameplay Engineer', 'Combat Gameplay Engineer', ['game-development'])
    const generalist = agent('Generalist', 'Agent', ['combat-systems'])
    const ranked = rankAgentsForMission([combat, generalist], { requiredCapabilities: ['combat-systems'] })
    expect(ranked[0].agent.name).toBe('Generalist')
    expect(ranked.find(item => item.agent.name === 'Combat Gameplay Engineer')?.eligible).toBe(false)
  })

  it('keeps availability as a hard eligibility gate', () => {
    const specialist = agent('QA Playtest & Release Verification Lead', 'QA Lead', ['qa-release'], 'offline')
    const available = agent('Available Reviewer', 'Reviewer', ['qa-release'])
    const ranked = rankAgentsForMission([specialist, available], { requiredCapabilities: ['qa-release'] })
    expect(ranked[0].agent.name).toBe('Available Reviewer')
    expect(ranked.find(item => item.agent.name.startsWith('QA Playtest'))?.eligible).toBe(false)
  })
})
