# AgentOS AI Arsenal (Authoritative Resource Registry)

AgentOS treats Freebuff's audited catalog under `D:\AI\_CATALOG\` as the
authoritative AI resource vault. The Project Command **AI Arsenal** panel is the
Company Commander's single view over that vault: registry, capability coverage,
new/changed detection, the review queue, promotion history, overlap policy, and
runtime risks — plus controlled approval actions that never move files.

## Authoritative files (AgentOS reads/writes through the adapter)

| File | Source of truth for |
| --- | --- |
| `agentos_resource_registry.json` | The audited resource list (`KEEP` / `KEEP-SECONDARY` / `REFERENCE` / `REJECT-CANDIDATE`, scores, capabilities, platoon/role, runtime requirements, move risk) |
| `agentos_capability_index.json` | Capability → provider entries (`auto_select_allowed`, `usage`), `capability_gaps` (OPEN), `partial_coverage` (PARTIALLY_COVERED) |
| `agentos_overlap_policy.json` | Duplicate / supersession resolution policy |
| `agentos_platoon_resource_map.json` | Platoon → specialist role → recommended resources |
| `agentos_resource_changes.json` | NEW / CHANGED / MISSING / UNCHANGED per scan (read-only) |
| `agentos_resource_review_queue.json` | Pending review candidates + decisions |
| `agentos_promotion_history.json` | Batch promotions with prior/new state and warnings |

## Selection order (Phase 3)

1. required capability match
2. preferred capability match
3. audit status
4. quality score
5. specialist affinity
6. platoon compatibility
7. runtime/path accessibility
8. integration mode
9. unique value
10. overlap policy

**Hard gates** (enforced before ranking): `REJECT*` never auto-selects,
`ARCHIVE-CANDIDATE` / manual-only never auto-selects, `REFERENCE` / manual-only
is searchable only, inaccessible runtimes are never claimed as used, and manual
overrides always win. The heuristic scanner (`scanAiVault`) is used only for
fallback + change detection — it can never override the deep audit.

## Adapter (`src/lib/ai-resource-registry.ts`)

- `getAiResourceRegistry(root)` — canonical first, scanner fallback.
- `getAiCapabilityCoverage(root)` — FILLED / PARTIALLY_COVERED / OPEN derived
  from the authoritative index (partial status is preserved, never auto-flipped).
- `getAiResourceChanges` / `getAiReviewQueue` / `getAiPromotionHistory` /
  `getAiPlatoonResourceMap` — read-only consumers of the queue/history files.
- `recommendAiResources(capabilities, limit, root)` — capability-index ranking
  with hard gates; used by `project-force-planning.ts` and
  `project-task-routing.ts`.
- `toTaskResourceAttachment(resource)` — canonical `agentos_resources` task
  metadata shape written when a mission is routed.

## Controlled action model (`src/lib/ai-resource-actions.ts`)

Backend actions behind `POST /api/agentos/resources/actions` (operator role):
`approve`, `reject`, `mark-manual-only`, `approve-supersession`,
`dismiss-duplicate`, `request-deep-review`, `rescan-changed`. Every action
validates its payload, builds all target documents in memory, validates them,
then writes with backup (`_CATALOG/.agentos-backups/`) + atomic rename, rolling
back on failure. Promotions preserve stable IDs and record history; no physical
moves ever happen.

## Deep-review mission lifecycle (`src/lib/resource-deep-review.ts`)

`Request Deep Review` in the Review Queue creates a NORMAL AgentOS mission:

1. **Queued** — the existing `request-deep-review` action marks the item QUEUED.
2. **Mission created** — `POST /api/agentos/resources/deep-review`
   (`createDeepReviewMission`) inserts an `agentos-resource-review` tagged task
   carrying the canonical `agentos_resource_review` contract: review_id,
   resource id/path, `required_output_schema: agentos-resource-review-v1`,
   filtered registry + overlap snapshots, creation metadata, and a SHA-256
   **fingerprint** of the candidate + its registry entry.
3. **Requirements inferred** — required capability is always
   `resource-deep-review`; preferred capabilities are inferred from the
   candidate's detected capabilities plus a declared domain-affinity map (game
   → game-development/qa-release/architecture, mcp → mcp/backend/security,
   knowledge → research/knowledge-management, …).
4. **Reviewer routed** — the task flows through the normal
   `routeTaskWithinProject` project/specialist selector (respecting the project
   command guard at dispatch, platoon allowlists, availability, specialist
   affinity, concurrency). No parallel dispatcher.
5. **Dispatch** — the existing scheduler dispatches it over the chosen native
   runtime (Hermes/Gamut/Codex/Claude/…); the delegation ledger tracks
   session/run IDs.
6. **Result ingestion** — `reconcileDeepReviewMissions` (wired into the
   scheduler's `task_dispatch` job) parses completed responses, validates the
   `agentos-resource-review-v1` envelope (review_id/resource_id match, field
   enums, policy conflicts), re-checks the fingerprint (STALE protection), and
   marks the queue item REVIEW_COMPLETE with the structured proposal attached.
   The authoritative registry is NEVER auto-promoted — a human approves via the
   existing atomic action model.

**Review states**: `QUEUED → ROUTED → RUNNING → COMPLETE`, with `FAILED`
(invalid/mismatched output), `STALE` (resource changed during review),
`NEEDS_MANUAL`, and safe retry that reuses the existing mission task rather
than duplicating it.

## Delegation, not hard-coding

Deep review is a native AgentOS delegation capability (`resource-deep-review`)
routed to the most qualified reviewer at the time from the global roster
(capability tags + specialist affinity). Freebuff is one available reviewer,
not the permanent one.

## Deferred (Phase 12)

The five knowledge packs (`tactical-encounter-design-patterns`,
`deployment-and-spawn-schemas`, `terrain-and-movement-models`,
`scenario-objective-patterns`, `tactical-ai-reference`) remain proposed backlog
items for future AgentOS-delegated knowledge-curation missions. Not built.