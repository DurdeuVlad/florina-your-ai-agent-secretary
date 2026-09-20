/**
 * Outbound port: Agent Profile storage/lookup (issue #191/#196).
 * Mirrors the synchronous, full-object style of `repositories.ts`.
 */
import type { EntityId } from '../../../domain/types.js';
import type { AgentProfile } from '../../../domain/agent-profile.js';

export interface AgentProfileStorePort {
  insert(profile: AgentProfile): void;
  getById(id: EntityId): AgentProfile | null;
  listAll(): readonly AgentProfile[];
  update(profile: AgentProfile): void;
}
