import { describe, it, expect } from 'vitest';
import { renderMemorySettingsView } from '../src/adapters/inbound/desktop/views/memory-settings-view.js';
import type { MemoryItem } from '../src/core/domain/memory.js';

function item(overrides: Partial<MemoryItem> & Pick<MemoryItem, 'id' | 'kind'>): MemoryItem {
  return {
    scope: { type: 'global' },
    statement: 'Prefer Codex for mechanical work.',
    provenance: 'explicit',
    confidence: 'high',
    status: 'active',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

function flatten(tree: ReturnType<typeof renderMemorySettingsView>): string[] {
  const out: string[] = [];
  function walk(node: typeof tree | string): void {
    if (typeof node === 'string') return;
    out.push(node.tag);
    node.children?.forEach(walk);
  }
  walk(tree);
  return out;
}

describe('renderMemorySettingsView', () => {
  it('shows an explicit empty state with no items, but still renders the filter bar', () => {
    const tree = renderMemorySettingsView([]);
    expect(flatten(tree)).toContain('EmptyState');
    expect(flatten(tree)).toContain('MemoryFilterBar');
  });

  it('offers a filter chip for every one of the 8 kinds plus "All kinds", even with zero live items', () => {
    const tree = renderMemorySettingsView([]);
    const filterBar = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryFilterBar');
    const kindChips =
      typeof filterBar === 'string' || filterBar === undefined
        ? []
        : (filterBar.children ?? []).filter(
            (c) => typeof c !== 'string' && c.props?.['filterKind'] === 'kind',
          );
    expect(kindChips).toHaveLength(9);
  });

  it('renders one row per item, most-recently-updated first', () => {
    const tree = renderMemorySettingsView([
      item({ id: 'm-old', kind: 'preference', updatedAt: '2026-09-19T00:00:00.000Z' }),
      item({ id: 'm-new', kind: 'preference', updatedAt: '2026-09-20T00:00:00.000Z' }),
    ]);
    const rows = tree.children?.filter((c) => typeof c !== 'string' && c.tag === 'MemoryRow') ?? [];
    const ids = rows.map((r) => (typeof r === 'string' ? undefined : r.props?.['itemId']));
    expect(ids).toEqual(['m-new', 'm-old']);
  });

  it('renders provenance and confidence as chips on each row', () => {
    const tree = renderMemorySettingsView([
      item({ id: 'm1', kind: 'preference', provenance: 'inferred-repeated', confidence: 'medium' }),
    ]);
    const row = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const meta =
      typeof row === 'string' || row === undefined
        ? undefined
        : row.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryMeta');
    const chipTexts =
      typeof meta === 'string' || meta === undefined
        ? []
        : (meta.children ?? []).map((c) => (typeof c === 'string' ? c : c.children?.[0]));
    expect(chipTexts).toContain('inferred-repeated');
    expect(chipTexts).toContain('confidence: medium');
  });

  it('a preference-kind item gets Forget and (when project-scoped) Promote actions', () => {
    const tree = renderMemorySettingsView([
      item({ id: 'm1', kind: 'preference', scope: { type: 'project', projectId: 'proj-1' } }),
    ]);
    const row = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const actions =
      typeof row === 'string' || row === undefined
        ? undefined
        : row.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryActions');
    expect(typeof actions === 'string' ? undefined : actions?.children).toHaveLength(2);
  });

  it('a global-scoped preference item gets Forget but not Promote (already global)', () => {
    const tree = renderMemorySettingsView([item({ id: 'm1', kind: 'preference', scope: { type: 'global' } })]);
    const row = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const actions =
      typeof row === 'string' || row === undefined
        ? undefined
        : row.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryActions');
    expect(typeof actions === 'string' ? undefined : actions?.children).toHaveLength(1);
  });

  it('a non-preference kind item (no real write path yet) gets no actions', () => {
    const tree = renderMemorySettingsView([item({ id: 'm1', kind: 'rule' })]);
    const row = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const actions =
      typeof row === 'string' || row === undefined
        ? undefined
        : row.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryActions');
    expect(actions).toBeUndefined();
  });

  it('a non-active status renders an extra status chip', () => {
    const tree = renderMemorySettingsView([item({ id: 'm1', kind: 'preference', status: 'proposed' })]);
    const row = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const meta =
      typeof row === 'string' || row === undefined
        ? undefined
        : row.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryMeta');
    const chipTexts =
      typeof meta === 'string' || meta === undefined
        ? []
        : (meta.children ?? []).map((c) => (typeof c === 'string' ? c : c.children?.[0]));
    expect(chipTexts).toContain('proposed');
  });
});
