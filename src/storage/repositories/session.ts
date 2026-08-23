/**
 * Repository for the `sessions` table.
 */
import type Database from 'better-sqlite3';

import type { EntityId, Session, SessionStatus } from '../../domain/types.js';
import { BaseRepository } from './base.js';

/** Database row shape for the `sessions` table. */
interface SessionRow {
  id: string;
  task_id: string;
  agent_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  event_ids: string;
  deliverable_ids: string;
  capsule_id: string;
}

export class SessionRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listByTaskStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO sessions (id, task_id, agent_id, status, started_at, ended_at,
        event_ids, deliverable_ids, capsule_id)
       VALUES (@id, @task_id, @agent_id, @status, @started_at, @ended_at,
        @event_ids, @deliverable_ids, @capsule_id)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM sessions WHERE id = ?');
    this.listByTaskStmt = this.prepare(
      'SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at ASC',
    );
    this.updateStmt = this.prepare(
      `UPDATE sessions SET status = @status, ended_at = @ended_at,
        event_ids = @event_ids, deliverable_ids = @deliverable_ids, capsule_id = @capsule_id
       WHERE id = @id`,
    );
    this.deleteStmt = this.prepare('DELETE FROM sessions WHERE id = ?');
  }

  insert(session: Session): void {
    this.insertStmt.run({
      id: session.id,
      task_id: session.taskId,
      agent_id: session.agentId,
      status: session.status,
      started_at: session.startedAt,
      ended_at: session.endedAt ?? null,
      event_ids: this.toJson(session.eventIds),
      deliverable_ids: this.toJson(session.deliverableIds),
      capsule_id: session.capsuleId,
    });
  }

  getById(id: EntityId): Session | null {
    const row = this.getByIdStmt.get(id) as SessionRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listByTask(taskId: EntityId): Session[] {
    const rows = this.listByTaskStmt.all(taskId) as SessionRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(session: Session): void {
    this.updateStmt.run({
      id: session.id,
      status: session.status,
      ended_at: session.endedAt ?? null,
      event_ids: this.toJson(session.eventIds),
      deliverable_ids: this.toJson(session.deliverableIds),
      capsule_id: session.capsuleId,
    });
  }

  /**
   * Delete a session row by id.
   *
   * This will fail if any rows in the `events` table still reference the
   * session (FK constraint), so it must only be called when no journal
   * events have been written for the session — e.g. during rollback after a
   * failed `start-task` before the state machine transition appends events.
   */
  delete(id: EntityId): void {
    this.deleteStmt.run(id);
  }

  private mapRow(row: SessionRow): Session {
    return {
      id: row.id,
      taskId: row.task_id,
      agentId: row.agent_id,
      status: row.status as SessionStatus,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      eventIds: this.fromJson<EntityId[]>(row.event_ids),
      deliverableIds: this.fromJson<EntityId[]>(row.deliverable_ids),
      capsuleId: row.capsule_id,
    };
  }
}
