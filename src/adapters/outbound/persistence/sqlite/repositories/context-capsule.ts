/**
 * Repository for the `context_capsules` table (DEC-020).
 *
 * Capsules are stored as scoped rows: each Project, Task, and Session owns a
 * capsule row identified by a `(scope, owner_id)` pair. Queries filter by
 * scope + owner_id so one scope's rows are never mixed with another's
 * (strict isolation, DEC-003).
 *
 * "Load" retrieves a capsule for a given scope; "unload" removes it from
 * storage. Session capsules are ephemeral (summarized into the Task capsule
 * on completion), so unloading a session capsule is the expected cleanup
 * path. Project and Task capsules are durable but may also be unloaded if
 * explicitly removed.
 */
import type Database from 'better-sqlite3';

import type { ContextCapsuleScope } from '../../../../../core/domain/enums.js';
import type {
  ContextCapsule,
  EntityId,
  ProjectCapsuleContent,
  SessionCapsuleContent,
  TaskCapsuleContent,
} from '../../../../../core/domain/types.js';
import { BaseRepository } from './base.js';
import type { ContextCapsuleRepositoryPort } from '../../../../../core/application/ports/outbound/repositories.js';

/** Database row shape for the `context_capsules` table. */
interface CapsuleRow {
  id: string;
  scope: string;
  owner_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export class ContextCapsuleRepository extends BaseRepository implements ContextCapsuleRepositoryPort {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly loadByScopeStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly unloadByScopeStmt: Database.Statement;
  private readonly listByScopeStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO context_capsules (id, scope, owner_id, content, created_at, updated_at)
       VALUES (@id, @scope, @owner_id, @content, @created_at, @updated_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM context_capsules WHERE id = ?');
    this.loadByScopeStmt = this.prepare(
      'SELECT * FROM context_capsules WHERE scope = ? AND owner_id = ?',
    );
    this.updateStmt = this.prepare(
      `UPDATE context_capsules SET content = @content, updated_at = @updated_at
       WHERE id = @id`,
    );
    this.unloadByScopeStmt = this.prepare(
      'DELETE FROM context_capsules WHERE scope = ? AND owner_id = ?',
    );
    this.listByScopeStmt = this.prepare(
      'SELECT * FROM context_capsules WHERE scope = ? ORDER BY updated_at ASC',
    );
  }

  insert(capsule: ContextCapsule): void {
    this.insertStmt.run({
      id: capsule.id,
      scope: capsule.scope,
      owner_id: capsule.ownerId,
      content: this.toJson(capsule.content),
      created_at: capsule.createdAt,
      updated_at: capsule.updatedAt,
    });
  }

  getById(id: EntityId): ContextCapsule | null {
    const row = this.getByIdStmt.get(id) as CapsuleRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Load the capsule for a specific scope + owner. Returns `null` if no
   * capsule exists for the given scope/owner pair.
   */
  loadByScope(scope: ContextCapsuleScope, ownerId: EntityId): ContextCapsule | null {
    const row = this.loadByScopeStmt.get(scope, ownerId) as CapsuleRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** List all capsules for a given scope. */
  listByScope(scope: ContextCapsuleScope): ContextCapsule[] {
    const rows = this.listByScopeStmt.all(scope) as CapsuleRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(capsule: ContextCapsule): void {
    this.updateStmt.run({
      id: capsule.id,
      content: this.toJson(capsule.content),
      updated_at: capsule.updatedAt,
    });
  }

  /**
   * Unload (remove) the capsule for a specific scope + owner. Returns the
   * number of rows deleted (0 if no capsule existed).
   */
  unloadByScope(scope: ContextCapsuleScope, ownerId: EntityId): number {
    const info = this.unloadByScopeStmt.run(scope, ownerId);
    return info.changes;
  }

  private mapRow(row: CapsuleRow): ContextCapsule {
    const scope = row.scope as ContextCapsuleScope;
    const base = {
      id: row.id,
      scope,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    switch (scope) {
      case 'project':
        return {
          ...base,
          scope: 'project',
          content: this.fromJson<ProjectCapsuleContent>(row.content),
        };
      case 'task':
        return {
          ...base,
          scope: 'task',
          content: this.fromJson<TaskCapsuleContent>(row.content),
        };
      case 'session':
        return {
          ...base,
          scope: 'session',
          content: this.fromJson<SessionCapsuleContent>(row.content),
        };
      default: {
        // Exhaustive guard — if a new scope is added without updating this
        // switch, the runtime assert catches it.
        const _exhaustive: never = scope;
        throw new Error(`Unknown capsule scope: ${String(_exhaustive)}`);
      }
    }
  }
}
