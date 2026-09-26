/**
 * Database initialization, connection management, and migration orchestration
 * for the Florina SQLite storage layer (DEC-012, DEC-020).
 *
 * `Database` wraps a `better-sqlite3` connection, runs forward-only migrations
 * on open, and exposes a health check. The class is intentionally synchronous
 * — `better-sqlite3` is a synchronous driver, which is ideal for a local
 * daemon where blocking I/O on a local file is acceptable and keeps the code
 * simple.
 */
import Database from 'better-sqlite3';

import type { StorageHealthPort } from '../../../../core/application/ports/outbound/health.js';
import { runMigrations } from './migrations.js';

/**
 * Options for opening a database connection.
 */
export interface DatabaseOptions {
  /**
   * File path for the SQLite database. Use `:memory:` for an ephemeral
   * in-memory database (useful for tests).
   */
  readonly path: string;
  /**
   * When true, enables SQLite verbose mode (logs every SQL statement to
   * stderr). Defaults to false.
   */
  readonly verbose?: boolean;
}

/**
 * Result of a successful database open + migrate.
 */
export interface OpenResult {
  /** The highest migration version applied during open. */
  readonly appliedVersion: number;
}

/**
 * Manages a single SQLite database connection with migration support.
 *
 * Usage:
 * ```ts
 * const db = new Database({ path: './florina.db' });
 * db.open();        // runs migrations
 * db.healthCheck(); // returns true if the connection is usable
 * db.close();       // releases the connection
 * ```
 */
export class StorageDatabase implements StorageHealthPort {
  private db: Database.Database | null = null;
  private readonly options: DatabaseOptions;

  constructor(options: DatabaseOptions) {
    this.options = options;
  }

  /**
   * Open the connection and run all pending forward-only migrations.
   *
   * @returns The highest migration version applied.
   * @throws If the connection is already open or the database cannot be opened.
   */
  open(): OpenResult {
    if (this.db !== null) {
      throw new Error('Database is already open.');
    }

    const dbOptions: Database.Options = {
      verbose: this.options.verbose
        ? (message: unknown) => {
            process.stderr.write(`${String(message)}\n`);
          }
        : undefined,
    };
    this.db = new Database(this.options.path, dbOptions);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    const appliedVersion = runMigrations(this.db);
    return { appliedVersion };
  }

  /**
   * The raw `better-sqlite3` connection. Throws if the database is not open.
   */
  get connection(): Database.Database {
    if (this.db === null) {
      throw new Error('Database is not open. Call open() first.');
    }
    return this.db;
  }

  /**
   * Whether the connection is currently open.
   */
  get isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Health check: verify the connection is usable by executing a trivial
   * query. Returns true on success, false on failure.
   */
  healthCheck(): boolean {
    if (this.db === null) {
      return false;
    }
    try {
      const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number };
      return row.ok === 1;
    } catch {
      return false;
    }
  }

  /**
   * Close the connection. Safe to call multiple times; subsequent calls are
   * no-ops.
   */
  close(): void {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }
}
