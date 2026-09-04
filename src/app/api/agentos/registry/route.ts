import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { buildAgentRegistrySnapshot } from '@/lib/agent-registry'

/**
 * GET /api/agentos/registry — operational Agent Registry: every discovered
 * external specialist grouped by CLI ecosystem / host with orchestrator
 * state, capability tags, runtime identity, cost class, registration status,
 * current (transient) assignment, and truthful dispatchability.
 *
 * Read-only composition of the existing discovery + registration modules.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const registry = buildAgentRegistrySnapshot(workspaceId)
    return NextResponse.json({ registry })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build AgentOS registry'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
