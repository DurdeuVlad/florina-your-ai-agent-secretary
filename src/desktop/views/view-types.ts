/**
 * View-layer types for the Attention Inbox UI (DEC-006, DEC-028, issue #25).
 *
 * These are pure, JSON-serializable data structures — no DOM, no React, no
 * framework. The desktop renderer (or any other surface) consumes them and
 * projects them onto whatever concrete rendering technology it uses. Keeping
 * the view model framework-agnostic means the inbox view logic is fully
 * testable with vitest and identical across surfaces.
 *
 * The home screen is an attention inbox, not a Kanban board (DEC-006): items
 * are grouped by priority (Critical / High / Medium / Low) and sorted FIFO
 * within each group.
 */
import type {
  AttentionItemKind,
  AttentionItemPriority,
  AttentionItemStatus,
} from '../../attention/attention-item.js';

/* ------------------------------------------------------------------ *
 * RenderTree — lightweight virtual DOM
 * ------------------------------------------------------------------ */

/**
 * A lightweight virtual DOM node: a plain, serializable object describing a
 * renderable element. No DOM access, no framework dependency. Any renderer
 * (React, Tauri webview, TUI, test harness) can walk this tree and project it
 * onto its own surface.
 *
 * `props` carries style hints (colors, icons, spacing), accessibility labels,
 * and event handlers (as string command identifiers, never closures, so the
 * whole tree stays JSON-serializable).
 */
export interface RenderTree {
  /** Element tag / component name (e.g. `div`, `InboxItem`, `button`). */
  readonly tag: string;
  /** Attributes, style hints, and serializable handler identifiers. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Child nodes and/or text. Strings are treated as text nodes. */
  readonly children?: readonly (RenderTree | string)[];
}

/* ------------------------------------------------------------------ *
 * Display metadata
 * ------------------------------------------------------------------ */

/**
 * Display metadata for a single visual facet (an item kind or a priority):
 * the icon glyph/identifier, a color token, and a human-readable label.
 *
 * `color` is a semantic color token (e.g. `'red'`, `'amber'`) rather than a
 * raw hex value, so each rendering surface can map it to its own palette.
 */
export interface DisplayMetadata {
  /** Icon identifier / glyph the renderer maps to its icon set. */
  readonly icon: string;
  /** Semantic color token (e.g. `'red'`, `'amber'`, `'blue'`). */
  readonly color: string;
  /** Human-readable label for this facet. */
  readonly label: string;
}

/* ------------------------------------------------------------------ *
 * AttentionItemView — display-ready representation of one item
 * ------------------------------------------------------------------ */

/**
 * Display-ready representation of a single {@link AttentionItem}.
 *
 * The view model enriches the raw item with display metadata (icon, color,
 * label) and a derived `title`/`summary` so templates don't need to inspect
 * payloads. All fields are readonly primitives or plain records so the whole
 * view is JSON-serializable.
 */
export interface AttentionItemView {
  /** Stable unique identifier (mirrors {@link AttentionItem.id}). */
  readonly id: string;
  /** Identifier of the Task this item belongs to. */
  readonly taskId: string;
  /** What category of thing needs attention. */
  readonly kind: AttentionItemKind;
  /** Display metadata for this item's kind. */
  readonly kindMeta: DisplayMetadata;
  /** Current priority. */
  readonly priority: AttentionItemPriority;
  /** Display metadata for this item's priority. */
  readonly priorityMeta: DisplayMetadata;
  /** Current lifecycle status. */
  readonly status: AttentionItemStatus;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** Optional ISO-8601 expiry timestamp. */
  readonly expiresAt?: string;
  /** Short human-readable title (e.g. task id + kind label). */
  readonly title: string;
  /** One-line summary derived from the payload, if available. */
  readonly summary: string;
  /** Event-specific structured data (verbatim from the source item). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/* ------------------------------------------------------------------ *
 * InboxViewData — grouped, sorted, filtered view data
 * ------------------------------------------------------------------ */

/**
 * A priority group within the inbox view: all items at one priority level,
 * sorted FIFO by `createdAt`.
 */
export interface PriorityGroup {
  /** The priority level this group represents. */
  readonly priority: AttentionItemPriority;
  /** Display metadata for this priority. */
  readonly meta: DisplayMetadata;
  /** Items in this group, sorted oldest-first (FIFO). */
  readonly items: readonly AttentionItemView[];
  /** Number of items in this group. */
  readonly count: number;
}

/**
 * The full inbox view data: items grouped by priority (Critical → Low), each
 * group sorted FIFO, after applying the active {@link ViewFilter}.
 *
 * Empty groups are omitted by default. `totalCount` reflects the number of
 * items that survived filtering.
 */
export interface InboxViewData {
  /** Priority groups, ordered Critical → Low, empty groups omitted. */
  readonly groups: readonly PriorityGroup[];
  /** Total number of items across all groups (post-filter). */
  readonly totalCount: number;
  /** Whether the view is empty (no items survived filtering). */
  readonly isEmpty: boolean;
  /** The filter that produced this view (undefined = no filter). */
  readonly filter?: ViewFilter;
}

/* ------------------------------------------------------------------ *
 * ViewFilter — filter specification for the inbox view
 * ------------------------------------------------------------------ */

/**
 * Filter specification for the inbox view. All fields are optional; only the
 * supplied fields are applied (logical AND). This mirrors
 * {@link AttentionInboxFilter} but is owned by the view layer so the UI can
 * express filters (e.g. "show only Pending") independently of the daemon.
 */
export interface ViewFilter {
  /** Only items with this status. */
  readonly status?: AttentionItemStatus;
  /** Only items with this kind. */
  readonly kind?: AttentionItemKind;
  /** Only items belonging to this task. */
  readonly taskId?: string;
  /** Only items with this priority. */
  readonly priority?: AttentionItemPriority;
}
