import '@testing-library/jest-dom'

// Hermetic unit tests: pnpm auto-loads the developer machine's `.env` into the
// test process. `MC_DISABLE_RATE_LIMIT=1` (a runtime operator convenience) must
// never leak in — it silently bypasses every non-critical limiter and turns the
// rate-limit suite into false failures. Tests that exercise the disable flag
// set/clear it explicitly. `MISSION_CONTROL_TEST_MODE` is intentionally left
// alone: some suites assert its runtime behavior.
delete process.env.MC_DISABLE_RATE_LIMIT
