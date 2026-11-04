# Mission Control Completion/Hardening Board

Persistent board tracking remaining work and completed Operator UX features.

## Backlog

- MC-H04 AI Vault / Arsenal Missing-Dependency Resilience (P1)
- MC-H05 AgentOS Test Coverage Gap Audit (P1)
- MC-H06 SSE State-Convergence Verification (P1)
- MC-H07 Deployment Configuration Audit (P1)
- MC-H08 Operator Error/Empty-State Polish (P1)
  - Overview portion DONE (2026-11-03, HEAD 48c9f48): a failed companion queue read no longer renders as 0.
    - Per-read availability state in `AgentOSOverviewPanel`: failed `/api/agentos/runs` marks Active runs / Queued / Reviewing / Failed / Held-blocked "Unavailable"; failed `/api/agentos/approvals` marks "Approvals waiting" "Unavailable"; successful reads keep exact counts (0 stays 0). Panel Refresh after recovery replaces "Unavailable" with the real value.
    - Regression: `tests/agentos-overview-approval-fallback.spec.ts` (isolated local harness; 2 passed). Pre-fix run observed the falsifying counts: approvals card "0Approvals waiting" after mocked 500 with healthy 3/4 runs; runs card "0Active runs" after mocked 500 with truthful approvals 0.
    - Wider MC-H08 card stays open (remaining error/empty-state polish).
  - Runs panel polish DONE (2026-11-03, HEAD ea8a053): filtered-empty vs no-runs split in `AgentOSRunsPanel` — with state/project/ecosystem/agent filters active the empty state now says "No AgentOS runs match the current ... filters. Clear or widen ..."; with no filters it says "No AgentOS runs yet. Plan and execute an objective ...". A "Clear filters" control appears in the panel header whenever any filter is active.
  - Project Command polish DONE (2026-11-03, HEAD ea8a053): explicit no-projects empty block in `ProjectCommandPanel` — zero projects now renders "No projects yet. Create a project, then return here ..." instead of only the header plus the select's "No projects" option.
    - Verified via typecheck (exit 0) and eslint on both touched files (exit 0); panels normalized to HEAD blob LF endings so diffs are semantic-only (runs 13 ± / projects +5). Browser-regression coverage for these two empty states remains part of the wider open MC-H08 card.
    - Regression coverage DONE (2026-11-03): `tests/agentos-empty-states.spec.ts` (3 passed, isolated local harness) — (1) empty feed vs filtered-empty are distinct messages and Clear filters appears with filters active and disappears when cleared; (2) a non-matching agent search over a non-empty feed shows filtered-empty (never no-runs-yet) and Clear filters + Refresh restores the run; (3) zero projects on /command renders the explicit no-projects block.
    - Two production defects found/fixed by that regression (2026-11-03): (a) `loadContext(null)` in `ProjectCommandPanel` never cleared `loading`, leaving a zero-project workspace stuck on "Loading command picture…" forever — now clears it; (b) `AgentOSRunsPanel`'s Clear filters condition lost its parentheses, so `&&`-over-`||` precedence made the control render only when the agent query was the active filter — state/project/ecosystem filters alone would never show it — now parenthesized.
  - Full-suite gate note (2026-11-03, HEAD 0cff01e): Playwright suite 512 passed / 1 skipped / 6 failed before repair — no operator panel regressed (all panel-level specs green incl. Overview, Runs, Approvals, Reviews, Project Command, and the two new MC-H08 specs).
    - login-flow 3 failures: environmental test-pressure — the deliberately `critical: true` loginLimiter (5 logins/min/IP, not bypassable by `MC_DISABLE_RATE_LIMIT`) trips when the full suite concentrates login POSTs in one minute window; passes in isolation. Left as a documented flake source; no code change.
    - quality-review 3 failures: stale spec vs the stricter `recordQualityReview` contract (decisions persist only for tasks in `review`/`quality_review` state; otherwise 409 — the old inline route on the D: baseline had no gate). Repaired `tests/quality-review.spec.ts` to seed decision-path tasks directly in `review` status; spec now 6/6 in isolation.
  - Approvals + Review Queue polish DONE (2026-11-03, HEAD add1aaa): a failed first read no longer co-renders the "no work ..." claim alongside its role=alert in `AgentOSApprovalsPanel` and `AgentOSReviewsPanel` (`error ? null : <claim>`) - a failed read is never presented as a truthful zero. Genuine empties keep the no-work claim; healthy reads keep the item card plus live count badge.
    - Regression: `tests/agentos-approvals-reviews-empty-states.spec.ts` (4 passed, isolated local harness) - per panel: failed first read shows the failure alert and never the no-work claim, reload after recovery shows the truthful zero with no alert, a healthy single item renders card + badge, and a non-matching filter tab yields the distinct filtered-empty message (never no-work) with switching back restoring the card.
    - Notes: the e2e harness serves `.next/standalone`, so the spec run required an artifact rebuild after the panel fix; and approvals/reviews are non-essential panels, so new test users hit the essential-mode "Switch to Full" nudge, which the spec's openPanel now handles. Panel diffs kept semantic-only (HEAD CRLF endings preserved). Wider MC-H08 card stays open.
  - Full regression gate (lint / typecheck / unit / build) DONE (2026-11-03, HEAD a948b09): lint exit 0; typecheck exit 0; unit 217 files / 1979 tests all passing; production build exit 0 with standalone artifact prepared.
    - Unit gate exposed 3 deterministic failures committed red in the MC-H01 commit (48c9f48 / 4a291e2), none caused by the recent UI commits: (a) agentos-reviews.test.ts asserted a null review createdAt that the `quality_reviews.created_at INTEGER NOT NULL` schema can never produce - assertion corrected to the stored value (36/36); (b)+(c) objective-planner-ui.test.tsx drove API validation errors through submissions that the component's disabled-button client-side gating now blocks, leaving the mocked rejections unconsumed - tests rewritten to assert the actual gating (buttons disabled, no API call, 5/5). Positive-path API error display remains covered by the creation-fails test.
    - Playwright-specific gates (full suite, API parity) verified separately at 0cff01e / add1aaa; this run covered lint, typecheck, vitest, and the production build.
  - Full regression gate completed (2026-11-03, HEAD 11b28ca): api:parity exit 0 (300 route operations == 300 openapi operations, 0 ignored); full Playwright suite 518 passed / 1 skipped / 4 failed (2.3m, isolated harness). All four failures are the documented critical loginLimiter test pressure - login never succeeded and the specs stayed on /login (victims this run: agentos-empty-states x2, agentos-overview-approval-fallback x2; last run's victims were login-flow x3). Verified by isolation rerun: both spec files 5/5 pass (31.9s). No panel, harness, or production defect; the whole-suite one-shot green would need a harness env knob for the critical limiter, still deferred pending a decision.
- MC-H09 Documentation Cleanup (P2)
- MC-H10 Accessibility / UI Consistency Audit (P2)
- MC-H11 Claude Executor Validation (P2)

## Ready

- MC-H02 Full Regression Verification (P0)
- MC-H03 Operator Panels End-to-End Contract Audit (P0)

## In Progress

- MC-H01 AgentOS Reviews Test Coverage (P0)

## Review

(none)

## Done

- canonical AgentOS run/read model
- Approval Center
- approval fingerprint handling
- Runs/Activity
- retry
- cancellation
- structured hold reasons
- Review Queue
- Project Command
- AgentOS Overview
- execution planning
- execution authorization
- ObjectivePlanner null-safe rendering (projectId type fix)
- Project Command Panel full feature set
- All AgentOS API routes (status, runs, approvals, reviews, resources, project command, execution planning/approval, objectives, delegations, handoffs, force-plan readiness)
- All AgentOS supporting libraries (agentos-status, agentos-runs, agentos-approvals, agentos-reviews, execution-authorization, project-command, project-task-routing, execution-planning, execution-costs)
- 67 database migrations covering full schema evolution
- Comprehensive Zustand state management
- 200+ test files covering security, isolation, routing
- TypeScript type fixes
- SSE real-time event streaming
- Workspace isolation and multi-tenancy
- Cost tracking and token usage analytics
- Security scanning and audit trails
- Real-time polling and WebSocket support
