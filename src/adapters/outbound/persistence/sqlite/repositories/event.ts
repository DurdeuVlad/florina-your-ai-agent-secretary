/**
 * Repository for the `events` table — the immutable append-only event journal
 * (DEC-012).
 *
 * This repository exposes only `insert` and read operations. There is no
 * `update` or `delete` method: the event journal is the source of truth and
 * may only grow forward. SQLite triggers (`events_no_update`,
 * `events_no_delete`) enforce this at the database level as well, so even
 * direct SQL cannot mutate existing rows.
 */
import type Database from 'better-sqlite3';

import type { EntityId, Event, SupervisorEventKind } from '../../../../../core/domain/types.js';
import { BaseRepository } from './base.js';
import type { EventJournalPort } from '../../../../../core/application/ports/outbound/repositories.js';

/** Database row shape for the `events` table. */
interface EventRow {
  id: string;
  session_id: string;
  task_id: string;
  timestamp: string;
  kind: string;
  payload: string;
}

export class EventRepository extends BaseRepository implements EventJournalPort {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listByTaskStmt: Database.Statement;
  private readonly listBySessionStmt: Database.Statement;
  private readonly listByTimestampRangeStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO events (id, session_id, task_id, timestamp, kind, payload)
       VALUES (@id, @session_id, @task_id, @timestamp, @kind, @payload)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM events WHERE id = ?');
    this.listByTaskStmt = this.prepare(
      'SELECT * FROM events WHERE task_id = ? ORDER BY timestamp ASC',
    );
    this.listBySessionStmt = this.prepare(
      'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC',
    );
    this.listByTimestampRangeStmt = this.prepare(
      'SELECT * FROM events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC',
    );
  }

  /**
   * Append a new event to the journal. This is the only write operation
   * exposed; existing events cannot be modified or removed (DEC-012).
   */
  insert(event: Event): void {
    this.insertStmt.run({
      id: event.id,
      session_id: event.sessionId,
      task_id: event.taskId,
      timestamp: event.timestamp,
      kind: event.kind,
      payload: this.toJson(event.payload),
    });
  }

  getById(id: EntityId): Event | null {
    const row = this.getByIdStmt.get(id) as EventRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Retrieve the full event stream for a task, in chronological order. */
  listByTask(taskId: EntityId): Event[] {
    const rows = this.listByTaskStmt.all(taskId) as EventRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Retrieve the full event stream for a session, in chronological order. */
  listBySession(sessionId: EntityId): Event[] {
    const rows = this.listBySessionStmt.all(sessionId) as EventRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Retrieve events within a timestamp range (inclusive), chronological. */
  listByTimestampRange(start: string, end: string): Event[] {
    const rows = this.listByTimestampRangeStmt.all(start, end) as EventRow[];
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: EventRow): Event {
    return {
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id,
      timestamp: row.timestamp,
      kind: row.kind as SupervisorEventKind,
      payload: this.fromJson<Readonly<Record<string, unknown>>>(row.payload),
    };
  }
}
