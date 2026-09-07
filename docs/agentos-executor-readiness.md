# AgentOS Executor Readiness Matrix

Canonical record of what each executor ecosystem can actually do through the
AgentOS orchestration layer, with the evidence used to verify it. A capability
is marked ✅ only when verified against the real runtime on this machine
(Windows 11, Node 26, Mission Control @ `agentos/master-command-center`).
Validation date: 2026-09-06.

## Matrix

| Ecosystem | Discovered | Runtime Resolved | Planning | Authorization | Real Dispatch | Native Run ID | Output Capture | Review | E2E Verified |
|---|---|---|---|---|---|---|---|---|---|
| **Hermes** (local CLI, `v0.21.0`) | ✅ 7 real profiles (`coreops`, `estimator`, `fieldops`, `guardian`, `orchestrator`, `release`, `verifier`) | ✅ per-profile dispatch (`-p <profile> -z <prompt>`), free model `upstage/solar-pro4:free` via Nous Portal | ✅ fingerprint `e0ce29093dff`, capability routing `construction-operations` | ✅ approval `VALID` gated dispatch; unknown-cost class honored | ✅ **REAL** — output `REAL HERMES DISPATCH OK` captured from live inference | ⚠️ delegation UUID yes; native session id `null` (one-shot CLI mode) | ✅ run feed `resultSummary` | ✅ `REVIEWING` (Aegis) | ✅ stub-based live E2E + real-binary probe |
| **Codex** (plugin-appserver CLI, `0.153.4`) | ✅ after named profile exists (`~/.codex/<name>.config.toml`); zero roster agents with only the main `config.toml` | ✅ `codex-cli 0.153.4` at `~/.codex/plugins/.plugin-appserver/codex.exe`, model from profile (`gpt-6-astra`) | ✅ fingerprint `9673e75f875e`, capability routing `performance-platform` | ✅ approval `VALID` | ✅ **REAL** — output `REAL CODEX CHECK OK` captured from live run | ⚠️ delegation UUID yes; native session id `null` | ✅ run feed `resultSummary` | ✅ `REVIEWING` (Aegis) | ✅ stub-based live E2E + real-binary probe |
| **Gamut / SuperAgent** (desktop host) | ✅ 20 real agent dirs under `%APPDATA%\Superagent\agents` — truthfully `offline` while host is down | ✅ effective runtime read from host `settings.json` (`generic` / `gpt-5.6-terra`), shared with plan fingerprints | ✅ plan builds; router **fail-closed** — routed to an available executor instead of the offline platoon | n/a — dispatch never reached | ❌ **BLOCKED**: host API not listening on `127.0.0.1:47891` (verified `Get-NetTCPConnection` + HTTP probe) | ❌ | ❌ | ❌ | ❌ (failure classification verified: offline platoon never yields false success) |
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

- **Gamut**: start the SuperAgent desktop host (must listen on
  `127.0.0.1:47891`, verified by `isGamutHostListeningSync()`). Everything
  upstream (discovery, registration, effective-runtime resolution, planning)
  already works. Re-run the validation probe after the host is up; expect
  provider spend on the configured `gpt-5.6-terra` model, so keep objectives
  tiny.
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
- Stub-based live E2E (mock executor, no provider spend):
  `scripts/e2e-agentos-live.cjs` — 62 checks passing, including failure paths
  (stale approval, offline executor, non-zero exit, 402 mapping, transport
  retry, cancellation invariant) and the SSE contract (§4b).
