import type { MissionRequirements } from './agent-selection'

export interface MissionIntentResult {
  requirements: MissionRequirements
  evidence: Array<{ capability: string; source: 'title' | 'description'; phrase: string }>
}

interface IntentRule {
  capability: string
  title: RegExp[]
  description?: RegExp[]
}

const RULES: IntentRule[] = [
  { capability: 'orchestration', title: [/orchestrat/i, /delegat/i, /coordinate.*agent/i, /assign.*agent/i] },
  { capability: 'architecture', title: [/architect/i, /system design/i, /refactor.*architecture/i, /technical design/i] },
  { capability: 'game-direction', title: [/game direction/i, /design pillar/i, /core gameplay vision/i, /game feel/i] },
  { capability: 'combat-systems', title: [/combat/i, /melee/i, /ki blast/i, /beam clash/i, /parry/i, /counter/i, /hitstun/i, /knockback/i] },
  { capability: 'tactical-encounters', title: [/encounter/i, /battlefield/i, /action economy/i, /terrain/i, /hazard/i, /enemy placement/i, /battle objective/i] },
  { capability: 'enemy-ai', title: [/enemy ai/i, /boss ai/i, /boss phase/i, /enemy behavior/i, /decision making/i] },
  { capability: 'progression-transformations', title: [/progression/i, /transformation/i, /leveling/i, /xp\b/i, /unlock/i, /loadout/i, /stat curve/i] },
  { capability: 'narrative-content', title: [/narrative/i, /quest/i, /dialogue/i, /story/i, /lore/i, /world content/i] },
  { capability: 'art-animation', title: [/animation/i, /technical art/i, /sprite/i, /shader/i, /rigging/i, /character art/i] },
  { capability: 'vfx-camera', title: [/\bvfx\b/i, /camera/i, /cinematic/i, /screen shake/i, /post.?processing/i, /combat presentation/i] },
  { capability: 'audio', title: [/audio/i, /music/i, /\bsfx\b/i, /sound/i, /voice line/i, /mixing/i] },
  { capability: 'ui-input-accessibility', title: [/\bui\b/i, /\bux\b/i, /accessibility/i, /controller/i, /input/i, /remap/i, /hud/i, /menu navigation/i] },
  { capability: 'save-data-tools', title: [/save system/i, /serialization/i, /data migration/i, /developer tool/i, /content data/i, /catalog/i] },
  { capability: 'performance-platform', title: [/performance/i, /profil/i, /optimization/i, /frame time/i, /memory usage/i, /platform/i] },
  { capability: 'build-repository', title: [/\bci\b/i, /github actions/i, /repository/i, /\bgit\b/i, /build pipeline/i, /unity meta/i, /\.meta\b/i, /branch/i, /merge conflict/i] },
  { capability: 'multiplayer-networking', title: [/multiplayer/i, /network/i, /netcode/i, /replication/i, /server authority/i] },
  { capability: 'qa-release', title: [/\bqa\b/i, /playtest/i, /release verification/i, /regression test/i, /acceptance test/i, /release gate/i] },
  { capability: 'security', title: [/security/i, /auth(?:entication|orization)?/i, /tenant isolation/i, /secret/i, /permission/i] },
  { capability: 'backend', title: [/backend/i, /api route/i, /server action/i, /server endpoint/i] },
  { capability: 'data', title: [/database/i, /postgres/i, /prisma/i, /\bsql\b/i, /\brls\b/i, /schema migration/i] },
  { capability: 'frontend', title: [/frontend/i, /react/i, /web interface/i, /component/i] },
  { capability: 'testing-review', title: [/test/i, /review/i, /verify/i, /validation/i, /playwright/i, /vitest/i] },
  { capability: 'devops', title: [/docker/i, /infrastructure/i, /container/i, /deployment infrastructure/i] },
  { capability: 'release-engineering', title: [/deploy/i, /release pipeline/i, /production smoke/i, /vercel/i] },
  { capability: 'construction-estimating', title: [/estimating/i, /estimate/i, /takeoff/i, /pricebook/i, /xactimate/i, /freebuff/i, /material quantit/i] },
  { capability: 'construction-operations', title: [/job packet/i, /subcontractor/i, /supplier/i, /crew schedule/i, /client workflow/i, /construction operations/i] },
  { capability: 'resource-deep-review', title: [/deep review/i, /resource review/i, /registry audit/i, /arsenal review/i] },
  { capability: 'knowledge-curation', title: [/knowledge curation/i, /knowledge pack/i, /curate/i, /reference pack/i, /knowledge base/i] },
]

for (const rule of RULES) {
  if (!rule.description) rule.description = rule.title
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[0]) return match[0]
  }
  return null
}

export function inferMissionIntent(title: string, description = ''): MissionIntentResult {
  const required: string[] = []
  const preferred: string[] = []
  const evidence: MissionIntentResult['evidence'] = []

  for (const rule of RULES) {
    const titleHit = firstMatch(title, rule.title)
    if (titleHit) {
      required.push(rule.capability)
      evidence.push({ capability: rule.capability, source: 'title', phrase: titleHit })
      continue
    }
    const descriptionHit = description ? firstMatch(description, rule.description || []) : null
    if (descriptionHit) {
      preferred.push(rule.capability)
      evidence.push({ capability: rule.capability, source: 'description', phrase: descriptionHit })
    }
  }

  return {
    requirements: {
      requiredCapabilities: [...new Set(required)],
      preferredCapabilities: [...new Set(preferred.filter(tag => !required.includes(tag)))],
      preferredPlatoons: [],
    },
    evidence,
  }
}
