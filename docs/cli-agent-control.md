# Mission Control CLI for Agent-Complete Operations (v2)

This repository includes a first-party CLI at:

- scripts/mc-cli.cjs

Designed for autonomous/headless usage first:
- API key auth support
- Profile persistence (~/.mission-control/profiles/*.json)
- Stable JSON mode (`--json`) with NDJSON for streaming
- Deterministic exit code categories
- SSE streaming for real-time event watching
- Compound subcommands for memory, soul, comments

## Quick start

1) Ensure Mission Control API is running.
2) Set environment variables or use profile flags:

- MC_URL=http://127.0.0.1:3000
- MC_API_KEY=your-key

3) Run commands:

```bash
node scripts/mc-cli.cjs agents list --json
node scripts/mc-cli.cjs tasks queue --agent Aegis --max-capacity 2 --json
node scripts/mc-cli.cjs sessions control --id <session-id> --action terminate
```

## Command groups

### auth
- login --username --password
- logout
- whoami

### agents
- list
- get --id
- create --name --role [--body '{}']
- update --id [--body '{}']
- delete --id
- wake --id
- diagnostics --id
- heartbeat --id
- attribution --id [--hours 24] [--section identity,cost] [--privileged]
- memory get --id
- memory set --id --content "..." [--append]
- memory set --id --file ./memory.md
- memory clear --id
- soul get --id
- soul set --id --content "..."
- soul set --id --file ./soul.md
- soul set --id --template operator
- soul templates --id [--template name]

### tasks
- list
- get --id
- create --title [--body '{}']
- update --id [--body '{}']
- delete --id
- queue --agent <name> [--max-capacity 2]
- broadcast --id --message "..."
- comments list --id
- comments add --id --content "..." [--parent-id 5]

### sessions
- list
- control --id --action monitor|pause|terminate
- continue --kind claude-code|codex-cli --id --prompt "..."
- transcript --kind claude-code|codex-cli|hermes --id [--limit 40] [--source]

### connect
- register --tool-name --agent-name [--body '{}']
- list
- disconnect --connection-id

### tokens
- list [--timeframe hour|day|week|month|all]
- stats [--timeframe]
- by-agent [--days 30]
- agent-costs [--timeframe]
- task-costs [--timeframe]
- trends [--timeframe]
- export [--format json|csv] [--timeframe] [--limit]
- rotate (shows current key info)
- rotate --confirm (generates new key -- admin only)

### skills
- list
- content --source --name
- check --source --name
- upsert --source --name --file ./skill.md
- delete --source --name

### cron
- list
- create/update/pause/resume/remove/run [--body '{}']

### events
- watch [--types agent,task] [--timeout-ms 3600000]

  Streams SSE events to stdout. In `--json` mode, outputs NDJSON (one JSON object per line). Press Ctrl+C to stop.

  Every event carries `{ type, data, timestamp }`; `data.workspace_id` scopes it to
  the authenticated workspace (events from other workspaces are never delivered).

  Event types relevant to agent operations:

  | Type | Emitted when | Key `data` fields |
  |---|---|---|
  | `task.created` | a task row is inserted, including AgentOS objective missions and knowledge-curation tasks | `id`, `title`, `status`, `project_id`, `workspace_id` |
  | `task.updated` | task fields change (assignment, dispatch metadata, framework reports) | `id`, `status`, `assigned_to`, `agentos_routing` |
  | `task.status_changed` | status transition: routing, dispatch claim, mission promotion (backlog → inbox), cancellation | `id`, `status`, `previous_status`, `error_message` |
  | `task.escalated` | a failed task is re-escalated for attention | `id`, `reason` |
  | `task.deleted` | the task row is removed | `id` |
  | `delegation.created` | the scheduler claims a task for an AgentOS specialist | `id`, `task_id`, `project_id`, `objective_id`, `status: 'claimed'`, `attempt` |
  | `delegation.updated` | a delegation's status changes (running, review, completed, failed, cancelled) | `id`, `task_id`, `status`, `attempt`, `native_session_id`, `completed_at` |
  | `agent.created` / `agent.updated` / `agent.status_changed` / `agent.deleted` | roster changes | `id`, `name`, `status` |
  | `run.created` / `run.updated` / `run.completed` / `run.eval_attached` | CLI/session runs | `id`, `status` |
  | `activity.created` | the activity log receives an entry (pipelines, workflows) | `id`, `action`, `entity_type` |
  | `chat.message` | chat messages | `session_key`, `role` |

  Panels that render the canonical run feed (Runs, Agent Registry recent
  executions) refresh instantly on `task.*` / `delegation.*` events through the
  shared SSE connection — no extra polling needed when an agent drives work via
  the API.

### status
- health (no auth required)
- overview
- dashboard
- gateway
- models
- capabilities

### export (admin)
- audit [--format json|csv] [--since <unix>] [--until <unix>] [--limit]
- tasks [--format json|csv] [--since] [--until] [--limit]
- activities [--format json|csv] [--since] [--until] [--limit]
- pipelines [--format json|csv] [--since] [--until] [--limit]

### raw
- raw --method GET --path /api/... [--body '{}']

## Exit code contract

- 0 success
- 2 usage error
- 3 auth error (401)
- 4 permission error (403)
- 5 network/timeout
- 6 server error (5xx)

## API contract parity gate

To detect drift between Next.js route handlers and openapi.json, use:

```bash
node scripts/check-api-contract-parity.mjs \
  --root . \
  --openapi openapi.json \
  --ignore-file scripts/api-contract-parity.ignore
```

Machine output:

```bash
node scripts/check-api-contract-parity.mjs --json
```

The checker scans `src/app/api/**/route.ts(x)`, derives operations (METHOD + /api/path), compares against OpenAPI operations, and exits non-zero on mismatch.

Baseline policy in this repo:
- `scripts/api-contract-parity.ignore` currently stores a temporary baseline of known drift.
- CI enforces no regressions beyond baseline.
- When you fix a mismatch, remove its line from ignore file in the same PR.
- Goal is monotonic burn-down to an empty ignore file.

## Next steps

- Promote script to package.json bin entry (`mc`).
- Add retry/backoff for transient failures.
- Add integration tests that run the CLI against a test server fixture.
- Add richer pagination/filter flags for list commands.
