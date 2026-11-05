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

// With an empty mission title the Create button is disabled client-side - no API
// call, no alert; the API validation-error path stays covered by the creation-fails test.
it('blocks creation when a mission title is empty', async () => {
  api.mockResolvedValueOnce({ plan })
  const onCreated = vi.fn()
  render(<ObjectivePlanner projectId={7} onCreated={onCreated} />)
  await preview()
  // Create a mission with empty title by clearing the title field
  fireEvent.change(screen.getAllByLabelText('Mission title')[0], { target: { value: '' } })
  expect(screen.getByRole('button', { name: 'Create Objective (2 missions)' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Create Objective (2 missions)' }))
  expect(api).toHaveBeenCalledTimes(1) // only the preview call
  expect(onCreated).not.toHaveBeenCalled()
})

// With an empty objective title the Preview button is disabled client-side;
// no API call can be made until an objective title exists.
it('blocks preview when the objective title is empty', async () => {
  api.mockResolvedValueOnce({ plan })
  const onCreated = vi.fn()
  render(<ObjectivePlanner projectId={7} onCreated={onCreated} />)
  fireEvent.click(screen.getByRole('button', { name: 'Preview Missions' }))
  expect(screen.getByRole('button', { name: 'Preview Missions' })).toBeDisabled()
  expect(api).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
})