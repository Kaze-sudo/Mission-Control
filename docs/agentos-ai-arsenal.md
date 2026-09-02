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

`Request Deep Review` in the Review Queue creates a NORMAL AgentOS objective
and mission, participating in the same Company Commander lifecycle as any other
work — objectives → mission graph → routing → delegation → result → follow-on:

1. **Queued** — the existing `request-deep-review` action marks the item QUEUED.
2. **Internal objective + mission created** — `POST
   /api/agentos/resources/deep-review` (`createDeepReviewMission`) creates a
   normal objective via `createObjectivePlan` under the per-workspace
   **AgentOS Operations** project (`agentos-operations`, reserved slug) unless
   an explicit active project was chosen (manual override preserved). The
   mission task is an ordinary Company Commander objective mission carrying the
   canonical `agentos_resource_review` contract: review_id, resource id/path,
   `required_output_schema: agentos-resource-review-v1`, filtered registry +
   overlap snapshots, creation metadata, and a SHA-256 **fingerprint** of the
   candidate + its registry entry — plus `objective_id` and an
   `agentos_review_link` marker in the objective's plan_json. One objective per
   review; retries reuse the same lineage.
3. **Requirements inferred** — required capability is always
   `resource-deep-review`; preferred capabilities are inferred from the
   candidate's detected capabilities plus a declared domain-affinity map (game
   → game-development/qa-release/architecture, mcp → mcp/backend/security,
   knowledge → research/knowledge-management, …).
4. **Reviewer routed** — the mission flows through `createObjectivePlan`'s
   normal `routeTaskWithinProject` project/specialist selector (respecting the
   project command guard at dispatch, platoon allowlists, availability,
   specialist affinity, concurrency). No parallel dispatcher.
5. **Dispatch** — the existing scheduler dispatches it over the chosen native
   runtime (Hermes/Gamut/Codex/Claude/…); the delegation ledger records
   `objective_id` straight from the mission metadata, tracking session/run IDs.
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

## Objective lifecycle & NEEDS_MANUAL escalation

Deep-review objectives follow real mission state through the existing objective
reconciler (`reconcileObjectiveStatuses`, also wired into the scheduler):
mission done + review complete → objective `completed`; STALE or escalated work
→ objective `needs_manual` (a new first-class status added by migration 064;
the module also reconciles objectives for non-review work). **STALE never
counts as completed.**

Escalation is a generic AgentOS service (`src/lib/agentos-escalation.ts`) — any
workflow can use it, not just reviews. Failures are classified
`RETRYABLE` / `MANUAL_REQUIRED` / `STALE` / `WAITING_APPROVAL` /
`TERMINAL_FAILURE` and only escalate after the retry budget
(`DEEP_REVIEW_MAX_RETRIES = 2`, `DEEP_REVIEW_MAX_INVALID_ATTEMPTS = 2`):

- one-off invalid output or dispatch failure → retryable, no escalation;
- repeated invalid structured output → `NEEDS_MANUAL`
  (`invalid_structured_output`);
- resource changed mid-review → `STALE` (`stale_resource`), fresh review offered;
- missing / inaccessible resource path → immediate `NEEDS_MANUAL`;
- repeated dispatch failure / no eligible reviewer → `NEEDS_MANUAL`.

Each escalation writes an `agentos_escalation` record (state, category, reason,
summary, recommended safe follow-ons, attempts, task/objective/delegation/
resource ids) to the task metadata, mirrors it onto the objective's plan_json,
and logs `agentos_escalation_needs_manual` / `agentos_escalation_resolved` in
the activity trail. Manual **Retry Review** reuses the same mission task,
clears the escalation, and the objective unblocks. The UI surfaces a red
**Needs manual** filter + banner and shows the escalation reason, attempts,
objective, and recommended follow-on actions.

## Delegation, not hard-coding

Deep review is a native AgentOS delegation capability (`resource-deep-review`)
routed to the most qualified reviewer at the time from the global roster
(capability tags + specialist affinity). Freebuff is one available reviewer,
not the permanent one.

## Knowledge curation (Company Commander proof)

`knowledge-curation` is a first-class AgentOS delegation capability
(roster keyword inference, specialist affinity, mission-intent rules). The
AI Arsenal **Knowledge Curation** tab plans a real internal-ops objective —
**Build Tactical Encounter Knowledge Pack Suite** — through the normal
objective path:

- M1–M5 curate the five tactical packs independently (parallel-ready);
- M6 **Validate Tactical Knowledge Pack Suite** depends on M1–M5 and stays
  `backlog` until the standard dependency promotion releases it;
- every mission is a normal objective mission task with explicit
  `knowledge-curation` + domain capability requirements routed through the
  project specialist selector and tracked in the delegation ledger;
- **source policy**: Wesnoth attaches automatically (approved auto-selectable
  `tactical-encounters` provider); OXCE attaches only as an explicitly
  selected manual/reference source and keeps its `manual_only` flag — the
  global gate is never weakened and REJECT resources can never attach.

Each pack result is validated against `agentos-knowledge-pack-v1` before
acceptance: pack/schema identity, source-claim policy (approved ids only,
manual-only never preferred, no `accessed` claim on an inaccessible path),
authoritative factual limits (no "Wesnoth cover/elevation/LOS", no "OXCE
automatic runtime", no "boardgame.io tactical provider"), and a verbatim-source
ratio guard. Validated packs are staged under
`00_INBOX/generated-knowledge/` — no final files are written before M6.
M6 (`agentos-knowledge-validation-v1`) is the only finalization gate: a PASS
verdict with all five packs COMPLETE writes the duplicate-safe final suite to
`Knowledge Packets/Tactical Encounters/` plus `manifest.json` (suite/objective/
task/delegation ids, source resource ids, validation result).

Nothing auto-promotes. AgentOS never runs the vault scanner — the finalized
staging container is scan-visible, so the next `node D:/AI/_CATALOG/scan.mjs`
registers the generated suite as a NEW resource that must pass NEW → Review
Queue → human approval. Retry/escalation reuses the generic foundation
(repeated invalid output → `NEEDS_MANUAL`; failed dispatch on a missing source
→ immediate escalation; manual retry keeps the same task lineage).

## Deferred

The five knowledge packs are now the real M1–M5 of the suite objective above;
they are built only through that AgentOS workflow, never by hand. Live
finalization writes require an actual AgentOS run with dispatch; the module is
exercised end-to-end in tests against temporary vaults (including a real
root-patched run of `scan.mjs` proving NEW discovery).