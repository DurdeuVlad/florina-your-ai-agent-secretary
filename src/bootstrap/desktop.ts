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
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// require('electron') in the main process resolves to the real API object;
// named ESM imports can hit the npm shim (issue #114).
const require = createRequire(import.meta.url);
const { app, session, Menu } = require('electron') as typeof import('electron');

import { DesktopApp } from '../adapters/inbound/desktop/desktop-app.js';
import { DictationService } from '../core/application/use-cases/voice/dictation-service.js';
import { IpcAudioTransport } from '../adapters/inbound/desktop/ipc-audio-transport.js';
import type { DesktopVoiceSession } from '../adapters/inbound/desktop/desktop-app.js';
import type { VoiceSessionManager } from '../adapters/inbound/voice/voice-session-manager.js';
import type {
  AudioTransport,
  TranscriptionPort,
  VoiceSessionState,
} from '../core/application/ports/outbound/voice.js';
import { HudController } from '../adapters/inbound/desktop/hud-controller.js';
import { VoiceOverlayController } from '../adapters/inbound/desktop/voice-overlay-controller.js';
import { ElectronWindowBackend } from '../adapters/inbound/desktop/electron/window-backend.js';
import { ElectronIpcTransport } from '../adapters/inbound/desktop/electron/ipc-transport.js';
import { ElectronKeyboardBackend } from '../adapters/inbound/desktop/electron/keyboard-backend.js';
import { ElectronTrayBackend } from '../adapters/inbound/desktop/electron/tray-backend.js';
import { ElectronFolderPicker } from '../adapters/inbound/desktop/electron/folder-picker.js';
import { installCopyContextMenu } from '../adapters/inbound/desktop/electron/context-menu.js';
import { HotkeyManager, DEFAULT_HOTKEYS } from '../adapters/inbound/desktop/hotkeys.js';
import { createPttHotkey } from '../adapters/inbound/desktop/ptt-hotkey.js';
import type { PttHotkey } from '../adapters/inbound/desktop/ptt-hotkey.js';
import type { TrayAction } from '../adapters/inbound/desktop/system-tray.js';
import { loadEnvFile } from '../adapters/outbound/credentials/dotenv.js';
import { ensureLocalAuthToken } from '../adapters/outbound/credentials/local-auth-token.js';
import {
  readDesktopSettings,
  writeDesktopSettings,
} from '../adapters/outbound/platform/desktop-settings.js';

// Same `.env` convenience as the CLI (#116) — FLORINA_DAEMON_URL and friends
// resolve from the project file when the caller didn't export them.
loadEnvFile();

const DAEMON_URL = process.env['FLORINA_DAEMON_URL'] ?? 'ws://127.0.0.1:17419';

/**
 * Resolve a renderer asset path for both development and packaged modes
 * (issue #171, DEC-028).
 *
 * Dev: `dist/bootstrap/desktop.js` → source tree is two dirs up.
 * Packaged: electron-builder copies renderer assets to
 * `<resources>/renderer/` via `extraResources` in electron-builder.yml;
 * `process.resourcesPath` is the path to that resources directory.
 */
function resolveRendererAsset(relativePath: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'renderer', relativePath);
  }
  return fileURLToPath(
    new URL(`../../src/adapters/inbound/desktop/renderer/${relativePath}`, import.meta.url),
  );
}

/** Absolute path to the bundled renderer HTML. */
const RENDERER_HTML = resolveRendererAsset('index.html');

/** CJS preload exposing the whitelisted `window.florina` bridge API. */
const PRELOAD = resolveRendererAsset('preload.cjs');

/** Voice-mode full-window overlay (#182). */
const VOICE_OVERLAY_HTML = resolveRendererAsset('voice-overlay.html');

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

  // Mic permission (issue #161): the renderer's getUserMedia asks the
  // default session — grant `media` for our own window, deny the rest.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });

  // Dictation pipeline (issue #161): renderer mic → dictation:audio IPC
  // → Realtime transcription (key stays in this process — the sandboxed
  // page never sees it). Whisper is the offline fallback when a model
  // file is configured (FLORINA_WHISPER_MODEL). No engine → the mic
  // button reports the honest error via dictation:update.
  const dictationTransport = new IpcAudioTransport(ipc);
  const openaiKey = process.env['OPENAI_API_KEY'];
  let dictation: DictationService | undefined;
  let whisper: TranscriptionPort | undefined;
  const whisperModel = process.env['FLORINA_WHISPER_MODEL'];
  const settings = readDesktopSettings();
  if (openaiKey !== undefined || whisperModel !== undefined) {
    const { RealtimeBridge, defaultSocketFactory } =
      await import('../adapters/outbound/voice/realtime-bridge.js');
    const { WhisperAdapter } = await import('../adapters/outbound/voice/whisper-adapter.js');
    const { WhisperCppBackend } = await import('../adapters/outbound/voice/whisper-backend.js');
    if (whisperModel !== undefined) {
      const adapter = new WhisperAdapter(new WhisperCppBackend());
      try {
        await adapter.initialize(
          whisperModel,
          settings.dictationLanguage !== undefined
            ? { language: settings.dictationLanguage }
            : undefined,
        );
        whisper = adapter;
      } catch {
        // Model missing/unreadable — realtime-only dictation.
      }
    }
    dictation = new DictationService({
      transport: dictationTransport,
      ...(openaiKey !== undefined
        ? {
            session: new RealtimeBridge(dictationTransport, defaultSocketFactory),
            apiKey: openaiKey,
          }
        : {}),
      // Dictation language hint (issue #163) — flows into the realtime
      // input-transcription config; whisper got it at initialize above.
      ...(settings.dictationLanguage !== undefined
        ? { sessionOptions: { transcriptionLanguage: settings.dictationLanguage } }
        : {}),
      ...(whisper !== undefined ? { whisper } : {}),
      onUpdate: (u) =>
        ipc.sendToRenderer(
          'dictation:update',
          u.error !== undefined ? { state: u.state, error: u.error } : { state: u.state },
        ),
      onTranscript: (t) =>
        ipc.sendToRenderer(
          'dictation:update',
          t.partial
            ? { state: 'listening', partial: t.text }
            : { state: 'listening', final: t.text },
        ),
    });
  }

  // Voice mode (issue #162): two-way spoken turns through
  // VoiceSessionManager on the SAME IPC transport (dictation and voice
  // mode are mutually exclusive — the DesktopApp verbs enforce it). The
  // manager is built lazily on first `voicemode:start` so the app doesn't
  // pay the connect cost when voice is never used. Spoken finals journal
  // into the canonical chat thread via `chat-append`; state reports flow
  // to the daemon HUD through attachVoiceStateReporting (#131).
  let voiceSession: DesktopVoiceSession | undefined;
  if (openaiKey !== undefined) {
    let manager: VoiceSessionManager | null = null;
    const stateCbs = new Set<(s: VoiceSessionState) => void>();
    const transcriptCbs = new Set<(text: string, partial: boolean) => void>();
    const transport: AudioTransport = dictationTransport;
    voiceSession = {
      async start() {
        if (manager !== null) return;
        const { RealtimeBridge, defaultSocketFactory } =
          await import('../adapters/outbound/voice/realtime-bridge.js');
        const { createStdinVoiceSession } = await import('./voice-session.js');
        const bridge = new RealtimeBridge(transport, defaultSocketFactory);
        // Journal the spoken exchange into the single Secretary thread —
        // user speech (input_audio_transcription.completed) and assistant
        // replies (response output transcripts) land as journaled rows.
        let lastAssistant = '';
        bridge.onTranscript((t) => {
          const text = t.text.trim();
          if (t.partial || text === '') return;
          if (t.source === 'assistant') {
            // text+audio transcript paths can both fire for one reply.
            if (text === lastAssistant) return;
            lastAssistant = text;
          } else {
            lastAssistant = '';
          }
          void desktopApp
            .sendCommand({ kind: 'chat-append', role: t.source ?? 'user', text })
            .catch(() => undefined);
        });
        manager = await createStdinVoiceSession({
          apiKey: openaiKey,
          commandApi: { execute: (cmd) => desktopApp.sendCommand(cmd) },
          audioTransport: transport,
          bridge,
          ...(whisper !== undefined ? { whisperAdapter: whisper } : {}),
        });
        manager.onStateChange((s) => stateCbs.forEach((cb) => cb(s)));
        manager.onTranscript((t, p) => transcriptCbs.forEach((cb) => cb(t, p)));
        // Without this the wrapper only *built* the manager — the realtime
        // socket never opened, `voicemode:start` reported success anyway,
        // and every talk turn threw "not connected". A failed start drops
        // the half-built manager so the next click retries fresh.
        try {
          await manager.start();
        } catch (err) {
          const m = manager;
          manager = null;
          void m.stop().catch(() => undefined);
          throw err;
        }
      },
      async stop() {
        const m = manager;
        manager = null;
        await m?.stop();
      },
      startListening() {
        manager?.startListening();
      },
      stopListening() {
        manager?.stopListening();
      },
      onStateChange(cb) {
        stateCbs.add(cb);
        return () => stateCbs.delete(cb);
      },
      onTranscript(cb) {
        transcriptCbs.add(cb);
        return () => transcriptCbs.delete(cb);
      },
    };
  }

  // PTT HUD (issue #123, merged into the main window per user feedback):
  // no separate overlay — hud:state pushes go over the main window's IPC
  // transport and the pill renders in the app header.
  const hud = new HudController({
    ipc,
    hotkeyHint: 'Ctrl+Space to talk',
  });

  // Voice-mode full-window overlay (#182) — a distinct, larger takeover
  // surface for active two-way turns, unlike the small always-on-top HUD
  // pill above. Its own window + IPC pair, but shares hud.viewModel so
  // both surfaces read one state machine.
  const overlayWindow = new ElectronWindowBackend(PRELOAD);
  const overlayIpc = new ElectronIpcTransport();
  overlayWindow.on('ready-to-show', () => {
    if (overlayWindow.contents !== null) overlayIpc.attachContents(overlayWindow.contents);
  });
  const voiceOverlay = new VoiceOverlayController({
    window: overlayWindow,
    ipc: overlayIpc,
    viewModel: hud.viewModel,
    overlayHtmlPath: VOICE_OVERLAY_HTML,
  });

  // Assigned by the hotkey block below — deskset: patches can only arrive
  // after the window loads, by which point `ptt` is always set.
  let ptt: PttHotkey | undefined;
  const desktopApp = new DesktopApp({
    window,
    ipcTransport: ipc,
    onVoiceModeChange: (active) => {
      if (active) voiceOverlay.show();
      else voiceOverlay.hide();
    },
    // The HUD pill mirrors real capture state — never animates on a
    // dead toggle (no engine → pttToggle pushes an honest error).
    onPttToggle: (listening) => {
      hud.setLocalListening(listening);
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
    ...(dictation !== undefined ? { dictation } : {}),
    ...(voiceSession !== undefined ? { voiceSession } : {}),
    voiceConfig: {
      ...(settings.micDeviceId !== undefined ? { micDeviceId: settings.micDeviceId } : {}),
      voiceModeDefault: settings.voiceModeDefault,
      ...(settings.dictationLanguage !== undefined
        ? { dictationLanguage: settings.dictationLanguage }
        : {}),
    },
    // Desktop settings persistence for the prefs screen's "Desktop &
    // voice" card (issue #163) — the renderer sends `deskset:` patches.
    desktopSettings: {
      read: () => readDesktopSettings(),
      write: (s) => writeDesktopSettings(s),
    },
    // Settings > Repos "+ Add folder"/"Use default folder" (issue #253).
    folderPicker: new ElectronFolderPicker(),
    // PTT rebind (issue #332): a deskset `pttHotkey` patch lands here —
    // the controller is wired below; until then fail honestly rather
    // than pretending a renderer-driven rebind can run before the hotkey
    // system exists.
    pttHotkeyRebind: (saved) =>
      ptt === undefined
        ? { ok: false, error: 'hotkey system is not ready yet — try again' }
        : ptt.rebind(saved),
    // Surface the env override in the Settings field hint (issue #332).
    ...(process.env['FLORINA_PTT_HOTKEY'] !== undefined
      ? { pttHotkeyEnv: process.env['FLORINA_PTT_HOTKEY'] }
      : {}),
    // First-run setup chooser (issue #277): the packaged/source default
    // comes from the real runtime — the user can still flip it in the
    // welcome step.
    packaged: app.isPackaged,
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
    // Right-click Copy for selectable content (issue #331, DG-01): the
    // menu offers editing roles only — never Inspect/Reload — so it
    // cannot widen the sandboxed renderer.
    installCopyContextMenu(window.contents, (items) => Menu.buildFromTemplate(items));
    // Packaged macOS apps have no default Edit menu, and without one
    // Cmd+C never reaches the renderer's selection — install the role
    // menu there only (Windows/Linux copy via the context menu above and
    // Chromium's built-in Ctrl+C path).
    if (process.platform === 'darwin' && Menu.getApplicationMenu() === null) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));
    }
    // Re-push once the page finishes loading — the initial hud:state,
    // daemon:status, and view-tree pushes can all land before the
    // renderer's listeners attach (#133 screenshots caught the sidebar
    // stuck on "connecting…" and the inbox never mounting).
    window.contents.once('did-finish-load', () => {
      hud.refresh();
      desktopApp.replayDaemonStatus();
      desktopApp.replayVoiceConfig();
      desktopApp.replaySetup();
      void desktopApp.refreshNow();
    });
  }
  window.loadFile(RENDERER_HTML);
  hud.start();

  // Global push-to-talk hotkey (issue #124): OS-level via Electron's
  // globalShortcut — works with no window focused and the main window
  // closed. Accelerator precedence (#332): FLORINA_PTT_HOTKEY env >
  // saved desktop setting > built-in default. Registration failure =
  // conflict, surfaced on the HUD's idle hint with a pointer at
  // Settings → Desktop & voice.
  const keyboard = new ElectronKeyboardBackend();
  const hotkeys = new HotkeyManager(keyboard);
  keyboard.setFireHandler((accelerator) => hotkeys.dispatch(accelerator));
  ptt = createPttHotkey({
    hotkeys,
    ...(process.env['FLORINA_PTT_HOTKEY'] !== undefined
      ? { envAccelerator: process.env['FLORINA_PTT_HOTKEY'] }
      : {}),
    ...(settings.pttHotkey !== undefined ? { savedAccelerator: settings.pttHotkey } : {}),
    defaultAccelerator: DEFAULT_HOTKEYS.PTT_HOLD,
    onFire: () => void desktopApp.pttToggle(),
    onHint: (hint) => hud.viewModel.setHotkeyHint(hint),
    hintFor: (a) => a.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
  });
  if (!ptt.register()) {
    console.warn(`[desktop] global hotkey "${ptt.effective()}" could not be registered (conflict)`);
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
    voiceOverlay.stop();
    void quitApp();
  });
  app.on('activate', () => {
    // macOS dock click: re-show the existing window.
    if (!window.isClosed()) window.show();
  });
}

void main();
