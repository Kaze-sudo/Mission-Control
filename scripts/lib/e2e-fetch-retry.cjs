#!/usr/bin/env node
'use strict'
/**
 * Bounded retry wrapper for E2E harness HTTP calls.
 *
 * Long server calls can reset the keep-alive socket between requests,
 * surfacing as "fetch failed" / ECONNRESET on the NEXT request. The retry
 * recovers from those transient transport failures. Semantics (tested in
 * src/lib/__tests__/http-with-retry.test.ts):
 *   - a failure that happens BEFORE the request reaches the server (connection
 *     reset, DNS hiccup) leaves no server-side effect, so retrying is safe;
 *   - a request that DID reach the server must never be blindly re-sent here —
 *     callers own idempotency for those (the harness only retries errors that
 *     look like transport failures, and the classification below never
 *     includes HTTP responses).
 *
 * Exposed for tests: classifyTransientFailure and attemptCounter.
 */

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 1000

/** Network-failure fingerprints treated as transient transport errors. */
function classifyTransientFailure(err) {
  if (!err) return false
  const msg = String(err.message || err).toLowerCase()
  return (
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('other side closed')
  )
}

/**
 * Runs `fn` with bounded retries. `fn` receives a 1-based attempt counter so
 * callers can assert how many attempts were made and verify no duplicate
 * server-side submissions occurred (only the final attempt should succeed).
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {{ maxAttempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 */
async function attemptWithRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS
  const delayMs = opts.delayMs ?? RETRY_DELAY_MS
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { ok: true, value: await fn(attempt), attempts: attempt }
    } catch (err) {
      lastErr = err
      if (attempt >= maxAttempts || !classifyTransientFailure(err)) break
      await sleep(delayMs)
    }
  }
  return { ok: false, error: lastErr, attempts: maxAttempts }
}

module.exports = { attemptWithRetry, classifyTransientFailure, MAX_ATTEMPTS, RETRY_DELAY_MS }
