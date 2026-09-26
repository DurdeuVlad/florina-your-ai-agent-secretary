/**
 * Electron {@link IpcTransport} — `ipcMain`/`webContents` delivery for the
 * desktop {@link IpcBridge} (DEC-028, issue #24).
 *
 * Main-process side: `sendToRenderer` pushes onto the window's
 * `WebContents`; `onMessage` subscribes to `ipcMain` for renderer→main
 * traffic; `sendToMain` dispatches to locally registered handlers (the main
 * process has no upstream). The renderer side is served by the preload-free
 * page — it talks to the daemon directly over WebSocket, so IPC only
 * carries bridge traffic the {@link DesktopApp} mirrors.
 */
import { createRequire } from 'node:module';

import type { WebContents } from 'electron';

// See window-backend.ts: require('electron') in main resolves to the real
// API, while named ESM imports may hit the npm shim (issue #114).
const require = createRequire(import.meta.url);
const { ipcMain } = require('electron') as typeof import('electron');

import type { IpcChannel, IpcMessageHandler, IpcTransport } from '../ipc-bridge.js';

export class ElectronIpcTransport implements IpcTransport {
  private contents: WebContents | null = null;
  private readonly local = new Map<IpcChannel, Set<IpcMessageHandler>>();

  /**
   * Attach the window's `WebContents` once the window exists. Called by the
   * composition root after `createWindow`; messages sent before attach are
   * dropped (the renderer could not have subscribed yet anyway).
   */
  attachContents(contents: WebContents): void {
    this.contents = contents;
  }

  sendToRenderer(channel: IpcChannel, data: unknown): void {
    if (this.contents !== null && !this.contents.isDestroyed()) {
      this.contents.send(channel, data);
    }
  }

  sendToMain(channel: IpcChannel, data: unknown): void {
    const set = this.local.get(channel);
    if (!set) return;
    for (const handler of set) {
      handler(data);
    }
  }

  onMessage(channel: IpcChannel, handler: IpcMessageHandler): () => void {
    let set = this.local.get(channel);
    if (!set) {
      set = new Set();
      this.local.set(channel, set);
    }
    set.add(handler);
    const listener = (_event: unknown, data: unknown): void => handler(data);
    ipcMain.on(channel, listener);
    return () => {
      const s = this.local.get(channel);
      if (s) s.delete(handler);
      ipcMain.off(channel, listener);
    };
  }
}
