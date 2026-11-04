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
