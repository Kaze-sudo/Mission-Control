#!/usr/bin/env node
'use strict'
/**
 * Real Gamut dispatch probe against a live Mission Control server (temp DB).
 *
 * Usage:
 *   node scripts/gamut-dispatch-probe.cjs --list                 # show discovered Gamut agents
 *   node scripts/gamut-dispatch-probe.cjs --target <rosterId>    # full dispatch validation
 *
 * Env: MC_BASE (default http://127.0.0.1:3000). Auth mirrors the live E2E
 * harness: parse .env (BOM-tolerant), AUTH_PASS_B64 wins over AUTH_PASS.
 */
const fs = require('node:fs')
const path = require('node:path')
const { attemptWithRetry } = require('./lib/e2e-fetch-retry.cjs')

const BASE = process.env.MC_BASE || 'http://127.0.0.1:3000'
const ROOT = path.resolve(__dirname, '..')
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)

function loadAuth() {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').replace(/^\uFEFF/, '')
  const env = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim()
  }
  let password = env.AUTH_PASS || ''
  if (env.AUTH_PASS_B64) {
    const decoded = Buffer.from(env.AUTH_PASS_B64.replace(/\s+/g, ''), 'base64').toString('utf8')
    if (decoded) password = decoded
  }
  return { username: env.AUTH_USER || 'admin', password }
}

let cookie = ''
async function rawFetch(p, opts = {}) {
  const res = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, json, text }
}

// Transport-only bounded retry (mirrors scripts/e2e-agentos-live.cjs): failures
// before the request reaches the server leave no server-side effect.
async function api(p, opts = {}) {
  const out = await attemptWithRetry(() => rawFetch(p, opts))
  if (!out.ok) throw out.error
  return out.value
}

function gamutEntries(rosterJson) {
  const discovered = rosterJson?.discovered || []
  return discovered.filter((a) => /gamut/i.test(String(a.id)) || /gamut/i.test(String(a.platoon || '')))
}

async function main() {
  const auth = loadAuth()
  const login = await api('/api/auth/login', { method: 'POST', body: auth })
  if (login.status !== 200) throw new Error(`login failed HTTP ${login.status}: ${login.text.slice(0, 160)}`)
  console.log(`logged in as ${auth.username}`)

  const listMode = process.argv.includes('--list')
  const targetArg = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : null

  const roster = await api('/api/agentos/roster')
  const gamut = gamutEntries(roster.json)
  console.log(`\n=== discovered Gamut agents (${gamut.length}) ===`)
  for (const a of gamut) {
    console.log(`- ${a.id} | ${a.name} | availability=${a.availability} | model=${a.model || '?'} provider=${a.provider || '?'}`)
    if (a.description) console.log(`    desc: ${String(a.description).slice(0, 110)}`)
  }
  if (listMode) return

  const target = targetArg || gamut.find((a) => a.availability === 'available')?.id
  if (!target) throw new Error('no available Gamut agent to target (run with --list)')
  console.log(`\ntarget: ${target}`)

  // Probe project
  const proj = await api('/api/projects', {
    method: 'POST',
    body: {
      name: `Gamut validation ${STAMP}`,
      slug: `gamut-val-${STAMP}`,
      ticket_prefix: `GV${STAMP.slice(-4)}`,
      description: 'Temporary Gamut real-dispatch validation probe — deleted automatically.',
    },
  })
  const projectId = proj.json?.project?.id
  if (!projectId) throw new Error(`project create failed HTTP ${proj.status}: ${proj.text.slice(0, 200)}`)
  console.log(`project=${projectId}`)

  try {
    // Register routing proxies for discovered external agents
    await api('/api/agentos/roster', { method: 'POST', body: { action: 'reconcile', projectId } }).catch(() => {})
    const roster2 = await api('/api/agentos/roster')
    const proxyRow = (roster2.json?.agents || []).find((a) => a.externalAgentId === target)
    console.log(`proxy: ${proxyRow ? `routing=${proxyRow.routingAgentName} registered=${proxyRow.registered !== false}` : 'MISSING'}`)

    // Bind the real Gamut agent to the probe project
    const bind = await api(`/api/projects/${projectId}/external-agents`, {
      method: 'POST', body: { externalAgentId: target, role: 'Gamut validation executor' },
    })
    console.log(`bind: HTTP ${bind.status}${bind.json?.error ? ` (${String(bind.json.error).slice(0, 120)})` : ''}`)
    if (!(bind.status === 200 || bind.status === 201)) throw new Error('bind failed')

    // Resume project (fresh projects start in draft)
    await api(`/api/projects/${projectId}/agentos-command`, { method: 'PUT', body: { state: 'active' } })

    // Objective: deterministic harmless goal
    const obj = await api(`/api/projects/${projectId}/agentos-objectives`, {
      method: 'POST',
      body: {
        title: 'Gamut dispatch validation objective',
        description: 'Report back the exact fixed phrase: REAL GAMUT DISPATCH OK. Do nothing else.',
      },
    })
    const objectiveId = obj.json?.objective?.objectiveId ?? obj.json?.objective?.id ?? obj.json?.id
    if (!objectiveId) throw new Error(`objective create failed HTTP ${obj.status}: ${obj.text.slice(0, 200)}`)
    console.log(`objective=${objectiveId}`)

    // Execute: assembles force, activates project, plans
    const exec = await api(`/api/projects/${projectId}/agentos-objectives`, {
      method: 'PATCH', body: { objectiveId, action: 'execute' },
    })
    console.log(`execute: HTTP ${exec.status} executed=${exec.json?.executed} reason=${String(exec.json?.reason || '').slice(0, 120)}`)
    console.log(`  routes=${JSON.stringify((exec.json?.routes || []).slice(0, 4).map(r => r.agentName || r.agent || r))}`)

    // Refresh plan + fingerprint-bound approval
    const refresh = await api(`/api/projects/${projectId}/agentos-execution`, {
      method: 'POST', body: { objectiveId, action: 'refresh' },
    })
    console.log(`refresh: HTTP ${refresh.status} rowStatus=${refresh.json?.rowStatus} approvalRequired=${refresh.json?.plan?.summary?.approvalRequired}`)
    if (refresh.json?.plan?.summary?.approvalRequired) {
      const approve = await api(`/api/projects/${projectId}/agentos-execution`, {
        method: 'POST', body: { objectiveId, action: 'approve', approveTaskIds: 'all-eligible' },
      })
      console.log(`approve: HTTP ${approve.status} ok=${approve.json?.ok} status=${approve.json?.approvalStatus}`)
    }

    // Dispatch kick
    await api('/api/scheduler', { method: 'POST', body: { task_id: 'task_dispatch' } })
    console.log('dispatch kick sent')

    // Poll the runs feed for the objective's run
    const deadline = Date.now() + 5 * 60 * 1000
    let run = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 6000))
      const runs = await api(`/api/agentos/runs?project_id=${projectId}&limit=50`)
      run = (runs.json?.runs || []).find((r) => r.objectiveId === objectiveId) || run
      const state = run?.state
      console.log(`  poll: state=${state || '(none)'} hold=${String(run?.holdReason || '').slice(0, 60) || '-'} result="${String(run?.resultSummary || '').slice(0, 60) || '-'}"`)
      if (run && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(state)) break
      await api('/api/scheduler', { method: 'POST', body: { task_id: 'task_dispatch' } }).catch(() => {})
    }

    console.log('\n=== FINAL RUN EVIDENCE ===')
    console.log(JSON.stringify(run, null, 2).slice(0, 3000))
    if (run?.taskId) {
      const t = await api(`/api/tasks/${run.taskId}`)
      if (t.json?.task) console.log(`task status=${t.json.task.status}`)
    }
  } finally {
    // Cleanup probe project + tasks
    const tasks = await api(`/api/tasks?project_id=${projectId}&limit=100`).catch(() => ({ json: null }))
    for (const t of tasks.json?.tasks || []) {
      await api(`/api/tasks/${t.id}`, { method: 'DELETE' }).catch(() => {})
    }
    await api(`/api/projects/${projectId}?mode=delete`, { method: 'DELETE' }).catch(() => {})
    console.log('\ncleanup: probe project removed')
  }
}

main().catch((err) => { console.error(`PROBE FAILED: ${err.message}`); process.exit(1) })
