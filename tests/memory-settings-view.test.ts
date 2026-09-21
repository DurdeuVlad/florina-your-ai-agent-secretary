import { describe, it, expect } from 'vitest';
import { renderMemorySettingsView } from '../src/adapters/inbound/desktop/views/memory-settings-view.js';
import type { MemoryRowInput } from '../src/adapters/inbound/desktop/views/memory-settings-view.js';
import type { MemoryItem } from '../src/core/domain/memory.js';
import type { UpdatePreferenceCommand } from '../src/core/application/use-cases/tasks/command-api.js';

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

const forgetCmd: UpdatePreferenceCommand = {
  kind: 'update-preference',
  action: 'remove-rule',
  provider: 'codex',
};
const promoteCmd: UpdatePreferenceCommand = {
  kind: 'update-preference',
  action: 'add-rule',
  provider: 'codex',
};

function row(memItem: MemoryItem, opts: { withForget?: boolean; withPromote?: boolean } = {}): MemoryRowInput {
  return {
    item: memItem,
    ...(opts.withForget ? { forgetCommand: forgetCmd } : {}),
    ...(opts.withPromote ? { promoteCommand: promoteCmd } : {}),
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
  it('shows an explicit empty state with no rows, but still renders the filter bar', () => {
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
      row(item({ id: 'm-old', kind: 'preference', updatedAt: '2026-09-19T00:00:00.000Z' })),
      row(item({ id: 'm-new', kind: 'preference', updatedAt: '2026-09-20T00:00:00.000Z' })),
    ]);
    const rows = tree.children?.filter((c) => typeof c !== 'string' && c.tag === 'MemoryRow') ?? [];
    const ids = rows.map((r) => (typeof r === 'string' ? undefined : r.props?.['itemId']));
    expect(ids).toEqual(['m-new', 'm-old']);
  });

  it('renders provenance and confidence as chips on each row', () => {
    const tree = renderMemorySettingsView([
      row(item({ id: 'm1', kind: 'preference', provenance: 'inferred-repeated', confidence: 'medium' })),
    ]);
    const memRow = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const meta =
      typeof memRow === 'string' || memRow === undefined
        ? undefined
        : memRow.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryMeta');
    const chipTexts =
      typeof meta === 'string' || meta === undefined
        ? []
        : (meta.children ?? []).map((c) => (typeof c === 'string' ? c : c.children?.[0]));
    expect(chipTexts).toContain('inferred-repeated');
    expect(chipTexts).toContain('confidence: medium');
  });

  it('a row with both forgetCommand and promoteCommand renders both action buttons', () => {
    const tree = renderMemorySettingsView([
      row(item({ id: 'm1', kind: 'preference', scope: { type: 'project', projectId: 'proj-1' } }), {
        withForget: true,
        withPromote: true,
      }),
    ]);
    const memRow = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const actions =
      typeof memRow === 'string' || memRow === undefined
        ? undefined
        : memRow.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryActions');
    expect(typeof actions === 'string' ? undefined : actions?.children).toHaveLength(2);
  });

  it('a row with only forgetCommand renders only Forget (e.g. already-global item)', () => {
    const tree = renderMemorySettingsView([
      row(item({ id: 'm1', kind: 'preference', scope: { type: 'global' } }), { withForget: true }),
    ]);
    const memRow = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const actions =
      typeof memRow === 'string' || memRow === undefined
        ? undefined
        : memRow.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryActions');
    expect(typeof actions === 'string' ? undefined : actions?.children).toHaveLength(1);
  });

  it('a row with neither command (no real write path for this kind yet) gets no actions', () => {
    const tree = renderMemorySettingsView([row(item({ id: 'm1', kind: 'rule' }))]);
    const memRow = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const actions =
      typeof memRow === 'string' || memRow === undefined
        ? undefined
        : memRow.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryActions');
    expect(actions).toBeUndefined();
  });

  it('the Promote button carries confirmPromote so the renderer knows to confirm first', () => {
    const tree = renderMemorySettingsView([
      row(item({ id: 'm1', kind: 'preference' }), { withForget: true, withPromote: true }),
    ]);
    const memRow = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const actions =
      typeof memRow === 'string' || memRow === undefined
        ? undefined
        : memRow.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryActions');
    const buttons = typeof actions === 'string' || actions === undefined ? [] : (actions.children ?? []);
    const promoteButton = buttons.find(
      (b) => typeof b !== 'string' && b.children?.[0] === 'Promote to global',
    );
    expect(typeof promoteButton === 'string' ? undefined : promoteButton?.props?.['confirmPromote']).toBe(true);
  });

  it('a non-active status renders an extra status chip', () => {
    const tree = renderMemorySettingsView([row(item({ id: 'm1', kind: 'preference', status: 'proposed' }))]);
    const memRow = tree.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryRow');
    const meta =
      typeof memRow === 'string' || memRow === undefined
        ? undefined
        : memRow.children?.find((c) => typeof c !== 'string' && c.tag === 'MemoryMeta');
    const chipTexts =
      typeof meta === 'string' || meta === undefined
        ? []
        : (meta.children ?? []).map((c) => (typeof c === 'string' ? c : c.children?.[0]));
    expect(chipTexts).toContain('proposed');
  });
});
