/**
 * In-memory cache of the currently active Context Capsule (DEC-020).
 *
 * The store holds exactly one active capsule at a time — the lightweight,
 * on-demand working context the Secretary reasons over. When the active
 * scope is switched away, the old capsule is discarded from memory (not
 * retained), enforcing the "context router, not blender" model (DEC-003).
 *
 * A load history is recorded so callers and tests can verify what was
 * loaded, when, and that no stale capsule lingers after a switch.
 */
import type { ContextCapsuleScope } from '../../../domain/enums.js';
import type { ContextCapsule, EntityId, ISODateString } from '../../../domain/types.js';

/**
 * A single entry in the load history. Records every set/clear event so
 * isolation can be audited after the fact.
 */
export interface LoadRecord {
  /** What happened: a capsule was loaded or cleared. */
  readonly action: 'load' | 'clear';
  /** Scope of the capsule involved (undefined for a clear with nothing loaded). */
  readonly scope?: ContextCapsuleScope;
  /** Owner id of the capsule involved. */
  readonly ownerId?: EntityId;
  /** Capsule id involved (undefined for clear). */
  readonly capsuleId?: EntityId;
  /** When the event occurred. */
  readonly at: ISODateString;
}

/**
 * In-memory store for the single active Context Capsule.
 *
 * The store is deliberately minimal: it does not cache multiple capsules
 * and it does not persist anything. Its job is to be the single source of
 * truth for "what scope is the Secretary currently reasoning over" so the
 * isolation layer can guard against cross-scope contamination.
 */
export class ContextStore {
  private active: ContextCapsule | null = null;
  private readonly history: LoadRecord[] = [];

  /** Returns the currently active capsule, or `null` if none is loaded. */
  getActive(): ContextCapsule | null {
    return this.active;
  }

  /** Whether any capsule is currently active. */
  hasActive(): boolean {
    return this.active !== null;
  }

  /** The scope of the active capsule, or `null` if none is loaded. */
  getActiveScope(): ContextCapsuleScope | null {
    return this.active?.scope ?? null;
  }

  /** The owner id of the active capsule, or `null` if none is loaded. */
  getActiveOwnerId(): EntityId | null {
    return this.active?.ownerId ?? null;
  }

  /**
   * Set the active capsule. Any previously active capsule is discarded
   * (not retained in memory) — this is the hard isolation boundary.
   */
  set(capsule: ContextCapsule): void {
    // Discard the previous capsule before installing the new one so there
    // is never a window where two capsules are reachable from the store.
    this.active = capsule;
    this.history.push({
      action: 'load',
      scope: capsule.scope,
      ownerId: capsule.ownerId,
      capsuleId: capsule.id,
      at: new Date().toISOString(),
    });
  }

  /**
   * Discard the active capsule. The old context is dropped from memory
   * entirely; it is not summarized here (summarization, when implemented,
   * happens against the immutable event journal before this call).
   */
  clear(): void {
    const prev = this.active;
    this.active = null;
    this.history.push({
      action: 'clear',
      scope: prev?.scope,
      ownerId: prev?.ownerId,
      at: new Date().toISOString(),
    });
  }

  /**
   * Returns a copy of the load history. Useful for debugging and for
   * tests that verify isolation (e.g. that a switch produced a clear
   * followed by a load of the new scope only).
   */
  getLoadHistory(): readonly LoadRecord[] {
    return [...this.history];
  }

  /** Reset the store to its initial empty state, including history. */
  reset(): void {
    this.active = null;
    this.history.length = 0;
  }
}
