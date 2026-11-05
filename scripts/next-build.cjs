#!/usr/bin/env node
/**
 * Drop-in replacement for `next build` that preloads the Windows build guard
 * into the next process (see scripts/build-process-guard.cjs and
 * docs/BUILD-WINDOWS.md).
 *
 * `node scripts/next-build.cjs build --webpack` === `next build --webpack`,
 * with the guard installed before any build code runs.
 *
 * Heap is intentionally NOT configured here: the tracer guard removes the
 * machine-wide directory scans that caused the OOM, so default V8 heap sizing
 * is correct. Forcing a large fixed heap would mask regressions.
 */
'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const nextBin = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
const guard = path.join(__dirname, 'build-process-guard.cjs')

// `next-build.cjs build --webpack ...` forwards verbatim; bare flags (e.g.
// `next-build.cjs --webpack`) get the `build` command prepended.
const argv = process.argv.slice(2)
const nextArgs = argv[0] && !argv[0].startsWith('-') ? argv : ['build', ...argv]

const result = spawnSync(process.execPath, ['--require', guard, nextBin, ...nextArgs], {
  stdio: 'inherit',
  cwd: repoRoot,
  env: process.env,
})

if (result.error) {
  console.error('next-build: failed to launch next:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
