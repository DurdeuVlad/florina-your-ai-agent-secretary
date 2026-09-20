/**
 * Outbound port: rule/memory persistence (DEC-039, issue #191/#204).
 *
 * Mirrors the synchronous, full-object `insert`/`update` style of
 * {@link TaskRepositoryPort} and friends (`repositories.ts`) — use cases
 * build a complete {@link MemoryItem} (ids/timestamps via the existing
 * `IdGeneratorPort`/`ClockPort`) and this port persists it. Status
 * transitions (`retire`, `supersede`, conflict detection) are use-case
 * concerns (#193/#206); this port only stores and retrieves, it does not
 * enforce lifecycle rules. Never deletes — retirement is a status update
 * per DEC-012 journal discipline, so `update` is the only mutation.
 */
import type { EntityId } from '../../../domain/types.js';
import type { MemoryItem, MemoryKind, MemoryScope, MemoryStatus } from '../../../domain/memory.js';

/** Filters for {@link MemoryStorePort.list}; all fields are AND-combined. */
export interface MemoryQuery {
  readonly kind?: MemoryKind;
  readonly scope?: MemoryScope;
  readonly status?: MemoryStatus;
}

export interface MemoryStorePort {
  /** Persist a newly-created memory item. */
  insert(item: MemoryItem): void;
  /** Look up a memory item by id, or `null` when none exists. */
  getById(id: EntityId): MemoryItem | null;
  /** All memory items matching every given filter (§ 6.3 audit surface, #200). */
  list(query?: MemoryQuery): readonly MemoryItem[];
  /** Persist a status/content change to an existing item (never a delete). */
  update(item: MemoryItem): void;
}
