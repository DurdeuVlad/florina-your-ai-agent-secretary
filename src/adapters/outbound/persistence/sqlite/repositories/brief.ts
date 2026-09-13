/**
 * Repository for the `briefs` table (issue #69).
 *
 * Stores compiled Briefs and their confirmation record — the journaled
 * gate decision before delegation (DEC-033/012). Briefs are never
 * deleted; status moves `draft` → `confirmed` → `dispatched`.
 */
import type Database from 'better-sqlite3';

import type { Brief, BriefStatus, DelegationPlan } from '../../../../../core/domain/ideas.js';
import { BaseRepository } from './base.js';
import type { BriefRepositoryPort } from '../../../../../core/application/ports/outbound/repositories.js';

/** Database row shape for the `briefs` table. */
interface BriefRow {
  id: string;
  idea_id: string;
  title: string;
  spec: string;
  plan: string;
  status: string;
  project_id: string | null;
  created_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  dispatched_at: string | null;
}

export class BriefRepository extends BaseRepository implements BriefRepositoryPort {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listByIdeaStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO briefs (id, idea_id, title, spec, plan, status, project_id,
        created_at, confirmed_at, confirmed_by, dispatched_at)
       VALUES (@id, @idea_id, @title, @spec, @plan, @status, @project_id,
        @created_at, @confirmed_at, @confirmed_by, @dispatched_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM briefs WHERE id = ?');
    this.listByIdeaStmt = this.prepare(
      'SELECT * FROM briefs WHERE idea_id = ? ORDER BY created_at ASC',
    );
    this.listStmt = this.prepare('SELECT * FROM briefs ORDER BY created_at ASC');
    this.updateStmt = this.prepare(
      `UPDATE briefs SET title = @title, spec = @spec, plan = @plan, status = @status,
        project_id = @project_id, confirmed_at = @confirmed_at, confirmed_by = @confirmed_by,
        dispatched_at = @dispatched_at
       WHERE id = @id`,
    );
  }

  insert(brief: Brief): void {
    this.insertStmt.run(this.toRow(brief));
  }

  getById(id: string): Brief | null {
    const row = this.getByIdStmt.get(id) as BriefRow | undefined;
    return row === undefined ? null : this.fromRow(row);
  }

  listByIdea(ideaId: string): Brief[] {
    return (this.listByIdeaStmt.all(ideaId) as BriefRow[]).map((r) => this.fromRow(r));
  }

  list(): Brief[] {
    return (this.listStmt.all() as BriefRow[]).map((r) => this.fromRow(r));
  }

  update(brief: Brief): void {
    this.updateStmt.run(this.toRow(brief));
  }

  private toRow(brief: Brief): BriefRow {
    return {
      id: brief.id,
      idea_id: brief.ideaId,
      title: brief.title,
      spec: brief.spec,
      plan: JSON.stringify(brief.plan),
      status: brief.status,
      project_id: brief.plan.projectId,
      created_at: brief.createdAt,
      confirmed_at: brief.confirmedAt ?? null,
      confirmed_by: brief.confirmedBy ?? null,
      dispatched_at: brief.dispatchedAt ?? null,
    };
  }

  private fromRow(row: BriefRow): Brief {
    return {
      id: row.id,
      ideaId: row.idea_id,
      title: row.title,
      spec: row.spec,
      plan: JSON.parse(row.plan) as DelegationPlan,
      status: row.status as BriefStatus,
      createdAt: row.created_at,
      ...(row.confirmed_at !== null ? { confirmedAt: row.confirmed_at } : {}),
      ...(row.confirmed_by !== null ? { confirmedBy: row.confirmed_by } : {}),
      ...(row.dispatched_at !== null ? { dispatchedAt: row.dispatched_at } : {}),
    };
  }
}
