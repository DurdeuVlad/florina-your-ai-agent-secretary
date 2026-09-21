/**
 * RepoRootsStore — durable repo-roots config (issue #253).
 *
 * The user's own words for "where my repos live": an ordered list of
 * folder paths, written by the desktop onboarding/Settings UI through the
 * `set-repo-roots` daemon command. The file is plain JSON, mirroring
 * {@link PreferenceProfileStore}'s load/validate/save shape.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  RepoRootsError,
  type RepoRoot,
  type RepoRootsConfig,
  type RepoRootsPort,
} from '../../../core/application/ports/outbound/repo-roots.js';

export { RepoRootsError };
export type { RepoRoot, RepoRootsConfig };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate an unknown value as a {@link RepoRootsConfig}. */
export function validateRepoRootsConfig(value: unknown): RepoRootsConfig {
  if (!isObject(value)) {
    throw new RepoRootsError('repo-roots config must be an object');
  }
  if (!Array.isArray(value['roots'])) {
    throw new RepoRootsError('repo-roots config requires a "roots" array');
  }
  for (const [i, root] of (value['roots'] as unknown[]).entries()) {
    if (!isObject(root) || typeof root['path'] !== 'string' || root['path'].length === 0) {
      throw new RepoRootsError(`roots[${i}] requires a non-empty "path"`);
    }
  }
  return { roots: value['roots'] as readonly RepoRoot[] };
}

/** File-backed repo-roots config. `load` reads (or seeds an empty) config. */
export class RepoRootsStore implements RepoRootsPort {
  private readonly path: string;
  private config: RepoRootsConfig;

  private constructor(path: string, config: RepoRootsConfig) {
    this.path = path;
    this.config = config;
  }

  /** The config file location. */
  get filePath(): string {
    return this.path;
  }

  /**
   * Load the config at `path`. A missing file seeds an empty config; a
   * malformed file throws {@link RepoRootsError}.
   */
  static async load(path: string): Promise<RepoRootsStore> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new RepoRootsStore(path, { roots: [] });
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RepoRootsError(`repo-roots file at ${path} is not valid JSON`);
    }
    return new RepoRootsStore(path, validateRepoRootsConfig(parsed));
  }

  toConfig(): RepoRootsConfig {
    return { roots: [...this.config.roots] };
  }

  /**
   * Replace the ordered root list. Blank paths are rejected; duplicate
   * paths are deduped, keeping the first (highest-priority) occurrence so
   * the caller's intended order survives.
   */
  setRoots(paths: readonly string[]): void {
    const seen = new Set<string>();
    const roots: RepoRoot[] = [];
    for (const path of paths) {
      if (path.length === 0) {
        throw new RepoRootsError('root path must be non-empty');
      }
      if (seen.has(path)) continue;
      seen.add(path);
      roots.push({ path });
    }
    this.config = { roots };
  }

  /** Persist the config to disk (pretty-printed JSON). */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.config, null, 2) + '\n', 'utf8');
  }
}
