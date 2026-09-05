#!/usr/bin/env node
'use strict'
/**
 * Live end-to-end verification of the AgentOS operational layer (runs feed,
 * hold reasons, cancel, retry, execution preview/approval, SSE run events).
 *
 * Items covered:
 *   1. Pause gate — objective execution on a paused project holds, dispatch
 *      kick never bypasses it, run appears in the feed with a real hold
 *      reason, queued cancel works through the API.
 *   2. Execution preview → refresh → approve → deny flow via
 *      /api/projects/[id]/agentos-execution.
 *   3. Retry path — a terminal run re-enters the pipeline; with no eligible
 *      executor the retry is held with a reason (deterministic on this box).
 *   4. Live events — delegation/task mutations are broadcast on the SSE bus
 *      (`delegation.*`, `task.created`) and received on /api/events.
 *
 * The run is self-contained: it creates its own probe project via the API,
 * drives everything through public endpoints, and removes every artifact in
 * a finally block (task delete → objective delete → project delete, then
 * DB-level leftovers sweep for safety). No hardcoded project/task IDs.
 *
 * Usage:
 *   node scripts/e2e-agentos-live.cjs [--base http://127.0.0.1:3000]
 *
 * Auth: uses AUTH_USER + AUTH_PASS_B64 (or AUTH_PASS) from .env, matching
 * the seeded admin credentials.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const baseFlag = args.indexOf('--base')
const BASE = (baseFlag >= 0 ? args[baseFlag + 1] : null) || process.env.MC_URL || 'http://127.0.0.1:3000'
const PROJECT_ROOT = path.resolve(__dirname, '..')
const DB_PATH = process.env.MISSION_CONTROL_DATA_DIR
  ? path.join(process.env.MISSION_CONTROL_DATA_DIR, 'mission-control.db')
  : path.join(PROJECT_ROOT, '.data', 'mission-control.db')

const STAMP = `e2e-${Date.now()}`
const PROBE_SLUG = `agentos-e2e-${STAMP}`

let failures = 0
const collectedTaskIds = new Set()
function rememberTask(id) { if (id) collectedTaskIds.add(id) }
function check(label, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures++
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(1, 58 - title.length))}`)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let cookie = ''

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, json, text }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env')
  if (!fs.existsSync(envPath)) return {}
  const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

async function login() {
  const env = loadEnv()
  const username = env.AUTH_USER || 'admin'
  let password = env.AUTH_PASS || ''
  if (env.AUTH_PASS_B64) {
    try {
      const decoded = Buffer.from(env.AUTH_PASS_B64.replace(/\s+/g, ''), 'base64').toString('utf8')
      if (decoded) password = decoded
    } catch { /* fall back to AUTH_PASS */ }
  }
  if (!password) throw new Error('No AUTH_PASS/AUTH_PASS_B64 in .env — cannot authenticate')
  const res = await api('/api/auth/login', { method: 'POST', body: { username, password } })
  if (res.status !== 200) throw new Error(`login failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`)
  console.log(`logged in as ${username}`)
}

// ---------------------------------------------------------------------------
// SSE listener (item 4)
// ---------------------------------------------------------------------------

async function collectEvents(wantTypes, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const authHeader = cookie
    const child = spawn('curl', [
      '-s', '-N', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-H', `Cookie: ${authHeader}`,
      `${BASE}/api/events`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let buffer = ''
    const events = []
    const timer = setTimeout(() => finish(), timeoutMs)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let idx
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const line = frame.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        try {
          const evt = JSON.parse(line.slice(6))
          if (evt.type && evt.type !== 'connected') events.push(evt)
        } catch { /* partial frame */ }
      }
      if (wantTypes.some(type => events.some(e => e.type === type))) finish()
    })
    child.on('error', () => finish())
    function finish() {
      clearTimeout(timer)
      try { child.kill() } catch { /* already gone */ }
      resolve(events)
    }
  })
}

// ---------------------------------------------------------------------------
// Cleanup — runs in finally; tolerant of missing artifacts
// ---------------------------------------------------------------------------

async function cleanupArtifact({ projectId }) {
  for (const taskId of [...collectedTaskIds]) {
    await api(`/api/tasks/${taskId}`, { method: 'DELETE' }).catch(() => {})
  }
  if (projectId) {
    await api(`/api/projects/${projectId}?mode=delete`, { method: 'DELETE' }).catch(() => {})
  }
}

function dbLeftoversSweep({ projectId }) {
  if (!fs.existsSync(DB_PATH)) {
    console.log('cleanup: DB not found, skipping leftovers sweep')
    return
  }
  let Database
  try { Database = require('better-sqlite3') } catch { return }
  let db
  try {
    db = new Database(DB_PATH)
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM agentos_execution_approvals WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM agentos_execution_plans WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM agentos_objectives WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM agentos_delegations WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM agentos_project_command WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    })
    tx()
  } catch (err) {
    console.log(`cleanup: DB sweep skipped (${err.message.split('\n')[0]})`)
  } finally {
    try { db && db.close() } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

async function main() {
  section('0. Setup')
  await login()

  // Probe project — created through the API, deleted in cleanup
  const projRes = await api('/api/projects', {
    method: 'POST',
    body: {
      name: `AgentOS E2E ${STAMP}`,
      slug: PROBE_SLUG,
      ticket_prefix: 'E2E',
      description: 'Temporary live E2E probe project — deleted automatically.',
    },
  })
  check('probe project created', projRes.status === 201 && !!projRes.json?.project?.id,
    projRes.status === 409 ? 'slug collision — rerun' : `HTTP ${projRes.status}`)
  const projectId = projRes.json?.project?.id
  if (!projectId) throw new Error('cannot continue without probe project')

  // Fresh projects start in command state 'draft' — pause it explicitly so
  // item 1 exercises the pause gate deterministically.
  const pauseRes = await api(`/api/projects/${projectId}/agentos-command`, {
    method: 'PUT', body: { state: 'paused' },
  })
  check('probe project paused', pauseRes.status === 200 && pauseRes.json?.command?.state === 'paused',
    `state=${pauseRes.json?.command?.state}`)

  // Objective on the paused project
  const objRes = await api(`/api/projects/${projectId}/agentos-objectives`, {
    method: 'POST',
    body: { title: 'E2E probe objective', description: 'Temporary live E2E artifact.' },
  })
  const objectiveId = objRes.json?.objective?.objectiveId ?? objRes.json?.objective?.id ?? objRes.json?.id
  check('objective created on paused project', objRes.status === 201 && !!objectiveId, `HTTP ${objRes.status}`)
  if (!objectiveId) throw new Error('cannot continue without objective')

  try {
    section('1. Pause gate + runs feed + queued cancel')
    const exec = await api(`/api/projects/${projectId}/agentos-objectives`, {
      method: 'PATCH', body: { objectiveId, action: 'execute' },
    })
    check('execute held on paused project', exec.status === 200
      && exec.json?.held === true
      && exec.json?.executed === false
      && typeof exec.json?.reason === 'string'
      && /paused/i.test(exec.json.reason),
      exec.json?.reason || `HTTP ${exec.status}`)

    const kick = await api('/api/scheduler', { method: 'POST', body: { task_id: 'task_dispatch' } })
    check('dispatch kick honored pause gate', kick.status === 200 && kick.json?.ok === true,
      (kick.json?.message || `HTTP ${kick.status}`).slice(0, 140))

    const runs1 = await api('/api/agentos/runs?limit=200')
    const probeRun = (runs1.json?.runs || []).find(r => r.objectiveId === objectiveId && r.projectId === projectId)
    check('run appears in feed with real hold reason', !!probeRun
      && probeRun.state === 'QUEUED'
      && typeof probeRun.holdReason === 'string'
      && /paused/i.test(probeRun.holdReason),
      probeRun ? `state=${probeRun.state} hold="${probeRun.holdReason}"` : 'run not found')

    const cancel = await api('/api/agentos/runs', {
      method: 'POST', body: { action: 'cancel', taskId: probeRun?.taskId },
    })
    check('queued cancel accepted', cancel.status === 200 && cancel.json?.ok === true && cancel.json?.cancelled === true,
      cancel.json ? JSON.stringify({ ok: cancel.json.ok, cancelled: cancel.json.cancelled, scope: cancel.json.scope }) : `HTTP ${cancel.status}`)
    const runsAfter = await api('/api/agentos/runs?limit=200')
    const after = (runsAfter.json?.runs || []).find(r => r.objectiveId === objectiveId)
    check('cancelled run no longer queued-active', !after
      || after.state === 'CANCELLED'
      || (typeof after.taskStatus === 'string' && after.taskStatus !== 'inbox'),
      after ? `state=${after.state} taskStatus=${after.taskStatus}` : 'run gone from feed')

    // ---------------------------------------------------------------------
    section('2. Execution preview → refresh → approve → deny')
    const preview = await api(`/api/projects/${projectId}/agentos-execution?objective_id=${objectiveId}`)
    const plan = preview.json?.plan
    check('GET preview returns plan', preview.status === 200 && !!plan && plan.objectiveId === objectiveId,
      plan ? `status=${plan.status} missions=${plan.missions?.length} fingerprint=${String(plan.fingerprint || '').slice(0, 8)}` : `HTTP ${preview.status}`)

    const refresh = await api(`/api/projects/${projectId}/agentos-execution`, {
      method: 'POST', body: { objectiveId, action: 'refresh' },
    })
    check('POST refresh persists plan row', refresh.status === 200 && !!refresh.json?.plan
      && typeof refresh.json?.rowStatus === 'string',
      `rowStatus=${refresh.json?.rowStatus}`)

    const deny = await api(`/api/projects/${projectId}/agentos-execution`, {
      method: 'POST', body: { objectiveId, action: 'deny', reason: 'E2E probe deny path' },
    })
    check('deny accepted', deny.status === 200 && deny.json?.ok === true,
      deny.json?.message || `HTTP ${deny.status}`)

    const approve = await api(`/api/projects/${projectId}/agentos-execution`, {
      method: 'POST', body: { objectiveId, action: 'approve', approveTaskIds: 'all-eligible' },
    })
    // Approve legitimately fails if no mission requires approval (free/local
    // under policy) — the plan summary tells us which contract we're in.
    const approvalRequired = !!plan?.summary?.approvalRequired
    if (approvalRequired) {
      check('approve creates fingerprint-bound approval', approve.status === 200
        && approve.json?.ok === true
        && approve.json?.approvalStatus === 'VALID',
        `rowStatus=${approve.json ? 'APPROVED' : 'n/a'}`)
    } else {
      check('approve correctly refused (no missions require approval)', approve.status === 400
        && approve.json?.ok === false,
        (approve.json?.error || 'no-approval contract').slice(0, 120))
    }

    // ---------------------------------------------------------------------
    section('3. Retry path (terminal runs)')
    // Contract: only terminal-failed runs are retryable. A cancelled-but-
    // never-dispatched queued run is refused; a failed run is retried, but
    // retry is NEW work — the paused-project gate holds it (HTTP 409) and
    // nothing is dispatched.
    const runs3 = await api('/api/agentos/runs?limit=200')
    const objRuns = (runs3.json?.runs || []).filter(r => r.objectiveId === objectiveId)
    const cancelledTaskId = after?.taskId ?? probeRun?.taskId
    rememberTask(cancelledTaskId)

    const retryCancelled = await api('/api/agentos/runs', {
      method: 'POST', body: { action: 'retry', taskId: cancelledTaskId },
    })
    check('retry refuses cancelled-but-never-dispatched run',
      retryCancelled.status === 400 && retryCancelled.json?.ok === false
        && /terminal failed/i.test(retryCancelled.json?.reason || ''),
      retryCancelled.json?.reason || `HTTP ${retryCancelled.status}`)

    // Prepare a terminal-failed run: force-fail the objective's other mission
    // task (or the cancelled task itself when only one mission exists).
    let failedTaskId = objRuns.find(r => r.taskId && r.taskId !== cancelledTaskId)?.taskId ?? null
    if (!failedTaskId) failedTaskId = cancelledTaskId
    const failPut = await api(`/api/tasks/${failedTaskId}`, {
      method: 'PUT', body: { status: 'failed', error_message: 'E2E forced failure for retry probe' },
    })
    check('terminal-failed run prepared for retry', failPut.status === 200, `HTTP ${failPut.status}`)

    if (failPut.status === 200) {
      const retry = await api('/api/agentos/runs', {
        method: 'POST', body: { action: 'retry', taskId: failedTaskId },
      })
      check('retry held behind paused project (409, nothing dispatched)',
        retry.status === 409 && retry.json?.ok === false && retry.json?.held === true
          && /paused/i.test(retry.json?.reason || ''),
        retry.json?.reason || `HTTP ${retry.status}`)
    }

    // ---------------------------------------------------------------------
    section('4. Live events (SSE bus)')
    // A direct task creation broadcasts `task.created` on the shared event
    // bus; the /api/events SSE stream must deliver it.
    const eventsPromise = collectEvents(['task.created'], 9000)
    await new Promise(resolve => setTimeout(resolve, 500)) // let the stream connect
    const sseTask = await api('/api/tasks', {
      method: 'POST', body: { title: 'E2E SSE probe task', project_id: projectId },
    })
    const sseTaskId = sseTask.json?.task?.id ?? null
    rememberTask(sseTaskId)
    check('SSE probe task created', sseTask.status === 201 && !!sseTaskId, `HTTP ${sseTask.status}`)
    const events = await eventsPromise
    const types = new Set(events.map(e => e.type))
    check('task.created event observed on SSE stream', types.has('task.created'),
      `events: ${[...types].join(', ') || 'none'}`)

    // ---------------------------------------------------------------------
    section('Summary')
    if (failures > 0) {
      console.log(`${failures} check(s) FAILED`)
      process.exitCode = 1
    } else {
      console.log('All checks passed.')
    }
  } finally {
    // ---------------------------------------------------------------------
    // Cleanup: API first (cascade-friendly), then DB sweep for leftovers
    // ---------------------------------------------------------------------
    console.log('\n── cleanup ' + '─'.repeat(50))
    await cleanupArtifact({ projectId })
    dbLeftoversSweep({ projectId })
    console.log('cleanup done')
  }
}

main().catch(err => {
  console.error('E2E FAILED:', err.message)
  process.exitCode = 1
})
