/**
 * Repository for the `tasks` table.
 */
import type Database from 'better-sqlite3';

import type { EntityId, Task } from '../../../../../core/domain/types.js';
import { BaseRepository } from './base.js';
import type { TaskRepositoryPort } from '../../../../../core/application/ports/outbound/repositories.js';

/** Database row shape for the `tasks` table. */
interface TaskRow {
  id: string;
  project_id: string;
  objective: string;
  state: string;
  agent_ids: string;
  session_ids: string;
  deliverable_ids: string;
  attention_item_ids: string;
  capsule_id: string;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

export class TaskRepository extends BaseRepository implements TaskRepositoryPort {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listByProjectStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO tasks (id, project_id, objective, state, agent_ids, session_ids,
        deliverable_ids, attention_item_ids, capsule_id, worktree_path, created_at, updated_at)
       VALUES (@id, @project_id, @objective, @state, @agent_ids, @session_ids,
        @deliverable_ids, @attention_item_ids, @capsule_id, @worktree_path, @created_at, @updated_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM tasks WHERE id = ?');
    this.listByProjectStmt = this.prepare(
      'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC',
    );
    this.updateStmt = this.prepare(
      `UPDATE tasks SET objective = @objective, state = @state, agent_ids = @agent_ids,
        session_ids = @session_ids, deliverable_ids = @deliverable_ids,
        attention_item_ids = @attention_item_ids, capsule_id = @capsule_id,
        worktree_path = @worktree_path, updated_at = @updated_at
       WHERE id = @id`,
    );
  }

  insert(task: Task): void {
    this.insertStmt.run({
      id: task.id,
      project_id: task.projectId,
      objective: task.objective,
      state: task.state,
      agent_ids: this.toJson(task.agentIds),
      session_ids: this.toJson(task.sessionIds),
      deliverable_ids: this.toJson(task.deliverableIds),
      attention_item_ids: this.toJson(task.attentionItemIds),
      capsule_id: task.capsuleId,
      worktree_path: task.worktreePath ?? null,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    });
  }

  getById(id: EntityId): Task | null {
    const row = this.getByIdStmt.get(id) as TaskRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listByProject(projectId: EntityId): Task[] {
    const rows = this.listByProjectStmt.all(projectId) as TaskRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Return all tasks ordered by creation time (ascending). */
  listAll(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as TaskRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(task: Task): void {
    this.updateStmt.run({
      id: task.id,
      objective: task.objective,
      state: task.state,
      agent_ids: this.toJson(task.agentIds),
      session_ids: this.toJson(task.sessionIds),
      deliverable_ids: this.toJson(task.deliverableIds),
      attention_item_ids: this.toJson(task.attentionItemIds),
      capsule_id: task.capsuleId,
      worktree_path: task.worktreePath ?? null,
      updated_at: task.updatedAt,
    });
  }

  private mapRow(row: TaskRow): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      objective: row.objective,
      state: row.state as Task['state'],
      agentIds: this.fromJson<EntityId[]>(row.agent_ids),
      sessionIds: this.fromJson<EntityId[]>(row.session_ids),
      deliverableIds: this.fromJson<EntityId[]>(row.deliverable_ids),
      attentionItemIds: this.fromJson<EntityId[]>(row.attention_item_ids),
      capsuleId: row.capsule_id,
      worktreePath: row.worktree_path ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
