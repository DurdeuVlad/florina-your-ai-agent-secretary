/**
 * FsRepoScanner — real filesystem {@link RepoScannerPort} (issue #253).
 *
 * Shallow scan only: a root's immediate subdirectories, checked for a
 * `.git` entry (a directory for a normal clone, a file for a worktree).
 * Nested repos need their own root added explicitly -- recursing into
 * every subdirectory of a large folder tree is exactly the unbounded scan
 * {@link discoverRepos}'s cap exists to avoid, and shallow-only keeps the
 * scan itself bounded too.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { RepoScannerPort } from '../../../core/application/use-cases/repos/discover-repos.js';

export class FsRepoScanner implements RepoScannerPort {
  listRepoDirs(dir: string): readonly string[] {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (existsSync(join(path, '.git'))) out.push(path);
    }
    return out;
  }
}
