/**
 * Repository for persisting {@link CompletionDigest}s to SQLite (#16).
 *
 * The `completion_digests` table stores the full digest as a JSON-serialized
 * blob alongside indexed scalar columns (`task_id`, `session_id`,
 * `completed_at`) for efficient retrieval. Because this repository is added
 * after the initial migration, it creates its own table on construction via
 * `CREATE TABLE IF NOT EXISTS` — this is self-contained and idempotent, so it
 * works against both fresh databases and existing ones without modifying the
 * shared migration files.
 */
import type Database from 'better-sqlite3';

import type { CompletionDigest } from '../../attention/completion-digest.js';
import { BaseRepository } from './base.js';

/** Database row shape for the `completion_digests` table. */
interface CompletionDigestRow {
  id: string;
  task_id: string;
  session_id: string;
  agent_id: string;
  completed_at: string;
  digest: string;
}

/** Options for listing recent digests. */
export interface ListDigestsOptions {
  /** Maximum number of digests to return (most recent first). */
  readonly limit?: number;
}

/**
 * DDL for the `completion_digests` table. Executed idempotently in the
 * constructor so the table exists without modifying shared migration files.
 */
const CREATE_TABLE_COMPLETION_DIGESTS = /* sql */ `
CREATE TABLE IF NOT EXISTS completion_digests (
  id            TEXT PRIMARY KEY NOT NULL,
  task_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  completed_at  TEXT NOT NULL,
  digest        TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const CREATE_INDEX_DIGESTS_BY_TASK = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_completion_digests_task_id
ON completion_digests(task_id);
`;

const CREATE_INDEX_DIGESTS_BY_SESSION = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_completion_digests_session_id
ON completion_digests(session_id);
`;

const CREATE_INDEX_DIGESTS_BY_COMPLETED = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_completion_digests_completed_at
ON completion_digests(completed_at DESC);
`;

/**
 * Repository for saving and retrieving completion digests.
 *
 * Usage:
 * ```ts
 * const repo = new CompletionDigestRepository(db.connection);
 * repo.save(digest);
 * const latest = repo.findByTaskId('task-42');
 * ```
 */
export class CompletionDigestRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByTaskIdStmt: Database.Statement;
  private readonly findBySessionIdStmt: Database.Statement;
  private readonly listStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    // Idempotently create the table + indexes. This avoids modifying the
    // shared schema/migration files while still ensuring the table exists.
    db.exec(CREATE_TABLE_COMPLETION_DIGESTS);
    db.exec(CREATE_INDEX_DIGESTS_BY_TASK);
    db.exec(CREATE_INDEX_DIGESTS_BY_SESSION);
    db.exec(CREATE_INDEX_DIGESTS_BY_COMPLETED);

    this.insertStmt = this.prepare(
      `INSERT INTO completion_digests (id, task_id, session_id, agent_id, completed_at, digest)
       VALUES (@id, @task_id, @session_id, @agent_id, @completed_at, @digest)`,
    );
    this.findByTaskIdStmt = this.prepare(
      'SELECT * FROM completion_digests WHERE task_id = ? ORDER BY completed_at DESC LIMIT 1',
    );
    this.findBySessionIdStmt = this.prepare(
      'SELECT * FROM completion_digests WHERE session_id = ? ORDER BY completed_at DESC LIMIT 1',
    );
    this.listStmt = this.prepare(
      'SELECT * FROM completion_digests ORDER BY completed_at DESC LIMIT ?',
    );
  }

  /**
   * Persist a completion digest. Uses a generated id derived from the task
   * and session identifiers so the same digest is not stored twice in a
   * single call (callers should check for existing entries if upsert
   * semantics are needed).
   *
   * @param digest - The completion digest to store.
   * @returns The generated row id.
   */
  save(digest: CompletionDigest): string {
    const id = `${digest.taskId}:${digest.sessionId}:${digest.completedAt}`;
    this.insertStmt.run({
      id,
      task_id: digest.taskId,
      session_id: digest.sessionId,
      agent_id: digest.agentId,
      completed_at: digest.completedAt,
      digest: this.toJson(digest),
    });
    return id;
  }

  /**
   * Retrieve the latest completion digest for a task.
   *
   * @param taskId - The Task identifier.
   * @returns The most recent digest for the task, or `null` if none exists.
   */
  findByTaskId(taskId: string): CompletionDigest | null {
    const row = this.findByTaskIdStmt.get(taskId) as CompletionDigestRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Retrieve the completion digest for a session.
   *
   * @param sessionId - The Session identifier.
   * @returns The digest for the session, or `null` if none exists.
   */
  findBySessionId(sessionId: string): CompletionDigest | null {
    const row = this.findBySessionIdStmt.get(sessionId) as CompletionDigestRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * List recent completion digests, most recent first.
   *
   * @param options - Optional limit (defaults to 50).
   * @returns An array of completion digests ordered by completion time desc.
   */
  list(options?: ListDigestsOptions): CompletionDigest[] {
    const limit = options?.limit ?? 50;
    const rows = this.listStmt.all(limit) as CompletionDigestRow[];
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: CompletionDigestRow): CompletionDigest {
    return this.fromJson<CompletionDigest>(row.digest);
  }
}
