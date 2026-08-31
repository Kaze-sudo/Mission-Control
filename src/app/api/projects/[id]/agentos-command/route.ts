import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { getProjectCommand, updateProjectCommand, type ProjectCommandState, type FallbackBehavior } from '@/lib/project-command'

function projectId(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const id = projectId((await params).id)
  if (!id) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
  try { return NextResponse.json({ command: getProjectCommand(id, auth.user.workspace_id ?? 1) }) }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load project command state'
    return NextResponse.json({ error: message }, { status: message === 'Project not found' ? 404 : 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const id = projectId((await params).id)
  if (!id) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const validStates = new Set<ProjectCommandState>(['draft','ready','active','paused','blocked'])
  const validFallbacks = new Set<FallbackBehavior>(['hold','manual','best_available'])
  const state = typeof body.state === 'string' && validStates.has(body.state as ProjectCommandState) ? body.state as ProjectCommandState : undefined
  const fallback = typeof body.fallbackBehavior === 'string' && validFallbacks.has(body.fallbackBehavior as FallbackBehavior) ? body.fallbackBehavior as FallbackBehavior : undefined
  const allowedPlatoons = Array.isArray(body.allowedPlatoons) && body.allowedPlatoons.every(item => typeof item === 'string') ? body.allowedPlatoons as string[] : undefined
  try {
    const command = updateProjectCommand({
      projectId: id, workspaceId: auth.user.workspace_id ?? 1, state, actor: auth.user.username,
      policy: {
        ...(typeof body.autoRoute === 'boolean' ? { autoRoute: body.autoRoute } : {}),
        ...(typeof body.allowReroute === 'boolean' ? { allowReroute: body.allowReroute } : {}),
        ...(fallback ? { fallbackBehavior: fallback } : {}),
        ...(allowedPlatoons ? { allowedPlatoons } : {}),
        ...(Number.isFinite(Number(body.maxProjectConcurrent)) ? { maxProjectConcurrent: Number(body.maxProjectConcurrent) } : {}),
        ...(Number.isFinite(Number(body.maxPlatoonConcurrent)) ? { maxPlatoonConcurrent: Number(body.maxPlatoonConcurrent) } : {}),
        ...(Number.isFinite(Number(body.maxAgentConcurrent)) ? { maxAgentConcurrent: Number(body.maxAgentConcurrent) } : {}),
      },
    })
    return NextResponse.json({ command })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update project command state'
    return NextResponse.json({ error: message }, { status: message === 'Project not found' ? 404 : message.includes('cannot activate') ? 409 : 500 })
  }
}

export const dynamic = 'force-dynamic'
