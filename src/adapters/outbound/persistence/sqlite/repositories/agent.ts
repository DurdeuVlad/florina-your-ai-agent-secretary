/**
 * Repository for the `agents` table.
 */
import type Database from 'better-sqlite3';

import type { AdapterFidelityTier } from '../../../../../core/domain/enums.js';
import type { Agent, AgentRuntime, EntityId } from '../../../../../core/domain/types.js';
import { BaseRepository } from './base.js';

/** Database row shape for the `agents` table. */
interface AgentRow {
  id: string;
  name: string;
  provider: string;
  fidelity_tier: string;
  runtime: string;
  created_at: string;
}

export class AgentRepository extends BaseRepository {
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly listAllStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at)
       VALUES (@id, @name, @provider, @fidelity_tier, @runtime, @created_at)`,
    );
    this.getByIdStmt = this.prepare('SELECT * FROM agents WHERE id = ?');
    this.listAllStmt = this.prepare('SELECT * FROM agents ORDER BY created_at ASC');
  }

  insert(agent: Agent): void {
    this.insertStmt.run({
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      fidelity_tier: agent.fidelityTier,
      runtime: this.toJson(agent.runtime),
      created_at: agent.createdAt,
    });
  }

  getById(id: EntityId): Agent | null {
    const row = this.getByIdStmt.get(id) as AgentRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  listAll(): Agent[] {
    const rows = this.listAllStmt.all() as AgentRow[];
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: AgentRow): Agent {
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      fidelityTier: row.fidelity_tier as AdapterFidelityTier,
      runtime: this.fromJson<AgentRuntime>(row.runtime),
      createdAt: row.created_at,
    };
  }
}
