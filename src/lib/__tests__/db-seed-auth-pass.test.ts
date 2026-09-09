import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { resolveSeedAuthPassword } from '../db'
import { logger } from '../logger'

describe('resolveSeedAuthPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns AUTH_PASS when AUTH_PASS_B64 is not set', () => {
    const password = resolveSeedAuthPassword({ AUTH_PASS: 'plain-secret-123' } as unknown as NodeJS.ProcessEnv)
    expect(password).toBe('plain-secret-123')
  })

  it('prefers AUTH_PASS_B64 when present and valid', () => {
    const encoded = Buffer.from('secret#with#hash', 'utf8').toString('base64')
    const password = resolveSeedAuthPassword({
      AUTH_PASS: 'fallback-value',
      AUTH_PASS_B64: encoded,
    } as unknown as NodeJS.ProcessEnv)
    expect(password).toBe('secret#with#hash')
  })

  it('falls back to AUTH_PASS when AUTH_PASS_B64 is invalid', () => {
    const password = resolveSeedAuthPassword({
      AUTH_PASS: 'fallback-value',
      AUTH_PASS_B64: '%%%not-base64%%%',
    } as unknown as NodeJS.ProcessEnv)
    expect(password).toBe('fallback-value')
  })

  it('returns null when no password env var is set', () => {
    const password = resolveSeedAuthPassword({} as unknown as NodeJS.ProcessEnv)
    expect(password).toBeNull()
  })

  it('warns when AUTH_PASS and AUTH_PASS_B64 are both set but decode to different values', () => {
    const encoded = Buffer.from('b64-secret', 'utf8').toString('base64')
    const password = resolveSeedAuthPassword({
      AUTH_PASS: 'plain-secret',
      AUTH_PASS_B64: encoded,
    } as unknown as NodeJS.ProcessEnv)
    expect(password).toBe('b64-secret')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('different values'),
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AUTH_PASS_B64 is authoritative'),
    )
  })

  it('does not warn when both are set and decode to the same value', () => {
    const encoded = Buffer.from('same-secret', 'utf8').toString('base64')
    const password = resolveSeedAuthPassword({
      AUTH_PASS: 'same-secret',
      AUTH_PASS_B64: encoded,
    } as unknown as NodeJS.ProcessEnv)
    expect(password).toBe('same-secret')
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
