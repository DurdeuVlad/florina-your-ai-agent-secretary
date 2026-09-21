/**
 * Repo-roots port — the core-owned outbound contract for the folders a
 * user keeps their repos in (issue #253).
 *
 * The model lives here (not in a discovery use case) so both the
 * discovery use case and the persistence adapter depend on the same
 * core-owned types, mirroring {@link PreferenceProfilePort}'s pattern
 * (DEC-037).
 */

/** One root folder Florina scans for git repos. */
export interface RepoRoot {
  readonly path: string;
}

/**
 * The user's configured repo roots (issue #253): an ordered list — order
 * is scan/search priority, so the first root's repos win any naming
 * collision and survive first when a discovery cap is hit.
 */
export interface RepoRootsConfig {
  readonly roots: readonly RepoRoot[];
}

/** True when no roots are configured (fresh install — the onboarding state). */
export function isRepoRootsEmpty(config: RepoRootsConfig): boolean {
  return config.roots.length === 0;
}

/** Raised when a repo-roots config or mutation is malformed. */
export class RepoRootsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoRootsError';
  }
}

/**
 * Durable repo-roots store. Every mutation is a single atomic,
 * identity-by-path operation applied against whatever the CURRENT
 * in-memory state is at call time — mirroring
 * {@link PreferenceProfilePort}'s `addRule`/`removeRule` shape.
 *
 * This is deliberate, not incidental: an earlier design had one
 * `setRoots(paths)` command that replaced the whole ordered list, built
 * from a client-side read-then-merge. That introduced a real lost-update
 * race (two concurrent add/remove actions could each compute a "new
 * whole list" from the same stale read and the second write would
 * silently discard the first) and let a stale precomputed row command
 * clobber unrelated concurrent edits. Atomic-by-path operations have no
 * read-then-write gap for a client to race across, and a no-op (path not
 * found, already at an edge) is safe by construction rather than
 * something a caller has to avoid triggering.
 */
export interface RepoRootsPort {
  /** Current config (immutable snapshot). */
  toConfig(): RepoRootsConfig;
  /** Append a root if not already present. Idempotent no-op if it already exists. */
  addRoot(path: string): void;
  /** Remove the root matching `path`. Returns `false` (no-op) if not found. */
  removeRoot(path: string): boolean;
  /**
   * Swap the root at `path` with its neighbor in `direction`. Returns
   * `false` (no-op) if `path` isn't found or is already at that edge.
   */
  moveRoot(path: string, direction: 'up' | 'down'): boolean;
  /** Persist the config. */
  save(): Promise<void>;
}
