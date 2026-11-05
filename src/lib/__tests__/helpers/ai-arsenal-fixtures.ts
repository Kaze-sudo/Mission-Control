import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Shared AI Arsenal canonical-vault fixtures for registry + action tests. */

export function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-arsenal-'))
}
export function write(root: string, rel: string, content: string): string {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}
export function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}
export function rmRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true })
}

const REGISTRY_RESOURCES = [
  {
    stable_id: 'res-tactical-wesnoth-framework',
    name: 'Battle for Wesnoth (scenario framework)',
    display_name: 'Wesnoth — self-contained hex-based tactical-encounter engine + WML scenario authoring framework',
    source_repo: 'wesnoth/wesnoth',
    absolute_path: 'D:\\AI\\00_INBOX\\tactical-encounters-candidates\\wesnoth',
    relative_path: '00_INBOX/tactical-encounters-candidates/wesnoth',
    resource_type: 'engine',
    primary_capability: 'tactical-encounters',
    secondary_capabilities: ['game-development', 'game-engine', 'narrative-content', 'qa-release'],
    quality_score: 83.5,
    audit_status: 'KEEP-SECONDARY',
    agentos_relevance: 'HIGH',
    preferred_platoon: 'game-platoon',
    preferred_specialist_role: 'tactical-battles-encounter-designer',
    integration_mode: 'external-runtime-integration',
    runtime_requirements: ['C++ / SDL2 engine', 'WML scenario files'],
    move_risk: 'SAFE_TO_MOVE - evidence clone inside 00_INBOX',
    path_sensitive: false,
    auto_select_allowed: true,
    manual_only: false,
    notes: 'Approved auto-selectable tactical encounter authoring/framework provider; hex-based; does NOT provide true cover/elevation/LOS.',
  },
  {
    stable_id: 'res-tactical-oxce-reference',
    name: 'OpenXcom Extended (OXCE)',
    display_name: 'OXCE — FULL grid-tactics tactical-encounter reference implementation (X-COM lineage)',
    source_repo: 'MeridianOXC/OpenXcom',
    absolute_path: 'D:\\AI\\00_INBOX\\tactical-encounters-candidates\\oxce-openxcom',
    relative_path: '00_INBOX/tactical-encounters-candidates/oxce-openxcom',
    resource_type: 'engine',
    primary_capability: 'tactical-encounters',
    secondary_capabilities: ['combat-systems', 'game-development', 'game-engine'],
    quality_score: 79,
    audit_status: 'REFERENCE',
    agentos_relevance: 'HIGH',
    preferred_platoon: 'game-platoon',
    preferred_specialist_role: 'tactical-battles-encounter-designer',
    integration_mode: 'knowledge-reference-integration',
    runtime_requirements: ['C++ / SDL2 build chain', 'Original X-COM assets to execute'],
    move_risk: 'SAFE_TO_MOVE - evidence clone inside 00_INBOX',
    path_sensitive: false,
    auto_select_allowed: false,
    manual_only: true,
    notes: 'FULL tactical simulation reference (grid/elevation/LOS/TU economy/deployment/AI); knowledge/reference only, never an automatic runtime dependency.',
  },
  {
    stable_id: 'res-tactical-boardgame-io',
    name: 'boardgame.io',
    display_name: 'boardgame.io — turn/state/multiplayer engine for turn-based games (supporting library)',
    source_repo: 'boardgameio/boardgame.io',
    absolute_path: 'D:\\AI\\00_INBOX\\tactical-encounters-candidates\\boardgame-io',
    relative_path: '00_INBOX/tactical-encounters-candidates/boardgame-io',
    resource_type: 'framework',
    primary_capability: 'turn-state-engine',
    secondary_capabilities: ['multiplayer-networking', 'game-development'],
    quality_score: 80.6,
    audit_status: 'KEEP',
    agentos_relevance: 'HIGH (directly embeddable in AgentOS Node/TS tooling)',
    preferred_platoon: 'game-platoon',
    preferred_specialist_role: 'game-systems-architect',
    integration_mode: 'shared-library',
    runtime_requirements: ['Node.js'],
    move_risk: 'SAFE_TO_MOVE - evidence clone inside 00_INBOX (NEW/UNAPPROVED)',
    path_sensitive: false,
    auto_select_allowed: true,
    manual_only: false,
    notes: 'capability_provider=false for tactical-encounters core (supporting library for the turn/state slice).',
    weaknesses: ['NOT a tactical-encounters provider: no maps, terrain, cover, elevation, deployment probes'],
  },
  {
    stable_id: 'res-gdev-ai',
    name: 'GDEV_AI',
    display_name: 'GDEV_AI — rejected candidate',
    source_repo: 'example/GDEV_AI',
    absolute_path: 'D:\\AI\\Repositories\\GDEV_AI',
    relative_path: 'Repositories/GDEV_AI',
    resource_type: 'repository',
    primary_capability: 'enemy-ai',
    secondary_capabilities: [],
    quality_score: 30,
    audit_status: 'REJECT-CANDIDATE',
    agentos_relevance: 'LOW',
    preferred_platoon: 'game-platoon',
    preferred_specialist_role: 'companion-ai-specialist',
    integration_mode: 'external-runtime-integration',
    runtime_requirements: ['stale toolchain'],
    move_risk: 'HIGH - replace or archive',
    path_sensitive: true,
    auto_select_allowed: false,
    manual_only: true,
    notes: 'REJECT — must never be auto-selected.',
  },
]

const CAPABILITY_INDEX = {
  index: 'AgentOS Capability Index',
  generated: '2026-09-01',
  version: '1.0.0',
  capabilities: {
    'tactical-encounters': [
      { resource_id: 'res-tactical-wesnoth-framework', score: 83.5, status: 'KEEP-SECONDARY', auto_select_allowed: true, usage: 'preferred', note: 'auto-selectable encounter authoring/framework; hex-based; no true cover/elevation/LOS' },
      { resource_id: 'res-tactical-oxce-reference', score: 79, status: 'REFERENCE', auto_select_allowed: false, usage: 'reference-only', note: 'FULL grid-tactics reference; manual-only; needs original X-COM assets' },
    ],
    'turn-state-engine': [
      { resource_id: 'res-tactical-boardgame-io', score: 80.6, status: 'KEEP', auto_select_allowed: true, usage: 'preferred', note: 'turn order, phases/stages, moves, authoritative state' },
    ],
    'enemy-ai': [
      { resource_id: 'res-gdev-ai', score: 30, status: 'REJECT-CANDIDATE', auto_select_allowed: false, usage: 'rejected' },
    ],
  },
  capability_gaps: ['local-llm', 'browser-automation'],
  gap_note: 'NEW resources that map to a known capability gap get flagged HIGH PRIORITY in the review queue.',
  partial_coverage: {
    'tactical-encounters': {
      status: 'PARTIALLY_COVERED',
      filled: false,
      note: 'Wesnoth = approved auto-selectable encounter authoring/framework layer (hex-based; no true cover/elevation/LOS). OXCE = approved FULL tactical simulation/reference layer but manual/reference-only. AgentOS still lacks ONE auto-selectable provider combining full grid tactical simulation + cover + elevation + LOS — do NOT mark FILLED.',
    },
  },
}

const OVERLAP_POLICY = {
  policy: 'AgentOS Overlap & Duplicate Resolution Policy',
  generated: '2026-09-01',
  version: '1.0.0',
  groups: [
    {
      group_id: 'grp-tactical-engines',
      capability: 'tactical engines',
      preferred_resource: 'res-tactical-wesnoth-framework',
      secondary_resources: ['res-tactical-boardgame-io'],
      archive_candidates: [],
      rejected_resources: [],
      exact_duplicate: false,
      near_duplicate: false,
      complementary: true,
      supersedes: false,
      why_preferred_wins: 'Wesnoth is the auto-selectable encounter layer; boardgame.io contributes the turn/state slice.',
    },
  ],
}

const PLATOON_MAP = {
  map: 'AgentOS Platoon -> Specialist Role -> Recommended Resources',
  generated: '2026-09-01',
  version: '1.0.0',
  platoons: [
    {
      platoon: 'game-platoon',
      command: 'Platoon Commander (game)',
      roles: [
        {
          role: 'tactical-battles-encounter-designer',
          resources: [
            { resource_id: 'res-tactical-wesnoth-framework', score: 83.5, usage: 'preferred', path: '00_INBOX/tactical-encounters-candidates/wesnoth', auto_select_allowed: true },
            { resource_id: 'res-tactical-oxce-reference', score: 79, usage: 'reference-only', path: '00_INBOX/tactical-encounters-candidates/oxce-openxcom', auto_select_allowed: false },
          ],
        },
        {
          role: 'game-systems-architect',
          resources: [
            { resource_id: 'res-tactical-boardgame-io', score: 80.6, usage: 'preferred', path: '00_INBOX/tactical-encounters-candidates/boardgame-io', auto_select_allowed: true },
          ],
        },
      ],
    },
  ],
}

const CHANGE_STATE = {
  scan_id: 'scan-test-001',
  scan_time: '2026-09-02T00:00:00.000Z',
  baseline_version: '1.0.0',
  unchanged: ['res-tactical-wesnoth-framework', 'res-tactical-oxce-reference'],
  changed: [],
  new: ['res-tactical-boardgame-io'],
  missing: [],
  duplicate_candidates: [],
  supersession_candidates: [],
  capability_gap_matches: [],
  gap_note: 'NEW resources that map to a known capability gap get flagged HIGH PRIORITY in the review queue.',
  promoted: [],
}

/** Pending items that can be acted on (approve/reject/etc). */
export const PENDING_QUEUE_ITEMS = [
  {
    review_id: 'rq-pending-newlib',
    detected_state: 'NEW',
    path: '00_INBOX/new-tactical-lib',
    probable_resource_type: 'engine',
    probable_name: 'new-tactical-lib',
    probable_source_repo: 'https://example.test/new-tactical-lib.git',
    detected_capabilities: ['tactical-encounters', 'game-development'],
    inferred_primary_capability: 'tactical-encounters',
    covers_capability_gaps: ['tactical-encounters'],
    likely_overlaps: ['grp-tactical-engines'],
    likely_duplicates: [],
    current_competing_resources: ['res-tactical-wesnoth-framework'],
    preliminary_quality_score: 71,
    preliminary_agentos_relevance: 'HIGH',
    suggested_platoon: 'game-platoon',
    suggested_specialist_role: 'tactical-battles-encounter-designer',
    runtime_path_risks: ['requires C++ toolchain'],
    recommended_action: 'NEEDS_DEEP_REVIEW',
    high_priority_gap: 'tactical-encounters',
    readme_snippet: '# new-tactical-lib',
    review_status: 'PENDING',
    pending: true,
  },
  {
    review_id: 'rq-pending-weak-skill',
    detected_state: 'NEW',
    path: 'Repositories/weak-skill',
    probable_resource_type: 'skill',
    probable_name: 'weak-skill',
    probable_source_repo: null,
    detected_capabilities: ['prompt-engineering'],
    inferred_primary_capability: 'prompt-engineering',
    covers_capability_gaps: [],
    likely_overlaps: [],
    likely_duplicates: [],
    current_competing_resources: [],
    preliminary_quality_score: 41,
    preliminary_agentos_relevance: 'LOW',
    suggested_platoon: null,
    suggested_specialist_role: null,
    runtime_path_risks: [],
    recommended_action: 'ADD_AS_REFERENCE',
    high_priority_gap: null,
    review_status: 'PENDING',
    pending: true,
  },
]

const REVIEW_QUEUE = {
  generated: '2026-09-02T00:00:00.000Z',
  scan_id: 'scan-test-001',
  purpose: 'Review queue for NEW or materially CHANGED resources. Proposals only; APPROVED history is preserved.',
  items: [
    ...PENDING_QUEUE_ITEMS,
    {
      review_id: 'rq-decided-pt',
      detected_state: 'NEW',
      path: 'Repositories/Project-Tactics',
      probable_resource_type: 'production-pipeline',
      probable_name: 'Project-Tactics',
      detected_capabilities: ['game-development'],
      inferred_primary_capability: 'game-development',
      preliminary_quality_score: 68,
      suggested_platoon: 'game-platoon',
      suggested_specialist_role: 'combat-systems-specialist',
      runtime_path_risks: ['requires C++ toolchain + CMake build'],
      recommended_action: 'NEEDS_DEEP_REVIEW',
      review_status: 'APPROVED',
      pending: false,
      promotion_batch_id: 'promo-test-01',
      approved_at: '2026-09-01T22:00:00.000Z',
      final_approved_decision: 'ADD_AS_KEEP_SECONDARY',
    },
  ],
}

const PROMOTION_HISTORY = {
  generated: '2026-09-01T22:49:59.887Z',
  promotions: [
    {
      promotion_batch_id: 'promo-test-01',
      approved_at: '2026-09-01T22:49:59.887Z',
      approved_resources: ['res-project-tactics', 'res-didactic-octo-happiness'],
      previous_state: { registry_total: 17, overlap_groups: 8, capabilities: 58 },
      new_state: { registry_total: 17, overlap_groups: 9, capabilities: 59 },
      capabilities_added: ['game-development', 'game-engine'],
      overlap_changes: ['grp-game-engines + res-project-tactics (secondary, no supersession)'],
      platoon_mappings: ['game-platoon -> combat-gameplay-engineer -> res-project-tactics'],
      reviewer_decision: 'APPROVED by user (batch promo-test-01)',
      warnings: ['tactical-encounters gap remains OPEN'],
    },
  ],
}

export function buildCanonicalVault(root: string): void {
  write(root, '_CATALOG/agentos_resource_registry.json', JSON.stringify({
    registry: 'AgentOS Resource Registry', generated: '2026-09-01', version: '1.0.0',
    authority: 'AgentOS selects via agentos_capability_index.json + agentos_overlap_policy.json',
    resources: REGISTRY_RESOURCES, agentos_resources_missing: [],
  }, null, 2))
  write(root, '_CATALOG/agentos_capability_index.json', JSON.stringify(CAPABILITY_INDEX, null, 2))
  write(root, '_CATALOG/agentos_overlap_policy.json', JSON.stringify(OVERLAP_POLICY, null, 2))
  write(root, '_CATALOG/agentos_platoon_resource_map.json', JSON.stringify(PLATOON_MAP, null, 2))
  write(root, '_CATALOG/agentos_resource_changes.json', JSON.stringify(CHANGE_STATE, null, 2))
  write(root, '_CATALOG/agentos_resource_review_queue.json', JSON.stringify(REVIEW_QUEUE, null, 2))
  write(root, '_CATALOG/agentos_promotion_history.json', JSON.stringify(PROMOTION_HISTORY, null, 2))
  // Physical/scan surface so scanner fallback + rescan tests have something to walk.
  write(root, 'Repositories/Existing/.git/config', '[remote "origin"]\n  url = https://example.test/existing.git\n')
  write(root, 'Repositories/Existing/README.md', '# Existing\nA known repository that has no upstream audit entry.\n')
}

export function registryResources(root: string): any[] {
  return JSON.parse(read(root, '_CATALOG/agentos_resource_registry.json')).resources
}
export function reviewQueueItems(root: string): any[] {
  return JSON.parse(read(root, '_CATALOG/agentos_resource_review_queue.json')).items
}
export function promotionHistory(root: string): any[] {
  return JSON.parse(read(root, '_CATALOG/agentos_promotion_history.json')).promotions
}