import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * Tests for the E2E harness's bounded transient-transport retry
 * (scripts/lib/e2e-fetch-retry.cjs). These lock in the transport-reset
 * invariants required by the AgentOS failure-path coverage:
 *   - transient failures retry and recover when a later attempt succeeds
 *   - retry count is bounded (no unbounded loop)
 *   - non-transient errors fail fast (no retry storm)
 *   - the attempt counter lets callers prove no duplicate submission
 */

const require = createRequire(import.meta.url)
const {
  attemptWithRetry,
  classifyTransientFailure,
  MAX_ATTEMPTS,
} = require('../../../scripts/lib/e2e-fetch-retry.cjs') as {
  attemptWithRetry: (fn: (attempt: number) => Promise<unknown>, opts?: Record<string, unknown>) => Promise<{
    ok: boolean
    value?: unknown
    error?: unknown
    attempts: number
  }>
  classifyTransientFailure: (err: unknown) => boolean
  MAX_ATTEMPTS: number
}

function transientError() {
  return new Error('fetch failed')
}

describe('e2e fetch retry: transient transport reset', () => {
  it('classifies transport failures as transient and HTTP-level errors as not', () => {
    expect(classifyTransientFailure(new Error('fetch failed'))).toBe(true)
    expect(classifyTransientFailure(new Error('Unable to connect. ECONNRESET.'))).toBe(true)
    expect(classifyTransientFailure(new Error('socket hang up'))).toBe(true)
    expect(classifyTransientFailure(new Error('HTTP 402 insufficient balance'))).toBe(false)
    expect(classifyTransientFailure(new Error('Unexpected token < in JSON'))).toBe(false)
    expect(classifyTransientFailure(null)).toBe(false)
  })

  it('recovers when a later attempt succeeds', async () => {
    const attempts: number[] = []
    const result = await attemptWithRetry(
      async (attempt) => {
        attempts.push(attempt)
        if (attempt < 3) throw transientError()
        return 'recovered'
      },
      { delayMs: 1 },
    )
    expect(result.ok).toBe(true)
    expect(result.value).toBe('recovered')
    expect(result.attempts).toBe(3)
    expect(attempts).toEqual([1, 2, 3])
  })

  it('bounds the retry count at MAX_ATTEMPTS and reports the last error', async () => {
    let calls = 0
    const result = await attemptWithRetry(
      async () => {
        calls++
        throw transientError()
      },
      { delayMs: 1 },
    )
    expect(result.ok).toBe(false)
    expect(calls).toBe(MAX_ATTEMPTS)
    expect(result.attempts).toBe(MAX_ATTEMPTS)
    expect((result.error as Error).message).toBe('fetch failed')
  })

  it('fails fast on non-transient errors without retrying', async () => {
    let calls = 0
    const result = await attemptWithRetry(
      async () => {
        calls++
        throw new Error('HTTP 402 insufficient balance')
      },
      { delayMs: 1 },
    )
    expect(result.ok).toBe(false)
    expect(calls).toBe(1)
  })

  it('invokes the operation exactly once per attempt — no duplicate submission', async () => {
    const submissions: number[] = []
    const result = await attemptWithRetry(
      async (attempt) => {
        // Simulate a transport reset AFTER the server may have seen the request
        // on attempt 1; the caller-side contract is one invocation per attempt
        // and success on the retry — callers assert server-side effects here.
        submissions.push(attempt)
        if (attempt === 1) throw transientError()
        return { created: true, attempt }
      },
      { delayMs: 1 },
    )
    expect(result.ok).toBe(true)
    expect(submissions).toEqual([1, 2])
    expect(submissions.length).toBe(result.attempts)
  })
})
