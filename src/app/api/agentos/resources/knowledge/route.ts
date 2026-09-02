import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  createKnowledgeSuiteObjective,
  ingestKnowledgeMissionResult,
  retryKnowledgeMission,
  reconcileKnowledgeCuration,
  listKnowledgeSuiteMissions,
  getKnowledgeSuiteState,
} from '@/lib/knowledge-curation'
import { reconcileObjectiveStatuses } from '@/lib/objective-planning'

/**
 * AgentOS knowledge-curation lifecycle (Company Commander proof).
 *
 * POST actions:
 *   create    — plan the "Build Tactical Encounter Knowledge Pack Suite"
 *               objective (M1–M6, M6 depends on M1–M5) under AgentOS Operations
 *   ingest    — validate + stage a pack mission result (pack or M6 validation)
 *   retry     — re-run a mission (same lineage; clears escalation)
 *   reconcile — sweep running/valid results + dependency promotion + escalation
 * GET        — suite state: objective + mission traces (task/delegation linkage)
 *
 * Nothing here promotes resources, writes outside the configured vault dirs, or
 * runs the vault scanner — generated packs surface as NEW only after a scan.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = body as {
    action?: unknown
    packId?: unknown
    taskId?: unknown
    workspaceId?: unknown
    projectId?: unknown
    text?: unknown
    actor?: unknown
  }
  const action = String(parsed.action || '')
  const workspaceId = typeof parsed.workspaceId === 'number' ? parsed.workspaceId : auth.user.workspace_id
  const projectId = typeof parsed.projectId === 'number' ? parsed.projectId : null
  const actor = auth.user.username || auth.user.display_name || 'agentos'
  const root: string | undefined = undefined // live vault via config

  try {
    switch (action) {
      case 'create': {
        const suite = createKnowledgeSuiteObjective({ workspaceId, projectId, actor, root })
        return NextResponse.json({ ok: true, suite })
      }
      case 'ingest': {
        const taskId = Number(parsed.taskId)
        if (!Number.isFinite(taskId)) return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
        const result = ingestKnowledgeMissionResult({
          taskId,
          workspaceId,
          text: typeof parsed.text === 'string' ? parsed.text : null,
          root,
          actor,
        })
        return NextResponse.json({ ok: true, result })
      }
      case 'retry': {
        const packId = String(parsed.packId || '').trim()
        if (!packId) return NextResponse.json({ error: 'packId is required' }, { status: 400 })
        const mission = retryKnowledgeMission({ packId, workspaceId, projectId, actor, root })
        return NextResponse.json({ ok: true, mission })
      }
      case 'reconcile': {
        const result = reconcileKnowledgeCuration(root)
        const objectives = reconcileObjectiveStatuses()
        return NextResponse.json({ ok: true, result, objectivesChanged: objectives.length })
      }
      default:
        return NextResponse.json({ error: `Unknown action "${action}"; expected create|ingest|retry|reconcile` }, { status: 400 })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Knowledge-curation action failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const url = request.nextUrl
  const workspaceId = Number(url.searchParams.get('workspace_id') || auth.user.workspace_id)
  const projectId = url.searchParams.get('project_id') ? Number(url.searchParams.get('project_id')) : null
  const state = getKnowledgeSuiteState(workspaceId)
  const missions = projectId
    ? listKnowledgeSuiteMissions(workspaceId, projectId)
    : state.missions
  return NextResponse.json({ ok: true, state: { ...state, missions } })
}

export const dynamic = 'force-dynamic'
