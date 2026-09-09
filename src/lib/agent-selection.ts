import type { GlobalRosterAgent } from './global-agent-roster'

export interface MissionRequirements {
  requiredCapabilities: string[]
  preferredCapabilities?: string[]
  preferredPlatoons?: string[]
}

export interface CandidateScore {
  agent: GlobalRosterAgent
  eligible: boolean
  score: number
  matchedRequired: string[]
  missingRequired: string[]
  matchedPreferred: string[]
  reasons: string[]
}

function normalize(values: string[] | undefined): string[] {
  return [...new Set((values || []).map(v => v.trim().toLowerCase()).filter(Boolean))]
}

const SPECIALIST_AFFINITY: Array<[string, RegExp]> = [
  ['orchestration', /chief of staff|orchestrator|platoon commander/i],
  ['architecture', /architect/i],
  ['game-direction', /game director|systems designer/i],
  ['combat-systems', /combat gameplay|combat systems/i],
  ['tactical-encounters', /tactical battles|encounter designer/i],
  ['enemy-ai', /enemy ai|boss engineer/i],
  ['progression-transformations', /progression|transformation/i],
  ['narrative-content', /narrative|world|content designer/i],
  ['art-animation', /art|animation|technical art/i],
  ['vfx-camera', /vfx|camera|combat presentation/i],
  ['audio', /audio/i],
  ['ui-input-accessibility', /ui ux|accessibility|input engineer/i],
  ['save-data-tools', /save|data|developer tools/i],
  ['performance-platform', /performance|platform/i],
  ['build-repository', /build|repository/i],
  ['multiplayer-networking', /multiplayer|online/i],
  ['qa-release', /qa|playtest|release verification/i],
  ['resource-deep-review', /deep reviewer|resource reviewer|arsenal|resource auditor|curator/i],
  ['knowledge-curation', /knowledge (curator|manager|pack)|curation specialist|technical writer|documentation architect|reference (material|guide|library) owner/i],
  ['construction-estimating', /estimating|estimator|takeoff/i],
]

function specialistAffinity(agent: GlobalRosterAgent, capabilities: string[]): string[] {
  const identity = `${agent.name}\n${agent.role}\n${agent.archetype}`
  return capabilities.filter(capability => {
    const pattern = SPECIALIST_AFFINITY.find(([tag]) => tag === capability)?.[1]
    return !!pattern?.test(identity)
  })
}

export function rankAgentsForMission(
  agents: GlobalRosterAgent[],
  requirements: MissionRequirements,
): CandidateScore[] {
  const required = normalize(requirements.requiredCapabilities)
  const preferred = normalize(requirements.preferredCapabilities)
  const preferredPlatoons = new Set(normalize(requirements.preferredPlatoons))

  const ranked = agents.map(agent => {
    const capabilities = new Set(agent.capabilities.tags.map(tag => tag.toLowerCase()))
    const matchedRequired = required.filter(tag => capabilities.has(tag))
    const missingRequired = required.filter(tag => !capabilities.has(tag))
    const matchedPreferred = preferred.filter(tag => capabilities.has(tag))
    const specialistRequired = specialistAffinity(agent, matchedRequired)
    const specialistPreferred = specialistAffinity(agent, matchedPreferred)
    const available = agent.availability === 'available' || agent.availability === 'busy'
    const eligible = available && missingRequired.length === 0
    const reasons: string[] = []

    let score = 0
    if (required.length === 0) score += 45
    else score += (matchedRequired.length / required.length) * 70
    if (preferred.length > 0) score += (matchedPreferred.length / preferred.length) * 15
    score += specialistRequired.length * 12
    score += specialistPreferred.length * 4
    if (agent.availability === 'available') score += 15
    else if (agent.availability === 'busy') score += 5
    if (preferredPlatoons.has(agent.platoonId.toLowerCase())) score += 5
    if (agent.performance.completionRate !== null) score += agent.performance.completionRate / 20

    if (matchedRequired.length) reasons.push(`Matched required: ${matchedRequired.join(', ')}`)
    if (missingRequired.length) reasons.push(`Missing required: ${missingRequired.join(', ')}`)
    if (matchedPreferred.length) reasons.push(`Matched preferred: ${matchedPreferred.join(', ')}`)
    if (specialistRequired.length) reasons.push(`Specialist owner: ${specialistRequired.join(', ')}`)
    if (specialistPreferred.length) reasons.push(`Preferred specialist: ${specialistPreferred.join(', ')}`)
    if (agent.availability === 'available') reasons.push('Available now')
    if (agent.availability === 'busy') reasons.push('Currently busy')
    if (!available) reasons.push(`Unavailable: ${agent.availability}`)

    return {
      agent,
      eligible,
      score: Math.round(Math.max(0, Math.min(100, score)) * 10) / 10,
      matchedRequired,
      missingRequired,
      matchedPreferred,
      reasons,
    }
  })

  return ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1
    if (b.score !== a.score) return b.score - a.score
    return a.agent.name.localeCompare(b.agent.name)
  })
}
