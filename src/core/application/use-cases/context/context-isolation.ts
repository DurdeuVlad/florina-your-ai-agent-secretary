/**
 * Context isolation enforcement (DEC-003, DEC-020).
 *
 * The Florina is a context router, not a blender: a loaded capsule's
 * data must never silently bleed into another scope's query. This module
 * provides the hard boundary checks that make that guarantee enforceable
 * at the call site rather than relying on prompt engineering.
 *
 * Two surfaces are exposed:
 *  - `validateScopeAccess`: a pure check that throws on mismatch.
 *  - `withContextBoundary`: a guard that wraps a query so it can only
 *    execute against the currently active scope.
 */
import type { ContextCapsuleScope } from '../../../domain/enums.js';
import type { EntityId } from '../../../domain/types.js';

/**
 * Thrown when a query requests a scope/owner that does not match the
 * currently active capsule. This is a hard isolation violation, not a
 * recoverable user error — the caller must explicitly switch scope first.
 */
export class ScopeAccessError extends Error {
  readonly requestedScope: ContextCapsuleScope;
  readonly requestedOwnerId: EntityId;
  readonly activeScope: ContextCapsuleScope | null;
  readonly activeOwnerId: EntityId | null;

  constructor(
    requestedScope: ContextCapsuleScope,
    requestedOwnerId: EntityId,
    activeScope: ContextCapsuleScope | null,
    activeOwnerId: EntityId | null,
  ) {
    const active =
      activeScope === null
        ? 'no active context'
        : `active scope ${activeScope}/${activeOwnerId}`;
    super(
      `Context isolation violation: requested ${requestedScope}/${requestedOwnerId} ` +
        `but ${active} is loaded. Switch scope explicitly before querying.`,
    );
    this.name = 'ScopeAccessError';
    this.requestedScope = requestedScope;
    this.requestedOwnerId = requestedOwnerId;
    this.activeScope = activeScope;
    this.activeOwnerId = activeOwnerId;
  }
}

/**
 * Validate that a requested scope/owner matches the currently active
 * scope/owner. Throws `ScopeAccessError` on any mismatch, including when
 * no capsule is active at all.
 *
 * Both the scope AND the owner id must match exactly — a task capsule
 * loaded for task A is not valid for a query about task B even though
 * both are `task` scope.
 */
export function validateScopeAccess(
  requestedScope: ContextCapsuleScope,
  requestedOwnerId: EntityId,
  activeScope: ContextCapsuleScope | null,
  activeOwnerId: EntityId | null,
): void {
  if (activeScope === null || activeOwnerId === null) {
    throw new ScopeAccessError(requestedScope, requestedOwnerId, null, null);
  }
  if (requestedScope !== activeScope || requestedOwnerId !== activeOwnerId) {
    throw new ScopeAccessError(requestedScope, requestedOwnerId, activeScope, activeOwnerId);
  }
}

/**
 * A query function executed inside a context boundary. It receives no
 * arguments — the caller closes over whatever it needs — and returns a
 * value of type `T`. The boundary guarantees the function only runs when
 * the active scope matches the requested scope.
 */
export type ScopedQuery<T> = () => T;

/**
 * Context boundary guard. Wraps a query so it can only execute when the
 * active scope/owner matches the requested scope/owner. On mismatch the
 * query is never run and `ScopeAccessError` is thrown — there is no
 * silent fallback to a different scope.
 *
 * Example:
 * ```ts
 * const result = withContextBoundary(
 *   store.getActiveScope(), store.getActiveOwnerId(),
 *   'task', 'task_42',
 *   () => repository.loadByScope('task', 'task_42'),
 * );
 * ```
 */
export function withContextBoundary<T>(
  activeScope: ContextCapsuleScope | null,
  activeOwnerId: EntityId | null,
  requestedScope: ContextCapsuleScope,
  requestedOwnerId: EntityId,
  query: ScopedQuery<T>,
): T {
  validateScopeAccess(requestedScope, requestedOwnerId, activeScope, activeOwnerId);
  return query();
}
