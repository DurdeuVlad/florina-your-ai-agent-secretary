/**
 * Context source ports — narrow read surfaces the context use cases query
 * when routing and resolving Context Capsules (DEC-003, DEC-020, DEC-037).
 *
 * Each port is a minimal, mockable projection over a concrete repository or
 * manager; use cases never depend on storage implementations directly.
 */
import type {
  ContextCapsule,
  Decision,
  EntityId,
  Event,
  Task,
} from '../../../domain/types.js';
import type { ContextCapsuleScope } from '../../../domain/enums.js';
import type { WorktreeStatus } from './worktree.js';

/**
 * Minimal read surface the context router needs from a capsule repository.
 * The concrete `ContextCapsuleRepository` satisfies this, and tests can
 * substitute a spy to verify exactly which storage calls were made
 * (e.g. that loading one scope does not scan the whole database).
 */
export interface CapsuleSourcePort {
  loadByScope(scope: ContextCapsuleScope, ownerId: EntityId): ContextCapsule | null;
  listByScope(scope: ContextCapsuleScope): ContextCapsule[];
}

/**
 * Read surface for task metadata. The concrete `TaskRepository` satisfies
 * this.
 */
export interface TaskSourcePort {
  getById(taskId: EntityId): Task | null;
}

/**
 * Read surface for the event journal. The concrete `EventRepository`
 * satisfies this; tests can substitute a spy.
 */
export interface EventSourcePort {
  listByTask(taskId: EntityId): Event[];
}

/**
 * Read surface for decisions. The concrete `DecisionRepository` satisfies
 * this.
 */
export interface DecisionSourcePort {
  listByTask(taskId: EntityId): Decision[];
}

/**
 * Read surface for completion digests. The concrete
 * `CompletionDigestRepository` satisfies this.
 */
export interface DigestSourcePort<TDigest> {
  findByTaskId(taskId: string): TDigest | null;
  list(options?: { readonly limit?: number }): TDigest[];
}

/**
 * Read surface for worktree status. The concrete `WorktreeManager` satisfies
 * this via a thin adapter (since `WorktreeManager.worktreeStatus` takes a
 * path, not a task id).
 */
export interface WorktreeStatusSourcePort {
  /** Get the worktree status for a task, or `null` if no worktree exists. */
  getWorktreeStatus(taskId: EntityId): WorktreeStatus | null;
}
