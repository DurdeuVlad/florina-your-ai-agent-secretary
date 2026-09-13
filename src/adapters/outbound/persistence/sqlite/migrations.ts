/**
 * Forward-only migration framework for the Agent Secretary SQLite database.
 *
 * Migrations are an ordered, append-only list. Each migration has a unique
 * numeric `version`, a human-readable `description`, and a `run` function that
 * receives a `Database` connection and executes arbitrary DDL/DML inside a
 * transaction managed by the framework.
 *
 * The framework records applied versions in a `_migrations` bookkeeping table.
 * On `runMigrations`, only migrations with a version greater than the highest
 * applied version are executed, and each is wrapped in its own transaction so
 * a failure leaves the database in a consistent state at the last successful
 * version. Migrations are **forward-only** — there is no down/rollback path,
 * matching the issue requirement and DEC-012's immutability stance.
 */
import type Database from 'better-sqlite3';

import { SCHEMA_STATEMENTS } from './schema.js';

/**
 * A single forward-only migration.
 */
export interface Migration {
  /** Monotonically increasing version number. */
  readonly version: number;
  /** Human-readable description of what the migration does. */
  readonly description: string;
  /** Execute the migration against the given database connection. */
  readonly run: (db: Database.Database) => void;
}

/**
 * The initial migration (version 1): creates every table, index, and the
 * append-only triggers for the `events` journal.
 */
export const MIGRATION_001_INITIAL: Migration = {
  version: 1,
  description: 'Create all tables, indexes, and append-only event triggers',
  run: (db: Database.Database) => {
    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
  },
};

/**
 * Migration 2 (issue #67): the `capability_grants` table — durable,
 * journaled scope grants the grant service auto-approves against
 * (DEC-010/011). Grants are never deleted; revocation sets `revoked_at`.
 */
export const MIGRATION_002_CAPABILITY_GRANTS: Migration = {
  version: 2,
  description: 'Create the capability_grants table',
  run: (db: Database.Database) => {
    db.exec(/* sql */ `
      CREATE TABLE IF NOT EXISTS capability_grants (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        task_id         TEXT,
        capability      TEXT NOT NULL,
        scopes          TEXT NOT NULL,
        duration        TEXT NOT NULL,
        granted_by      TEXT NOT NULL,
        authority_level TEXT NOT NULL,
        granted_at      TEXT NOT NULL,
        expires_at      TEXT,
        revoked_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_capability_grants_project
        ON capability_grants (project_id);
      CREATE INDEX IF NOT EXISTS idx_capability_grants_task
        ON capability_grants (task_id);
    `);
  },
};

/**
 * The ordered list of all known migrations. New migrations are appended here
 * with an incrementing version number; the framework applies only those not
 * yet recorded in the `_migrations` table.
 */
export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_001_INITIAL,
  MIGRATION_002_CAPABILITY_GRANTS,
];

/**
 * SQL for the `_migrations` bookkeeping table that records which migration
 * versions have been applied.
 */
export const CREATE_MIGRATIONS_TABLE = /* sql */ `
CREATE TABLE IF NOT EXISTS _migrations (
  version     INTEGER PRIMARY KEY NOT NULL,
  description TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);
`;

/**
 * Run all pending forward-only migrations against the database.
 *
 * Each migration is executed in its own transaction. If a migration throws,
 * the transaction is rolled back and the error propagates — the database
 * remains at the last successfully applied version.
 *
 * @param db - An open better-sqlite3 database connection.
 * @returns The highest migration version now applied.
 */
export function runMigrations(db: Database.Database): number {
  // Ensure the bookkeeping table exists before reading/writing it.
  db.exec(CREATE_MIGRATIONS_TABLE);

  const getAppliedVersion = db.prepare('SELECT MAX(version) AS v FROM _migrations') as {
    get: () => { v: number | null };
  };

  const currentVersion = getAppliedVersion.get().v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version,
  );

  const recordMigration = db.prepare(
    'INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)',
  ) as { run: (version: number, description: string, appliedAt: string) => void };

  for (const migration of pending) {
    const tx = db.transaction(() => {
      migration.run(db);
      recordMigration.run(migration.version, migration.description, new Date().toISOString());
    });
    tx();
  }

  const finalVersion = getAppliedVersion.get().v ?? 0;
  return finalVersion;
}
