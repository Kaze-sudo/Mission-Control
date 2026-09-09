import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listReviewableTasks } from '@/lib/agentos-reviews'

/**
 * GET /api/agentos/reviews — canonical cross-project review queue.
 *
 * Read-only surface over the shared read model in `agentos-reviews.ts`:
 * every task whose executor work landed in a review state
 * ('review' | 'quality_review'), with the latest quality-review record and
 * delegation identity. Review decisions stay on the authoritative backend
 * (`POST /api/quality-review`) — this endpoint never mutates.
 *
 * Query params:
 *   project_id — narrow to one project
 *   limit      — cap (default 100, max 250)
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const search = request.nextUrl.searchParams
    const projectRaw = search.get('project_id')
    const projectId = projectRaw && /^\d+$/.test(projectRaw) ? Number(projectRaw) : null
    const limitRaw = search.get('limit')
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 100

    const result = listReviewableTasks(workspaceId, { projectId, limit })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load AgentOS review queue'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
