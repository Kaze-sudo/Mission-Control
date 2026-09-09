import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  bindExternalAgentToProject,
  listExternalProjectBindings,
  unbindExternalAgentFromProject,
} from '@/lib/external-project-bindings'

function projectId(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const resolved = projectId((await params).id)
  if (!resolved) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })

  try {
    const bindings = listExternalProjectBindings(resolved, auth.user.workspace_id ?? 1)
    return NextResponse.json({ bindings })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list external agent bindings'
    return NextResponse.json({ error: message }, { status: message === 'Project not found' ? 404 : 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  const resolved = projectId((await params).id)
  if (!resolved) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const externalAgentId = typeof body.externalAgentId === 'string' ? body.externalAgentId.trim() : ''
  const role = typeof body.role === 'string' ? body.role.trim() : undefined
  if (!externalAgentId) return NextResponse.json({ error: 'externalAgentId is required' }, { status: 400 })

  try {
    const binding = bindExternalAgentToProject({
      projectId: resolved,
      workspaceId: auth.user.workspace_id ?? 1,
      externalAgentId,
      role,
      actor: auth.user.username,
    })
    return NextResponse.json({ binding }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to bind external agent'
    const status = message === 'Project not found' ? 404
      : message.includes('discoverable') || message.includes('role') ? 400
      : 500
    return NextResponse.json({ error: message }, { status })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  const resolved = projectId((await params).id)
  if (!resolved) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })

  const rawBindingId = new URL(request.url).searchParams.get('bindingId') || ''
  const bindingId = Number.parseInt(rawBindingId, 10)
  if (!Number.isFinite(bindingId) || bindingId <= 0) {
    return NextResponse.json({ error: 'Valid bindingId is required' }, { status: 400 })
  }

  try {
    const removed = unbindExternalAgentFromProject({
      projectId: resolved,
      workspaceId: auth.user.workspace_id ?? 1,
      bindingId,
    })
    if (!removed) return NextResponse.json({ error: 'Binding not found' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to remove external agent binding'
    return NextResponse.json({ error: message }, { status: message === 'Project not found' ? 404 : 500 })
  }
}

export const dynamic = 'force-dynamic'
