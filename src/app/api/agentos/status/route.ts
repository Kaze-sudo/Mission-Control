import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { buildAgentOSStatusSnapshot } from '@/lib/agentos-status'

/**
 * GET /api/agentos/status — live AgentOS command-layer snapshot for the
 * Overview surface: CLI host health, project command state, roster
 * dispatchability, gated execution buckets, and recent orchestration errors.
 * Read-only composition of existing discovery + registry state.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const workspaceId = auth.user.workspace_id ?? 1
    const snapshot = buildAgentOSStatusSnapshot(workspaceId)
    return NextResponse.json({ status: snapshot })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build AgentOS status snapshot'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
