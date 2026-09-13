/**
 * Template functions for the Attention Inbox UI (DEC-006, DEC-028, issue #25).
 *
 * Each template returns a {@link RenderTree} — a plain, serializable object
 * describing a renderable element (`{ tag, props, children }`). No DOM, no
 * React, no framework. Any renderer (desktop webview, TUI, test harness) can
 * walk the tree and project it onto its own surface.
 *
 * Style hints (priority colors, icons, spacing) are embedded in `props` as
 * semantic tokens, so each surface maps them to its own palette/layout. Event
 * handlers are expressed as **string command identifiers** (never closures)
 * so the whole tree is JSON-serializable and can cross the IPC boundary.
 *
 * The home screen is an attention inbox, not a Kanban board (DEC-006).
 */
import type { AttentionItemPriority } from '../../../../core/application/use-cases/attention/attention-item.js';
import type {
  AttentionItemView,
  InboxViewData,
  RenderTree,
  ViewFilter,
} from './view-types.js';
import { PRIORITY_METADATA } from './inbox-view.js';

/* ------------------------------------------------------------------ *
 * Primitive element helpers
 * ------------------------------------------------------------------ */

/** Create a {@link RenderTree} node. */
function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** A text node (represented as a plain string child). */
function text(value: string): string {
  return value;
}

/* ------------------------------------------------------------------ *
 * Item / group / list templates
 * ------------------------------------------------------------------ */

/**
 * Render a single inbox item as a {@link RenderTree} card.
 *
 * The card surfaces the priority color/icon, kind icon, title, summary, and
 * action buttons. Action buttons carry string command identifiers in
 * `props.command` so the renderer can dispatch them to the typed command API
 * without closures (keeping the tree JSON-serializable).
 */
export function renderInboxItem(item: AttentionItemView): RenderTree {
  const actions = actionsFor(item);
  return el(
    'InboxItem',
    {
      itemId: item.id,
      taskId: item.taskId,
      priority: item.priority,
      priorityColor: item.priorityMeta.color,
      priorityIcon: item.priorityMeta.icon,
      kind: item.kind,
      kindIcon: item.kindMeta.icon,
      kindColor: item.kindMeta.color,
      status: item.status,
      createdAt: item.createdAt,
      spacing: 'md',
    },
    [
      el('ItemHeader', { layout: 'row', gap: 'sm' }, [
        el('Icon', { name: item.priorityMeta.icon, color: item.priorityMeta.color }, []),
        el('PriorityLabel', { color: item.priorityMeta.color }, [
          text(item.priorityMeta.label),
        ]),
        el('KindLabel', { color: item.kindMeta.color, icon: item.kindMeta.icon }, [
          text(item.kindMeta.label),
        ]),
      ]),
      el('ItemTitle', { weight: 'semibold' }, [text(item.title)]),
      el('ItemSummary', { color: 'muted' }, [text(item.summary)]),
      ...(actions.length > 0
        ? [el('ItemActions', { layout: 'row', gap: 'sm' }, actions)]
        : []),
    ],
  );
}

/**
 * Render a priority group: a header (priority label + count) followed by the
 * group's items. Items are rendered in the order provided (FIFO from the view
 * model).
 */
export function renderInboxGroup(
  priority: AttentionItemPriority,
  items: readonly AttentionItemView[],
): RenderTree {
  const meta = PRIORITY_METADATA[priority];
  const header = el(
    'GroupHeader',
    { priority, color: meta.color, icon: meta.icon, spacing: 'md' },
    [
      el('Icon', { name: meta.icon, color: meta.color }, []),
      el('GroupLabel', { color: meta.color, weight: 'bold' }, [
        text(meta.label),
      ]),
      el('GroupCount', { color: 'muted' }, [text(String(items.length))]),
    ],
  );
  return el('PriorityGroup', { priority, color: meta.color }, [
    header,
    el('GroupItems', { layout: 'column', gap: 'sm' }, items.map(renderInboxItem)),
  ]);
}

/**
 * Render the full inbox list: each priority group in order, or an empty state
 * when the view is empty.
 */
export function renderInboxList(view: InboxViewData): RenderTree {
  if (view.isEmpty) {
    return renderEmptyState();
  }
  return el('InboxList', { layout: 'column', gap: 'lg', totalCount: view.totalCount }, view.groups.map((group) => renderInboxGroup(group.priority, group.items)));
}

/**
 * Render the empty state: a centered placeholder with a calm icon and a hint
 * that there is nothing needing attention right now.
 */
export function renderEmptyState(): RenderTree {
  return el('EmptyState', { layout: 'center', padding: 'xl' }, [
    el('Icon', { name: 'check-circle', color: 'green', size: 'lg' }, []),
    el('EmptyTitle', { weight: 'semibold' }, [text('Nothing needs you right now')]),
    el('EmptyHint', { color: 'muted' }, [
      text('Items will appear here as agents surface attention.'),
    ]),
  ]);
}

/**
 * Render the filter bar: shows the active filter chips and clear control.
 *
 * Each active filter facet is a chip with a label and a `clearCommand` string
 * identifier so the renderer can dispatch removal without closures.
 */
export function renderFilterBar(filters: ViewFilter): RenderTree {
  const chips: RenderTree[] = [];
  if (filters.status !== undefined) {
    chips.push(filterChip('status', filters.status, `clear-filter:status`));
  }
  if (filters.kind !== undefined) {
    chips.push(filterChip('kind', filters.kind, `clear-filter:kind`));
  }
  if (filters.taskId !== undefined) {
    chips.push(filterChip('taskId', filters.taskId, `clear-filter:taskId`));
  }
  if (filters.priority !== undefined) {
    chips.push(filterChip('priority', filters.priority, `clear-filter:priority`));
  }
  const children: (RenderTree | string)[] = [
    el('FilterLabel', { weight: 'semibold' }, [text('Filters')]),
    ...chips,
  ];
  if (chips.length > 0) {
    children.push(
      el(
        'ClearAllButton',
        { command: 'clear-filter:all', variant: 'ghost' },
        [text('Clear all')],
      ),
    );
  }
  return el('FilterBar', { layout: 'row', gap: 'sm', wrap: true }, children);
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/**
 * Choose the action buttons for an item based on its kind. Buttons carry
 * string command identifiers so the tree stays JSON-serializable.
 */
function actionsFor(item: AttentionItemView): RenderTree[] {
  switch (item.kind) {
    case 'ApprovalRequest':
      return [
        actionButton('Allow once', `approve:${item.id}`, 'primary'),
        actionButton('Deny', `deny:${item.id}`, 'danger'),
        actionButton('Inspect', `inspect:${item.id}`, 'ghost'),
      ];
    case 'FailedRun':
      return [
        actionButton('Inspect', `inspect:${item.id}`, 'ghost'),
        actionButton('Retry', `retry:${item.id}`, 'primary'),
      ];
    case 'DirtyWorktree':
      return [
        actionButton('Inspect', `inspect:${item.id}`, 'ghost'),
        actionButton('Prune', `prune:${item.id}`, 'danger'),
      ];
    case 'Digest':
      return [
        actionButton('Read digest', `digest:${item.id}`, 'primary'),
        actionButton('Open diff', `diff:${item.id}`, 'ghost'),
        actionButton('Create PR', `pr:${item.id}`, 'ghost'),
      ];
    case 'IdleAgent':
    case 'StaleTask':
      return [actionButton('Inspect', `inspect:${item.id}`, 'ghost')];
    case 'Custom':
    default:
      return [actionButton('Inspect', `inspect:${item.id}`, 'ghost')];
  }
}

/** Build an action button node with a serializable command identifier. */
function actionButton(
  label: string,
  command: string,
  variant: 'primary' | 'danger' | 'ghost',
): RenderTree {
  return el('Button', { command, variant, size: 'sm' }, [text(label)]);
}

/** Build a filter chip node with a serializable clear command. */
function filterChip(
  facet: string,
  value: string,
  clearCommand: string,
): RenderTree {
  return el('FilterChip', { facet, value, clearCommand, color: 'blue' }, [
    text(`${facet}: ${value}`),
    el('ChipClear', { command: clearCommand }, [text('×')]),
  ]);
}
