const DEFAULT_GAMUT_HOST_API = 'http://127.0.0.1:47891/api'

export interface GamutHostAgent {
  slug: string
  name?: string
  status?: string
}

export interface GamutHostSession {
  id: string
  isActive?: boolean
  isAwaitingInput?: boolean
  name?: string
  lastActivityAt?: string
}

export interface GamutRunResult {
  sessionId: string
  text: string | null
}

function baseUrl(): string {
  return (process.env.GAMUT_HOST_API_URL || DEFAULT_GAMUT_HOST_API).replace(/\/+$/, '')
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function listGamutHostAgents(timeoutMs = 3000): Promise<GamutHostAgent[]> {
  const response = await fetchWithTimeout(`${baseUrl()}/agents`, {}, timeoutMs)
  if (!response.ok) throw new Error(`Gamut host returned HTTP ${response.status}`)
  const data = await response.json()
  if (!Array.isArray(data)) throw new Error('Gamut host returned an invalid agents payload')
  return data as GamutHostAgent[]
}

export async function probeGamutHost(timeoutMs = 2000): Promise<boolean> {
  try {
    await listGamutHostAgents(timeoutMs)
    return true
  } catch {
    return false
  }
}
function extractAssistantText(payload: unknown): string | null {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { messages?: unknown[] }).messages)
      ? (payload as { messages: unknown[] }).messages
      : []
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i] as Record<string, unknown>
    if (item?.type !== 'assistant') continue
    const content = item.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (content && typeof content === 'object') {
      const text = (content as Record<string, unknown>).text
      if (typeof text === 'string' && text.trim()) return text.trim()
    }
  }
  return null
}

async function getSession(slug: string, sessionId: string): Promise<GamutHostSession | null> {
  const response = await fetchWithTimeout(`${baseUrl()}/agents/${encodeURIComponent(slug)}/sessions?limit=100`, {}, 5000)
  if (!response.ok) throw new Error(`Gamut session status returned HTTP ${response.status}`)
  const sessions = await response.json()
  if (!Array.isArray(sessions)) return null
  return (sessions as GamutHostSession[]).find(session => session.id === sessionId) || null
}

async function getSessionMessages(slug: string, sessionId: string): Promise<unknown> {
  const url = `${baseUrl()}/agents/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&media=ref`
  const response = await fetchWithTimeout(url, {}, 10000)
  if (!response.ok) throw new Error(`Gamut session messages returned HTTP ${response.status}`)
  return await response.json()
}

export async function createGamutSession(slug: string, message: string): Promise<string> {
  const response = await fetchWithTimeout(`${baseUrl()}/agents/${encodeURIComponent(slug)}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  }, 45000)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Gamut session creation failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
  const data = await response.json() as { id?: string }
  if (!data.id) throw new Error('Gamut session creation returned no session ID')
  return data.id
}
export async function runGamutAgent(input: {
  slug: string
  message: string
  timeoutMs?: number
  pollMs?: number
}): Promise<GamutRunResult> {
  const timeoutMs = input.timeoutMs ?? 300_000
  const pollMs = input.pollMs ?? 1500
  const sessionId = await createGamutSession(input.slug, input.message)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const session = await getSession(input.slug, sessionId)
    if (session?.isAwaitingInput) {
      throw new Error(`Gamut session ${sessionId} is waiting for user input`)
    }
    if (session && session.isActive === false) {
      const messages = await getSessionMessages(input.slug, sessionId)
      return { sessionId, text: extractAssistantText(messages) }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }

  throw new Error(`Gamut session ${sessionId} timed out after ${Math.round(timeoutMs / 1000)}s`)
}
export function isGamutHostListeningSync(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "$c=Get-NetTCPConnection -State Listen -LocalPort 47891 -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){'READY'}else{'DOWN'}",
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    return String(result.stdout || '').includes('READY')
  } catch {
    return false
  }
}
