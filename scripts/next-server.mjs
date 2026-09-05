#!/usr/bin/env node
/**
 * Cross-platform Next.js server launcher.
 *
 * The package.json scripts previously used `--port ${PORT:-3000}`, which POSIX
 * shells expand but pnpm's Windows shell passes through literally, making
 * `pnpm dev` / `pnpm start` fail on Windows. Port/hostname resolution happens
 * here instead so the scripts are portable.
 *
 * Usage: node scripts/next-server.mjs <dev|start> [extra next args...]
 *
 * Env:
 *   PORT      — port to listen on (default 3000)
 *   MC_HOST   — bind hostname (default: 127.0.0.1 for dev, 0.0.0.0 for start)
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)

const mode = process.argv[2] || 'dev'
if (mode !== 'dev' && mode !== 'start') {
  console.error(`next-server: unknown mode "${mode}" (expected dev|start)`)
  process.exit(1)
}

const extraArgs = process.argv.slice(3)
const port = Number(process.env.PORT) || 3000
const hostname = process.env.MC_HOST || (mode === 'start' ? '0.0.0.0' : '127.0.0.1')

const nextBin = path.join(path.dirname(require.resolve('next/package.json')), 'dist', 'bin', 'next')

const result = spawnSync(process.execPath, [nextBin, mode, '--hostname', hostname, '--port', String(port), ...extraArgs], {
  stdio: 'inherit',
  env: process.env,
})

if (result.error) {
  console.error('next-server: failed to launch next:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
