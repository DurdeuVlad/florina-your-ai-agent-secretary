/**
 * Base repository with shared helpers for mapping between domain objects and
 * SQLite rows.
 *
 * Repositories use `better-sqlite3`'s synchronous prepared statements. Each
 * repository owns a set of statements prepared once on construction and
 * reused for the lifetime of the database connection.
 */
import type Database from 'better-sqlite3';

/**
 * Base class providing the database connection reference and shared
 * JSON/boolean serialization helpers.
 */
export abstract class BaseRepository {
  protected readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Prepare a SQL statement for repeated execution. */
  protected prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  /** Serialize a value to a JSON string for storage in a TEXT column. */
  protected toJson(value: unknown): string {
    return JSON.stringify(value);
  }

  /** Parse a JSON TEXT column back into a typed value. */
  protected fromJson<T>(value: string): T {
    return JSON.parse(value) as T;
  }

  /** Convert a boolean to its 0/1 integer representation. */
  protected toBool(value: boolean): number {
    return value ? 1 : 0;
  }

  /** Convert a 0/1 integer back to a boolean. */
  protected fromBool(value: number): boolean {
    return value === 1;
  }
}
