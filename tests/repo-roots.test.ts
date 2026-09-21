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
    store.addRoot('/repos/a');
    store.addRoot('/repos/b');
    store.addRoot('/repos/c');
    await store.save();

    const reloaded = await RepoRootsStore.load(path);
    expect(reloaded.toConfig().roots.map((r) => r.path)).toEqual([
      '/repos/a',
      '/repos/b',
      '/repos/c',
    ]);
    expect(isRepoRootsEmpty(reloaded.toConfig())).toBe(false);
  });

  it('addRoot appends, it does not replace the list', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    store.addRoot('/repos/a');
    store.addRoot('/repos/b');
    store.addRoot('/repos/c');
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/a', '/repos/b', '/repos/c']);
  });

  it('addRoot is idempotent -- adding an already-configured path is a no-op', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    store.addRoot('/repos/a');
    store.addRoot('/repos/b');
    store.addRoot('/repos/a');
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/a', '/repos/b']);
  });

  it('two "concurrent" adds each atomically append -- neither is lost (regression for the read-then-write race)', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    // Simulates two callers each deciding to add a path from the same
    // starting state, without either reading the other's write first --
    // exactly the shape that a client-side read-merge-replace command
    // would lose one of under real concurrency.
    store.addRoot('/repos/a');
    store.addRoot('/repos/b');
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/a', '/repos/b']);
  });

  it('rejects a blank path', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    expect(() => store.addRoot('')).toThrow(RepoRootsError);
  });

  it('removeRoot removes the matching root and returns true; a second call is a no-op returning false', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    store.addRoot('/repos/a');
    store.addRoot('/repos/b');
    expect(store.removeRoot('/repos/a')).toBe(true);
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/b']);
    expect(store.removeRoot('/repos/a')).toBe(false);
  });

  it('removeRoot on a path that was never configured is a safe no-op', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    store.addRoot('/repos/a');
    expect(store.removeRoot('/repos/nonexistent')).toBe(false);
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/a']);
  });

  it('moveRoot swaps a root with its upstream/downstream neighbor', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    store.addRoot('/repos/a');
    store.addRoot('/repos/b');
    store.addRoot('/repos/c');
    expect(store.moveRoot('/repos/b', 'up')).toBe(true);
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/b', '/repos/a', '/repos/c']);
    expect(store.moveRoot('/repos/b', 'down')).toBe(true);
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/a', '/repos/b', '/repos/c']);
  });

  it('moveRoot at an edge (already first/last) is a safe no-op returning false', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    store.addRoot('/repos/a');
    store.addRoot('/repos/b');
    expect(store.moveRoot('/repos/a', 'up')).toBe(false);
    expect(store.moveRoot('/repos/b', 'down')).toBe(false);
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/a', '/repos/b']);
  });

  it('moveRoot on an unknown path is a safe no-op -- stale row commands cannot clobber current state', async () => {
    const store = await RepoRootsStore.load(await tempPath());
    store.addRoot('/repos/a');
    store.addRoot('/repos/b');
    // Simulates a stale row action referencing a root that was already
    // removed by a concurrent edit -- must not throw or corrupt state.
    expect(store.moveRoot('/repos/removed-already', 'up')).toBe(false);
    expect(store.toConfig().roots.map((r) => r.path)).toEqual(['/repos/a', '/repos/b']);
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
