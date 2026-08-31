import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { routeTaskWithinProject } from '@/lib/project-task-routing'

function toTaskId(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

function stringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null
  return value as string[]
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  const taskId = toTaskId((await params).id)
  if (!taskId) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
  let body: Record<string, unknown> = {}
  try {
    const text = await request.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const requiredCapabilities = stringArray(body.requiredCapabilities)
  const preferredCapabilities = stringArray(body.preferredCapabilities)
  const preferredPlatoons = stringArray(body.preferredPlatoons)
  if (requiredCapabilities === null || preferredCapabilities === null || preferredPlatoons === null) {
    return NextResponse.json({ error: 'Routing requirements must be string arrays' }, { status: 400 })
  }

  const result = routeTaskWithinProject({
    taskId,
    workspaceId: auth.user.workspace_id ?? 1,
    actor: auth.user.username,
    allowReassign: body.allowReassign === true,
    requirements: {
      ...(requiredCapabilities !== undefined ? { requiredCapabilities } : {}),
      ...(preferredCapabilities !== undefined ? { preferredCapabilities } : {}),
      ...(preferredPlatoons !== undefined ? { preferredPlatoons } : {}),
    },
  })
  if (!result.routed) {
    const status = result.reason === 'Task not found' ? 404 : 409
    return NextResponse.json(result, { status })
  }

  return NextResponse.json(result)
}

export const dynamic = 'force-dynamic'
