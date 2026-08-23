import { describe, it, expect, vi, beforeEach } from 'vitest';

import { KeyboardNavigator } from '../src/desktop/keyboard-nav.js';
import type { NavAction } from '../src/desktop/keyboard-nav.js';

/** Build a KeyEventLike for a single key (no modifiers). */
function key(key: string, mods: Partial<{
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}> = {}): {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
} {
  return { key, ...mods };
}

/* ------------------------------------------------------------------ *
 * KeyboardNavigator — basic state
 * ------------------------------------------------------------------ */
describe('KeyboardNavigator basic state', () => {
  it('starts empty with no selection', () => {
    const nav = new KeyboardNavigator();
    expect(nav.currentItems).toEqual([]);
    expect(nav.currentIndex).toBe(-1);
    expect(nav.currentId).toBeNull();
  });

  it('setItems populates the list and selects the first item', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b', 'c']);
    expect(nav.currentItems).toEqual(['a', 'b', 'c']);
    expect(nav.currentIndex).toBe(0);
    expect(nav.currentId).toBe('a');
  });

  it('setItems on empty list clears selection', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b']);
    nav.setItems([]);
    expect(nav.currentItems).toEqual([]);
    expect(nav.currentIndex).toBe(-1);
    expect(nav.currentId).toBeNull();
  });

  it('setItems preserves selection by id when possible', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b', 'c']);
    nav.handleKey(key('j'));
    expect(nav.currentId).toBe('b');
    // Re-set with b in a different position.
    nav.setItems(['x', 'b', 'y']);
    expect(nav.currentId).toBe('b');
    expect(nav.currentIndex).toBe(1);
  });

  it('setItems resets to first when previous id is gone', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b', 'c']);
    nav.handleKey(key('j'));
    expect(nav.currentId).toBe('b');
    nav.setItems(['x', 'y', 'z']);
    expect(nav.currentId).toBe('x');
    expect(nav.currentIndex).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * KeyboardNavigator — movement (j/k, arrows)
 * ------------------------------------------------------------------ */
describe('KeyboardNavigator movement', () => {
  it('j moves selection down', () => {
    const nav = new KeyboardNavigator();
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    nav.setItems(['a', 'b', 'c']);
    cb.mockClear();
    expect(nav.handleKey(key('j'))).toBe(true);
    expect(nav.currentId).toBe('b');
    expect(cb).toHaveBeenCalledWith({ type: 'move', id: 'b', index: 1 });
  });

  it('k moves selection up', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b', 'c']);
    nav.handleKey(key('j'));
    nav.handleKey(key('j'));
    expect(nav.currentId).toBe('c');
    expect(nav.handleKey(key('k'))).toBe(true);
    expect(nav.currentId).toBe('b');
  });

  it('ArrowDown moves down and ArrowUp moves up', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b', 'c']);
    expect(nav.handleKey(key('ArrowDown'))).toBe(true);
    expect(nav.currentId).toBe('b');
    expect(nav.handleKey(key('ArrowUp'))).toBe(true);
    expect(nav.currentId).toBe('a');
  });

  it('j clamps at the bottom (no move past last item)', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b']);
    nav.handleKey(key('j'));
    expect(nav.currentId).toBe('b');
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    expect(nav.handleKey(key('j'))).toBe(true);
    expect(nav.currentId).toBe('b');
    // Consumed but no move action emitted (already at bottom).
    expect(cb).not.toHaveBeenCalled();
  });

  it('k clamps at the top (no move before first item)', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b']);
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    expect(nav.handleKey(key('k'))).toBe(true);
    expect(nav.currentId).toBe('a');
    expect(cb).not.toHaveBeenCalled();
  });

  it('movement is a no-op (returns false) on an empty list', () => {
    const nav = new KeyboardNavigator();
    expect(nav.handleKey(key('j'))).toBe(false);
    expect(nav.handleKey(key('k'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * KeyboardNavigator — approve / deny / activate (y / d / Enter)
 * ------------------------------------------------------------------ */
describe('KeyboardNavigator approve/deny/activate', () => {
  it('y emits an approve action for the selected item', () => {
    const nav = new KeyboardNavigator();
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    nav.setItems(['a', 'b', 'c']);
    nav.handleKey(key('j'));
    cb.mockClear();
    expect(nav.handleKey(key('y'))).toBe(true);
    expect(cb).toHaveBeenCalledWith({ type: 'approve', id: 'b', index: 1 });
  });

  it('d emits a deny action for the selected item', () => {
    const nav = new KeyboardNavigator();
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    nav.setItems(['a', 'b', 'c']);
    cb.mockClear();
    expect(nav.handleKey(key('d'))).toBe(true);
    expect(cb).toHaveBeenCalledWith({ type: 'deny', id: 'a', index: 0 });
  });

  it('Enter emits an activate action for the selected item', () => {
    const nav = new KeyboardNavigator();
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    nav.setItems(['a', 'b']);
    cb.mockClear();
    expect(nav.handleKey(key('Enter'))).toBe(true);
    expect(cb).toHaveBeenCalledWith({ type: 'activate', id: 'a', index: 0 });
  });

  it('y/d/Enter return false on an empty list', () => {
    const nav = new KeyboardNavigator();
    expect(nav.handleKey(key('y'))).toBe(false);
    expect(nav.handleKey(key('d'))).toBe(false);
    expect(nav.handleKey(key('Enter'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * KeyboardNavigator — top / bottom (g / G)
 * ------------------------------------------------------------------ */
describe('KeyboardNavigator top/bottom', () => {
  it('g jumps to the first item', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b', 'c']);
    nav.handleKey(key('j'));
    nav.handleKey(key('j'));
    expect(nav.currentId).toBe('c');
    expect(nav.handleKey(key('g'))).toBe(true);
    expect(nav.currentId).toBe('a');
    expect(nav.currentIndex).toBe(0);
  });

  it('G (shift+g) jumps to the last item', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b', 'c']);
    expect(nav.handleKey(key('g', { shiftKey: true }))).toBe(true);
    expect(nav.currentId).toBe('c');
    expect(nav.currentIndex).toBe(2);
  });

  it('g on empty list emits top without error', () => {
    const nav = new KeyboardNavigator();
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    expect(nav.handleKey(key('g'))).toBe(true);
    expect(cb).toHaveBeenCalledWith({ type: 'top' });
  });

  it('G on empty list emits bottom without error', () => {
    const nav = new KeyboardNavigator();
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    expect(nav.handleKey(key('g', { shiftKey: true }))).toBe(true);
    expect(cb).toHaveBeenCalledWith({ type: 'bottom' });
  });
});

/* ------------------------------------------------------------------ *
 * KeyboardNavigator — modifier chords ignored
 * ------------------------------------------------------------------ */
describe('KeyboardNavigator modifier chords', () => {
  it('ignores ctrl+j (belongs to global hotkeys)', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b']);
    expect(nav.handleKey(key('j', { ctrlKey: true }))).toBe(false);
    expect(nav.currentId).toBe('a');
  });

  it('ignores meta+k', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b']);
    nav.handleKey(key('j'));
    expect(nav.handleKey(key('k', { metaKey: true }))).toBe(false);
    expect(nav.currentId).toBe('b');
  });

  it('ignores alt+y', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b']);
    expect(nav.handleKey(key('y', { altKey: true }))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * KeyboardNavigator — unknown keys
 * ------------------------------------------------------------------ */
describe('KeyboardNavigator unknown keys', () => {
  it('returns false for unmapped keys', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['a', 'b']);
    expect(nav.handleKey(key('x'))).toBe(false);
    expect(nav.handleKey(key('z'))).toBe(false);
    expect(nav.handleKey(key('1'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * KeyboardNavigator — view-agnosticism (inbox / approvals / digest)
 * ------------------------------------------------------------------ */
describe('KeyboardNavigator view-agnosticism', () => {
  it('works over inbox item ids', () => {
    const nav = new KeyboardNavigator();
    nav.setItems(['inbox-1', 'inbox-2', 'inbox-3']);
    nav.handleKey(key('j'));
    expect(nav.currentId).toBe('inbox-2');
    nav.handleKey(key('y'));
    // approve emitted for inbox-2 (verified via callback in earlier tests).
  });

  it('works over approval card ids', () => {
    const nav = new KeyboardNavigator();
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    nav.setItems(['approval-a', 'approval-b']);
    nav.handleKey(key('j'));
    cb.mockClear();
    nav.handleKey(key('d'));
    expect(cb).toHaveBeenCalledWith({ type: 'deny', id: 'approval-b', index: 1 });
  });

  it('works over digest viewer section ids', () => {
    const nav = new KeyboardNavigator();
    const cb = vi.fn<(a: NavAction) => void>();
    nav.onAction(cb);
    nav.setItems(['digest-summary', 'digest-tests', 'digest-diff']);
    nav.handleKey(key('j'));
    nav.handleKey(key('j'));
    cb.mockClear();
    nav.handleKey(key('Enter'));
    expect(cb).toHaveBeenCalledWith({
      type: 'activate',
      id: 'digest-diff',
      index: 2,
    });
  });
});
