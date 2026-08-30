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
    const available = agent.availability === 'available' || agent.availability === 'busy'
    const eligible = available && missingRequired.length === 0
    const reasons: string[] = []

    let score = 0
    if (required.length === 0) score += 45
    else score += (matchedRequired.length / required.length) * 70
    if (preferred.length > 0) score += (matchedPreferred.length / preferred.length) * 15
    if (agent.availability === 'available') score += 15
    else if (agent.availability === 'busy') score += 5
    if (preferredPlatoons.has(agent.platoonId.toLowerCase())) score += 5
    if (agent.performance.completionRate !== null) score += agent.performance.completionRate / 20

    if (matchedRequired.length) reasons.push(`Matched required: ${matchedRequired.join(', ')}`)
    if (missingRequired.length) reasons.push(`Missing required: ${missingRequired.join(', ')}`)
    if (matchedPreferred.length) reasons.push(`Matched preferred: ${matchedPreferred.join(', ')}`)
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
