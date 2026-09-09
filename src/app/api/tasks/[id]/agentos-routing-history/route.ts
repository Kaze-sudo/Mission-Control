import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listRoutingDecisions } from '@/lib/routing-decisions'

function toTaskId(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const taskId = toTaskId((await params).id)
  if (!taskId) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })

  const decisions = listRoutingDecisions(taskId, auth.user.workspace_id ?? 1)
  return NextResponse.json({ decisions })
}

export const dynamic = 'force-dynamic'
