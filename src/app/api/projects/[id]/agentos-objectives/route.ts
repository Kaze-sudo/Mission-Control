import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { z } from 'zod'
import {
  createObjectivePlan,
  executeObjective,
  listProjectObjectives,
  previewObjectivePlan,
} from '@/lib/objective-planning'

const objectiveInputSchema = z.object({
  action: z.enum(['preview', 'create']).optional(),
  title: z.string().trim().min(1, 'Objective title is required').max(500),
  description: z.string().max(30000).optional(),
  missions: z.array(z.object({
    key: z.string().trim().min(1).max(100).optional(),
    title: z.string().trim().min(1).max(1000),
    description: z.string().max(30000).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(100).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    requiredCapabilities: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    preferredCapabilities: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })).min(1).max(100).optional(),
})

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

  const parsed = objectiveInputSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid objective' }, { status: 400 })
  const { title, description, missions, action } = parsed.data

  try {
    if (action === 'preview') {
      return NextResponse.json({ plan: previewObjectivePlan({
        projectId, workspaceId: auth.user.workspace_id ?? 1, title, description, missions,
      }) })
    }
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
