import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { performArsenalAction, validatePromotionPayload } from '@/lib/ai-resource-actions'
import { getAiResourceRegistry, getAiPromotionHistory, getAiReviewQueue, recommendAiResources } from '@/lib/ai-resource-registry'
import { buildCanonicalVault, read, reviewQueueItems, registryResources, tmpRoot, rmRoot, write } from './helpers/ai-arsenal-fixtures'

let root = ''
beforeEach(() => { root = tmpRoot(); buildCanonicalVault(root) })
afterEach(() => { rmRoot(root) })

const promotionPayload = {
  name: 'new-tactical-lib',
  display_name: 'npmlib — new tactical encounter library',
  source_repo: 'https://example.test/new-tactical-lib.git',
  resource_type: 'framework',
  primary_capability: 'tactical-encounters',
  secondary_capabilities: ['game-development'],
  quality_score: 71,
  audit_status: 'KEEP',
  auto_select_allowed: true,
  manual_only: false,
  preferred_platoon: 'game-platoon',
  preferred_specialist_role: 'tactical-battles-encounter-designer',
  integration_mode: 'shared-library',
  runtime_requirements: ['Node.js'],
  overlap_group_id: 'grp-tactical-engines',
  relative_path: '00_INBOX/new-tactical-lib',
}

describe('validatePromotionPayload', () => {
  it('rejects missing name, missing primary capability, and invalid audit status', () => {
    expect(validatePromotionPayload({})).toContain('name/display_name is required')
    expect(validatePromotionPayload({ name: 'x' })).toContain('primary_capability is required')
    const errors = validatePromotionPayload({ name: 'x', primary_capability: 'y', audit_status: 'REJECT' })
    expect(errors.some(e => e.includes('audit_status must be one of'))).toBe(true)
  })
  it('rejects manual_only without auto_select_allowed=false', () => {
    expect(validatePromotionPayload({ name: 'x', primary_capability: 'y', manual_only: true })).toContain('manual_only resources must have auto_select_allowed=false')
  })
  it('accepts a well-formed promotion proposal', () => {
    expect(validatePromotionPayload(promotionPayload)).toEqual([])
  })
})

describe('performArsenalAction — approve (promotion)', () => {
  it('promotes into registry + capability index + platoon map + history + queue atomically', () => {
    const result = performArsenalAction({ action: 'approve', resourceId: 'rq-pending-newlib', root, actor: 'tester', payload: { promotion: promotionPayload } })
    expect(result.ok).toBe(true)
    expect(result.updatedFiles).toEqual(expect.arrayContaining([
      'agentos_resource_registry.json',
      'agentos_capability_index.json',
      'agentos_overlap_policy.json',
      'agentos_platoon_resource_map.json',
      'agentos_promotion_history.json',
      'agentos_resource_review_queue.json',
    ]))

    const registry = getAiResourceRegistry(root)
    const promoted = registry.resources.find(r => r.id === 'res-new-tactical-lib')
    expect(promoted).toBeTruthy()
    expect(promoted?.score).toBe(71)
    expect(promoted?.auditStatus).toBe('KEEP')
    expect(promoted?.preferredPlatoon).toBe('game-platoon')
    expect(promoted?.authoritative).toBe(true)

    // Capability index now routes tactical-encounters through the new provider too.
    const tactical = recommendAiResources(['tactical-encounters'], 6, root)
    expect(tactical.map(r => r.id)).toContain('res-new-tactical-lib')

    // Review item approved with batch id.
    const item = reviewQueueItems(root).find(i => i.review_id === 'rq-pending-newlib')
    expect(item?.review_status).toBe('APPROVED')
    expect(item?.pending).toBe(false)
    expect(item?.promotion_batch_id).toMatch(/^promo-/)

    // History records prior/new state + batch.
    const history = getAiPromotionHistory(root)
    expect(history[1].promotionBatchId).toBe(item.promotion_batch_id)
    expect(history[1].approvedResources).toEqual(['res-new-tactical-lib'])
    expect(history[1].previousState?.resources).toBe(4)
    expect(history[1].newState?.resources).toBe(5)

    // Physical layout untouched — no moves, deletes, or renames.
    const rest = [...registryResources(root).map(r => r.stable_id)]
    expect(rest).toContain('res-tactical-wesnoth-framework')
    expect(rest).toContain('res-gdev-ai')
  })

  it('fails atomically when the promotion payload is invalid — no file changes', () => {
    const snapshots = new Map<string, string>()
    for (const name of ['agentos_resource_registry.json', 'agentos_capability_index.json', 'agentos_promotion_history.json', 'agentos_resource_review_queue.json']) {
      snapshots.set(name, read(root, '_CATALOG/' + name))
    }
    expect(() => performArsenalAction({ action: 'approve', resourceId: 'rq-pending-newlib', root, payload: { promotion: { name: 'x', primary_capability: 'y', audit_status: 'REJECT' } } }))
      .toThrowError(/audit_status must be one of/)
    for (const [name, content] of snapshots) {
      expect(read(root, '_CATALOG/' + name)).toBe(content)
    }
  })

  it('refuses to promote a resource that is already registered', () => {
    expect(() => performArsenalAction({
      action: 'approve',
      resourceId: 'rq-pending-weak-skill',
      root,
      payload: { promotion: { name: 'dup', display_name: 'dup', primary_capability: 'tactical-encounters', stable_id: 'res-tactical-wesnoth-framework', quality_score: 10 } },
    })).toThrowError(/already registered/)
  })
})

describe('performArsenalAction — reject / dismiss / manual-only / deep review', () => {
  it('reject only touches the review queue', () => {
    const result = performArsenalAction({ action: 'reject', resourceId: 'rq-pending-weak-skill', root, payload: { reason: 'stale, superseded by Lux' } })
    expect(result.updatedFiles).toEqual(['agentos_resource_review_queue.json'])
    const item = reviewQueueItems(root).find(i => i.review_id === 'rq-pending-weak-skill')
    expect(item?.review_status).toBe('REJECTED')
    expect(item?.pending).toBe(false)
    expect(item?.rejection_reason).toBe('stale, superseded by Lux')
  })

  it('dismiss-duplicate only touches the review queue', () => {
    const result = performArsenalAction({ action: 'dismiss-duplicate', resourceId: 'rq-pending-weak-skill', root, payload: { reason: 'duplicate of weak-skill-2' } })
    expect(result.updatedFiles).toEqual(['agentos_resource_review_queue.json'])
    expect(reviewQueueItems(root).find(i => i.review_id === 'rq-pending-weak-skill')?.review_status).toBe('DISMISSED_DUPLICATE')
  })

  it('mark-manual-only flips registry + capability index to non-auto-selectable', () => {
    const result = performArsenalAction({ action: 'mark-manual-only', resourceId: 'res-tactical-boardgame-io', root, payload: { reason: 'keep as reference only' } })
    expect(result.updatedFiles).toEqual(expect.arrayContaining(['agentos_resource_registry.json', 'agentos_capability_index.json']))
    const registry = getAiResourceRegistry(root)
    const resource = registry.resources.find(r => r.id === 'res-tactical-boardgame-io')
    expect(resource?.manualOnly).toBe(true)
    expect(resource?.autoSelectAllowed).toBe(false)
    const index = JSON.parse(read(root, '_CATALOG/agentos_capability_index.json'))
    const entry = index.capabilities['turn-state-engine'].find((e: any) => e.resource_id === 'res-tactical-boardgame-io')
    expect(entry.auto_select_allowed).toBe(false)
    expect(entry.usage).toBe('reference-only')
    // No longer auto-selected.
    expect(recommendAiResources(['turn-state-engine'], 6, root).some(r => r.id === 'res-tactical-boardgame-io')).toBe(false)
  })

  it('request-deep-review marks the item and records delegation metadata (not Freebuff-hardcoded)', () => {
    const result = performArsenalAction({ action: 'request-deep-review', resourceId: 'rq-pending-newlib', root, payload: { reviewer: 'squad-reviewer-alpha' } })
    expect(result.updatedFiles).toEqual(['agentos_resource_review_queue.json'])
    const item = reviewQueueItems(root).find(i => i.review_id === 'rq-pending-newlib')
    expect(item?.review_status).toBe('DEEP_REVIEW_REQUESTED')
    expect(item?.deep_review.required_capability).toBe('resource-deep-review')
    expect(item?.deep_review.status).toBe('queued')
    expect(item?.deep_review.reviewer).toBe('squad-reviewer-alpha')
    expect(item?.deep_review.requested_by).toBe('agentos')
  })

  it('approve-supersession updates overlap policy + history', () => {
    const result = performArsenalAction({ action: 'approve-supersession', resourceId: 'res-project-tactics-standin', root, payload: { preferredResourceId: 'res-tactical-wesnoth-framework', reason: 'hex engine supersedes prototype' } })
    expect(result.updatedFiles).toEqual(expect.arrayContaining(['agentos_overlap_policy.json', 'agentos_promotion_history.json']))
    const policy = JSON.parse(read(root, '_CATALOG/agentos_overlap_policy.json'))
    // Loser is not registered, so the winning engine's existing tactical group records the supersession.
    const group = policy.groups.find((g: any) => g.group_id === 'grp-tactical-engines')
    expect(group).toBeTruthy()
    expect(group.supersedes).toBe(true)
    expect(group.archive_candidates).toContain('res-project-tactics-standin')
  })

  it('rescan-changed proposes NEW candidates into the queue but never mutates canonical audit files', () => {
    write(root, 'Repositories/BrandNewThing/README.md', '# BrandNewThing\nA brand new sprite animation tool for tactical games.')
    const before = new Map(
      ['agentos_resource_registry.json', 'agentos_capability_index.json', 'agentos_overlap_policy.json', 'agentos_platoon_resource_map.json']
        .map(name => [name, read(root, '_CATALOG/' + name)] as [string, string])
    )
    const result = performArsenalAction({ action: 'rescan-changed', resourceId: 'ignored', root })
    expect(result.detail?.new).toBeTruthy()
    expect(reviewQueueItems(root).some(i => i.probable_name === 'BrandNewThing')).toBe(true)
    for (const [name, content] of before) {
      expect(read(root, '_CATALOG/' + name)).toBe(content)
    }
  })

  it('rejects unknown actions and requires a root that exists', () => {
    expect(() => performArsenalAction({ action: 'bogus' as never, resourceId: 'x', root })).toThrowError(/Unknown arsenal action/)
    expect(() => performArsenalAction({ action: 'reject', resourceId: 'x', root: tmpRoot() })).toThrowError(/AI vault root does not exist|_CATALOG/)
  })

  it('can approve a candidate directly even when it is not in the review queue', () => {
    const result = performArsenalAction({ action: 'approve', resourceId: 'direct-candidate', root, payload: { promotion: { ...promotionPayload, name: 'direct-candidate', display_name: 'direct-candidate' } } })
    expect(result.ok).toBe(true)
    expect(getAiResourceRegistry(root).resources.some(r => r.id === 'res-direct-candidate')).toBe(true)
  })

  it('refuses to act twice on a finalized review item', () => {
    expect(() => performArsenalAction({ action: 'reject', resourceId: 'rq-decided-pt', root })).toThrowError(/already in state APPROVED/)
  })

  it('parses the review queue including decided and pending items', () => {
    const queue = getAiReviewQueue(root)
    expect(queue.length).toBe(3)
    expect(queue.filter(i => i.pending).length).toBe(2)
    expect(queue.find(i => i.reviewId === 'rq-decided-pt')?.reviewStatus).toBe('APPROVED')
  })
})