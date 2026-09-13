/**
 * Repository for the `projects` table.
 */
import type Database from 'better-sqlite3';

import type { EntityId, Project, ProjectPolicies, RepoMetadata } from '../../../../../core/domain/types.js';
import { BaseRepository } from './base.js';

/** Database row shape for the `projects` table. */
interface ProjectRow {
  id: string;
  name: string;
  repo: string;
  policies: string;
  capsule_id: string;
  created_at: string;
  updated_at: string;
}

export class ProjectRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listAllStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO projects (id, name, repo, policies, capsule_id, created_at, updated_at)
       VALUES (@id, @name, @repo, @policies, @capsule_id, @created_at, @updated_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM projects WHERE id = ?');
    this.listAllStmt = this.prepare('SELECT * FROM projects ORDER BY created_at ASC');
    this.updateStmt = this.prepare(
      `UPDATE projects SET name = @name, repo = @repo, policies = @policies,
        capsule_id = @capsule_id, updated_at = @updated_at WHERE id = @id`,
    );
  }

  insert(project: Project): void {
    this.insertStmt.run({
      id: project.id,
      name: project.name,
      repo: this.toJson(project.repo),
      policies: this.toJson(project.policies),
      capsule_id: project.capsuleId,
      created_at: project.createdAt,
      updated_at: project.updatedAt,
    });
  }

  getById(id: EntityId): Project | null {
    const row = this.getByIdStmt.get(id) as ProjectRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listAll(): Project[] {
    const rows = this.listAllStmt.all() as ProjectRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(project: Project): void {
    this.updateStmt.run({
      id: project.id,
      name: project.name,
      repo: this.toJson(project.repo),
      policies: this.toJson(project.policies),
      capsule_id: project.capsuleId,
      updated_at: project.updatedAt,
    });
  }

  private mapRow(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      repo: this.fromJson<RepoMetadata>(row.repo),
      policies: this.fromJson<ProjectPolicies>(row.policies),
      taskIds: [],
      capsuleId: row.capsule_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
