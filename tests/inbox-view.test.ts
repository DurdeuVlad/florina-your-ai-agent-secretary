import { describe, it, expect } from 'vitest';

import { AttentionInbox } from '../src/attention/attention-inbox.js';
import {
  createAttentionItem,
  type AttentionItem,
  type AttentionItemKind,
  type AttentionItemPriority,
  type AttentionItemStatus,
} from '../src/attention/attention-item.js';
import {
  InboxViewModel,
  KIND_METADATA,
  PRIORITY_METADATA,
} from '../src/desktop/views/inbox-view.js';
import {
  renderInboxItem,
  renderInboxGroup,
  renderInboxList,
  renderEmptyState,
  renderFilterBar,
} from '../src/desktop/views/inbox-templates.js';
import type {
  AttentionItemView,
  InboxViewData,
  RenderTree,
  ViewFilter,
} from '../src/desktop/views/view-types.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

const ATTENTION_ITEM_KINDS: readonly AttentionItemKind[] = [
  'ApprovalRequest',
  'FailedRun',
  'DirtyWorktree',
  'IdleAgent',
  'StaleTask',
  'Digest',
  'Custom',
];

const PRIORITIES: readonly AttentionItemPriority[] = ['Critical', 'High', 'Medium', 'Low'];

/** Build an item with explicit fields and a stable id. */
function item(
  id: string,
  overrides: Partial<AttentionItem> & {
    taskId?: string;
    kind?: AttentionItemKind;
    priority?: AttentionItemPriority;
    createdAt?: string;
    status?: AttentionItemStatus;
  } = {},
): AttentionItem {
  return createAttentionItem({
    id,
    taskId: overrides.taskId ?? 'task-1',
    kind: overrides.kind ?? 'ApprovalRequest',
    priority: overrides.priority ?? 'High',
    createdAt: overrides.createdAt ?? '2026-08-19T12:00:00.000Z',
    status: overrides.status ?? 'Pending',
    payload: overrides.payload ?? { message: 'needs review' },
  });
}

/** Build an inbox from a list of items. */
function inboxOf(items: AttentionItem[]): AttentionInbox {
  const inbox = new AttentionInbox();
  for (const it of items) inbox.add(it);
  return inbox;
}

/* ------------------------------------------------------------------ *
 * InboxViewModel — grouping & sorting
 * ------------------------------------------------------------------ */

describe('InboxViewModel.buildView', () => {
  const vm = new InboxViewModel();

  it('groups items by priority and orders groups Critical → Low', () => {
    const inbox = inboxOf([
      item('a', { priority: 'Low', createdAt: '2026-08-19T10:00:00.000Z' }),
      item('b', { priority: 'Critical', createdAt: '2026-08-19T11:00:00.000Z' }),
      item('c', { priority: 'Medium', createdAt: '2026-08-19T09:00:00.000Z' }),
      item('d', { priority: 'High', createdAt: '2026-08-19T12:00:00.000Z' }),
    ]);
    const view = vm.buildView(inbox);
    expect(view.groups.map((g) => g.priority)).toEqual(['Critical', 'High', 'Medium', 'Low']);
  });

  it('sorts items within each group FIFO by createdAt', () => {
    const inbox = inboxOf([
      item('late', { priority: 'High', createdAt: '2026-08-19T12:00:00.000Z' }),
      item('early', { priority: 'High', createdAt: '2026-08-19T09:00:00.000Z' }),
      item('mid', { priority: 'High', createdAt: '2026-08-19T10:30:00.000Z' }),
    ]);
    const view = vm.buildView(inbox);
    const high = view.groups.find((g) => g.priority === 'High');
    expect(high?.items.map((i) => i.id)).toEqual(['early', 'mid', 'late']);
  });

  it('omits empty priority groups', () => {
    const inbox = inboxOf([item('a', { priority: 'Critical' }), item('b', { priority: 'Low' })]);
    const view = vm.buildView(inbox);
    expect(view.groups.map((g) => g.priority)).toEqual(['Critical', 'Low']);
  });

  it('reports totalCount and isEmpty correctly', () => {
    expect(vm.buildView(inboxOf([item('a')])).totalCount).toBe(1);
    expect(vm.buildView(inboxOf([item('a')])).isEmpty).toBe(false);
    expect(vm.buildView(new AttentionInbox()).isEmpty).toBe(true);
    expect(vm.buildView(new AttentionInbox()).totalCount).toBe(0);
  });

  it('enriches each item with kind and priority display metadata', () => {
    const inbox = inboxOf([item('a', { kind: 'ApprovalRequest', priority: 'Critical' })]);
    const view = vm.buildView(inbox);
    const itemView = view.groups[0]!.items[0]!;
    expect(itemView.kindMeta).toEqual(KIND_METADATA.ApprovalRequest);
    expect(itemView.priorityMeta).toEqual(PRIORITY_METADATA.Critical);
  });

  it('derives a title and summary from the item', () => {
    const inbox = inboxOf([
      item('a', { kind: 'FailedRun', taskId: 'oauth', payload: { message: 'tests failed' } }),
    ]);
    const view = vm.buildView(inbox);
    const itemView = view.groups[0]!.items[0]!;
    expect(itemView.title).toBe('Failed Run · oauth');
    expect(itemView.summary).toBe('tests failed');
  });

  it('falls back to the kind label when payload has no message/reason', () => {
    const inbox = inboxOf([item('a', { kind: 'Digest', payload: { foo: 'bar' } })]);
    const view = vm.buildView(inbox);
    const itemView = view.groups[0]!.items[0]!;
    expect(itemView.summary).toBe(KIND_METADATA.Digest.label);
  });
});

/* ------------------------------------------------------------------ *
 * InboxViewModel — filtering
 * ------------------------------------------------------------------ */

describe('InboxViewModel filtering', () => {
  const vm = new InboxViewModel();
  const source = inboxOf([
    item('a', { kind: 'ApprovalRequest', priority: 'Critical', status: 'Pending', taskId: 't1' }),
    item('b', { kind: 'FailedRun', priority: 'High', status: 'Acknowledged', taskId: 't2' }),
    item('c', { kind: 'Digest', priority: 'Low', status: 'Pending', taskId: 't1' }),
    item('d', { kind: 'ApprovalRequest', priority: 'High', status: 'Resolved', taskId: 't3' }),
  ]);

  it('filters by status', () => {
    const view = vm.buildView(source, { status: 'Pending' });
    expect(ids(view)).toEqual(['a', 'c']);
  });

  it('filters by kind', () => {
    const view = vm.buildView(source, { kind: 'ApprovalRequest' });
    expect(ids(view)).toEqual(['a', 'd']);
  });

  it('filters by taskId', () => {
    const view = vm.buildView(source, { taskId: 't1' });
    expect(ids(view)).toEqual(['a', 'c']);
  });

  it('filters by priority', () => {
    const view = vm.buildView(source, { priority: 'High' });
    expect(ids(view)).toEqual(['b', 'd']);
  });

  it('combines multiple filter facets (logical AND)', () => {
    const view = vm.buildView(source, { status: 'Pending', taskId: 't1' });
    expect(ids(view)).toEqual(['a', 'c']);
    const view2 = vm.buildView(source, { status: 'Pending', kind: 'Digest' });
    expect(ids(view2)).toEqual(['c']);
  });

  it('records the applied filter on the view data', () => {
    const filter: ViewFilter = { status: 'Pending' };
    const view = vm.buildView(source, filter);
    expect(view.filter).toEqual(filter);
  });

  it('returns an empty view when nothing matches', () => {
    const view = vm.buildView(source, { taskId: 'nope' });
    expect(view.isEmpty).toBe(true);
    expect(view.groups).toEqual([]);
  });
});

/** Flatten all item ids from a view (ordered by group then FIFO). */
function ids(view: InboxViewData): string[] {
  return view.groups.flatMap((g) => g.items.map((i) => i.id));
}

/* ------------------------------------------------------------------ *
 * Display metadata coverage
 * ------------------------------------------------------------------ */

describe('display metadata', () => {
  it('provides icon, color, and label for every item kind', () => {
    for (const kind of ATTENTION_ITEM_KINDS) {
      const meta = KIND_METADATA[kind];
      expect(meta).toBeDefined();
      expect(typeof meta.icon).toBe('string');
      expect(meta.icon.length).toBeGreaterThan(0);
      expect(typeof meta.color).toBe('string');
      expect(meta.color.length).toBeGreaterThan(0);
      expect(typeof meta.label).toBe('string');
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });

  it('provides icon, color, and label for every priority', () => {
    for (const priority of PRIORITIES) {
      const meta = PRIORITY_METADATA[priority];
      expect(meta).toBeDefined();
      expect(typeof meta.icon).toBe('string');
      expect(meta.icon.length).toBeGreaterThan(0);
      expect(typeof meta.color).toBe('string');
      expect(meta.color.length).toBeGreaterThan(0);
      expect(typeof meta.label).toBe('string');
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });

  it('enriches item views with the correct metadata per kind and priority', () => {
    const vm = new InboxViewModel();
    const inbox = inboxOf([item('a', { kind: 'FailedRun', priority: 'Critical' })]);
    const view = vm.buildView(inbox);
    const itemView = view.groups[0]!.items[0]!;
    expect(itemView.kindMeta).toEqual(KIND_METADATA.FailedRun);
    expect(itemView.priorityMeta).toEqual(PRIORITY_METADATA.Critical);
  });
});

/* ------------------------------------------------------------------ *
 * Template functions
 * ------------------------------------------------------------------ */

describe('renderInboxItem', () => {
  it('produces a RenderTree with tag, props, and children', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(inboxOf([item('a', { kind: 'ApprovalRequest' })]));
    const itemView = view.groups[0]!.items[0]!;
    const tree = renderInboxItem(itemView);
    expect(tree.tag).toBe('InboxItem');
    expect(tree.props).toBeDefined();
    expect(tree.props!['itemId']).toBe('a');
    expect(tree.props!['priority']).toBe('High');
    expect(tree.props!['kind']).toBe('ApprovalRequest');
    expect(Array.isArray(tree.children)).toBe(true);
    expect(tree.children!.length).toBeGreaterThan(0);
  });

  it('embeds priority color/icon and kind color/icon in props', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(inboxOf([item('a', { kind: 'FailedRun', priority: 'Critical' })]));
    const tree = renderInboxItem(view.groups[0]!.items[0]!);
    expect(tree.props!['priorityColor']).toBe(PRIORITY_METADATA.Critical.color);
    expect(tree.props!['priorityIcon']).toBe(PRIORITY_METADATA.Critical.icon);
    expect(tree.props!['kindIcon']).toBe(KIND_METADATA.FailedRun.icon);
    expect(tree.props!['kindColor']).toBe(KIND_METADATA.FailedRun.color);
  });

  it('includes action buttons with serializable command identifiers for approvals', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(inboxOf([item('a', { kind: 'ApprovalRequest' })]));
    const tree = renderInboxItem(view.groups[0]!.items[0]!);
    const actions = findNodes(tree, 'ItemActions')[0];
    expect(actions).toBeDefined();
    const buttons = findNodes(tree, 'Button');
    const commands = buttons.map((b) => b.props!['command']);
    expect(commands).toContain('approve:a');
    expect(commands).toContain('deny:a');
    expect(commands).toContain('inspect:a');
  });

  it('uses kind-appropriate actions for Digest items', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(inboxOf([item('d', { kind: 'Digest' })]));
    const tree = renderInboxItem(view.groups[0]!.items[0]!);
    const commands = findNodes(tree, 'Button').map((b) => b.props!['command']);
    expect(commands).toContain('digest:d');
    expect(commands).toContain('diff:d');
    expect(commands).toContain('pr:d');
  });
});

describe('renderInboxGroup', () => {
  it('renders a group header with priority metadata and item count', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(
      inboxOf([
        item('a', { priority: 'High', createdAt: '2026-08-19T09:00:00.000Z' }),
        item('b', { priority: 'High', createdAt: '2026-08-19T10:00:00.000Z' }),
      ]),
    );
    const group = view.groups[0]!;
    const tree = renderInboxGroup(group.priority, group.items);
    expect(tree.tag).toBe('PriorityGroup');
    expect(tree.props!['priority']).toBe('High');
    const header = findNodes(tree, 'GroupHeader')[0];
    expect(header).toBeDefined();
    expect(header.props!['color']).toBe(PRIORITY_METADATA.High.color);
    const count = findNodes(tree, 'GroupCount')[0];
    expect(count.children?.[0]).toBe('2');
  });

  it('renders each item in the group', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(
      inboxOf([item('a', { priority: 'Low' }), item('b', { priority: 'Low' })]),
    );
    const group = view.groups[0]!;
    const tree = renderInboxGroup(group.priority, group.items);
    const items = findNodes(tree, 'InboxItem');
    expect(items.length).toBe(2);
  });
});

describe('renderInboxList', () => {
  it('renders all groups in priority order', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(
      inboxOf([item('a', { priority: 'Low' }), item('b', { priority: 'Critical' })]),
    );
    const tree = renderInboxList(view);
    expect(tree.tag).toBe('InboxList');
    const groups = findNodes(tree, 'PriorityGroup');
    expect(groups.map((g) => g.props!['priority'])).toEqual(['Critical', 'Low']);
  });

  it('renders the empty state when the view is empty', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(new AttentionInbox());
    const tree = renderInboxList(view);
    expect(tree.tag).toBe('EmptyState');
  });
});

describe('renderEmptyState', () => {
  it('produces a centered placeholder with a check icon and hint', () => {
    const tree = renderEmptyState();
    expect(tree.tag).toBe('EmptyState');
    expect(tree.props!['layout']).toBe('center');
    const icon = findNodes(tree, 'Icon')[0];
    expect(icon).toBeDefined();
    expect(icon.props!['color']).toBe('green');
    const title = findNodes(tree, 'EmptyTitle')[0];
    expect(title.children?.[0]).toBe('Nothing needs you right now');
  });
});

describe('renderFilterBar', () => {
  it('renders a chip per active filter facet and a clear-all control', () => {
    const tree = renderFilterBar({ status: 'Pending', taskId: 't1' });
    expect(tree.tag).toBe('FilterBar');
    const chips = findNodes(tree, 'FilterChip');
    expect(chips.length).toBe(2);
    const facets = chips.map((c) => c.props!['facet']);
    expect(facets).toContain('status');
    expect(facets).toContain('taskId');
    expect(findNodes(tree, 'ClearAllButton').length).toBe(1);
  });

  it('omits the clear-all control when no filters are active', () => {
    const tree = renderFilterBar({});
    expect(findNodes(tree, 'FilterChip').length).toBe(0);
    expect(findNodes(tree, 'ClearAllButton').length).toBe(0);
  });

  it('emits serializable clear commands on chips', () => {
    const tree = renderFilterBar({ priority: 'High' });
    const chip = findNodes(tree, 'FilterChip')[0];
    expect(chip.props!['clearCommand']).toBe('clear-filter:priority');
  });
});

/* ------------------------------------------------------------------ *
 * RenderTree serializability
 * ------------------------------------------------------------------ */

describe('RenderTree serializability', () => {
  it('a full inbox render tree survives a JSON round-trip unchanged', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(
      inboxOf([
        item('a', { kind: 'ApprovalRequest', priority: 'Critical' }),
        item('b', { kind: 'Digest', priority: 'Low' }),
      ]),
    );
    const tree = renderInboxList(view);
    const json = JSON.stringify(tree);
    const roundTripped = JSON.parse(json) as RenderTree;
    expect(roundTripped).toEqual(tree);
  });

  it('the empty state tree is JSON-serializable', () => {
    const tree = renderEmptyState();
    expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
  });

  it('the filter bar tree is JSON-serializable', () => {
    const tree = renderFilterBar({ status: 'Pending', kind: 'Digest' });
    expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
  });

  it('item view data is JSON-serializable', () => {
    const vm = new InboxViewModel();
    const view = vm.buildView(inboxOf([item('a')]));
    const itemView: AttentionItemView = view.groups[0]!.items[0]!;
    expect(JSON.parse(JSON.stringify(itemView))).toEqual(itemView);
  });
});

/* ------------------------------------------------------------------ *
 * Tree-walk helper for tests
 * ------------------------------------------------------------------ */

/** Recursively collect all nodes in a tree with the given tag. */
function findNodes(node: RenderTree | string, tag: string): RenderTree[] {
  if (typeof node === 'string') return [];
  const matches: RenderTree[] = [];
  if (node.tag === tag) matches.push(node);
  if (node.children) {
    for (const child of node.children) {
      matches.push(...findNodes(child, tag));
    }
  }
  return matches;
}
