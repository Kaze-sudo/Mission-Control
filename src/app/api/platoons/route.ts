import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { discoverPlatoons } from '@/lib/platoons'

/** AgentOS Company Commander view of installed CLI/runtime platoons. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  return NextResponse.json({ platoons: discoverPlatoons() })
}

export const dynamic = 'force-dynamic'
