import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { config, ensureDirExists } from './config'

export type AiResourceType =
  | 'repository' | 'skill-library' | 'skill' | 'tool' | 'engine' | 'knowledge'
  | 'production-pipeline' | 'utility' | 'project' | 'unknown'

export interface AiResourceRecord {
  id: string
  name: string
  path: string
  relativePath: string
  parentId: string | null
  type: AiResourceType
  score: number
  status: 'keep' | 'keep-secondary' | 'reference' | 'archive-candidate'
  primaryCapability: string
  capabilities: string[]
  description: string
  gitRemote: string | null
  modifiedAt: number
  signals: { readme: boolean; git: boolean; tests: boolean; skillManifest: boolean }
  auditStatus?: string
  autoSelectAllowed?: boolean
  manualOnly?: boolean
  preferredPlatoon?: string | null
  preferredSpecialistRole?: string | null
  integrationMode?: string | null
  runtimeRequirements?: string[]
  moveRisk?: string | null
  pathSensitive?: boolean
  supersededBy?: string[]
  usage?: string | null
  authoritative?: boolean
}

/**
 * Phase 3 — AgentOS resource selection order (canonical, from
 * the AI Arsenal routing plan). Hard gates (REJECT / archive /
 * manual-only / inaccessible runtime) are enforced before ranking.
 */
export const AI_RESOURCE_SELECTION_ORDER = [
  'required capability match',
  'preferred capability match',
  'audit status',
  'quality score',
  'specialist affinity',
  'platoon compatibility',
  'runtime/path accessibility',
  'integration mode',
  'unique value',
  'overlap policy',
] as const

export type CapabilityCoverageStatus = 'FILLED' | 'PARTIALLY_COVERED' | 'OPEN'

export interface CapabilityCoverageEntry {
  resourceId: string
  name: string
  score: number | null
  status: string
  auditStatus: string | null
  autoSelectAllowed: boolean
  manualOnly: boolean
  usage: string | null
  note: string | null
  preferredPlatoon: string | null
  preferredSpecialistRole: string | null
}

export interface CapabilityCoverage {
  capability: string
  status: CapabilityCoverageStatus
  /** Auto-selectable providers, ranked by the canonical index order + score. */
  preferred: CapabilityCoverageEntry[]
  /** Auto-selectable providers that are not the preferred pick. */
  secondary: CapabilityCoverageEntry[]
  /** Searchable/reference only — never auto-selected. */
  reference: CapabilityCoverageEntry[]
  /** Known resources that explicitly are NOT providers for this capability. */
  notProviders: string[]
  note: string | null
}

export interface AiResourceChangeState {
  scanId: string
  scanTime: string
  baselineVersion: string
  unchanged: string[]
  changed: string[]
  new: string[]
  missing: string[]
  duplicateCandidates: string[]
  supersessionCandidates: string[]
  capabilityGapMatches: string[]
  promoted: string[]
  gapNote: string
}

export interface AiReviewQueueItem {
  reviewId: string
  detectedState: string
  path: string
  probableResourceType: string | null
  probableName: string
  probableSourceRepo: string | null
  detectedCapabilities: string[]
  inferredPrimaryCapability: string | null
  coversCapabilityGaps: string[]
  likelyOverlaps: string[]
  likelyDuplicates: string[]
  currentCompetingResources: string[]
  preliminaryQualityScore: number | null
  preliminaryAgentosRelevance: string | null
  suggestedPlatoon: string | null
  suggestedSpecialistRole: string | null
  runtimePathRisks: string[]
  recommendedAction: string | null
  highPriorityGap: string | null
  readmeSnippet: string | null
  reviewStatus: string
  pending: boolean
  promotionBatchId: string | null
  approvedAt: string | null
  finalApprovedDecision: string | null
  deepReview?: {
    requiredCapability: string
    status: string
    requestedAt: string
    requestedBy: string | null
    reviewer: string | null
    taskId: number | null
    projectId: number | null
    fingerprint: string | null
    retries: number
    error: string | null
    routing: { externalAgentId?: string; agentName?: string; platoonId?: string; routingAgentName?: string } | null
    result: unknown
    proposal: Record<string, unknown> | null
    reviewCompletedAt: string | null
  }
  raw: Record<string, unknown>
}

export interface AiPromotionRecord {
  promotionBatchId: string
  approvedAt: string
  approvedResources: string[]
  previousState: Record<string, unknown> | null
  newState: Record<string, unknown> | null
  capabilitiesAdded: string[]
  capabilityChanges: string[]
  overlapChanges: string[]
  platoonMappings: string[]
  reviewerDecision: string | null
  warnings: string[]
  raw: Record<string, unknown>
}

export interface AiPlatoonMapRoleResource {
  resourceId: string
  name: string
  score: number | null
  usage: string | null
  path: string | null
  autoSelectAllowed: boolean
}

export interface AiPlatoonRole {
  role: string
  resources: AiPlatoonMapRoleResource[]
}

export interface AiPlatoonMapPlatoon {
  platoon: string
  command: string | null
  roles: AiPlatoonRole[]
}

/** Phase 12 — proposed future knowledge packs. NOT built. */
export const KNOWLEDGE_PACK_BACKLOG: Array<{ id: string; name: string; description: string; status: 'proposed' }> = [
  { id: 'kp-tactical-encounter-design-patterns', name: 'tactical-encounter-design-patterns', description: 'Reusable encounter authoring patterns (spawn pacing, unit roles, encounter budgets) for tactical-encounters work.', status: 'proposed' },
  { id: 'kp-deployment-and-spawn-schemas', name: 'deployment-and-spawn-schemas', description: 'Unit deployment / spawn table schemas for grid and hex tactical maps.', status: 'proposed' },
  { id: 'kp-terrain-and-movement-models', name: 'terrain-and-movement-models', description: 'Terrain cost, cover/elevation/LOS movement models for tactical engines.', status: 'proposed' },
  { id: 'kp-scenario-objective-patterns', name: 'scenario-objective-patterns', description: 'Scenario win/lose objective patterns (defend, escort, capture, horde) encoded as WML/ruleset templates.', status: 'proposed' },
  { id: 'kp-tactical-ai-reference', name: 'tactical-ai-reference', description: 'Reference on tactical AI decision loops (threat assessment, target selection, movement planning).', status: 'proposed' },
]

/**
 * Hard selection gate (Phase 3). REJECT / archive / manual-only
 * resources are never auto-selected; REFERENCE stays searchable only.
 */
export function isResourceAutoSelectable(resource: Pick<AiResourceRecord, 'status' | 'auditStatus' | 'manualOnly' | 'autoSelectAllowed'>): boolean {
  if (resource.manualOnly === true) return false
  if (resource.autoSelectAllowed === false) return false
  if (resource.status === 'archive-candidate') return false
  const audit = (resource.auditStatus || '').toUpperCase()
  if (audit.startsWith('REJECT')) return false
  return true
}

/**
 * Phase 4 — canonical `agentos_resources` task-metadata shape.
 * Pure mapping so routing + prompt building share one contract.
 */
export function toTaskResourceAttachment(resource: AiResourceRecord): Record<string, unknown> {
  return {
    resource_id: resource.id,
    name: resource.name,
    type: resource.type,
    path: resource.path,
    score: resource.score,
    audit_status: resource.auditStatus || resource.status,
    capabilities: resource.capabilities,
    primary_capability: resource.primaryCapability,
    usage: resource.usage || null,
    preferred_platoon: resource.preferredPlatoon || null,
    preferred_specialist_role: resource.preferredSpecialistRole || null,
    integration_mode: resource.integrationMode || null,
    runtime_requirements: resource.runtimeRequirements || [],
    authoritative: resource.authoritative === true,
  }
}

export interface AiOverlapGroup {
  capability: string
  preferredId: string
  candidateIds: string[]
  relation: 'functional-overlap'
}

export interface AiResourceRegistry {
  schemaVersion: number
  generatedAt: string
  root: string
  resources: AiResourceRecord[]
  overlapGroups: AiOverlapGroup[]
  summary: {
    repositories: number
    skills: number
    total: number
    overlapGroups: number
    keep: number
    archiveCandidates: number
  }
}

const IGNORED = new Set(['.git','node_modules','.next','dist','build','coverage','.venv','venv','__pycache__','Library','Temp','Logs'])

const CAPABILITIES: Array<[RegExp,string]> = [
  [/architect|system design|design pattern/i,'architecture'],
  [/security|audit|auth|vulnerab/i,'security'],
  [/playtest|release checklist|release readiness|quality assurance/i,'qa-release'],
  [/test|qa|regression|smoke|release|quality/i,'testing-review'],
  [/unity|gameplay|game dev|game-development/i,'game-development'],
  [/combat|fight|melee|beam|parry|counter|hitstun/i,'combat-systems'],
  [/tactical|encounter|battlefield|terrain|hazard/i,'tactical-encounters'],
  [/enemy ai|boss|behavior tree|decision-making/i,'enemy-ai'],
  [/progression|transformation|stats|experience|unlock/i,'progression-transformations'],
  [/narrative|quest|dialogue|story|lore/i,'narrative-content'],
  [/sprite|pixel art|spritesheet|animation|rig|motion|choreo/i,'art-animation'],
  [/vfx|visual effect|shader|camera|cinematic/i,'vfx-camera'],
  [/audio|music|sound|voice/i,'audio'],
  [/character design|concept art|environment concept/i,'art-direction'],
  [/storyboard|film|video|cinematography|lighting|editing/i,'creative-production'],
  [/3d|mesh|blender|triposr|trellis|hunyuan3d|instantmesh/i,'3d-generation'],
  [/agent|orchestrat|delegat|multi-agent/i,'orchestration'],
  [/mcp|model context protocol/i,'mcp'],
  [/research|paper|tutorial|awesome list|catalog|treasurebox/i,'research'],
  [/prompt/i,'prompt-engineering'],
  [/rag|vector|embedding|knowledge base|memory/i,'knowledge-management'],
  [/browser|scrap|crawl|web search/i,'web-automation'],
  [/docker|deploy|ci\/cd|devops|github actions/i,'devops'],
  [/git|repository|repo management/i,'build-repository'],
]

function clamp(value:number){ return Math.max(0,Math.min(100,Math.round(value))) }
function slug(value:string){ return value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'resource' }
function stableId(type:string,relativePath:string){
  const hash=createHash('sha1').update(relativePath.toLowerCase()).digest('hex').slice(0,10)
  return type+':'+slug(path.basename(relativePath))+':'+hash
}
function readText(filePath:string,max=16000){ try{return fs.readFileSync(filePath,'utf8').slice(0,max)}catch{return ''} }
function latestMtime(filePath:string){ try{return Math.floor(fs.statSync(filePath).mtimeMs/1000)}catch{return 0} }
function gitRemote(repoPath:string):string|null{
  const text=readText(path.join(repoPath,'.git','config'),12000)
  const match=text.match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*([^\r\n]+)/i)
  return match?.[1]?.trim() || null
}
function capabilitiesFor(text:string,name:string){
  const normalizedName=name.replace(/[-_.]+/g,' ')
  const nameTags=CAPABILITIES.filter(([pattern])=>pattern.test(normalizedName)).map(([,tag])=>tag)
  const textTags=CAPABILITIES.filter(([pattern])=>pattern.test(text)).map(([,tag])=>tag)
  const tags=[...nameTags,...textTags]
  return [...new Set(tags.length?tags:['general-ai'])]
}
function descriptionFrom(text:string,fallback:string){
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim()
    if(!line||line.startsWith('#')||line.startsWith('![')||line.startsWith('<'))continue
    const cleaned=line.replace(/[*_`>|]/g,'').trim()
    if(cleaned.length>=24)return cleaned.slice(0,280)
  }
  return fallback
}
function hasTests(root:string){
  if(['tests','test','__tests__','spec','.github'].some(name=>fs.existsSync(path.join(root,name))))return true
  for(const dir of [root,path.join(root,'scripts')]){
    let names:string[]=[]
    try{names=fs.readdirSync(dir)}catch{continue}
    if(names.some(name=>/(^|[-_.])(test|tests|smoke|validate|validation)([-_.]|$)/i.test(name)))return true
  }
  return false
}
function hasUnityProject(root:string,depth=0):boolean{
  if(depth>3)return false
  if(fs.existsSync(path.join(root,'ProjectSettings')))return true
  let entries:fs.Dirent[]=[]
  try{entries=fs.readdirSync(root,{withFileTypes:true})}catch{return false}
  return entries.some(entry=>entry.isDirectory()&&!IGNORED.has(entry.name)&&hasUnityProject(path.join(root,entry.name),depth+1))
}
function countSkillManifests(root:string,depth=0):number{
  if(depth>4)return 0
  let entries:fs.Dirent[]=[]
  try{entries=fs.readdirSync(root,{withFileTypes:true})}catch{return 0}
  let count=entries.some(entry=>entry.isFile()&&entry.name.toLowerCase()==='skill.md')?1:0
  for(const entry of entries){
    if(count>=3)break
    if(entry.isDirectory()&&!IGNORED.has(entry.name))count+=countSkillManifests(path.join(root,entry.name),depth+1)
  }
  return count
}
function inferType(root:string,text:string):AiResourceType{
  const lower=text.toLowerCase();const head=lower.slice(0,1800)
  if(/ultimate resource hub|collect practical ai|curated list|resource catalog/.test(head))return 'knowledge'
  if(countSkillManifests(root)>=3||/skill source tree|skill library|skill suite|skills inventory|modular skill/.test(lower)||fs.existsSync(path.join(root,'SKILL-SCHEMA.md')))return 'skill-library'
  if(/full-featured.*game development software|custom graphics engine|game engine developed/.test(head))return 'engine'
  if(/pipeline|production tool|asset production|production pipeline/.test(head))return 'production-pipeline'
  if(fs.existsSync(path.join(root,'SKILL.md')))return 'skill'
  if(/converter|utility|web tool/.test(head))return 'utility'
  if(/scaffold for comparing|consistent interface|benchmark/.test(head))return 'tool'
  if(hasUnityProject(root))return 'project'
  return 'repository'
}
function scoreResource(input:{type:AiResourceType;readme:boolean;git:boolean;tests:boolean;skillManifest:boolean;capabilityCount:number}){
  let score=42
  if(input.readme)score+=12
  if(input.git)score+=8
  if(input.tests)score+=9
  if(input.skillManifest)score+=15
  score+=Math.min(10,input.capabilityCount*2)
  if(input.type==='skill-library')score+=12
  if(input.type==='skill')score+=5
  if(input.type==='production-pipeline')score+=5
  if(input.type==='tool')score+=4
  if(input.type==='knowledge')score-=2
  if(input.type==='project')score-=12
  return clamp(score)
}
function statusFor(score:number,type:AiResourceType):AiResourceRecord['status']{
  if(type==='project'&&score<70)return 'archive-candidate'
  if(score>=82)return 'keep'
  if(score>=68)return 'keep-secondary'
  if(score>=48)return 'reference'
  return 'archive-candidate'
}
function makeRecord(input:{root:string;fullPath:string;parentId?:string|null;typeOverride?:AiResourceType}):AiResourceRecord{
  const rel=path.relative(input.root,input.fullPath)
  const readmePath=['README.md','README.MD','readme.md'].map(f=>path.join(input.fullPath,f)).find(fs.existsSync)
  const manifestPath=path.join(input.fullPath,'SKILL.md')
  const skillManifest=fs.existsSync(manifestPath)
  const text=skillManifest?readText(manifestPath):(readmePath?readText(readmePath):'')
  const type=input.typeOverride||inferType(input.fullPath,text)
  const caps=capabilitiesFor(text,path.basename(input.fullPath))
  const git=fs.existsSync(path.join(input.fullPath,'.git'))
  const tests=hasTests(input.fullPath)
  let score=scoreResource({type,readme:!!readmePath,git,tests,skillManifest,capabilityCount:caps.length})
  if(/beta.*2018|pyqt4|angularjs/i.test(text))score=clamp(score-30)
  return {
    id:stableId(type,rel),name:path.basename(input.fullPath),path:input.fullPath,relativePath:rel,
    parentId:input.parentId||null,type,score,status:statusFor(score,type),primaryCapability:caps[0],capabilities:caps,
    description:descriptionFrom(text,type+' resource at '+rel),gitRemote:git?gitRemote(input.fullPath):null,
    modifiedAt:latestMtime(input.fullPath),signals:{readme:!!readmePath,git,tests,skillManifest},
  }
}
function walkSkillDirs(root:string,current:string,parentId:string|null,out:AiResourceRecord[],depth=0):void{
  if(depth>6)return
  let entries:fs.Dirent[]
  try{entries=fs.readdirSync(current,{withFileTypes:true})}catch{return}
  if(entries.some(entry=>entry.isFile()&&entry.name.toLowerCase()==='skill.md')){
    out.push(makeRecord({root,fullPath:current,parentId,typeOverride:'skill'}))
    return
  }
  for(const entry of entries){
    if(!entry.isDirectory()||IGNORED.has(entry.name))continue
    walkSkillDirs(root,path.join(current,entry.name),parentId,out,depth+1)
  }
}
function addRepositoryResources(root:string,resources:AiResourceRecord[]):void{
  const reposRoot=path.join(root,'Repositories')
  if(!fs.existsSync(reposRoot))return
  for(const entry of fs.readdirSync(reposRoot,{withFileTypes:true})){
    if(!entry.isDirectory())continue
    const full=path.join(reposRoot,entry.name)
    const repo=makeRecord({root,fullPath:full})
    resources.push(repo)
    walkSkillDirs(root,full,repo.id,resources)
  }
}
function addStandaloneSkills(root:string,resources:AiResourceRecord[]):void{
  const skillRoots=[path.join(root,'.agents','skills'),path.join(root,'.claude','skills')]
  for(const skillRoot of skillRoots){
    if(fs.existsSync(skillRoot))walkSkillDirs(root,skillRoot,null,resources)
  }
}
function addKnowledge(root:string,resources:AiResourceRecord[]):void{
  const knowledge=path.join(root,'Knowledge Packets')
  if(!fs.existsSync(knowledge))return
  for(const entry of fs.readdirSync(knowledge,{withFileTypes:true})){
    const full=path.join(knowledge,entry.name)
    if(entry.isDirectory())resources.push(makeRecord({root,fullPath:full,typeOverride:'knowledge'}))
    else if(entry.isFile()){
      const rel=path.relative(root,full)
      resources.push({
        id:stableId('knowledge',rel),name:entry.name,path:full,relativePath:rel,parentId:null,type:'knowledge',
        score:55,status:'reference',primaryCapability:'knowledge-management',capabilities:['knowledge-management'],
        description:'Knowledge packet '+entry.name,gitRemote:null,modifiedAt:latestMtime(full),
        signals:{readme:false,git:false,tests:false,skillManifest:false},
      })
    }
  }
}
function buildOverlapGroups(resources:AiResourceRecord[]):AiOverlapGroup[]{
  const groups=new Map<string,AiResourceRecord[]>()
  for(const resource of resources){
    if(!['skill','utility','tool','production-pipeline'].includes(resource.type))continue
    const list=groups.get(resource.primaryCapability)||[]
    list.push(resource)
    groups.set(resource.primaryCapability,list)
  }
  const result:AiOverlapGroup[]=[]
  for(const [capability,candidates] of groups){
    if(candidates.length<2)continue
    const ranked=[...candidates].sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name))
    result.push({capability,preferredId:ranked[0].id,candidateIds:ranked.map(item=>item.id),relation:'functional-overlap'})
  }
  return result.sort((a,b)=>a.capability.localeCompare(b.capability))
}
function writeReports(registry:AiResourceRegistry):void{
  const catalogDir=path.join(registry.root,'_CATALOG')
  const reportsDir=path.join(registry.root,'_REPORTS')
  ensureDirExists(catalogDir);ensureDirExists(reportsDir)
  fs.writeFileSync(path.join(catalogDir,'scanner_registry.json'),JSON.stringify(registry,null,2))
  fs.writeFileSync(path.join(catalogDir,'scanner_overlap_groups.json'),JSON.stringify(registry.overlapGroups,null,2))
  const top=registry.resources.slice().sort((a,b)=>b.score-a.score).slice(0,25)
  const inventory=[
    '# AI Master Inventory','',
    'Generated: '+registry.generatedAt,'',
    'Resources: '+registry.summary.total+' | Repositories: '+registry.summary.repositories+' | Skills: '+registry.summary.skills,'',
    '| Score | Status | Type | Resource | Primary capability |',
    '|---:|---|---|---|---|',
    ...top.map(r=>'| '+r.score+' | '+r.status+' | '+r.type+' | '+r.name+' | '+r.primaryCapability+' |'),
    '','No files were moved, deleted, renamed, or archived by this scan.',
  ].join('\n')
  fs.writeFileSync(path.join(reportsDir,'AGENTOS_SCANNER_INVENTORY.md'),inventory)
  const overlaps=['# AI Duplicate / Overlap Analysis','']
  for(const group of registry.overlapGroups){
    const candidates=group.candidateIds.map(id=>registry.resources.find(r=>r.id===id)).filter(Boolean) as AiResourceRecord[]
    overlaps.push('## '+group.capability,'Preferred: **'+(candidates[0]?.name||group.preferredId)+'**')
    for(const resource of candidates)overlaps.push('- '+resource.name+': '+resource.score+'/100 ('+resource.status+')')
    overlaps.push('')
  }
  fs.writeFileSync(path.join(reportsDir,'AGENTOS_SCANNER_OVERLAPS.md'),overlaps.join('\n'))
}
export function scanAiVault(root=config.aiVaultRoot,write=false):AiResourceRegistry{
  if(!root||!fs.existsSync(root))throw new Error('AI vault root does not exist: '+root)
  const resources:AiResourceRecord[]=[]
  addRepositoryResources(root,resources)
  addStandaloneSkills(root,resources)
  addKnowledge(root,resources)
  const deduped=[...new Map(resources.map(resource=>[resource.id,resource])).values()]
    .sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name))
  const overlapGroups=buildOverlapGroups(deduped)
  const registry:AiResourceRegistry={
    schemaVersion:2,generatedAt:new Date().toISOString(),root,resources:deduped,overlapGroups,
    summary:{
      repositories:deduped.filter(r=>r.parentId===null&&r.relativePath.startsWith('Repositories')).length,
      skills:deduped.filter(r=>r.type==='skill').length,
      total:deduped.length,overlapGroups:overlapGroups.length,
      keep:deduped.filter(r=>r.status==='keep').length,
      archiveCandidates:deduped.filter(r=>r.status==='archive-candidate').length,
    },
  }
  if(write)writeReports(registry)
  return registry
}

export function getAiResourceRegistry(root=config.aiVaultRoot):AiResourceRegistry{
  const empty:AiResourceRegistry={schemaVersion:2,generatedAt:new Date(0).toISOString(),root,resources:[],overlapGroups:[],summary:{repositories:0,skills:0,total:0,overlapGroups:0,keep:0,archiveCandidates:0}}
  if(!root||!fs.existsSync(root))return empty
  const canonical=path.join(root,'_CATALOG','agentos_resource_registry.json')
  if(fs.existsSync(canonical)){
    try{
      const parsed=JSON.parse(fs.readFileSync(canonical,'utf8')) as any
      const resources=(Array.isArray(parsed.resources)?parsed.resources:[]).map((item:any)=>({
        id:String(item.stable_id||item.name),name:String(item.display_name||item.name||item.stable_id),path:String(item.absolute_path||''),relativePath:String(item.relative_path||''),parentId:null,
        type:item.resource_type==='skill'?'skill':item.resource_type==='skill-library'?'skill-library':item.resource_type==='engine'?'engine':item.resource_type==='production-pipeline'?'production-pipeline':item.resource_type==='knowledge-pack'||item.resource_type==='knowledge-catalog'?'knowledge':item.resource_type==='experimental-project'||item.resource_type==='legacy-project'?'project':'tool',
        score:Number(item.quality_score||0),status:String(item.audit_status).toUpperCase()==='KEEP'?'keep':String(item.audit_status).toUpperCase()==='KEEP-SECONDARY'?'keep-secondary':String(item.audit_status).toUpperCase()==='ARCHIVE-CANDIDATE'||String(item.audit_status).toUpperCase()==='REJECT-CANDIDATE'?'archive-candidate':'reference',
        primaryCapability:String(item.primary_capability||'general-ai'),capabilities:[String(item.primary_capability||'general-ai'),...(Array.isArray(item.secondary_capabilities)?item.secondary_capabilities.map(String):[])],description:String(item.notes||item.integration_mode||''),gitRemote:item.git_remote?String(item.git_remote):null,modifiedAt:0,
        signals:{readme:true,git:!!item.git_remote,tests:!!item.tests_detected,skillManifest:item.resource_type==='skill'},auditStatus:String(item.audit_status||''),autoSelectAllowed:item.auto_select_allowed===true,manualOnly:item.manual_only===true,preferredPlatoon:item.preferred_platoon?String(item.preferred_platoon):null,preferredSpecialistRole:item.preferred_specialist_role?String(item.preferred_specialist_role):null,integrationMode:item.integration_mode?String(item.integration_mode):null,runtimeRequirements:Array.isArray(item.runtime_requirements)?item.runtime_requirements.map(String):[],moveRisk:item.move_risk?String(item.move_risk):null,pathSensitive:item.path_sensitive===true,supersededBy:Array.isArray(item.superseded_by)?item.superseded_by.map(String):[],authoritative:true,
      })) as AiResourceRecord[]
      let overlapGroups:AiOverlapGroup[]=[]
      try{
        const overlapFile=path.join(root,'_CATALOG','agentos_overlap_policy.json')
        const overlap=JSON.parse(fs.readFileSync(overlapFile,'utf8')) as any
        overlapGroups=(Array.isArray(overlap.groups)?overlap.groups:[]).map((group:any)=>({capability:String(group.capability||group.group_id||'overlap'),preferredId:String(group.preferred_resource||''),candidateIds:[String(group.preferred_resource||''),...(Array.isArray(group.secondary_resources)?group.secondary_resources.map(String):[]),...(Array.isArray(group.archive_candidates)?group.archive_candidates.map(String):[]),...(Array.isArray(group.rejected_resources)?group.rejected_resources.map(String):[])].filter(Boolean),relation:'functional-overlap' as const}))
      }catch{}
      return {schemaVersion:3,generatedAt:String(parsed.generated||new Date().toISOString()),root,resources,overlapGroups,summary:{repositories:resources.filter(r=>r.parentId===null).length,skills:resources.filter(r=>r.type==='skill').length,total:resources.length,overlapGroups:overlapGroups.length,keep:resources.filter(r=>r.status==='keep').length,archiveCandidates:resources.filter(r=>r.status==='archive-candidate').length}}
    }catch{}
  }
  const file=path.join(root,'_CATALOG','scanner_registry.json')
  if(!fs.existsSync(file))return scanAiVault(root,false)
  try{const parsed=JSON.parse(fs.readFileSync(file,'utf8')) as AiResourceRegistry;if(parsed?.schemaVersion===2&&Array.isArray(parsed.resources))return parsed}catch{}
  return scanAiVault(root,false)
}

export function recommendAiResources(capabilities:string[],limit=6,root=config.aiVaultRoot):AiResourceRecord[]{
  const requested=[...new Set(capabilities.map(value=>value.trim().toLowerCase()).filter(Boolean))]
  if(requested.length===0)return []
  const registry=getAiResourceRegistry(root)
  const canonicalIndex=path.join(root,'_CATALOG','agentos_capability_index.json')
  if(fs.existsSync(canonicalIndex)){
    try{
      const parsed=JSON.parse(fs.readFileSync(canonicalIndex,'utf8')) as any
      const byId=new Map(registry.resources.map(resource=>[resource.id,resource]))
      const scored=new Map<string,{resource:AiResourceRecord;matches:number;rank:number;usage:string}>()
      for(const capability of requested){
        const entries=Array.isArray(parsed?.capabilities?.[capability])?parsed.capabilities[capability]:[]
        entries.forEach((entry:any,index:number)=>{
          if(entry.auto_select_allowed!==true)return
          const resource=byId.get(String(entry.resource_id));if(!resource)return
          if(!isResourceAutoSelectable(resource))return
          const current=scored.get(resource.id)
          const next={resource,matches:(current?.matches||0)+1,rank:(current?.rank||0)+(100-index),usage:String(entry.usage||current?.usage||'preferred')}
          scored.set(resource.id,next)
        })
      }
      return [...scored.values()].sort((a,b)=>b.matches-a.matches||b.rank-a.rank||b.resource.score-a.resource.score).slice(0,Math.max(1,Math.min(20,limit))).map(item=>({...item.resource,usage:item.usage,authoritative:true}))
    }catch{}
  }
  const wanted=new Set(requested)
  return registry.resources.filter(resource=>isResourceAutoSelectable(resource)).map(resource=>({resource,matches:resource.capabilities.filter(capability=>wanted.has(capability)).length})).filter(item=>item.matches>0).sort((a,b)=>b.matches-a.matches||b.resource.score-a.resource.score||a.resource.name.localeCompare(b.resource.name)).slice(0,Math.max(1,Math.min(20,limit))).map(item=>item.resource)
}

// ---------------------------------------------------------------------------
// Phase 6 — capability coverage (FILLED / PARTIALLY_COVERED / OPEN)
// ---------------------------------------------------------------------------

function coverageEntryFor(resource: AiResourceRecord | undefined, entry: any): CapabilityCoverageEntry | null {
  if(!resource)return null
  return {
    resourceId: resource.id,
    name: resource.name,
    score: typeof entry?.score==='number'?entry.score:resource.score,
    status: typeof entry?.status==='string'?String(entry.status):resource.status,
    auditStatus: resource.auditStatus||null,
    autoSelectAllowed: resource.autoSelectAllowed===true,
    manualOnly: resource.manualOnly===true,
    usage: entry?.usage?String(entry.usage):resource.usage||null,
    note: entry?.note?String(entry.note):null,
    preferredPlatoon: resource.preferredPlatoon||null,
    preferredSpecialistRole: resource.preferredSpecialistRole||null,
  }
}

const NOT_PROVIDER_PATTERN = /capability_provider\s*=\s*false|NOT a .{0,40}provider/i

/** Resources that explicitly declare they are NOT a provider for this capability. */
function findNotProviders(registry: AiResourceRegistry, capability: string): string[] {
  const expected = capability.toLowerCase()
  return registry.resources
    .filter(resource => !resource.capabilities.map(cap=>cap.toLowerCase()).includes(expected))
    .filter(resource => {
      const text = [resource.description, resource.usage].filter(Boolean).join(' | ').toLowerCase()
      if (NOT_PROVIDER_PATTERN.test(text)) return true
      if (text.includes(expected)) return true
      return false
    })
    .sort((a,b)=>a.name.localeCompare(b.name))
    .map(resource=>resource.name)
}

/**
 * Build canonical capability coverage from agentos_capability_index.json.
 * Status is authoritative: partial_coverage status > provider-less > OPEN gap list.
 * PARTIALLY_COVERED survives normalization exactly as Freebuff audited it.
 */
export function getAiCapabilityCoverage(root=config.aiVaultRoot): CapabilityCoverage[] {
  const registry = getAiResourceRegistry(root)
  const indexFile = path.join(root,'_CATALOG','agentos_capability_index.json')
  if(!fs.existsSync(indexFile))return []
  const parsed = JSON.parse(fs.readFileSync(indexFile,'utf8')) as any
  const capabilities: Record<string, unknown[]> = parsed?.capabilities && typeof parsed.capabilities==='object' ? parsed.capabilities : {}
  const gaps = new Set<string>(Array.isArray(parsed?.capability_gaps)?parsed.capability_gaps.map(String):[])
  const partial = parsed?.partial_coverage && typeof parsed.partial_coverage==='object' ? parsed.partial_coverage : {}
  const byId=new Map(registry.resources.map(resource=>[resource.id,resource]))
  const result: CapabilityCoverage[]=[]
  for(const [capability,rawEntries] of Object.entries(capabilities)){
    const entries=Array.isArray(rawEntries)?rawEntries as any[]:[]
    const normalized=entries.map(entry=>coverageEntryFor(byId.get(String(entry?.resource_id)),entry)).filter((entry):entry is CapabilityCoverageEntry=>entry!==null)
    const auto=normalized.filter(entry=>entry.autoSelectAllowed).sort((a,b)=>{
      const aPref=(a.usage==='preferred'?0:1),bPref=(b.usage==='preferred'?0:1)
      return aPref-bPref||(b.score??0)-(a.score??0)
    })
    const partialInfo:any = partial[capability]
    const status: CapabilityCoverageStatus = partialInfo?.status==='PARTIALLY_COVERED'
      ? 'PARTIALLY_COVERED'
      : gaps.has(capability)
        ? 'OPEN'
        : 'FILLED'
    result.push({
      capability,
      status,
      preferred: auto.filter(entry=>entry.usage==='preferred'||entry.usage===null).slice(0,1),
      secondary: auto.filter(entry=>entry.usage!=='preferred'&&entry.usage!==null),
      reference: normalized.filter(entry=>!entry.autoSelectAllowed),
      notProviders: findNotProviders(registry,capability),
      note: partialInfo?.note?String(partialInfo.note):(parsed?.gap_note?String(parsed.gap_note):null),
    })
  }
  for(const gap of gaps){
    if(capabilities[gap])continue
    result.push({capability:gap,status:'OPEN',preferred:[],secondary:[],reference:[],notProviders:[],note:String(parsed?.gap_note||'No provider registered for this capability.')})
  }
  return result.sort((a,b)=>a.capability.localeCompare(b.capability))
}

// ---------------------------------------------------------------------------
// Phase 7 — New / Changed (read-only consumption of changes file)
// ---------------------------------------------------------------------------

export function getAiResourceChanges(root=config.aiVaultRoot): AiResourceChangeState | null {
  const file=path.join(root,'_CATALOG','agentos_resource_changes.json')
  if(!fs.existsSync(file))return null
  const parsed=JSON.parse(fs.readFileSync(file,'utf8')) as any
  return {
    scanId:String(parsed.scan_id||''),
    scanTime:String(parsed.scan_time||''),
    baselineVersion:String(parsed.baseline_version||''),
    unchanged:Array.isArray(parsed.unchanged)?parsed.unchanged.map(String):[],
    changed:Array.isArray(parsed.changed)?parsed.changed.map(String):[],
    new:Array.isArray(parsed.new)?parsed.new.map(String):[],
    missing:Array.isArray(parsed.missing)?parsed.missing.map(String):[],
    duplicateCandidates:Array.isArray(parsed.duplicate_candidates)?parsed.duplicate_candidates.map(String):[],
    supersessionCandidates:Array.isArray(parsed.supersession_candidates)?parsed.supersession_candidates.map(String):[],
    capabilityGapMatches:Array.isArray(parsed.capability_gap_matches)?parsed.capability_gap_matches.map(String):[],
    promoted:Array.isArray(parsed.promoted)?parsed.promoted.map(String):[],
    gapNote:String(parsed.gap_note||''),
  }
}

// ---------------------------------------------------------------------------
// Phase 8 — Review queue (read-only consumption)
// ---------------------------------------------------------------------------

export function getAiReviewQueue(root=config.aiVaultRoot): AiReviewQueueItem[] {
  const file=path.join(root,'_CATALOG','agentos_resource_review_queue.json')
  if(!fs.existsSync(file))return []
  const parsed=JSON.parse(fs.readFileSync(file,'utf8')) as any
  if(!Array.isArray(parsed?.items))return []
  return parsed.items.map((item:any)=>({
    reviewId:String(item.review_id||item.path||'unknown'),
    detectedState:String(item.detected_state||'NEW'),
    path:String(item.path||''),
    probableResourceType:item.probable_resource_type?String(item.probable_resource_type):null,
    probableName:String(item.probable_name||item.path||'candidate'),
    probableSourceRepo:item.probable_source_repo?String(item.probable_source_repo):null,
    detectedCapabilities:Array.isArray(item.detected_capabilities)?item.detected_capabilities.map(String):[],
    inferredPrimaryCapability:item.inferred_primary_capability?String(item.inferred_primary_capability):null,
    coversCapabilityGaps:Array.isArray(item.covers_capability_gaps)?item.covers_capability_gaps.map(String):[],
    likelyOverlaps:Array.isArray(item.likely_overlaps)?item.likely_overlaps.map(String):[],
    likelyDuplicates:Array.isArray(item.likely_duplicates)?item.likely_duplicates.map(String):[],
    currentCompetingResources:Array.isArray(item.current_competing_resources)?item.current_competing_resources.map(String):[],
    preliminaryQualityScore:typeof item.preliminary_quality_score==='number'?item.preliminary_quality_score:null,
    preliminaryAgentosRelevance:item.preliminary_agentos_relevance?String(item.preliminary_agentos_relevance):null,
    suggestedPlatoon:item.suggested_platoon?String(item.suggested_platoon):null,
    suggestedSpecialistRole:item.suggested_specialist_role?String(item.suggested_specialist_role):null,
    runtimePathRisks:Array.isArray(item.runtime_path_risks)?item.runtime_path_risks.map(String):[],
    recommendedAction:item.recommended_action?String(item.recommended_action):null,
    highPriorityGap:item.high_priority_gap?String(item.high_priority_gap):null,
    readmeSnippet:item.readme_snippet?String(item.readme_snippet).slice(0,180):null,
    reviewStatus:String(item.review_status||'PENDING'),
    pending:(()=>{ const finalStates=new Set(['APPROVED','REJECTED','DISMISSED_DUPLICATE']); return item.pending!==false&&!finalStates.has(String(item.review_status||'PENDING').toUpperCase()) })(),
    promotionBatchId:item.promotion_batch_id?String(item.promotion_batch_id):null,
    approvedAt:item.approved_at?String(item.approved_at):null,
    finalApprovedDecision:item.final_approved_decision?String(item.final_approved_decision):null,
    deepReview:item.deep_review?{
      requiredCapability:String(item.deep_review.required_capability||'resource-deep-review'),
      status:String(item.deep_review.status||'QUEUED'),
      requestedAt:String(item.deep_review.requested_at||''),
      requestedBy:item.deep_review.requested_by?String(item.deep_review.requested_by):null,
      reviewer:item.deep_review.reviewer?String(item.deep_review.reviewer):null,
      taskId:typeof item.deep_review.task_id==='number'?item.deep_review.task_id:null,
      projectId:typeof item.deep_review.project_id==='number'?item.deep_review.project_id:null,
      fingerprint:item.deep_review.fingerprint?String(item.deep_review.fingerprint):null,
      retries:typeof item.deep_review.retries==='number'?item.deep_review.retries:0,
      error:item.deep_review.error?String(item.deep_review.error):null,
      routing:item.deep_review.routing&&typeof item.deep_review.routing==='object'?item.deep_review.routing:null,
      result:item.deep_review.result??null,
      proposal:item.deep_review.proposal&&typeof item.deep_review.proposal==='object'?item.deep_review.proposal:null,
      reviewCompletedAt:item.deep_review.review_completed_at?String(item.deep_review.review_completed_at):null,
    }:undefined,
    raw:item,
  }))
}

// ---------------------------------------------------------------------------
// Phase 10 — Promotion history (read-only consumption)
// ---------------------------------------------------------------------------

export function getAiPromotionHistory(root=config.aiVaultRoot): AiPromotionRecord[] {
  const file=path.join(root,'_CATALOG','agentos_promotion_history.json')
  if(!fs.existsSync(file))return []
  const parsed=JSON.parse(fs.readFileSync(file,'utf8')) as any
  if(!Array.isArray(parsed?.promotions))return []
  return parsed.promotions.map((promo:any)=>({
    promotionBatchId:String(promo.promotion_batch_id||'unknown'),
    approvedAt:String(promo.approved_at||''),
    approvedResources:Array.isArray(promo.approved_resources)?promo.approved_resources.map(String):[],
    previousState:promo.previous_state&&typeof promo.previous_state==='object'?promo.previous_state:null,
    newState:promo.new_state&&typeof promo.new_state==='object'?promo.new_state:null,
    capabilitiesAdded:Array.isArray(promo.capabilities_added)?promo.capabilities_added.map(String):[],
    capabilityChanges:Array.isArray(promo.capability_changes)?promo.capability_changes.map(String):[],
    overlapChanges:Array.isArray(promo.overlap_changes)?promo.overlap_changes.map(String):[],
    platoonMappings:Array.isArray(promo.platoon_mappings)?promo.platoon_mappings.map(String):[],
    reviewerDecision:promo.reviewer_decision?String(promo.reviewer_decision):null,
    warnings:Array.isArray(promo.warnings)?promo.warnings.map(String):[],
    raw:promo,
  }))
}

// ---------------------------------------------------------------------------
// Phase 2 — Platoon resource map (consumed by platoon commanders)
// ---------------------------------------------------------------------------

export function getAiPlatoonResourceMap(root=config.aiVaultRoot): AiPlatoonMapPlatoon[] {
  const file=path.join(root,'_CATALOG','agentos_platoon_resource_map.json')
  if(!fs.existsSync(file))return []
  const parsed=JSON.parse(fs.readFileSync(file,'utf8')) as any
  if(!Array.isArray(parsed?.platoons))return []
  return parsed.platoons.map((platoon:any)=>({
    platoon:String(platoon.platoon||''),
    command:platoon.command?String(platoon.command):null,
    roles:Array.isArray(platoon.roles)?platoon.roles.map((role:any)=>({
      role:String(role.role||''),
      resources:Array.isArray(role.resources)?role.resources.map((resource:any)=>({
        resourceId:String(resource.resource_id||''),
        name:resource.display_name?String(resource.display_name):resource.resource_id?String(resource.resource_id):'',
        score:typeof resource.score==='number'?resource.score:null,
        usage:resource.usage?String(resource.usage):null,
        path:resource.path?String(resource.path):null,
        autoSelectAllowed:resource.auto_select_allowed===true,
      })):[]
    })):[],
  }))
}

// ---------------------------------------------------------------------------
// Aggregate Arsenal state for API + UI
// ---------------------------------------------------------------------------

export function getAiArsenalState(root=config.aiVaultRoot): {
  registry: AiResourceRegistry
  capabilityCoverage: CapabilityCoverage[]
  changes: AiResourceChangeState | null
  reviewQueue: AiReviewQueueItem[]
  promotionHistory: AiPromotionRecord[]
  platoonMap: AiPlatoonMapPlatoon[]
  selectionOrder: typeof AI_RESOURCE_SELECTION_ORDER
  knowledgePackBacklog: typeof KNOWLEDGE_PACK_BACKLOG
  summary: { capabilities: number; filled: number; partiallyCovered: number; open: number; resources: number; pendingReviews: number }
} {
  const coverage=getAiCapabilityCoverage(root)
  const reviewQueue=getAiReviewQueue(root)
  return {
    registry:getAiResourceRegistry(root),
    capabilityCoverage:coverage,
    changes:getAiResourceChanges(root),
    reviewQueue,
    promotionHistory:getAiPromotionHistory(root),
    platoonMap:getAiPlatoonResourceMap(root),
    selectionOrder:AI_RESOURCE_SELECTION_ORDER,
    knowledgePackBacklog:KNOWLEDGE_PACK_BACKLOG,
    summary:{
      capabilities:coverage.length,
      filled:coverage.filter(item=>item.status==='FILLED').length,
      partiallyCovered:coverage.filter(item=>item.status==='PARTIALLY_COVERED').length,
      open:coverage.filter(item=>item.status==='OPEN').length,
      resources:getAiResourceRegistry(root).resources.length,
      pendingReviews:reviewQueue.filter(item=>item.pending).length,
    },
  }
}