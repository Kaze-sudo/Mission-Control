import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useServerEvents } from '@/lib/use-server-events'

/**
 * Tests for the reconnect side of the app-wide SSE hook.
 *
 * The stream is live-only (at-least-once, no replay): everything emitted while
 * the connection is down is lost. The hook must therefore announce a genuine
 * RE-connect (window event `mc:sse-reconnected`) so live operator surfaces
 * (Runs, Approval Center, Review Queue, Overview) converge immediately from
 * canonical backend state instead of sitting on stale data until their next
 * poll tick. The initial connection is NOT a reconnect and must stay silent.
 */

const storeActions = vi.hoisted(() => ({
  setConnection: vi.fn(),
  addTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  addAgent: vi.fn(),
  updateAgent: vi.fn(),
  addChatMessage: vi.fn(),
  addNotification: vi.fn(),
  addActivity: vi.fn(),
}))

vi.mock('@/store', () => ({
  useMissionControl: () => storeActions,
}))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  closed = false
  constructor() {
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
}

describe('useServerEvents reconnect announcement', () => {
  let reconnectEvents: number
  let listener: (() => void) | null = null

  beforeEach(() => {
    FakeEventSource.instances = []
    reconnectEvents = 0
    vi.stubGlobal('EventSource', FakeEventSource)
    listener = () => { reconnectEvents++ }
    window.addEventListener('mc:sse-reconnected', listener)
  })

  afterEach(() => {
    if (listener) window.removeEventListener('mc:sse-reconnected', listener)
    listener = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function open(es: FakeEventSource): void {
    es.onopen?.()
  }

  function drop(es: FakeEventSource): void {
    es.onerror?.()
  }

  it('does not announce the initial connection', () => {
    renderHook(() => useServerEvents())
    const es = FakeEventSource.instances[0]
    act(() => open(es))
    expect(reconnectEvents).toBe(0)
    expect(storeActions.setConnection).toHaveBeenCalledWith({ sseConnected: true })
  })

  it('announces exactly once when the stream reopens after a drop', () => {
    renderHook(() => useServerEvents())
    const es = FakeEventSource.instances[0]
    act(() => open(es)) // initial connect — silent
    act(() => drop(es)) // connection lost
    expect(storeActions.setConnection).toHaveBeenLastCalledWith({ sseConnected: false })
    act(() => open(es)) // reconnected
    expect(reconnectEvents).toBe(1)
    expect(storeActions.setConnection).toHaveBeenLastCalledWith({ sseConnected: true })
  })

  it('stays silent across repeated drops without a successful reopen between them', () => {
    renderHook(() => useServerEvents())
    const es = FakeEventSource.instances[0]
    act(() => open(es))
    act(() => drop(es))
    act(() => drop(es)) // still down; onerror fired again (browser retry attempt)
    expect(reconnectEvents).toBe(0)
    act(() => open(es))
    expect(reconnectEvents).toBe(1)
  })
})
