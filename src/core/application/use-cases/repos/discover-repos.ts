/**
 * Repo discovery (issue #253): walks the user's configured
 * {@link RepoRootsConfig} in priority order and returns the git repos
 * found in each root's immediate subdirectories.
 *
 * Filesystem access is behind {@link RepoScannerPort} so this stays a pure
 * core use case (DEC-037) -- the outbound `FsRepoScanner` adapter does the
 * actual `readdir`/`.git` probing.
 */
import type { RepoRootsConfig } from '../../ports/outbound/repo-roots.js';

/** A git repo found under one of the user's configured roots. */
export interface DiscoveredRepo {
  readonly name: string;
  readonly path: string;
  /** Which configured root this repo was found under. */
  readonly rootPath: string;
}

/** Outbound port: list immediate subdirectories of `dir` that look like git repos. */
export interface RepoScannerPort {
  /**
   * Absolute paths of `dir`'s immediate subdirectories containing a `.git`
   * entry. Returns `[]` (never throws) for a missing/unreadable root --
   * a configured root may be a disconnected drive or a typo, and that
   * should degrade to "no repos here", not fail discovery entirely.
   */
  listRepoDirs(dir: string): readonly string[];
}

/**
 * ponytail: memory ceiling on discovery -- an unbounded scan across many
 * large root folders could hold an unbounded repo list in memory. Roots
 * are scanned in configured (priority) order and discovery stops the
 * moment this cap is hit, so earlier roots always win. Raise if a real
 * user's repo count exceeds it.
 */
export const MAX_DISCOVERED_REPOS = 500;

/** Walk `config`'s roots in order, deduping by path, capped at `maxRepos`. */
export function discoverRepos(
  config: RepoRootsConfig,
  scanner: RepoScannerPort,
  maxRepos: number = MAX_DISCOVERED_REPOS,
): readonly DiscoveredRepo[] {
  const out: DiscoveredRepo[] = [];
  const seen = new Set<string>();
  for (const root of config.roots) {
    if (out.length >= maxRepos) break;
    for (const repoPath of scanner.listRepoDirs(root.path)) {
      if (out.length >= maxRepos) break;
      if (seen.has(repoPath)) continue;
      seen.add(repoPath);
      out.push({ name: repoNameOf(repoPath), path: repoPath, rootPath: root.path });
    }
  }
  return out;
}

/** Case-insensitive substring match on repo name -- "search for repos there". */
export function searchRepos(
  repos: readonly DiscoveredRepo[],
  query: string,
): readonly DiscoveredRepo[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return repos;
  return repos.filter((r) => r.name.toLowerCase().includes(q));
}

function repoNameOf(repoPath: string): string {
  const normalized = repoPath.replace(/[/\\]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}
