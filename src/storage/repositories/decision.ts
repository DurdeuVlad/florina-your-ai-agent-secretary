/**
 * Repository for the `decisions` table.
 */
import type Database from 'better-sqlite3';

import type { Decision, DecisionStatus, EntityId } from '../../domain/types.js';
import { BaseRepository } from './base.js';

/** Database row shape for the `decisions` table. */
interface DecisionRow {
  id: string;
  task_id: string;
  attention_item_id: string | null;
  question: string;
  options: string;
  answer: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
}

export class DecisionRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listByTaskStmt: Database.Statement;
  private readonly listByStatusStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO decisions (id, task_id, attention_item_id, question, options, answer, status, created_at, decided_at)
       VALUES (@id, @task_id, @attention_item_id, @question, @options, @answer, @status, @created_at, @decided_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM decisions WHERE id = ?');
    this.listByTaskStmt = this.prepare(
      'SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at ASC',
    );
    this.listByStatusStmt = this.prepare(
      'SELECT * FROM decisions WHERE status = ? ORDER BY created_at ASC',
    );
    this.updateStmt = this.prepare(
      `UPDATE decisions SET question = @question, options = @options, answer = @answer,
        status = @status, decided_at = @decided_at
       WHERE id = @id`,
    );
  }

  insert(decision: Decision): void {
    this.insertStmt.run({
      id: decision.id,
      task_id: decision.taskId,
      attention_item_id: decision.attentionItemId ?? null,
      question: decision.question,
      options: this.toJson(decision.options),
      answer: decision.answer ?? null,
      status: decision.status,
      created_at: decision.createdAt,
      decided_at: decision.decidedAt ?? null,
    });
  }

  getById(id: EntityId): Decision | null {
    const row = this.getByIdStmt.get(id) as DecisionRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listByTask(taskId: EntityId): Decision[] {
    const rows = this.listByTaskStmt.all(taskId) as DecisionRow[];
    return rows.map((r) => this.mapRow(r));
  }

  listByStatus(status: DecisionStatus): Decision[] {
    const rows = this.listByStatusStmt.all(status) as DecisionRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(decision: Decision): void {
    this.updateStmt.run({
      id: decision.id,
      question: decision.question,
      options: this.toJson(decision.options),
      answer: decision.answer ?? null,
      status: decision.status,
      decided_at: decision.decidedAt ?? null,
    });
  }

  private mapRow(row: DecisionRow): Decision {
    return {
      id: row.id,
      taskId: row.task_id,
      attentionItemId: row.attention_item_id ?? undefined,
      question: row.question,
      options: this.fromJson<string[]>(row.options),
      answer: row.answer ?? undefined,
      status: row.status as DecisionStatus,
      createdAt: row.created_at,
      decidedAt: row.decided_at ?? undefined,
    };
  }
}
