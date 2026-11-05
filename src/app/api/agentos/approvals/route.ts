import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listApprovalRequiredPlans } from '@/lib/agentos-approvals'

/**
 * GET /api/agentos/approvals — canonical cross-project approval queue.
 *
 * Read-only surface over the shared read model in `agentos-approvals.ts`:
 * every objective whose latest execution plan requires approval and is not
 * covered by a VALID approval (missing, STALE, or EXPIRED). Approve/deny
 * mutations stay on the authoritative per-project route
 * (`POST /api/projects/[id]/agentos-execution`) — this endpoint never mutates.
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

    const result = listApprovalRequiredPlans(workspaceId, { projectId, limit })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load AgentOS approvals'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
