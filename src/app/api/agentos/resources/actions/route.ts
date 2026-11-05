import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { performArsenalAction, ARSENAL_ACTIONS, validatePromotionPayload, type ArsenalAction } from '@/lib/ai-resource-actions'

/**
 * Phase 9 — controlled AI Arsenal approval actions.
 * Every action is validated and written atomically with backups;
 * nothing here moves, deletes, or renames physical resources.
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = body as { action?: unknown; resourceId?: unknown; reason?: unknown; reviewer?: unknown; promotion?: unknown; preferredResourceId?: unknown }
  const action = String(parsed.action || '')
  const resourceId = String(parsed.resourceId || '').trim()
  const knownActions = new Set<ArsenalAction>(ARSENAL_ACTIONS.map(a => a.id))
  if (!knownActions.has(action as ArsenalAction)) {
    return NextResponse.json({ error: `Unknown action "${action}"; expected one of ${[...knownActions].join(', ')}` }, { status: 400 })
  }
  if (!resourceId) return NextResponse.json({ error: 'resourceId is required' }, { status: 400 })
  if (action === 'approve') {
    const errors = validatePromotionPayload(parsed.promotion)
    if (errors.length) return NextResponse.json({ error: 'Invalid promotion payload: ' + errors.join('; ') }, { status: 400 })
  }
  try {
    const result = performArsenalAction({
      action: action as ArsenalAction,
      resourceId,
      actor: auth.user.username || auth.user.display_name || 'agentos',
      payload: {
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        reviewer: typeof parsed.reviewer === 'string' ? parsed.reviewer : undefined,
        promotion: parsed.promotion && typeof parsed.promotion === 'object' ? parsed.promotion as Record<string, unknown> : undefined,
        preferredResourceId: typeof parsed.preferredResourceId === 'string' ? parsed.preferredResourceId : undefined,
      },
    })
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Arsenal action failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export const dynamic = 'force-dynamic'