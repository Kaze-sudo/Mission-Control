import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getGlobalAgentRoster } from '@/lib/global-agent-roster'

/** AgentOS global roster across discovered CLI platoons. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = auth.user.workspace_id ?? 1
  const agents = getGlobalAgentRoster(workspaceId)
  return NextResponse.json({ agents, total: agents.length })
}

export const dynamic = 'force-dynamic'
