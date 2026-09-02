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

## Execution preview & authorization

Before any cost-bearing native dispatch, AgentOS generates an **execution
plan** (`src/lib/execution-planning.ts`) from the routed objective: every
mission is classified independently into a reusable cost class —
`FREE_LOCAL`, `FREE_REMOTE`, `PAID_KNOWN`, `PAID_ESTIMATED`, `UNKNOWN_COST`,
`MANUAL_EXTERNAL`, or `BLOCKED` — using only runtime/provider metadata that
actually exists in the roster/config (no invented dollar values:
`UNKNOWN_COST` stays `UNKNOWN_COST` with `estimated_cost: null`).

Plans carry a stable SHA-256 **fingerprint** over execution-relevant fields
(task ids, dependencies, platoon/specialist, runtime/provider/model, attached
resources, cost classes). Approval (`src/lib/execution-authorization.ts`) is
durable, project-scoped, and applies **only to the exact plan snapshot**: if
routing changes materially after approval the plan is flagged
`APPROVAL_STALE` and a fresh preview is required before any cost-bearing work.
Partial approval is supported (approve M1–M3 only; unapproved missions stay
held, dependent missions stay blocked naturally).

The authorization guard lives in the **real dispatch path**
(`task-dispatch.ts`): after the project command guard and concurrency guard,
free-local work allowed by project policy proceeds as before, while
paid/unknown-cost work without a valid approval is held — the task stays
`assigned`, never moves to `in_progress`, and an
`agentos_execution_approval_held` activity event is logged. Per-project
command policy gains optional execution fields (`allowFreeLocalWithoutApproval`
and friends) with safe defaults that preserve existing behavior, and the
Project Command **Execution Preview & Authorization** surface shows the plan,
cost classes, per-mission runtime/provider/estimate, stale-approval warnings,
and Approve All / Approve Selected / Hold actions.

The knowledge suite objective is the primary fixture: M1–M5 route to
free-local runtimes in the default configuration while unknown-cost missions
wait for approval, and M6 stays blocked until every dependency is approved and
complete. No paid or unknown-cost work is ever dispatched without approval.

## Live roster registration bridge

AgentOS discovers Gamut/Hermes/Codex specialists through the platoon-commander
adapters, but the normal dispatcher joins tasks against `agents` rows — so
before this layer the discovered specialists were visible yet never
dispatchable (`SELECT COUNT(*) FROM agents` stayed 0).

`src/lib/agent-roster-sync.ts` closes that gap with an idempotent,
workspace-scoped **registration** bridge:

- **Stable identity**: one `agentos-external` row per discovered specialist,
  named `agentos:{platoon}:{slugified-name}:{sha256(external-id)[:8]}` — never
  display-name alone, so renames do not duplicate and re-sync maps back to the
  same row. Repeated sync is a true no-op (delta-guarded; liveness is
  maintained by refreshing `last_seen` on the sync cadence).
- **Availability**: available/busy → `online`, error → `error`, offline →
  `offline`; rows are **never deleted** when a runtime is temporarily down.
- **Truthful cost metadata**: `provider`/`model`/free-local evidence are stored
  only when actually known. Because of this, the execution classifier now
  treats host-orchestrated runtimes (`gamut`, `superagent-host`) as
  **evidence-required**: no declared model/provider and no explicit
  free-local evidence ⇒ `UNKNOWN_COST` (a localhost host API never implies
  FREE_LOCAL); declared non-local provider ⇒ `PAID_ESTIMATED`; explicit
  free-local evidence ⇒ `FREE_LOCAL`. MC-native tokens (`local`, `builtin`,
  `filesystem`, `mission-control`) stay unconditional FREE_LOCAL.
- **Binding**: `syncAgentRoster({ workspaceId, projectId })` (API:
  `POST /api/agentos/roster`; UI: **Reconcile & Bind Available** in Project
  Command) registers available specialists and ensures the project's binding
  rows exist so capability routing can select them. Re-binding the same
  identity preserves the richer config the sync wrote (no metadata clobber).
  `GET /api/agentos/roster` is read-only (registration status + cost class
  per specialist).
- A registration-only `agentos_roster_sync` scheduler job keeps rows fresh
  every tick.

Live reconcile on this machine registered the real Gamut platoon (18
specialists, incl. Tactical Battles & Encounter Designer, Combat Gameplay
Engineer, Enemy AI & Boss Engineer, QA Playtest & Release Verification Lead)
and 7 Hermes profiles into the ops-project roster with bindings — all
classify `UNKNOWN_COST` (no model/provider evidence in the definitions), so
they can never dispatch without an explicit approval, and none ever will
under the default policy.

## Knowledge-curation ownership (evidence-based)

The suite objective's M1–M6 require the `knowledge-curation` capability, and
routing stays honest: no specialist receives it unless their definition
explicitly authors reference material. `inferCapabilityTags`
(`global-agent-roster.ts`) treats knowledge-curation as **authoring-only** —
curated knowledge packs, reference material/guides, technical writing,
documentation architecture, pattern catalogs, cross-source synthesis qualify;
generic intelligence, single documentation mentions, README/docs work, or
synthesis of ordinary project/release evidence never do (locked by unit
tests). Affinity in `agent-selection.ts` mirrors the same ownership language.

An evidence scan of every live definition (18 Gamut + 7 Hermes) found no
curation authorship: QA synthesizes verification evidence, the Chief of Staff
synthesizes cross-agent work, and the Architect documents project architecture
— none author AgentOS reference packs. So reconciliation propagates **zero**
new capabilities (verified live: no false positives) until a dedicated
native-format curator definition exists.

### Live curator specialist (registered)

A real Gamut/SuperAgent definition — **Knowledge & Technical Synthesis
Specialist** (slug `p40nnujai8`, `C:\Users\KazeK\AppData\Roaming\Superagent\agents\p40nnujai8\workspace\CLAUDE.md`)
— owns curation of approved reference material into reusable knowledge packs
(cross-source synthesis, technical writing, documentation architecture,
source-attributed reference authoring) and explicitly disclaims gameplay/
combat/tactical/enemy-AI implementation ownership. The evidence-based parser
infers `knowledge-curation` (+ `research`, `knowledge-management`-adjacent
`documentation`, `architecture`, `testing-review`) and rejects
tactical-encounters/enemy-ai/combat-systems — verified live against the file
itself, no parser changes.

Roster reconciliation then took the live roster **25 → 26**: the curator was
registered (`agents` row, stable `agentos:gamut:…` identity) and bound to
AgentOS Operations (project 8) through the guarded binding path (binding 32,
capability snapshot `["architecture","testing-review","research","knowledge-curation","documentation"]`).
The pack-mission specs were also corrected so the required execution role is
`knowledge-curation` only and domain expertise (`tactical-encounters`, …) is
**preferred**, not required — a general curator must be routable for any pack;
the domain comes from approved Arsenal resources (Wesnoth/OXCE) and
preferred-capability scoring, never from the curator pretending to be a
tactical implementation specialist. A `refreshSuiteMissionCapabilityMetadata`
helper heals already-created suite tasks to the current spec.

Result on Objective 1: **M1–M5 (tasks 9–13) routed** to the curator proxy
(`assigned`, required `[knowledge-curation]`, per-mission preferred sets
preserved — M5 keeps `enemy-ai` preferred, M6 keeps `testing-review`/`qa-release`
preferred); M6 stays `backlog` dependency-gated.

### Effective runtime cost resolution (truthful provider/model)

Gamut/SuperAgent specialists have **no per-agent model configuration**: every
agent inherits the host-wide LLM provider + agent model from `settings.json`
(`llmProvider` / `models.agentModel`). On this machine that is
`openrouter` / `sonnet` (Claude Sonnet via the OpenRouter API, keys configured
in the desktop app) — a **remote paid API**, never free. `getGamutHostEffectiveRuntime()`
(`gamut-host.ts`) reads that settings file (TTL-cached, GET-only, never touches
`apiKeys`/auth) and discovery attaches `provider`/`model` to every Gamut
descriptor; the roster and sync propagate them into the registered agent
`config`, so execution planning classifies truthfully: **gamut + openrouter =
PAID_ESTIMATED** (paid, exact per-token price not stored — no invented
pricing), gamut + `provider: local` = FREE_LOCAL, no evidence = UNKNOWN_COST.
A localhost host API never implies free.

Local-model inventory: **no usable local inference runtime** — `~/.ollama`
holds `qwen2.5-coder:7b` weights (4.4 GB, June install) but the Ollama app is
not installed/running; Ollama integrations are configured to a *cloud* model
(`minimax-m3:cloud`). LM Studio / llama.cpp / LocalAI absent. Even if started,
qwen2.5-coder:7b is **MARGINAL** for multi-source synthesis / long-context /
structured JSON authoring — not recommended as the suite worker just to reach
FREE_LOCAL.

Live after the fix: **26 agents stable** (19 Gamut now carry
provider=openrouter/model=sonnet → PAID_ESTIMATED; 7 Hermes unchanged →
UNKNOWN_COST), curator identity/binding/capabilities untouched, re-sync a
no-op. Objective-1 preview regenerated: M1–M5 **PAID_ESTIMATED** (openrouter /
sonnet, approval required), M6 BLOCKED (unassigned), paid 5 / free 0 /
unknown 0. **Nothing dispatched**: 0 delegations, 0 approvals, 0
`in_progress` tasks.

## Deferred

The five knowledge packs are now the real M1–M5 of the suite objective above;
they are built only through that AgentOS workflow, never by hand. Live
finalization writes require an actual AgentOS run with dispatch; the module is
exercised end-to-end in tests against temporary vaults (including a real
root-patched run of `scan.mjs` proving NEW discovery).