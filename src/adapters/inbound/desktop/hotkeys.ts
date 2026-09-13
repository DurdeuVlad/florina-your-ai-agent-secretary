/**
 * Global hotkey manager for the desktop app (DEC-028, issue #28).
 *
 * {@link HotkeyManager} registers keyboard shortcuts and dispatches them to
 * callbacks. It uses a pluggable {@link KeyboardBackend} so the hotkey logic
 * is fully testable without real OS-level keyboard hooks — in production the
 * backend wraps Electron's `globalShortcut` / Tauri's accelerator API; in
 * tests a {@link MockKeyboardBackend} records registrations.
 *
 * Accelerators use the Electron-style format: modifier tokens joined by `+`
 * followed by the key, e.g. `"CommandOrControl+Shift+Space"`, `"Alt+P"`.
 * Supported modifiers: `CommandOrControl` (ctrl on Win/Linux, meta on macOS),
 * `Control` / `Ctrl`, `Command` / `Cmd` / `Meta`, `Alt` / `Option`, `Shift`.
 *
 * The manager also supports in-process event matching via {@link match} and
 * {@link dispatchEvent}, so a renderer can forward DOM `KeyboardEvent`s to
 * the same registered accelerators without a separate binding layer.
 */
/* ------------------------------------------------------------------ *
 * Default accelerators (issue #28)
 * ------------------------------------------------------------------ */

/**
 * The default global hotkeys for the desktop app (issue #28).
 *
 * - `PTT_HOLD`    — hold to talk (push-to-talk).
 * - `PTT_TOGGLE`  — toggle continuous listening.
 * - `APPROVE`     — approve the current request.
 * - `DENY`        — deny the current request.
 * - `INBOX`       — open the attention inbox.
 * - `ESCALATE`    — escalate the current item.
 */
export const DEFAULT_HOTKEYS = {
  PTT_HOLD: 'CommandOrControl+Space',
  PTT_TOGGLE: 'CommandOrControl+Shift+Space',
  APPROVE: 'CommandOrControl+Y',
  DENY: 'CommandOrControl+N',
  INBOX: 'CommandOrControl+I',
  ESCALATE: 'CommandOrControl+E',
} as const;

/** Logical hotkey action names (keys of {@link DEFAULT_HOTKEYS}). */
export type HotkeyAction = keyof typeof DEFAULT_HOTKEYS;

/* ------------------------------------------------------------------ *
 * KeyEvent-like
 * ------------------------------------------------------------------ */

/**
 * A minimal, DOM-`KeyboardEvent`-like shape used for in-process matching.
 *
 * This is deliberately framework-agnostic so the manager can match events
 * from a browser webview, a TUI key reader, or a test harness without
 * pulling in DOM types.
 */
export interface KeyEventLike {
  /** The key value (e.g. `" "`, `"Enter"`, `"p"`). Compared case-insensitively. */
  readonly key: string;
  /** Whether the Control modifier is held. */
  readonly ctrlKey?: boolean;
  /** Whether the Meta (Command) modifier is held. */
  readonly metaKey?: boolean;
  /** Whether the Alt (Option) modifier is held. */
  readonly altKey?: boolean;
  /** Whether the Shift modifier is held. */
  readonly shiftKey?: boolean;
}

/* ------------------------------------------------------------------ *
 * Parsed accelerator
 * ------------------------------------------------------------------ */

/**
 * The parsed form of an accelerator string: the normalized key plus the
 * active modifier flags. `commandOrControl` is `true` when the accelerator
 * used the `CommandOrControl` token; at match time it is satisfied by
 * either `ctrl` or `meta`.
 */
export interface ParsedAccelerator {
  /** The normalized key token (e.g. `"space"`, `"p"`, `"y"`). */
  readonly key: string;
  /** Whether the Control modifier is required. */
  readonly ctrl: boolean;
  /** Whether the Meta (Command) modifier is required. */
  readonly meta: boolean;
  /** Whether the Alt (Option) modifier is required. */
  readonly alt: boolean;
  /** Whether the Shift modifier is required. */
  readonly shift: boolean;
  /** Whether the `CommandOrControl` token was used (ctrl OR meta at match). */
  readonly commandOrControl: boolean;
  /** The original accelerator string. */
  readonly raw: string;
}

/* ------------------------------------------------------------------ *
 * KeyboardBackend — pluggable OS-level registration
 * ------------------------------------------------------------------ */

/**
 * Pluggable backend for OS-level global shortcut registration.
 *
 * Implementations:
 * - **Production**: wraps Electron `globalShortcut` / Tauri accelerator API.
 * - **Tests**: {@link MockKeyboardBackend} records registrations in memory.
 *
 * The backend only handles OS-level registration / unregistration; the
 * {@link HotkeyManager} owns the callback dispatch.
 */
export interface KeyboardBackend {
  /**
   * Register a global shortcut for the accelerator. Returns `true` if the
   * registration succeeded (some platforms reject duplicates or conflicts).
   */
  register(accelerator: string): boolean;
  /** Unregister a previously-registered global shortcut. */
  unregister(accelerator: string): void;
  /** Unregister all previously-registered global shortcuts. */
  unregisterAll(): void;
}

/**
 * In-memory {@link KeyboardBackend} for tests and headless environments.
 *
 * Records every registered accelerator in a `Set` so tests can assert which
 * shortcuts were registered. `register` always succeeds (returns `true`)
 * unless the accelerator was already registered (returns `false`, mirroring
 * platforms that reject duplicates).
 */
export class MockKeyboardBackend implements KeyboardBackend {
  /** The set of currently-registered accelerators. */
  readonly registered = new Set<string>();

  register(accelerator: string): boolean {
    if (this.registered.has(accelerator)) return false;
    this.registered.add(accelerator);
    return true;
  }

  unregister(accelerator: string): void {
    this.registered.delete(accelerator);
  }

  unregisterAll(): void {
    this.registered.clear();
  }
}

/* ------------------------------------------------------------------ *
 * HotkeyManager
 * ------------------------------------------------------------------ */

/**
 * Registers and dispatches keyboard shortcuts.
 *
 * Construct with a {@link KeyboardBackend} (defaults to a
 * {@link MockKeyboardBackend}) and register accelerators via
 * {@link register}. The manager tracks callbacks by accelerator string and
 * can dispatch them either via {@link dispatch} (when the backend reports a
 * global shortcut fire) or via {@link dispatchEvent} (when a renderer
 * forwards a DOM `KeyboardEvent`-like event).
 */
export class HotkeyManager {
  private readonly backend: KeyboardBackend;
  /** Callbacks keyed by canonical accelerator string. */
  private readonly callbacks = new Map<string, () => void>();

  constructor(backend: KeyboardBackend = new MockKeyboardBackend()) {
    this.backend = backend;
  }

  /**
   * Register a hotkey. Registers the accelerator with the backend and stores
   * the callback. If the accelerator was already registered, the previous
   * callback is replaced (and the backend registration is refreshed).
   *
   * @param accelerator - Electron-style accelerator (e.g. `"Alt+P"`).
   * @param callback - Invoked when the hotkey fires.
   * @returns `true` if the backend accepted the registration.
   */
  register(accelerator: string, callback: () => void): boolean {
    const canonical = canonicalize(accelerator);
    if (this.callbacks.has(canonical)) {
      // Refresh the backend registration for the replaced callback.
      this.backend.unregister(canonical);
    }
    const ok = this.backend.register(canonical);
    if (!ok && !this.callbacks.has(canonical)) {
      // Backend rejected a fresh registration — do not store a callback.
      return false;
    }
    this.callbacks.set(canonical, callback);
    return true;
  }

  /**
   * Remove a registered hotkey. Unregisters with the backend and drops the
   * callback. No-op if the accelerator was not registered.
   */
  unregister(accelerator: string): void {
    const canonical = canonicalize(accelerator);
    this.backend.unregister(canonical);
    this.callbacks.delete(canonical);
  }

  /** Remove all registered hotkeys. */
  unregisterAll(): void {
    this.backend.unregisterAll();
    this.callbacks.clear();
  }

  /** Whether an accelerator is currently registered. */
  isRegistered(accelerator: string): boolean {
    return this.callbacks.has(canonicalize(accelerator));
  }

  /** The list of currently-registered accelerators (canonical form). */
  get registeredAccelerators(): readonly string[] {
    return [...this.callbacks.keys()];
  }

  /**
   * Dispatch the callback for a registered accelerator. No-op if the
   * accelerator is not registered. Returns `true` if a callback fired.
   *
   * This is the entry point used when the OS-level backend reports a global
   * shortcut fire.
   */
  dispatch(accelerator: string): boolean {
    const cb = this.callbacks.get(canonicalize(accelerator));
    if (cb === undefined) return false;
    cb();
    return true;
  }

  /**
   * Find the registered accelerator that matches a keyboard event, or
   * `null` if none match.
   *
   * Matching compares the normalized key and modifier flags. For
   * `CommandOrControl` accelerators, either `ctrl` or `meta` satisfies the
   * modifier. An accelerator that requires an explicit `Control` modifier
   * is not satisfied by `meta` alone (and vice versa).
   */
  findMatch(event: KeyEventLike): string | null {
    const ev = normalizeEvent(event);
    for (const accelerator of this.callbacks.keys()) {
      const parsed = parseAccelerator(accelerator);
      if (matchesParsed(parsed, ev)) return accelerator;
    }
    return null;
  }

  /**
   * Check whether a keyboard event matches any registered accelerator.
   * Convenience wrapper around {@link findMatch}.
   */
  match(event: KeyEventLike): boolean {
    return this.findMatch(event) !== null;
  }

  /**
   * Dispatch the callback for the registered accelerator matching a
   * keyboard event. Returns `true` if a callback fired.
   *
   * This is the entry point used when a renderer forwards a DOM
   * `KeyboardEvent`-like event in-process.
   */
  dispatchEvent(event: KeyEventLike): boolean {
    const accelerator = this.findMatch(event);
    if (accelerator === null) return false;
    return this.dispatch(accelerator);
  }

  /**
   * Register all {@link DEFAULT_HOTKEYS} with the given callbacks. Missing
   * callbacks are skipped (the action is simply not registered).
   *
   * @param callbacks - A map from {@link HotkeyAction} to callback. Only the
   *   supplied actions are registered.
   * @returns the set of actions that were successfully registered.
   */
  registerDefaults(callbacks: Partial<Record<HotkeyAction, () => void>>): Set<HotkeyAction> {
    const registered = new Set<HotkeyAction>();
    for (const action of Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]) {
      const cb = callbacks[action];
      if (cb === undefined) continue;
      const accelerator = DEFAULT_HOTKEYS[action];
      if (this.register(accelerator, cb)) {
        registered.add(action);
      }
    }
    return registered;
  }
}

/* ------------------------------------------------------------------ *
 * Accelerator parsing
 * ------------------------------------------------------------------ */

/**
 * Parse an Electron-style accelerator string into a {@link ParsedAccelerator}.
 *
 * The last `+`-separated token is the key; all preceding tokens are
 * modifiers. Modifiers are matched case-insensitively and accept aliases:
 * - `CommandOrControl` / `CmdOrCtrl` → commandOrControl
 * - `Control` / `Ctrl` → ctrl
 * - `Command` / `Cmd` / `Meta` / `Super` → meta
 * - `Alt` / `Option` / `Opt` → alt
 * - `Shift` → shift
 *
 * The key is normalized via {@link normalizeKeyToken} (e.g. `"Space"` →
 * `"space"`, `"P"` → `"p"`).
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator {
  const parts = accelerator.split('+').map((p) => p.trim());
  let key = '';
  let ctrl = false;
  let meta = false;
  let alt = false;
  let shift = false;
  let commandOrControl = false;
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    const lower = token.toLowerCase();
    if (i === parts.length - 1) {
      key = normalizeKeyToken(token);
      continue;
    }
    switch (lower) {
      case 'commandorcontrol':
      case 'cmdorctrl':
        commandOrControl = true;
        break;
      case 'control':
      case 'ctrl':
        ctrl = true;
        break;
      case 'command':
      case 'cmd':
      case 'meta':
      case 'super':
        meta = true;
        break;
      case 'alt':
      case 'option':
      case 'opt':
        alt = true;
        break;
      case 'shift':
        shift = true;
        break;
      default:
        // Unknown modifier token — treat as part of the key only if it is
        // the last token; otherwise ignore.
        break;
    }
  }
  if (key === '') {
    // Single-token accelerator (no modifiers).
    key = normalizeKeyToken(parts[0]);
  }
  return { key, ctrl, meta, alt, shift, commandOrControl, raw: accelerator };
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/**
 * Canonicalize an accelerator string for stable keying: parse it and
 * re-emit in a normalized form. This means `"CmdOrCtrl+Space"` and
 * `"CommandOrControl+Space"` map to the same canonical string.
 */
function canonicalize(accelerator: string): string {
  const p = parseAccelerator(accelerator);
  const mods: string[] = [];
  if (p.commandOrControl) mods.push('CommandOrControl');
  if (p.ctrl) mods.push('Control');
  if (p.meta) mods.push('Command');
  if (p.alt) mods.push('Alt');
  if (p.shift) mods.push('Shift');
  mods.push(p.key);
  return mods.join('+');
}

/** Normalize a key token for case-insensitive comparison. */
function normalizeKeyToken(token: string): string {
  const lower = token.toLowerCase();
  switch (lower) {
    case ' ':
    case 'space':
    case 'spacebar':
      return 'space';
    case 'enter':
    case 'return':
      return 'enter';
    case 'esc':
    case 'escape':
      return 'escape';
    case 'tab':
      return 'tab';
    case 'backspace':
      return 'backspace';
    case 'up':
      return 'up';
    case 'down':
      return 'down';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    default:
      // Single-character keys are lowercased; named keys keep their case
      // normalized to lower for consistent comparison.
      return lower;
  }
}

/** Normalize a {@link KeyEventLike} into a comparable shape. */
function normalizeEvent(event: KeyEventLike): {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
} {
  return {
    key: normalizeKeyToken(event.key),
    ctrl: event.ctrlKey ?? false,
    meta: event.metaKey ?? false,
    alt: event.altKey ?? false,
    shift: event.shiftKey ?? false,
  };
}

/** Whether a parsed accelerator matches a normalized event. */
function matchesParsed(
  parsed: ParsedAccelerator,
  ev: { key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean },
): boolean {
  if (parsed.key !== ev.key) return false;
  // CommandOrControl is satisfied by ctrl OR meta.
  if (parsed.commandOrControl) {
    if (!ev.ctrl && !ev.meta) return false;
  } else {
    if (parsed.ctrl !== ev.ctrl) return false;
    if (parsed.meta !== ev.meta) return false;
  }
  if (parsed.alt !== ev.alt) return false;
  if (parsed.shift !== ev.shift) return false;
  return true;
}
