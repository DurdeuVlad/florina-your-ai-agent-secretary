/**
 * Desktop composition root (DEC-028, DEC-037, issue #24).
 *
 * Electron main-process entry: composes the {@link DesktopApp} orchestrator
 * with the real Electron backends ({@link ElectronWindowBackend},
 * {@link ElectronIpcTransport}, {@link ElectronTrayBackend}) and loads the
 * bundled renderer. The app is a strict client of the daemon — the window
 * renders state the daemon pushes; no business logic lives here.
 *
 * Run with `npm run build && npm run desktop` (the script points Electron at
 * the compiled `dist/bootstrap/desktop.js`).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// require('electron') in the main process resolves to the real API object;
// named ESM imports can hit the npm shim (issue #114).
const require = createRequire(import.meta.url);
const { app } = require('electron') as typeof import('electron');

import { DesktopApp } from '../adapters/inbound/desktop/desktop-app.js';
import { HudController } from '../adapters/inbound/desktop/hud-controller.js';
import { ElectronWindowBackend } from '../adapters/inbound/desktop/electron/window-backend.js';
import { ElectronIpcTransport } from '../adapters/inbound/desktop/electron/ipc-transport.js';
import { ElectronTrayBackend } from '../adapters/inbound/desktop/electron/tray-backend.js';
import type { TrayAction } from '../adapters/inbound/desktop/system-tray.js';
import { loadEnvFile } from '../adapters/outbound/credentials/dotenv.js';
import { readLocalAuthToken } from '../adapters/outbound/credentials/local-auth-token.js';

// Same `.env` convenience as the CLI (#116) — FLORINA_DAEMON_URL and friends
// resolve from the project file when the caller didn't export them.
loadEnvFile();

const DAEMON_URL = process.env['FLORINA_DAEMON_URL'] ?? 'ws://127.0.0.1:17419';

/** Absolute path to the bundled renderer (served from the source tree). */
const RENDERER_HTML = fileURLToPath(
  new URL('../../src/adapters/inbound/desktop/renderer/index.html', import.meta.url),
);

/** CJS preload exposing the whitelisted `window.florina` bridge API. */
const PRELOAD = fileURLToPath(
  new URL('../../src/adapters/inbound/desktop/renderer/preload.cjs', import.meta.url),
);

/** Absolute path to the PTT HUD overlay page (issue #123). */
const HUD_HTML = fileURLToPath(
  new URL('../../src/adapters/inbound/desktop/renderer/hud.html', import.meta.url),
);

/** Repo root — used to resolve the CLI entry for tray daemon actions. */
const CLI_ENTRY = fileURLToPath(new URL('../cli/index.js', import.meta.url));

function runCli(action: 'start' | 'stop'): void {
  const child = spawn(process.execPath, [CLI_ENTRY, action], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function main(): Promise<void> {
  await app.whenReady();

  const window = new ElectronWindowBackend(PRELOAD);
  const ipc = new ElectronIpcTransport();
  const desktopApp = new DesktopApp({
    window,
    ipcTransport: ipc,
    windowOptions: {
      width: 1180,
      height: 760,
      title: 'Florina',
      resizable: true,
    },
    trayBackend: new ElectronTrayBackend(),
    onTrayAction: (action: TrayAction) => {
      switch (action) {
        case 'show-window':
        case 'open-inbox':
          window.show();
          break;
        case 'start-daemon':
          runCli('start');
          break;
        case 'stop-daemon':
          runCli('stop');
          break;
        case 'quit':
          app.quit();
          break;
      }
    },
  });

  // PTT HUD overlay (issue #123): a second, frameless always-on-top window
  // driven by app state changes — daemon status maps to the offline state,
  // the mirrored voice session to listening/processing/responding.
  const hudWindow = new ElectronWindowBackend(PRELOAD);
  const hudIpc = new ElectronIpcTransport();
  const hud = new HudController({
    window: hudWindow,
    ipc: hudIpc,
    hudHtmlPath: HUD_HTML,
    hotkeyHint: 'Hold Space to talk',
  });
  desktopApp.onStateChange((s) => hud.applyRendererState(s));

  desktopApp.start();
  if (window.contents !== null) {
    ipc.attachContents(window.contents);
  }
  window.loadFile(RENDERER_HTML);

  hud.start();
  if (hudWindow.contents !== null) {
    hudIpc.attachContents(hudWindow.contents);
  }

  // Renderer → daemon commands (approve, preferences, …) route through the
  // main process socket so the sandboxed page never holds a connection.
  ipc.onMessage('command', (msg) => void desktopApp.handleRendererCommand(msg));

  try {
    await desktopApp.connectToDaemon(DAEMON_URL, readLocalAuthToken());
    desktopApp.subscribeToEvents();
    void desktopApp.refreshNow();
  } catch {
    // The renderer surfaces the disconnected state and retries on its own.
  }

  app.on('window-all-closed', () => {
    hud.stop();
    void desktopApp.stop().finally(() => app.quit());
  });
  app.on('activate', () => {
    // macOS dock click: re-show the existing window.
    if (!window.isClosed()) window.show();
  });
}

void main();
