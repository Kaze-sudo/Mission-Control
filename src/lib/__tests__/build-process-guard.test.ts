import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * Tests for the Windows build guard (scripts/build-process-guard.cjs).
 *
 * The guard wraps next's compiled glob so wildcard globs anchored OUTSIDE the
 * repository are skipped before any filesystem traversal (next's output file
 * tracer emits machine-wide scans like `%LOCALAPPDATA%\**\*` on Windows because
 * runtime-discovery code reads homedir()/LOCALAPPDATA). Repo-anchored globs —
 * relative patterns and absolute in-repo paths — must pass through untouched.
 *
 * See docs/BUILD-WINDOWS.md for the full root-cause analysis.
 */

const require = createRequire(import.meta.url)
const {
  installBuildProcessGuard,
  isMachineScanPattern,
  isOutsideRepo,
  repoRoot,
} = require('../../../scripts/build-process-guard.cjs') as {
  installBuildProcessGuard: () => boolean
  isMachineScanPattern: (pattern: unknown) => boolean
  isOutsideRepo: (abs: string) => boolean
  repoRoot: () => string
}

// The guard exports the raw module; installing a second time is a no-op that
// must not throw when vitest or another test already loaded/preloaded it.
const processState = process as unknown as { __mcBuildGuardInstalled?: boolean }
const installIsIdempotent = (() => {
  const before = typeof processState.__mcBuildGuardInstalled
  installBuildProcessGuard()
  return before === 'boolean' || processState.__mcBuildGuardInstalled === true
})()

describe('build-process-guard: machine-scan pattern classification', () => {
  const repoRootDir = repoRoot()

  it('flags wildcard globs anchored outside the repository', () => {
    const home = os.homedir()
    const examples = [
      path.join(home, 'AppData', 'Local', '**', '*'),
      path.join(home, '.openclaw', '**', '*'),
      path.join(home, '.codex', 'skills', '**', '*'),
      path.join(os.tmpdir(), 'mc-codex-task-*-*-*.txt'),
    ]
    for (const pattern of examples) {
      expect(isMachineScanPattern(pattern), pattern).toBe(true)
    }
  })

  it('passes through relative repo-anchored wildcard globs', () => {
    expect(isMachineScanPattern('**/*.css')).toBe(false)
    expect(isMachineScanPattern('src/**/*.sql')).toBe(false)
    expect(isMachineScanPattern('.next/static/chunks/**/*.js')).toBe(false)
  })

  it('passes through absolute wildcard globs inside the repository', () => {
    expect(isMachineScanPattern(path.join(repoRootDir, '.next', 'static', '**', '*.css'))).toBe(
      false
    )
    expect(isMachineScanPattern(path.join(repoRootDir, 'openapi.json'))).toBe(false)
  })

  it('treats non-wildcard paths as machine scans only by location, not content', () => {
    // Literal (non-wildcard) paths are never skipped, even outside the repo:
    // nft reads concrete files it resolved; the machine scans are wildcards.
    expect(isMachineScanPattern('C:\\some\\other\\disk\\file.txt')).toBe(false)
    expect(isMachineScanPattern(path.join(os.tmpdir(), 'literal-file.txt'))).toBe(false)
    expect(isMachineScanPattern('')).toBe(false)
    expect(isMachineScanPattern(null)).toBe(false)
    expect(isMachineScanPattern(undefined)).toBe(false)
  })

  it('classifies directory containment independent of separators', () => {
    const inside = path.join(repoRootDir, 'src', 'lib')
    expect(isOutsideRepo(inside)).toBe(false)
    expect(isOutsideRepo(repoRootDir)).toBe(false)
    expect(isOutsideRepo(path.dirname(repoRootDir))).toBe(true)
  })
})

describe('build-process-guard: installation', () => {
  it('is idempotent and does not throw', () => {
    expect(() => installBuildProcessGuard()).not.toThrow()
    expect(installIsIdempotent).toBe(true)
  })

  it('wraps the compiled glob with guard metadata when next is installed', () => {
    let globModule: Record<string, unknown> | undefined
    try {
      const globPath = require.resolve('next/dist/compiled/glob', { paths: [process.cwd()] })
      globModule = require(globPath)
    } catch {
      // next not installed in this environment — nothing to assert
    }
    if (!globModule) return
    // The guard must either already be wrapped (preloaded) or wrap on install.
    if (globModule.__mcGuardWrapped === true) {
      expect(typeof globModule.glob).toBe('function')
      expect(typeof globModule.sync).toBe('function')
      expect(typeof globModule.hasMagic).toBe('function')
    } else {
      expect(installBuildProcessGuard()).toBe(true)
      const globPath = require.resolve('next/dist/compiled/glob', { paths: [process.cwd()] })
      expect(require(globPath).__mcGuardWrapped).toBe(true)
    }
  })
})
