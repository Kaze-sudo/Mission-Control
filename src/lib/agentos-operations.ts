import { getDatabase } from './db'

/**
 * Internal AgentOS Operations project.
 *
 * AI Arsenal / system maintenance work (resource deep reviews, registry
 * maintenance, knowledge curation, capability acquisition, future system
 * maintenance) lives in a designated per-workspace internal project instead of
 * being attached arbitrarily to user projects. It is a normal projects row —
 * workspace-isolated and subject to the same project command state, concurrency
 * and delegation ledger as any other AgentOS work.
 */

export const AGENTOS_OPERATIONS_PROJECT_SLUG = 'agentos-operations'
export const AGENTOS_OPERATIONS_TICKET_PREFIX = 'OPS'

export interface AgentOSOperationsProject {
  id: number
  workspaceId: number
  name: string
  slug: string
  status: string
}

export function getAgentOSOperationsProject(workspaceId: number): AgentOSOperationsProject | null {
  const row = getDatabase().prepare(
    'SELECT id, workspace_id, name, slug, status FROM projects WHERE workspace_id = ? AND slug = ?',
  ).get(workspaceId, AGENTOS_OPERATIONS_PROJECT_SLUG) as any
  if (!row) return null
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
  }
}

/** Idempotent get-or-create for the internal project (workspace-scoped). */
export function getOrCreateAgentOSOperationsProject(workspaceId: number): AgentOSOperationsProject {
  const existing = getAgentOSOperationsProject(workspaceId)
  if (existing) return existing
  const db = getDatabase()
  db.prepare(`
    INSERT INTO projects (
      workspace_id, name, slug, description, ticket_prefix, ticket_counter,
      status, created_at, updated_at
    ) VALUES (?, 'AgentOS Operations', ?, ?,
              ?, 0, 'active', unixepoch(), unixepoch())
    ON CONFLICT(workspace_id, slug) DO NOTHING
  `).run(
    workspaceId,
    AGENTOS_OPERATIONS_PROJECT_SLUG,
    'Internal AgentOS operational work: resource deep reviews, registry maintenance, knowledge curation. Managed by AgentOS — do not attach user work here.',
    AGENTOS_OPERATIONS_TICKET_PREFIX,
  )
  const created = getAgentOSOperationsProject(workspaceId)
  if (!created) throw new Error('Failed to create AgentOS Operations project')
  return created
}