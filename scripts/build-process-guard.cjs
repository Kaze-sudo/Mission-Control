#!/usr/bin/env node
/**
 * Windows build guard for Next.js output file tracing (see docs/BUILD-WINDOWS.md).
 *
 * Verified root cause (next@16.2.11, next-trace-entrypoints-plugin -> @vercel/nft):
 * the output file tracer statically evaluates fs/path expressions in traced
 * server code. Our runtime-discovery modules (agent-runtimes, codex-sessions,
 * gamut-host, platoon-commanders, ...) legitimately read under `os.homedir()`,
 * `process.env.LOCALAPPDATA`, `process.env.APPDATA`, and `os.tmpdir()` at
 * RUNTIME. Because those tails are dynamic, nft cannot enumerate them and emits
 * recursive wildcard globs over BUILD-MACHINE directories, e.g.
 *   C:\Users\<me>\AppData\Local\**\*, C:\Users\<me>\.openclaw\**\*,
 *   C:\Users\<me>\AppData\Local\Temp\mc-codex-task-*-*-*.txt
 * and walks them during `next build`. Consequences on Windows:
 *   1. Any entry rejecting readdir with EACCES/EPERM (WindowsApps app-execution
 *      aliases, orphaned docker socket files, sealed profile dirs) surfaces as
 *      an unhandledRejection from glob's strict mode and kills the build.
 *   2. Even without a crash, traversing and caching the whole user profile
 *      drives V8 past an 8GB heap (OOM on 16GB machines).
 *
 * Fix (this file): the machine scans can never produce traceable output — their
 * results are build-machine files that do not exist on a deploy target — so this
 * preload wraps next's compiled `glob` and SKIPS wildcard globs whose pattern is
 * anchored outside the repository before any filesystem work starts. Next's own
 * glob calls are all repo-anchored (relative patterns or absolute in-repo paths),
 * so they are untouched. No next internals are patched.
 *
 * Logging only: a narrow `unhandledRejection` listener records rejections of the
 * exact class this guard exists for (EACCES/EPERM on scandir/readdir outside the
 * repository). It does NOT suppress them — if one still reaches the process, the
 * build fails loudly with context instead of silently producing a bad artifact.
 */
'use strict'

const path = require('node:path')

/**
 * Repository root: the repo being built. The build (and this preload) always
 * runs with cwd = repo root, which also keeps the guard correct when it is
 * preloaded into a build of a different checkout (worktrees, CI).
 */
function repoRoot() {
  return path.resolve(process.cwd())
}

/** True when `abs` lies outside the repository root. */
function isOutsideRepo(abs) {
  const root = repoRoot()
  const rel = path.relative(root, abs)
  // rel === '' -> abs IS the repo root (inside); '..' prefix or absolute rel -> outside
  return rel.startsWith('..') || path.isAbsolute(rel)
}

/**
 * True when `pattern` is a wildcard glob anchored outside the repository —
 * the fingerprint of nft's build-machine scans. Non-wildcard paths and every
 * repo-anchored pattern (relative or absolute-in-repo) return false.
 */
function isMachineScanPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false
  const wildcardIdx = pattern.search(/[*?]/)
  if (wildcardIdx === -1) return false
  // Literal base before the first wildcard. Absolute bases resolve to
  // themselves; relative bases resolve against cwd (repo root during build),
  // which is always in-repo.
  const base = path.resolve(pattern.slice(0, wildcardIdx) || '.')
  return isOutsideRepo(base)
}

function installBuildProcessGuard() {
  if (process.__mcBuildGuardInstalled) return false
  process.__mcBuildGuardInstalled = true

  let globModule
  try {
    // Resolve against the repo being built (cwd), not the guard's own tree, so
    // the wrapper patches the module instance this build actually loads.
    const globPath = require.resolve('next/dist/compiled/glob', { paths: [repoRoot()] })
    globModule = require(globPath)
  } catch {
    return false // next not installed / shape moved — degrade to stock behavior
  }
  if (!globModule || globModule.__mcGuardWrapped) return false

  const origGlob = globModule
  const origSync = globModule.sync

  function filterPatterns(pattern) {
    if (Array.isArray(pattern)) {
      const kept = pattern.filter((p) => !isMachineScanPattern(p))
      const skipped = pattern.length - kept.length
      if (skipped > 0) logSkip(`${skipped} pattern(s) of an array glob`, pattern[0])
      return { skipped: kept.length === 0, pattern: kept }
    }
    if (isMachineScanPattern(pattern)) {
      logSkip('glob', pattern)
      return { skipped: true, pattern }
    }
    return { skipped: false, pattern }
  }

  function logSkip(kind, pattern) {
    const base = typeof pattern === 'string' ? pattern : JSON.stringify(pattern)
    console.warn(
      `[build-guard] skipping ${kind} anchored outside the repository: ${String(base).slice(0, 160)}`
    )
  }

  function wrappedGlob(pattern, opts, cb) {
    const { skipped, pattern: filtered } = filterPatterns(pattern)
    if (skipped) {
      // Preserve glob's calling conventions: callback -> async empty result;
      // no callback -> promise of an empty list.
      if (typeof opts === 'function') {
        setImmediate(() => opts(null, []))
        return
      }
      if (typeof cb === 'function') {
        setImmediate(() => cb(null, []))
        return
      }
      return Promise.resolve([])
    }
    if (typeof opts === 'function') return origGlob.call(globModule, filtered, opts)
    return origGlob.call(globModule, filtered, opts, cb)
  }

  function wrappedSync(pattern, opts) {
    const { skipped, pattern: filtered } = filterPatterns(pattern)
    if (skipped) return []
    return origSync.call(globModule, filtered, opts)
  }

  const wrapper = wrappedGlob
  wrapper.glob = wrappedGlob
  wrapper.sync = wrappedSync
  wrapper.hasMagic = globModule.hasMagic
  wrapper.Glob = globModule.Glob
  wrapper.GlobSync = globModule.GlobSync
  wrapper.__mcGuardWrapped = true

  try {
    const globPath = require.resolve('next/dist/compiled/glob', { paths: [repoRoot()] })
    require.cache[globPath].exports = wrapper
  } catch {
    return false
  }

  // Last-resort logging net (non-suppressing). Covers the proven failure class
  // should any path reach it; everything else remains stock Next behavior.
  process.on('unhandledRejection', (reason) => {
    const err = reason && typeof reason === 'object' ? reason : {}
    const toleratedClass =
      (err.code === 'EACCES' || err.code === 'EPERM') &&
      (err.syscall === 'scandir' || err.syscall === 'readdir') &&
      typeof err.path === 'string' &&
      isOutsideRepo(path.resolve(err.path))
    if (toleratedClass) {
      console.error(
        `[build-guard] unscannable path outside repository reached rejection stage: ${err.path} (${err.code} on ${err.syscall})`
      )
    }
  })

  return true
}

module.exports = { installBuildProcessGuard, isMachineScanPattern, isOutsideRepo, repoRoot }

// Self-install when preloaded via `node --require` so the wrapper is in place
// before next (and its compiled glob) is ever loaded.
installBuildProcessGuard()
