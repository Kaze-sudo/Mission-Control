import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { acceptHandoff, cancelHandoff, createHandoff, listProjectHandoffs } from '@/lib/task-handoffs'

function projectId(raw: string): number | null { const v = Number.parseInt(raw, 10); return Number.isFinite(v) && v > 0 ? v : null }

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const id = projectId((await params).id)
  if (!id) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
  return NextResponse.json({ handoffs: listProjectHandoffs(id, auth.user.workspace_id ?? 1) })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request); if (limited) return limited
  const id = projectId((await params).id)
  if (!id) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const fromTaskId = Number(body.fromTaskId)
  if (!Number.isFinite(fromTaskId) || fromTaskId <= 0) return NextResponse.json({ error: 'Valid fromTaskId is required' }, { status: 400 })
  const caps = Array.isArray(body.requestedCapabilities) && body.requestedCapabilities.every(x => typeof x === 'string') ? body.requestedCapabilities as string[] : []
  try {
    const handoff = createHandoff({
      projectId: id, workspaceId: auth.user.workspace_id ?? 1, fromTaskId,
      toExternalAgentId: typeof body.toExternalAgentId === 'string' ? body.toExternalAgentId : null,
      requestedCapabilities: caps, instructions: typeof body.instructions === 'string' ? body.instructions : null, actor: auth.user.username,
    })
    return NextResponse.json({ handoff }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create handoff'
    return NextResponse.json({ error: message }, { status: message.includes('not found') || message.includes('not bound') ? 400 : 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request); if (limited) return limited
  const id = projectId((await params).id)
  if (!id) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const handoffId = Number(body.handoffId)
  if (!Number.isFinite(handoffId) || handoffId <= 0) return NextResponse.json({ error: 'Valid handoffId is required' }, { status: 400 })
  try {
    if (body.action === 'cancel') return NextResponse.json({ success: cancelHandoff(handoffId, auth.user.workspace_id ?? 1) })
    if (body.action !== 'accept') return NextResponse.json({ error: 'action must be accept or cancel' }, { status: 400 })
    const handoff = acceptHandoff({ handoffId, workspaceId: auth.user.workspace_id ?? 1, actor: auth.user.username })
    if (handoff.projectId !== id) return NextResponse.json({ error: 'Handoff project mismatch' }, { status: 409 })
    return NextResponse.json({ handoff })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update handoff'
    return NextResponse.json({ error: message }, { status: 409 })
  }
}

export const dynamic = 'force-dynamic'
