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
import { ElectronKeyboardBackend } from '../adapters/inbound/desktop/electron/keyboard-backend.js';
import { ElectronTrayBackend } from '../adapters/inbound/desktop/electron/tray-backend.js';
import { HotkeyManager, DEFAULT_HOTKEYS } from '../adapters/inbound/desktop/hotkeys.js';
import type { TrayAction } from '../adapters/inbound/desktop/system-tray.js';
import { loadEnvFile } from '../adapters/outbound/credentials/dotenv.js';
import { ensureLocalAuthToken } from '../adapters/outbound/credentials/local-auth-token.js';
import { readDesktopSettings } from '../adapters/outbound/platform/desktop-settings.js';

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

/** Repo root — used to resolve the CLI entry for tray daemon actions. */
const CLI_ENTRY = fileURLToPath(new URL('../cli/index.js', import.meta.url));

function runCli(action: 'start' | 'stop'): void {
  const child = spawn(process.execPath, [CLI_ENTRY, action], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Quit path (issue #132): stop the daemon too when the user's
 * desktop-local setting asks for it (`stopDaemonOnQuit` in
 * ~/.florina/desktop-settings.json). Default is to leave it running —
 * other surfaces (CLI, voice) may still be attached.
 */
async function quitApp(): Promise<void> {
  await desktopAppRef?.stop();
  if (readDesktopSettings().stopDaemonOnQuit) runCli('stop');
  app.quit();
}

/** Set once {@link DesktopApp} is constructed — used by {@link quitApp}. */
let desktopAppRef: DesktopApp | null = null;

async function main(): Promise<void> {
  await app.whenReady();

  const window = new ElectronWindowBackend(PRELOAD);
  const ipc = new ElectronIpcTransport();

  // PTT HUD (issue #123, merged into the main window per user feedback):
  // no separate overlay — hud:state pushes go over the main window's IPC
  // transport and the pill renders in the app header.
  const hud = new HudController({
    ipc,
    hotkeyHint: 'Hold Space to talk',
  });

  const desktopApp = new DesktopApp({
    window,
    ipcTransport: ipc,
    onPttToggle: () => {
      hud.toggleLocalListening();
    },
    windowOptions: {
      width: 1180,
      height: 760,
      title: 'Florina',
      resizable: true,
    },
    trayBackend: new ElectronTrayBackend(),
    closeToTray: true,
    // Daemon lifecycle (#132): no daemon at launch → spawn `florina
    // start` once; the existing reconnect loop picks it up when it
    // listens. Mid-session drops never reach this hook.
    onDaemonMissing: () => runCli('start'),
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
          // Explicit quit: tear down cleanly (stop() bypasses
          // close-to-tray), then honor stopDaemonOnQuit.
          void quitApp();
          break;
      }
    },
  });
  desktopAppRef = desktopApp;

  desktopApp.onStateChange((s) => hud.applyRendererState(s));

  desktopApp.start();
  if (window.contents !== null) {
    ipc.attachContents(window.contents);
    // Re-push once the page finishes loading — the initial hud:state push
    // can race the renderer's listener registration.
    window.contents.once('did-finish-load', () => hud.refresh());
  }
  window.loadFile(RENDERER_HTML);
  hud.start();

  // Global push-to-talk hotkey (issue #124): OS-level via Electron's
  // globalShortcut — works with no window focused and the main window
  // closed. The accelerator is configurable (env until #128 lands the
  // preferences editor); registration failure = conflict, surfaced on the
  // HUD's idle hint.
  const keyboard = new ElectronKeyboardBackend();
  const hotkeys = new HotkeyManager(keyboard);
  keyboard.setFireHandler((accelerator) => hotkeys.dispatch(accelerator));
  const pttAccelerator = process.env['FLORINA_PTT_HOTKEY'] ?? DEFAULT_HOTKEYS.PTT_HOLD;
  const hintAccel = pttAccelerator.replace(
    'CommandOrControl',
    process.platform === 'darwin' ? 'Cmd' : 'Ctrl',
  );
  if (hotkeys.register(pttAccelerator, () => hud.toggleLocalListening())) {
    hud.viewModel.setHotkeyHint(`${hintAccel} to talk — or click`);
  } else {
    hud.viewModel.setHotkeyHint(`Hotkey conflict: ${pttAccelerator} — set FLORINA_PTT_HOTKEY`);
    console.warn(`[desktop] global hotkey "${pttAccelerator}" could not be registered (conflict)`);
  }
  app.on('will-quit', () => hotkeys.unregisterAll());

  // Renderer → daemon commands (approve, preferences, …) route through the
  // main process socket so the sandboxed page never holds a connection.
  ipc.onMessage('command', (msg) => void desktopApp.handleRendererCommand(msg));

  try {
    // ensureLocalAuthToken (not read): on a first launch the file may
    // not exist yet — provisioning it here means the daemon we might
    // spawn (onDaemonMissing → florina start) adopts the same token
    // instead of generating one we never send (#118 + #132).
    await desktopApp.connectToDaemon(DAEMON_URL, ensureLocalAuthToken());
    desktopApp.subscribeToEvents();
    void desktopApp.refreshNow();
  } catch {
    // The renderer surfaces the disconnected state and retries on its own.
  }

  app.on('window-all-closed', () => {
    hud.stop();
    void quitApp();
  });
  app.on('activate', () => {
    // macOS dock click: re-show the existing window.
    if (!window.isClosed()) window.show();
  });
}

void main();
