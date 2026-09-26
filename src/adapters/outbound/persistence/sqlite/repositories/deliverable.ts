/**
 * Repository for the `deliverables` table.
 */
import type Database from 'better-sqlite3';

import type {
  Deliverable,
  DeliverableArtifacts,
  DeliverableType,
  EntityId,
} from '../../../../../core/domain/types.js';
import type { DeliverableRepositoryPort } from '../../../../../core/application/ports/outbound/repositories.js';
import { BaseRepository } from './base.js';

/** Database row shape for the `deliverables` table. */
interface DeliverableRow {
  id: string;
  task_id: string;
  session_id: string | null;
  type: string;
  title: string;
  description: string;
  artifacts: string;
  created_at: string;
}

export class DeliverableRepository extends BaseRepository implements DeliverableRepositoryPort {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listByTaskStmt: Database.Statement;
  private readonly listBySessionStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO deliverables (id, task_id, session_id, type, title, description, artifacts, created_at)
       VALUES (@id, @task_id, @session_id, @type, @title, @description, @artifacts, @created_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM deliverables WHERE id = ?');
    this.listByTaskStmt = this.prepare(
      'SELECT * FROM deliverables WHERE task_id = ? ORDER BY created_at ASC',
    );
    this.listBySessionStmt = this.prepare(
      'SELECT * FROM deliverables WHERE session_id = ? ORDER BY created_at ASC',
    );
    this.updateStmt = this.prepare(
      `UPDATE deliverables SET title = @title, description = @description, artifacts = @artifacts
       WHERE id = @id`,
    );
  }

  insert(deliverable: Deliverable): void {
    this.insertStmt.run({
      id: deliverable.id,
      task_id: deliverable.taskId,
      session_id: deliverable.sessionId ?? null,
      type: deliverable.type,
      title: deliverable.title,
      description: deliverable.description,
      artifacts: this.toJson(deliverable.artifacts),
      created_at: deliverable.createdAt,
    });
  }

  getById(id: EntityId): Deliverable | null {
    const row = this.getByIdStmt.get(id) as DeliverableRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listByTask(taskId: EntityId): Deliverable[] {
    const rows = this.listByTaskStmt.all(taskId) as DeliverableRow[];
    return rows.map((r) => this.mapRow(r));
  }

  listBySession(sessionId: EntityId): Deliverable[] {
    const rows = this.listBySessionStmt.all(sessionId) as DeliverableRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(deliverable: Deliverable): void {
    this.updateStmt.run({
      id: deliverable.id,
      title: deliverable.title,
      description: deliverable.description,
      artifacts: this.toJson(deliverable.artifacts),
    });
  }

  private mapRow(row: DeliverableRow): Deliverable {
    return {
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id ?? undefined,
      type: row.type as DeliverableType,
      title: row.title,
      description: row.description,
      artifacts: this.fromJson<DeliverableArtifacts>(row.artifacts),
      createdAt: row.created_at,
    };
  }
}
