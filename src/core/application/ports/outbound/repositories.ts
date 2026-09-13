/**
 * Persistence repository ports — the core-owned outbound contracts for the
 * domain stores (DEC-012, DEC-020, DEC-037).
 *
 * Use cases read and mutate domain objects exclusively through these
 * interfaces; persistence adapters satisfy them and tests substitute
 * in-memory implementations. Methods are synchronous because that is the
 * current application contract — transitions and journal appends must apply
 * immediately and in-process, in a defined order, before the use case
 * proceeds.
 */
import type {
  Approval,
  ContextCapsule,
  Decision,
  EntityId,
  Event,
  Session,
  Task,
} from '../../../domain/types.js';
import type { ContextCapsuleScope } from '../../../domain/enums.js';

/** Task store (DEC-004). */
export interface TaskRepositoryPort {
  insert(task: Task): void;
  getById(id: EntityId): Task | null;
  listByProject(projectId: EntityId): Task[];
  listAll(): readonly Task[];
  update(task: Task): void;
}

/** Immutable event journal (DEC-012). */
export interface EventJournalPort {
  insert(event: Event): void;
  getById(id: EntityId): Event | null;
  listByTask(taskId: EntityId): Event[];
  listBySession(sessionId: EntityId): Event[];
  listByTimestampRange(start: string, end: string): Event[];
}

/** Approval store. */
export interface ApprovalRepositoryPort {
  insert(approval: Approval): void;
  getById(id: EntityId): Approval | null;
  listByTask(taskId: EntityId): Approval[];
  update(approval: Approval): void;
}

/** Session (run) store. */
export interface SessionRepositoryPort {
  insert(session: Session): void;
  getById(id: EntityId): Session | null;
  listByTask(taskId: EntityId): Session[];
  update(session: Session): void;
  delete(id: EntityId): void;
}

/** Context Capsule store (DEC-020). */
export interface ContextCapsuleRepositoryPort {
  insert(capsule: ContextCapsule): void;
  getById(id: EntityId): ContextCapsule | null;
  loadByScope(scope: ContextCapsuleScope, ownerId: EntityId): ContextCapsule | null;
  listByScope(scope: ContextCapsuleScope): ContextCapsule[];
  update(capsule: ContextCapsule): void;
  unloadByScope(scope: ContextCapsuleScope, ownerId: EntityId): number;
}

/** Decision Ledger store (read surface used by context resolution). */
export interface DecisionRepositoryPort {
  listByTask(taskId: EntityId): Decision[];
}

/**
 * Completion digest store (issue #16/#37). Generic over the digest type so
 * the port stays decoupled from any one digest representation.
 */
export interface CompletionDigestRepositoryPort<TDigest> {
  save(digest: TDigest): string;
  findByTaskId(taskId: string): TDigest | null;
  findBySessionId(sessionId: string): TDigest | null;
  list(options?: { readonly limit?: number }): TDigest[];
}
