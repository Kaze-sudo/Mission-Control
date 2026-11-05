import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listProjectDelegations } from '@/lib/delegation-ledger'

function toProjectId(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const projectId = toProjectId((await params).id)
  if (!projectId) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })

  return NextResponse.json({
    delegations: listProjectDelegations(projectId, auth.user.workspace_id ?? 1),
  })
}

export const dynamic = 'force-dynamic'
