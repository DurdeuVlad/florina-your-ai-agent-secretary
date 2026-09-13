/**
 * Repository for the `approvals` table.
 */
import type Database from 'better-sqlite3';

import type { ApprovalAuthorityLevel } from '../../../../../core/domain/enums.js';
import type { Approval, ApprovalScope, EntityId } from '../../../../../core/domain/types.js';
import { BaseRepository } from './base.js';
import type { ApprovalRepositoryPort } from '../../../../../core/application/ports/outbound/repositories.js';

/** Database row shape for the `approvals` table. */
interface ApprovalRow {
  id: string;
  task_id: string;
  attention_item_id: string | null;
  capability: string;
  destination: string | null;
  scope: string;
  authority_level: string;
  granted: number;
  granted_at: string | null;
  expires_at: string | null;
}

export class ApprovalRepository extends BaseRepository implements ApprovalRepositoryPort {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listByTaskStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO approvals (id, task_id, attention_item_id, capability, destination, scope,
        authority_level, granted, granted_at, expires_at)
       VALUES (@id, @task_id, @attention_item_id, @capability, @destination, @scope,
        @authority_level, @granted, @granted_at, @expires_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM approvals WHERE id = ?');
    this.listByTaskStmt = this.prepare(
      'SELECT * FROM approvals WHERE task_id = ? ORDER BY rowid ASC',
    );
    this.updateStmt = this.prepare(
      `UPDATE approvals SET capability = @capability, destination = @destination, scope = @scope,
        authority_level = @authority_level, granted = @granted, granted_at = @granted_at,
        expires_at = @expires_at
       WHERE id = @id`,
    );
  }

  insert(approval: Approval): void {
    this.insertStmt.run({
      id: approval.id,
      task_id: approval.taskId,
      attention_item_id: approval.attentionItemId ?? null,
      capability: approval.capability,
      destination: approval.destination ?? null,
      scope: approval.scope,
      authority_level: approval.authorityLevel,
      granted: this.toBool(approval.granted),
      granted_at: approval.grantedAt ?? null,
      expires_at: approval.expiresAt ?? null,
    });
  }

  getById(id: EntityId): Approval | null {
    const row = this.getByIdStmt.get(id) as ApprovalRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listByTask(taskId: EntityId): Approval[] {
    const rows = this.listByTaskStmt.all(taskId) as ApprovalRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(approval: Approval): void {
    this.updateStmt.run({
      id: approval.id,
      capability: approval.capability,
      destination: approval.destination ?? null,
      scope: approval.scope,
      authority_level: approval.authorityLevel,
      granted: this.toBool(approval.granted),
      granted_at: approval.grantedAt ?? null,
      expires_at: approval.expiresAt ?? null,
    });
  }

  private mapRow(row: ApprovalRow): Approval {
    return {
      id: row.id,
      taskId: row.task_id,
      attentionItemId: row.attention_item_id ?? undefined,
      capability: row.capability,
      destination: row.destination ?? undefined,
      scope: row.scope as ApprovalScope,
      authorityLevel: row.authority_level as ApprovalAuthorityLevel,
      granted: this.fromBool(row.granted),
      grantedAt: row.granted_at ?? undefined,
      expiresAt: row.expires_at ?? undefined,
    };
  }
}
