'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import type { ObjectiveMissionInput, ObjectivePlan } from '@/lib/objective-planning'

interface Props {
  projectId: number
  onCreated: () => void | Promise<void>
}

const fieldClass = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

// Mount with key={projectId} so a project switch cannot carry a draft into another project.
export function ObjectivePlanner({ projectId, onCreated }: Props) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [missions, setMissions] = useState<ObjectiveMissionInput[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function updateMission(index: number, patch: Partial<ObjectiveMissionInput>) {
    setMissions(current => current?.map((mission, i) => i === index ? { ...mission, ...patch } : mission) ?? null)
  }

  async function preview() {
    setBusy(true); setError(null); setNotice(null)
    try {
      const { plan } = await apiFetch<{ plan: ObjectivePlan }>(`/api/projects/${projectId}/agentos-objectives`, {
        method: 'POST', body: JSON.stringify({ action: 'preview', title, description }),
      })
      setMissions(plan.missions.map(mission => ({
        key: mission.key, title: mission.title, description: mission.description,
        priority: mission.priority, dependsOn: mission.dependsOnKeys,
        requiredCapabilities: mission.requiredCapabilities,
        preferredCapabilities: mission.preferredCapabilities,
      })))
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not preview objective') }
    finally { setBusy(false) }
  }

  async function create() {
    if (!missions?.length) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await apiFetch(`/api/projects/${projectId}/agentos-objectives`, {
        method: 'POST', body: JSON.stringify({ title, description, missions }),
      })
      setTitle(''); setDescription(''); setMissions(null)
      setNotice('Objective created. Missions are now available for routing and execution review.')
      try { await onCreated() } catch { setNotice('Objective created. Refresh the project to load its missions.') }
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create objective') }
    finally { setBusy(false) }
  }

  return <div className="space-y-3">
    <label className="block text-xs">Objective title
      <input className={fieldClass} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="What should this project accomplish?" />
    </label>
    <label className="block text-xs">Objective description
      <textarea className={`${fieldClass} min-h-20`} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} placeholder="Put independent missions on separate lines; use Then/Next/After for dependencies." />
    </label>
    {!missions && <Button size="sm" disabled={busy || !title.trim()} onClick={() => void preview()}>{busy ? 'Planning…' : 'Preview Missions'}</Button>}
    {missions && <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Review the mission plan before saving. Preview creates no tasks and starts no agents. Creating the objective makes these missions eligible for routing under project policy.</p>
      {missions.map((mission, index) => <fieldset key={mission.key} disabled={busy} className="space-y-2 rounded-lg border border-border/50 p-3">
        <legend className="px-1 text-xs">Mission {index + 1}</legend>
        <label className="block text-xs">Mission title
          <input className={fieldClass} value={mission.title} onChange={event => updateMission(index, { title: event.target.value })} />
        </label>
        <label className="block text-xs">Mission description
          <textarea className={fieldClass} value={mission.description ?? ''} onChange={event => updateMission(index, { description: event.target.value })} />
        </label>
        <label className="block text-xs">Priority
          <select className={fieldClass} value={mission.priority} onChange={event => updateMission(index, { priority: event.target.value as ObjectiveMissionInput['priority'] })}>
            {['low', 'medium', 'high', 'urgent'].map(priority => <option key={priority}>{priority}</option>)}
          </select>
        </label>
        <label className="block text-xs">Required capabilities (comma separated)
          <input className={fieldClass} defaultValue={mission.requiredCapabilities?.join(', ')} onBlur={event => updateMission(index, { requiredCapabilities: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })} />
        </label>
        {index > 0 && <div className="space-y-1"><p className="text-xs">Wait for missions</p>
          {missions.slice(0, index).map(earlier => <label key={earlier.key} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={mission.dependsOn?.includes(earlier.key!) ?? false} onChange={event => updateMission(index, {
              dependsOn: event.target.checked ? [...(mission.dependsOn ?? []), earlier.key!] : mission.dependsOn?.filter(key => key !== earlier.key),
            })} />{earlier.title}
          </label>)}
        </div>}
        <Button size="xs" variant="ghost" disabled={missions.length === 1} onClick={() => setMissions(current => current!.filter((_, i) => i !== index).map(item => ({ ...item, dependsOn: item.dependsOn?.filter(key => key !== mission.key) })))}>Remove mission</Button>
      </fieldset>)}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || missions.length >= 100} onClick={() => setMissions(current => [...current!, { key: `manual-${Date.now()}`, title: '', description: '', priority: 'medium', dependsOn: [], requiredCapabilities: [], preferredCapabilities: [] }])}>Add mission</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMissions(null)}>Back to description</Button>
        <Button size="sm" disabled={busy || !title.trim() || missions.some(mission => !mission.title.trim())} onClick={() => void create()}>{busy ? 'Creating…' : `Create Objective (${missions.length} missions)`}</Button>
      </div>
    </div>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {notice && <p role="status" className="text-xs text-emerald-400">{notice}</p>}
  </div>
}
