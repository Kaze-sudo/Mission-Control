import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearDeviceIdentity,
  getOrCreateDeviceIdentity,
  signPayload,
} from '@/lib/device-identity'

describe('device identity secure fallback', () => {
  const originalIndexedDb = globalThis.indexedDB

  // Node >= 26 ships an experimental global `localStorage` that is disabled
  // unless `--localstorage-file` is provided; it shadows jsdom's working
  // implementation in the vitest environment. Provide an explicit in-memory
  // stub so the module under test (which uses the real browser API) behaves
  // as it does in a browser. Assertions are unchanged.
  const originalLocalStorage = globalThis.localStorage
  let memoryStore: Record<string, string> = {}

  beforeEach(() => {
    memoryStore = {}
    if (!originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem: (key: string) => (key in memoryStore ? memoryStore[key] : null),
          setItem: (key: string, value: string) => {
            memoryStore[key] = String(value)
          },
          removeItem: (key: string) => {
            delete memoryStore[key]
          },
          clear: () => {
            memoryStore = {}
          },
        } as Storage,
      })
    }
    clearDeviceIdentity()
    localStorage.clear()
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: undefined,
    })
  })

  afterEach(() => {
    clearDeviceIdentity()
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: originalIndexedDb,
    })
    if (!originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalLocalStorage,
      })
    }
  })

  it('uses a non-extractable in-memory key when IndexedDB is unavailable', async () => {
    const identity = await getOrCreateDeviceIdentity()

    expect(identity.storageMode).toBe('memory-ephemeral')
    expect(identity.privateKey.extractable).toBe(false)
    expect(localStorage.getItem('mc-device-privkey')).toBeNull()
    await expect(crypto.subtle.exportKey('pkcs8', identity.privateKey)).rejects.toThrow()
  })

  it('reuses the ephemeral identity for same-page reconnects', async () => {
    const first = await getOrCreateDeviceIdentity()
    const second = await getOrCreateDeviceIdentity()

    expect(second).toBe(first)
    const signed = await signPayload(second.privateKey, 'challenge')
    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('deletes a legacy plaintext key instead of importing it without secure persistence', async () => {
    localStorage.setItem('mc-device-id', 'legacy-device')
    localStorage.setItem('mc-device-pubkey', 'legacy-public-key')
    localStorage.setItem('mc-device-privkey', 'legacy-private-key')

    const identity = await getOrCreateDeviceIdentity()

    expect(identity.storageMode).toBe('memory-ephemeral')
    expect(identity.deviceId).not.toBe('legacy-device')
    expect(localStorage.getItem('mc-device-privkey')).toBeNull()
  })
})
