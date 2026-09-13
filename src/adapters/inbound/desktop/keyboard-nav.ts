/**
 * Keyboard navigation for the desktop app (DEC-028, issue #28).
 *
 * {@link KeyboardNavigator} provides instant, vim-style keyboard navigation
 * across the three primary views: the attention inbox, the approval cards,
 * and the digest viewer. It is pure and synchronous: no DOM, no framework,
 * no side effects beyond notifying subscribers of selection changes and
 * action requests. This keeps the navigation logic fully testable with
 * vitest and identical across rendering surfaces (desktop webview, TUI).
 *
 * Key bindings (issue #28):
 * - `j` / `ArrowDown` — move selection down (next item)
 * - `k` / `ArrowUp`   — move selection up (previous item)
 * - `y`              — approve the currently-selected item
 * - `d`              — deny the currently-selected item
 * - `Enter`          — open / activate the currently-selected item
 * - `g`              — go to top; `G` (shift+g) — go to bottom
 *
 * The navigator operates over a flat, ordered list of selectable item ids
 * supplied by the active view model. It does not inspect view payloads —
 * it only tracks the cursor and emits {@link NavAction} requests that the
 * host ({@link DesktopApp} or renderer) wires to the appropriate command.
 *
 * Per DEC-028, keyboard navigation must work across inbox, approvals, and
 * the digest viewer. The navigator is view-agnostic: the host supplies the
 * current list of selectable ids and the navigator handles movement and
 * action dispatch uniformly.
 */
import type { KeyEventLike } from './hotkeys.js';

/* ------------------------------------------------------------------ *
 * Navigation actions
 * ------------------------------------------------------------------ */

/**
 * A logical navigation action raised by the keyboard navigator.
 *
 * - `move` — the selection cursor moved (host should highlight the new id).
 * - `approve` — the user approved the selected item (y).
 * - `deny` — the user denied the selected item (d).
 * - `activate` — the user activated/opened the selected item (Enter).
 * - `top` — jump to the first item (g).
 * - `bottom` — jump to the last item (G).
 */
export type NavAction =
  | { readonly type: 'move'; readonly id: string; readonly index: number }
  | { readonly type: 'approve'; readonly id: string; readonly index: number }
  | { readonly type: 'deny'; readonly id: string; readonly index: number }
  | { readonly type: 'activate'; readonly id: string; readonly index: number }
  | { readonly type: 'top' }
  | { readonly type: 'bottom' };

/** Callback invoked when the navigator raises a {@link NavAction}. */
export type NavActionCallback = (action: NavAction) => void;

/* ------------------------------------------------------------------ *
 * KeyboardNavigator
 * ------------------------------------------------------------------ */

/**
 * Manages keyboard-driven selection navigation over an ordered list of
 * selectable item ids.
 *
 * Construct a navigator, then drive it with {@link setItems} whenever the
 * active view's selectable list changes, and {@link handleKey} for each
 * key event. The navigator maintains a cursor (index into the current item
 * list) and emits {@link NavAction}s via {@link onAction}.
 *
 * The navigator clamps the cursor to the valid range and preserves the
 * current selection across item-list updates when possible (by matching
 * the previously-selected id).
 */
export class KeyboardNavigator {
  private items: readonly string[] = [];
  private cursor = 0;
  private actionCallback: NavActionCallback | null = null;

  /** The current ordered list of selectable item ids. */
  get currentItems(): readonly string[] {
    return this.items;
  }

  /** The index of the currently-selected item, or -1 if the list is empty. */
  get currentIndex(): number {
    return this.items.length === 0 ? -1 : this.cursor;
  }

  /** The id of the currently-selected item, or null if the list is empty. */
  get currentId(): string | null {
    return this.items[this.cursor] ?? null;
  }

  /**
   * Replace the list of selectable item ids. Attempts to preserve the
   * current selection by matching the previously-selected id; otherwise
   * resets the cursor to 0 (or -1 if the new list is empty). Emits a
   * `move` action if the selection changed as a result.
   */
  setItems(ids: readonly string[]): void {
    const prevId = this.currentId;
    this.items = [...ids];
    if (this.items.length === 0) {
      this.cursor = 0;
      return;
    }
    // Preserve selection by id when possible.
    const matchIndex =
      prevId !== null ? this.items.indexOf(prevId) : -1;
    this.cursor = matchIndex >= 0 ? matchIndex : 0;
    // Only emit when the selection actually changed.
    if (this.currentId !== prevId && this.currentId !== null) {
      this.emit({ type: 'move', id: this.currentId, index: this.cursor });
    }
  }

  /**
   * Register the callback invoked when the navigator raises a
   * {@link NavAction}.
   */
  onAction(callback: NavActionCallback): void {
    this.actionCallback = callback;
  }

  /**
   * Handle a keyboard event. Returns `true` if the event was consumed
   * (matched a navigation binding), `false` otherwise. Consumed events
   * emit a {@link NavAction} via the registered callback.
   *
   * Navigation keys are only active when the item list is non-empty (except
   * `top`/`bottom`, which are no-ops on an empty list but still "consumed").
   * Modifier-chorded events (ctrl/meta/alt held) are ignored so they do not
   * conflict with global hotkeys.
   */
  handleKey(event: KeyEventLike): boolean {
    // Ignore modifier-chorded events — those belong to global hotkeys.
    if (event.ctrlKey || event.metaKey || event.altKey) return false;

    const key = event.key.toLowerCase();
    switch (key) {
      case 'j':
      case 'arrowdown':
        return this.moveBy(1);
      case 'k':
      case 'arrowup':
        return this.moveBy(-1);
      case 'y':
        return this.actOnSelected((id, index) => ({
          type: 'approve',
          id,
          index,
        }));
      case 'd':
        return this.actOnSelected((id, index) => ({
          type: 'deny',
          id,
          index,
        }));
      case 'enter':
        return this.actOnSelected((id, index) => ({
          type: 'activate',
          id,
          index,
        }));
      case 'g':
        if (event.shiftKey) {
          return this.jumpToBottom();
        }
        return this.jumpToTop();
      default:
        return false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Internal
   * ---------------------------------------------------------------- */

  /** Move the cursor by `delta` positions, clamping to the valid range. */
  private moveBy(delta: number): boolean {
    if (this.items.length === 0) return false;
    const next = clamp(this.cursor + delta, 0, this.items.length - 1);
    if (next === this.cursor) return true; // consumed but no change
    this.cursor = next;
    const id = this.items[next]!;
    this.emit({ type: 'move', id, index: next });
    return true;
  }

  /** Jump the cursor to the first item. */
  private jumpToTop(): boolean {
    if (this.items.length === 0) {
      this.emit({ type: 'top' });
      return true;
    }
    if (this.cursor === 0) return true;
    this.cursor = 0;
    this.emit({ type: 'move', id: this.items[0]!, index: 0 });
    this.emit({ type: 'top' });
    return true;
  }

  /** Jump the cursor to the last item. */
  private jumpToBottom(): boolean {
    if (this.items.length === 0) {
      this.emit({ type: 'bottom' });
      return true;
    }
    const last = this.items.length - 1;
    if (this.cursor === last) return true;
    this.cursor = last;
    this.emit({ type: 'move', id: this.items[last]!, index: last });
    this.emit({ type: 'bottom' });
    return true;
  }

  /**
   * Emit an action targeting the currently-selected item. Returns `false`
   * (event not consumed) if the list is empty.
   */
  private actOnSelected(
    build: (id: string, index: number) => NavAction,
  ): boolean {
    const id = this.currentId;
    if (id === null) return false;
    this.emit(build(id, this.cursor));
    return true;
  }

  /** Dispatch an action to the registered callback (if any). */
  private emit(action: NavAction): void {
    if (this.actionCallback !== null) {
      this.actionCallback(action);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Clamp `value` to the inclusive range [`min`, `max`]. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
