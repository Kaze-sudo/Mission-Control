import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ObjectivePlanner } from '@/components/panels/objective-planner'

const api = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-client', () => ({ apiFetch: api }))
beforeEach(() => api.mockReset())
afterEach(cleanup)

const plan = { missions: [
  { key: 'm1', title: 'Build', description: 'Build feature', priority: 'high', dependsOnKeys: [], requiredCapabilities: ['build'], preferredCapabilities: [] },
  { key: 'm2', title: 'Verify', description: 'Verify feature', priority: 'medium', dependsOnKeys: ['m1'], requiredCapabilities: ['test'], preferredCapabilities: [] },
] }

async function preview() {
  fireEvent.change(screen.getByLabelText('Objective title'), { target: { value: 'Ship feature' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview Missions' }))
  await screen.findByDisplayValue('Build')
}

it('previews without creating and submits the edited mission plan only on explicit creation', async () => {
  api.mockResolvedValueOnce({ plan }).mockResolvedValueOnce({ objective: { id: 1 } })
  const onCreated = vi.fn()
  render(<ObjectivePlanner projectId={7} onCreated={onCreated} />)
  await preview()
  expect(api).toHaveBeenCalledTimes(1)
  expect(JSON.parse(api.mock.calls[0][1].body).action).toBe('preview')
  fireEvent.change(screen.getByDisplayValue('Build'), { target: { value: 'Build revised' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create Objective (2 missions)' }))
  await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
  const [url, options] = api.mock.calls[1]
  expect(url).toBe('/api/projects/7/agentos-objectives')
  const body = JSON.parse(options.body)
  expect(body.missions[0].title).toBe('Build revised')
  expect(body.missions[1].dependsOn).toEqual(['m1'])
  expect(screen.getByLabelText('Objective title')).toHaveValue('')
})

it('removes dependencies on a removed mission and preserves the draft when creation fails', async () => {
  api.mockResolvedValueOnce({ plan }).mockRejectedValueOnce(new Error('Creation refused'))
  render(<ObjectivePlanner projectId={7} onCreated={vi.fn()} />)
  await preview()
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove mission' })[0])
  fireEvent.click(screen.getByRole('button', { name: 'Create Objective (1 missions)' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Creation refused')
  expect(JSON.parse(api.mock.calls[1][1].body).missions[0].dependsOn).toEqual([])
  expect(screen.getByDisplayValue('Verify')).toBeInTheDocument()
})

it('discards the previous project draft when mounted with the new project key', async () => {
  api.mockResolvedValueOnce({ plan })
  const view = render(<ObjectivePlanner key={7} projectId={7} onCreated={vi.fn()} />)
  await preview()
  view.rerender(<ObjectivePlanner key={8} projectId={8} onCreated={vi.fn()} />)
  expect(screen.getByLabelText('Objective title')).toHaveValue('')
  expect(screen.queryByDisplayValue('Build')).not.toBeInTheDocument()
  expect(api).toHaveBeenCalledTimes(1)
})

it('shows validation errors from API when mission title is empty', async () => {
  api.mockResolvedValueOnce({ plan }).mockRejectedValueOnce(new Error('Mission title is required'))
  const onCreated = vi.fn()
  render(<ObjectivePlanner projectId={7} onCreated={onCreated} />)
  await preview()
  // Create a mission with empty title by clearing the title field
  fireEvent.change(screen.getAllByLabelText('Mission title')[0], { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create Objective (2 missions)' }))
  // Wait for error to appear
  expect(await screen.findByRole('alert')).toHaveTextContent('Mission title is required')
  // Verify onCreated was not called
  expect(onCreated).not.toHaveBeenCalled()
})

it('shows validation errors from API when objective title is empty', async () => {
  api.mockResolvedValueOnce({ plan }).mockRejectedValueOnce(new Error('Objective title is required'))
  const onCreated = vi.fn()
  render(<ObjectivePlanner projectId={7} onCreated={onCreated} />)
  // Try to create without filling title
  fireEvent.click(screen.getByRole('button', { name: 'Preview Missions' }))
  // Wait for error to appear
  expect(await screen.findByRole('alert')).toHaveTextContent('Objective title is required')
  // Verify onCreated was not called
  expect(onCreated).not.toHaveBeenCalled()
})