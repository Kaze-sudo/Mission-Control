import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regex helpers below are built from path.resolve/path.join so the suite
// verifies the path-derivation CONTRACT on every platform instead of assuming
// POSIX separators. On POSIX the generated patterns are identical to the
// original literal ones.
const sepForRe = path.sep === '\\' ? '\\\\' : '/'
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Match `<as-joined root>/worker-<id>` exactly the way src/lib/config.ts builds
 * it: `mkdtempSync(path.join(buildScratchRoot, 'worker-'))` — the configured
 * root is used VERBATIM (env passthrough), so on Windows a root-relative value
 * like `/tmp/build-scratch` yields `\tmp\build-scratch\worker-*` (no drive).
 * Building the prefix with path.join keeps expectations platform-correct and
 * identical to the original literal regexes on POSIX.
 */
function workerDirRe(root: string): RegExp {
  const prefix = path.join(root, 'worker-')
  return new RegExp(`^${escapeRe(prefix)}[^${sepForRe}]+$`)
}

/** Match `<as-joined root>/worker-<id>/<fileName>`. */
function workerFileRe(root: string, fileName: string): RegExp {
  const prefix = path.join(root, 'worker-')
  return new RegExp(
    `^${escapeRe(prefix)}[^${sepForRe}]+${sepForRe}${escapeRe(fileName)}$`,
  )
}

async function loadConfigWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules()

  const original = {
    MISSION_CONTROL_DATA_DIR: process.env.MISSION_CONTROL_DATA_DIR,
    MISSION_CONTROL_BUILD_DATA_DIR: process.env.MISSION_CONTROL_BUILD_DATA_DIR,
    MISSION_CONTROL_BUILD_DB_PATH: process.env.MISSION_CONTROL_BUILD_DB_PATH,
    MISSION_CONTROL_BUILD_TOKENS_PATH: process.env.MISSION_CONTROL_BUILD_TOKENS_PATH,
    MISSION_CONTROL_DB_PATH: process.env.MISSION_CONTROL_DB_PATH,
    MISSION_CONTROL_TOKENS_PATH: process.env.MISSION_CONTROL_TOKENS_PATH,
    NEXT_PHASE: process.env.NEXT_PHASE,
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  const mod = await import('./config')

  if (original.MISSION_CONTROL_DATA_DIR === undefined) delete process.env.MISSION_CONTROL_DATA_DIR
  else process.env.MISSION_CONTROL_DATA_DIR = original.MISSION_CONTROL_DATA_DIR

  if (original.MISSION_CONTROL_BUILD_DATA_DIR === undefined) delete process.env.MISSION_CONTROL_BUILD_DATA_DIR
  else process.env.MISSION_CONTROL_BUILD_DATA_DIR = original.MISSION_CONTROL_BUILD_DATA_DIR

  if (original.MISSION_CONTROL_BUILD_DB_PATH === undefined) delete process.env.MISSION_CONTROL_BUILD_DB_PATH
  else process.env.MISSION_CONTROL_BUILD_DB_PATH = original.MISSION_CONTROL_BUILD_DB_PATH

  if (original.MISSION_CONTROL_BUILD_TOKENS_PATH === undefined) delete process.env.MISSION_CONTROL_BUILD_TOKENS_PATH
  else process.env.MISSION_CONTROL_BUILD_TOKENS_PATH = original.MISSION_CONTROL_BUILD_TOKENS_PATH

  if (original.MISSION_CONTROL_DB_PATH === undefined) delete process.env.MISSION_CONTROL_DB_PATH
  else process.env.MISSION_CONTROL_DB_PATH = original.MISSION_CONTROL_DB_PATH

  if (original.MISSION_CONTROL_TOKENS_PATH === undefined) delete process.env.MISSION_CONTROL_TOKENS_PATH
  else process.env.MISSION_CONTROL_TOKENS_PATH = original.MISSION_CONTROL_TOKENS_PATH

  if (original.NEXT_PHASE === undefined) delete process.env.NEXT_PHASE
  else process.env.NEXT_PHASE = original.NEXT_PHASE

  return mod.config
}

describe('config data paths', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('derives db and token paths from MISSION_CONTROL_DATA_DIR', async () => {
    const config = await loadConfigWithEnv({
      MISSION_CONTROL_DATA_DIR: '/tmp/mission-control-data',
      MISSION_CONTROL_DB_PATH: undefined,
      MISSION_CONTROL_TOKENS_PATH: undefined,
    })

    // MISSION_CONTROL_DATA_DIR passes through verbatim (env passthrough, same
    // string on every platform); derived file paths come from path.join, so
    // expectations are built with path.join for separator portability.
    const dataDir = '/tmp/mission-control-data'
    expect(config.dataDir).toBe(dataDir)
    expect(config.dbPath).toBe(path.join(dataDir, 'mission-control.db'))
    expect(config.tokensPath).toBe(path.join(dataDir, 'mission-control-tokens.json'))
  })

  it('respects explicit db and token path overrides', async () => {
    const config = await loadConfigWithEnv({
      MISSION_CONTROL_DATA_DIR: '/tmp/mission-control-data',
      MISSION_CONTROL_DB_PATH: '/tmp/custom.db',
      MISSION_CONTROL_TOKENS_PATH: '/tmp/custom-tokens.json',
    })

    // Explicit override values are used verbatim (no re-resolution), so plain
    // string identity is the platform-agnostic assertion.
    expect(config.dataDir).toBe('/tmp/mission-control-data')
    expect(config.dbPath).toBe('/tmp/custom.db')
    expect(config.tokensPath).toBe('/tmp/custom-tokens.json')
  })

  it('uses a build-scoped worker data dir during next build', async () => {
    const config = await loadConfigWithEnv({
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_DATA_DIR: '/tmp/runtime-data',
      MISSION_CONTROL_BUILD_DATA_DIR: '/tmp/build-scratch',
      MISSION_CONTROL_DB_PATH: undefined,
      MISSION_CONTROL_TOKENS_PATH: undefined,
    })

    expect(config.dataDir).toMatch(workerDirRe('/tmp/build-scratch'))
    expect(config.dbPath).toMatch(workerFileRe('/tmp/build-scratch', 'mission-control.db'))
    expect(config.tokensPath).toMatch(
      workerFileRe('/tmp/build-scratch', 'mission-control-tokens.json'),
    )
  })

  it('allocates a distinct private scratch directory for each build worker', async () => {
    const env = {
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_BUILD_DATA_DIR: '/tmp/build-scratch',
      MISSION_CONTROL_BUILD_DB_PATH: undefined,
      MISSION_CONTROL_BUILD_TOKENS_PATH: undefined,
    }

    const first = await loadConfigWithEnv(env)
    const second = await loadConfigWithEnv(env)

    expect(first.dataDir).not.toBe(second.dataDir)
  })

  it('prefers build-specific db and token overrides during next build', async () => {
    const config = await loadConfigWithEnv({
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_DATA_DIR: '/tmp/runtime-data',
      MISSION_CONTROL_DB_PATH: '/tmp/runtime.db',
      MISSION_CONTROL_TOKENS_PATH: '/tmp/runtime-tokens.json',
      MISSION_CONTROL_BUILD_DB_PATH: '/tmp/build.db',
      MISSION_CONTROL_BUILD_TOKENS_PATH: '/tmp/build-tokens.json',
    })

    const expectedBuildRoot = path.join(os.tmpdir(), 'mission-control-build')
    expect(config.dataDir).toMatch(workerDirRe(expectedBuildRoot))
    expect(config.dbPath).toBe('/tmp/build.db')
    expect(config.tokensPath).toBe('/tmp/build-tokens.json')
  })
})
