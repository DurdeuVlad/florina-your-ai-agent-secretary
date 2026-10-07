/**
 * Push-to-talk hotkey resolution and live rebinding (issue #332).
 *
 * Owns the "which accelerator should PTT use" answer and the safe rebind
 * path, so the bootstrap wiring and the `deskset:` save handler stay thin.
 * Registration itself stays inside {@link HotkeyManager} — this module
 * decides what to register and when, and reports the outcome via a HUD
 * hint callback so a conflict is surfaced honestly.
 *
 * Precedence: `FLORINA_PTT_HOTKEY` env > `desktop-settings.json`
 * `pttHotkey` > {@link DEFAULT_HOTKEYS}.PTT_HOLD. The env var is the
 * operator override — a saved setting takes effect only when it is absent.
 */
import { DEFAULT_HOTKEYS, HotkeyManager } from './hotkeys.js';

export interface PttHotkeyDeps {
  /** The hotkey manager that owns OS-level registration. */
  readonly hotkeys: HotkeyManager;
  /** Snapshot of `FLORINA_PTT_HOTKEY` — wins over everything when set. */
  readonly envAccelerator?: string;
  /** Snapshot of the saved `pttHotkey` desktop setting at startup. */
  readonly savedAccelerator?: string;
  /** Fallback when neither env nor a saved value exists. */
  readonly defaultAccelerator?: string;
  /** What fires when the hotkey is pressed (typically `pttToggle`). */
  readonly onFire: () => void;
  /** Receives the HUD hint text for the pill (success or conflict copy). */
  readonly onHint?: (hint: string) => void;
  /** Display-name mapper, e.g. `CommandOrControl` → `Cmd`/`Ctrl`. */
  readonly hintFor?: (accelerator: string) => string;
}

export interface PttHotkeyResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Resolved accelerator source — for the conflict-hint copy only. */
type Source = 'env' | 'saved' | 'default';

export interface PttHotkey {
  /** The accelerator the app is trying to bind (env > saved > default). */
  effective(): string;
  /**
   * Initial registration. Returns `true` when the binding landed; on
   * conflict returns `false` and the HUD hint explains the recovery path.
   */
  register(): boolean;
  /**
   * Rebind after a `deskset:` save. `saved` is the value the user wants
   * persisted (`null` = clear back to default/env). Returns `{ok: false}`
   * without dropping the currently-working registration when the new
   * accelerator cannot be claimed.
   */
  rebind(saved: string | null): PttHotkeyResult;
}

export function createPttHotkey(deps: PttHotkeyDeps): PttHotkey {
  const hintFor = deps.hintFor ?? ((a: string) => a);
  const fallback = deps.defaultAccelerator ?? DEFAULT_HOTKEYS.PTT_HOLD;
  let saved = deps.savedAccelerator;
  /** The accelerator currently bound or last attempted. */
  let active = resolve();

  function resolve(): string {
    return deps.envAccelerator ?? saved ?? fallback;
  }

  function sourceOf(): Source {
    if (deps.envAccelerator !== undefined) return 'env';
    return saved !== undefined ? 'saved' : 'default';
  }

  function applyHint(registered: boolean, accelerator: string): void {
    if (deps.onHint === undefined) return;
    if (registered) {
      deps.onHint(`${hintFor(accelerator)} to talk — or click`);
      return;
    }
    if (sourceOf() === 'env') {
      deps.onHint(`Hotkey conflict: ${accelerator} (from FLORINA_PTT_HOTKEY)`);
    } else {
      deps.onHint(`Hotkey conflict: ${accelerator} — rebind in Settings → Desktop & voice`);
    }
  }

  function register(): boolean {
    active = resolve();
    const ok = deps.hotkeys.register(active, deps.onFire);
    applyHint(ok, active);
    return ok;
  }

  function rebind(nextSaved: string | null): PttHotkeyResult {
    const prev = active;
    saved = nextSaved ?? undefined;
    const next = resolve();
    // Already bound under the canonical form (same accelerator, possibly
    // spelled differently) — nothing to do.
    if (deps.hotkeys.isRegistered(next)) {
      active = next;
      applyHint(true, next);
      return { ok: true };
    }
    if (deps.hotkeys.register(next, deps.onFire)) {
      if (prev !== next) deps.hotkeys.unregister(prev);
      active = next;
      applyHint(true, next);
      return { ok: true };
    }
    // New accelerator could not be claimed — keep the working binding and
    // surface the conflict on the attempted name.
    if (deps.hotkeys.isRegistered(prev)) applyHint(true, prev);
    else applyHint(false, next);
    return { ok: false, error: `could not register "${next}" — held by another app or invalid` };
  }

  return { effective: () => active, register, rebind };
}
