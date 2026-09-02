import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { getProjectCommand } from '@/lib/project-command'
import {
  buildExecutionPlan,
  saveExecutionPlanRow,
  readExecutionPlanRow,
  type ExecutionPolicy,
} from '@/lib/execution-planning'
import {
  createExecutionApproval,
  denyExecutionPlan,
  latestApprovalForObjective,
  approvalStatusForPlan,
} from '@/lib/execution-authorization'

function projectId(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

function policyOf(projectId: number, workspaceId: number): ExecutionPolicy {
  const command = getProjectCommand(projectId, workspaceId)
  const policy = command.policy
  return {
    allowFreeLocalWithoutApproval: policy.allowFreeLocalWithoutApproval ?? true,
    allowFreeRemoteWithoutApproval: policy.allowFreeRemoteWithoutApproval ?? false,
    allowPaidWithoutApproval: policy.allowPaidWithoutApproval ?? false,
    maxApprovedEstimatedCost: policy.maxApprovedEstimatedCost ?? null,
    approvedProviders: policy.approvedProviders || [],
    blockedProviders: policy.blockedProviders || [],
  }
}

/**
 * AgentOS execution preview → cost/runtime risk → user approval → dispatch
 * authorization. Preview generation classifies every mission with existing
 * runtime metadata; approval records bind to the exact plan fingerprint.
 * Dispatch-time enforcement lives in the scheduler (authorizeAgentOSTaskDispatch),
 * not here.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const id = projectId((await params).id)
  if (!id) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
  const workspaceId = auth.user.workspace_id ?? 1
  const objectiveId = Number(request.nextUrl.searchParams.get('objective_id'))
  if (!Number.isFinite(objectiveId) || objectiveId <= 0) {
    return NextResponse.json({ error: 'objective_id query parameter is required' }, { status: 400 })
  }
  try {
    const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: policyOf(id, workspaceId), actor: 'agentos' })
    const approval = latestApprovalForObjective(objectiveId, workspaceId)
    const approvalStatus = approvalStatusForPlan(approval, plan)
    const stored = readExecutionPlanRow(objectiveId, workspaceId)
    return NextResponse.json({ ok: true, plan, approval, approvalStatus, rowStatus: stored?.status ?? null })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build execution preview'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const id = projectId((await params).id)
  if (!id) return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const workspaceId = auth.user.workspace_id ?? 1
  const actor = auth.user.username || auth.user.display_name || 'operator'
  const objectiveId = Number(body.objectiveId)
  if (!Number.isFinite(objectiveId) || objectiveId <= 0) {
    return NextResponse.json({ error: 'objectiveId is required' }, { status: 400 })
  }
  const action = String(body.action || 'preview')

  try {
    if (action === 'preview' || action === 'refresh') {
      const plan = buildExecutionPlan({ objectiveId, workspaceId, policy: policyOf(id, workspaceId), actor })
      const status = plan.summary.approvalRequired ? 'AWAITING_APPROVAL' : 'APPROVED'
      saveExecutionPlanRow(plan, status)
      const approval = latestApprovalForObjective(objectiveId, workspaceId)
      const approvalStatus = approvalStatusForPlan(approval, plan)
      return NextResponse.json({ ok: true, plan, approval, approvalStatus, rowStatus: status })
    }
    if (action === 'approve') {
      const taskIds = body.approveTaskIds === 'all-eligible' || body.approveTaskIds === undefined
        ? 'all-eligible' as const
        : Array.isArray(body.approveTaskIds) ? (body.approveTaskIds as unknown[]).map(Number).filter(Number.isFinite) : undefined
      if (!taskIds && !Array.isArray(body.approveTaskIds)) {
        return NextResponse.json({ error: 'approveTaskIds must be an array or "all-eligible"' }, { status: 400 })
      }
      const result = createExecutionApproval({
        objectiveId,
        workspaceId,
        actor,
        approveTaskIds: taskIds as number[] | 'all-eligible',
        excludeTaskIds: Array.isArray(body.excludeTaskIds) ? (body.excludeTaskIds as unknown[]).map(Number).filter(Number.isFinite) : [],
        expiresInHours: typeof body.expiresInHours === 'number' && Number.isFinite(body.expiresInHours) ? body.expiresInHours : undefined,
        maxAuthorizedAmount: body.maxAuthorizedAmount === null || body.maxAuthorizedAmount === undefined ? undefined : Number(body.maxAuthorizedAmount),
      })
      if (!result.ok || !result.plan) {
        return NextResponse.json({ ok: false, error: result.message, errors: result.errors || [] }, { status: 400 })
      }
      saveExecutionPlanRow(result.plan, result.partiallyApproved ? 'AWAITING_APPROVAL' : 'APPROVED')
      return NextResponse.json({ ok: true, plan: result.plan, approval: result.approval, approvalStatus: 'VALID', result })
    }
    if (action === 'deny') {
      const result = denyExecutionPlan({
        objectiveId,
        workspaceId,
        actor,
        reason: typeof body.reason === 'string' ? body.reason : null,
      })
      return NextResponse.json({ ok: result.ok, message: result.message })
    }
    return NextResponse.json({ error: `Unknown action "${action}"; expected preview|refresh|approve|deny` }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Execution action failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export const dynamic = 'force-dynamic'
