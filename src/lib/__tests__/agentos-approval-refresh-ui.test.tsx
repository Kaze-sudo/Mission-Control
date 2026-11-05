import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentOSApprovalsPanel } from '@/components/panels/agentos-approvals-panel'

const api = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-client', () => ({ apiFetch: api, ApiError: class extends Error {} }))
vi.mock('@/lib/use-smart-poll', () => ({ useSmartPoll: (load: () => void) => useEffect(() => { load() }, [load]) }))
vi.mock('@/lib/use-run-events', () => ({ useRunEventPulse: () => {} }))
afterEach(cleanup)

it('regenerates a rejected cached preview and requires a new click with the new fingerprint', async () => {
  let fingerprint = 'old-fingerprint'
  const approvals: string[] = []
  api.mockImplementation(async (url: string, options?: { body: string }) => {
    if (url.startsWith('/api/agentos/approvals')) return { items: [{ objectiveId: 1, projectId: 2,
      objectiveTitle: 'Review this plan', fingerprint, approvalStatus: 'NONE',
      missionCounts: { total: 1, free: 0, paid: 1, unknownCost: 0, blocked: 0, requiresApproval: 1 },
      estimatedTotalCost: null, maximumTotalExposure: null, approvalRequiredMissions: [], createdAt: null }],
      summary: { total: 1, byStatus: { NONE: 1 } } }
    const body = JSON.parse(options!.body)
    if (body.action === 'refresh') { fingerprint = 'new-fingerprint'; return { ok: true } }
    approvals.push(body.fingerprint)
    if (body.fingerprint === 'old-fingerprint') throw new Error('Plan changed — re-approval required')
    return { ok: true }
  })
  render(<AgentOSApprovalsPanel />)
  fireEvent.click(await screen.findByRole('button', { name: 'Approve plan' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve plan' })).toBeEnabled())
  expect(await screen.findByText('Plan changed — re-approval required')).toBeInTheDocument()
  expect(approvals).toEqual(['old-fingerprint'])
  fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
  await waitFor(() => expect(approvals).toEqual(['old-fingerprint', 'new-fingerprint']))
})
