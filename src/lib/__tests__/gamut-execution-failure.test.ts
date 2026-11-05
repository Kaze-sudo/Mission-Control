import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectGamutSessionResult, runGamutAgent } from '../gamut-host'
import { dispatchFailureIsTerminal } from '../task-dispatch'
import { getDelegation, updateDelegation } from '../delegation-ledger'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  activities: [] as unknown[],
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  db_helpers: { logActivity: (...args: unknown[]) => state.activities.push(args) },
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

const PROVIDER_402_TEXT = 'API Error: 402 Workspace has insufficient balance. Top up to continue.'

describe('gamut terminal-result classification (result-truthfulness)', () => {
  const transcript = (...items: unknown[]) => ({ messages: items })

  it('classifies normal authored output as success', () => {
    const r = inspectGamutSessionResult(transcript({ type: 'assistant', content: { text: 'completed safely' } }))
    expect(r).toEqual({ text: 'completed safely', failed: false, errorCode: null })
  })

  it('classifies a structured host apiError marker as a provider failure (observed 402 payload)', () => {
    const r = inspectGamutSessionResult(transcript({
      type: 'assistant',
      content: { text: PROVIDER_402_TEXT },
      apiError: 'unknown',
      usage: { inputTokens: 0, outputTokens: 0 },
    }))
    expect(r.failed).toBe(true)
    expect(r.errorCode).toBe('unknown')
    expect(r.text).toContain('402')
  })

  it('recognizes the OpenRouter 402 envelope even without the structured marker (narrow fallback)', () => {
    const r = inspectGamutSessionResult(transcript({
      type: 'assistant',
      content: { text: PROVIDER_402_TEXT },
    }))
    expect(r).toEqual({ text: PROVIDER_402_TEXT, failed: true, errorCode: null })
  })

  it('recognizes other machine API-error envelopes (401 auth) as failures', () => {
    const r = inspectGamutSessionResult(transcript({
      type: 'assistant',
      content: { text: 'API Error: 401 Authentication failed' },
    }))
    expect(r.failed).toBe(true)
  })

  it('does NOT reject legitimate model prose that merely discusses an API error', () => {
    const r = inspectGamutSessionResult(transcript({
      type: 'assistant',
      content: { text: 'The upstream API returned 402 during my research pass, but here is the completed analysis you asked for.' },
    }))
    expect(r.failed).toBe(false)
  })

  it('does NOT reject model output that quotes the envelope mid-text', () => {
    const r = inspectGamutSessionResult(transcript({
      type: 'assistant',
      content: { text: 'Note: no "API Error: 402 Workspace has insufficient balance" was encountered during this synthesis.' },
    }))
    expect(r.failed).toBe(false)
  })

  it('reports a text-less session as not-failed so the caller decides (never fabricated success)', () => {
    const r = inspectGamutSessionResult(transcript({ type: 'user', content: { text: 'hello' } }))
    expect(r).toEqual({ text: null, failed: false, errorCode: null })
  })
})

describe('runGamutAgent structured result', () => {
  it('surfaces the observed 402 as a failed result with session id + diagnostic (no fake success)', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 'session-402' }), { status: 201, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify([{ id: 'session-402', isActive: true, isAwaitingInput: false }]), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify([{ id: 'session-402', isActive: false, isAwaitingInput: false }]), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ messages: [{ type: 'assistant', content: { text: PROVIDER_402_TEXT }, apiError: 'unknown', usage: { inputTokens: 0, outputTokens: 0 } }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))
    const result = await runGamutAgent({ slug: 'chief', message: 'test task', timeoutMs: 1000, pollMs: 1 })
    expect(result).toEqual({
      sessionId: 'session-402',
      text: PROVIDER_402_TEXT,
      failed: true,
      errorCode: 'unknown',
    })
  })

  it('keeps successful runs byte-identical to the pre-fix result shape', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 'session-ok' }), { status: 201, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify([{ id: 'session-ok', isActive: true, isAwaitingInput: false }]), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify([{ id: 'session-ok', isActive: false, isAwaitingInput: false }]), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ messages: [{ type: 'assistant', content: { text: 'completed safely' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))
    const result = await runGamutAgent({ slug: 'chief', message: 'test task', timeoutMs: 1000, pollMs: 1 })
    expect(result).toEqual({ sessionId: 'session-ok', text: 'completed safely' })
  })
})

describe('dispatch terminal-vs-retry decision', () => {
  it('retryable failures within the attempt budget are retried', () => {
    expect(dispatchFailureIsTerminal({ currentAttempts: 0 })).toBe(false)
    expect(dispatchFailureIsTerminal({ currentAttempts: 3 })).toBe(false)
  })

  it('retry budget exhaustion is terminal', () => {
    expect(dispatchFailureIsTerminal({ currentAttempts: 4 })).toBe(true)
    expect(dispatchFailureIsTerminal({ currentAttempts: 0, maxDispatchRetries: 1 })).toBe(true)
  })

  it('non-retryable provider failures are terminal from the very first attempt — no auto-retry loop', () => {
    expect(dispatchFailureIsTerminal({ currentAttempts: 0, nonRetryable: true })).toBe(true)
    expect(dispatchFailureIsTerminal({ currentAttempts: 4, nonRetryable: true })).toBe(true)
  })
})

describe('delegation failure ingestion preserves the native execution record', () => {
  beforeEach(() => {
    state.db = new Database(':memory:')
    state.db.exec(`
      CREATE TABLE agentos_delegations (
        id TEXT PRIMARY KEY,
        task_id INTEGER NOT NULL,
        project_id INTEGER,
        workspace_id INTEGER NOT NULL,
        objective_id INTEGER,
        platoon_id TEXT,
        specialist_name TEXT,
        routing_agent_name TEXT,
        runtime_type TEXT,
        status TEXT NOT NULL DEFAULT 'claimed',
        native_session_id TEXT,
        native_run_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        result_summary TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER
      );
      INSERT INTO agentos_delegations (id, task_id, workspace_id, status, attempt, created_at, updated_at)
      VALUES ('dlg-402', 9, 1, 'claimed', 6, 1, 1);
    `)
  })

  it('marks the delegation terminal failed with native session id + diagnostic preserved (NOT completed/review)', () => {
    const updated = updateDelegation('dlg-402', 1, {
      status: 'failed',
      nativeSessionId: '6a2519ee-fa0a-4ea5-943d-77dc0b81397b',
      errorMessage: PROVIDER_402_TEXT,
      completed: true,
    })
    expect(updated?.status).toBe('failed')
    expect(updated?.nativeSessionId).toBe('6a2519ee-fa0a-4ea5-943d-77dc0b81397b')
    expect(updated?.errorMessage).toBe(PROVIDER_402_TEXT)
    expect(updated?.completedAt).not.toBeNull()
    expect(updated?.resultSummary).toBeNull()
  })

  it('the ledger row reflects the preserved terminal failure', () => {
    updateDelegation('dlg-402', 1, {
      status: 'failed',
      nativeSessionId: '6a2519ee-fa0a-4ea5-943d-77dc0b81397b',
      errorMessage: PROVIDER_402_TEXT,
      completed: true,
    })
    const d = getDelegation('dlg-402', 1)
    expect(d?.status).toBe('failed')
    expect(d?.nativeSessionId).toBe('6a2519ee-fa0a-4ea5-943d-77dc0b81397b')
    expect(d?.errorMessage).toBe(PROVIDER_402_TEXT)
  })
})
