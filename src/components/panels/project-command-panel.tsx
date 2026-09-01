'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'

interface Project { id: number; name: string; slug: string }
interface CommandRecord {
  projectId: number; state: 'draft'|'ready'|'active'|'paused'|'blocked'
  policy: { autoRoute: boolean; allowReroute: boolean; fallbackBehavior: 'hold'|'manual'|'best_available'; allowedPlatoons: string[]; maxProjectConcurrent: number; maxPlatoonConcurrent: number; maxAgentConcurrent: number }
  readiness: { required: number; ready: number; percent: number; status: string }
  activationBlockers: string[]; activatedAt: number|null
}
interface Binding { id:number; externalAgentId:string; agentName:string; platoonId:string; role:string; availability:string }
interface Task { id:number; title:string; status:string; priority:string; assigned_to:string|null; metadata?:Record<string,unknown>; ticket_ref?:string }
interface Handoff { id:number; fromTaskId:number; toTaskId:number|null; toExternalAgentId:string|null; toPlatoonId:string|null; requestedCapabilities:string[]; instructions:string|null; status:string; createdAt:number }
interface ForcePlan { readiness:{required:number;ready:number;percent:number;status:string}; missingCapabilities:string[]; blockedCapabilities:string[]; coverage:Array<{capability:string;covered:boolean;ready:boolean}> }
interface ObjectiveMission { key:string; title:string; taskId:number; dependsOnTaskIds:number[]; requiredCapabilities:string[]; preferredCapabilities:string[] }
interface Objective { id:number; title:string; description:string; status:string; created_at:number; plan?:{ source?:string; missions?:ObjectiveMission[] } }
interface Delegation { id:string; taskId:number; objectiveId:number|null; platoonId:string|null; specialistName:string|null; routingAgentName:string|null; runtimeType:string|null; status:string; nativeSessionId:string|null; nativeRunId:string|null; attempt:number; resultSummary:string|null; errorMessage:string|null; createdAt:number; updatedAt:number; completedAt:number|null }

const STATES: CommandRecord['state'][] = ['draft','ready','active','paused','blocked']

export function ProjectCommandPanel() {
  const [projects,setProjects]=useState<Project[]>([])
  const [projectId,setProjectId]=useState<number|null>(null)
  const [command,setCommand]=useState<CommandRecord|null>(null)
  const [bindings,setBindings]=useState<Binding[]>([])
  const [tasks,setTasks]=useState<Task[]>([])
  const [handoffs,setHandoffs]=useState<Handoff[]>([])
  const [force,setForce]=useState<ForcePlan|null>(null)
  const [objectives,setObjectives]=useState<Objective[]>([])
  const [delegations,setDelegations]=useState<Delegation[]>([])
  const [objectiveTitle,setObjectiveTitle]=useState('')
  const [objectiveDescription,setObjectiveDescription]=useState('')
  const [objectiveBusy,setObjectiveBusy]=useState(false)
  const [objectiveExecutingId,setObjectiveExecutingId]=useState<number|null>(null)
  const [handoffFrom,setHandoffFrom]=useState('')
  const [handoffCaps,setHandoffCaps]=useState('')
  const [handoffInstructions,setHandoffInstructions]=useState('')
  const [handoffBusy,setHandoffBusy]=useState(false)
  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState<string|null>(null)
  const loadProjects=useCallback(async()=>{
    const data=await apiFetch<{projects?:Project[]}>('/api/projects')
    const next=data.projects||[]; setProjects(next); setProjectId(current=>current??next[0]?.id??null)
  },[])

  const loadContext=useCallback(async(id:number|null)=>{
    if(!id){setCommand(null);setBindings([]);setTasks([]);setHandoffs([]);setForce(null);setObjectives([]);setDelegations([]);return}
    setLoading(true);setError(null)
    try{
      const [c,b,t,h,f,o,d]=await Promise.all([
        apiFetch<{command:CommandRecord}>(`/api/projects/${id}/agentos-command`),
        apiFetch<{bindings?:Binding[]}>(`/api/projects/${id}/external-agents`),
        apiFetch<{tasks?:Task[]}>(`/api/tasks?project_id=${id}&limit=200`),
        apiFetch<{handoffs?:Handoff[]}>(`/api/projects/${id}/agentos-handoffs`),
        apiFetch<ForcePlan>(`/api/projects/${id}/agentos-force-plan`),
        apiFetch<{objectives?:Objective[]}>(`/api/projects/${id}/agentos-objectives`),
        apiFetch<{delegations?:Delegation[]}>(`/api/projects/${id}/agentos-delegations`),
      ])
      setCommand(c.command);setBindings(b.bindings||[]);setTasks(t.tasks||[]);setHandoffs(h.handoffs||[]);setForce(f);setObjectives(o.objectives||[]);setDelegations(d.delegations||[])
    }catch(err){setError(err instanceof Error?err.message:'Failed to load project command view')}
    finally{setLoading(false)}
  },[])

  useEffect(()=>{void loadProjects()},[loadProjects])
  useEffect(()=>{void loadContext(projectId)},[loadContext,projectId])

  const updateCommand=useCallback(async(patch:Record<string,unknown>)=>{
    if(!projectId)return;setSaving(true);setError(null)
    try{
      const result=await apiFetch<{command:CommandRecord}>(`/api/projects/${projectId}/agentos-command`,{method:'PUT',body:JSON.stringify(patch)})
      setCommand(result.command);await loadContext(projectId)
    }catch(err){setError(err instanceof Error?err.message:'Failed to update project command state')}
    finally{setSaving(false)}
  },[loadContext,projectId])

  const createObjective=useCallback(async()=>{
    if(!projectId||!objectiveTitle.trim())return
    setObjectiveBusy(true);setError(null)
    try{
      await apiFetch(`/api/projects/${projectId}/agentos-objectives`,{method:'POST',body:JSON.stringify({title:objectiveTitle.trim(),description:objectiveDescription.trim()})})
      setObjectiveTitle('');setObjectiveDescription('');await loadContext(projectId)
    }catch(err){setError(err instanceof Error?err.message:'Failed to create objective')}
    finally{setObjectiveBusy(false)}
  },[loadContext,objectiveDescription,objectiveTitle,projectId])

  const executeObjectiveAction=useCallback(async(objectiveId:number)=>{
    if(!projectId)return
    setObjectiveExecutingId(objectiveId);setError(null)
    try{
      const result=await apiFetch<{executed?:boolean;held?:boolean;reason?:string}>(`/api/projects/${projectId}/agentos-objectives`,{method:'PATCH',body:JSON.stringify({objectiveId,action:'execute'})})
      if(result.held&&result.reason)setError(result.reason)
      await loadContext(projectId)
    }catch(err){setError(err instanceof Error?err.message:'Failed to execute objective')}
    finally{setObjectiveExecutingId(null)}
  },[loadContext,projectId])

  const createProjectHandoff=useCallback(async()=>{
    if(!projectId||!handoffFrom)return
    setHandoffBusy(true);setError(null)
    try{
      const caps=handoffCaps.split(',').map(x=>x.trim()).filter(Boolean)
      await apiFetch(`/api/projects/${projectId}/agentos-handoffs`,{method:'POST',body:JSON.stringify({fromTaskId:Number(handoffFrom),requestedCapabilities:caps,instructions:handoffInstructions||null})})
      setHandoffCaps('');setHandoffInstructions('');await loadContext(projectId)
    }catch(err){setError(err instanceof Error?err.message:'Failed to create handoff')}
    finally{setHandoffBusy(false)}
  },[handoffCaps,handoffFrom,handoffInstructions,loadContext,projectId])

  const updateHandoff=useCallback(async(handoffId:number,action:'accept'|'cancel')=>{
    if(!projectId)return
    setHandoffBusy(true);setError(null)
    try{await apiFetch(`/api/projects/${projectId}/agentos-handoffs`,{method:'PATCH',body:JSON.stringify({handoffId,action})});await loadContext(projectId)}
    catch(err){setError(err instanceof Error?err.message:'Failed to update handoff')}
    finally{setHandoffBusy(false)}
  },[loadContext,projectId])
  const counts={
    active:tasks.filter(t=>t.status==='in_progress').length,
    queued:tasks.filter(t=>t.status==='assigned'||t.status==='awaiting_owner').length,
    blocked:tasks.filter(t=>t.status==='failed'||t.status==='awaiting_owner').length,
    done:tasks.filter(t=>t.status==='done').length,
  }
  const selectedProject=projects.find(p=>p.id===projectId)

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-primary">AgentOS Company Commander</p>
          <h1 className="text-2xl font-semibold mt-1">Project Command</h1>
          <p className="text-sm text-muted-foreground mt-1">Activate projects, control routing policy, watch force readiness, missions, handoffs, and concurrency from one screen.</p>
        </div>
        <label className="text-xs text-muted-foreground min-w-64">Project
          <select className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" value={projectId??''} onChange={e=>setProjectId(e.target.value?Number(e.target.value):null)}>
            {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      {error&&<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
      {loading&&<div className="text-sm text-muted-foreground">Loading command picture…</div>}
      {!loading&&command&&(
        <>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Command State" value={command.state.toUpperCase()} note={selectedProject?.name||''}/>
            <MetricCard label="Force Readiness" value={`${command.readiness.percent}%`} note={`${command.readiness.ready}/${command.readiness.required} required capabilities ready`}/>
            <MetricCard label="Active Missions" value={String(counts.active)} note={`${counts.queued} queued/held`}/>
            <MetricCard label="Team" value={String(bindings.length)} note={`${new Set(bindings.map(b=>b.platoonId)).size} platoons represented`}/>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div><p className="text-xs font-mono uppercase tracking-wider text-primary">Activation</p><h2 className="text-lg font-semibold mt-1">Project command state</h2></div>
              <div className="flex flex-wrap gap-2">
                {STATES.map(state=><Button key={state} size="sm" variant={command.state===state?'default':'outline'} disabled={saving} onClick={()=>void updateCommand({state})}>{state}</Button>)}
              </div>
            </div>
            {command.activationBlockers.length>0&&<div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300"><div className="font-medium mb-1">Activation blockers</div>{command.activationBlockers.map(x=><div key={x}>• {x}</div>)}</div>}
            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <label className="text-xs text-muted-foreground">Project max<input type="number" min={1} max={50} value={command.policy.maxProjectConcurrent} onChange={e=>setCommand({...command,policy:{...command.policy,maxProjectConcurrent:Number(e.target.value)}})} className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5"/></label>
              <label className="text-xs text-muted-foreground">Platoon max<input type="number" min={1} max={20} value={command.policy.maxPlatoonConcurrent} onChange={e=>setCommand({...command,policy:{...command.policy,maxPlatoonConcurrent:Number(e.target.value)}})} className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5"/></label>
              <label className="text-xs text-muted-foreground">Agent max<input type="number" min={1} max={10} value={command.policy.maxAgentConcurrent} onChange={e=>setCommand({...command,policy:{...command.policy,maxAgentConcurrent:Number(e.target.value)}})} className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5"/></label>
              <label className="text-xs text-muted-foreground md:col-span-2">Allowed platoons<input value={command.policy.allowedPlatoons.join(', ')} onChange={e=>setCommand({...command,policy:{...command.policy,allowedPlatoons:e.target.value.split(',').map(x=>x.trim()).filter(Boolean)}})} className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5" placeholder="blank = all bound platoons"/></label>
              <label className="text-xs text-muted-foreground">Fallback<select value={command.policy.fallbackBehavior} onChange={e=>setCommand({...command,policy:{...command.policy,fallbackBehavior:e.target.value as CommandRecord['policy']['fallbackBehavior']}})} className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5"><option value="hold">Hold</option><option value="manual">Manual</option><option value="best_available">Best available</option></select></label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={command.policy.autoRoute} onChange={e=>setCommand({...command,policy:{...command.policy,autoRoute:e.target.checked}})}/>Auto-route</label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={command.policy.allowReroute} onChange={e=>setCommand({...command,policy:{...command.policy,allowReroute:e.target.checked}})}/>Allow reroute</label>
            </div>
            <div className="flex justify-end"><Button size="sm" disabled={saving} onClick={()=>void updateCommand(command.policy)}>{saving?'Saving…':'Save Routing Policy'}</Button></div>
          </section>
          <section className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between"><div><p className="text-xs font-mono uppercase tracking-wider text-primary">Force</p><h2 className="text-lg font-semibold mt-1">Active team</h2></div><span className="text-xs text-muted-foreground">{force?.readiness.status||'unknown'}</span></div>
              <div className="mt-3 space-y-2">
                {bindings.length===0?<div className="text-sm text-muted-foreground">No project agents bound.</div>:bindings.map(b=><div key={b.id} className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-2"><div><div className="text-sm font-medium">{b.agentName}</div><div className="text-[10px] text-muted-foreground">{b.platoonId} · {b.role}</div></div><span className="text-[10px] uppercase">{b.availability}</span></div>)}
              </div>
              {force&&(force.missingCapabilities.length>0||force.blockedCapabilities.length>0)&&<div className="mt-3 text-xs text-muted-foreground">{force.missingCapabilities.length>0&&<div>Gaps: {force.missingCapabilities.join(', ')}</div>}{force.blockedCapabilities.length>0&&<div>Blocked: {force.blockedCapabilities.join(', ')}</div>}</div>}
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <div><p className="text-xs font-mono uppercase tracking-wider text-primary">Operations</p><h2 className="text-lg font-semibold mt-1">Mission status</h2></div>
              <div className="grid grid-cols-2 gap-2 mt-3"><MiniMetric label="In progress" value={counts.active}/><MiniMetric label="Queued / held" value={counts.queued}/><MiniMetric label="Done" value={counts.done}/><MiniMetric label="Needs attention" value={counts.blocked}/></div>
              <div className="mt-3 max-h-72 overflow-auto space-y-2">
                {tasks.slice(0,20).map(t=><div key={t.id} className="rounded-lg border border-border/50 px-3 py-2"><div className="flex justify-between gap-2"><span className="text-sm font-medium">{t.ticket_ref?`${t.ticket_ref} `:''}{t.title}</span><span className="text-[10px] uppercase text-muted-foreground">{t.status}</span></div><div className="text-[10px] text-muted-foreground mt-1">{t.assigned_to||'Unassigned'} · {t.priority}</div></div>)}
                {tasks.length===0&&<div className="text-sm text-muted-foreground">No project tasks yet.</div>}
              </div>
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div><p className="text-xs font-mono uppercase tracking-wider text-primary">Objectives</p><h2 className="text-lg font-semibold mt-1">Company objectives</h2></div>
                <span className="text-xs text-muted-foreground">{objectives.length} recorded</span>
              </div>
              <div className="grid gap-2">
                <input value={objectiveTitle} onChange={e=>setObjectiveTitle(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Objective title"/>
                <textarea value={objectiveDescription} onChange={e=>setObjectiveDescription(e.target.value)} className="min-h-20 rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Describe the objective. Put independent missions on separate lines; use Then/Next/After for dependencies."/>
                <div className="flex justify-end"><Button size="sm" disabled={objectiveBusy||!objectiveTitle.trim()} onClick={()=>void createObjective()}>{objectiveBusy?'Planning…':'Plan Objective'}</Button></div>
              </div>
              <div className="max-h-96 overflow-auto space-y-3">
                {objectives.map(o=><div key={o.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                  <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-medium">{o.title}</div><div className="text-[10px] text-muted-foreground mt-1">Objective #{o.id} · {o.plan?.source||'planned'}</div></div><div className="flex items-center gap-2"><span className="text-[10px] uppercase">{o.status}</span>{!['completed','cancelled'].includes(o.status)&&<Button size="sm" variant="outline" disabled={objectiveExecutingId===o.id} onClick={()=>void executeObjectiveAction(o.id)}>{objectiveExecutingId===o.id?'Executing…':o.status==='active'?'Re-route':'Assemble & Execute'}</Button>}</div></div>
                  {o.description&&<div className="text-xs text-foreground/75 mt-2">{o.description}</div>}
                  <div className="mt-3 space-y-2">
                    {(o.plan?.missions||[]).map(m=><div key={m.taskId} className="rounded border border-border/40 px-2.5 py-2">
                      <div className="flex justify-between gap-2"><span className="text-xs font-medium">{m.key}: {m.title}</span><span className="text-[10px] text-muted-foreground">Task {m.taskId}</span></div>
                      <div className="text-[10px] text-muted-foreground mt-1">{m.dependsOnTaskIds.length ? 'Depends on '+m.dependsOnTaskIds.map(id=>'Task '+id).join(', ') : 'Parallel-ready'}{m.requiredCapabilities.length ? ' · '+m.requiredCapabilities.join(', ') : ''}</div>
                    </div>)}
                  </div>
                </div>)}
                {objectives.length===0&&<div className="text-sm text-muted-foreground">No AgentOS objectives planned yet.</div>}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div><p className="text-xs font-mono uppercase tracking-wider text-primary">Delegations</p><h2 className="text-lg font-semibold mt-1">Platoon execution ledger</h2></div>
                <span className="text-xs text-muted-foreground">{delegations.length} traced</span>
              </div>
              <div className="max-h-[32rem] overflow-auto space-y-2">
                {delegations.map(d=><div key={d.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                  <div className="flex justify-between gap-2"><span className="text-sm font-medium">Task {d.taskId} · {d.specialistName||d.routingAgentName||'Specialist'}</span><span className="text-[10px] uppercase">{d.status}</span></div>
                  <div className="text-[10px] text-muted-foreground mt-1">{d.platoonId||d.runtimeType||'runtime'} · attempt {d.attempt}{d.objectiveId ? ' · objective '+d.objectiveId : ''}</div>
                  <div className="mt-2 grid gap-1 text-[10px] font-mono text-muted-foreground">
                    <div>AgentOS: {d.id}</div>
                    {d.nativeSessionId&&<div>Session: {d.nativeSessionId}</div>}
                    {d.nativeRunId&&<div>Run: {d.nativeRunId}</div>}
                  </div>
                  {d.errorMessage&&<div className="mt-2 text-xs text-destructive">{d.errorMessage}</div>}
                  {d.resultSummary&&<div className="mt-2 text-xs text-foreground/75 line-clamp-3">{d.resultSummary}</div>}
                </div>)}
                {delegations.length===0&&<div className="text-sm text-muted-foreground">No AgentOS delegations dispatched yet.</div>}
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 space-y-4">
            <div className="flex items-center justify-between"><div><p className="text-xs font-mono uppercase tracking-wider text-primary">Transfers</p><h2 className="text-lg font-semibold mt-1">Handoff chain</h2></div><span className="text-xs text-muted-foreground">{handoffs.length} recorded</span></div>
            <div className="grid gap-2 md:grid-cols-3">
              <select value={handoffFrom} onChange={e=>setHandoffFrom(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm"><option value="">Source task…</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.ticket_ref?`${t.ticket_ref} `:''}{t.title}</option>)}</select>
              <input value={handoffCaps} onChange={e=>setHandoffCaps(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Required next capabilities"/>
              <input value={handoffInstructions} onChange={e=>setHandoffInstructions(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" placeholder="Handoff instructions"/>
            </div>
            <div className="flex justify-end"><Button size="sm" disabled={handoffBusy||!handoffFrom} onClick={()=>void createProjectHandoff()}>{handoffBusy?'Working…':'Create Handoff'}</Button></div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {handoffs.map(h=><div key={h.id} className="rounded-lg border border-border/50 bg-background/40 p-3"><div className="flex justify-between"><span className="text-xs font-medium">Task {h.fromTaskId} → {h.toTaskId?`Task ${h.toTaskId}`:'pending'}</span><span className="text-[10px] uppercase">{h.status}</span></div><div className="text-[10px] text-muted-foreground mt-1">{h.toPlatoonId||'best platoon'}{h.requestedCapabilities.length?` · ${h.requestedCapabilities.join(', ')}`:''}</div>{h.instructions&&<div className="text-xs mt-2 text-foreground/80">{h.instructions}</div>}{h.status==='pending'&&<div className="flex gap-2 mt-3"><Button size="sm" onClick={()=>void updateHandoff(h.id,'accept')} disabled={handoffBusy}>Accept</Button><Button size="sm" variant="outline" onClick={()=>void updateHandoff(h.id,'cancel')} disabled={handoffBusy}>Cancel</Button></div>}</div>)}
              {handoffs.length===0&&<div className="text-sm text-muted-foreground">No handoffs recorded yet.</div>}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function MetricCard({label,value,note}:{label:string;value:string;note:string}){return <div className="rounded-xl border border-border bg-card p-4"><div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div><div className="text-2xl font-semibold mt-1">{value}</div><div className="text-xs text-muted-foreground mt-1">{note}</div></div>}
function MiniMetric({label,value}:{label:string;value:number}){return <div className="rounded-lg bg-secondary/40 p-3"><div className="text-xl font-semibold">{value}</div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div></div>}
