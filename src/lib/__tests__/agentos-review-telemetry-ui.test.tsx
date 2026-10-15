import { useEffect } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentOSReviewsPanel } from '@/components/panels/agentos-reviews-panel'

const api = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-client', () => ({ apiFetch: api, ApiError: class extends Error {} }))
vi.mock('@/store', () => ({ useMissionControl: () => ({ currentUser: { username: 'operator' } }) }))
vi.mock('@/lib/use-smart-poll', () => ({ useSmartPoll: (load: () => void) => useEffect(() => { load() }, [load]) }))
vi.mock('@/lib/use-run-events', () => ({ useRunEventPulse: () => {} }))
afterEach(cleanup)

function show(telemetry: Record<string, unknown>) {
  api.mockResolvedValue({ items: [{ taskId: 1, taskTitle: 'Review example', taskStatus: 'review', projectId: null,
    projectName: null, objectiveId: null, objectiveTitle: null, review: null, delegation: null,
    createdAt: null, updatedAt: null, telemetry: { source: 'execution_ledger', actualCost: null, currency: 'USD',
      inputTokens: null, outputTokens: null, costDelta: null, isPartial: false, completeness: 'unknown',
      mixedCurrencies: false, scope: 'task_aggregate', ...telemetry } }] })
  render(<AgentOSReviewsPanel />)
}

it('renders a small recorded charge without displaying zero and preserves missing output tokens', async () => {
  show({ actualCost: 0.000123, inputTokens: 100 })
  expect(await screen.findByText(/0\.000123 USD/)).toBeInTheDocument()
  expect(screen.getByText(/100 in \/ Not recorded out tokens/)).toBeInTheDocument()
  expect(screen.getByText('Coverage not confirmed')).toBeInTheDocument()
})

it('shows output-only telemetry without inventing input tokens', async () => {
  show({ outputTokens: 25 })
  expect(await screen.findByText(/Not recorded in \/ 25 out tokens/)).toBeInTheDocument()
})

it('explains mixed currencies instead of labelling the recorded amounts absent', async () => {
  show({ currency: null, mixedCurrencies: true })
  expect(await screen.findByText('Mixed currencies — no combined total')).toBeInTheDocument()
})
