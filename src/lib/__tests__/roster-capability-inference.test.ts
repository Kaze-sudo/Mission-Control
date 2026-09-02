import { describe, expect, it } from 'vitest'
import { inferCapabilityTags } from '@/lib/global-agent-roster'

/**
 * knowledge-curation ownership is AUTHORING-ONLY. These tests lock the
 * evidence bar: explicit reference-authoring ownership qualifies; generic
 * intelligence, README/docs mentions, evidence synthesis, and single
 * documentation mentions never do.
 */
describe('knowledge-curation capability inference (evidence-based ownership)', () => {
  it('qualifies a genuine curator definition (Gamut frontmatter format)', () => {
    const identity = [
      'Mission: Curate approved AgentOS reference material into structured knowledge packs for specialists.',
      'Primary ownership: reference authoring, cross-source synthesis with source attribution, technical writing, documentation architecture.',
      'Deliverables: knowledge pack suite, reference guides, pattern catalog, source-indexed summaries.',
    ].join('\n')
    expect(inferCapabilityTags('Technical Writer & Knowledge Curator (AgentOS Ops)', identity)).toContain('knowledge-curation')
  })

  it('qualifies a genuine curator definition (Hermes SOUL/profile format)', () => {
    const identity = [
      'ROLE',
      '- Maintain the AgentOS knowledge base: curate approved reference guides, write technical reference material,',
      '  and produce structured knowledge packs with cross-source synthesis and attribution.',
      'PRIMARY SCOPE',
      '- Knowledge base maintenance, reference library ownership, documentation architecture.',
    ].join('\n')
    expect(inferCapabilityTags('Knowledge Curator', identity)).toContain('knowledge-curation')
  })

  it('qualifies individual authoring signals: reference guides, pattern catalogs, knowledge-base maintenance', () => {
    expect(inferCapabilityTags('Specialist', 'Owns the AgentOS reference guide for tactical encounters.')).toContain('knowledge-curation')
    expect(inferCapabilityTags('Specialist', 'Maintains the pattern catalog of approved integration patterns.')).toContain('knowledge-curation')
    expect(inferCapabilityTags('Specialist', 'Primary ownership: knowledge base maintenance and curation.')).toContain('knowledge-curation')
    expect(inferCapabilityTags('Specialist', 'Curates approved reference material for the arsenal.')).toContain('knowledge-curation')
    expect(inferCapabilityTags('Specialist', 'Delivers technical writing: architecture documentation for AgentOS specialists.')).toContain('knowledge-curation')
  })

  it('never infers knowledge-curation from generic or weak text', () => {
    // Game Director — design authority, not a curator.
    const director = [
      'Mission: Define and protect a cohesive, fun, polished player experience.',
      'Primary ownership: core loop, tactical depth, feature priorities, definition of fun, design acceptance.',
      'Deliverables: approved design briefs, rules, acceptance criteria, source-of-truth updates.',
    ].join('\n')
    expect(inferCapabilityTags('Game Director & Systems Designer (DBZ Tactics)', director)).not.toContain('knowledge-curation')

    // QA — synthesizes verification evidence, does not author reference packs.
    const qa = [
      'Mission: Independently determine whether changes/releases work and meet acceptance.',
      'Primary ownership: regression, acceptance evidence, risk report, release checklist. Claim only executed evidence.',
    ].join('\n')
    expect(inferCapabilityTags('QA Playtest & Release Verification Lead (DBZ Tactics)', qa)).not.toContain('knowledge-curation')

    // Combat engineer — gameplay implementation ownership.
    const combat = 'Mission: Deliver responsive, reusable combat. Primary ownership: melee, hit detection, combat runtime, migration notes.'
    expect(inferCapabilityTags('Combat Gameplay Engineer (DBZ Tactics)', combat)).not.toContain('knowledge-curation')

    // Chief of Staff — cross-agent synthesis is coordination, not authorship.
    const chief = 'Chief of Staff owns orchestration, delegation, coordination, prioritization, and cross-agent synthesis. Produces project documentation.'
    expect(inferCapabilityTags('Chief of Staff (DBZ Tactics)', chief)).not.toContain('knowledge-curation')

    // README/docs mentions, single research/synthesis words — never enough.
    expect(inferCapabilityTags('Build & Repository Engineer', 'Writes READMEs and docs; keeps repository documentation current.')).not.toContain('knowledge-curation')
    expect(inferCapabilityTags('Narrative Designer', 'Produces content documentation and continuity notes.')).not.toContain('knowledge-curation')
    expect(inferCapabilityTags('Researcher', 'Does research; synthesizes findings into reports.')).not.toContain('knowledge-curation')
  })

  it('still infers domain capabilities alongside ownership when present', () => {
    const identity = [
      'Primary ownership: tactical-encounter reference guides, knowledge pack authoring for tactical systems.',
    ].join('\n')
    const tags = inferCapabilityTags('Tactical Knowledge Curator', identity)
    expect(tags).toContain('knowledge-curation')
    expect(tags).toContain('tactical-encounters')
  })
})
