/**
 * Context Capsule routing (DEC-003, DEC-020).
 *
 * The Secretary acts as a context router: it loads the relevant Context
 * Capsule on demand when discussion enters a scope, and unloads it
 * (discards it from working memory) when switching away. Only one
 * capsule is active at a time, and the isolation layer guarantees a
 * loaded capsule's data cannot bleed into another scope's query.
 *
 * This module implements the explicit-command scope switching path only.
 * Natural-language disambiguation (DEC-025) is deferred to M5.
 */
import type { ContextCapsuleRepository } from '../storage/repositories/context-capsule.js';
import type { ContextCapsuleScope } from '../domain/enums.js';
import type { ContextCapsule, EntityId, ProjectCapsule } from '../domain/types.js';
import { ContextStore } from './context-store.js';
import { validateScopeAccess, withContextBoundary, ScopeAccessError } from './context-isolation.js';

/**
 * Minimal read surface the router needs from a capsule repository. The
 * concrete `ContextCapsuleRepository` satisfies this, and tests can
 * substitute a spy to verify exactly which storage calls were made
 * (e.g. that loading one scope does not scan the whole database).
 */
export interface CapsuleSource {
  loadByScope(scope: ContextCapsuleScope, ownerId: EntityId): ContextCapsule | null;
  listByScope(scope: ContextCapsuleScope): ContextCapsule[];
}

/**
 * Lightweight global-level awareness: which projects exist, which tasks
 * are active, and where detailed context can be retrieved. This is the
 * only place the router enumerates capsules broadly; everything else is
 * a single scoped fetch.
 */
export interface GlobalAwareness {
  /** Project capsules currently known to the Secretary. */
  readonly projects: readonly ProjectCapsule[];
}

/**
 * Result of an unload: the capsule that was active (now discarded from
 * memory), or `null` if nothing was loaded.
 */
export interface UnloadResult {
  readonly unloaded: ContextCapsule | null;
}

/**
 * The Context Router. Manages the currently active capsule scope, fetches
 * capsules on demand from storage, and enforces that queries only access
 * the active scope.
 *
 * The router owns a `ContextStore` (the in-memory cache) and reads
 * capsules from a `CapsuleSource` (the storage repository). It never
 * retains more than one capsule in memory at a time.
 */
export class ContextRouter {
  private readonly source: CapsuleSource;
  private readonly store: ContextStore;

  constructor(source: CapsuleSource, store?: ContextStore) {
    this.source = source;
    this.store = store ?? new ContextStore();
  }

  /**
   * Load the capsule for a specific scope + owner from storage and set it
   * as the active working context. Any previously active capsule is
   * discarded first (hard isolation boundary).
   *
   * Only the requested `(scope, ownerId)` row is fetched — never the
   * entire database.
   *
   * @returns The loaded capsule, or `null` if no capsule exists for the
   *   given scope/owner (in which case no capsule is active afterwards).
   */
  loadCapsule(scope: ContextCapsuleScope, ownerId: EntityId): ContextCapsule | null {
    // Discard any prior context before loading the new one so there is
    // never a window where two capsules are reachable.
    if (this.store.hasActive()) {
      this.store.clear();
    }
    const capsule = this.source.loadByScope(scope, ownerId);
    if (capsule === null) {
      return null;
    }
    this.store.set(capsule);
    return capsule;
  }

  /**
   * Unload the currently active capsule. The old context is discarded
   * from working memory (not retained). Summarization, when implemented,
   * happens against the immutable event journal before this call; here
   * we simply drop the in-memory reference.
   *
   * Note: this discards from the in-memory cache only. It does NOT
   * delete the capsule from storage — durable project/task capsules
   * remain in the database for future reloads. Storage removal is a
   * separate concern handled by the repository's `unloadByScope`.
   *
   * @returns The capsule that was unloaded, or `null` if none was active.
   */
  unloadCapsule(): UnloadResult {
    const unloaded = this.store.getActive();
    this.store.clear();
    return { unloaded };
  }

  /**
   * Switch to a new scope: unload the current capsule, then load the new
   * one. This is the explicit-command scope switching path (DEC-025 NL
   * resolution is deferred).
   *
   * @returns The newly loaded capsule, or `null` if none exists for the
   *   requested scope/owner.
   */
  switchScope(scope: ContextCapsuleScope, ownerId: EntityId): ContextCapsule | null {
    this.unloadCapsule();
    return this.loadCapsule(scope, ownerId);
  }

  /**
   * Returns the currently active capsule, or `null` if none is loaded.
   * This is the only way to obtain the working context — there is no
   * accessor for non-active capsules, so stale context cannot leak.
   */
  getActiveContext(): ContextCapsule | null {
    return this.store.getActive();
  }

  /** The scope of the active capsule, or `null` if none is loaded. */
  getActiveScope(): ContextCapsuleScope | null {
    return this.store.getActiveScope();
  }

  /** The owner id of the active capsule, or `null` if none is loaded. */
  getActiveOwnerId(): EntityId | null {
    return this.store.getActiveOwnerId();
  }

  /**
   * Global Secretary level: lightweight awareness of which projects
   * exist and where detailed context can be retrieved. This enumerates
   * project capsules only — it does not load task or session capsules
   * into working memory.
   */
  getGlobalAwareness(): GlobalAwareness {
    const all = this.source.listByScope('project');
    const projects = all.filter(
      (c): c is ProjectCapsule => c.scope === 'project',
    );
    return { projects };
  }

  /**
   * Run a query against the currently active scope. The query is only
   * executed if the active scope/owner matches the requested scope/owner;
   * otherwise `ScopeAccessError` is thrown and the query never runs.
   * This is the boundary guard that prevents silent cross-scope
   * contamination.
   */
  queryActive<T>(
    requestedScope: ContextCapsuleScope,
    requestedOwnerId: EntityId,
    query: () => T,
  ): T {
    return withContextBoundary(
      this.store.getActiveScope(),
      this.store.getActiveOwnerId(),
      requestedScope,
      requestedOwnerId,
      query,
    );
  }

  /**
   * Validate that a requested scope/owner matches the active context.
   * Throws `ScopeAccessError` on mismatch. Useful for pre-checking before
   * performing an operation that should only touch the active scope.
   */
  assertScope(requestedScope: ContextCapsuleScope, requestedOwnerId: EntityId): void {
    validateScopeAccess(
      requestedScope,
      requestedOwnerId,
      this.store.getActiveScope(),
      this.store.getActiveOwnerId(),
    );
  }

  /** The load history of the underlying store (for debugging/tests). */
  getLoadHistory() {
    return this.store.getLoadHistory();
  }
}

/**
 * Convenience factory: build a `ContextRouter` backed by a concrete
 * `ContextCapsuleRepository` and a fresh `ContextStore`.
 */
export function createContextRouter(
  repository: ContextCapsuleRepository,
): ContextRouter {
  return new ContextRouter(repository);
}

// Re-export the isolation error so callers can catch it without importing
// the isolation module separately.
export { ScopeAccessError };
