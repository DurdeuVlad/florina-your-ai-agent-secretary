/**
 * Provider project discovery and path canonicalization ports (issue #175).
 *
 * Each provider CLI (Claude Code, Codex, Devin, Antigravity) maintains its
 * own notion of projects rooted at working directories. These ports define the
 * contract for discovering those folders and normalizing paths according to
 * host OS filesystem rules so that multiple providers pointing at the same
 * directory resolve to the single canonical Florina project.
 */

/** A project discovered from an external provider's local state. */
export interface DiscoveredProviderProject {
  /** Identifier of the provider (e.g. 'claude-code', 'codex', 'devin', 'antigravity'). */
  readonly provider: string;
  /** Working directory path of the project. */
  readonly folderPath: string;
  /** Optional human-readable name or label given by the provider. */
  readonly name?: string;
  /** Optional external identifier used by the provider. */
  readonly externalId?: string;
}

/** Outbound port for discovering projects from local provider CLIs/state. */
export interface ProviderProjectScannerPort {
  /** Identifier of the provider this scanner covers. */
  readonly providerId: string;
  /** Scan local provider state files (read-only) and return discovered projects. */
  scanProjects(): Promise<readonly DiscoveredProviderProject[]> | readonly DiscoveredProviderProject[];
}

/** Outbound port for resolving canonical absolute filesystem paths. */
export interface PathCanonicalizerPort {
  /**
   * Return the canonicalized absolute path:
   * - Normalized separators (forward slashes).
   * - Trailing slashes stripped (except root `/` or Windows drive root `C:/`).
   * - Host OS case rules applied (case-folded on Windows and macOS, case-preserved on Linux).
   * - Symlinks resolved where reachable on the local filesystem.
   */
  canonicalize(rawPath: string): string;
}
