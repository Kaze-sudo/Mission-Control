import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getGlobalAgentRoster } from '@/lib/global-agent-roster'
import { rankAgentsForMission } from '@/lib/agent-selection'

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null
  return value as string[]
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const requiredCapabilities = stringArray(body.requiredCapabilities)
  const preferredCapabilities = stringArray(body.preferredCapabilities)
  const preferredPlatoons = stringArray(body.preferredPlatoons)
  if (!requiredCapabilities || !preferredCapabilities || !preferredPlatoons) {
    return NextResponse.json({ error: 'Capability and platoon fields must be string arrays' }, { status: 400 })
  }

  const roster = getGlobalAgentRoster(auth.user.workspace_id ?? 1)
  const candidates = rankAgentsForMission(roster, {
    requiredCapabilities,
    preferredCapabilities,
    preferredPlatoons,
  })

  return NextResponse.json({
    requirements: { requiredCapabilities, preferredCapabilities, preferredPlatoons },
    candidates,
    selected: candidates.find(candidate => candidate.eligible) || null,
  })
}

export const dynamic = 'force-dynamic'
