import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { analyzeProjectForce, updateProjectForceProfile } from '@/lib/project-force-planning'
import { bindExternalAgentToProject } from '@/lib/external-project-bindings'

function toProjectId(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null
  return value as string[]
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
    return NextResponse.json(analyzeProjectForce(projectId, auth.user.workspace_id ?? 1))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to analyze project force'
    return NextResponse.json({ error: message }, { status: message === 'Project not found' ? 404 : 500 })
  }
}
export async function PUT(
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
  const required = strings(body.requiredCapabilities)
  const preferred = strings(body.preferredCapabilities)
  const platoons = strings(body.preferredPlatoons)
  if (!required || !preferred || !platoons) {
    return NextResponse.json({ error: 'Capability and platoon fields must be string arrays' }, { status: 400 })
  }
  const maxTeamSize = body.maxTeamSize == null ? null : Number(body.maxTeamSize)
  if (maxTeamSize !== null && (!Number.isFinite(maxTeamSize) || maxTeamSize < 1 || maxTeamSize > 50)) {
    return NextResponse.json({ error: 'maxTeamSize must be between 1 and 50' }, { status: 400 })
  }
  try {
    updateProjectForceProfile({
      projectId, workspaceId: auth.user.workspace_id ?? 1,
      requiredCapabilities: required, preferredCapabilities: preferred, preferredPlatoons: platoons,
      maxTeamSize, actor: auth.user.username,
    })
    return NextResponse.json(analyzeProjectForce(projectId, auth.user.workspace_id ?? 1))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update project force profile'
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

  let body: Record<string, unknown> = {}
  try {
    const text = await request.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (body.action !== 'assemble-recommended') {
    return NextResponse.json({ error: 'action must be assemble-recommended' }, { status: 400 })
  }

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const before = analyzeProjectForce(projectId, workspaceId)
    const added: Array<{ externalAgentId: string; agentName: string; platoonId: string; capabilities: string[] }> = []
    const errors: Array<{ externalAgentId: string; agentName: string; error: string }> = []

    for (const recommendation of before.recommendations) {
      try {
        const binding = bindExternalAgentToProject({
          projectId, workspaceId, externalAgentId: recommendation.externalAgentId,
          role: recommendation.capabilities.join(', ') || 'recommended',
          actor: auth.user.username,
        })
        added.push({
          externalAgentId: binding.externalAgentId, agentName: binding.agentName,
          platoonId: binding.platoonId, capabilities: recommendation.capabilities,
        })
      } catch (error) {
        errors.push({
          externalAgentId: recommendation.externalAgentId,
          agentName: recommendation.name,
          error: error instanceof Error ? error.message : 'Failed to bind recommended agent',
        })
      }
    }

    return NextResponse.json({
      added, errors, ...analyzeProjectForce(projectId, workspaceId),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to assemble recommended team'
    return NextResponse.json({ error: message }, { status: message === 'Project not found' ? 404 : 500 })
  }
}
export const dynamic = 'force-dynamic'
