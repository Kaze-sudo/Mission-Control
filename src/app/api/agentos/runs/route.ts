import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  listAgentOSRuns,
  retryAgentOSRun,
  type AgentOSRunDisplayState,
} from '@/lib/agentos-runs'

const DISPLAY_STATES = new Set([
  'QUEUED', 'HELD', 'WAITING', 'RUNNING', 'REVIEWING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED',
])

/**
 * GET /api/agentos/runs — canonical AgentOS execution run feed.
 *
 * Lightweight DB-only reads (no host discovery) joining the delegation ledger
 * to task/project/objective identity, plus AgentOS mission tasks that have not
 * yet produced a delegation so queued/held/waiting work is visible. Safe to
 * poll while runs are active.
 *
 * Query params:
 *   project_id  — narrow to one project
 *   state       — comma-separated display buckets (QUEUED,RUNNING,...)
 *   ecosystem   — CLI ecosystem id (gamut, hermes, codex, claude)
 *   agent       — routing agent or specialist name (substring)
 *   limit       — cap (default 100, max 250)
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const search = request.nextUrl.searchParams
    const projectRaw = search.get('project_id')
    const projectId = projectRaw && /^\d+$/.test(projectRaw) ? Number(projectRaw) : null
    const states = (search.get('state') || '')
      .split(',')
      .map(value => value.trim().toUpperCase())
      .filter((value): value is AgentOSRunDisplayState => DISPLAY_STATES.has(value as AgentOSRunDisplayState))
    const limitRaw = search.get('limit')
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 100

    const result = listAgentOSRuns({
      workspaceId,
      projectId,
      states: states.length > 0 ? states : null,
      ecosystem: search.get('ecosystem')?.trim().toLowerCase() || null,
      agent: search.get('agent')?.trim() || null,
      limit,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load AgentOS runs'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST /api/agentos/runs — operator actions on the canonical run feed.
 *
 * Currently only `retry`, which re-enters a terminal FAILED run through the
 * existing AgentOS pipeline (fresh routing + dispatch-time authorization).
 * The failed delegation is preserved as history. Project pause/block state is
 * honored — retry is new work and never bypasses the pause gate.
 *
 * Body: { action: 'retry', delegationId?: string, taskId?: number }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const workspaceId = auth.user.workspace_id ?? 1
  const actor = auth.user.username || auth.user.display_name || 'operator'
  const action = String(body.action || '')

  if (action !== 'retry') {
    return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 })
  }

  const delegationId = typeof body.delegationId === 'string' && body.delegationId.trim()
    ? body.delegationId.trim()
    : null
  const taskIdRaw = typeof body.taskId === 'number' || typeof body.taskId === 'string' ? body.taskId : null
  const taskId = taskIdRaw !== null && Number.isFinite(Number(taskIdRaw)) && Number(taskIdRaw) > 0
    ? Number(taskIdRaw)
    : null
  if (!delegationId && !taskId) {
    return NextResponse.json({ error: 'delegationId or taskId is required' }, { status: 400 })
  }

  try {
    const result = retryAgentOSRun({ workspaceId, actor, delegationId, taskId })
    if (result.ok) return NextResponse.json(result)
    const status = result.held ? 409 : 400
    return NextResponse.json(result, { status })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to retry run'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
