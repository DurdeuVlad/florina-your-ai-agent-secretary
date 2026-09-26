/**
 * Electron {@link KeyboardBackend} — OS-level global shortcut registration
 * for the desktop client (DEC-028, issue #124).
 *
 * Wraps Electron's `globalShortcut`. `register` returns the boolean the OS
 * reports, so accelerator conflicts (another app already holds the combo)
 * surface to the caller as `false`.
 *
 * `globalShortcut` needs its fire callback at registration time, while the
 * {@link HotkeyManager} port owns callback dispatch — so this backend
 * forwards every fire through {@link setFireHandler}, which the composition
 * root wires to `HotkeyManager.dispatch`.
 *
 * Note: `globalShortcut` only reports key *down* — there is no release
 * event. True hold-to-talk (press = listen, release = send) needs a native
 * hook and is wired with the voice pipeline in issue #131; the hotkey
 * currently toggles listening on press.
 */
import { createRequire } from 'node:module';

// require('electron') in the main process resolves to the real API object;
// named ESM imports can hit the npm shim (issue #114).
const require = createRequire(import.meta.url);
const { globalShortcut } = require('electron') as typeof import('electron');

import type { KeyboardBackend } from '../hotkeys.js';

/** Production keyboard backend backed by Electron `globalShortcut`. */
export class ElectronKeyboardBackend implements KeyboardBackend {
  private fireHandler: (accelerator: string) => void = () => {};

  /** Set the sink invoked with the accelerator each time a shortcut fires. */
  setFireHandler(handler: (accelerator: string) => void): void {
    this.fireHandler = handler;
  }

  register(accelerator: string): boolean {
    return globalShortcut.register(accelerator, () => this.fireHandler(accelerator));
  }

  unregister(accelerator: string): void {
    globalShortcut.unregister(accelerator);
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll();
  }
}
