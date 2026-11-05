import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { getGlobalAgentRoster } from '@/lib/global-agent-roster'
import { syncAgentRoster, buildRosterView, type RosterSyncReport, type RosterAgentCostMeta } from '@/lib/agent-roster-sync'

/**
 * AgentOS roster bridge.
 *
 * GET  /api/agentos/roster — discovered roster plus per-agent registration
 *                            status (registered → live agents row) and the
 *                            truthful cost classification that dispatch would
 *                            apply.
 * POST /api/agentos/roster — reconcile: register discovered specialists as
 *                            live roster agents; when projectId is given, bind
 *                            available specialists to that project so
 *                            capability routing can select them. Operator-gated.
 *
 * Registration never costs credits — it only writes already-discovered
 * specialists into the roster. Dispatch is still gated by the execution
 * authorization guard.
 */
function classifyRows(rows: RosterSyncReport['agents']) {
  const byClass: Record<string, number> = {}
  for (const row of rows) {
    if (!row.costClass) continue
    byClass[row.costClass] = (byClass[row.costClass] || 0) + 1
  }
  return byClass
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const workspaceId = auth.user.workspace_id ?? 1

  const roster = getGlobalAgentRoster(workspaceId)
  const view = buildRosterView({ workspaceId })

  return NextResponse.json({
    discovered: roster.map(agent => ({
      id: agent.id,
      name: agent.name,
      platoonId: agent.platoonId,
      role: agent.role,
      availability: agent.availability,
      source: agent.source,
      capabilities: agent.capabilities.tags,
    })),
    agents: view.agents,
    summary: {
      discovered: view.discovered,
      registered: view.registered,
      dispatchable: view.dispatchable,
      unavailable: view.unavailable,
      classifications: classifyRows(view.agents),
    },
  })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  let body: Record<string, unknown>
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const workspaceId = typeof body.workspaceId === 'number' ? body.workspaceId : (auth.user.workspace_id ?? 1)
  const projectId = typeof body.projectId === 'number' ? body.projectId : null
  const action = String(body.action || 'reconcile')
  if (action !== 'reconcile') {
    return NextResponse.json({ error: `Unsupported action: ${action}` }, { status: 400 })
  }

  const costMetaRaw = body.costMeta
  let costMeta: Record<string, RosterAgentCostMeta> | undefined
  if (costMetaRaw && typeof costMetaRaw === 'object' && !Array.isArray(costMetaRaw)) {
    costMeta = costMetaRaw as Record<string, RosterAgentCostMeta>
  }

  try {
    const report = syncAgentRoster({
      workspaceId,
      projectId,
      costMeta,
      actor: auth.user.username || auth.user.display_name || 'operator',
    })
    const rows = report.agents
    return NextResponse.json({
      ok: true,
      report,
      summary: {
        discovered: report.discovered,
        registered: report.registered,
        added: report.added,
        updated: report.updated,
        markedOffline: report.markedOffline,
        boundAdded: report.boundAdded,
        dispatchable: report.dispatchable,
        unavailable: report.unavailable,
        classifications: classifyRows(rows),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Roster reconcile failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
