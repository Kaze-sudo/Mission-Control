import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { getAiResourceRegistry, recommendAiResources, scanAiVault, getAiArsenalState } from '@/lib/ai-resource-registry'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const caps = (request.nextUrl.searchParams.get('capabilities') || '').split(',').map(v => v.trim()).filter(Boolean)
  try {
    const arsenal = getAiArsenalState()
    return NextResponse.json({
      registry: arsenal.registry,
      capabilityCoverage: arsenal.capabilityCoverage,
      changes: arsenal.changes,
      reviewQueue: arsenal.reviewQueue,
      promotionHistory: arsenal.promotionHistory,
      platoonMap: arsenal.platoonMap,
      selectionOrder: arsenal.selectionOrder,
      knowledgePackBacklog: arsenal.knowledgePackBacklog,
      summary: arsenal.summary,
      recommendations: caps.length ? recommendAiResources(caps, 12) : [],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load AI Arsenal state'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  try {
    const registry = scanAiVault(undefined, false)
    return NextResponse.json({ registry })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to scan AI vault'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'