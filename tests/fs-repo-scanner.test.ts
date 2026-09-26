import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { FsRepoScanner } from '../src/adapters/outbound/repos/fs-repo-scanner.js';

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function tempRoot(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'repo-scan-'));
  return dir;
}

describe('FsRepoScanner', () => {
  it('finds immediate subdirectories containing a .git entry', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'repo-a', '.git'), { recursive: true });
    await mkdir(join(root, 'repo-b', '.git'), { recursive: true });
    await mkdir(join(root, 'not-a-repo'), { recursive: true });

    const scanner = new FsRepoScanner();
    const found = scanner.listRepoDirs(root).sort();
    expect(found).toEqual([join(root, 'repo-a'), join(root, 'repo-b')].sort());
  });

  it('is shallow only -- a repo nested two levels deep is not found', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'group', 'nested-repo', '.git'), { recursive: true });

    const scanner = new FsRepoScanner();
    expect(scanner.listRepoDirs(root)).toEqual([]);
  });

  it('ignores files at the root (only directories are candidates)', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'real-repo', '.git'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'README.md'), 'not a repo', 'utf8');

    const scanner = new FsRepoScanner();
    expect(scanner.listRepoDirs(root)).toEqual([join(root, 'real-repo')]);
  });

  it('returns an empty list for a missing root rather than throwing', () => {
    const scanner = new FsRepoScanner();
    expect(scanner.listRepoDirs(join(tmpdir(), 'definitely-does-not-exist-' + Date.now()))).toEqual(
      [],
    );
  });

  it('a worktree-style .git file (not a directory) still counts as a repo', async () => {
    const root = await tempRoot();
    const worktreeDir = join(root, 'worktree-repo');
    await mkdir(worktreeDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(worktreeDir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x', 'utf8');

    const scanner = new FsRepoScanner();
    expect(scanner.listRepoDirs(root)).toEqual([worktreeDir]);
  });
});
