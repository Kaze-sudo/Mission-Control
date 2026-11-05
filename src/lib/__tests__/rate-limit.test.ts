import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createKeyedRateLimiter, createRateLimiter } from '@/lib/rate-limit'

describe('createRateLimiter', () => {
  const originalDisableRateLimit = process.env.MC_DISABLE_RATE_LIMIT
  const originalTestMode = process.env.MISSION_CONTROL_TEST_MODE

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalDisableRateLimit === undefined) delete process.env.MC_DISABLE_RATE_LIMIT
    else process.env.MC_DISABLE_RATE_LIMIT = originalDisableRateLimit
    if (originalTestMode === undefined) delete process.env.MISSION_CONTROL_TEST_MODE
    else process.env.MISSION_CONTROL_TEST_MODE = originalTestMode
  })

  it('tracks authenticated identities independently with a keyed limiter', () => {
    const limiter = createKeyedRateLimiter({ windowMs: 60_000, maxRequests: 1 })

    expect(limiter('workspace-1:user-1')).toBeNull()
    expect(limiter('workspace-1:user-2')).toBeNull()
    expect(limiter('workspace-1:user-1')?.status).toBe(429)
  })

  it('does not bypass a critical keyed limiter in test mode', () => {
    process.env.MC_DISABLE_RATE_LIMIT = '1'
    process.env.MISSION_CONTROL_TEST_MODE = '1'
    const limiter = createKeyedRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      critical: true,
    })

    expect(limiter('workspace-1:user-1')).toBeNull()
    expect(limiter('workspace-1:user-1')?.status).toBe(429)
  })
  it('bypasses a critical IP limiter in test mode when the request has no client-IP context', () => {
    process.env.MC_DISABLE_RATE_LIMIT = '1'
    process.env.MISSION_CONTROL_TEST_MODE = '1'
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, critical: true })

    // Browser/UI login traffic carries no x-real-ip (and no trusted proxies),
    // so every shared-bucket request stays allowed across the whole window.
    expect(limiter(makeNoIpRequest())).toBeNull()
    expect(limiter(makeNoIpRequest())).toBeNull()
    expect(limiter(makeNoIpRequest())).toBeNull()
  })

  it('keeps enforcement for a critical IP limiter when the request presents x-real-ip in test mode', () => {
    process.env.MC_DISABLE_RATE_LIMIT = '1'
    process.env.MISSION_CONTROL_TEST_MODE = '1'
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, critical: true })

    // Explicit x-real-ip keeps the limiter live (rate-limiting.spec.ts path).
    expect(limiter(makeRequest('10.99.99.99'))).toBeNull()
    expect(limiter(makeRequest('10.99.99.99'))?.status).toBe(429)
  })

  it('does not bypass a critical IP limiter without explicit test mode', () => {
    process.env.MC_DISABLE_RATE_LIMIT = '1'
    delete process.env.MISSION_CONTROL_TEST_MODE
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, critical: true })

    expect(limiter(makeRequest('10.99.99.99'))).toBeNull()
    expect(limiter(makeRequest('10.99.99.99'))?.status).toBe(429)
    // The shared unknown bucket is equally enforced without the opt-in:
    // the first request opens the window, the next one over it is 429.
    expect(limiter(makeRequest())).toBeNull()
    expect(limiter(makeRequest())?.status).toBe(429)
  })

  function makeRequest(ip: string = '127.0.0.1'): Request {
    return new Request('http://localhost/api/test', {
      headers: new Headers({ 'x-real-ip': ip }),
    })
  }

  // No client-IP headers at all (browser/UI traffic without trusted proxies)
  function makeNoIpRequest(): Request {
    return new Request('http://localhost/api/test', { headers: new Headers() })
  }

  it('allows first request within limit (returns null)', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5 })
    const result = limiter(makeRequest())
    expect(result).toBeNull()
  })

  it('allows requests up to the max limit', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3 })
    expect(limiter(makeRequest())).toBeNull()
    expect(limiter(makeRequest())).toBeNull()
    expect(limiter(makeRequest())).toBeNull()
  })

  it('blocks request exceeding the limit with 429', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2 })
    limiter(makeRequest())
    limiter(makeRequest())
    const blocked = limiter(makeRequest())
    expect(blocked).not.toBeNull()
    expect(blocked!.status).toBe(429)
  })

  it('uses custom message in 429 response', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      message: 'Slow down!',
    })
    limiter(makeRequest())
    const blocked = limiter(makeRequest())
    expect(blocked).not.toBeNull()
    const body = await blocked!.json()
    expect(body.error).toBe('Slow down!')
  })

  it('resets after the window expires', () => {
    const limiter = createRateLimiter({ windowMs: 10_000, maxRequests: 1 })
    expect(limiter(makeRequest())).toBeNull()
    expect(limiter(makeRequest())).not.toBeNull()

    // Advance past the window
    vi.advanceTimersByTime(11_000)

    // Should be allowed again
    expect(limiter(makeRequest())).toBeNull()
  })

  it('tracks different IPs independently', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 })
    expect(limiter(makeRequest('10.0.0.1'))).toBeNull()
    expect(limiter(makeRequest('10.0.0.2'))).toBeNull()
    // First IP now blocked
    expect(limiter(makeRequest('10.0.0.1'))).not.toBeNull()
    // Second IP now blocked
    expect(limiter(makeRequest('10.0.0.2'))).not.toBeNull()
  })

  it('evicts oldest entry when maxEntries is reached', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1, maxEntries: 3 })

    // Fill to capacity and exhaust 10.0.0.1's quota
    limiter(makeRequest('10.0.0.1'))
    vi.advanceTimersByTime(1)
    expect(limiter(makeRequest('10.0.0.1'))).not.toBeNull() // blocked: quota consumed

    limiter(makeRequest('10.0.0.2'))
    vi.advanceTimersByTime(1)
    limiter(makeRequest('10.0.0.3'))
    vi.advanceTimersByTime(1)

    // Store has 3 entries (A blocked, B, C). Adding D evicts A (oldest resetAt)
    limiter(makeRequest('10.0.0.4'))

    // 10.0.0.1 was evicted — counter is gone, this is allowed (fresh entry)
    expect(limiter(makeRequest('10.0.0.1'))).toBeNull()
    // Now 10.0.0.1 is back at count=1 and blocked
    expect(limiter(makeRequest('10.0.0.1'))).not.toBeNull()

    // 10.0.0.3 should still be tracked (not evicted — it had the newest resetAt)
    expect(limiter(makeRequest('10.0.0.3'))).not.toBeNull()
  })
})
