import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  createObjectivePlan,
  executeObjective,
  listProjectObjectives,
  type ObjectiveMissionInput,
} from '@/lib/objective-planning'

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

  try {
    return NextResponse.json({
      objectives: listProjectObjectives(projectId, auth.user.workspace_id ?? 1),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list objectives'
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

  const projectId = toProjectId((await params).id)
  if (!projectId) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const description = typeof body.description === 'string' ? body.description : ''
  if (!title) return NextResponse.json({ error: 'Objective title is required' }, { status: 400 })
  const missions = Array.isArray(body.missions)
    ? body.missions as ObjectiveMissionInput[]
    : undefined

  try {
    const objective = createObjectivePlan({
      projectId,
      workspaceId: auth.user.workspace_id ?? 1,
      title,
      description,
      missions,
      actor: auth.user.username,
    })
    return NextResponse.json({ objective }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to plan objective'
    const status = message === 'Project not found' ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const projectId = toProjectId((await params).id)
  if (!projectId) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const objectiveId = Number(body.objectiveId)
  if (!Number.isInteger(objectiveId) || objectiveId <= 0 || body.action !== 'execute') {
    return NextResponse.json({ error: 'objectiveId and action=execute are required' }, { status: 400 })
  }

  try {
    const result = executeObjective({
      objectiveId,
      projectId,
      workspaceId: auth.user.workspace_id ?? 1,
      actor: auth.user.username,
    })
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to execute objective'
    return NextResponse.json({ error: message }, { status: message.includes('not found') ? 404 : 400 })
  }
}

export const dynamic = 'force-dynamic'
