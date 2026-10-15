import Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { recordQualityReview, latestReviewFeedback } from '../quality-review'
const state = vi.hoisted(() => ({ db: null as InstanceType<typeof Database> | null }))
vi.mock('@/lib/db', () => ({ getDatabase: () => state.db }))
vi.mock('../db', () => ({ getDatabase: () => state.db }))

beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, workspace_id INTEGER, title TEXT, status TEXT, assigned_to TEXT,
    error_message TEXT, updated_at INTEGER, dispatch_attempts INTEGER DEFAULT 2);
    CREATE TABLE quality_reviews (id INTEGER PRIMARY KEY, task_id INTEGER, workspace_id INTEGER, reviewer TEXT, status TEXT, notes TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE agentos_delegations (id TEXT PRIMARY KEY, task_id INTEGER, status TEXT, result_summary TEXT);
    INSERT INTO tasks(id,workspace_id,title,status,assigned_to) VALUES(1,1,'Ship feature','review','executor');
    INSERT INTO agentos_delegations VALUES('original',1,'completed','first result');`)
})
afterEach(() => state.db?.close())
const decide = (status: 'approved' | 'rejected' = 'rejected', workspaceId = 1) => recordQualityReview({ taskId: 1, workspaceId, reviewer: 'operator', status, notes: 'Fix missing persistence' })
describe('quality review lifecycle', () => {
  it('requeues the same executor with feedback and preserves attempt history', () => {
    expect(decide()).toMatchObject({taskStatus:'assigned', reworkQueued:true, needsAssignment:false})
    expect(state.db!.prepare('SELECT assigned_to, dispatch_attempts FROM tasks').get()).toEqual({assigned_to:'executor',dispatch_attempts:2})
    expect(state.db!.prepare('SELECT * FROM agentos_delegations').get()).toEqual({id:'original',task_id:1,status:'completed',result_summary:'first result'})
    expect(latestReviewFeedback(1,1)).toBe('operator: Fix missing persistence')
  })
  it('rejects duplicate decisions once work has been queued', () => {
    decide()
    expect(() => decide()).toThrow('refresh the review queue')
    expect(state.db!.prepare('SELECT count(*) AS n FROM quality_reviews').get()).toEqual({n:1})
  })
  it('isolates decisions and feedback by workspace', () => {
    expect(() => decide('rejected',2)).toThrow('Task not found')
    decide()
    expect(latestReviewFeedback(1,2)).toBeNull()
  })
  it('returns unassigned rework to inbox without claiming it is running', () => {
    state.db!.prepare('UPDATE tasks SET assigned_to = NULL').run()
    expect(decide()).toMatchObject({taskStatus:'inbox',reworkQueued:false,needsAssignment:true})
  })
  it('approves the next review and clears obsolete feedback even within the same second', () => {
    decide()
    state.db!.prepare("UPDATE tasks SET status = 'review'").run()
    expect(decide('approved')).toMatchObject({taskStatus:'done',reworkQueued:false})
    expect(latestReviewFeedback(1,1)).toBeNull()
    expect(state.db!.prepare('SELECT error_message FROM tasks').get()).toEqual({error_message:null})
  })
  it('rolls back the verdict if the queue transition fails', () => {
    state.db!.exec("CREATE TRIGGER refuse_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'write failure'); END;")
    expect(() => decide()).toThrow('write failure')
    expect(state.db!.prepare('SELECT count(*) AS n FROM quality_reviews').get()).toEqual({n:0})
  })
})
