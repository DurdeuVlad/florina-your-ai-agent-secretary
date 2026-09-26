import { describe, it, expect } from 'vitest';

import {
  discoverRepos,
  searchRepos,
  MAX_DISCOVERED_REPOS,
  type RepoScannerPort,
} from '../src/core/application/use-cases/repos/discover-repos.js';
import type { RepoRootsConfig } from '../src/core/application/ports/outbound/repo-roots.js';

function fakeScanner(map: Record<string, readonly string[]>): RepoScannerPort {
  return {
    listRepoDirs: (dir) => map[dir] ?? [],
  };
}

describe('discoverRepos', () => {
  it('scans each root and returns the repos found under it, named from the path', () => {
    const config: RepoRootsConfig = { roots: [{ path: '/repos' }] };
    const scanner = fakeScanner({ '/repos': ['/repos/foo', '/repos/bar'] });
    const found = discoverRepos(config, scanner);
    expect(found).toEqual([
      { name: 'foo', path: '/repos/foo', rootPath: '/repos' },
      { name: 'bar', path: '/repos/bar', rootPath: '/repos' },
    ]);
  });

  it('scans roots in configured priority order', () => {
    const config: RepoRootsConfig = { roots: [{ path: '/b' }, { path: '/a' }] };
    const scanner = fakeScanner({ '/a': ['/a/repo1'], '/b': ['/b/repo2'] });
    const found = discoverRepos(config, scanner);
    expect(found.map((r) => r.name)).toEqual(['repo2', 'repo1']);
  });

  it('dedupes an identical repo path found under two roots, keeping the first', () => {
    const config: RepoRootsConfig = { roots: [{ path: '/a' }, { path: '/b' }] };
    // A symlinked/overlapping root could surface the same path twice.
    const scanner = fakeScanner({ '/a': ['/shared/repo'], '/b': ['/shared/repo'] });
    const found = discoverRepos(config, scanner);
    expect(found).toHaveLength(1);
    expect(found[0]!.rootPath).toBe('/a');
  });

  it('a root the scanner cannot read contributes nothing, not an error', () => {
    const config: RepoRootsConfig = { roots: [{ path: '/gone' }, { path: '/ok' }] };
    const scanner = fakeScanner({ '/ok': ['/ok/repo'] });
    const found = discoverRepos(config, scanner);
    expect(found).toEqual([{ name: 'repo', path: '/ok/repo', rootPath: '/ok' }]);
  });

  it('caps discovery at maxRepos, earlier roots winning (ponytail memory ceiling)', () => {
    const config: RepoRootsConfig = {
      roots: [{ path: '/first' }, { path: '/second' }],
    };
    const scanner = fakeScanner({
      '/first': ['/first/a', '/first/b'],
      '/second': ['/second/c', '/second/d'],
    });
    const found = discoverRepos(config, scanner, 3);
    expect(found).toHaveLength(3);
    expect(found.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('the default cap is a real, finite number', () => {
    expect(MAX_DISCOVERED_REPOS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_DISCOVERED_REPOS)).toBe(true);
  });

  it('handles a backslash-separated (Windows-style) path for the repo name', () => {
    const config: RepoRootsConfig = { roots: [{ path: 'C:\\repos' }] };
    const scanner = fakeScanner({ 'C:\\repos': ['C:\\repos\\my-app'] });
    const found = discoverRepos(config, scanner);
    expect(found[0]).toMatchObject({ name: 'my-app', path: 'C:\\repos\\my-app' });
  });
});

describe('searchRepos', () => {
  const repos = discoverRepos(
    { roots: [{ path: '/repos' }] },
    fakeScanner({ '/repos': ['/repos/agent-secretary', '/repos/website', '/repos/Agent-Tools'] }),
  );

  it('is case-insensitive and matches a substring of the name', () => {
    expect(searchRepos(repos, 'agent').map((r) => r.name)).toEqual([
      'agent-secretary',
      'Agent-Tools',
    ]);
  });

  it('an empty or blank query returns every repo unfiltered', () => {
    expect(searchRepos(repos, '')).toEqual(repos);
    expect(searchRepos(repos, '   ')).toEqual(repos);
  });

  it('a query matching nothing returns an empty list', () => {
    expect(searchRepos(repos, 'nonexistent')).toEqual([]);
  });
});
