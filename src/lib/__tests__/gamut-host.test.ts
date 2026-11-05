import { afterEach, describe, expect, it, vi } from 'vitest'
import { listGamutHostAgents, runGamutAgent } from '../gamut-host'

afterEach(() => { vi.unstubAllGlobals() })

describe('Gamut host client', () => {
  it('uses the official host agents endpoint for discovery', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ slug: 'chief', name: 'Chief of Staff' }]), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const agents = await listGamutHostAgents(100)
    expect(agents).toEqual([{ slug: 'chief', name: 'Chief of Staff' }])
    const firstCall = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit?]
    expect(String(firstCall[0])).toContain('/api/agents')
  })

  it('creates, polls, and reads a completed Gamut session', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 'session-1' }), { status: 201, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify([{ id: 'session-1', isActive: true, isAwaitingInput: false }]), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify([{ id: 'session-1', isActive: false, isAwaitingInput: false }]), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ messages: [{ type: 'assistant', content: { text: 'completed safely' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ]
    const fetchMock = vi.fn(async () => {
      const next = responses.shift()
      if (!next) throw new Error('unexpected fetch')
      return next
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await runGamutAgent({ slug: 'chief', message: 'test task', timeoutMs: 1000, pollMs: 1 })
    expect(result).toEqual({ sessionId: 'session-1', text: 'completed safely' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const firstCall = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit?]
    expect(String(firstCall[0])).toContain('/api/agents/chief/sessions')
  })

  it('stops waiting when Gamut requests user input', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 'session-2' }), { status: 201, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify([{ id: 'session-2', isActive: true, isAwaitingInput: true }]), { status: 200, headers: { 'content-type': 'application/json' } }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))
    await expect(runGamutAgent({ slug: 'chief', message: 'test task', timeoutMs: 100, pollMs: 1 }))
      .rejects.toThrow('waiting for user input')
  })
})
