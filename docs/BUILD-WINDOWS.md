# Windows build: tracer machine-scan crash & OOM (root cause & resolution)

## Symptom

`pnpm build` (`next build --webpack`) dies during "Creating an optimized
production build" with one of two failures, depending on how far it gets:

```
glob error [Error: EACCES: permission denied, scandir 'C:\Users\<me>\AppData\Local\Microsoft\WindowsApps\<Alias>.exe']
unhandledRejection [Error: EACCES ...]
ELIFECYCLE  Command failed with exit code 1.
```

or — once that crash is suppressed — a V8 heap OOM:

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
ELIFECYCLE  Command failed with exit code 134.
```

Different machines hit different EACCES paths: an orphaned 0-byte
`engine.sock` in `%LOCALAPPDATA%\docker-secrets-engine\`, 0-byte files in
`%LOCALAPPDATA%\Docker\run\`, or the permanent case —
`%LOCALAPPDATA%\Microsoft\WindowsApps\*.exe` app-execution aliases (present on
every Windows install).

## Root cause (verified against next@16.2.11)

1. **Component**: `@vercel/nft` — Next.js's output file tracer — invoked by
   `next-trace-entrypoints-plugin.js` during webpack `finishModules`.
2. **Mechanism**: nft statically evaluates fs/path expressions in traced
   server code. Our runtime-discovery modules (`agent-runtimes.ts`,
   `codex-sessions.ts`, `gamut-host.ts`, `platoon-commanders.ts`, ...)
   legitimately read under `os.homedir()`, `process.env.LOCALAPPDATA`,
   `process.env.APPDATA`, and `os.tmpdir()` at RUNTIME. Because those tails
   are dynamic, nft cannot enumerate them and emits **recursive wildcard
   globs over build-machine directories**, e.g.
   - `C:\Users\<me>\AppData\Local\**\*`
   - `C:\Users\<me>\.openclaw\**\*`
   - `C:\Users\<me>\AppData\Local\Temp\mc-codex-task-*-*-*.txt`
   and walks them on the build machine during `next build`.
3. **Crash**: when any traversed entry rejects `readdir` with EACCES/EPERM
   (WindowsApps aliases are reparse points; orphaned sockets behave the same),
   glob's strict mode emits the error on an unawaited promise →
   `unhandledRejection` kills the build.
4. **OOM**: even without a crash, traversing + caching the entire user
   profile drives the heap past 4GB and past 8GB. Verified empirically:
   - clean tree, real profile: tracer crash (exit 1) at both `490b81e` and
     `14bb1e7` — pre-existing, not a branch regression;
   - clean tree, crash suppressed: OOM at ~4100MB;
   - clean tree, crash suppressed + 8GB child heap: OOM at ~8188MB;
   - clean tree, machine-scan globs skipped: **build passes at the default
     heap** (no `--max-old-space-size` anywhere).

The crash and the OOM have the same root cause: nft's machine-wide glob
traversal. They are sequential failures, not alternatives.

## Why the fix lives at the glob layer

- `outputFileTracingRoot` is already pinned to the repo, and all
  `outputFileTracingIncludes/Excludes` patterns are repo-relative; the wild
  globs are emitted by the tracer itself because the app discovers runtimes
  under the user profile at runtime.
- Next 16.2.11 hardcodes `traceIgnores: []` (`webpack-config.js`) with no
  next.config surface, and nft's asset globbing (`emitAssetDirectory`)
  consults `ignoreFn` only for dependency traversal, not for the wildcard
  asset globs. Patching `traceIgnores` was tested and does not help.
- The scans can never produce traceable output: their results are
  build-machine files that do not exist on a deploy target. Skipping them
  cannot change the artifact.

## Resolution

`scripts/build-process-guard.cjs` is preloaded into the next build process by
`scripts/next-build.cjs` (`node scripts/next-build.cjs build --webpack`, a
drop-in replacement for `next build --webpack`).

The guard wraps `next/dist/compiled/glob` and **skips, before any filesystem
work, wildcard globs whose literal base is anchored outside the repository**
(absolute out-of-repo bases). Relative patterns and absolute in-repo patterns —
everything next itself uses — pass through untouched. No next internals are
patched; the wrapper degrades to stock behavior if the module moves.

Skips are logged as
`[build-guard] skipping glob anchored outside the repository: <pattern>`.
A run typically shows ~47 skips on Windows.

Additionally a **non-suppressing** listener logs (does not swallow) any
rejection of the historical class (EACCES/EPERM on scandir/readdir outside the
repo) should one still reach the process — the build then fails loudly with
context instead of silently producing a bad artifact.

**Heap is intentionally not configured anywhere**: `scripts/next-build.cjs`
does not set `--max-old-space-size`, and `package.json` does not either. The
guard removes the cause of the memory growth; a large fixed heap would only
mask regressions.

## Machine hygiene notes

- 0-byte leftovers from Docker Desktop crashes
  (`%LOCALAPPDATA%\docker-secrets-engine\engine.sock`,
  `%LOCALAPPDATA%\Docker\run\*.sock`) can be deleted; their removal alone was
  insufficient because of the WindowsApps aliases.
- A temporary `USERPROFILE` redirect is NOT required and NOT part of the fix.
  It was used in earlier sessions as an emergency switch; with the glob-skip
  guard it is unnecessary.
- CI note: Linux runners are unaffected in practice — the emitted scan bases
  are Windows profile paths — but the guard is platform-neutral and cheap.
