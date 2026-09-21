/**
 * IPC bridge for the desktop client (DEC-028, issue #24).
 *
 * The {@link IpcBridge} provides bidirectional communication between the
 * desktop main process and the renderer process. In a real Electron app this
 * maps onto `ipcMain` / `ipcRenderer`; in Tauri it maps onto the event
 * system. The bridge programs against a pluggable {@link IpcTransport}
 * interface so it can be exercised in tests without any real runtime.
 *
 * Channels are a fixed, typed set so the compiler can check both sides of a
 * message exchange. The desktop app is a strict client of the daemon
 * (DEC-028): the bridge only carries UI/state updates and user actions, never
 * business logic.
 */

/**
 * The canonical set of IPC channels used between the desktop main process and
 * the renderer. Kept as a const tuple so {@link IpcChannel} is a finite,
 * exhaustively-checkable union.
 */
export const IPC_CHANNELS = [
  'inbox:update',
  'task:update',
  'approval:request',
  'digest:update',
  'metrics:update',
  'voice:state',
  'daemon:status',
  'inspector:update',
  'view:show',
  'fleet:update',
  'prefs:update',
  'ideas:update',
  'history:update',
  'secretary:update',
  'chat:update',
  'chat:activity',
  'dictation:capture',
  'dictation:audio',
  'dictation:audio-out',
  'dictation:update',
  'voice:update',
  'hud:state',
  'command',
  'command:result',
] as const;

/** A single IPC channel name. */
export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** Callback invoked when a message arrives on a subscribed channel. */
export type IpcMessageHandler = (data: unknown) => void;

/**
 * Pluggable transport for the {@link IpcBridge}. Abstracts over
 * Electron's `ipcMain`/`ipcRenderer` or Tauri's event emitter so the bridge
 * can be tested headlessly.
 *
 * The transport is responsible for actually delivering a message to the other
 * process; the bridge only routes by channel.
 */
export interface IpcTransport {
  /** Send a message to the renderer process on the given channel. */
  sendToRenderer(channel: IpcChannel, data: unknown): void;
  /** Send a message to the main process on the given channel. */
  sendToMain(channel: IpcChannel, data: unknown): void;
  /** Register a handler for messages arriving on a channel. */
  onMessage(channel: IpcChannel, handler: IpcMessageHandler): () => void;
}

/**
 * Error thrown when an IPC operation fails or is used incorrectly (e.g.
 * sending on an unknown channel or a transport error).
 */
export class IpcError extends Error {
  constructor(
    message: string,
    readonly channel?: IpcChannel,
    readonly cause?: Error,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

/**
 * Bidirectional IPC bridge between the desktop main process and renderer.
 *
 * The bridge validates channel names against {@link IPC_CHANNELS} and
 * delegates actual delivery to the injected {@link IpcTransport}. Handlers
 * registered via {@link on} are invoked for every incoming message on the
 * matching channel, regardless of direction.
 */
export class IpcBridge {
  private readonly handlers = new Map<IpcChannel, Set<IpcMessageHandler>>();
  private readonly transport: IpcTransport;
  private readonly unsubs: Array<() => void> = [];
  private disposed = false;

  constructor(transport: IpcTransport) {
    this.transport = transport;
    // Wire every channel so the bridge sees all incoming messages.
    for (const channel of IPC_CHANNELS) {
      const unsub = transport.onMessage(channel, (data) => {
        this.dispatch(channel, data);
      });
      this.unsubs.push(unsub);
    }
  }

  /**
   * Send data to the renderer process on the given channel.
   * Throws {@link IpcError} if the channel is invalid or the bridge is disposed.
   */
  sendToRenderer(channel: IpcChannel, data: unknown): void {
    this.assertChannel(channel);
    this.assertNotDisposed();
    try {
      this.transport.sendToRenderer(channel, data);
    } catch (err) {
      throw new IpcError(
        `Failed to send to renderer on "${channel}"`,
        channel,
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Send data to the main process on the given channel.
   * Throws {@link IpcError} if the channel is invalid or the bridge is disposed.
   */
  sendToMain(channel: IpcChannel, data: unknown): void {
    this.assertChannel(channel);
    this.assertNotDisposed();
    try {
      this.transport.sendToMain(channel, data);
    } catch (err) {
      throw new IpcError(
        `Failed to send to main on "${channel}"`,
        channel,
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Register a handler for an IPC channel. The handler is invoked for every
   * incoming message on that channel. Returns an unsubscribe function.
   */
  on(channel: IpcChannel, callback: IpcMessageHandler): () => void {
    this.assertChannel(channel);
    this.assertNotDisposed();
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(callback);
    return () => {
      const s = this.handlers.get(channel);
      if (s) s.delete(callback);
    };
  }

  /** Release all transport subscriptions. The bridge is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // ignore — best-effort cleanup
      }
    }
    this.unsubs.length = 0;
    this.handlers.clear();
  }

  /** Whether the bridge has been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Dispatch an incoming message to all registered handlers for a channel. */
  private dispatch(channel: IpcChannel, data: unknown): void {
    if (this.disposed) return;
    const set = this.handlers.get(channel);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (err) {
        // A handler throwing must not break other handlers or the transport.
        // Re-throw as an IpcError only if the caller wants to observe it; here
        // we swallow to keep the bridge resilient.
        void err;
      }
    }
  }

  private assertChannel(channel: IpcChannel): void {
    if (!IPC_CHANNELS.includes(channel)) {
      throw new IpcError(`Unknown IPC channel: "${channel}"`, channel);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new IpcError('IpcBridge has been disposed');
    }
  }
}

/**
 * In-memory {@link IpcTransport} for tests. Records every sent message and
 * lets tests deliver messages in either direction via {@link emitToMain} /
 * {@link emitToRenderer}.
 */
export class MockIpcTransport implements IpcTransport {
  /** Messages sent to the renderer, in order: [channel, data]. */
  readonly toRenderer: Array<{ channel: IpcChannel; data: unknown }> = [];
  /** Messages sent to the main process, in order: [channel, data]. */
  readonly toMain: Array<{ channel: IpcChannel; data: unknown }> = [];
  private readonly listeners = new Map<IpcChannel, Set<IpcMessageHandler>>();

  sendToRenderer(channel: IpcChannel, data: unknown): void {
    this.toRenderer.push({ channel, data });
  }

  sendToMain(channel: IpcChannel, data: unknown): void {
    this.toMain.push({ channel, data });
  }

  onMessage(channel: IpcChannel, handler: IpcMessageHandler): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(handler);
    return () => {
      const s = this.listeners.get(channel);
      if (s) s.delete(handler);
    };
  }

  /** Simulate a message arriving from the renderer (delivered to main-side handlers). */
  emitToMain(channel: IpcChannel, data: unknown): void {
    const set = this.listeners.get(channel);
    if (set) {
      for (const h of set) h(data);
    }
  }

  /** Simulate a message arriving from the main process (delivered to renderer-side handlers). */
  emitToRenderer(channel: IpcChannel, data: unknown): void {
    // Both directions flow through the same onMessage listeners in the bridge.
    const set = this.listeners.get(channel);
    if (set) {
      for (const h of set) h(data);
    }
  }

  /** Clear all recorded messages. */
  reset(): void {
    this.toRenderer.length = 0;
    this.toMain.length = 0;
  }
}
