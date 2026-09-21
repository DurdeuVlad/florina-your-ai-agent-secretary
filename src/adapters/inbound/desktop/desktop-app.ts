/**
 * Desktop application orchestrator (DEC-028, issue #24).
 *
 * {@link DesktopApp} wires together the three desktop-skeleton primitives:
 * a {@link WindowBackend} (the OS window), an {@link IpcBridge} (main ↔
 * renderer messaging), and a {@link RendererState} (the view-state mirror).
 * It owns the lifecycle: create the window, connect to the Florina daemon
 * over WebSocket, sync daemon state into the renderer state, and tear it all
 * down on disconnect.
 *
 * The app is a strict client of the daemon (DEC-028): no business logic
 * lives here. All state originates from the daemon and is mirrored into the
 * renderer via IPC. The class is runtime-agnostic — it depends on the
 * pluggable {@link WindowBackend} and {@link IpcTransport} interfaces, so it
 * can be tested headlessly with the in-memory mocks.
 */
import { WebSocket } from 'ws';

import type { Command, Response } from '../../../core/application/use-cases/tasks/command-api.js';
import type {
  AttentionItemSnapshot,
  TaskSnapshot,
} from '../../../core/application/use-cases/tasks/command-api.js';
import type { ConversationMessage, Event } from '../../../core/domain/types.js';
import type { MetricsSnapshot } from '../../../core/application/use-cases/metrics.js';
import type { AttentionItem } from '../../../core/application/use-cases/attention/attention-item.js';
import { renderHomeView } from './views/home-view.js';
import { renderHistoryView } from './views/history-view.js';
import { renderInspectorView } from './views/inspector-view.js';
import { renderFleetScreen } from './views/fleet-screen.js';
import { renderPrefsScreen } from './views/prefs-screen.js';
import type { PreferenceProfile } from '../../../core/application/ports/outbound/preference-profile.js';
import { IDEACMD_KINDS, renderIdeasScreen } from './views/ideas-screen.js';
import { renderChatScreen } from './views/chat-screen.js';
import { renderChatActivityDrawer } from './views/chat-activity-drawer.js';
import { renderSecretaryScreen } from './views/secretary-screen.js';
import type { DictationService } from '../../../core/application/use-cases/voice/dictation-service.js';
import type { VoiceSessionState } from '../../../core/application/ports/outbound/voice.js';

/**
 * The voice-mode surface the desktop needs (issue #162) — satisfied by
 * `VoiceSessionManager`. Two-way turns: mic audio in, tools executed
 * against the daemon, AI audio back out through the same transport.
 */
export interface DesktopVoiceSession {
  /** Connect the realtime session (tools + instructions wired). */
  start(): Promise<void>;
  /** Disconnect and release the session. */
  stop(): Promise<void>;
  /** Begin a talk turn (push-to-talk within voice mode). */
  startListening(): void;
  /** End the turn — commits audio, the model responds. */
  stopListening(): void;
  /** Engine state stream (idle/listening/processing/responding/error). */
  onStateChange(cb: (state: VoiceSessionState) => void): () => void;
  /** Transcript stream — user and assistant speech, partials + finals. */
  onTranscript(cb: (text: string, partial: boolean) => void): () => void;
}
import type { SecretaryResponse } from '../../../core/application/use-cases/tasks/command-api.js';
import type {
  BriefListResponse,
  IdeaListResponse,
} from '../../../core/application/use-cases/tasks/command-api.js';
import { IpcBridge } from './ipc-bridge.js';
import type { IpcTransport } from './ipc-bridge.js';
import { RendererState } from './renderer-state.js';
import type {
  RendererStateData,
  StateChangeCallback,
  VoiceState,
  DaemonStatus,
} from './renderer-state.js';
import type { WindowBackend, WindowOptions } from './window-backend.js';
import { SystemTrayManager } from './system-tray.js';
import type { TrayActionCallback, TrayBackend } from './system-tray.js';

/** Options for constructing a {@link DesktopApp}. */
export interface DesktopAppOptions {
  /** Window backend (default: caller must supply; tests inject a mock). */
  readonly window: WindowBackend;
  /** IPC transport (default: caller must supply; tests inject a mock). */
  readonly ipcTransport: IpcTransport;
  /** Initial window options. */
  readonly windowOptions?: WindowOptions;
  /** Connection timeout in milliseconds (default 10s). */
  readonly connectTimeoutMs?: number;
  /**
   * Base delay for the first reconnect attempt after a drop (default 1s).
   * Doubles each attempt up to {@link DesktopAppOptions.reconnectMaxDelayMs}.
   */
  readonly reconnectBaseDelayMs?: number;
  /** Upper bound on the reconnect backoff (default 30s). */
  readonly reconnectMaxDelayMs?: number;
  /**
   * Optional system tray backend. When supplied, the app creates a
   * {@link SystemTrayManager} on {@link DesktopApp.start} and tears it down
   * on {@link DesktopApp.stop}. When omitted, no tray is created (useful for
   * headless tests that only exercise the window/IPC path).
   */
  readonly trayBackend?: TrayBackend;
  /**
   * Optional callback invoked when the user selects a quick action from the
   * system tray. The host wires these to daemon commands / window actions.
   */
  readonly onTrayAction?: TrayActionCallback;
  /**
   * Close-to-tray (DG-01 §3.8, issue #125): when true, closing the main
   * window hides it instead of quitting — the app keeps running headless
   * (HUD + tray stay live) until an explicit {@link stop} or tray Quit.
   */
  readonly closeToTray?: boolean;
  /**
   * Push-to-talk state hook: {@link pttToggle} calls this with the
   * resulting listening state after routing to the real audio pipeline
   * (dictation round or voice talk-turn). The composition root wires it
   * to `HudController.setLocalListening` so the HUD pill mirrors actual
   * capture — it never animates without a live engine behind it.
   */
  readonly onPttToggle?: (listening: boolean) => void;
  /**
   * Voice-mode engaged/disengaged hook (issue #182): called with `true`
   * right after `voicemode:start` succeeds and `false` right after
   * `voicemode:stop` completes. The composition root wires this to
   * `VoiceOverlayController.show`/`hide` — the full-window immersive
   * overlay is a render target for voice-mode state, not new state.
   */
  readonly onVoiceModeChange?: (active: boolean) => void;
  /**
   * Daemon lifecycle (issue #132): invoked once per {@link connectToDaemon}
   * intent when the FIRST connection attempt fails — i.e. the daemon is
   * absent at launch, not a mid-session drop (a crash shouldn't silently
   * respawn the daemon; the reconnect loop plus the tray's "Start daemon"
   * cover that). The composition root wires this to spawning
   * `florina start`; the existing retry loop then picks the daemon up.
   */
  readonly onDaemonMissing?: () => void;
  /**
   * Dictation pipeline (issue #161): the mic button's `dictation:start` /
   * `dictation:stop` verbs drive this service; it owns the renderer-mic
   * ↔ realtime/whisper path and reports state + transcripts through its
   * own callbacks (the composition root forwards them on
   * `dictation:update`). Absent → the verbs fail honestly.
   */
  readonly dictation?: DictationService;
  /**
   * Voice-mode session (issue #162): `voicemode:start/stop` drive the
   * session lifecycle and `voice:talk` toggles a push-to-talk turn.
   * Mutually exclusive with dictation — starting one ends the other.
   * Absent → the verbs fail honestly.
   */
  readonly voiceSession?: DesktopVoiceSession;
  /**
   * Voice-mode preference/config pushed to the renderer on load
   * (issue #162): `micDeviceId` constrains getUserMedia;
   * `voiceModeDefault: true` auto-engages voice mode.
   */
  readonly voiceConfig?: {
    readonly micDeviceId?: string;
    readonly voiceModeDefault?: boolean;
    readonly dictationLanguage?: string;
  };
  /**
   * Desktop-local settings persistence (issue #163): the prefs screen's
   * "Desktop & voice" card writes through this port (`deskset:` verb);
   * {@link replayVoiceConfig} re-reads so a saved change is what the
   * renderer sees. Absent → deskset fails honestly.
   */
  readonly desktopSettings?: DesktopSettingsStore;
}

/**
 * The shape {@link DesktopApp} persists through the injected settings
 * store (issue #163) — mirrors `DesktopSettings` in the platform adapter
 * without importing it (hexagonal direction: inbound never imports
 * outbound).
 */
export interface DesktopSettingsShape {
  readonly stopDaemonOnQuit: boolean;
  readonly micDeviceId?: string;
  readonly voiceModeDefault: boolean;
  readonly dictationLanguage?: string;
}

/** Read/write port for `~/.florina/desktop-settings.json` (issue #163). */
export interface DesktopSettingsStore {
  read(): DesktopSettingsShape;
  write(settings: DesktopSettingsShape): void;
}

/**
 * Error thrown when the desktop app cannot connect to the daemon.
 */
export class DesktopConnectionError extends Error {
  constructor(
    message: string,
    readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DesktopConnectionError';
  }
}

/**
 * Orchestrates the desktop application lifecycle.
 *
 * Typical usage:
 * ```ts
 * const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: new MockIpcTransport() });
 * await app.start();
 * await app.connectToDaemon('ws://127.0.0.1:17419');
 * app.onStateChange(state => render(state));
 * // ... later
 * await app.disconnect();
 * await app.stop();
 * ```
 */
export class DesktopApp {
  private readonly window: WindowBackend;
  private readonly bridge: IpcBridge;
  private readonly state: RendererState;
  private readonly connectTimeoutMs: number;
  private readonly windowOptions: WindowOptions;
  private readonly tray: SystemTrayManager | null;
  private socket: WebSocket | null = null;
  /** Serializes sendCommand — the daemon protocol has no request ids. */
  private commandChain: Promise<unknown> = Promise.resolve();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private wantsConnection = false;
  private socketUrl: string | null = null;
  private authToken: string | undefined;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly closeToTray: boolean;
  private readonly onPttToggle?: (listening: boolean) => void;
  private readonly onVoiceModeChange?: (active: boolean) => void;
  private readonly onDaemonMissing?: () => void;
  private readonly dictation: DictationService | undefined;
  private readonly voiceSession: DesktopVoiceSession | undefined;
  private readonly voiceConfig: DesktopAppOptions['voiceConfig'];
  private readonly desktopSettings: DesktopSettingsStore | undefined;
  /** Voice-mode on/off + whether a talk turn is capturing (issue #162). */
  private voiceActive = false;
  private voiceListening = false;
  /** A `voicemode:start` connect is in flight — guards double-clicks. */
  private voiceConnecting = false;
  /** True once the current connect intent has linked at least once (#132). */
  private everConnected = false;
  private started = false;
  private stopping = false;
  /** Latest task list from the daemon (inspector column 1, #126). */
  private tasks: TaskSnapshot[] = [];
  /** Session inspector selection state (#126). */
  private inspectorTaskId: string | null = null;
  private inspectorEventIndex: number | null = null;
  private inspectorEvents: readonly Event[] = [];
  /** Open ledger reader on the ideas screen (#129), if any. */
  private ideaReader: { ideaId: string; title: string; body: string } | null = null;
  /** Single Secretary conversation mirror (issue #160). */
  private chatMessages: ConversationMessage[] = [];
  private chatClearedAt: string | undefined;
  private chatWorking = false;
  private chatTool: string | undefined;

  constructor(options: DesktopAppOptions) {
    this.window = options.window;
    this.bridge = new IpcBridge(options.ipcTransport);
    this.state = new RendererState();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.closeToTray = options.closeToTray ?? false;
    this.onPttToggle = options.onPttToggle;
    this.onVoiceModeChange = options.onVoiceModeChange;
    this.onDaemonMissing = options.onDaemonMissing;
    this.dictation = options.dictation;
    this.voiceSession = options.voiceSession;
    this.voiceConfig = options.voiceConfig;
    this.desktopSettings = options.desktopSettings;
    // Voice-mode state + live transcript captions reach the renderer on
    // voice:update (issue #162). Finals ALSO journal into the chat thread
    // via chat-append (wired in the composition root) — the preview is
    // ephemeral, the bubble is journaled (DEC-012).
    this.voiceSession?.onStateChange((state) => {
      this.bridge.sendToRenderer('voice:update', { state });
      if (state !== 'listening') {
        this.voiceListening = false;
      }
    });
    this.voiceSession?.onTranscript((text, partial) => {
      this.bridge.sendToRenderer('voice:update', partial ? { partial: text } : { final: text });
    });
    this.windowOptions = options.windowOptions ?? {};
    if (options.trayBackend !== undefined) {
      this.tray = new SystemTrayManager(options.trayBackend);
      if (options.onTrayAction !== undefined) {
        this.tray.onAction(options.onTrayAction);
      }
    } else {
      this.tray = null;
    }
  }

  /** The IPC bridge (exposed for wiring renderer-side handlers in tests). */
  get ipc(): IpcBridge {
    return this.bridge;
  }

  /** Whether the app window has been started and not yet stopped. */
  get isStarted(): boolean {
    return this.started;
  }

  /** Whether the app is currently connected to the daemon. */
  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * The system tray manager, or `null` when no tray backend was supplied.
   * Exposed so the host can register additional action callbacks or inspect
   * tray state.
   */
  get trayManager(): SystemTrayManager | null {
    return this.tray;
  }

  /**
   * Start the app: create and show the window, and start the system tray
   * (if configured). Does not connect to the daemon — call
   * {@link connectToDaemon} afterwards.
   */
  start(): void {
    if (this.started) return;
    this.window.createWindow(this.windowOptions);
    this.window.show();
    if (this.tray !== null) {
      this.tray.start();
      // Mirror the initial daemon status into the tray.
      this.tray.setStatus(this.state.snapshot().daemonStatus);
    }
    this.started = true;
    if (this.closeToTray) {
      // Close-to-tray: a close request hides the window unless we're
      // actually tearing down. The HUD + tray keep the process alive.
      this.window.setCloseInterceptor(() => {
        if (this.stopping) return true;
        this.window.hide();
        return false;
      });
    }
  }

  /**
   * Connect to the Florina daemon at the given WebSocket URL and stay
   * connected: if the socket drops (or this first attempt fails), the app
   * retries with exponential backoff and reports `reconnecting` until the
   * link is re-established or {@link disconnect} is called (#122).
   * The returned promise reflects only the first attempt.
   */
  connectToDaemon(socketUrl: string, authToken?: string): Promise<void> {
    // Record the intent — the app keeps retrying (with backoff) until it
    // either connects or the user explicitly disconnects (#122).
    this.socketUrl = socketUrl;
    this.authToken = authToken;
    this.wantsConnection = true;
    this.reconnectAttempt = 0;
    this.everConnected = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    return this.openSocket().catch((err: unknown) => {
      // First attempt failed and we've never linked on this intent —
      // the daemon simply isn't running (issue #132). The host can
      // spawn it; the retry loop below picks it up once it listens.
      if (!this.everConnected) this.onDaemonMissing?.();
      this.scheduleReconnect();
      throw err;
    });
  }

  /**
   * Single connection attempt. On success, updates renderer state to
   * `connected` and wires incoming daemon messages to renderer-state
   * updates. Rejects with {@link DesktopConnectionError} on failure.
   */
  private openSocket(): Promise<void> {
    const socketUrl = this.socketUrl;
    const authToken = this.authToken;
    if (socketUrl === null) {
      return Promise.reject(new DesktopConnectionError('No daemon URL configured'));
    }
    const reconnecting = this.reconnectAttempt > 0 || this.socket !== null;
    this.updateDaemonStatus(reconnecting ? 'reconnecting' : 'connecting', {
      connected: false,
      error: undefined,
    });
    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(socketUrl);
      } catch (err) {
        const e = new DesktopConnectionError(
          `Invalid daemon URL: ${socketUrl}`,
          err instanceof Error ? err : undefined,
        );
        this.updateDaemonStatus('error', { connected: false, error: e.message });
        reject(e);
        return;
      }

      const timer = setTimeout(() => {
        socket.terminate();
        const e = new DesktopConnectionError(`Timed out connecting to daemon at ${socketUrl}`);
        this.updateDaemonStatus('error', { connected: false, error: e.message });
        reject(e);
      }, this.connectTimeoutMs);

      let authenticated = authToken === undefined;

      socket.once('open', () => {
        // Local control-plane auth (#118): when the daemon requires a token,
        // authenticate before anything else — including the event stream.
        if (authToken !== undefined) {
          socket.send(JSON.stringify({ type: 'auth', token: authToken }));
        } else {
          clearTimeout(timer);
          this.adoptSocket(socket, resolve, reject);
        }
      });

      socket.on('message', (data: unknown) => {
        if (authenticated) return; // wireDaemonSocket handles post-auth traffic
        const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
        let ack: unknown;
        try {
          ack = JSON.parse(text);
        } catch {
          return;
        }
        const ok =
          ack !== null &&
          typeof ack === 'object' &&
          (ack as { type?: unknown }).type === 'auth' &&
          (ack as { ok?: unknown }).ok === true;
        if (!ok) {
          clearTimeout(timer);
          const e = new DesktopConnectionError(
            'Daemon rejected authentication — token mismatch (~/.florina/auth-token)',
          );
          this.updateDaemonStatus('error', { connected: false, error: e.message });
          socket.close();
          reject(e);
          return;
        }
        authenticated = true;
        clearTimeout(timer);
        this.adoptSocket(socket, resolve, reject);
      });

      socket.once('error', (err: Error) => {
        clearTimeout(timer);
        const e = new DesktopConnectionError(
          `Failed to connect to daemon at ${socketUrl}: ${err.message}`,
          err,
        );
        this.updateDaemonStatus('error', { connected: false, error: e.message });
        reject(e);
      });
    });
  }

  /**
   * Take ownership of a freshly-opened (and authenticated) socket. If the
   * connection was cancelled while the attempt was in flight — e.g.
   * {@link disconnect} ran during the handshake — the socket is discarded
   * instead of being adopted (#122 race).
   */
  private adoptSocket(socket: WebSocket, resolve: () => void, reject: (err: Error) => void): void {
    if (!this.wantsConnection) {
      socket.close();
      reject(new DesktopConnectionError('Connection cancelled by disconnect'));
      return;
    }
    this.socket = socket;
    this.everConnected = true;
    this.updateDaemonStatus('connected', { connected: true, error: undefined });
    this.wireDaemonSocket(socket);
    resolve();
  }

  /**
   * Send a typed {@link Command} to the daemon over the live WebSocket and
   * resolve with the typed {@link Response}. Rejects if not connected or the
   * response times out / is malformed.
   *
   * The daemon protocol has no request correlation — responses arrive in
   * the order commands were received. Commands are therefore serialized
   * through {@link commandChain} so a pending command's listener only ever
   * sees its own response (found while adding query-fleet to the refresh
   * fan-out: concurrent listeners each resolved with the first response).
   */
  sendCommand(command: Command, timeoutMs = 10_000): Promise<Response> {
    const run = this.commandChain.then(() => this.sendCommandNow(command, timeoutMs));
    this.commandChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Single in-flight command — see {@link sendCommand} for serialization. */
  private sendCommandNow(command: Command, timeoutMs: number): Promise<Response> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new DesktopConnectionError('Not connected to daemon'));
    }
    const socket = this.socket;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DesktopConnectionError(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMessage = (data: unknown): void => {
        const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          reject(
            new DesktopConnectionError(
              'Malformed response from daemon',
              err instanceof Error ? err : undefined,
            ),
          );
          return;
        }
        // Daemon pushes (subscribe stream) carry `type`; command responses
        // don't. A push arriving mid-request is not our response — keep
        // waiting for the real one.
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof (parsed as { type?: unknown }).type === 'string'
        ) {
          return;
        }
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed as Response);
      };

      socket.on('message', onMessage);
      socket.send(JSON.stringify(command));
    });
  }

  /** Returns a deep-copy snapshot of the current renderer state. */
  getState(): RendererStateData {
    return this.state.snapshot();
  }

  /** Subscribe to renderer state changes. Returns an unsubscribe function. */
  onStateChange(callback: StateChangeCallback): () => void {
    return this.state.subscribe(callback);
  }

  /**
   * Deliberate disconnect: cancels the reconnect loop, closes the socket,
   * and resets connection-related renderer state.
   */
  disconnect(): Promise<void> {
    this.wantsConnection = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    return new Promise<void>((resolve) => {
      const socket = this.socket;
      this.socket = null;
      if (socket) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.once('close', () => resolve());
          socket.close();
        } else {
          resolve();
        }
      } else {
        resolve();
      }
      this.updateDaemonStatus('disconnected', {
        connected: false,
        inboxItems: [],
        activeTask: null,
        metrics: null,
        error: undefined,
      });
    });
  }

  /** Stop the app: disconnect, dispose the IPC bridge, close the window, and destroy the tray. */
  stop(): Promise<void> {
    this.stopping = true;
    return this.disconnect().then(() => {
      this.bridge.dispose();
      this.window.close();
      if (this.tray !== null) {
        this.tray.stop();
      }
      this.started = false;
    });
  }

  /**
   * Update the daemon status in the renderer state and mirror it into the
   * system tray (when configured). Centralizes the status-sync so every
   * connection transition (connecting / connected / disconnected / error)
   * keeps both surfaces consistent.
   */
  private updateDaemonStatus(status: DaemonStatus, extra?: Partial<RendererStateData>): void {
    this.state.update({ daemonStatus: status, ...extra });
    this.bridge.sendToRenderer('daemon:status', { status, error: extra?.error });
    if (this.tray !== null) {
      this.tray.setStatus(status);
    }
  }

  /**
   * Re-push the current daemon status — status changes fire only on
   * transition, so a connect that lands before the renderer finishes
   * loading leaves the sidebar stuck on its initial "connecting…"
   * (#133 found this via screenshots). Call on `did-finish-load`.
   */
  replayDaemonStatus(): void {
    const snap = this.state.snapshot();
    this.bridge.sendToRenderer('daemon:status', {
      status: snap.daemonStatus,
      error: snap.error,
    });
  }

  /**
   * Wire incoming daemon WebSocket messages to renderer-state updates.
   * The daemon pushes typed state updates (inbox, task, metrics, etc.) which
   * the app mirrors into the renderer state and forwards to the renderer over
   * the IPC bridge.
   */
  private wireDaemonSocket(socket: WebSocket): void {
    socket.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // ignore malformed push messages
      }
      this.applyDaemonMessage(parsed);
    });

    socket.once('close', () => {
      if (this.socket === socket) this.socket = null;
      this.handleSocketDrop();
    });

    socket.once('error', () => {
      // 'close' follows 'error' on a live socket — force it so the drop
      // handler runs even when ws doesn't close on its own.
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
    });
  }

  /**
   * A live socket went away. While the app still wants the connection,
   * report `reconnecting` (amber — last known state stays readable, DG-01
   * §4) and schedule the next attempt with exponential backoff.
   */
  private handleSocketDrop(): void {
    // Daemon loss suspends an in-flight voice turn (issue #162): tools and
    // chat journaling route through the daemon — committing more audio
    // would produce an unanswerable turn.
    if (this.voiceListening && this.voiceSession !== undefined) {
      this.voiceListening = false;
      this.voiceSession.stopListening();
      this.bridge.sendToRenderer('voice:update', { listening: false, suspended: true });
    }
    if (this.wantsConnection) {
      this.scheduleReconnect();
    } else {
      this.updateDaemonStatus('disconnected', { connected: false, error: undefined });
    }
  }

  /** Schedule the next reconnect attempt; no-op unless a connect was requested. */
  private scheduleReconnect(): void {
    if (!this.wantsConnection || this.reconnectTimer !== null) return;
    // Keep the last error in state — DG-01 wants the raw daemon error
    // readable/copyable while the amber dot says "reconnecting".
    this.updateDaemonStatus('reconnecting', { connected: false });
    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempt,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket()
        .then(() => {
          // Re-subscribe and re-pull so the renderer resyncs after a gap.
          this.reconnectAttempt = 0;
          this.subscribeToEvents();
          void this.refreshNow();
        })
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  /**
   * Apply a daemon push message to the renderer state and forward it to the
   * renderer over the appropriate IPC channel. Unknown message types are
   * ignored (forward compatibility).
   */
  private applyDaemonMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const record = msg as Record<string, unknown>;
    const type = record['type'];
    switch (type) {
      case 'inbox:update': {
        const items = (record['items'] as AttentionItemSnapshot[]) ?? [];
        this.state.update({ inboxItems: items });
        this.bridge.sendToRenderer('inbox:update', items);
        break;
      }
      case 'task:update': {
        const task = (record['task'] as TaskSnapshot) ?? null;
        this.state.update({ activeTask: task });
        this.bridge.sendToRenderer('task:update', task);
        break;
      }
      case 'metrics:update': {
        const metrics = (record['snapshot'] as MetricsSnapshot) ?? null;
        this.state.update({ metrics });
        this.bridge.sendToRenderer('metrics:update', metrics);
        break;
      }
      case 'approval:request': {
        this.bridge.sendToRenderer('approval:request', record);
        break;
      }
      case 'digest:update': {
        this.bridge.sendToRenderer('digest:update', record);
        break;
      }
      case 'voice:state': {
        // The daemon's report carries `state` ('listening' | 'processing'
        // | 'responding' | 'idle'); legacy pushes carry bare flags —
        // accept both (#131).
        const reported = typeof record['state'] === 'string' ? record['state'] : undefined;
        const voiceState: VoiceState = {
          listening: reported === 'listening' || Boolean(record['listening']),
          speaking: reported === 'responding' || Boolean(record['speaking']),
          processing: reported === 'processing' || Boolean(record['processing']),
          muted: Boolean(record['muted']),
          mode: typeof record['mode'] === 'string' ? record['mode'] : undefined,
          transcript: typeof record['transcript'] === 'string' ? record['transcript'] : undefined,
          responsePreview:
            typeof record['responsePreview'] === 'string' ? record['responsePreview'] : undefined,
        };
        this.state.update({ voiceState });
        this.bridge.sendToRenderer('voice:state', record);
        break;
      }
      case 'chat:message': {
        // Journaled conversation append (issue #160). The sender's own
        // message arrives here AND in the chat-send response — dedupe by
        // id so the bubble renders once regardless of ordering.
        const message = record['message'] as ConversationMessage | undefined;
        if (message !== undefined && !this.chatMessages.some((m) => m.id === message.id)) {
          this.chatMessages.push(message);
        }
        // An assistant row only journals when a turn ends (or fails) —
        // the loop emits no 'completed' event on the failure path.
        if (message?.role === 'assistant') {
          this.chatWorking = false;
          this.chatTool = undefined;
        }
        this.pushChat();
        break;
      }
      case 'chat:event': {
        // Ephemeral loop progress (issue #158 → #160): drives only the
        // working row — never the message list (journaled rows do that).
        const event = record['event'] as { kind?: string; name?: string } | undefined;
        switch (event?.kind) {
          case 'iteration':
            this.chatWorking = true;
            break;
          case 'tool_call':
            this.chatWorking = true;
            this.chatTool = event.name;
            break;
          case 'completed':
          case 'iteration_limit':
            this.chatWorking = false;
            this.chatTool = undefined;
            break;
          default:
            break;
        }
        this.pushChat();
        break;
      }
      case 'event': {
        // Raw SupervisorEvent from the daemon's subscribe stream. Events are
        // the change signal: rebuild the inbox view (debounced) so the
        // renderer always shows the latest state without polling.
        this.scheduleRefresh();
        break;
      }
      default:
        // Unknown push type — ignore for forward compatibility.
        break;
    }
  }

  /**
   * Send `{type:'subscribe'}` on the live daemon socket so SupervisorEvents
   * stream in and drive {@link scheduleRefresh}. No-op when disconnected.
   */
  subscribeToEvents(): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'subscribe' }));
    }
  }

  /**
   * Handle a command sent by the renderer over the `command` IPC channel.
   * Forwards to the daemon and replies on `command:result` with the same
   * correlation id.
   */
  async handleRendererCommand(message: unknown): Promise<void> {
    const m = message as { id?: unknown; cmd?: unknown };
    if (m.cmd === 'ptt:toggle') {
      void this.pttToggle();
      this.bridge.sendToRenderer('command:result', { id: m.id, res: { ok: true } });
      return;
    }
    if (typeof m.cmd === 'string' && (await this.handleInspectorCommand(m.cmd, m.id))) {
      return;
    }
    if (typeof m.cmd === 'string' && (await this.handleIdeasCommand(m.cmd, m.id))) {
      return;
    }
    if (typeof m.cmd === 'string' && (await this.handleDictationCommand(m.cmd, m.id))) {
      return;
    }
    if (typeof m.cmd === 'string' && (await this.handleVoiceCommand(m.cmd, m.id))) {
      return;
    }
    if (typeof m.cmd === 'string' && m.cmd.startsWith('deskset:')) {
      this.handleDesktopSettingsCommand(m.cmd, m.id);
      return;
    }
    const cmd = this.resolveRendererCommand(m.cmd);
    if (cmd === null) {
      // UI-only verbs (inspect / digest / diff / clear-filter …) are handled
      // by the renderer itself — acknowledge without hitting the daemon.
      this.bridge.sendToRenderer('command:result', { id: m.id, res: { ok: true } });
      return;
    }
    if (typeof cmd === 'object' && 'error' in cmd) {
      this.bridge.sendToRenderer('command:result', {
        id: m.id,
        res: { ok: false, error: (cmd as { error: string }).error },
      });
      return;
    }
    const res = await this.sendCommand(cmd).catch((e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    this.bridge.sendToRenderer('command:result', { id: m.id, res });
    // Chat (issue #160): a started turn shows the working row right
    // away; a clear wipes the local mirror — the journaled rows stay
    // on the daemon side, the read window just moved.
    if (res.ok && cmd.kind === 'chat-send') {
      this.chatWorking = 'turn' in res && res.turn === 'started';
      if (this.chatWorking) this.pushChat();
    }
    if (res.ok && cmd.kind === 'chat-clear') {
      this.chatMessages = [];
      this.chatClearedAt = new Date().toISOString();
      this.chatWorking = false;
      this.chatTool = undefined;
      this.pushChat();
    }
    // Committed mutations re-pull their view data so the screen reflects
    // the journaled change immediately (#128 preferences, #129 ideas,
    // #130 memory-write gate).
    if (
      res.ok &&
      (cmd.kind === 'update-preference' ||
        cmd.kind === 'memory-confirm' ||
        cmd.kind === 'memory-reject' ||
        IDEACMD_KINDS.has(cmd.kind))
    ) {
      void this.refreshViews();
    }
  }

  /**
   * Translate the view layer's string command identifiers (`approve:<id>`,
   * `deny:<id>`) into typed daemon {@link Command}s by looking the item up
   * in the current renderer state. Returns `null` for UI-only verbs.
   */
  private resolveRendererCommand(cmd: unknown): Command | { error: string } | null {
    if (typeof cmd !== 'string') return cmd as Command;
    // `prefcmd:<uri-encoded JSON>` carries a typed `update-preference`
    // command authored by the prefs screen — decode, validate the kind,
    // forward. Other kinds are rejected: the renderer can only mutate
    // the preference profile through this verb (DEC-011).
    if (cmd.startsWith('prefcmd:')) {
      try {
        const parsed = JSON.parse(decodeURIComponent(cmd.slice('prefcmd:'.length))) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { kind?: unknown }).kind === 'update-preference'
        ) {
          return parsed as Command;
        }
        return { error: 'prefcmd payload must be an update-preference command' };
      } catch {
        return { error: 'malformed prefcmd payload' };
      }
    }
    // `ideacmd:<uri-encoded JSON>` — same pattern for the ideas screen,
    // whitelisted to the idea/brief command kinds (issue #129).
    if (cmd.startsWith('ideacmd:')) {
      try {
        const parsed = JSON.parse(decodeURIComponent(cmd.slice('ideacmd:'.length))) as unknown;
        const kind = (parsed as { kind?: unknown }).kind;
        if (typeof kind === 'string' && IDEACMD_KINDS.has(kind)) {
          return parsed as Command;
        }
        return { error: 'ideacmd payload must be an idea/brief command' };
      } catch {
        return { error: 'malformed ideacmd payload' };
      }
    }
    // `chatcmd:<uri-encoded JSON>` — chat composer sends/clears (issue
    // #160). Whitelisted to the chat command kinds; the renderer can't
    // mint arbitrary commands through this verb (DEC-011).
    if (cmd.startsWith('chatcmd:')) {
      try {
        const parsed = JSON.parse(decodeURIComponent(cmd.slice('chatcmd:'.length))) as unknown;
        const kind = (parsed as { kind?: unknown }).kind;
        if (kind === 'chat-send' || kind === 'chat-clear') {
          return parsed as Command;
        }
        return { error: 'chatcmd payload must be a chat-send or chat-clear command' };
      } catch {
        return { error: 'malformed chatcmd payload' };
      }
    }
    // `memwrite:confirm:<id>` / `memwrite:reject:<id>` — memory-write
    // gate decisions on the Secretary screen (issue #130).
    if (cmd.startsWith('memwrite:confirm:')) {
      return { kind: 'memory-confirm', writeId: cmd.slice('memwrite:confirm:'.length) };
    }
    if (cmd.startsWith('memwrite:reject:')) {
      return { kind: 'memory-reject', writeId: cmd.slice('memwrite:reject:'.length) };
    }
    const [verb, itemId] = cmd.split(':', 2);
    if (verb === 'approve' || verb === 'deny') {
      const item = this.state.snapshot().inboxItems.find((i) => i.id === itemId);
      const approvalId = item?.payload['approvalId'];
      if (item === undefined || typeof approvalId !== 'string') {
        return { error: `Cannot ${verb}: no pending approval for ${itemId ?? '?'}` };
      }
      return {
        kind: 'approve',
        taskId: item.taskId,
        approvalId,
        decision: verb === 'approve' ? 'grant' : 'deny',
      };
    }
    return null;
  }

  /**
   * Session-inspector verbs (#126). `inspect-task:<id>` and
   * `approval:inspect:<cap>:<dest>` open the inspector on a task (daemon
   * `query-events` pull + `inspector:update` push + `view:show`); the
   * approval form resolves capability/destination against the mirrored
   * inbox items so the renderer can't fabricate a task id.
   * `inspect-event:<i>` selects a timeline row — local, no daemon call.
   * Returns true when the command was claimed.
   */
  private async handleInspectorCommand(raw: string, id: unknown): Promise<boolean> {
    const ack = (res: { ok: boolean; error?: string }): void => {
      this.bridge.sendToRenderer('command:result', { id, res });
    };
    if (raw.startsWith('inspect-task:')) {
      ack(await this.openInspector(raw.slice('inspect-task:'.length)));
      return true;
    }
    if (raw.startsWith('approval:inspect:')) {
      const parts = raw.split(':');
      const cap = parts[2];
      const dest = parts[3];
      const item = this.state
        .snapshot()
        .inboxItems.find(
          (i) =>
            i.kind === 'ApprovalRequest' &&
            i.payload['capability'] === cap &&
            i.payload['destination'] === dest,
        );
      if (item === undefined) {
        ack({ ok: false, error: `No pending approval matches ${cap ?? '?'} → ${dest ?? '?'}` });
        return true;
      }
      ack(await this.openInspector(item.taskId));
      return true;
    }
    if (raw.startsWith('inspect-event:')) {
      const idx = Number.parseInt(raw.slice('inspect-event:'.length), 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < this.inspectorEvents.length) {
        this.inspectorEventIndex = idx;
        this.pushInspector();
        ack({ ok: true });
      } else {
        ack({ ok: false, error: `No event at index ${raw.slice(14)}` });
      }
      return true;
    }
    return false;
  }

  /**
   * Ideas-screen verbs (#129). `idearead:<id>` pulls the ledger body
   * (`idea-read`) into the reader pane; `ideaclose` clears it. Both
   * re-push the ideas tree. Returns true when the command was claimed.
   */
  private async handleIdeasCommand(raw: string, id: unknown): Promise<boolean> {
    const ack = (res: { ok: boolean; error?: string }): void => {
      this.bridge.sendToRenderer('command:result', { id, res });
    };
    if (raw.startsWith('idearead:')) {
      const ideaId = raw.slice('idearead:'.length);
      const res = await this.sendCommand({ kind: 'idea-read', ideaId }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
      if (!res.ok || !('idea' in res) || res.idea === null || !('body' in res)) {
        this.ideaReader = null;
        ack({ ok: false, error: 'error' in res ? res.error : 'idea-read failed' });
      } else {
        this.ideaReader = { ideaId, title: res.idea.title, body: res.body ?? '' };
        void this.refreshViews();
        ack({ ok: true });
      }
      return true;
    }
    if (raw === 'ideaclose') {
      this.ideaReader = null;
      void this.refreshViews();
      ack({ ok: true });
      return true;
    }
    return false;
  }

  /**
   * Dictation verbs (issue #161). `dictation:start` begins a mic round
   * (the service pushes `dictation:capture` to start the renderer mic and
   * `dictation:update` for state/transcripts); `dictation:stop` commits
   * and awaits the final transcript; `dictation:cancel` aborts silently.
   * Without a wired service the verbs fail honestly. Returns true when
   * the command was claimed.
   */
  private async handleDictationCommand(raw: string, id: unknown): Promise<boolean> {
    if (!raw.startsWith('dictation:')) return false;
    // dictation:audio / dictation:capture / dictation:update are channel
    // names, not renderer verbs — only the three control verbs reach here
    // via the `command` channel.
    const verb = raw.slice('dictation:'.length);
    if (verb !== 'start' && verb !== 'stop' && verb !== 'cancel') return false;
    const ack = (res: { ok: boolean; error?: string }): void => {
      this.bridge.sendToRenderer('command:result', { id, res });
    };
    if (this.dictation === undefined) {
      ack({ ok: false, error: 'dictation is not configured' });
      return true;
    }
    if (verb === 'cancel') {
      this.dictation.cancel();
      ack({ ok: true });
      return true;
    }
    if (verb === 'start' && this.voiceActive) {
      ack({ ok: false, error: 'voice mode is active — turn it off to dictate' });
      return true;
    }
    const run = verb === 'start' ? this.dictation.start() : this.dictation.stop();
    await run.then(
      () => ack({ ok: true }),
      (err: unknown) => ack({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  }

  /**
   * One push-to-talk semantic shared by the global hotkey and the HUD
   * pill click (`ptt:toggle`): voice mode on → toggle a talk turn;
   * off → toggle a dictation round (start captures, stop commits and
   * emits the final). The HUD hook fires only when a real engine
   * accepted the toggle — a dead button never animates the pill.
   */
  async pttToggle(): Promise<void> {
    if (this.voiceActive && this.voiceSession !== undefined) {
      try {
        if (this.voiceListening) {
          this.voiceSession.stopListening();
          this.voiceListening = false;
        } else {
          this.voiceSession.startListening();
          this.voiceListening = true;
        }
      } catch (err) {
        // A dead session (socket dropped mid-mode) must surface honestly —
        // the HUD never animates on a talk turn that didn't start.
        this.voiceListening = false;
        this.bridge.sendToRenderer('voice:update', {
          listening: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      this.onPttToggle?.(this.voiceListening);
      this.bridge.sendToRenderer('voice:update', { listening: this.voiceListening });
      return;
    }
    if (this.dictation !== undefined) {
      if (this.dictation.active) {
        this.onPttToggle?.(false);
        void this.dictation.stop().catch(() => undefined);
      } else {
        await this.dictation.start().catch(() => undefined);
        // The hook fires only once the engine reports listening —
        // a failed start (no key, dead engine) never fakes the HUD.
        if (this.dictation.currentState === 'listening') this.onPttToggle?.(true);
      }
      return;
    }
    this.bridge.sendToRenderer('dictation:update', {
      state: 'error',
      error: 'no voice engine — set OPENAI_API_KEY or FLORINA_WHISPER_MODEL',
    });
  }

  /**
   * Voice-mode verbs (issue #162). `voicemode:start` opens the realtime
   * session (tools + HUD state reporting); `voicemode:stop` closes it;
   * `voice:talk` toggles a push-to-talk turn inside the session — the mic
   * button's role while voice mode is on. Mutually exclusive with
   * dictation: starting voice mode cancels an in-flight dictation round.
   */
  private async handleVoiceCommand(raw: string, id: unknown): Promise<boolean> {
    if (raw !== 'voicemode:start' && raw !== 'voicemode:stop' && raw !== 'voice:talk') {
      return false;
    }
    const ack = (res: { ok: boolean; error?: string }): void => {
      this.bridge.sendToRenderer('command:result', { id, res });
    };
    if (this.voiceSession === undefined) {
      ack({ ok: false, error: 'voice mode is not configured' });
      return true;
    }
    if (raw === 'voicemode:start' && (this.voiceActive || this.voiceConnecting)) {
      // Already on, or a connect is still in flight — idempotent ack.
      ack({ ok: true });
      return true;
    }
    try {
      if (raw === 'voicemode:start') {
        // The connect can take seconds — tell the renderer so the
        // toggle isn't a dead click.
        this.bridge.sendToRenderer('voice:update', { connecting: true });
        this.voiceConnecting = true;
        this.dictation?.cancel(); // one audio pipeline at a time
        try {
          await this.voiceSession.start();
        } finally {
          this.voiceConnecting = false;
        }
        this.voiceActive = true;
        this.bridge.sendToRenderer('voice:update', { active: true });
        this.onVoiceModeChange?.(true);
      } else if (raw === 'voicemode:stop') {
        this.voiceListening = false;
        this.voiceSession.stopListening();
        await this.voiceSession.stop();
        this.voiceActive = false;
        this.bridge.sendToRenderer('voice:update', { active: false });
        this.onVoiceModeChange?.(false);
      } else {
        // voice:talk — PTT inside voice mode.
        if (!this.voiceActive) {
          ack({ ok: false, error: 'voice mode is off' });
          return true;
        }
        if (this.voiceListening) {
          this.voiceSession.stopListening();
          this.voiceListening = false;
        } else {
          this.voiceSession.startListening();
          this.voiceListening = true;
        }
        this.bridge.sendToRenderer('voice:update', { listening: this.voiceListening });
      }
      ack({ ok: true });
    } catch (err) {
      ack({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  /**
   * Push the voice preference/config to the renderer (issue #162) —
   * called on `did-finish-load` like the other state replays (#133).
   * When a settings store is wired (#163) the freshest read wins so a
   * `deskset:` save is reflected immediately.
   */
  replayVoiceConfig(): void {
    const config = this.desktopSettings?.read() ?? this.voiceConfig;
    if (config !== undefined) {
      this.bridge.sendToRenderer('voice:update', { config });
    }
  }

  /**
   * `deskset:<uri-encoded JSON>` — persist a desktop-settings patch
   * (issue #163). The renderer may only touch the desktop-owned fields;
   * anything else is stripped. After a successful write the config is
   * re-pushed so the UI reflects what actually landed on disk.
   */
  private handleDesktopSettingsCommand(raw: string, id: unknown): void {
    const ack = (res: { ok: boolean; error?: string }): void => {
      this.bridge.sendToRenderer('command:result', { id, res });
    };
    if (this.desktopSettings === undefined) {
      ack({ ok: false, error: 'desktop settings store is not wired' });
      return;
    }
    let patch: unknown;
    try {
      patch = JSON.parse(decodeURIComponent(raw.slice('deskset:'.length)));
    } catch {
      ack({ ok: false, error: 'malformed deskset payload' });
      return;
    }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      ack({ ok: false, error: 'deskset payload must be an object' });
      return;
    }
    const p = patch as Record<string, unknown>;
    const current = this.desktopSettings.read();
    const next: DesktopSettingsShape = {
      stopDaemonOnQuit:
        typeof p['stopDaemonOnQuit'] === 'boolean'
          ? p['stopDaemonOnQuit']
          : current.stopDaemonOnQuit,
      voiceModeDefault:
        typeof p['voiceModeDefault'] === 'boolean'
          ? p['voiceModeDefault']
          : current.voiceModeDefault,
      ...(p['micDeviceId'] === null
        ? {}
        : typeof p['micDeviceId'] === 'string' && p['micDeviceId'].length > 0
          ? { micDeviceId: p['micDeviceId'] }
          : current.micDeviceId !== undefined
            ? { micDeviceId: current.micDeviceId }
            : {}),
      ...(p['dictationLanguage'] === null
        ? {}
        : typeof p['dictationLanguage'] === 'string' && p['dictationLanguage'].length > 0
          ? { dictationLanguage: p['dictationLanguage'] }
          : current.dictationLanguage !== undefined
            ? { dictationLanguage: current.dictationLanguage }
            : {}),
    };
    try {
      this.desktopSettings.write(next);
    } catch (err) {
      ack({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Apply live: future dictation rounds use the new language; mic
    // device + voice default flow through the config re-push below.
    this.dictation?.setSessionLanguage(next.dictationLanguage);
    ack({ ok: true });
    this.replayVoiceConfig();
  }

  /**
   * Open the session inspector on `taskId`: switch the renderer to the
   * Tasks view, pull the task's journaled events (`query-events`), and
   * push the rendered three-column tree. Keeps last-known events when the
   * daemon is unreachable (DG-01 §4).
   */
  private async openInspector(taskId: string): Promise<{ ok: boolean; error?: string }> {
    this.inspectorTaskId = taskId;
    this.inspectorEventIndex = null;
    this.bridge.sendToRenderer('view:show', 'tasks');
    const res = await this.sendCommand({ kind: 'query-events', taskId }).catch((e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (!res.ok) {
      this.pushInspector();
      return { ok: false, error: 'error' in res ? res.error : 'query-events failed' };
    }
    this.inspectorEvents = 'events' in res ? res.events : [];
    this.pushInspector();
    return { ok: true };
  }

  /** Re-pull events for the open inspector task (live timeline refresh). */
  private async refreshInspectorEvents(): Promise<void> {
    if (this.inspectorTaskId === null) return;
    const res = await this.sendCommand({
      kind: 'query-events',
      taskId: this.inspectorTaskId,
    }).catch(() => null);
    if (res === null || !res.ok) return; // offline — keep last known events
    this.inspectorEvents = 'events' in res ? res.events : [];
    this.pushInspector();
  }

  /** Render and push the inspector tree on the `inspector:update` channel. */
  private pushInspector(): void {
    this.bridge.sendToRenderer(
      'inspector:update',
      renderInspectorView({
        tasks: this.tasks,
        selectedTaskId: this.inspectorTaskId,
        events: this.inspectorEvents,
        selectedEventIndex: this.inspectorEventIndex,
      }),
    );
  }

  /** Render and push the chat message list on the `chat:update` channel. */
  private pushChat(): void {
    this.bridge.sendToRenderer(
      'chat:update',
      renderChatScreen({
        messages: this.chatMessages,
        working: this.chatWorking,
        ...(this.chatTool !== undefined ? { workingTool: this.chatTool } : {}),
        ...(this.chatClearedAt !== undefined ? { clearedAt: this.chatClearedAt } : {}),
      }),
    );
  }

  /**
   * Re-query the daemon and push fresh RenderTrees to the renderer.
   * Debounced because daemon events can arrive in bursts.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshViews();
    }, 250);
  }

  /**
   * Trigger an immediate view refresh — used right after connect so the
   * renderer shows current state without waiting for a daemon event.
   */
  async refreshNow(): Promise<void> {
    return this.refreshViews();
  }

  /**
   * Pull current inbox + task state and push the rendered home tree to the
   * renderer (NEEDS YOU / WORKING / DONE — issue #120).
   */
  private async refreshViews(): Promise<void> {
    // A dropped socket mid-refresh is normal (reconnect races) — treat a
    // failed send as "no answer" and keep the last known state rather than
    // blanking the renderer or throwing an unhandled rejection.
    const [inboxRes, tasksRes, fleetRes, prefsRes, ideasRes, briefsRes, secretaryRes, chatRes] =
      await Promise.all([
        this.sendCommand({ kind: 'query-inbox' }).catch(() => null),
        this.sendCommand({ kind: 'list-tasks' }).catch(() => null),
        this.sendCommand({ kind: 'query-fleet' }).catch(() => null),
        this.sendCommand({ kind: 'query-preferences' }).catch(() => null),
        this.sendCommand({ kind: 'idea-list' }).catch(() => null),
        this.sendCommand({ kind: 'brief-list' }).catch(() => null),
        this.sendCommand({ kind: 'query-secretary' }).catch(() => null),
        this.sendCommand({ kind: 'chat-read' }).catch(() => null),
      ]);
    if (
      inboxRes === null &&
      tasksRes === null &&
      fleetRes === null &&
      prefsRes === null &&
      ideasRes === null &&
      briefsRes === null &&
      secretaryRes === null &&
      chatRes === null
    ) {
      return; // offline — keep last known
    }
    const items =
      inboxRes !== null && inboxRes.ok && 'items' in inboxRes
        ? (inboxRes as { items: AttentionItemSnapshot[] }).items
        : [...this.state.snapshot().inboxItems];
    const tasks =
      tasksRes !== null && tasksRes.ok && 'tasks' in tasksRes
        ? (tasksRes as { tasks: TaskSnapshot[] }).tasks
        : this.tasks; // keep last-known task list when the query fails
    this.tasks = tasks;
    // Chat activity/diff drawer (#181): same task list as Fleet/Tasks,
    // pushed alongside them rather than on a separate query cycle.
    this.bridge.sendToRenderer('chat:activity', renderChatActivityDrawer(tasks));
    this.state.update({ inboxItems: items });
    this.bridge.sendToRenderer('inbox:update', renderHomeView(items as AttentionItem[], tasks));
    // Keep the inspector in sync: column 1 always shows the task list,
    // and an open task's timeline re-pulls so events journal forward.
    if (this.inspectorTaskId === null) this.pushInspector();
    else void this.refreshInspectorEvents();
    // Fleet/quota screen (#127): quota + parked + routing decisions.
    if (fleetRes !== null && fleetRes.ok && 'providers' in fleetRes) {
      this.bridge.sendToRenderer('fleet:update', renderFleetScreen(fleetRes));
    }
    // Preferences screen (#128): durable routing rules + denies.
    if (prefsRes !== null && prefsRes.ok && 'profile' in prefsRes) {
      this.bridge.sendToRenderer(
        'prefs:update',
        renderPrefsScreen(prefsRes.profile as PreferenceProfile),
      );
    }
    // Ideas screen (#129): ledger directory + awaiting-decision briefs.
    if (ideasRes !== null && briefsRes !== null && 'ideas' in ideasRes && 'briefs' in briefsRes) {
      this.bridge.sendToRenderer(
        'ideas:update',
        renderIdeasScreen({
          ideas: ideasRes as IdeaListResponse,
          briefs: briefsRes as BriefListResponse,
          ...(this.ideaReader !== null ? { reader: this.ideaReader } : {}),
        }),
      );
    }
    // History screen (issue #221): completed tasks + resolved decisions,
    // pure read-composition over the same task/inbox data already
    // fetched above -- no new query, no new data model.
    this.bridge.sendToRenderer('history:update', renderHistoryView({ tasks, resolvedItems: items as AttentionItem[] }));
    // Secretary screen (#130): plan, research, memory writes, health.
    if (secretaryRes !== null && secretaryRes.ok && 'plan' in secretaryRes) {
      this.bridge.sendToRenderer(
        'secretary:update',
        renderSecretaryScreen(secretaryRes as SecretaryResponse),
      );
    }
    // Chat screen (#160): rehydrate the single conversation — resume is
    // automatic on every (re)connect. A daemon restart loses any
    // in-flight turn, so the working row resets here.
    if (chatRes !== null && chatRes.ok && 'messages' in chatRes) {
      this.chatMessages = [...chatRes.messages];
      this.chatClearedAt = chatRes.clearedAt;
      this.chatWorking = false;
      this.chatTool = undefined;
      this.pushChat();
    }
  }
}
