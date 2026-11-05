import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { discoverPlatoonCommanders } from '@/lib/platoon-commanders'

/** AgentOS platoon-commander inventory and safety state. */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  return NextResponse.json({ commanders: discoverPlatoonCommanders() })
}

export const dynamic = 'force-dynamic'
