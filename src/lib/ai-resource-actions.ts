import fs from 'node:fs'
import path from 'node:path'
import { config } from './config'
import { scanAiVault } from './ai-resource-registry'

/**
 * Phase 9 — AI Arsenal approval action model.
 *
 * Controlled backend mutations only: every action validates its payload
 * against the canonical schemas, builds ALL target documents in memory,
 * validates them, then writes with backup + atomic rename. Registry /
 * index / policy / map files are only touched when the promotion payload
 * is structurally valid. No physical moves ever happen here, and
 * canonical audit files are never edited in place without a backup.
 */

export type ArsenalAction =
  | 'approve'
  | 'reject'
  | 'mark-manual-only'
  | 'approve-supersession'
  | 'dismiss-duplicate'
  | 'request-deep-review'
  | 'rescan-changed'

export interface ArsenalActionDescriptor {
  id: ArsenalAction
  label: string
  description: string
}

export const ARSENAL_ACTIONS: ArsenalActionDescriptor[] = [
  { id: 'approve', label: 'Approve', description: 'Promote a candidate into the registry, capability index, platoon map, and history (validated, atomic).' },
  { id: 'reject', label: 'Reject', description: 'Reject a review-queue candidate. No registry change.' },
  { id: 'mark-manual-only', label: 'Manual-only', description: 'Keep in registry but never auto-select (auto_select_allowed=false, manual_only=true).' },
  { id: 'approve-supersession', label: 'Approve supersession', description: 'Mark a resource superseded by a preferred one in the overlap policy.' },
  { id: 'dismiss-duplicate', label: 'Dismiss duplicate', description: 'Dismiss a review-queue candidate as a duplicate. No registry change.' },
  { id: 'request-deep-review', label: 'Request deep review', description: 'Queue a structured deep-review request. AgentOS delegates it to the most qualified reviewer for the resource-deep-review capability; reviewers are not hard-coded.' },
  { id: 'rescan-changed', label: 'Rescan changed', description: 'Heuristic scan vs canonical registry; NEW candidates are proposed into the review queue. Registry/index/policy/map untouched.' },
]

export interface ArsenalActionPayload {
  reason?: string
  reviewer?: string
  /** Structured promotion proposal used by `approve` (canonical registry shape). */
  promotion?: Record<string, unknown>
  /** Winner stable_id for `approve-supersession`. */
  preferredResourceId?: string
}

export interface ArsenalActionResult {
  ok: boolean
  action: ArsenalAction
  resourceId: string
  updatedFiles: string[]
  message: string
  detail?: Record<string, unknown>
}

const FINAL_REVIEW_STATES = new Set(['APPROVED', 'REJECTED', 'DISMISSED_DUPLICATE', 'MANUAL_ONLY'])
const VALID_AUDIT_STATUS = new Set(['KEEP', 'KEEP-SECONDARY', 'REFERENCE'])

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'resource'
}
function nowIso(): string { return new Date().toISOString() }

const catalogFile = (catalog: string, name: string) => path.join(catalog, name)

/** Find a review-queue item by reviewId, probableName, or path suffix. */
function findQueueItem(items: any[], resourceId: string): any | null {
  const needle = resourceId.toLowerCase()
  return items.find(item => {
    const candidates = [item.review_id, item.probable_name, item.path, item.stable_id]
    return candidates.some(candidate => typeof candidate === 'string' && candidate.toLowerCase() === needle)
  }) || items.find(item => {
    const candidates = [item.review_id, item.probable_name, item.path]
    return candidates.some(candidate => typeof candidate === 'string' && candidate.toLowerCase().endsWith(needle))
  }) || null
}

function requirePending(item: any | null, resourceId: string): void {
  if (!item) throw new Error('Review-queue candidate not found: ' + resourceId)
  const status = String(item.review_status || 'PENDING').toUpperCase()
  if (item.pending === false || FINAL_REVIEW_STATES.has(status)) {
    throw new Error('Review item ' + resourceId + ' is already in state ' + status)
  }
}

/** Validate an `approve` promotion payload against the canonical registry schema. */
export function validatePromotionPayload(payload: unknown): string[] {
  const errors: string[] = []
  if (!payload || typeof payload !== 'object') return ['promotion payload is required']
  const p = payload as Record<string, unknown>
  if (!p.name && !p.display_name) errors.push('name/display_name is required')
  const audit = String(p.audit_status || '').toUpperCase()
  if (audit && !VALID_AUDIT_STATUS.has(audit)) errors.push(`audit_status must be one of ${[...VALID_AUDIT_STATUS].join(', ')} (got "${audit}")`)
  if (!p.primary_capability || typeof p.primary_capability !== 'string') errors.push('primary_capability is required')
  if (p.quality_score !== undefined && typeof p.quality_score !== 'number') errors.push('quality_score must be a number')
  if (p.manual_only === true && p.auto_select_allowed !== false) errors.push('manual_only resources must have auto_select_allowed=false')
  return errors
}

type PlannedUpdate = Map<string, string>

// ---------------------------------------------------------------------------
// Action planners — each returns in-memory file updates (JSON strings)
// ---------------------------------------------------------------------------

function planApprove(catalog: string, resourceId: string, actor: string | null, payload: ArsenalActionPayload): { updates: PlannedUpdate; message: string; detail: Record<string, unknown> } {
  if (!payload.promotion) throw new Error('approve requires a structured payload.promotion (deep-review proposal)')
  const errors = validatePromotionPayload(payload.promotion)
  if (errors.length) throw new Error('Invalid promotion payload: ' + errors.join('; '))

  const registryDoc = readJson(catalogFile(catalog, 'agentos_resource_registry.json'))
  if (!registryDoc || !Array.isArray(registryDoc.resources)) throw new Error('Registry is missing or malformed: agentos_resource_registry.json')
  const indexDoc = readJson(catalogFile(catalog, 'agentos_capability_index.json'))
  const policyDoc = readJson(catalogFile(catalog, 'agentos_overlap_policy.json'))
  const platoonDoc = readJson(catalogFile(catalog, 'agentos_platoon_resource_map.json'))
  const changesDoc = readJson(catalogFile(catalog, 'agentos_resource_changes.json'))
  const queueDoc = readJson(catalogFile(catalog, 'agentos_resource_review_queue.json'))
  const historyDoc = readJson(catalogFile(catalog, 'agentos_promotion_history.json'))

  const raw = payload.promotion as Record<string, unknown>
  const displayName = String(raw.display_name || raw.name || '')
  const stableId = String(raw.stable_id || 'res-' + slug(String(raw.name || raw.display_name || '')))
  const registryResources = registryDoc.resources as any[]
  if (registryResources.some(r => String(r.stable_id) === stableId)) throw new Error('Resource already registered: ' + stableId)
  const manualOnly = raw.manual_only === true
  const resource = {
    ...raw,
    stable_id: stableId,
    name: String(raw.name || displayName),
    audit_status: String(raw.audit_status || (manualOnly ? 'REFERENCE' : 'KEEP')).toUpperCase(),
    auto_select_allowed: manualOnly ? false : (raw.auto_select_allowed !== false),
    manual_only: manualOnly,
    promoted_by: actor || 'agentos',
    promoted_at: nowIso(),
  }

  const updates: PlannedUpdate = new Map()

  // 1. Registry
  registryResources.push(resource)
  updates.set('agentos_resource_registry.json', JSON.stringify(registryDoc, null, 2) + '\n')

  // 2. Capability index — always add provider entries (never flip PARTIALLY_COVERED).
  const capabilitiesBeforeCount = indexDoc && indexDoc.capabilities && typeof indexDoc.capabilities === 'object' ? Object.keys(indexDoc.capabilities).length : 0
  const addedCapabilities = new Set<string>()
  if (indexDoc && indexDoc.capabilities && typeof indexDoc.capabilities === 'object') {
    const capabilities: Record<string, unknown[]> = indexDoc.capabilities as Record<string, unknown[]>
    const primary = String(raw.primary_capability)
    const secondaries = Array.isArray(raw.secondary_capabilities) ? raw.secondary_capabilities.map(String) : []
    const addEntry = (capability: string, usage: string) => {
      if (!capability) return
      if (!Array.isArray(capabilities[capability])) { capabilities[capability] = []; addedCapabilities.add(capability) }
      if (capabilities[capability].some((e: any) => String(e?.resource_id) === stableId)) return
      capabilities[capability].push({
        resource_id: stableId,
        score: typeof raw.quality_score === 'number' ? raw.quality_score : null,
        status: resource.audit_status,
        auto_select_allowed: resource.auto_select_allowed,
        usage,
        note: raw.notes ? String(raw.notes) : null,
      })
    }
    addEntry(primary, manualOnly ? 'reference-only' : 'preferred')
    for (const secondary of secondaries) addEntry(secondary, manualOnly ? 'reference-only' : 'secondary')
    updates.set('agentos_capability_index.json', JSON.stringify(indexDoc, null, 2) + '\n')
  }

  // 3. Overlap policy — attach to an existing group only when the proposal says so.
  const overlapNotes: string[] = []
  if (Array.isArray(payload.promotion.overlap_group_id) || typeof payload.promotion.overlap_group_id === 'string') {
    const groupId = String(payload.promotion.overlap_group_id)
    if (policyDoc && Array.isArray(policyDoc.groups)) {
      const group = policyDoc.groups.find((g: any) => String(g?.group_id) === groupId)
      if (group) {
        if (!Array.isArray(group.secondary_resources)) group.secondary_resources = []
        if (!group.secondary_resources.includes(stableId)) group.secondary_resources.push(stableId)
        overlapNotes.push(groupId + ': added ' + stableId + ' as secondary')
        updates.set('agentos_overlap_policy.json', JSON.stringify(policyDoc, null, 2) + '\n')
      } else {
        overlapNotes.push(groupId + ': group not found, overlap policy untouched')
      }
    }
  }

  // 4. Platoon map
  const platoonMappings: string[] = []
  const suggestedPlatoon = String(raw.preferred_platoon || '')
  const suggestedRole = String(raw.preferred_specialist_role || '')
  if (platoonDoc && Array.isArray(platoonDoc.platoons) && suggestedPlatoon) {
    const platoon = platoonDoc.platoons.find((p: any) => String(p?.platoon).toLowerCase() === suggestedPlatoon.toLowerCase())
    if (platoon && Array.isArray(platoon.roles)) {
      let role = suggestedRole ? platoon.roles.find((r: any) => String(r?.role).toLowerCase() === suggestedRole.toLowerCase()) : platoon.roles[0]
      if (!role && suggestedRole) { role = { role: suggestedRole, resources: [] }; platoon.roles.push(role) }
      if (role) {
        if (!Array.isArray(role.resources)) role.resources = []
        if (!role.resources.some((r: any) => String(r?.resource_id) === stableId)) {
          role.resources.push({ resource_id: stableId, score: typeof raw.quality_score === 'number' ? raw.quality_score : null, usage: raw.usage ? String(raw.usage) : 'preferred', path: raw.relative_path ? String(raw.relative_path) : null, auto_select_allowed: resource.auto_select_allowed })
        }
        platoonMappings.push(String(platoon.platoon) + ' -> ' + String(role.role) + ' -> ' + stableId)
      }
    }
    updates.set('agentos_platoon_resource_map.json', JSON.stringify(platoonDoc, null, 2) + '\n')
  }

  // 5. Changes file — move from new/changed into promoted (read-only otherwise).
  if (changesDoc) {
    for (const key of ['new', 'changed'] as const) {
      if (Array.isArray(changesDoc[key])) {
        const from = changesDoc[key].filter((v: unknown) => String(v) !== stableId)
        if (from.length !== changesDoc[key].length) {
          changesDoc[key] = from
          const changesState = changesDoc as Record<string, any>
          if (!Array.isArray(changesState.promoted)) changesState.promoted = []
          changesState.promoted.push(stableId)
          updates.set('agentos_resource_changes.json', JSON.stringify(changesDoc, null, 2) + '\n')
          break
        }
      }
    }
  }

  // 6. Review queue — mark candidate approved.
  const queueItems = Array.isArray(queueDoc?.items) ? queueDoc.items as any[] : []
  const item = findQueueItem(queueItems, resourceId)
  if (item) requirePending(item, resourceId)
  if (item && queueDoc) {
    item.review_status = 'APPROVED'
    item.pending = false
    item.approved_at = nowIso()
    item.final_approved_decision = 'ADD_AS_' + resource.audit_status.replace('-', '_')
    item.promotion_batch_id = buildPromotionBatchId(historyDoc)
    updates.set('agentos_resource_review_queue.json', JSON.stringify(queueDoc, null, 2) + '\n')
  }

  // 7. Promotion history
  const batchId = buildPromotionBatchId(historyDoc)
  const before = {
    resources: registryResources.length - 1,
    overlapGroups: Array.isArray(policyDoc?.groups) ? policyDoc.groups.length : 0,
    capabilities: capabilitiesBeforeCount,
  }
  const after = {
    resources: registryResources.length,
    overlapGroups: Array.isArray(policyDoc?.groups) ? policyDoc.groups.length : 0,
    capabilities: capabilitiesBeforeCount + addedCapabilities.size,
  }
  if (historyDoc) {
    const history = historyDoc as Record<string, any>
    if (!Array.isArray(history.promotions)) history.promotions = []
    history.promotions.push({
      promotion_batch_id: batchId,
      approved_at: nowIso(),
      approved_resources: [stableId],
      previous_state: before,
      new_state: after,
      capabilities_added: [String(raw.primary_capability), ...(Array.isArray(raw.secondary_capabilities) ? raw.secondary_capabilities.map(String) : [])].filter(Boolean),
      overlap_changes: overlapNotes,
      platoon_mappings: platoonMappings,
      reviewer_decision: 'APPROVED via AgentOS AI Arsenal action (actor: ' + (actor || 'agentos') + ')',
      warnings: raw.manual_only === true ? [stableId + ' is manual-only/reference; never auto-selected'] : [],
    })
    updates.set('agentos_promotion_history.json', JSON.stringify(historyDoc, null, 2) + '\n')
  }

  return {
    updates,
    message: 'Promoted ' + stableId + ' into registry + capability index' + (platoonMappings.length ? ' + platoon map' : ''),
    detail: { stable_id: stableId, promotionBatchId: batchId, platoonMappings, overlapNotes },
  }
}

function planQueueDecision(catalog: string, resourceId: string, actor: string | null, payload: ArsenalActionPayload, decision: 'REJECTED' | 'DISMISSED_DUPLICATE'): { updates: PlannedUpdate; message: string; detail: Record<string, unknown> } {
  const queueDoc = readJson(catalogFile(catalog, 'agentos_resource_review_queue.json'))
  if (!queueDoc || !Array.isArray(queueDoc.items)) throw new Error('Review queue is missing or malformed: agentos_resource_review_queue.json')
  const item = findQueueItem(queueDoc.items, resourceId)
  requirePending(item, resourceId)
  item.review_status = decision
  item.pending = false
  if (decision === 'REJECTED') item.rejection_reason = payload.reason || null
  else item.dismissal_reason = payload.reason || null
  item.decided_at = nowIso()
  item.decided_by = actor || 'agentos'
  const updates: PlannedUpdate = new Map()
  updates.set('agentos_resource_review_queue.json', JSON.stringify(queueDoc, null, 2) + '\n')
  return { updates, message: 'Marked review item ' + item.review_id + ' as ' + decision.toLowerCase().replace('_', ' '), detail: { reviewId: item.review_id } }
}

function planMarkManualOnly(catalog: string, resourceId: string, actor: string | null, payload: ArsenalActionPayload): { updates: PlannedUpdate; message: string; detail: Record<string, unknown> } {
  const updates: PlannedUpdate = new Map()
  const registryDoc = readJson(catalogFile(catalog, 'agentos_resource_registry.json'))
  const indexDoc = readJson(catalogFile(catalog, 'agentos_capability_index.json'))
  const queueDoc = readJson(catalogFile(catalog, 'agentos_resource_review_queue.json'))
  let touchedRegistry = false
  if (registryDoc && Array.isArray(registryDoc.resources)) {
    const resource = registryDoc.resources.find((r: any) => String(r?.stable_id) === resourceId || String(r?.name) === resourceId)
    if (resource) {
      resource.manual_only = true
      resource.auto_select_allowed = false
      if (resource.audit_status === 'KEEP' || resource.audit_status === 'KEEP-SECONDARY') {
        resource.audit_status = 'REFERENCE'
        resource.manual_only_note = payload.reason || 'Marked manual-only via AgentOS'
      }
      updates.set('agentos_resource_registry.json', JSON.stringify(registryDoc, null, 2) + '\n')
      touchedRegistry = true
    }
  }
  if (indexDoc && indexDoc.capabilities && typeof indexDoc.capabilities === 'object') {
    let changed = false
    for (const entries of Object.values(indexDoc.capabilities) as any[]) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (entry && String(entry.resource_id) === resourceId && (entry.auto_select_allowed === true || entry.usage !== 'reference-only')) {
          entry.auto_select_allowed = false
          entry.usage = 'reference-only'
          changed = true
        }
      }
    }
    if (changed) updates.set('agentos_capability_index.json', JSON.stringify(indexDoc, null, 2) + '\n')
  }
  const queueItems = Array.isArray(queueDoc?.items) ? queueDoc.items as any[] : []
  const item = findQueueItem(queueItems, resourceId)
  if (item && queueDoc) {
    if (item.pending !== false && !FINAL_REVIEW_STATES.has(String(item.review_status || 'PENDING').toUpperCase())) {
      item.review_status = 'MANUAL_ONLY'
      item.pending = false
      item.final_approved_decision = 'ADD_AS_REFERENCE (manual-only)'
      item.decided_at = nowIso()
      updates.set('agentos_resource_review_queue.json', JSON.stringify(queueDoc, null, 2) + '\n')
    }
  }
  if (!touchedRegistry && !item) throw new Error('No registry resource or review candidate found: ' + resourceId)
  return { updates, message: 'Marked ' + resourceId + ' manual-only (never auto-selected)', detail: { registryUpdated: touchedRegistry } }
}

function planApproveSupersession(catalog: string, resourceId: string, actor: string | null, payload: ArsenalActionPayload): { updates: PlannedUpdate; message: string; detail: Record<string, unknown> } {
  const winner = String(payload.preferredResourceId || '')
  if (!winner) throw new Error('approve-supersession requires payload.preferredResourceId (the winning resource)')
  const loser = resourceId
  const updates: PlannedUpdate = new Map()
  const registryDoc = readJson(catalogFile(catalog, 'agentos_resource_registry.json'))
  const policyDoc = readJson(catalogFile(catalog, 'agentos_overlap_policy.json'))
  const historyDoc = readJson(catalogFile(catalog, 'agentos_promotion_history.json'))
  const queueDoc = readJson(catalogFile(catalog, 'agentos_resource_review_queue.json'))

  if (registryDoc && Array.isArray(registryDoc.resources)) {
    const resource = registryDoc.resources.find((r: any) => String(r?.stable_id) === loser)
    if (resource) {
      resource.superseded_by = Array.isArray(resource.superseded_by) && !resource.superseded_by.includes(winner) ? [...resource.superseded_by, winner] : [winner]
      updates.set('agentos_resource_registry.json', JSON.stringify(registryDoc, null, 2) + '\n')
    }
  }

  const idPrefixMatch = (id: string, needle: string) => String(id).toLowerCase() === needle.toLowerCase() || String(id).toLowerCase().startsWith(needle.toLowerCase())
  let groupNote = ''
  if (policyDoc && Array.isArray(policyDoc.groups)) {
    let group = policyDoc.groups.find((g: any) => {
      const ids = [g?.preferred_resource, ...(Array.isArray(g?.secondary_resources) ? g.secondary_resources : []), ...(Array.isArray(g?.archive_candidates) ? g.archive_candidates : []), ...(Array.isArray(g?.rejected_resources) ? g.rejected_resources : [])]
      return ids.some((id: unknown) => id && (idPrefixMatch(String(id), loser) || idPrefixMatch(String(id), winner)))
    })
    if (!group) {
      group = { group_id: 'grp-supersession-' + slug(loser), capability: payload.reason || 'supersession', preferred_resource: winner, secondary_resources: [], archive_candidates: [], rejected_resources: [], exact_duplicate: false, near_duplicate: true, complementary: false, supersedes: true, why_preferred_wins: '' }
      policyDoc.groups.push(group)
    }
    group.supersedes = true
    if (idPrefixMatch(String(group.preferred_resource || ''), loser)) group.preferred_resource = winner
    if (!Array.isArray(group.secondary_resources)) group.secondary_resources = []
    if (!group.secondary_resources.some((id: unknown) => id && idPrefixMatch(String(id), winner))) group.secondary_resources.unshift(winner)
    if (!Array.isArray(group.archive_candidates)) group.archive_candidates = []
    if (!group.archive_candidates.includes(loser)) group.archive_candidates.push(loser)
    if (group.why_preferred_wins) group.why_preferred_wins = String(group.why_preferred_wins) + ' ' + winner + ' supersedes ' + loser + ' (approved via AgentOS).'
    else group.why_preferred_wins = winner + ' supersedes ' + loser + ' (approved via AgentOS).'
    groupNote = 'grp-' + String(group.group_id)
    updates.set('agentos_overlap_policy.json', JSON.stringify(policyDoc, null, 2) + '\n')
  }

  if (historyDoc) {
    const history = historyDoc as Record<string, any>
    if (!Array.isArray(history.promotions)) history.promotions = []
    history.promotions.push({
      promotion_batch_id: 'promo-supersession-' + slug(loser) + '-' + nowIso().slice(0, 10),
      approved_at: nowIso(),
      approved_resources: [winner],
      previous_state: null,
      new_state: null,
      capabilities_added: [],
      overlap_changes: [winner + ' supersedes ' + loser + (groupNote ? ' (' + groupNote + ')' : '')],
      platoon_mappings: [],
      reviewer_decision: 'SUPERSESSION APPROVED via AgentOS (actor: ' + (actor || 'agentos') + ')',
      warnings: [],
    })
    updates.set('agentos_promotion_history.json', JSON.stringify(historyDoc, null, 2) + '\n')
  }

  const queueItems = Array.isArray(queueDoc?.items) ? queueDoc.items as any[] : []
  const item = findQueueItem(queueItems, loser)
  if (item && queueDoc && item.pending !== false && !FINAL_REVIEW_STATES.has(String(item.review_status || 'PENDING').toUpperCase())) {
    item.review_status = 'APPROVED'
    item.pending = false
    updates.set('agentos_resource_review_queue.json', JSON.stringify(queueDoc, null, 2) + '\n')
  }

  return { updates, message: winner + ' now supersedes ' + loser, detail: { winner, loser, overlapGroup: groupNote || null } }
}

function planRequestDeepReview(catalog: string, resourceId: string, actor: string | null, payload: ArsenalActionPayload): { updates: PlannedUpdate; message: string; detail: Record<string, unknown> } {
  const queueDoc = readJson(catalogFile(catalog, 'agentos_resource_review_queue.json'))
  if (!queueDoc || !Array.isArray(queueDoc.items)) throw new Error('Review queue is missing or malformed: agentos_resource_review_queue.json')
  let item = findQueueItem(queueDoc.items, resourceId)
  if (!item) {
    if (!payload.promotion) throw new Error('No review-queue item found for ' + resourceId + '; pass payload.promotion with probable_name/path to create one')
    const probableName = String(payload.promotion.probable_name || payload.promotion.name || resourceId)
    const probablePath = String(payload.promotion.path || payload.promotion.relative_path || '')
    item = {
      review_id: 'rq-scan-' + nowIso().slice(0, 10).replace(/-/g, '-') + '-' + slug(probableName),
      detected_state: 'NEW',
      path: probablePath,
      probable_resource_type: payload.promotion.resource_type || null,
      probable_name: probableName,
      probable_source_repo: payload.promotion.source_repo || null,
      detected_capabilities: Array.isArray(payload.promotion.detected_capabilities) ? payload.promotion.detected_capabilities.map(String) : [],
      inferred_primary_capability: payload.promotion.primary_capability || null,
      covers_capability_gaps: [],
      likely_overlaps: [],
      likely_duplicates: [],
      current_competing_resources: [],
      preliminary_quality_score: typeof payload.promotion.preliminary_quality_score === 'number' ? payload.promotion.preliminary_quality_score : null,
      preliminary_agentos_relevance: null,
      suggested_platoon: null,
      suggested_specialist_role: null,
      runtime_path_risks: [],
      recommended_action: 'NEEDS_DEEP_REVIEW',
      high_priority_gap: null,
      review_status: 'DEEP_REVIEW_REQUESTED',
      pending: true,
    }
    queueDoc.items.push(item)
  } else {
    requirePending(item, resourceId)
    item.review_status = 'DEEP_REVIEW_REQUESTED'
  }
  item.deep_review = {
    required_capability: String(payload.promotion?.required_capability || 'resource-deep-review'),
    status: 'queued',
    requested_at: nowIso(),
    requested_by: actor || 'agentos',
    reviewer: payload.reviewer || null,
  }
  const updates: PlannedUpdate = new Map()
  updates.set('agentos_resource_review_queue.json', JSON.stringify(queueDoc, null, 2) + '\n')
  return {
    updates,
    message: 'Deep-review request queued for ' + (item.probable_name || resourceId) + ' (delegated via resource-deep-review capability)',
    detail: { reviewId: item.review_id, requiredCapability: 'resource-deep-review', reviewer: payload.reviewer || null },
  }
}

function planRescanChanged(catalog: string, root: string, resourceId: string): { updates: PlannedUpdate; message: string; detail: Record<string, unknown> } {
  const registryDoc = readJson(catalogFile(catalog, 'agentos_resource_registry.json'))
  if (!registryDoc || !Array.isArray(registryDoc.resources)) throw new Error('Registry is missing or malformed: agentos_resource_registry.json')
  const canonicalNames = new Set(registryDoc.resources.map((r: any) => String(r?.name || r?.display_name || '').toLowerCase()).filter(Boolean))
  const canonicalByPath = new Map(registryDoc.resources.map((r: any) => [String(r?.relative_path || '').toLowerCase().replace(/\\/g, '/'), String(r?.stable_id || '')]))
  const scanned = scanAiVault(root, false)
  const newCandidates: any[] = []
  const changedCandidateIds: string[] = []
  for (const record of scanned.resources) {
    if (record.relativePath === '.agents') continue
    const rel = record.relativePath.toLowerCase().replace(/\\/g, '/')
    if (canonicalByPath.has(rel)) continue
    if (canonicalNames.has(record.name.toLowerCase())) { changedCandidateIds.push(record.name); continue }
    newCandidates.push(record)
  }
  if (newCandidates.length + changedCandidateIds.length === 0) {
    return { updates: new Map(), message: 'Rescan: no new or changed candidates detected', detail: { new: [], changed: changedCandidateIds, missing: [] } }
  }
  const queueDoc = readJson(catalogFile(catalog, 'agentos_resource_review_queue.json')) || { generated: nowIso(), scan_id: 'scan-agentos-' + nowIso().slice(0, 10), purpose: 'Review queue for NEW or materially CHANGED resources. Proposals only; APPROVED history is preserved.', items: [] as any[] }
  if (!Array.isArray(queueDoc.items)) queueDoc.items = []
  const queueItems = queueDoc.items as unknown[]
  const existingIds = new Set(queueItems.map((i: any) => String(i.review_id || '')))
  const pendingItemIds: string[] = []
  for (const candidate of newCandidates) {
    const reviewId = 'rq-scan-' + slug(candidate.name) + '-' + nowIso().replace(/[:.]/g, '').slice(4, 16)
    if (existingIds.has(reviewId)) continue
    queueItems.push({
      review_id: reviewId,
      detected_state: 'NEW',
      path: candidate.relativePath,
      probable_resource_type: candidate.type,
      probable_name: candidate.name,
      probable_source_repo: candidate.gitRemote,
      detected_capabilities: candidate.capabilities,
      inferred_primary_capability: candidate.primaryCapability,
      covers_capability_gaps: [],
      likely_overlaps: [],
      likely_duplicates: [],
      current_competing_resources: [],
      preliminary_quality_score: candidate.score,
      preliminary_agentos_relevance: candidate.score >= 75 ? 'HIGH' : candidate.score >= 55 ? 'MEDIUM' : 'LOW',
      suggested_platoon: null,
      suggested_specialist_role: null,
      runtime_path_risks: [],
      recommended_action: 'NEEDS_DEEP_REVIEW',
      high_priority_gap: null,
      readme_snippet: candidate.description.slice(0, 180),
      review_status: 'PENDING',
      pending: true,
    })
    existingIds.add(reviewId)
    pendingItemIds.push(reviewId)
  }
  queueDoc.generated = nowIso()
  queueDoc.scan_id = 'scan-agentos-rescan-' + nowIso().slice(0, 10)
  const updates: PlannedUpdate = new Map()
  updates.set('agentos_resource_review_queue.json', JSON.stringify(queueDoc, null, 2) + '\n')
  return {
    updates,
    message: 'Rescan proposed ' + pendingItemIds.length + ' new candidate(s) into the review queue (no canonical audit files touched)',
    detail: { new: pendingItemIds, changed: changedCandidateIds, missing: [] },
  }
}

function buildPromotionBatchId(historyDoc: any): string {
  const base = 'promo-' + nowIso().slice(0, 10)
  let id = base
  let n = 1
  const existing = new Set(Array.isArray(historyDoc?.promotions) ? historyDoc.promotions.map((p: any) => p.promotion_batch_id) : [])
  while (existing.has(id)) id = base + '-' + (n++)
  return id
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function performArsenalAction(input: {
  action: ArsenalAction
  resourceId: string
  root?: string
  actor?: string | null
  payload?: ArsenalActionPayload
}): ArsenalActionResult {
  const root = input.root || config.aiVaultRoot
  if (!root || !fs.existsSync(root)) throw new Error('AI vault root does not exist: ' + root)
  const catalog = path.join(root, '_CATALOG')
  if (!fs.existsSync(catalog)) throw new Error('AI vault catalog does not exist: ' + catalog)
  const resourceId = String(input.resourceId || '').trim()
  if (!resourceId) throw new Error('resourceId is required')
  const actor = input.actor || null
  const payload: ArsenalActionPayload = input.payload || {}
  if (payload.reason !== undefined && typeof payload.reason !== 'string') throw new Error('payload.reason must be a string')
  if (payload.reviewer !== undefined && typeof payload.reviewer !== 'string') throw new Error('payload.reviewer must be a string')
  if (payload.preferredResourceId !== undefined && typeof payload.preferredResourceId !== 'string') throw new Error('payload.preferredResourceId must be a string')

  let planned: { updates: PlannedUpdate; message: string; detail: Record<string, unknown> }
  switch (input.action) {
    case 'approve': planned = planApprove(catalog, resourceId, actor, payload); break
    case 'reject': planned = planQueueDecision(catalog, resourceId, actor, payload, 'REJECTED'); break
    case 'dismiss-duplicate': planned = planQueueDecision(catalog, resourceId, actor, payload, 'DISMISSED_DUPLICATE'); break
    case 'mark-manual-only': planned = planMarkManualOnly(catalog, resourceId, actor, payload); break
    case 'approve-supersession': planned = planApproveSupersession(catalog, resourceId, actor, payload); break
    case 'request-deep-review': planned = planRequestDeepReview(catalog, resourceId, actor, payload); break
    case 'rescan-changed': planned = planRescanChanged(catalog, root, resourceId); break
    default: throw new Error('Unknown arsenal action: ' + String(input.action))
  }

  // Validate every target document parses before touching disk.
  for (const [, content] of planned.updates) {
    JSON.parse(content)
  }
  if (planned.updates.size === 0) {
    return { ok: true, action: input.action, resourceId, updatedFiles: [], message: planned.message, detail: planned.detail }
  }

  const backupDir = path.join(catalog, '.agentos-backups', nowIso().replace(/[:.]/g, '-'))
  fs.mkdirSync(backupDir, { recursive: true })
  const written: string[] = []
  try {
    for (const [name, content] of planned.updates) {
      const file = catalogFile(catalog, name)
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backupDir, name))
      const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
      fs.writeFileSync(tmp, content, 'utf8')
      fs.renameSync(tmp, file)
      written.push(name)
    }
  } catch (err) {
    for (const name of written) {
      const file = catalogFile(catalog, name)
      const backup = path.join(backupDir, name)
      if (fs.existsSync(backup)) fs.copyFileSync(backup, file)
    }
    throw err
  }

  return { ok: true, action: input.action, resourceId, updatedFiles: written, message: planned.message, detail: planned.detail }
}