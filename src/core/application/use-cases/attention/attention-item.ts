/**
 * `AttentionItem` domain object for the attention inbox (DEC-006, DEC-014).
 *
 * Represents a single item the human should look at. Each item is classified
 * by `kind` (what category of thing needs attention), `priority` (how urgent),
 * and `status` (where it sits in the inbox lifecycle), and carries an
 * event-specific structured `payload`.
 *
 * Priority ordering: **Critical > High > Medium > Low**. Within the same
 * priority, earlier `createdAt` wins (FIFO) — see {@link compareAttentionItems}.
 *
 * The home screen is an attention inbox, not a Kanban board (DEC-006). These
 * items are the unit the inbox surfaces, groups, and collapses.
 */

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/**
 * The kind of attention item — what category of thing needs human attention.
 *
 * Mapped from {@link SupervisorEvent} variants by the
 * {@link AttentionAggregator}, or reported directly by daemon subsystems
 * (e.g. dirty worktree, liveness timeout).
 */
export type AttentionItemKind =
  | 'ApprovalRequest'
  | 'FailedRun'
  | 'DirtyWorktree'
  | 'IdleAgent'
  | 'StaleTask'
  | 'Digest'
  | 'UnverifiedCompletion'
  | 'Custom';

/**
 * Priority levels, ordered **Critical > High > Medium > Low**.
 *
 * The numeric rank is available via {@link PRIORITY_RANK}.
 */
export type AttentionItemPriority = 'Critical' | 'High' | 'Medium' | 'Low';

/**
 * Lifecycle status of an attention item.
 *
 * - `Pending` — newly surfaced, not yet looked at.
 * - `Acknowledged` — the human has seen it; still visible but not "new".
 * - `Resolved` — handled; removed from the active queue.
 * - `Escalated` — boosted to `Critical` priority (e.g. overdue approval).
 */
export type AttentionItemStatus = 'Pending' | 'Acknowledged' | 'Resolved' | 'Escalated';

/**
 * A single item the human should look at.
 *
 * `priority` and `status` are mutable — the inbox escalates, acknowledges,
 * and resolves items in place. The remaining fields are immutable identity /
 * provenance fields.
 */
export interface AttentionItem {
  /** Stable unique identifier. */
  readonly id: string;
  /** Identifier of the Task this item belongs to (DEC-004). */
  readonly taskId: string;
  /** What category of thing needs attention. */
  readonly kind: AttentionItemKind;
  /** Current priority (mutable: {@link AttentionInbox.escalate} boosts to Critical). */
  priority: AttentionItemPriority;
  /** ISO-8601 timestamp of when the item was created. */
  readonly createdAt: string;
  /** Optional ISO-8601 expiry timestamp (e.g. approval deadline). */
  readonly expiresAt?: string;
  /** Event-specific structured data (deterministic adapter fields, DEC-010). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Current lifecycle status (mutable). */
  status: AttentionItemStatus;
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Numeric rank for priority comparison (higher = more urgent). */
export const PRIORITY_RANK: Readonly<Record<AttentionItemPriority, number>> = {
  Critical: 3,
  High: 2,
  Medium: 1,
  Low: 0,
} as const;

/** Ordered list of priorities from highest to lowest. */
export const PRIORITY_ORDER: readonly AttentionItemPriority[] = [
  'Critical',
  'High',
  'Medium',
  'Low',
] as const;

/** All valid attention item kinds. */
export const ATTENTION_ITEM_KINDS: readonly AttentionItemKind[] = [
  'ApprovalRequest',
  'FailedRun',
  'DirtyWorktree',
  'IdleAgent',
  'StaleTask',
  'Digest',
  'UnverifiedCompletion',
  'Custom',
] as const;

/** All valid attention item statuses. */
export const ATTENTION_ITEM_STATUSES: readonly AttentionItemStatus[] = [
  'Pending',
  'Acknowledged',
  'Resolved',
  'Escalated',
] as const;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Compare two attention items for priority-queue ordering.
 *
 * Ordering: higher priority first (Critical > High > Medium > Low); within
 * the same priority, earlier `createdAt` wins (FIFO). A stable id tie-break
 * ensures deterministic ordering when both priority and timestamp are equal.
 *
 * @returns negative when `a` should come before `b`, positive when `b`
 *   should come before `a`, zero when they are equal in ordering.
 */
export function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  const priDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  if (priDiff !== 0) {
    return priDiff;
  }
  // Earlier createdAt wins (FIFO within the same priority).
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  // Stable tie-break on id.
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Generate a reasonably unique id without a crypto dependency. */
export function generateAttentionItemId(prefix = 'attn'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

/** Input for {@link createAttentionItem}. */
export interface CreateAttentionItemInput {
  /** Explicit id (defaults to a generated one). */
  readonly id?: string;
  /** Identifier of the Task this item belongs to. */
  readonly taskId: string;
  /** What category of thing needs attention. */
  readonly kind: AttentionItemKind;
  /** Initial priority. */
  readonly priority: AttentionItemPriority;
  /** ISO-8601 creation timestamp (defaults to now). */
  readonly createdAt?: string;
  /** Optional ISO-8601 expiry timestamp. */
  readonly expiresAt?: string;
  /** Event-specific structured data. */
  readonly payload?: Record<string, unknown>;
  /** Initial status (defaults to `Pending`). */
  readonly status?: AttentionItemStatus;
}

/**
 * Build an {@link AttentionItem} with sensible defaults.
 *
 * `status` defaults to `Pending` and `payload` defaults to an empty record.
 */
export function createAttentionItem(input: CreateAttentionItemInput): AttentionItem {
  return {
    id: input.id ?? generateAttentionItemId(),
    taskId: input.taskId,
    kind: input.kind,
    priority: input.priority,
    createdAt: input.createdAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt,
    payload: input.payload ?? {},
    status: input.status ?? 'Pending',
  };
}
