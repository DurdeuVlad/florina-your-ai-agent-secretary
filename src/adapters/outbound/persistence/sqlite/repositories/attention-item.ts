/**
 * Repository for the `attention_items` table.
 */
import type Database from 'better-sqlite3';

import type { AttentionCategory, AttentionPriority } from '../../../../../core/domain/enums.js';
import type { AttentionItem, EntityId } from '../../../../../core/domain/types.js';
import type { AttentionRecordRepositoryPort } from '../../../../../core/application/ports/outbound/repositories.js';
import { BaseRepository } from './base.js';

/** Database row shape for the `attention_items` table. */
interface AttentionItemRow {
  id: string;
  task_id: string;
  category: string;
  priority: string;
  reason: string;
  decision_requested: string;
  affected_capability: string | null;
  suggested_safe_options: string;
  deadline: string | null;
  blocking_impact: number;
  related_event_ids: string;
  resolved: number;
  created_at: string;
}

export class AttentionItemRepository extends BaseRepository implements AttentionRecordRepositoryPort {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listByTaskStmt: Database.Statement;
  private readonly listByResolvedStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO attention_items (id, task_id, category, priority, reason, decision_requested,
        affected_capability, suggested_safe_options, deadline, blocking_impact,
        related_event_ids, resolved, created_at)
       VALUES (@id, @task_id, @category, @priority, @reason, @decision_requested,
        @affected_capability, @suggested_safe_options, @deadline, @blocking_impact,
        @related_event_ids, @resolved, @created_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM attention_items WHERE id = ?');
    this.listByTaskStmt = this.prepare(
      'SELECT * FROM attention_items WHERE task_id = ? ORDER BY created_at ASC',
    );
    this.listByResolvedStmt = this.prepare(
      'SELECT * FROM attention_items WHERE resolved = ? ORDER BY created_at ASC',
    );
    this.updateStmt = this.prepare(
      `UPDATE attention_items SET category = @category, priority = @priority, reason = @reason,
        decision_requested = @decision_requested, affected_capability = @affected_capability,
        suggested_safe_options = @suggested_safe_options, deadline = @deadline,
        blocking_impact = @blocking_impact, related_event_ids = @related_event_ids,
        resolved = @resolved
       WHERE id = @id`,
    );
  }

  insert(item: AttentionItem): void {
    this.insertStmt.run({
      id: item.id,
      task_id: item.taskId,
      category: item.category,
      priority: item.priority,
      reason: item.reason,
      decision_requested: item.decisionRequested,
      affected_capability: item.affectedCapability ?? null,
      suggested_safe_options: this.toJson(item.suggestedSafeOptions),
      deadline: item.deadline ?? null,
      blocking_impact: this.toBool(item.blockingImpact),
      related_event_ids: this.toJson(item.relatedEventIds),
      resolved: this.toBool(item.resolved),
      created_at: item.createdAt,
    });
  }

  getById(id: EntityId): AttentionItem | null {
    const row = this.getByIdStmt.get(id) as AttentionItemRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listByTask(taskId: EntityId): AttentionItem[] {
    const rows = this.listByTaskStmt.all(taskId) as AttentionItemRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** List attention items by resolved state (pass `false` for open items). */
  listByResolved(resolved: boolean): AttentionItem[] {
    const rows = this.listByResolvedStmt.all(this.toBool(resolved)) as AttentionItemRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(item: AttentionItem): void {
    this.updateStmt.run({
      id: item.id,
      category: item.category,
      priority: item.priority,
      reason: item.reason,
      decision_requested: item.decisionRequested,
      affected_capability: item.affectedCapability ?? null,
      suggested_safe_options: this.toJson(item.suggestedSafeOptions),
      deadline: item.deadline ?? null,
      blocking_impact: this.toBool(item.blockingImpact),
      related_event_ids: this.toJson(item.relatedEventIds),
      resolved: this.toBool(item.resolved),
    });
  }

  private mapRow(row: AttentionItemRow): AttentionItem {
    return {
      id: row.id,
      taskId: row.task_id,
      category: row.category as AttentionCategory,
      priority: row.priority as AttentionPriority,
      reason: row.reason,
      decisionRequested: row.decision_requested,
      affectedCapability: row.affected_capability ?? undefined,
      suggestedSafeOptions: this.fromJson<string[]>(row.suggested_safe_options),
      deadline: row.deadline ?? undefined,
      blockingImpact: this.fromBool(row.blocking_impact),
      relatedEventIds: this.fromJson<EntityId[]>(row.related_event_ids),
      resolved: this.fromBool(row.resolved),
      createdAt: row.created_at,
    };
  }
}
