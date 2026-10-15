import { getDatabase } from './db'

export class QualityReviewError extends Error {
  constructor(message: string, public readonly status: number) { super(message) }
}

/** Persist a decision and its queue transition together; execution remains scheduler-gated. */
export function recordQualityReview(input: {
  taskId: number; workspaceId: number; reviewer: string; status: 'approved' | 'rejected'; notes: string
}) {
  const db = getDatabase()
  return db.transaction(() => {
    const task = db.prepare('SELECT id, title, status, assigned_to FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(input.taskId, input.workspaceId) as { id: number; title: string; status: string; assigned_to: string | null } | undefined
    if (!task) throw new QualityReviewError('Task not found', 404)
    if (!['review', 'quality_review'].includes(task.status)) {
      throw new QualityReviewError(`Task is ${task.status}; refresh the review queue before deciding`, 409)
    }
    const result = db.prepare(`INSERT INTO quality_reviews (task_id, reviewer, status, notes, workspace_id)
      VALUES (?, ?, ?, ?, ?)`).run(input.taskId, input.reviewer, input.status, input.notes, input.workspaceId)
    // Keep the original executor assignment and completed delegation intact. A new
    // delegation is created only when the scheduler authorizes and claims rework.
    const taskStatus = input.status === 'approved' ? 'done' : task.assigned_to ? 'assigned' : 'inbox'
    const error = input.status === 'rejected' ? `Quality review rejected by ${input.reviewer}: ${input.notes}` : null
    db.prepare('UPDATE tasks SET status = ?, error_message = ?, updated_at = unixepoch() WHERE id = ? AND workspace_id = ?')
      .run(taskStatus, error, input.taskId, input.workspaceId)
    return {
      id: Number(result.lastInsertRowid), taskTitle: task.title, previousStatus: task.status,
      taskStatus, reworkQueued: input.status === 'rejected' && taskStatus === 'assigned',
      needsAssignment: input.status === 'rejected' && taskStatus === 'inbox',
    }
  })()
}

/** Latest verdict only: an older rejection must not leak past a subsequent approval. */
export function latestReviewFeedback(taskId: number, workspaceId: number): string | null {
  const review = getDatabase().prepare(`SELECT reviewer, status, notes FROM quality_reviews
    WHERE task_id = ? AND workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(taskId, workspaceId) as { reviewer: string; status: string; notes: string | null } | undefined
  return review?.status === 'rejected' && review.notes ? `${review.reviewer}: ${review.notes}` : null
}
