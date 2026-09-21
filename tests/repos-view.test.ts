import { describe, it, expect } from 'vitest';

import { renderReposView, encodeReposCommand } from '../src/adapters/inbound/desktop/views/repos-view.js';
import type { RepoRootsConfig } from '../src/core/application/ports/outbound/repo-roots.js';
import type { DiscoveredRepo } from '../src/core/application/use-cases/repos/discover-repos.js';
import type { RenderTree } from '../src/adapters/inbound/desktop/views/view-types.js';

function flatten(tree: RenderTree): string[] {
  const out: string[] = [];
  function walk(node: RenderTree | string): void {
    if (typeof node === 'string') return;
    out.push(node.tag);
    node.children?.forEach(walk);
  }
  walk(tree);
  return out;
}

function findByTag(tree: RenderTree, tag: string): RenderTree | undefined {
  if (tree.tag === tag) return tree;
  for (const c of tree.children ?? []) {
    if (typeof c === 'string') continue;
    const found = findByTag(c, tag);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findAllByTag(tree: RenderTree, tag: string): RenderTree[] {
  const out: RenderTree[] = [];
  function walk(node: RenderTree | string): void {
    if (typeof node === 'string') return;
    if (node.tag === tag) out.push(node);
    node.children?.forEach(walk);
  }
  walk(tree);
  return out;
}

describe('renderReposView', () => {
  it('shows an empty state plus the add-folder row when no roots are configured (onboarding)', () => {
    const tree = renderReposView({ roots: { roots: [] }, repos: [] });
    expect(flatten(tree)).toContain('EmptyState');
    const addRow = findByTag(tree, 'ReposAddRow');
    expect(addRow).toBeDefined();
    const buttons = (addRow?.children ?? []).filter(
      (c): c is RenderTree => typeof c !== 'string',
    );
    expect(buttons.map((b) => b.props?.['command'])).toEqual(['pickfolders', 'defaultfolder']);
  });

  it('renders one row per configured root, in order, with its priority number', () => {
    const roots: RepoRootsConfig = { roots: [{ path: '/repos/a' }, { path: '/repos/b' }] };
    const tree = renderReposView({ roots, repos: [] });
    const rows = findAllByTag(tree, 'ReposRootRow');
    expect(rows.map((r) => r.props?.['path'])).toEqual(['/repos/a', '/repos/b']);
    expect(rows.map((r) => r.props?.['priority'])).toEqual([0, 1]);
  });

  it('the first root has no move-up button, the last has no move-down button', () => {
    const roots: RepoRootsConfig = {
      roots: [{ path: '/a' }, { path: '/b' }, { path: '/c' }],
    };
    const tree = renderReposView({ roots, repos: [] });
    const rows = findAllByTag(tree, 'ReposRootRow');
    const buttonLabels = (row: RenderTree): string[] =>
      findAllByTag(row, 'Button').map((b) => (typeof b.children?.[0] === 'string' ? b.children[0] : ''));
    expect(buttonLabels(rows[0]!)).toEqual(['↓', 'Remove']);
    expect(buttonLabels(rows[1]!)).toEqual(['↑', '↓', 'Remove']);
    expect(buttonLabels(rows[2]!)).toEqual(['↑', 'Remove']);
  });

  it('move-down on the first root is an atomic move-repo-root command identified by its own path', () => {
    const roots: RepoRootsConfig = { roots: [{ path: '/a' }, { path: '/b' }] };
    const tree = renderReposView({ roots, repos: [] });
    const [firstRow] = findAllByTag(tree, 'ReposRootRow');
    const downButton = findAllByTag(firstRow!, 'Button').find(
      (b) => b.children?.[0] === '↓',
    );
    const raw = downButton?.props?.['command'] as string;
    expect(raw.startsWith('reposcmd:')).toBe(true);
    const decoded = JSON.parse(decodeURIComponent(raw.slice('reposcmd:'.length)));
    expect(decoded).toEqual({ kind: 'move-repo-root', path: '/a', direction: 'down' });
  });

  it('move-up on the last root is an atomic move-repo-root command', () => {
    const roots: RepoRootsConfig = { roots: [{ path: '/a' }, { path: '/b' }] };
    const tree = renderReposView({ roots, repos: [] });
    const rows = findAllByTag(tree, 'ReposRootRow');
    const upButton = findAllByTag(rows[1]!, 'Button').find((b) => b.children?.[0] === '↑');
    const raw = upButton?.props?.['command'] as string;
    const decoded = JSON.parse(decodeURIComponent(raw.slice('reposcmd:'.length)));
    expect(decoded).toEqual({ kind: 'move-repo-root', path: '/b', direction: 'up' });
  });

  it('remove on the middle root is an atomic remove-repo-root command identified by its own path, not a recomputed array', () => {
    const roots: RepoRootsConfig = { roots: [{ path: '/a' }, { path: '/b' }, { path: '/c' }] };
    const tree = renderReposView({ roots, repos: [] });
    const rows = findAllByTag(tree, 'ReposRootRow');
    const removeButton = findAllByTag(rows[1]!, 'Button').find((b) => b.children?.[0] === 'Remove');
    const raw = removeButton?.props?.['command'] as string;
    const decoded = JSON.parse(decodeURIComponent(raw.slice('reposcmd:'.length)));
    expect(decoded).toEqual({ kind: 'remove-repo-root', path: '/b' });
  });

  it('renders discovered repos when present', () => {
    const roots: RepoRootsConfig = { roots: [{ path: '/repos' }] };
    const repos: DiscoveredRepo[] = [
      { name: 'agent-secretary', path: '/repos/agent-secretary', rootPath: '/repos' },
      { name: 'website', path: '/repos/website', rootPath: '/repos' },
    ];
    const tree = renderReposView({ roots, repos });
    const rows = findAllByTag(tree, 'ReposRepoRow');
    expect(rows.map((r) => r.props?.['path'])).toEqual([
      '/repos/agent-secretary',
      '/repos/website',
    ]);
  });

  it('shows a distinct empty hint for "no repos yet" vs "no search matches"', () => {
    const roots: RepoRootsConfig = { roots: [{ path: '/repos' }] };
    const noRepos = renderReposView({ roots, repos: [] });
    expect(flatten(noRepos)).toContain('EmptyHint');
    const noReposHint = findByTag(noRepos, 'EmptyHint');
    expect(noReposHint?.children?.[0]).toBe('no repos found under these folders');

    const noMatches = renderReposView({ roots, repos: [], query: 'nonexistent' });
    const noMatchesHint = findByTag(noMatches, 'EmptyHint');
    expect(noMatchesHint?.children?.[0]).toBe('no matching repos');
  });

  it('encodeReposCommand round-trips a remove-repo-root command', () => {
    const encoded = encodeReposCommand({ kind: 'remove-repo-root', path: '/x' });
    expect(encoded.startsWith('reposcmd:')).toBe(true);
    const decoded = JSON.parse(decodeURIComponent(encoded.slice('reposcmd:'.length)));
    expect(decoded).toEqual({ kind: 'remove-repo-root', path: '/x' });
  });

  it('encodeReposCommand round-trips a move-repo-root command', () => {
    const encoded = encodeReposCommand({ kind: 'move-repo-root', path: '/x', direction: 'up' });
    expect(encoded.startsWith('reposcmd:')).toBe(true);
    const decoded = JSON.parse(decodeURIComponent(encoded.slice('reposcmd:'.length)));
    expect(decoded).toEqual({ kind: 'move-repo-root', path: '/x', direction: 'up' });
  });
});
