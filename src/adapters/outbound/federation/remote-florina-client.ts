/**
 * Remote Florina client (DEC-036, issue #78) — a persistent WebSocket
 * connection to a child daemon's control plane, parent side.
 *
 * Unlike {@link DaemonClient} (one connection per request, for the CLI),
 * this client holds a long-lived socket: it authenticates, subscribes
 * to the child's event stream, and multiplexes command responses
 * against streamed events on the same connection.
 *
 * Wire protocol (shared with {@link WebSocketControlPlaneServer}):
 * - Client → server: `{type:'auth', token}`, `{type:'subscribe'}`,
 *   typed Command objects.
 * - Server → client: `{type:'auth', ok}`, `{type:'event', event, seq}`,
 *   typed Response objects.
 *
 * Command responses are matched FIFO — callers serialize `send` calls
 * (the adapter issues delegate/stop sequentially), which is the same
 * discipline the CLI client relies on per-connection.
 */
import { WebSocket } from 'ws';

import type { Command, Response } from '../../../core/application/use-cases/tasks/command-api.js';
import type { SupervisorEvent } from '../../../core/domain/events.js';

/** Options for {@link RemoteFlorinaClient}. */
export interface RemoteFlorinaClientOptions {
  /** Child daemon host (e.g. `server-x` or `127.0.0.1`). */
  readonly host: string;
  /** Child daemon control-plane port. */
  readonly port: number;
  /** Pairing token when the child requires auth; omit for localhost trust. */
  readonly authToken?: string;
  /** Connection/response timeout in milliseconds (default 10s). */
  readonly timeoutMs?: number;
}

/** Raised for connection, auth, or protocol failures. */
export class RemoteFlorinaError extends Error {
  constructor(
    message: string,
    readonly cause?: Error,
  ) {
    super(message);
    this.name = 'RemoteFlorinaError';
  }
}

/**
 * Persistent parent-side client for a child daemon. Multiplexes the
 * three inbound message shapes (auth replies, event envelopes, command
 * responses) over one socket.
 */
export class RemoteFlorinaClient {
  private readonly options: RemoteFlorinaClientOptions;
  private socket: WebSocket | null = null;
  /** FIFO queue of resolvers for in-flight command responses. */
  private readonly pendingResponses: Array<{
    resolve: (r: Response) => void;
    reject: (e: Error) => void;
  }> = [];
  /** Buffered subscribed events awaiting consumption. */
  private readonly eventQueue: SupervisorEvent[] = [];
  private readonly eventResolvers: Array<(e: SupervisorEvent | null) => void> = [];
  private authResolve?: (ok: boolean, error?: string) => void;
  private closed = false;

  constructor(options: RemoteFlorinaClientOptions) {
    this.options = options;
  }

  /** The `ws://` URL of the child's control plane. */
  get url(): string {
    return `ws://${this.options.host}:${this.options.port}`;
  }

  /** Whether the socket is open. */
  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Open the socket and (when configured) complete the auth handshake.
   * Rejects on connection failure or a rejected token.
   */
  connect(): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timer = setTimeout(() => {
        reject(new RemoteFlorinaError(`connection to ${this.url} timed out`));
        socket.close();
      }, timeoutMs);

      socket.on('message', (data: unknown) => this.handleMessage(data));
      socket.on('close', () => this.handleClose());
      socket.on('error', (err: Error) => {
        clearTimeout(timer);
        if (this.authResolve === undefined && this.pendingResponses.length === 0) {
          reject(new RemoteFlorinaError(`cannot reach child daemon at ${this.url}`, err));
        }
      });

      socket.on('open', () => {
        if (this.options.authToken === undefined) {
          clearTimeout(timer);
          resolve();
          return;
        }
        // Auth handshake: resolve once the server replies.
        this.authResolve = (ok, error) => {
          clearTimeout(timer);
          if (ok) {
            resolve();
          } else {
            reject(new RemoteFlorinaError(error ?? 'authentication rejected'));
          }
        };
        socket.send(JSON.stringify({ type: 'auth', token: this.options.authToken }));
      });
    });
  }

  /** Subscribe to the child's event stream. */
  subscribe(): void {
    this.requireSocket().send(JSON.stringify({ type: 'subscribe' }));
  }

  /** Send a typed command; resolves with the child's typed response. */
  send(command: Command): Promise<Response> {
    const socket = this.requireSocket();
    return new Promise<Response>((resolve, reject) => {
      this.pendingResponses.push({ resolve, reject });
      socket.send(JSON.stringify(command));
    });
  }

  /**
   * Async iterable of subscribed events. Yields each streamed
   * SupervisorEvent until {@link close} is called (then completes).
   */
  async *events(): AsyncIterable<SupervisorEvent> {
    while (true) {
      const buffered = this.eventQueue.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<SupervisorEvent | null>((resolve) => {
        this.eventResolvers.push(resolve);
      });
      if (next === null) return;
      yield next;
    }
  }

  /** Close the socket and complete any pending event consumers. */
  close(): void {
    this.closed = true;
    for (const resolve of this.eventResolvers.splice(0)) {
      resolve(null);
    }
    for (const pending of this.pendingResponses.splice(0)) {
      pending.reject(new RemoteFlorinaError('connection closed'));
    }
    this.socket?.close();
    this.socket = null;
  }

  /* ---------------------------------------------------------------- *
   * Internal
   * ---------------------------------------------------------------- */

  private requireSocket(): WebSocket {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      throw new RemoteFlorinaError('not connected');
    }
    return this.socket;
  }

  /** Route an inbound message: auth reply, event envelope, or command response. */
  private handleMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const msg = parsed as Record<string, unknown>;

    if (msg['type'] === 'auth') {
      this.authResolve?.(
        msg['ok'] === true,
        typeof msg['error'] === 'string' ? msg['error'] : undefined,
      );
      this.authResolve = undefined;
      return;
    }
    if (msg['type'] === 'event' && typeof msg['event'] === 'object' && msg['event'] !== null) {
      const event = msg['event'] as SupervisorEvent;
      const waiter = this.eventResolvers.shift();
      if (waiter !== undefined) {
        waiter(event);
      } else {
        this.eventQueue.push(event);
      }
      return;
    }
    // Anything else is a command response — match FIFO.
    const pending = this.pendingResponses.shift();
    if (pending !== undefined) {
      pending.resolve(parsed as Response);
    }
  }

  private handleClose(): void {
    this.close();
  }
}
