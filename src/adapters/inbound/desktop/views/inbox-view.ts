/**
 * View model for the Attention Inbox UI (DEC-006, DEC-028, issue #25).
 *
 * {@link InboxViewModel} transforms {@link AttentionInbox} data into
 * display-ready, grouped, sorted, filtered view structures
 * ({@link InboxViewData}). It owns the display metadata (icon, color, label)
 * for every item kind and priority, and derives a short title/summary per
 * item so templates don't need to inspect payloads.
 *
 * The view model is pure and synchronous: no DOM, no framework, no side
 * effects. This keeps the inbox view logic fully testable with vitest and
 * identical across rendering surfaces (desktop webview, TUI, CLI).
 *
 * The home screen is an attention inbox, not a Kanban board (DEC-006).
 */
import type { AttentionInbox } from '../../../../core/application/use-cases/attention/attention-inbox.js';
import type {
  AttentionItem,
  AttentionItemKind,
  AttentionItemPriority,
} from '../../../../core/application/use-cases/attention/attention-item.js';
import {
  PRIORITY_ORDER,
  compareAttentionItems,
} from '../../../../core/application/use-cases/attention/attention-item.js';
import type {
  AttentionItemView,
  DisplayMetadata,
  InboxViewData,
  PriorityGroup,
  ViewFilter,
} from './view-types.js';

/* ------------------------------------------------------------------ *
 * Display metadata tables
 * ------------------------------------------------------------------ */

/**
 * Display metadata for each {@link AttentionItemKind}: icon, color, label.
 *
 * Icons are generic glyph identifiers the renderer maps to its icon set.
 * Colors are semantic tokens mapped to each surface's palette.
 */
export const KIND_METADATA: Readonly<Record<AttentionItemKind, DisplayMetadata>> = {
  ApprovalRequest: {
    icon: 'shield',
    color: 'amber',
    label: 'Approval Required',
  },
  FailedRun: {
    icon: 'alert',
    color: 'red',
    label: 'Failed Run',
  },
  DirtyWorktree: {
    icon: 'branch',
    color: 'orange',
    label: 'Dirty Worktree',
  },
  IdleAgent: {
    icon: 'pause',
    color: 'slate',
    label: 'Idle Agent',
  },
  StaleTask: {
    icon: 'clock',
    color: 'slate',
    label: 'Stale Task',
  },
  Digest: {
    icon: 'document',
    color: 'blue',
    label: 'Digest',
  },
  UnverifiedCompletion: {
    icon: 'shield',
    color: 'amber',
    label: 'Unverified Completion',
  },
  DegradedContext: {
    icon: 'gauge',
    color: 'orange',
    label: 'Degraded Context',
  },
  Custom: {
    icon: 'info',
    color: 'slate',
    label: 'Custom',
  },
};

/**
 * Display metadata for each {@link AttentionItemPriority}: icon, color, label.
 */
export const PRIORITY_METADATA: Readonly<Record<AttentionItemPriority, DisplayMetadata>> = {
  Critical: {
    icon: 'flame',
    color: 'red',
    label: 'Critical',
  },
  High: {
    icon: 'arrow-up',
    color: 'amber',
    label: 'High',
  },
  Medium: {
    icon: 'minus',
    color: 'blue',
    label: 'Medium',
  },
  Low: {
    icon: 'arrow-down',
    color: 'slate',
    label: 'Low',
  },
};

/* ------------------------------------------------------------------ *
 * InboxViewModel
 * ------------------------------------------------------------------ */

/**
 * Transforms {@link AttentionInbox} data into display-ready view structures.
 *
 * Use {@link buildView} to produce an {@link InboxViewData} from an inbox,
 * optionally applying a {@link ViewFilter}. The view model is stateless aside
 * from the (immutable) metadata tables, so a single instance can be reused.
 */
export class InboxViewModel {
  /**
   * Build the full inbox view data from an {@link AttentionInbox}.
   *
   * Items are filtered (when a filter is supplied), grouped by priority
   * (Critical → Low), and sorted FIFO by `createdAt` within each group.
   * Empty groups are omitted. The returned structure is JSON-serializable.
   *
   * @param inbox - The source inbox (read-only; not mutated).
   * @param filter - Optional filter (status, kind, taskId, priority).
   * @returns Grouped, sorted, filtered view data.
   */
  buildView(inbox: AttentionInbox, filter?: ViewFilter): InboxViewData {
    const items = inbox.list(toInboxFilter(filter));
    return this.buildViewFromItems(items, filter);
  }

  /**
   * Build the view data from a raw list of items (e.g. from a snapshot).
   *
   * This is the same transformation as {@link buildView} but accepts a plain
   * array instead of an {@link AttentionInbox}, useful when rendering from a
   * persisted snapshot or daemon reply.
   */
  buildViewFromItems(items: readonly AttentionItem[], filter?: ViewFilter): InboxViewData {
    // Apply the view filter (defensive — the source may already be filtered).
    const filtered = items.filter((item) => matchesViewFilter(item, filter));

    // Group by priority.
    const byPriority = new Map<AttentionItemPriority, AttentionItem[]>();
    for (const item of filtered) {
      const bucket = byPriority.get(item.priority) ?? [];
      bucket.push(item);
      byPriority.set(item.priority, bucket);
    }

    // Build ordered groups (Critical → Low), sort each FIFO, omit empties.
    const groups: PriorityGroup[] = [];
    for (const priority of PRIORITY_ORDER) {
      const bucket = byPriority.get(priority);
      if (bucket === undefined || bucket.length === 0) continue;
      // FIFO: earliest createdAt first. compareAttentionItems already orders
      // by priority then createdAt; within a single priority that's just FIFO.
      const sorted = [...bucket].sort(compareAttentionItems);
      groups.push({
        priority,
        meta: PRIORITY_METADATA[priority],
        items: sorted.map((item) => this.toItemView(item)),
        count: sorted.length,
      });
    }

    return {
      groups,
      totalCount: filtered.length,
      isEmpty: filtered.length === 0,
      filter,
    };
  }

  /**
   * Convert a single {@link AttentionItem} into a display-ready
   * {@link AttentionItemView}.
   */
  toItemView(item: AttentionItem): AttentionItemView {
    const kindMeta = KIND_METADATA[item.kind];
    const priorityMeta = PRIORITY_METADATA[item.priority];
    return {
      id: item.id,
      taskId: item.taskId,
      kind: item.kind,
      kindMeta,
      priority: item.priority,
      priorityMeta,
      status: item.status,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      title: deriveTitle(item),
      summary: deriveSummary(item),
      payload: item.payload,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Convert a {@link ViewFilter} into the inbox's native filter shape. */
function toInboxFilter(filter?: ViewFilter):
  | {
      status?: AttentionItemView['status'];
      kind?: AttentionItemKind;
      taskId?: string;
      priority?: AttentionItemPriority;
    }
  | undefined {
  if (filter === undefined) return undefined;
  return {
    status: filter.status,
    kind: filter.kind,
    taskId: filter.taskId,
    priority: filter.priority,
  };
}

/** Whether an item matches the (optional) view filter. */
function matchesViewFilter(item: AttentionItem, filter?: ViewFilter): boolean {
  if (filter === undefined) return true;
  if (filter.status !== undefined && item.status !== filter.status) return false;
  if (filter.kind !== undefined && item.kind !== filter.kind) return false;
  if (filter.taskId !== undefined && item.taskId !== filter.taskId) return false;
  if (filter.priority !== undefined && item.priority !== filter.priority) return false;
  return true;
}

/**
 * Derive a short title for an item: the kind label plus the task id, so the
 * card header is meaningful even without payload inspection.
 */
function deriveTitle(item: AttentionItem): string {
  const kindLabel = KIND_METADATA[item.kind].label;
  return `${kindLabel} · ${item.taskId}`;
}

/**
 * Derive a one-line summary from the payload, if it carries a `message` or
 * `reason` field. Falls back to the kind label so cards always have text.
 */
function deriveSummary(item: AttentionItem): string {
  const payload = item.payload as Record<string, unknown>;
  const message =
    typeof payload['message'] === 'string'
      ? (payload['message'] as string)
      : typeof payload['reason'] === 'string'
        ? (payload['reason'] as string)
        : undefined;
  if (message !== undefined && message.length > 0) return message;
  return KIND_METADATA[item.kind].label;
}
