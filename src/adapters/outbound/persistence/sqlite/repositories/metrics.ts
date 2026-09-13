/**
 * Repository for persisting metric snapshots to SQLite as a time-series
 * (issue #18, DEC-015).
 *
 * Each {@link MetricsSnapshot} produced by {@link MetricsCollector.snapshot}
 * is stored as a single JSON row keyed by an auto-incrementing id and a
 * timestamp. This gives a lightweight time-series that can be queried for
 * trend visualization on any of the four client surfaces without recomputing
 * from the event journal.
 *
 * The table is created on construction (`CREATE TABLE IF NOT EXISTS`) so the
 * repository is self-contained and does not require a migration entry — this
 * keeps it decoupled from the core schema migrations (DEC-012).
 */
import type Database from 'better-sqlite3';

import type { MetricsSnapshot } from '../../../../../core/application/use-cases/metrics.js';
import { BaseRepository } from './base.js';

/** Database row shape for the `metrics_snapshots` table. */
interface MetricsSnapshotRow {
  id: number;
  timestamp: string;
  payload: string;
}

/** Stored metric snapshot with its database id and timestamp. */
export interface StoredMetricsSnapshot {
  /** Auto-incrementing row id. */
  readonly id: number;
  /** ISO-8601 timestamp captured in the snapshot. */
  readonly timestamp: string;
  /** The full {@link MetricsSnapshot} payload. */
  readonly snapshot: MetricsSnapshot;
}

/** Options for listing snapshots within a time range. */
export interface ListSnapshotsOptions {
  /** Only snapshots at or after this ISO-8601 timestamp (inclusive). */
  readonly since?: string;
  /** Maximum number of snapshots to return (default 100). */
  readonly limit?: number;
}

/** SQL to create the metrics_snapshots table. */
const CREATE_TABLE_METRICS_SNAPSHOTS = /* sql */ `
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  payload   TEXT NOT NULL
);
`;

/** SQL to create an index on the timestamp column. */
const CREATE_INDEX_METRICS_SNAPSHOTS_TIMESTAMP = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_timestamp
ON metrics_snapshots(timestamp);
`;

/**
 * Repository for the `metrics_snapshots` time-series table.
 */
export class MetricsRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly listSinceStmt: Database.Statement;
  private readonly listAllStmt: Database.Statement;
  private readonly getLatestStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    // Ensure the table exists (self-contained, no migration dependency).
    db.exec(CREATE_TABLE_METRICS_SNAPSHOTS);
    db.exec(CREATE_INDEX_METRICS_SNAPSHOTS_TIMESTAMP);

    this.insertStmt = this.prepare(
      'INSERT INTO metrics_snapshots (timestamp, payload) VALUES (@timestamp, @payload)',
    );
    this.listSinceStmt = this.prepare(
      'SELECT * FROM metrics_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC LIMIT ?',
    );
    this.listAllStmt = this.prepare(
      'SELECT * FROM metrics_snapshots ORDER BY timestamp ASC LIMIT ?',
    );
    this.getLatestStmt = this.prepare(
      'SELECT * FROM metrics_snapshots ORDER BY id DESC LIMIT 1',
    );
  }

  /**
   * Persist a metric snapshot. The snapshot's `timestamp` is used as the
   * row timestamp so time-range queries align with snapshot time.
   *
   * @returns The auto-incremented row id assigned to the stored snapshot.
   */
  saveSnapshot(snapshot: MetricsSnapshot): number {
    const result = this.insertStmt.run({
      timestamp: snapshot.timestamp,
      payload: this.toJson(snapshot),
    });
    return Number(result.lastInsertRowid);
  }

  /**
   * List stored snapshots, optionally filtered to those at or after a given
   * timestamp. Results are ordered oldest-first.
   *
   * @param options - `since` filters by timestamp (inclusive); `limit` caps
   *   the result count (default 100).
   */
  listSnapshots(options: ListSnapshotsOptions = {}): StoredMetricsSnapshot[] {
    const limit = options.limit ?? 100;
    const rows: MetricsSnapshotRow[] =
      options.since !== undefined
        ? (this.listSinceStmt.all(options.since, limit) as MetricsSnapshotRow[])
        : (this.listAllStmt.all(limit) as MetricsSnapshotRow[]);
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Return the most recently stored snapshot, or `null` when none exist.
   */
  getLatestSnapshot(): StoredMetricsSnapshot | null {
    const row = this.getLatestStmt.get() as MetricsSnapshotRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Map a database row to a stored snapshot object. */
  private mapRow(row: MetricsSnapshotRow): StoredMetricsSnapshot {
    return {
      id: row.id,
      timestamp: row.timestamp,
      snapshot: this.fromJson<MetricsSnapshot>(row.payload),
    };
  }
}
