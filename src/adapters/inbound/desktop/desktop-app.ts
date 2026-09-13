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
import type { AttentionItemSnapshot, TaskSnapshot } from '../../../core/application/use-cases/tasks/command-api.js';
import type { MetricsSnapshot } from '../../../core/application/use-cases/metrics.js';
import { IpcBridge } from './ipc-bridge.js';
import type { IpcTransport } from './ipc-bridge.js';
import { RendererState } from './renderer-state.js';
import type { RendererStateData, StateChangeCallback, VoiceState, DaemonStatus } from './renderer-state.js';
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
}

/**
 * Error thrown when the desktop app cannot connect to the daemon.
 */
export class DesktopConnectionError extends Error {
  constructor(message: string, readonly cause?: Error) {
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
  private started = false;

  constructor(options: DesktopAppOptions) {
    this.window = options.window;
    this.bridge = new IpcBridge(options.ipcTransport);
    this.state = new RendererState();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
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
  }

  /**
   * Connect to the Florina daemon at the given WebSocket URL. On success,
   * updates renderer state to `connected` and wires incoming daemon messages
   * to renderer-state updates. Rejects with {@link DesktopConnectionError}
   * on failure.
   */
  connectToDaemon(socketUrl: string): Promise<void> {
    this.updateDaemonStatus('connecting', { connected: false, error: undefined });
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
        const e = new DesktopConnectionError(
          `Timed out connecting to daemon at ${socketUrl}`,
        );
        this.updateDaemonStatus('error', { connected: false, error: e.message });
        reject(e);
      }, this.connectTimeoutMs);

      socket.once('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.updateDaemonStatus('connected', { connected: true, error: undefined });
        this.wireDaemonSocket(socket);
        resolve();
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
   * Send a typed {@link Command} to the daemon over the live WebSocket and
   * resolve with the typed {@link Response}. Rejects if not connected or the
   * response times out / is malformed.
   */
  sendCommand(command: Command, timeoutMs = 10_000): Promise<Response> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new DesktopConnectionError('Not connected to daemon'));
    }
    const socket = this.socket;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DesktopConnectionError(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMessage = (data: unknown): void => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          reject(
            new DesktopConnectionError(
              'Malformed response from daemon',
              err instanceof Error ? err : undefined,
            ),
          );
          return;
        }
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

  /** Disconnect from the daemon and reset connection-related renderer state. */
  disconnect(): Promise<void> {
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
  private updateDaemonStatus(
    status: DaemonStatus,
    extra?: Partial<RendererStateData>,
  ): void {
    this.state.update({ daemonStatus: status, ...extra });
    if (this.tray !== null) {
      this.tray.setStatus(status);
    }
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
      this.socket = null;
      this.updateDaemonStatus('disconnected', { connected: false, error: undefined });
    });

    socket.once('error', (err: Error) => {
      this.socket = null;
      this.updateDaemonStatus('error', { connected: false, error: err.message });
    });
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
        const voiceState: VoiceState = {
          listening: Boolean(record['listening']),
          speaking: Boolean(record['speaking']),
          muted: Boolean(record['muted']),
          mode: typeof record['mode'] === 'string' ? record['mode'] : undefined,
        };
        this.state.update({ voiceState });
        this.bridge.sendToRenderer('voice:state', record);
        break;
      }
      default:
        // Unknown push type — ignore for forward compatibility.
        break;
    }
  }
}
