# AgentOS Executor Readiness Matrix

Canonical record of what each executor ecosystem can actually do through the
AgentOS orchestration layer, with the evidence used to verify it. A capability
is marked ✅ only when verified against the real runtime on this machine
(Windows 11, Node 26, Mission Control @ `agentos/master-command-center`).
Validation dates: 2026-09-06 (Hermes/Codex/discovery), 2026-09-07 (Gamut host
restoration + root-cause deep-dive).

## Matrix

| Ecosystem | Discovered | Runtime Resolved | Planning | Authorization | Real Dispatch | Native Run ID | Output Capture | Review | E2E Verified |
|---|---|---|---|---|---|---|---|---|---|
| **Hermes** (local CLI, `v0.21.0`) | ✅ 7 real profiles (`coreops`, `estimator`, `fieldops`, `guardian`, `orchestrator`, `release`, `verifier`) | ✅ per-profile dispatch (`-p <profile> -z <prompt>`), free model `upstage/solar-pro4:free` via Nous Portal | ✅ fingerprint `e0ce29093dff`, capability routing `construction-operations` | ✅ approval `VALID` gated dispatch; unknown-cost class honored | ✅ **REAL** — output `REAL HERMES DISPATCH OK` captured from live inference | ⚠️ delegation UUID yes; native session id `null` (one-shot CLI mode) | ✅ run feed `resultSummary` | ✅ `REVIEWING` (Aegis) | ✅ stub-based live E2E + real-binary probe |
| **Codex** (plugin-appserver CLI, `0.153.4`) | ✅ after named profile exists (`~/.codex/<name>.config.toml`); zero roster agents with only the main `config.toml` | ✅ `codex-cli 0.153.4` at `~/.codex/plugins/.plugin-appserver/codex.exe`, model from profile (`gpt-6-astra`) | ✅ fingerprint `9673e75f875e`, capability routing `performance-platform` | ✅ approval `VALID` | ✅ **REAL** — output `REAL CODEX CHECK OK` captured from live run | ⚠️ delegation UUID yes; native session id `null` | ✅ run feed `resultSummary` | ✅ `REVIEWING` (Aegis) | ✅ stub-based live E2E + real-binary probe |
| **Gamut / SuperAgent** (desktop host) | ✅ 20 real agents via live host API (`/api/agents`) once the desktop app is running — truthfully `offline` while it is down | ✅ effective runtime (`generic` / `gpt-5.6-terra`) read live; container env verified inside WSL (`ANTHROPIC_BASE_URL=host.docker.internal:4000`, `--model gpt-5.6-terra`) | ✅ plan builds; router fail-closed while offline; dispatched once host was up | ✅ approval `VALID` (fingerprint-bound) | ⚠️ **REAL host dispatch reached** — sessions created via `POST /api/agents/<slug>/sessions` (3 real session IDs); blocked at the **LLM bridge credential**: the `gpt-5.6-*` LiteLLM bridge (`D:\Gamut-OpenAI-Bridge`, Startup shortcut) requires `OPENAI_API_KEY` (User env), which is missing on this machine — agent containers spin without a model endpoint until MC's 300s timeout (truthful failure + bounded retry) | ❌ (no completed session yet) | ❌ | ❌ | ⚠️ failure paths verified (offline host fail-closed; 300s timeout → FAILURE, never COMPLETED, bounded retries); happy path awaits bridge credential |
| **Claude** (Mission Control-native runtime) | n/a — not a platoon roster; MC agent rows with `runtime_type='claude'` | ✅ Claude Code CLI `2.1.237` on PATH; adapter `callClaudeViaCli` present | n/a | n/a | ⚪ not exercised in this validation (avoids uncontrolled Claude quota spend) | — | — | — | — |

Legend: ✅ verified with evidence · ⚠️ partial (documented) · ❌ blocked · ⚪ not attempted (reason given)

## Dispatch routes

| Ecosystem | Route | Adapter |
|---|---|---|
| Hermes | `callHermesViaProfile` → `hermes -p <profile> -z <prompt>` spawn | `HermesCommanderAdapter` (native-profiles inventory) |
| Codex | `callCodexCli` → codex binary, prompt on stdin, output file capture | `CodexCommanderAdapter` (config-profiles / runtime-only inventory) |
| Gamut | `callGamutViaHost` → HTTP `POST {host}/api/agents/<slug>/sessions` | `GamutCommanderAdapter` (host API required) |
| Claude | `callClaudeViaCli` (per-agent CLI session dispatch, #602) | no platoon adapter — MC-native `agents` rows only |

## Current blockers

- **Gamut — OpenAI account has no credits (verified 2026-09-07, after the
  key was set)**: with `OPENAI_API_KEY` configured, the bridge starts via its
  intended mechanism and the full container path works — container env carries
  `ANTHROPIC_BASE_URL=http://host.docker.internal:4000`, the WSL-gateway route
  reaches the bridge, and the bridge logs the agent's `POST /v1/messages`
  arriving (first call `200 OK`). OpenAI then returns
  `429 insufficient_quota / credit_balance_exhausted` — the agent retries with
  backoff and the session terminates truthfully. The moment the account has
  credits, re-run the Gamut probe; expect provider spend on `gpt-5.6-terra` —
  keep objectives tiny.
- **Codex**: zero roster agents unless named profiles exist. To reproduce the
  validated state: `printf 'model = "gpt-6-astra"\n' > ~/.codex/mc-validation.config.toml`
  (profile was removed after validation to leave the machine clean).

## Evidence

- Real-binary probes (temp-DB server, port-isolated, per-run project created
  and deleted): `resultSummary` values `REAL HERMES DISPATCH OK`,
  `REAL CODEX CHECK OK` captured from live executor runs; server logs record
  the adapter lines `Dispatching task via Hermes profile (profile: coreops)`
  and `Dispatching task via Codex CLI`.
- Gamut fail-closed evidence: with 20 offline Gamut roster rows bound, the
  router selected the available Hermes specialist; no dispatch attempted to
  the offline host.
- Gamut host-restoration evidence (2026-09-07): host relaunched, API healthy
  on `127.0.0.1:47891`; roster shows all 20 agents `available`; MC dispatch
  created real host sessions (e.g. `032f0a4a-1ba0-4288-ad39-a58b83079348`) and
  classified the model-bridge stall as `Gamut session ... timed out after
  300s` → FAILURE with bounded retries, never a false success. Container-side
  evidence: stuck `claude` processes inside the `superagent` WSL distro carry
  `ANTHROPIC_BASE_URL=http://host.docker.internal:4000`; `/etc/hosts` maps
  that name to the distro gateway `192.168.16.1`; nothing listened there
  (bridge absent + port squatted by the container's own published port).
- Stub-based live E2E (mock executor, no provider spend):
  `scripts/e2e-agentos-live.cjs` — 62 checks passing, including failure paths
  (stale approval, offline executor, non-zero exit, 402 mapping, transport
  retry, cancellation invariant) and the SSE contract (§4b).
