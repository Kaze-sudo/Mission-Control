import fs from 'node:fs'
import path from 'node:path'
import { config, ensureDirExists } from './config'

/**
 * AgentOS model pricing metadata (Phase 2/3) — the cost-bounded execution
 * authorization layer needs reliable per-model rates so PAID_ESTIMATED work can
 * become a dollar-bounded plan without inventing numbers.
 *
 * Sources, in preference order:
 *  1. a live lookup of OpenRouter's public model metadata (no auth required,
 *     read-only, no billing);
 *  2. a local cache file under the data dir (TTL-bounded);
 *  3. an embedded fallback table derived from the *installed* Gamut host
 *     catalog (`pricingFor(...)` inside the app bundle) — trusted local
 *     metadata, clearly labeled, never treated as live.
 *
 * Guarantees:
 *  - secrets are never read, stored, or logged (we fetch a public endpoint and
 *    persist only rate/context fields);
 *  - lookup failure is never fatal: callers fall back to PAID_ESTIMATED /
 *    UNKNOWN_ESTIMATE rather than pretending a model is free;
 *  - no large downloads — only the compact models list endpoint.
 */

export interface ModelPricing {
  provider: string
  model: string
  /** Canonical provider-qualified id (e.g. anthropic/claude-sonnet-5). */
  canonicalModelId: string
  currency: string
  /** USD per 1M input tokens. */
  inputPerMillion: number
  /** USD per 1M output tokens. */
  outputPerMillion: number
  /** USD per 1M cached-input tokens (read). */
  cachedInputPerMillion: number | null
  /** USD per 1M cached-input tokens (write). */
  cachedInputWritePerMillion: number | null
  /** Extra per-call charges (e.g. web search). */
  otherCharges: Record<string, number>
  contextLength: number | null
  pricingSource: 'openrouter-live' | 'local-cache' | 'gamut-catalog-fallback'
  retrievedAt: number
  expiresAt: number
}

/** Default cache TTL — 7 days. Rates are stable enough that daily refresh is pointless. */
const DEFAULT_PRICING_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

/**
 * Embedded fallback table derived from the installed Gamut host bundle
 * (`pricingFor("claude-sonnet-5")` in the app catalog) and cross-validated
 * against OpenRouter's live model metadata on 2026-09-02. Used ONLY when the
 * live lookup + cache are both unavailable — never treated as live truth.
 */
const GAMUT_CATALOG_FALLBACK: Record<string, ModelPricing> = {
  'anthropic/claude-sonnet-5': {
    provider: 'openrouter',
    model: 'claude-sonnet-5',
    canonicalModelId: 'anthropic/claude-sonnet-5',
    currency: 'USD',
    inputPerMillion: 2,
    outputPerMillion: 10,
    cachedInputPerMillion: 0.2,
    cachedInputWritePerMillion: 2.5,
    otherCharges: {},
    contextLength: 1_000_000,
    pricingSource: 'gamut-catalog-fallback',
    retrievedAt: 0,
    expiresAt: 0,
  },
}

export interface PricingLookupOptions {
  /** Override the cache file location (tests). */
  cacheFile?: string
  now?: number
  ttlMs?: number
  /** Inject a fetch (tests / hermetic environments). */
  fetchFn?: typeof fetch
}

interface CacheEntry {
  canonicalModelId: string
  pricing: ModelPricing
}

interface PricingCacheFile {
  updatedAt: number
  entries: CacheEntry[]
}

let memoryCache: Record<string, ModelPricing> = {}

function nowMs(): number {
  return Date.now()
}

function cachePath(): string {
  return path.join(config.dataDir, 'model-pricing-cache.json')
}

/** Normalize a model id to its canonical OpenRouter form. */
export function canonicalOpenRouterModelId(model: string | null | undefined): string | null {
  if (!model || typeof model !== 'string') return null
  const trimmed = model.trim()
  if (!trimmed) return null
  if (trimmed.includes('/')) return trimmed
  if (trimmed.startsWith('claude-')) return `anthropic/${trimmed}`
  return trimmed
}

/** Whether a pricing entry applies to the requested model id. */
function matches(entry: ModelPricing, provider: string | null | undefined, model: string | null): boolean {
  if (!model) return false
  const requested = model.trim().toLowerCase()
  const canonical = canonicalOpenRouterModelId(model)?.toLowerCase()
  const entryIds = [
    entry.canonicalModelId?.toLowerCase(),
    entry.model?.toLowerCase(),
    canonicalOpenRouterModelId(entry.model)?.toLowerCase(),
  ].filter(Boolean)
  if (!entryIds.includes(requested) && !(canonical && entryIds.includes(canonical))) return false
  if (!provider || provider.toLowerCase() === 'openrouter') return true
  return entry.provider?.toLowerCase() === provider.toLowerCase()
}

function readCacheFile(file: string): PricingCacheFile | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as PricingCacheFile
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

function writeCacheFile(file: string, cache: PricingCacheFile): void {
  try {
    ensureDirExists(path.dirname(file))
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    // Cache persistence must never break planning.
  }
}

function freshFromCache(cache: PricingCacheFile, provider: string | null | undefined, model: string, ttlMs: number, now: number): ModelPricing | null {
  for (const entry of cache.entries) {
    if (entry.pricing.expiresAt && now > entry.pricing.expiresAt) continue
    if (matches(entry.pricing, provider, model)) {
      return { ...entry.pricing, pricingSource: 'local-cache' }
    }
  }
  return null
}

/**
 * Sync pricing lookup — NEVER fetches the network. Order: memory → cache file →
 * embedded fallback. Returns null when no reliable metadata exists (caller must
 * not pretend the model is free).
 */
export function getModelPricing(
  provider: string | null | undefined,
  model: string | null | undefined,
  options: PricingLookupOptions = {},
): ModelPricing | null {
  if (!model) return null
  const file = options.cacheFile || cachePath()
  const now = options.now ?? nowMs()
  const ttlMs = options.ttlMs ?? DEFAULT_PRICING_CACHE_TTL_MS
  const requested = model.trim()

  const memKey = canonicalOpenRouterModelId(requested) || requested.toLowerCase()
  const mem = memoryCache[memKey]
  if (mem && mem.expiresAt && now <= mem.expiresAt && matches(mem, provider, requested)) {
    return { ...mem, pricingSource: 'local-cache' }
  }

  const fileCache = readCacheFile(file)
  if (fileCache) {
    const fromFile = freshFromCache(fileCache, provider, requested, ttlMs, now)
    if (fromFile) {
      memoryCache[fromFile.canonicalModelId] = fromFile
      return fromFile
    }
  }

  for (const entry of Object.values(GAMUT_CATALOG_FALLBACK)) {
    if (matches(entry, provider, requested)) {
      return { ...entry, retrievedAt: now, expiresAt: now + ttlMs }
    }
  }
  return null
}

interface OpenRouterModelDto {
  id: string
  context_length?: number | null
  pricing?: {
    prompt?: string | number
    completion?: string | number
    input_cache_read?: string | number
    input_cache_write?: string | number
    web_search?: string | number
  } | null
}

/** Parse OpenRouter's /models payload into ModelPricing entries (per-token → per-1M). */
export function parseOpenRouterModelsPayload(payload: unknown): ModelPricing[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown[] }).data
  if (!Array.isArray(data)) return []
  const now = nowMs()
  const entries: ModelPricing[] = []
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue
    const dto = raw as OpenRouterModelDto
    if (!dto.id || typeof dto.id !== 'string') continue
    const pricing = dto.pricing || {}
    const toNum = (v: string | number | undefined): number | null => {
      if (v === undefined || v === null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? n : null
    }
    const input = toNum(pricing.prompt)
    const output = toNum(pricing.completion)
    if (input === null && output === null) continue
    const canonical = canonicalOpenRouterModelId(dto.id) || dto.id
    entries.push({
      provider: 'openrouter',
      model: dto.id,
      canonicalModelId: canonical,
      currency: 'USD',
      inputPerMillion: (input ?? 0) * 1_000_000,
      outputPerMillion: (output ?? 0) * 1_000_000,
      cachedInputPerMillion: toNum(pricing.input_cache_read) !== null ? (toNum(pricing.input_cache_read)! * 1_000_000) : null,
      cachedInputWritePerMillion: toNum(pricing.input_cache_write) !== null ? (toNum(pricing.input_cache_write)! * 1_000_000) : null,
      otherCharges: toNum(pricing.web_search) !== null ? { web_search: toNum(pricing.web_search)! } : {},
      contextLength: dto.context_length ?? null,
      pricingSource: 'openrouter-live',
      retrievedAt: now,
      expiresAt: now + DEFAULT_PRICING_CACHE_TTL_MS,
    })
  }
  return entries
}

export interface RefreshPricingResult {
  refreshed: boolean
  matched: number
  source: 'openrouter-live' | 'unavailable'
  error?: string
}

/**
 * Async pricing refresh — fetches OpenRouter's public model metadata and writes
 * the cache. Called from the scheduler on a slow cadence; planning itself stays
 * sync. Never throws: any failure leaves the previous cache intact.
 */
export async function refreshOpenRouterPricing(
  options: PricingLookupOptions = {},
): Promise<RefreshPricingResult> {
  const file = options.cacheFile || cachePath()
  const fetchFn = options.fetchFn || globalThis.fetch
  try {
    const response = await fetchFn(OPENROUTER_MODELS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return { refreshed: false, matched: 0, source: 'unavailable', error: `OpenRouter returned HTTP ${response.status}` }
    }
    const payload: unknown = await response.json()
    const entries = parseOpenRouterModelsPayload(payload)
    if (entries.length === 0) {
      return { refreshed: false, matched: 0, source: 'unavailable', error: 'No models parsed from OpenRouter payload' }
    }
    const existing = readCacheFile(file)
    const merged = new Map<string, CacheEntry>()
    for (const entry of existing?.entries || []) {
      merged.set(entry.canonicalModelId, entry)
    }
    for (const pricing of entries) {
      merged.set(pricing.canonicalModelId, {
        canonicalModelId: pricing.canonicalModelId,
        pricing: { ...pricing },
      })
      memoryCache[pricing.canonicalModelId] = pricing
    }
    writeCacheFile(file, { updatedAt: nowMs(), entries: [...merged.values()] })
    return { refreshed: true, matched: entries.length, source: 'openrouter-live' }
  } catch (error) {
    return {
      refreshed: false,
      matched: 0,
      source: 'unavailable',
      error: error instanceof Error ? error.message : 'Pricing refresh failed',
    }
  }
}

/** Test/ops helper: clear the in-memory pricing cache. */
export function clearPricingMemoryCache(): void {
  memoryCache = {}
}