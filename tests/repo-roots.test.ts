import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  RepoRootsStore,
  RepoRootsError,
  validateRepoRootsConfig,
} from '../src/adapters/outbound/repos/json-repo-roots.js';
import { isRepoRootsEmpty } from '../src/core/application/ports/outbound/repo-roots.js';

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function tempPath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'repo-roots-'));
  return join(dir, 'repo-roots.json');
}

describe('RepoRootsStore', () => {
  it('seeds an empty config for a missing file', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    expect(store.toConfig()).toEqual({ roots: [] });
    expect(isRepoRootsEmpty(store.toConfig())).toBe(true);
  });

  it('round-trips an ordered root list through disk', async () => {
    const path = await tempPath();
    const store = await RepoRootsStore.load(path);
    store.setRoots(['/repos/a', '/repos/b', '/repos/c']);
    await store.save();

    const reloaded = await RepoRootsStore.load(path);
    expect(reloaded.toConfig().roots.map((r) => r.path)).toEqual([
      '/repos/a',
      '/repos/b',
      '/repos/c',
    ]);
    expect(isRepoRootsEmpty(reloaded.toConfig())).toBe(false);
  });

  it('setRoots replaces the whole list, not appends', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    store.setRoots(['/repos/a']);
    store.setRoots(['/repos/b', '/repos/c']);
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/b', '/repos/c']);
  });

  it('dedupes duplicate paths, keeping the first (highest-priority) occurrence', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    store.setRoots(['/repos/a', '/repos/b', '/repos/a']);
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/a', '/repos/b']);
  });

  it('rejects a blank path', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    expect(() => store.setRoots(['/repos/a', ''])).toThrow(RepoRootsError);
  });

  it('rejects malformed files', async () => {
    const path = await tempPath();
    await writeFile(path, '{"roots": "nope"}', 'utf8');
    await expect(RepoRootsStore.load(path)).rejects.toBeInstanceOf(RepoRootsError);
    await writeFile(path, 'not json', 'utf8');
    await expect(RepoRootsStore.load(path)).rejects.toBeInstanceOf(RepoRootsError);
    expect(() => validateRepoRootsConfig({ roots: [{ path: '' }] })).toThrow(RepoRootsError);
    expect(() => validateRepoRootsConfig('nope')).toThrow(RepoRootsError);
  });
});
