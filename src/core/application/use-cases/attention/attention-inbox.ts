/**
 * In-memory priority queue of {@link AttentionItem}s (DEC-006, DEC-014).
 *
 * The home screen is an attention inbox, not a Kanban board (DEC-006). This
 * class is the in-memory backing store for that inbox: it holds the current
 * set of attention items, orders them by priority (Critical > High > Medium >
 * Low, FIFO within the same priority), and exposes queue operations
 * (peek/take), lifecycle transitions (acknowledge/resolve/escalate), filtered
 * listing, and snapshot/restore for persistence.
 *
 * The inbox is intentionally a thin, synchronous, in-memory structure. The
 * {@link AttentionAggregator} populates it from the {@link EventBus}; the
 * daemon persists snapshots to SQLite and restores them on startup.
 */
import {
  type AttentionItem,
  type AttentionItemKind,
  type AttentionItemPriority,
  type AttentionItemStatus,
  compareAttentionItems,
} from './attention-item.js';

/* ------------------------------------------------------------------ *
 * Filter & snapshot types
 * ------------------------------------------------------------------ */

/**
 * Filter criteria for {@link AttentionInbox.list}.
 *
 * All fields are optional; only the supplied fields are applied (logical AND).
 */
export interface AttentionInboxFilter {
  /** Only items with this status. */
  readonly status?: AttentionItemStatus;
  /** Only items with this kind. */
  readonly kind?: AttentionItemKind;
  /** Only items belonging to this task. */
  readonly taskId?: string;
  /** Only items with this priority. */
  readonly priority?: AttentionItemPriority;
}

/**
 * Serializable snapshot of the inbox state.
 *
 * Produced by {@link AttentionInbox.snapshot} and consumed by
 * {@link AttentionInbox.restore}. The snapshot is a deep copy of the current
 * items so mutating the inbox after taking a snapshot does not affect it.
 */
export interface AttentionInboxSnapshot {
  /** All items currently in the inbox (in any order). */
  readonly items: readonly AttentionItem[];
}

/* ------------------------------------------------------------------ *
 * AttentionInbox
 * ------------------------------------------------------------------ */

/**
 * An in-memory priority queue of {@link AttentionItem}s.
 *
 * Items are stored by id and ordered on demand using
 * {@link compareAttentionItems}. The queue surfaces the highest-priority
 * `Pending` item via {@link peek} / {@link take}.
 */
export class AttentionInbox {
  /** All items keyed by id (including Acknowledged / Resolved / Escalated). */
  private readonly items = new Map<string, AttentionItem>();

  /**
   * Insert an item into the inbox in priority order.
   *
   * If an item with the same id already exists it is replaced.
   */
  add(item: AttentionItem): void {
    this.items.set(item.id, { ...item });
  }

  /**
   * Returns the highest-priority active (`Pending` or `Escalated`) item
   * without removing it.
   *
   * @returns the top active item, or `undefined` when there are none.
   */
  peek(): AttentionItem | undefined {
    const active = this.activeSorted();
    return active[0];
  }

  /**
   * Returns and removes the highest-priority active (`Pending` or
   * `Escalated`) item.
   *
   * @returns the removed item, or `undefined` when there are none active.
   */
  take(): AttentionItem | undefined {
    const active = this.activeSorted();
    const top = active[0];
    if (top !== undefined) {
      this.items.delete(top.id);
    }
    return top;
  }

  /**
   * Mark an item as `Acknowledged`.
   *
   * The item remains visible (e.g. in `list`) but is no longer surfaced as
   * "new" by {@link peek} / {@link take}.
   *
   * @returns `true` if the item was found and updated.
   */
  acknowledge(id: string): boolean {
    const item = this.items.get(id);
    if (item === undefined) return false;
    item.status = 'Acknowledged';
    return true;
  }

  /**
   * Mark an item as `Resolved`.
   *
   * Resolved items are removed from the active queue (they are no longer
   * returned by {@link peek} / {@link take}) but remain in the inbox for
   * history / audit until explicitly removed.
   *
   * @returns `true` if the item was found and updated.
   */
  resolve(id: string): boolean {
    const item = this.items.get(id);
    if (item === undefined) return false;
    item.status = 'Resolved';
    return true;
  }

  /**
   * Mark an item as `Escalated` and boost its priority to `Critical`.
   *
   * Escalated items jump to the front of the pending queue.
   *
   * @returns `true` if the item was found and updated.
   */
  escalate(id: string): boolean {
    const item = this.items.get(id);
    if (item === undefined) return false;
    item.priority = 'Critical';
    item.status = 'Escalated';
    return true;
  }

  /**
   * Merge fields into an item's payload in place.
   *
   * Used when an open item accumulates new evidence — issue #264 folds
   * each failed journal row in a burst into the card's retained
   * `writes` list so collapsing the storm never drops a write.
   *
   * @returns `true` if the item was found and updated.
   */
  mergePayload(id: string, patch: Record<string, unknown>): boolean {
    const item = this.items.get(id);
    if (item === undefined) return false;
    Object.assign(item.payload as Record<string, unknown>, patch);
    return true;
  }

  /**
   * Remove an item from the inbox entirely.
   *
   * Unlike {@link resolve}, this deletes the item rather than marking it
   * resolved. Useful for pruning resolved items after persistence.
   *
   * @returns `true` if the item was found and removed.
   */
  remove(id: string): boolean {
    return this.items.delete(id);
  }

  /**
   * Returns items matching the supplied filter, ordered by priority.
   *
   * When no filter is supplied, all items are returned (ordered).
   *
   * @param filter - Optional filter criteria (status, kind, taskId, priority).
   * @returns A new array; mutating it does not affect the inbox.
   */
  list(filter?: AttentionInboxFilter): AttentionItem[] {
    const all = [...this.items.values()];
    return all.filter((item) => matchesFilter(item, filter)).sort(compareAttentionItems);
  }

  /**
   * Returns a serializable snapshot of the inbox state.
   *
   * The snapshot is a deep copy of the current items; mutating the inbox
   * after taking a snapshot does not affect it. Restore with
   * {@link AttentionInbox.restore}.
   */
  snapshot(): AttentionInboxSnapshot {
    return {
      items: [...this.items.values()].map(cloneAttentionItem),
    };
  }

  /**
   * Restore an inbox from a previously taken snapshot.
   *
   * The restored inbox starts empty and is populated with copies of the
   * snapshot's items, so mutating either does not affect the other.
   *
   * @param snapshot - A snapshot produced by {@link AttentionInbox.snapshot}.
   * @returns A new {@link AttentionInbox} containing the snapshot's items.
   */
  static restore(snapshot: AttentionInboxSnapshot): AttentionInbox {
    const inbox = new AttentionInbox();
    for (const item of snapshot.items) {
      inbox.items.set(item.id, cloneAttentionItem(item));
    }
    return inbox;
  }

  /** Total number of items in the inbox (all statuses). */
  get size(): number {
    return this.items.size;
  }

  /** Number of active (`Pending` or `Escalated`) items currently in the inbox. */
  get pendingCount(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status === 'Pending' || item.status === 'Escalated') count++;
    }
    return count;
  }

  /* ---------------------------------------------------------------- *
   * Internal
   * ---------------------------------------------------------------- */

  /** All active (Pending or Escalated) items, ordered by priority then createdAt (FIFO). */
  private activeSorted(): AttentionItem[] {
    return [...this.items.values()]
      .filter((item) => item.status === 'Pending' || item.status === 'Escalated')
      .sort(compareAttentionItems);
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

function cloneAttentionItem(item: AttentionItem): AttentionItem {
  if (typeof structuredClone === 'function') {
    return structuredClone(item);
  }
  return JSON.parse(JSON.stringify(item)) as AttentionItem;
}

/** Whether an item matches the (optional) filter criteria. */
function matchesFilter(item: AttentionItem, filter?: AttentionInboxFilter): boolean {
  if (filter === undefined) return true;
  if (filter.status !== undefined && item.status !== filter.status) return false;
  if (filter.kind !== undefined && item.kind !== filter.kind) return false;
  if (filter.taskId !== undefined && item.taskId !== filter.taskId) return false;
  if (filter.priority !== undefined && item.priority !== filter.priority) return false;
  return true;
}
