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
| **Gamut / SuperAgent** (desktop host) | ✅ 20 real agents via live host API (`/api/agents`) once the desktop app is running — truthfully `offline` while it is down | ✅ effective runtime (`generic` / `gpt-5.6-terra`) read live; container env verified inside WSL (`ANTHROPIC_BASE_URL=host.docker.internal:4000`, `--model gpt-5.6-terra`) | ✅ plan builds; router fail-closed while offline; dispatched once host was up | ✅ approval `VALID` (fingerprint-bound) | ✅ **REAL — verified 2026-09-07**: host session created, container executed, model round-trip via the LiteLLM bridge → Nous Portal free tier (`upstage/solar-pro4:free`); delegation `completed` in 34s, attempt 1 | ✅ `nativeSessionId: db1884b5-f324-4720-97ff-b04347f641f0` on the delegation row | ✅ `resultSummary: "REAL GAMUT DISPATCH OK"` | ✅ `REVIEWING` (Aegis) | ✅ full live probe + failure paths (offline fail-closed; quota-exhaustion → truthful FAILURE, bounded retries, never COMPLETED) |
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

- **Gamut — resolved 2026-09-07.** Final wiring: the LiteLLM bridge in
  `D:\Gamut-OpenAI-Bridge` (Startup shortcut, `--host 0.0.0.0`) now routes the
  `gpt-5.6-*` model names to the **Nous Portal free tier**
  (`upstage/solar-pro4:free` at `inference-api.nousresearch.com/v1`) instead
  of the out-of-credits OpenAI account. Auth is sourced at startup from
  Hermes's own credential store (`%LOCALAPPDATA%\hermes\auth.json`) into
  `NOUS_API_KEY` — no secret persisted anywhere new. Caveats: (1) the access
  token is short-lived (~1h; Hermes refreshes it) — restart the bridge if it
  starts returning 401 after an hour; (2) the bridge must be started *before*
  the first agent container, whose auto-published port otherwise squats
  `127.0.0.1:4000`; (3) free tier is rate-limited (~50 rpm) — fine for
  validation, size accordingly for fleet loads.
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
  created real host sessions and classified the model-bridge stall as
  `Gamut session ... timed out after 300s` → FAILURE with bounded retries,
  never a false success. Container-side evidence: stuck `claude` processes
  inside the `superagent` WSL distro carry
  `ANTHROPIC_BASE_URL=http://host.docker.internal:4000`; `/etc/hosts` maps
  that name to the distro gateway `192.168.16.1`.
- Gamut real-dispatch evidence (2026-09-07, after the Nous re-route): direct
  host session `GAMUT NOUS DISPATCH OK` (completed in 15s); full MC probe
  (`scripts/gamut-dispatch-probe.cjs`) delegation `completed` in 34s on
  attempt 1 with `resultSummary: "REAL GAMUT DISPATCH OK"`, native session
  `db1884b5…`, server log line `Dispatching task through Gamut host API
  (gamutSlug: qbs9bmo0ky)`. Bridge smoke: `NOUS BRIDGE OK` served as
  `gpt-5.6-terra`.
- Stub-based live E2E (mock executor, no provider spend):
  `scripts/e2e-agentos-live.cjs` — 62 checks passing, including failure paths
  (stale approval, offline executor, non-zero exit, 402 mapping, transport
  retry, cancellation invariant) and the SSE contract (§4b).
