import { getDatabase } from './db'

export interface RoutingDecision {
  id: number
  taskId: number
  projectId: number | null
  status: string
  requirements: Record<string, unknown>
  candidates: Array<Record<string, unknown>>
  selectedExternalAgentId: string | null
  selectedPlatoonId: string | null
  selectedRoutingAgentName: string | null
  reason: string | null
  actor: string | null
  createdAt: number
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
  catch { return {} }
}

function parseJsonArray(raw: string): Array<Record<string, unknown>> {
  try { const value = JSON.parse(raw); return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [] }
  catch { return [] }
}
export function listRoutingDecisions(taskId: number, workspaceId: number): RoutingDecision[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT id, task_id, project_id, status, requirements_json, candidates_json,
           selected_external_agent_id, selected_platoon_id, selected_routing_agent_name,
           reason, actor, created_at
    FROM agentos_routing_decisions
    WHERE task_id = ? AND workspace_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `).all(taskId, workspaceId) as Array<Record<string, unknown>>

  return rows.map(row => ({
    id: Number(row.id), taskId: Number(row.task_id),
    projectId: row.project_id == null ? null : Number(row.project_id),
    status: String(row.status || ''),
    requirements: parseJsonObject(String(row.requirements_json || '{}')),
    candidates: parseJsonArray(String(row.candidates_json || '[]')),
    selectedExternalAgentId: row.selected_external_agent_id ? String(row.selected_external_agent_id) : null,
    selectedPlatoonId: row.selected_platoon_id ? String(row.selected_platoon_id) : null,
    selectedRoutingAgentName: row.selected_routing_agent_name ? String(row.selected_routing_agent_name) : null,
    reason: row.reason ? String(row.reason) : null, actor: row.actor ? String(row.actor) : null,
    createdAt: Number(row.created_at),
  }))
}