/**
 * Repository for the `capability_grants` table (issue #67).
 *
 * Stores durable capability grants — journaled scope records the grant
 * service auto-approves against. Grants are never deleted; revocation is a
 * `revoked_at` update (DEC-012).
 */
import type Database from 'better-sqlite3';

import type { CapabilityGrant } from '../../../../../core/domain/grants.js';
import type { CapabilityScope, CapabilityType } from '../../../../../core/domain/capabilities.js';
import type { ApprovalAuthorityLevel } from '../../../../../core/domain/enums.js';
import type { EntityId } from '../../../../../core/domain/types.js';
import { BaseRepository } from './base.js';
import type { CapabilityGrantRepositoryPort } from '../../../../../core/application/ports/outbound/repositories.js';

/** Database row shape for the `capability_grants` table. */
interface CapabilityGrantRow {
  id: string;
  project_id: string;
  task_id: string | null;
  capability: string;
  scopes: string;
  duration: string;
  granted_by: string;
  authority_level: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export class CapabilityGrantRepository
  extends BaseRepository
  implements CapabilityGrantRepositoryPort
{
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listByProjectStmt: Database.Statement;
  private readonly listByTaskStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO capability_grants (id, project_id, task_id, capability, scopes, duration,
        granted_by, authority_level, granted_at, expires_at, revoked_at)
       VALUES (@id, @project_id, @task_id, @capability, @scopes, @duration,
        @granted_by, @authority_level, @granted_at, @expires_at, @revoked_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM capability_grants WHERE id = ?');
    this.listByProjectStmt = this.prepare(
      'SELECT * FROM capability_grants WHERE project_id = ? ORDER BY rowid ASC',
    );
    this.listByTaskStmt = this.prepare(
      'SELECT * FROM capability_grants WHERE task_id = ? ORDER BY rowid ASC',
    );
    this.updateStmt = this.prepare(
      `UPDATE capability_grants SET capability = @capability, scopes = @scopes,
        duration = @duration, granted_by = @granted_by, authority_level = @authority_level,
        granted_at = @granted_at, expires_at = @expires_at, revoked_at = @revoked_at
       WHERE id = @id`,
    );
  }

  insert(grant: CapabilityGrant): void {
    this.insertStmt.run(this.toRow(grant));
  }

  getById(id: EntityId): CapabilityGrant | null {
    const row = this.getByIdStmt.get(id) as CapabilityGrantRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listByProject(projectId: EntityId): CapabilityGrant[] {
    const rows = this.listByProjectStmt.all(projectId) as CapabilityGrantRow[];
    return rows.map((r) => this.mapRow(r));
  }

  listByTask(taskId: EntityId): CapabilityGrant[] {
    const rows = this.listByTaskStmt.all(taskId) as CapabilityGrantRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(grant: CapabilityGrant): void {
    this.updateStmt.run(this.toRow(grant));
  }

  private toRow(grant: CapabilityGrant): CapabilityGrantRow {
    return {
      id: grant.id,
      project_id: grant.projectId,
      task_id: grant.taskId ?? null,
      capability: grant.capability,
      scopes: JSON.stringify(grant.scopes),
      duration: grant.duration,
      granted_by: grant.grantedBy,
      authority_level: grant.authorityLevel,
      granted_at: grant.grantedAt,
      expires_at: grant.expiresAt ?? null,
      revoked_at: grant.revokedAt ?? null,
    };
  }

  private mapRow(row: CapabilityGrantRow): CapabilityGrant {
    return {
      id: row.id,
      projectId: row.project_id,
      ...(row.task_id !== null ? { taskId: row.task_id } : {}),
      capability: row.capability as CapabilityType,
      scopes: JSON.parse(row.scopes) as CapabilityScope[],
      duration: row.duration as CapabilityGrant['duration'],
      grantedBy: row.granted_by,
      authorityLevel: row.authority_level as ApprovalAuthorityLevel,
      grantedAt: row.granted_at,
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
      ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    };
  }
}
