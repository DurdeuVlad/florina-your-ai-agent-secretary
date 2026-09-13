/**
 * Electron {@link WindowBackend} — the production window runtime for the
 * desktop client (DEC-028, issue #24).
 *
 * Wraps a `BrowserWindow`: the skeleton's `WindowOptions` map onto
 * `BrowserWindowConstructorOptions`, and window lifecycle events forward to
 * registered handlers. The renderer is hardened — no Node integration,
 * context isolation, sandboxed — because it only needs DOM + WebSocket to
 * reach the daemon.
 */
import { createRequire } from 'node:module';

import type { BrowserWindow, WebContents } from 'electron';

// In the Electron main process `require('electron')` resolves to the real
// API object; a named ESM import can resolve to the npm shim (which only
// exports the binary path) depending on loader wiring — see issue #114.
const require = createRequire(import.meta.url);
const { BrowserWindow: BrowserWindowCtor } = require('electron') as typeof import('electron');

import type {
  WindowBackend,
  WindowBounds,
  WindowEvent,
  WindowEventHandler,
  WindowOptions,
} from '../window-backend.js';

/**
 * One Electron `BrowserWindow` behind the {@link WindowBackend} port.
 * Construct before `app.whenReady()` resolves; `createWindow` must only be
 * called afterwards (the {@link ../../bootstrap/desktop.js} entry point
 * enforces this ordering).
 */
export class ElectronWindowBackend implements WindowBackend {
  private win: BrowserWindow | null = null;
  private readonly handlers = new Map<WindowEvent, Set<WindowEventHandler>>();

  /**
   * @param preloadPath - Absolute path to the CJS preload script
   *   (`renderer/preload.cjs`). Required for the sandboxed renderer to
   *   receive RenderTrees and dispatch commands over the IPC bridge.
   */
  constructor(private readonly preloadPath?: string) {}

  createWindow(options: WindowOptions = {}): void {
    if (this.win !== null && !this.win.isDestroyed()) {
      throw new Error('ElectronWindowBackend: window already created');
    }
    this.win = new BrowserWindowCtor({
      width: options.width ?? 800,
      height: options.height ?? 600,
      title: options.title ?? 'Florina',
      resizable: options.resizable ?? true,
      frame: options.frame ?? true,
      transparent: options.transparent ?? false,
      alwaysOnTop: options.alwaysOnTop ?? false,
      skipTaskbar: options.skipTaskbar ?? false,
      show: false,
      backgroundColor: '#0d1117',
      webPreferences: {
        // Renderer gets DOM + the whitelisted contextBridge API only. No
        // Node integration; the CJS preload exposes florina.on/command.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        ...(this.preloadPath !== undefined ? { preload: this.preloadPath } : {}),
      },
    });
    for (const event of this.handlers.keys()) {
      this.attachEvent(event);
    }
  }

  /** The window's WebContents, once created (used by the IPC transport). */
  get contents(): WebContents | null {
    return this.win !== null && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  loadURL(url: string): void {
    void this.assertWindow('loadURL').loadURL(url);
  }

  loadFile(path: string): void {
    void this.assertWindow('loadFile').loadFile(path);
  }

  close(): void {
    this.win?.close();
  }

  on(event: WindowEvent, callback: WindowEventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
      // Window already exists — attach immediately for late subscribers.
      this.attachEvent(event);
    }
    set.add(callback);
    return () => {
      const s = this.handlers.get(event);
      if (s) s.delete(callback);
    };
  }

  show(): void {
    this.win?.show();
  }

  hide(): void {
    this.win?.hide();
  }

  setBounds(bounds: WindowBounds): void {
    this.win?.setBounds(bounds);
  }

  getBounds(): WindowBounds {
    return this.win?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  isVisible(): boolean {
    return this.win?.isVisible() ?? false;
  }

  isClosed(): boolean {
    return this.win === null || this.win.isDestroyed();
  }

  /** Forward a BrowserWindow event to all registered handlers. */
  private attachEvent(event: WindowEvent): void {
    if (this.win === null) return;
    const win = this.win;
    // Guard against double-attach when a handler registers after creation.
    if (win.listenerCount(event) > 0) return;
    // BrowserWindow's typings overload `on` per event literal; our union of
    // port events goes through the underlying EventEmitter signature.
    (win as unknown as { addListener(e: string, cb: (...a: unknown[]) => void): void }).addListener(
      event,
      (...args: unknown[]) => {
        const set = this.handlers.get(event);
        if (!set) return;
        for (const handler of set) {
          handler(...args);
        }
      },
    );
  }

  private assertWindow(action: string): BrowserWindow {
    if (this.win === null || this.win.isDestroyed()) {
      throw new Error(`Cannot ${action} — no live BrowserWindow`);
    }
    return this.win;
  }
}
