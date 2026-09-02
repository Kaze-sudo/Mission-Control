'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'

interface Project { id: number; name: string; slug: string }
interface CommandRecord {
  projectId: number; state: 'draft'|'ready'|'active'|'paused'|'blocked'
  policy: { autoRoute: boolean; allowReroute: boolean; fallbackBehavior: 'hold'|'manual'|'best_available'; allowedPlatoons: string[]; maxProjectConcurrent: number; maxPlatoonConcurrent: number; maxAgentConcurrent: number; allowFreeLocalWithoutApproval?: boolean; allowFreeRemoteWithoutApproval?: boolean; allowPaidWithoutApproval?: boolean; maxApprovedEstimatedCost?: number|null; approvedProviders?: string[]; blockedProviders?: string[] }
  readiness: { required: number; ready: number; percent: number; status: string }
  activationBlockers: string[]; activatedAt: number|null
}
interface Binding { id:number; externalAgentId:string; agentName:string; platoonId:string; role:string; availability:string }
interface Task { id:number; title:string; status:string; priority:string; assigned_to:string|null; metadata?:Record<string,unknown>; ticket_ref?:string }
interface Handoff { id:number; fromTaskId:number; toTaskId:number|null; toExternalAgentId:string|null; toPlatoonId:string|null; requestedCapabilities:string[]; instructions:string|null; status:string; createdAt:number }
interface ForcePlan { readiness:{required:number;ready:number;percent:number;status:string}; missingCapabilities:string[]; blockedCapabilities:string[]; coverage:Array<{capability:string;covered:boolean;ready:boolean}>; resourceRecommendations?:Array<{id:string;name:string;path:string;type:string;score:number;primaryCapability:string;capabilities:string[]}> }
interface ObjectiveMission { key:string; title:string; taskId:number; dependsOnTaskIds:number[]; requiredCapabilities:string[]; preferredCapabilities:string[] }
interface Objective { id:number; title:string; description:string; status:string; created_at:number; plan?:{ source?:string; missions?:ObjectiveMission[] } }
interface Delegation { id:string; taskId:number; objectiveId:number|null; platoonId:string|null; specialistName:string|null; routingAgentName:string|null; runtimeType:string|null; status:string; nativeSessionId:string|null; nativeRunId:string|null; attempt:number; resultSummary:string|null; errorMessage:string|null; createdAt:number; updatedAt:number; completedAt:number|null }
interface ArsenalResource { id:string; name:string; path:string; type:string; score:number; primaryCapability:string; capabilities:string[]; auditStatus?:string; status?:string; manualOnly?:boolean; autoSelectAllowed?:boolean; preferredPlatoon?:string|null; preferredSpecialistRole?:string|null; moveRisk?:string|null; pathSensitive?:boolean; supersededBy?:string[]; usage?:string|null }
interface ArsenalCoverageEntry { resourceId:string; name:string; score:number|null; status:string; autoSelectAllowed:boolean; manualOnly:boolean; usage:string|null; note:string|null; preferredPlatoon:string|null; preferredSpecialistRole:string|null }
interface ArsenalCoverage { capability:string; status:'FILLED'|'PARTIALLY_COVERED'|'OPEN'; preferred:ArsenalCoverageEntry[]; secondary:ArsenalCoverageEntry[]; reference:ArsenalCoverageEntry[]; notProviders:string[]; note:string|null }
interface ArsenalChangeState { scanId:string; scanTime:string; baselineVersion:string; unchanged:string[]; changed:string[]; new:string[]; missing:string[]; duplicateCandidates:string[]; supersessionCandidates:string[]; promoted:string[]; gapNote:string }
interface ArsenalEscalation { state:string; category:string|null; reason:string; summary:string|null; recommended_actions:string[]; attempts:number|null; task_id:number|null; objective_id:number|null; delegation_id:string|null; resource_id:string|null; created_at:string|null; resolved_at:string|null }
interface ArsenalDeepReview { requiredCapability:string; status:string; requestedAt:string; requestedBy:string|null; reviewer:string|null; taskId:number|null; projectId:number|null; objectiveId:number|null; fingerprint:string|null; retries:number; invalidAttempts:number; escalatedReason:string|null; escalatedAt:string|null; escalation:ArsenalEscalation|null; error:string|null; routing:{externalAgentId?:string;agentName?:string;platoonId?:string;routingAgentName?:string}|null; result:unknown; proposal:Record<string,unknown>|null; reviewCompletedAt:string|null }
interface ArsenalReviewItem { reviewId:string; detectedState:string; path:string; probableName:string; probableSourceRepo:string|null; probableResourceType:string|null; detectedCapabilities:string[]; inferredPrimaryCapability:string|null; coversCapabilityGaps:string[]; likelyOverlaps:string[]; runtimePathRisks:string[]; preliminaryQualityScore:number|null; preliminaryAgentosRelevance:string|null; suggestedPlatoon:string|null; suggestedSpecialistRole:string|null; recommendedAction:string|null; reviewStatus:string; pending:boolean; promotionBatchId:string|null; finalApprovedDecision:string|null; deepReview?:ArsenalDeepReview }
interface ArsenalReviewMissionTrace {
  taskId:number; reviewId:string; title:string; status:string; assignedTo:string|null; projectId:number|null; objectiveId:number|null; createdAt:number; updatedAt:number; reviewState:string|null; fingerprint:string|null
  escalation: { reason:string|null; category:string|null; attempts:number|null; summary:string|null; recommendedActions:string[] } | null
  delegation: { id:string|null; status:string|null; nativeSessionId:string|null; nativeRunId:string|null; attempt:number|null; runtimeType:string|null; platoonId:string|null; specialistName:string|null; errorMessage:string|null } | null
}
interface ArsenalPromotion { promotionBatchId:string; approvedAt:string; approvedResources:string[]; previousState:Record<string,unknown>|null; newState:Record<string,unknown>|null; capabilitiesAdded:string[]; overlapChanges:string[]; warnings:string[]; reviewerDecision:string|null }
interface ArsenalKnowledgeMission {
  taskId:number; packId:string; missionKey:string; file:string; schema:string; title:string; status:string; assignedTo:string|null; projectId:number|null; objectiveId:number|null; dependsOnKeys:string[]; createdAt:number; updatedAt:number; state:string|null; stagedPath:string|null; invalidAttempts:number
  escalation: { reason:string|null; category:string|null; attempts:number|null; summary:string|null; recommendedActions:string[] } | null
  delegation: { id:string|null; status:string|null; nativeSessionId:string|null; nativeRunId:string|null; attempt:number|null; runtimeType:string|null; platoonId:string|null; specialistName:string|null; errorMessage:string|null } | null
  resultSummary: { title:string|null; capabilities:string[]|null; source_claims:Array<{resource_id:string;accessed:boolean;usage?:string;notes?:string}>|null; limitations:string[]|null } | null
}interface ArsenalKnowledgeState {
  objective: { id: number; projectId: number; title: string; status: string; plan:Record<string,unknown>|null } | null
  missions: ArsenalKnowledgeMission[]
}
type ExecCostClass = 'FREE_LOCAL'|'FREE_REMOTE'|'PAID_KNOWN'|'PAID_ESTIMATED'|'UNKNOWN_COST'|'MANUAL_EXTERNAL'|'BLOCKED'
interface ExecPlanMission { taskId:number; missionKey:string; title:string; status:string; assignedTo:string|null; platoon:string|null; specialist:string|null; runtimeType:string|null; provider:string|null; model:string|null; costClass:ExecCostClass; estimatedCost:number|null; costBasis:string; requiresApproval:boolean; dependencies:string[]; resources:Array<{resourceId:string;name:string;manualOnly?:boolean}>; runtimeAccess:string; warnings:string[] }
interface ExecPlan { planId:string; objectiveId:number; projectId:number; workspaceId:number; createdAt:string; status:string; missions:ExecPlanMission[]; summary:{ freeMissions:number; paidMissions:number; unknownCostMissions:number; blockedMissions:number; approvalRequired:boolean; waves:string[][] }; fingerprint:string }
interface ExecApproval { id:number; approvalId:string; objectiveId:number; projectId:number; workspaceId:number; approvedBy:string; approvedAt:number; approvedTaskIds:number[]; excludedTaskIds:number[]; fingerprint:string; maxAuthorizedAmount:number|null; expiresAt:number|null; createdAt:number }
interface ArsenalState {
  registry: { resources: ArsenalResource[]; overlapGroups: Array<{capability:string;preferredId:string;candidateIds:string[]}>; summary:{ total:number; keep:number } } | null
  capabilityCoverage: ArsenalCoverage[]
  changes: ArsenalChangeState | null
  reviewQueue: ArsenalReviewItem[]
  promotionHistory: ArsenalPromotion[]
  knowledgePackBacklog: Array<{ id:string; name:string; status:string }>
  missions?: ArsenalReviewMissionTrace[]
  knowledge?: ArsenalKnowledgeState | null
  summary?: { resources:number; capabilities:number; filled:number; partiallyCovered:number; open:number; pendingReviews:number; needsManual:number }
}
type ArsenalTab = 'recommendations'|'registry'|'coverage'|'changes'|'reviews'|'history'|'overlaps'|'risks'|'backlog'|'curation'

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
  const [resourceBusy,setResourceBusy]=useState(false)
  const [arsenal,setArsenal]=useState<ArsenalState|null>(null)
  const [arsenalTab,setArsenalTab]=useState<ArsenalTab>('recommendations')
  const [actionBusy,setActionBusy]=useState(false)
  const [actionError,setActionError]=useState<string|null>(null)
  const [actionMessage,setActionMessage]=useState<string|null>(null)
  const [pendingAction,setPendingAction]=useState<{resourceId:string;action:string}|null>(null)
  const [deepReviewBusy,setDeepReviewBusy]=useState(false)
  const [curationBusy,setCurationBusy]=useState(false)
  const [execObjectiveId,setExecObjectiveId]=useState<number|null>(null)
  const [execPlan,setExecPlan]=useState<ExecPlan|null>(null)
  const [execApproval,setExecApproval]=useState<ExecApproval|null>(null)
  const [execApprovalStatus,setExecApprovalStatus]=useState<'NONE'|'VALID'|'STALE'|'EXPIRED'>('NONE')
  const [execSelected,setExecSelected]=useState<Set<number>>(new Set())
  const [execBusy,setExecBusy]=useState(false)
  const arsenalNeedsManual=arsenal?.summary?.needsManual||0
  const curationNeedsManual=arsenal?.knowledge?.missions?.some(m=>m.escalation||m.state==='NEEDS_MANUAL')||false
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

  const loadArsenal=useCallback(async()=>{
    try{
      const [data,missions]=await Promise.all([
        apiFetch<ArsenalState>('/api/agentos/resources'),
        apiFetch<{missions?:ArsenalReviewMissionTrace[]}>('/api/agentos/resources/deep-review'),
      ])
      setArsenal({registry:data.registry,capabilityCoverage:data.capabilityCoverage||[],changes:data.changes||null,reviewQueue:data.reviewQueue||[],promotionHistory:data.promotionHistory||[],knowledgePackBacklog:data.knowledgePackBacklog||[],missions:missions.missions||[],summary:data.summary})
    }catch{/* Arsenal companion view is non-fatal */}
    try{
      const knowledge=await apiFetch<{state?:ArsenalKnowledgeState}>(`/api/agentos/resources/knowledge`)
      setArsenal(prev=>prev?{...prev,knowledge:knowledge.state||null}:prev)
    }catch{/* Knowledge curation view is non-fatal */}
  },[])
  useEffect(()=>{void loadArsenal()},[loadArsenal])

  const rescanAiVault=useCallback(async()=>{
    if(!projectId)return
    setResourceBusy(true);setError(null)
    try{
      await apiFetch('/api/agentos/resources',{method:'POST'})
      await loadContext(projectId);await loadArsenal()
    }catch(err){setError(err instanceof Error?err.message:'Failed to rescan AI vault')}
    finally{setResourceBusy(false)}
  },[loadArsenal,loadContext,projectId])

  const submitArsenalAction=useCallback(async(payload:{action:string;resourceId:string;reason?:string;reviewer?:string;promotion?:Record<string,unknown>})=>{
    setActionBusy(true);setActionError(null);setActionMessage(null)
    try{
      const response=await apiFetch<{ok?:boolean;result?:{message?:string};error?:string}>(`/api/agentos/resources/actions`,{method:'POST',body:JSON.stringify(payload)})
      if(response.ok){setActionMessage(response.result?.message||'Arsenal action applied');setPendingAction(null);await loadArsenal()}
      else setActionError(response.error||'Arsenal action failed')
    }catch(err){setActionError(err instanceof Error?err.message:'Arsenal action failed')}
    finally{setActionBusy(false)}
  },[loadArsenal])

  const loadExecutionPreview=useCallback(async(objectiveId:number,notify=true)=>{
    if(!projectId)return
    setExecBusy(true);setActionError(null)
    try{
      const data=await apiFetch<{ok?:boolean;plan?:ExecPlan;approval?:ExecApproval|null;approvalStatus?:'NONE'|'VALID'|'STALE'|'EXPIRED';rowStatus?:string|null;error?:string}>(`/api/projects/${projectId}/agentos-execution?objective_id=${objectiveId}`)
      if(data.ok&&data.plan){
        setExecObjectiveId(objectiveId);setExecPlan(data.plan);setExecApproval(data.approval||null);setExecApprovalStatus(data.approvalStatus||'NONE')
        if(notify&&data.plan.summary.approvalRequired){setActionMessage('Execution preview generated — cost-bearing missions wait for approval');setActionError(null)}
        else if(notify){setActionMessage('Execution preview generated — all missions are free/local under policy');setActionError(null)}
      }
      else if(data.error)setActionError(data.error)
    }catch(err){setActionError(err instanceof Error?err.message:'Failed to load execution preview')}
    finally{setExecBusy(false)}
  },[apiFetch,projectId])

  const runExecAction=useCallback(async(action:'preview'|'refresh'|'approve'|'deny',objectiveId:number,extra:Record<string,unknown>={})=>{
    if(!projectId)return
    setExecBusy(true);setActionError(null);setActionMessage(null)
    try{
      const data=await apiFetch<{ok?:boolean;error?:string;message?:string;plan?:ExecPlan;approval?:ExecApproval|null;approvalStatus?:'NONE'|'VALID'|'STALE'|'EXPIRED';result?:{approved?:number[];partiallyApproved?:boolean;message?:string}}>(`/api/projects/${projectId}/agentos-execution`,{method:'POST',body:JSON.stringify({action,objectiveId,...extra})})
      if(data.ok&&data.plan){
        setExecObjectiveId(objectiveId);setExecPlan(data.plan);setExecApproval(data.approval||null);setExecApprovalStatus(data.approvalStatus||'NONE')
        if(action==='approve'){
          const approved=Number(data.result?.approved?.length||0)
          setActionMessage(data.result?.message||`Approved ${approved} mission(s)`)
          setExecSelected(new Set())
          await loadContext(projectId)
        }
        else setActionMessage(data.plan.summary.approvalRequired?'Execution preview ready — approval required before dispatch':'Execution plan ready (free/local only — runs automatically)')
      }
      else if(data.ok&&action==='deny'){setActionMessage(data.message||'Execution plan denied');setExecApproval(null);setExecApprovalStatus('NONE')}
      else if(data.error)setActionError(data.error)
    }catch(err){setActionError(err instanceof Error?err.message:'Execution action failed')}
    finally{setExecBusy(false)}
  },[apiFetch,loadContext,projectId])

  const runKnowledgeAction=useCallback(async(payload:{action:'create'|'retry'|'reconcile';packId?:string})=>{
    setCurationBusy(true);setActionError(null);setActionMessage(null)
    try{
      const response=await apiFetch<{ok?:boolean;suite?:{objectiveId:number};mission?:{taskId:number};error?:string}>(`/api/agentos/resources/knowledge`,{method:'POST',body:JSON.stringify({...payload,projectId})})
      if(response.ok){
        setActionMessage(payload.action==='create'
          ? `Knowledge suite objective #${response.suite?.objectiveId} planned (M1–M6; M6 gates on M1–M5)`
          : payload.action==='retry'
            ? `Knowledge mission ${payload.packId} retried (task #${response.mission?.taskId})`
            : 'Knowledge curation reconcile complete')
        setPendingAction(null);await loadArsenal()
      }
      else setActionError(response.error||'Knowledge-curation action failed')
    }catch(err){setActionError(err instanceof Error?err.message:'Knowledge-curation action failed')}
    finally{setCurationBusy(false)}
  },[loadArsenal,projectId])

  const runDeepReviewAction=useCallback(async(payload:{action:'create'|'retry';reviewId:string;reviewer?:string})=>{
    setDeepReviewBusy(true);setActionError(null);setActionMessage(null)
    try{
      const response=await apiFetch<{ok?:boolean;mission?:{taskId:number;reviewed:boolean}&Record<string,unknown>;error?:string}>(`/api/agentos/resources/deep-review`,{method:'POST',body:JSON.stringify({...payload,projectId})})
      if(response.ok){setActionMessage(`Deep-review mission ${response.mission?.taskId?'#'+response.mission.taskId+' ':''}${payload.action==='retry'?'re-created':'created'}`);setPendingAction(null);await loadArsenal()}
      else setActionError(response.error||'Failed to create deep-review mission')
    }catch(err){setActionError(err instanceof Error?err.message:'Failed to create deep-review mission')}
    finally{setDeepReviewBusy(false)}
  },[loadArsenal,projectId])

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
            <div className="rounded-md border border-border/40 bg-background/30 p-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground md:col-span-4">Execution authorization policy — free/local work may auto-run; paid/unknown work waits for your approval</div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={command.policy.allowFreeLocalWithoutApproval!==false} onChange={e=>setCommand({...command,policy:{...command.policy,allowFreeLocalWithoutApproval:e.target.checked}})}/>Free-local auto-runs</label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={command.policy.allowFreeRemoteWithoutApproval===true} onChange={e=>setCommand({...command,policy:{...command.policy,allowFreeRemoteWithoutApproval:e.target.checked}})}/>Free-remote auto-runs</label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={command.policy.allowPaidWithoutApproval===true} onChange={e=>setCommand({...command,policy:{...command.policy,allowPaidWithoutApproval:e.target.checked}})}/>Allow paid without approval</label>
              <label className="text-xs text-muted-foreground">Max approved estimate (blank = unlimited)<input type="number" min={0} step={0.01} value={command.policy.maxApprovedEstimatedCost??''} onChange={e=>setCommand({...command,policy:{...command.policy,maxApprovedEstimatedCost:e.target.value===''?null:Number(e.target.value)}})} className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5"/></label>
              <label className="text-xs text-muted-foreground md:col-span-2 xl:col-span-2">Blocked providers<input value={(command.policy.blockedProviders||[]).join(', ')} onChange={e=>setCommand({...command,policy:{...command.policy,blockedProviders:e.target.value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)}})} className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5" placeholder="provider slugs, blank = none blocked"/></label>
              <label className="text-xs text-muted-foreground xl:col-span-2">Pre-approved providers<input value={(command.policy.approvedProviders||[]).join(', ')} onChange={e=>setCommand({...command,policy:{...command.policy,approvedProviders:e.target.value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)}})} className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5" placeholder="provider slugs bypass approval, blank = none"/></label>
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

          <section className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><p className="text-xs font-mono uppercase tracking-wider text-primary">AI Arsenal</p><h2 className="text-lg font-semibold mt-1">Approved skills, tools & knowledge</h2></div>
              <div className="flex items-center gap-3">
                {arsenal?.summary&&<span className="text-[10px] text-muted-foreground">{arsenal.summary.resources} resources · {arsenal.summary.filled} filled · {arsenal.summary.partiallyCovered} partial · {arsenal.summary.open} open{arsenal.summary.needsManual>0?<span className="text-rose-400"> · {arsenal.summary.needsManual} need manual</span>:null}</span>}
                <Button size="sm" variant="outline" disabled={resourceBusy} onClick={()=>void rescanAiVault()}>{resourceBusy?'Scanning…':'Rescan D:\AI'}</Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {([['recommendations','Recommendations'],['registry','Registry'],['coverage','Capability Coverage'],['changes','New / Changed'],['reviews','Review Queue'],['history','Promotion History'],['overlaps','Duplicates / Supersessions'],['risks','Runtime Risks'],['backlog','Backlog'],['curation','Knowledge Curation']] as Array<[ArsenalTab,string]>).map(([tab,label])=><button key={tab} onClick={()=>{setArsenalTab(tab);setActionError(null);setActionMessage(null)}} className={`rounded-md px-2.5 py-1 text-xs font-medium ${arsenalTab===tab?'bg-primary text-primary-foreground':'bg-secondary/50 text-muted-foreground hover:bg-secondary'}`}>{label}</button>)}
            </div>
            {actionError&&<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{actionError}</div>}
            {actionMessage&&<div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">{actionMessage}</div>}
            {arsenalTab==='recommendations'&&<ArsenalRecommendations recommendations={force?.resourceRecommendations||[]}/>}
            {arsenalTab==='registry'&&<ArsenalRegistry registry={arsenal?.registry||null}/>}
            {arsenalTab==='coverage'&&<ArsenalCoverage coverage={arsenal?.capabilityCoverage||[]}/>}
            {arsenalTab==='changes'&&<ArsenalChanges changes={arsenal?.changes||null}/>}
            {arsenalTab==='reviews'&&<ArsenalReviews items={arsenal?.reviewQueue||[]} missions={arsenal?.missions||[]} pendingAction={pendingAction} setPendingAction={setPendingAction} busy={actionBusy} onSubmit={submitArsenalAction} deepReviewBusy={deepReviewBusy} onDeepReview={runDeepReviewAction}/>}
            {arsenalTab==='reviews'&&arsenalNeedsManual>0&&<div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">⚠ {arsenalNeedsManual} escalated review{arsenalNeedsManual===1?'':'s'} need human attention below.</div>}
            {arsenalTab==='history'&&<ArsenalHistory history={arsenal?.promotionHistory||[]}/>}
            {arsenalTab==='overlaps'&&<ArsenalOverlaps registry={arsenal?.registry||null}/>}
            {arsenalTab==='risks'&&<ArsenalRisks registry={arsenal?.registry||null} reviews={arsenal?.reviewQueue||[]}/>}
            {arsenalTab==='backlog'&&<ArsenalBacklog backlog={arsenal?.knowledgePackBacklog||[]}/>}
            {arsenalTab==='curation'&&<ArsenalCuration state={arsenal?.knowledge||null} busy={curationBusy} onCreate={()=>void runKnowledgeAction({action:'create'})} onRetry={(packId)=>void runKnowledgeAction({action:'retry',packId})} onReconcile={()=>void runKnowledgeAction({action:'reconcile'})}/>}
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><p className="text-xs font-mono uppercase tracking-wider text-primary">Execution</p><h2 className="text-lg font-semibold mt-1">Preview, cost & authorization</h2><p className="text-xs text-muted-foreground mt-1">Preview exactly what AgentOS intends to run. FREE_LOCAL missions auto-run under policy; PAID/UNKNOWN missions stay safely assigned until you approve the exact plan snapshot.</p></div>
              <div className="flex flex-wrap gap-2">
                <select value={execObjectiveId??''} onChange={e=>{setExecObjectiveId(e.target.value?Number(e.target.value):null);setExecPlan(null);setExecApproval(null);setExecApprovalStatus('NONE');setExecSelected(new Set())}} className="rounded-md border border-border bg-background px-3 py-2 text-sm"><option value="">Objective…</option>{objectives.map(o=><option key={o.id} value={o.id}>{o.title} (#{o.id})</option>)}</select>
                <Button size="sm" variant="outline" disabled={execBusy||!execObjectiveId} onClick={()=>void runExecAction('preview',execObjectiveId!)}>{execBusy?'Working…':'Generate Preview'}</Button>
                <Button size="sm" variant="outline" disabled={execBusy||!execObjectiveId||!execPlan} onClick={()=>void runExecAction('refresh',execObjectiveId!)}>Refresh Plan</Button>
                {execPlan&&<Button size="sm" disabled={execBusy||!execPlan.summary.approvalRequired} onClick={()=>void runExecAction('approve',execObjectiveId!,{approveTaskIds:'all-eligible'})}>Approve All Eligible</Button>}
                {execPlan&&<Button size="sm" variant="outline" disabled={execBusy||execSelected.size===0} onClick={()=>void runExecAction('approve',execObjectiveId!,{approveTaskIds:[...execSelected]})}>Approve Selected ({execSelected.size})</Button>}
                {execPlan&&<Button size="sm" variant="ghost" disabled={execBusy} onClick={()=>void runExecAction('deny',execObjectiveId!,{reason:'User held execution from Project Command'})}>Deny / Hold</Button>}
              </div>
            </div>
            {execApprovalStatus==='STALE'&&<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">⚠ Approval stale — routing changed since approval (different specialist/provider/model/runtime or new mission). Cost-bearing work stays held until you refresh the plan and approve again.</div>}
            {execPlan&&execPlan.summary.approvalRequired&&execApprovalStatus==='NONE'&&<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">⚠ This objective contains cost-bearing/unknown-cost missions — they will be held (never claimed, never dispatched) until you approve the exact plan below.</div>}
            {!execPlan&&<div className="text-sm text-muted-foreground">Pick an objective and generate a preview to see per-mission cost classes, runtimes, and approval requirements. No dispatch happens from here — the scheduler enforces the same authorization.</div>}
            {execPlan&&<>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                <MiniMetric label="Free / local" value={execPlan.summary.freeMissions}/>
                <MiniMetric label="Paid" value={execPlan.summary.paidMissions}/>
                <MiniMetric label="Unknown cost" value={execPlan.summary.unknownCostMissions}/>
                <MiniMetric label="Blocked" value={execPlan.summary.blockedMissions}/>
                <div className="rounded-lg bg-secondary/40 p-3"><div className="text-xl font-semibold">{execPlan.summary.approvalRequired?'REQUIRED':'NONE'}</div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">Approval</div></div>
              </div>
              <div className="max-h-[26rem] overflow-auto space-y-2 pr-1">
                {execPlan.missions.map(mission=>{
                  const tone=mission.costClass==='FREE_LOCAL'?'bg-emerald-500/15 text-emerald-400':mission.costClass==='FREE_REMOTE'?'bg-sky-500/15 text-sky-400':mission.costClass==='PAID_KNOWN'||mission.costClass==='PAID_ESTIMATED'?'bg-rose-500/15 text-rose-400':mission.costClass==='BLOCKED'?'bg-red-500/15 text-red-400':'bg-amber-500/15 text-amber-300'
                  const approved=!!execApproval?.approvedTaskIds.includes(mission.taskId)
                  return <div key={mission.taskId} className="rounded-lg border border-border/50 bg-background/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap"><span className="text-xs font-mono font-semibold text-primary">{mission.missionKey.toUpperCase()}</span><span className="text-sm font-medium">{mission.title}</span><span className="text-[10px] text-muted-foreground">task #{mission.taskId}</span></div>
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-mono uppercase rounded px-1.5 py-0.5 ${tone}`}>{mission.costClass}</span>
                        {mission.requiresApproval&&<label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer"><input type="checkbox" checked={execSelected.has(mission.taskId)||approved} disabled={approved} onChange={e=>{const next=new Set(execSelected);if(e.target.checked)next.add(mission.taskId);else next.delete(mission.taskId);setExecSelected(next)}}/>approve</label>}
                        {approved&&<span className="text-[10px] text-emerald-400">✓ approved</span>}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1.5">{mission.dependencies.length?`deps: ${mission.dependencies.map(d=>d.toUpperCase()).join(' ')} · `:''}{mission.runtimeAccess||'unassigned'} · specialist {mission.specialist||'—'}{mission.provider?` · ${mission.provider}${mission.model?`/${mission.model}`:''}`:''}{mission.estimatedCost!==null?` · est ${mission.estimatedCost}`:''}</div>
                    {mission.resources.length>0&&<div className="text-[10px] text-muted-foreground mt-1">resources: {mission.resources.map(r=>r.resourceId+(r.manualOnly?' (manual)':'')).join(', ')}</div>}
                    <div className="text-[10px] text-muted-foreground/70 mt-1">basis: {mission.costBasis}</div>
                    {mission.warnings.length>0&&<div className="text-[10px] text-amber-400/80 mt-1">{mission.warnings.join(' · ')}</div>}
                  </div>
                })}
              </div>
            </>}
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
function ArsenalStatusBadge({status}:{status:string}){const tone=status==='FILLED'?'bg-emerald-500/15 text-emerald-400':status==='PARTIALLY_COVERED'?'bg-amber-500/15 text-amber-400':status==='OPEN'?'bg-rose-500/15 text-rose-400':'bg-secondary/50 text-muted-foreground';return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-mono uppercase ${tone}`}>{status}</span>}
function ArsenalRecommendations({recommendations}:{recommendations:Array<{id:string;name:string;path:string;type:string;score:number;primaryCapability:string;capabilities:string[]}>}){return <div>
  <p className="text-xs text-muted-foreground mb-3">AgentOS ranks D:\AI resources against this project's capability demand and attaches the best matches to routed missions. Manual-only and reference resources are never auto-selected.</p>
  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
    {recommendations.slice(0,12).map(resource=><div key={resource.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="flex items-start justify-between gap-2"><div><div className="text-sm font-medium">{resource.name}</div><div className="text-[10px] text-muted-foreground mt-1">{resource.type} · {resource.primaryCapability}</div></div><span className="text-xs font-mono">{resource.score}</span></div>
      <div className="text-[10px] text-muted-foreground mt-2 break-all">{resource.path}</div>
    </div>)}
    {recommendations.length===0&&<div className="text-sm text-muted-foreground">No matching vault resources for the current project demand yet.</div>}
  </div>
</div>}
function ArsenalRegistry({registry}:{registry:ArsenalState['registry']}){
  if(!registry)return <div className="text-sm text-muted-foreground">AI Arsenal registry unavailable.</div>
  const resources=[...registry.resources].sort((a,b)=>(b.score||0)-(a.score||0))
  return <div>
    <p className="text-xs text-muted-foreground mb-2">{registry.summary.total} canonical audited resources from agentos_resource_registry.json. Deep-audit policy beats heuristic scanner scores; REJECT / archive / manual-only resources are never auto-selected.</p>
    <div className="max-h-96 overflow-auto rounded-lg border border-border/50">
      {resources.map(resource=><div key={resource.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-3 py-2 last:border-b-0">
        <div className="w-2/5 min-w-44"><div className="text-sm font-medium">{resource.name}</div><div className="text-[10px] text-muted-foreground break-all">{resource.path}</div></div>
        <span className="text-[10px] uppercase rounded bg-secondary/50 px-1.5 py-0.5">{resource.type}</span>
        <span className="text-xs font-mono w-10">{resource.score}</span>
        <ArsenalStatusBadge status={resource.auditStatus||resource.status||''}/>
        <span className="text-xs text-muted-foreground min-w-36">{resource.primaryCapability}</span>
        <span className="text-[10px] text-muted-foreground min-w-28">{resource.preferredPlatoon||''}{resource.preferredSpecialistRole?` · ${resource.preferredSpecialistRole}`:''}</span>
        <span className="text-[10px] font-mono text-muted-foreground">{resource.autoSelectAllowed?'auto-select':'manual-only'}</span>
      </div>)}
    </div>
  </div>
}
function ArsenalCoverage({coverage}:{coverage:ArsenalCoverage[]}){
  if(coverage.length===0)return <div className="text-sm text-muted-foreground">No capability coverage available (agentos_capability_index.json missing?).</div>
  const order:{[key:string]:number}={PARTIALLY_COVERED:0,OPEN:1,FILLED:2}
  const sorted=[...coverage].sort((a,b)=>(order[a.status]??3)-(order[b.status]??3)||a.capability.localeCompare(b.capability))
  return <div className="space-y-2">
    {sorted.map(item=><div key={item.capability} className="rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="text-sm font-medium">{item.capability}</span><ArsenalStatusBadge status={item.status}/>
        {item.preferred.map(entry=><span key={entry.resourceId} className="text-xs text-emerald-400">Preferred: {entry.name}</span>)}
        {item.secondary.map(entry=><span key={entry.resourceId} className="text-xs text-muted-foreground">• {entry.name}</span>)}
        {item.reference.map(entry=><span key={entry.resourceId} className="text-xs text-sky-400">Reference: {entry.name}{entry.manualOnly?' (manual-only)':''}</span>)}
        {item.notProviders.map(name=><span key={name} className="text-[10px] text-rose-400/80 line-through">Not provider: {name}</span>)}</div>
      {item.note&&<div className="text-[11px] text-muted-foreground mt-1.5">{item.note}</div>}
    </div>)}
  </div>
}
function ArsenalChanges({changes}:{changes:ArsenalChangeState|null}){
  if(!changes)return <div className="text-sm text-muted-foreground">No change-detection snapshot (agentos_resource_changes.json) available.</div>
  const tiles:Array<[string,string[],string]>=[['NEW',changes.new,'text-emerald-400'],['CHANGED',changes.changed,'text-amber-400'],['MISSING',changes.missing,'text-rose-400'],['UNCHANGED',changes.unchanged,'text-muted-foreground']]
  return <div>
    <p className="text-xs text-muted-foreground mb-2">Snapshot {changes.scanId} · {changes.scanTime} (baseline {changes.baselineVersion}). AgentOS never promotes automatically — candidates flow through the review queue.</p>
    <div className="grid gap-2 md:grid-cols-2">
      {tiles.map(([label,ids,color])=><div key={label} className="rounded-lg border border-border/50 p-3"><div className={`text-xs font-mono uppercase ${color}`}>{label} · {ids.length}</div><div className="text-[11px] text-muted-foreground mt-1 break-words">{label==='UNCHANGED'?(ids.length?`${ids.length} resources stable`:'—'):ids.join(', ')||'—'}</div></div>)}
      {changes.duplicateCandidates.length>0&&<div className="rounded-lg border border-border/50 p-3"><div className="text-xs font-mono uppercase text-muted-foreground">Duplicate candidates · {changes.duplicateCandidates.length}</div><div className="text-[11px] text-muted-foreground mt-1">{changes.duplicateCandidates.join(', ')}</div></div>}
      {changes.supersessionCandidates.length>0&&<div className="rounded-lg border border-border/50 p-3"><div className="text-xs font-mono uppercase text-muted-foreground">Supersession candidates · {changes.supersessionCandidates.length}</div><div className="text-[11px] text-muted-foreground mt-1">{changes.supersessionCandidates.join(', ')}</div></div>}
      {changes.promoted.length>0&&<div className="rounded-lg border border-border/50 p-3"><div className="text-xs font-mono uppercase text-emerald-400">Promoted · {changes.promoted.length}</div><div className="text-[11px] text-muted-foreground mt-1">{changes.promoted.join(', ')}</div></div>}
    </div>
    {changes.gapNote&&<p className="text-[11px] text-muted-foreground mt-2">{changes.gapNote}</p>}
  </div>
}
function ArsenalReviews({items,missions,pendingAction,setPendingAction,busy,onSubmit,deepReviewBusy,onDeepReview}:{
  items:ArsenalReviewItem[]
  missions:ArsenalReviewMissionTrace[]
  pendingAction:{resourceId:string;action:string}|null
  setPendingAction:(value:{resourceId:string;action:string}|null)=>void
  busy:boolean
  onSubmit:(payload:{action:string;resourceId:string;reason?:string;reviewer?:string;promotion?:Record<string,unknown>})=>Promise<void>
  deepReviewBusy:boolean
  onDeepReview:(payload:{action:'create'|'retry';reviewId:string;reviewer?:string})=>Promise<void>
}){
  const [filter,setFilter]=useState<'all'|'needs-manual'>('all')
  const pending=items.filter(item=>item.pending)
  const decided=items.filter(item=>!item.pending)
  const isNeedsManual=(item:ArsenalReviewItem)=>{const state=(item.deepReview?.status||'').toUpperCase();return state==='NEEDS_MANUAL'||state==='STALE'||!!item.deepReview?.escalatedReason}
  const reviewInFlight=(item:ArsenalReviewItem)=>['QUEUED','ROUTED','RUNNING'].includes((item.deepReview?.status||'').toUpperCase())
  const visible=pending.filter(item=>filter!=='needs-manual'||isNeedsManual(item))
  const needsManualCount=pending.filter(isNeedsManual).length
  return <div className="space-y-2">
    <p className="text-xs text-muted-foreground">Candidates detected by the AI vault scan pipeline ({items.length} total, {pending.length} pending). Deep review delegates a structured review mission to the most qualified reviewer; the result is validated (agentos-resource-review-v1) before approvals unlock.</p>
    <div className="flex flex-wrap items-center gap-1.5">
      <button onClick={()=>setFilter('all')} className={`rounded-md px-2 py-1 text-[10px] font-medium ${filter==='all'?'bg-primary text-primary-foreground':'bg-secondary/50 text-muted-foreground'}`}>All · {pending.length}</button>
      {needsManualCount>0&&<button onClick={()=>setFilter('needs-manual')} className={`rounded-md px-2 py-1 text-[10px] font-medium ${filter==='needs-manual'?'bg-rose-500 text-white':'bg-rose-500/10 text-rose-300'}`}>⚠ Needs manual · {needsManualCount}</button>}
    </div>
    {visible.length===0&&<div className="text-sm text-muted-foreground">{filter==='needs-manual'?'Nothing escalated right now.':'No pending review candidates.'}</div>}
    {visible.map(item=>{
      const trace=missions.find(mission=>mission.reviewId===item.reviewId)
      const state=(item.deepReview?.status||'').toUpperCase()
      const decideDisabled=reviewInFlight(item)
      const retryable=state==='FAILED'||state==='STALE'||state==='NEEDS_MANUAL'||state==='COMPLETE'
      const requestable=!item.deepReview||state==='QUEUED'||state==='FAILED'||state==='STALE'
      return <div key={item.reviewId} className="rounded-lg border border-border/50 bg-background/40 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><div className="text-sm font-medium">{item.probableName}</div><div className="text-[10px] text-muted-foreground break-all">{item.path}</div></div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" disabled={busy||decideDisabled||pendingAction!==null&&pendingAction.resourceId===item.reviewId&&['approve','reject','mark-manual-only','dismiss-duplicate'].includes(pendingAction.action)} onClick={()=>setPendingAction({resourceId:item.reviewId,action:'approve'})} title={decideDisabled?'Decision unlocked after deep review completes':undefined}>Approve</Button>
            <Button size="sm" variant="outline" disabled={busy||decideDisabled||pendingAction!==null&&pendingAction.resourceId===item.reviewId&&['approve','reject','mark-manual-only','dismiss-duplicate'].includes(pendingAction.action)} onClick={()=>setPendingAction({resourceId:item.reviewId,action:'reject'})} title={decideDisabled?'Decision unlocked after deep review completes':undefined}>Reject</Button>
            <Button size="sm" variant="outline" disabled={busy||decideDisabled||pendingAction!==null&&pendingAction.resourceId===item.reviewId&&['approve','reject','mark-manual-only','dismiss-duplicate'].includes(pendingAction.action)} onClick={()=>setPendingAction({resourceId:item.reviewId,action:'mark-manual-only'})} title={decideDisabled?'Decision unlocked after deep review completes':undefined}>Manual-only</Button>
            <Button size="sm" variant="outline" disabled={busy||decideDisabled||pendingAction!==null&&pendingAction.resourceId===item.reviewId&&['approve','reject','mark-manual-only','dismiss-duplicate'].includes(pendingAction.action)} onClick={()=>setPendingAction({resourceId:item.reviewId,action:'dismiss-duplicate'})} title={decideDisabled?'Decision unlocked after deep review completes':undefined}>Dismiss dup</Button>
            {requestable&&<Button size="sm" disabled={deepReviewBusy||pendingAction!==null} onClick={()=>setPendingAction({resourceId:item.reviewId,action:'request-deep-review'})}>{state==='FAILED'||state==='STALE'?'Re-request':'Deep review'}</Button>}
            {retryable&&<Button size="sm" disabled={deepReviewBusy||pendingAction!==null} onClick={()=>setPendingAction({resourceId:item.reviewId,action:'retry-review'})}>Retry</Button>}
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground mt-1.5 break-words">{(item.detectedCapabilities||[]).join(', ')||'no capabilities inferred'} · score {item.preliminaryQualityScore??'—'} · {item.recommendedAction||'no action'}{item.likelyOverlaps.length?` · overlaps: ${item.likelyOverlaps.join(', ')}`:''}{item.runtimePathRisks.length?` · risks: ${item.runtimePathRisks.join(', ')}`:''}</div>
        {item.deepReview&&<div className="mt-2 rounded border border-border/40 bg-background/50 px-2.5 py-2 text-[11px] space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-mono uppercase text-[10px] text-muted-foreground">Deep review</span><ArsenalStatusBadge status={state||'QUEUED'}/>
            {item.deepReview.reviewer&&<span>Reviewer: {item.deepReview.reviewer}</span>}
            {item.deepReview.routing?.platoonId&&<span>Platoon: {item.deepReview.routing.platoonId}</span>}
            {item.deepReview.retries>0&&<span>Retries: {item.deepReview.retries}</span>}
            {item.deepReview.taskId&&<span>Mission: Task {item.deepReview.taskId}</span>}
            {item.deepReview.objectiveId&&<span>Objective #{item.deepReview.objectiveId}</span>}
            {item.deepReview.reviewCompletedAt&&<span>Completed: {item.deepReview.reviewCompletedAt}</span>}
          </div>
          {trace&&<div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
            <span>Task {trace.taskId} · {trace.status}</span>
            {trace.delegation&&                <span>Delegation {trace.delegation.id?.slice(0,8)} · {trace.delegation.status||'pending'} · {trace.delegation.runtimeType||'runtime'}{trace.delegation.platoonId?` · ${trace.delegation.platoonId}`:''}{trace.delegation.specialistName?` · ${trace.delegation.specialistName}`:''}{trace.delegation.nativeSessionId?` · session ${trace.delegation.nativeSessionId.slice(0,12)}`:''}{trace.delegation.nativeRunId?` · run ${trace.delegation.nativeRunId.slice(0,12)}`:''}{(trace.delegation.attempt||0)>1?` · attempt ${trace.delegation.attempt}`:''}</span>}
            {trace?.delegation?.errorMessage&&<span className="text-destructive">error: {trace.delegation.errorMessage.slice(0,120)}</span>}
          </div>}
          {(item.deepReview.escalatedReason||trace?.escalation)&&<div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 space-y-1">
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-rose-300">
              <span className="font-mono uppercase text-[10px]">Needs manual</span>
              {item.deepReview.escalatedReason&&<span>Reason: {item.deepReview.escalatedReason}</span>}
              <span>Attempts: {Math.max(item.deepReview.invalidAttempts||0,item.deepReview.retries||0,trace?.escalation?.attempts||1)}</span>
              {trace?.escalation?.category&&<span>Category: {trace.escalation.category}</span>}
              {item.deepReview.objectiveId&&<span>Objective #{item.deepReview.objectiveId}</span>}
            </div>
            {(trace?.escalation?.recommendedActions?.length||item.deepReview.escalation?.recommended_actions?.length)&&<div className="text-[10px] text-rose-200/80">Safe follow-ons: {[...(item.deepReview.escalation?.recommended_actions||[]),...(trace?.escalation?.recommendedActions||[])].filter((value,index,all)=>all.indexOf(value)===index).join(' · ')}</div>}
            {trace?.escalation?.summary&&<div className="text-[10px] text-rose-200/70">{trace.escalation.summary}</div>}
          </div>}
          {item.deepReview.error&&<div className="text-destructive">{item.deepReview.error}</div>}
          {(()=>{const result=item.deepReview.result as {quality_score?:number;audit_status_recommendation?:string;primary_capability?:string;confidence?:string}|null;return result&&typeof result==='object'?(<div className="text-muted-foreground">Result: score {result.quality_score??'—'} · {result.audit_status_recommendation??'—'} · {result.primary_capability??'—'} {result.confidence??''}</div>):null})()}
        </div>}
        {pendingAction&&pendingAction.resourceId===item.reviewId&&<ArsenalActionForm item={item} action={pendingAction.action} busy={busy||deepReviewBusy} onCancel={()=>setPendingAction(null)} onSubmit={onSubmit} onDeepReview={onDeepReview}/>}
      </div>
    })}
    {decided.length>0&&<div className="pt-2"><p className="text-[10px] font-mono uppercase text-muted-foreground mb-1.5">Decided</p>{decided.map(item=><div key={item.reviewId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border/40 px-3 py-1.5 text-[11px]"><span className="font-medium">{item.probableName}</span><ArsenalStatusBadge status={item.reviewStatus}/>{item.promotionBatchId&&<span className="text-muted-foreground">{item.promotionBatchId}</span>}{item.finalApprovedDecision&&<span className="text-muted-foreground">{item.finalApprovedDecision}</span>}</div>)}</div>}
  </div>
}
function ArsenalActionForm({item,action,busy,onCancel,onSubmit,onDeepReview}:{
  item:ArsenalReviewItem
  action:string
  busy:boolean
  onCancel:()=>void
  onSubmit:(p:{action:string;resourceId:string;reason?:string;reviewer?:string;promotion?:Record<string,unknown>})=>Promise<void>
  onDeepReview:(p:{action:'create'|'retry';reviewId:string;reviewer?:string})=>Promise<void>
}){
  const [reason,setReason]=useState('')
  const [reviewer,setReviewer]=useState('')
  const [localError,setLocalError]=useState<string|null>(null)
  const [proposal,setProposal]=useState<string>(()=>JSON.stringify({
    name:item.probableName,
    display_name:item.probableName,
    source_repo:item.probableSourceRepo,
    resource_type:item.probableResourceType,
    primary_capability:item.inferredPrimaryCapability,
    secondary_capabilities:(item.detectedCapabilities||[]).filter(cap=>cap!==item.inferredPrimaryCapability),
    quality_score:item.preliminaryQualityScore,
    audit_status:'KEEP',
    auto_select_allowed:true,
    manual_only:false,
    notes:item.recommendedAction?`Deep-review proposal: ${item.recommendedAction}`:undefined,
  },null,2))
  const submit=async()=>{
    setLocalError(null)
    if(action==='request-deep-review'||action==='retry-review'){
      await onDeepReview({action:action==='request-deep-review'?'create':'retry',reviewId:item.reviewId,reviewer:reviewer.trim()||undefined})
      return
    }
    let promotion:Record<string,unknown>|undefined
    if(action==='approve'){
      try{promotion=JSON.parse(proposal)}catch{setLocalError('Promotion payload is not valid JSON');return}
    }
    await onSubmit({action,resourceId:item.reviewId,reason:reason.trim()||undefined,reviewer:reviewer.trim()||undefined,promotion})
  }
  const actionLabel=action==='approve'?'Promote':action==='request-deep-review'?'Request deep review':action==='retry-review'?'Retry review':action==='mark-manual-only'?'Mark manual-only':action==='dismiss-duplicate'?'Dismiss duplicate':action==='approve-supersession'?'Approve supersession':'Apply'
  return <div className="mt-2 rounded border border-border/50 bg-background/60 p-2.5 space-y-2">
    {localError&&<div className="text-xs text-destructive">{localError}</div>}
    {action==='approve'&&<textarea value={proposal} onChange={e=>setProposal(e.target.value)} className="min-h-36 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[10px]" spellCheck={false}/>}
    {(action==='request-deep-review'||action==='retry-review')&&<input value={reviewer} onChange={e=>setReviewer(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs" placeholder="Optional reviewer (AgentOS picks the most qualified resource-deep-review specialist when blank)"/>}
    {['reject','dismiss-duplicate','mark-manual-only','approve-supersession'].includes(action)&&<input value={reason} onChange={e=>setReason(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs" placeholder={action==='approve-supersession'?'Required capability note / winning resource id (payload.preferredResourceId)':action==='mark-manual-only'?'Optional reason for manual-only':action==='dismiss-duplicate'?'Duplicate of which resource? (optional)':'Rejection reason (optional)'}/>}
    <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button><Button size="sm" disabled={busy} onClick={()=>void submit()}>{busy?'Working…':actionLabel}</Button></div>
  </div>
}
function ArsenalHistory({history}:{history:ArsenalPromotion[]}){
  if(history.length===0)return <div className="text-sm text-muted-foreground">No promotion history yet.</div>
  return <div className="space-y-2">{[...history].reverse().map(promo=><div key={promo.promotionBatchId} className="rounded-lg border border-border/50 bg-background/40 p-3">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="text-sm font-medium font-mono">{promo.promotionBatchId}</span><span className="text-[10px] text-muted-foreground">{promo.approvedAt}</span></div>
    <div className="text-[11px] text-muted-foreground mt-1">Resources: {promo.approvedResources.join(', ')||'—'}</div>
    {(promo.previousState||promo.newState)&&<div className="text-[11px] text-muted-foreground mt-0.5">{promo.previousState?`prior ${JSON.stringify(promo.previousState)}`:'—'} → {promo.newState?JSON.stringify(promo.newState):'—'}</div>}
    {promo.capabilitiesAdded.length>0&&<div className="text-[11px] text-muted-foreground mt-0.5">Capabilities: {promo.capabilitiesAdded.join(', ')}</div>}
    {promo.overlapChanges.length>0&&<div className="text-[11px] text-muted-foreground mt-0.5">Overlaps: {promo.overlapChanges.join('; ')}</div>}
    {promo.warnings.length>0&&<div className="mt-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">{promo.warnings.join(' · ')}</div>}
  </div>)}
  </div>
}
function ArsenalOverlaps({registry}:{registry:ArsenalState['registry']}){
  if(!registry)return <div className="text-sm text-muted-foreground">Overlap data unavailable.</div>
  const superseded=registry.resources.filter(resource=>resource.supersededBy&&resource.supersededBy.length>0)
  return <div className="space-y-2">
    {superseded.length>0&&<div className="rounded-lg border border-border/50 bg-background/40 p-3"><div className="text-xs font-mono uppercase text-muted-foreground mb-1">Supersessions</div>{superseded.map(resource=><div key={resource.id} className="text-[11px] text-muted-foreground">{resource.name} superseded by {resource.supersededBy?.join(', ')}</div>)}</div>}
    {registry.overlapGroups.map(group=><div key={group.capability+group.preferredId} className="rounded-lg border border-border/50 bg-background/40 p-3"><div className="text-xs font-medium">{group.capability}</div><div className="text-[11px] text-muted-foreground mt-1">Preferred: {group.preferredId}</div><div className="text-[11px] text-muted-foreground">Candidates: {group.candidateIds.join(', ')}</div></div>)}
    {registry.overlapGroups.length===0&&superseded.length===0&&<div className="text-sm text-muted-foreground">No overlap groups or supersessions recorded.</div>}
  </div>
}
function ArsenalRisks({registry,reviews}:{registry:ArsenalState['registry'];reviews:ArsenalReviewItem[]}){
  const risky=(registry?.resources||[]).filter(resource=>resource.moveRisk||resource.pathSensitive)
  const queueRisks=reviews.filter(item=>item.runtimePathRisks.length>0)
  return <div className="space-y-2">
    {risky.length===0&&queueRisks.length===0&&<div className="text-sm text-muted-foreground">No runtime/path risks flagged.</div>}
    {risky.map(resource=><div key={resource.id} className="rounded-lg border border-border/50 bg-background/40 p-3"><div className="text-sm font-medium">{resource.name}</div>{resource.moveRisk&&<div className="text-[11px] text-muted-foreground mt-1">{resource.moveRisk}</div>}{resource.pathSensitive&&<div className="text-[11px] text-amber-400 mt-1">Path-sensitive — do not relocate without re-pointing integrations</div>}</div>)}
    {queueRisks.map(item=><div key={item.reviewId} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"><div className="text-sm font-medium">{item.probableName}</div><div className="text-[11px] text-amber-300 mt-1">{item.runtimePathRisks.join(' · ')}</div></div>)}
  </div>
}
function ArsenalBacklog({backlog}:{backlog:Array<{id:string;name:string;status:string}>}){
  return <div>
    <p className="text-xs text-muted-foreground mb-2">Proposed future knowledge packs — deliberately NOT built yet. They are backlog items for future AgentOS-delegated knowledge-curation missions.</p>
    {backlog.map(item=><div key={item.id} className="rounded-lg border border-border/50 bg-background/40 p-3 mb-2"><div className="flex items-center gap-2"><span className="text-sm font-medium">{item.name}</span><span className="text-[10px] font-mono uppercase text-muted-foreground">{item.status}</span></div><div className="text-[11px] text-muted-foreground mt-1">{item.id}</div></div>)}
    {backlog.length===0&&<div className="text-sm text-muted-foreground">No backlog recorded.</div>}
  </div>
}
function ArsenalCuration({state,busy,onCreate,onRetry,onReconcile}:{
  state: ArsenalKnowledgeState|null
  busy: boolean
  onCreate: ()=>void
  onRetry: (packId:string)=>void
  onReconcile: ()=>void
}){
  const objective=state?.objective||null
  const missions=(state?.missions||[]).slice().sort((a,b)=>(a.missionKey<b.missionKey?-1:a.missionKey>b.missionKey?1:0))
  const plan=(objective?.plan||null) as Record<string,unknown>|null
  const suiteMeta=(plan?.agentos_knowledge_suite||null) as Record<string,unknown>|null
  const needsManual=missions.some(m=>m.escalation||m.state==='NEEDS_MANUAL')
  const packDone=missions.filter(m=>m.missionKey!=='m6'&&m.state==='COMPLETE').length
  const depLabel=(keys:string[])=>keys.length?`depends: ${keys.map(k=>k.toUpperCase()).join(' ')}`:'independent'
  return <div className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap"><p className="text-xs font-mono uppercase tracking-wider text-primary">Knowledge Curation</p>{objective&&<span className={`text-[10px] font-mono uppercase rounded px-1.5 py-0.5 ${objective.status==='completed'?'bg-emerald-500/15 text-emerald-400':objective.status==='needs_manual'?'bg-rose-500/15 text-rose-400':objective.status==='active'?'bg-blue-500/15 text-blue-400':'bg-secondary/50 text-muted-foreground'}`}>{objective.status}</span>}{needsManual&&<span className="text-[10px] font-mono uppercase rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-400">⚠ needs manual</span>}</div>
        {objective
          ? <h3 className="text-base font-semibold mt-1">{objective.title} <span className="text-xs font-mono text-muted-foreground">objective #{objective.id}</span></h3>
          : <h3 className="text-base font-semibold mt-1">Build Tactical Encounter Knowledge Pack Suite</h3>}
        <p className="text-xs text-muted-foreground mt-1">M1–M5 curate the approved tactical packs (Wesnoth auto + OXCE as explicit manual reference) → staged to <span className="font-mono">00_INBOX/generated-knowledge</span>; M6 validates and finalizes. The vault scanner registers the suite as NEW afterwards — nothing is auto-promoted.</p>
        {suiteMeta&&<p className="text-[10px] text-muted-foreground mt-2 font-mono break-all">staging: {String(suiteMeta.staging_dir||'')} · output: {String(suiteMeta.output_dir||'')} · state: {String(suiteMeta.state||'PLANNED')}</p>}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onReconcile}>Reconcile</Button>
        {!objective&&<Button size="sm" disabled={busy} onClick={onCreate}>{busy?'Planning…':'Plan Knowledge Suite Objective'}</Button>}
      </div>
    </div>
    {objective&&<>
      <div className="grid gap-2 md:grid-cols-3">
        <MiniMetric label="Curation missions" value={packDone}/>
        <MiniMetric label="Validation (M6)" value={missions.find(m=>m.missionKey==='m6')?.state==='COMPLETE'?1:0}/>
        <MiniMetric label="Total missions" value={6}/>
      </div>
      {needsManual&&<div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">⚠ One or more curation missions are escalated — resolve below (Retry keeps the same task lineage).</div>}
      <div className="space-y-2 max-h-[32rem] overflow-auto pr-1">
        {missions.map(mission=>{
          const escalated=mission.escalation
          const retryable=mission.state==='FAILED'||mission.state==='NEEDS_MANUAL'||!!escalated
          return <div key={mission.taskId} className={`rounded-lg border p-3 ${escalated?'border-rose-500/40 bg-rose-500/5':'border-border/50 bg-background/40'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap"><span className="text-xs font-mono font-semibold text-primary">{mission.missionKey.toUpperCase()}</span><span className="text-sm font-medium">{mission.title}</span><span className="text-[10px] font-mono uppercase text-muted-foreground">task #{mission.taskId}</span></div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono uppercase rounded px-1.5 py-0.5 bg-secondary/50 text-muted-foreground">{mission.state||mission.status}</span>
                {retryable&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>onRetry(mission.packId)}>{busy?'Retrying…':'Retry'}</Button>}
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground mt-1.5 font-mono break-all">{mission.packId} · {mission.file} · {depLabel(mission.dependsOnKeys)}</div>
            <div className="text-[10px] text-muted-foreground mt-1">assigned: {mission.assignedTo||mission.delegation?.specialistName||'unassigned'} · platoon: {mission.delegation?.platoonId||'—'} · runtime: {mission.delegation?.runtimeType||'—'}{mission.delegation?.id?` · delegation ${mission.delegation.id}`:''}{mission.delegation?.nativeRunId?` · run ${mission.delegation.nativeRunId}`:''}</div>
            {mission.stagedPath&&<div className="text-[10px] font-mono text-emerald-400/80 mt-1 break-all">✓ staged: {mission.stagedPath}</div>}
            {escalated&&<div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 mt-2 text-[11px] text-rose-300"><div className="font-medium">Needs manual — {escalated.reason} ({escalated.category||'MANUAL_REQUIRED'}) · attempts {escalated.attempts??0}</div>{escalated.summary&&<div className="mt-0.5">{escalated.summary}</div>}{escalated.recommendedActions.length>0&&<div className="text-[10px] mt-1 text-rose-400/70">follow-ons: {escalated.recommendedActions.join(', ')}</div>}</div>}
            {mission.delegation?.errorMessage&&<div className="text-[10px] text-rose-400/80 mt-1">last error: {mission.delegation.errorMessage}</div>}
          </div>
        })}
      </div>
    </>}
  </div>
}
