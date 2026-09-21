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
 * Durable repo-roots store. `load`-style construction seeds or reads the
 * config; `setRoots` replaces the whole ordered list (the desktop UI
 * always sends the full list back after the user reorders/adds/removes,
 * so there is no incremental add/remove/reorder mutation surface to keep
 * in sync -- one command, one source of truth).
 */
export interface RepoRootsPort {
  /** Current config (immutable snapshot). */
  toConfig(): RepoRootsConfig;
  /** Replace the ordered root list. Rejects empty-string or duplicate paths. */
  setRoots(paths: readonly string[]): void;
  /** Persist the config. */
  save(): Promise<void>;
}
