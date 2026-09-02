import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  createDeepReviewMission,
  retryDeepReviewMission,
  ingestDeepReviewResult,
  listDeepReviewMissions,
  reconcileDeepReviewMissions,
} from '@/lib/resource-deep-review'
import { reconcileObjectiveStatuses } from '@/lib/objective-planning'

/**
 * Phase 4/7/8 — AI Arsenal deep-review mission lifecycle.
 * Creates normal AgentOS tasks, routes them through the standard project
 * selector, and ingests structured reviewer results (agentos-resource-review-v1).
 * Nothing here auto-promotes; approvals stay in the action model.
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
    reviewId?: unknown
    taskId?: unknown
    workspaceId?: unknown
    projectId?: unknown
    text?: unknown
    actor?: unknown
    reviewer?: unknown
  }
  const action = String(parsed.action || '')
  const workspaceId = typeof parsed.workspaceId === 'number' ? parsed.workspaceId : auth.user.workspace_id
  const projectId = typeof parsed.projectId === 'number' ? parsed.projectId : null
  const actor = auth.user.username || auth.user.display_name || 'agentos'
  const root: string | undefined = undefined // live vault via config

  try {
    switch (action) {
      case 'create': {
        const reviewId = String(parsed.reviewId || '').trim()
        if (!reviewId) return NextResponse.json({ error: 'reviewId is required' }, { status: 400 })
        const mission = createDeepReviewMission({
          reviewId,
          workspaceId,
          projectId,
          actor,
          root,
          reviewer: typeof parsed.reviewer === 'string' ? parsed.reviewer : null,
        })
        return NextResponse.json({ ok: true, mission })
      }
      case 'retry': {
        const reviewId = String(parsed.reviewId || '').trim()
        if (!reviewId) return NextResponse.json({ error: 'reviewId is required' }, { status: 400 })
        const mission = retryDeepReviewMission({ reviewId, workspaceId, projectId, actor, root })
        return NextResponse.json({ ok: true, mission })
      }
      case 'ingest': {
        const taskId = Number(parsed.taskId)
        if (!Number.isFinite(taskId)) return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
        const result = ingestDeepReviewResult({
          taskId,
          workspaceId,
          text: typeof parsed.text === 'string' ? parsed.text : null,
          root,
        })
        return NextResponse.json({ ok: true, result })
      }
      case 'reconcile': {
        const result = reconcileDeepReviewMissions(root)
        const objectives = reconcileObjectiveStatuses()
        return NextResponse.json({ ok: true, result, objectivesChanged: objectives.length })
      }
      default:
        return NextResponse.json({ error: `Unknown action "${action}"; expected create|retry|ingest|reconcile` }, { status: 400 })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Deep-review action failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const url = request.nextUrl
  const workspaceId = Number(url.searchParams.get('workspace_id') || auth.user.workspace_id)
  const projectId = url.searchParams.get('project_id') ? Number(url.searchParams.get('project_id')) : null
  const missions = listDeepReviewMissions(workspaceId, projectId)
  return NextResponse.json({ missions })
}

export const dynamic = 'force-dynamic'