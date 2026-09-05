const DEFAULT_GAMUT_HOST_API = 'http://127.0.0.1:47891/api'

/**
 * Effective model/provider resolution for Gamut specialists.
 *
 * Gamut/SuperAgent agents have NO per-agent model configuration: every agent
 * inherits the host-wide LLM provider + agent model (settings.json
 * `llmProvider` / `models.agentModel` — e.g. `openrouter` / `sonnet`). We read
 * the same settings file the desktop host writes (its `/api/settings` endpoint
 * mirrors this file) so discovery can attach truthful provider/model metadata
 * without per-agent config duplication. Secrets (apiKeys/auth) are never read.
 */
export interface GamutHostEffectiveRuntime {
  provider: string | null
  model: string | null
  /** Concrete catalog model id the alias resolved to (e.g. claude-sonnet-5). */
  modelResolved: string | null
  /** Provider-qualified canonical id (e.g. anthropic/claude-sonnet-5). */
  canonicalModelId: string | null
  source: 'settings-file' | 'none'
}

/**
 * Resolve a Gamut model alias (settings `models.agentModel`) to its concrete
 * catalog id. Gamut resolves bare family names to the newest model in that
 * family (the app bundle catalog: `family === alias && isLatest`). Aliases we
 * have verified in the installed host catalog map to these concrete ids.
 */
const GAMUT_MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-4-6',
}

export function resolveGamutModelAlias(alias: string | null | undefined): string | null {
  if (!alias || typeof alias !== 'string') return null
  const trimmed = alias.trim()
  if (!trimmed) return null
  return GAMUT_MODEL_ALIASES[trimmed] ?? trimmed
}

const EFFECTIVE_RUNTIME_TTL_MS = 30_000
let effectiveRuntimeCache: { at: number; value: GamutHostEffectiveRuntime } | null = null

function resolveGamutHostEffectiveRuntime(): GamutHostEffectiveRuntime {
  const appData = process.env.APPDATA || require('node:path').join(require('node:os').homedir(), 'AppData', 'Roaming')
  const settingsPath = require('node:path').join(appData, 'Superagent', 'settings.json')
  try {
    const raw = require('node:fs').readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const provider = typeof parsed.llmProvider === 'string' && parsed.llmProvider.trim()
      ? parsed.llmProvider.trim()
      : null
    const models = parsed.models && typeof parsed.models === 'object'
      ? parsed.models as Record<string, unknown>
      : {}
    const model = typeof models.agentModel === 'string' && models.agentModel.trim()
      ? models.agentModel.trim()
      : null
    const modelResolved = resolveGamutModelAlias(model)
    if (provider || model) {
      return {
        provider,
        model,
        modelResolved,
        canonicalModelId: provider === 'openrouter' && modelResolved
          ? (modelResolved.includes('/') ? modelResolved : `anthropic/${modelResolved}`)
          : null,
        source: 'settings-file',
      }
    }
  } catch {
    /* host not configured or settings file unreadable */
  }
  return { provider: null, model: null, modelResolved: null, canonicalModelId: null, source: 'none' }
}

export function getGamutHostEffectiveRuntime(): GamutHostEffectiveRuntime {
  const now = Date.now()
  if (effectiveRuntimeCache && now - effectiveRuntimeCache.at < EFFECTIVE_RUNTIME_TTL_MS) {
    return effectiveRuntimeCache.value
  }
  const value = resolveGamutHostEffectiveRuntime()
  effectiveRuntimeCache = { at: now, value }
  return value
}

export function invalidateGamutEffectiveRuntimeCache(): void {
  effectiveRuntimeCache = null
}

/**
 * Normalized effective runtime identity — the material execution facts that
 * must be stable across cosmetic metadata but MUST change when what would
 * actually execute changes (provider/model/runtime drift).
 *
 * For Gamut/SuperAgent host runtimes the host-wide settings (settings.json
 * `llmProvider` / `models.agentModel`) are authoritative: every agent inherits
 * them, so they decide what a NEW native session would run. When the host is
 * configured (source 'settings-file') the live values win; otherwise (no
 * settings file / unreadable — e.g. isolated test envs) we fall back to the
 * annotated/config values so behavior stays identical to the legacy path.
 *
 * This is the single shared resolver used by BOTH plan building and dispatch
 * authorization, so a plan-time fingerprint and a dispatch-time re-check can
 * never disagree about which runtime is actually going to execute.
 */
export interface EffectiveRuntimeIdentity {
  provider: string | null
  model: string | null
  modelResolved: string | null
  canonicalModelId: string | null
  source: 'settings-file' | 'annotation' | 'none'
}

const HOST_CONFIG_RUNTIMES = new Set(['gamut', 'superagent-host'])

export function resolveEffectiveRuntimeIdentity(input: {
  runtimeType: string | null
  annotatedProvider?: string | null
  annotatedModel?: string | null
}): EffectiveRuntimeIdentity {
  const runtime = (input.runtimeType || '').toLowerCase().trim()
  const annotationProvider = typeof input.annotatedProvider === 'string' && input.annotatedProvider.trim()
    ? input.annotatedProvider.trim()
    : null
  const annotationModel = typeof input.annotatedModel === 'string' && input.annotatedModel.trim()
    ? input.annotatedModel.trim()
    : null
  const hasExplicitAnnotation = Boolean(annotationProvider || annotationModel)

  // An explicit task-level annotation is a manual override and stays
  // authoritative. Otherwise, for host-config runtimes (Gamut/SuperAgent), the
  // CURRENT host settings decide what a new session would actually execute —
  // they win over any snapshot captured in agent-row config at roster-sync
  // time. When the host is not configured (no settings file / unreadable, e.g.
  // isolated test envs), we fall back to the annotation values so legacy
  // behavior is preserved.
  if (!hasExplicitAnnotation && HOST_CONFIG_RUNTIMES.has(runtime)) {
    const live = getGamutHostEffectiveRuntime()
    if (live.source === 'settings-file' && (live.provider || live.model)) {
      return {
        provider: live.provider,
        model: live.model,
        modelResolved: live.modelResolved,
        canonicalModelId: live.canonicalModelId,
        source: 'settings-file',
      }
    }
  }
  return {
    provider: annotationProvider,
    model: annotationModel,
    modelResolved: resolveGamutModelAlias(annotationModel) ?? annotationModel,
    canonicalModelId: annotationProvider === 'openrouter' && annotationModel
      ? (annotationModel.includes('/') ? annotationModel : `anthropic/${resolveGamutModelAlias(annotationModel) ?? annotationModel}`)
      : null,
    source: hasExplicitAnnotation ? 'annotation' : 'none',
  }
}

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
  /** True when the host marked the terminal assistant turn as a provider/API
   *  execution failure (e.g. OpenRouter 402 insufficient balance). Such a
   *  session ended without producing usable model output. */
  failed?: boolean
  /** Structured host error marker when one exists (observed `apiError` value). */
  errorCode?: string | null
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
export interface GamutSessionInspection {
  text: string | null
  /** True when the terminal assistant message is a provider/API execution
   *  failure rather than authored model output. */
  failed: boolean
  /** Structured host error marker when one exists (e.g. `apiError`). */
  errorCode: string | null
}

/**
 * Inspect a finished Gamut session's messages and classify its terminal
 * assistant result. Detection hierarchy (result-truthfulness contract):
 *
 *   1. Structured native signal — the host marks assistant turns that failed
 *      a provider/API call with a top-level `apiError` field (observed value
 *      "unknown", with `usage` zeroed for such turns). This is the primary,
 *      authoritative signal and never requires parsing display text.
 *   2. Narrow compatibility fallback — a terminal assistant message whose text
 *      starts with the host SDK's machine error envelope (`API Error: <code>`)
 *      is treated as a failure even if a future host version omits the
 *      `apiError` marker. The `^API Error:\s*\d{3}` anchor only matches the
 *      host's rendered error format, so model-authored prose that merely
 *      *discusses* an "API Error: 402" mid-response is never rejected.
 *
 * Anything else with terminal assistant text is a successful authored output;
 * a session with no terminal assistant text is reported as text-less (the
 * caller treats it as a generic execution failure, never as success).
 */
export function inspectGamutSessionResult(payload: unknown): GamutSessionInspection {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { messages?: unknown[] }).messages)
      ? (payload as { messages: unknown[] }).messages
      : []
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i] as Record<string, unknown>
    if (item?.type !== 'assistant') continue
    const rawContent = item.content
    let text: string | null = null
    if (typeof rawContent === 'string' && rawContent.trim()) {
      text = rawContent.trim()
    } else if (rawContent && typeof rawContent === 'object') {
      const contentText = (rawContent as Record<string, unknown>).text
      if (typeof contentText === 'string' && contentText.trim()) text = contentText.trim()
    }
    if (text === null) continue

    const apiError = item.apiError
    if (apiError !== undefined && apiError !== null) {
      return { text, failed: true, errorCode: String(apiError) }
    }
    if (/^API Error:\s*\d{3}\b/.test(text)) {
      return { text, failed: true, errorCode: null }
    }
    return { text, failed: false, errorCode: null }
  }
  return { text: null, failed: false, errorCode: null }
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
      const inspection = inspectGamutSessionResult(messages)
      if (inspection.failed) {
        return { sessionId, text: inspection.text, failed: true, errorCode: inspection.errorCode }
      }
      return { sessionId, text: inspection.text }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }

  throw new Error(`Gamut session ${sessionId} timed out after ${Math.round(timeoutMs / 1000)}s`)
}

/**
 * Terminate a running Gamut host session (executor-aware cancel).
 *
 * The host session store implements `DELETE /agents/{slug}/sessions/{id}`
 * (verified live: a bogus id returns the session-scoped `Session not found`
 * body, distinct from the generic `Not found` unknown-route error). A 2xx
 * confirms termination; a 404 means the session already ended on the host, so
 * there is nothing further to terminate (idempotent success). Any other
 * status is surfaced as a refusal so callers never report a cancelled run
 * that is still executing remotely.
 */
export async function terminateGamutSession(
  slug: string,
  sessionId: string,
  timeoutMs = 5000,
): Promise<{ terminated: boolean; alreadyEnded: boolean }> {
  const url = `${baseUrl()}/agents/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`
  const response = await fetchWithTimeout(url, { method: 'DELETE' }, timeoutMs)
  if (response.ok) return { terminated: true, alreadyEnded: false }
  if (response.status === 404) return { terminated: false, alreadyEnded: true }
  const detail = await response.text().catch(() => '')
  throw new Error(`Gamut host refused session termination (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
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
