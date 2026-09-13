/**
 * DaemonClient — WebSocket client for the `secretary` / `asec` CLI (#20).
 *
 * The CLI talks to the running daemon over the same localhost WebSocket the
 * daemon exposes (DEC-008). Each request is a typed {@link Command} from the
 * shared command API (#19); the daemon returns a typed {@link Response}.
 *
 * The client is intentionally thin: open a connection, send one JSON-serialized
 * command, await the matching response, and close. Connection errors are
 * surfaced as rejected promises with human-readable messages so the CLI can
 * print a helpful hint (e.g. "is the daemon running?") instead of a raw
 * `ECONNREFUSED` stack.
 */
import { WebSocket } from 'ws';

import type { Command, Response } from '../../../core/application/use-cases/tasks/command-api.js';

/** Default localhost port the daemon listens on (DEC-008). */
export const DEFAULT_DAEMON_PORT = 17419;

/** Default host — always localhost (never exposed to the network in MVP). */
export const DEFAULT_DAEMON_HOST = '127.0.0.1';

/** Options for constructing a {@link DaemonClient}. */
export interface DaemonClientOptions {
  /** Daemon host (defaults to 127.0.0.1). */
  readonly host?: string;
  /** Daemon port (defaults to {@link DEFAULT_DAEMON_PORT}). */
  readonly port?: number;
  /** Connection / response timeout in milliseconds (default 10s). */
  readonly timeoutMs?: number;
}

/**
 * Connection-oriented error thrown when the daemon cannot be reached or a
 * request times out. Carries a human-readable `message` suitable for CLI
 * output.
 */
export class DaemonConnectionError extends Error {
  constructor(message: string, readonly cause?: Error) {
    super(message);
    this.name = 'DaemonConnectionError';
  }
}

/**
 * A WebSocket client that sends typed {@link Command}s to the daemon and
 * resolves with the typed {@link Response}.
 *
 * A new connection is opened per `send` call (request/response). This keeps
 * the client stateless and simple — the CLI issues one command per process
 * invocation. A long-lived connection mode can be added later for streaming.
 */
export class DaemonClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options: DaemonClientOptions = {}) {
    this.host = options.host ?? DEFAULT_DAEMON_HOST;
    this.port = options.port ?? DEFAULT_DAEMON_PORT;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** The `ws://` URL the client connects to. */
  get url(): string {
    return `ws://${this.host}:${this.port}`;
  }

  /**
   * Send a typed {@link Command} to the daemon and resolve with the typed
   * {@link Response}.
   *
   * Rejects with {@link DaemonConnectionError} if the daemon cannot be
   * reached, the response is malformed, or the request times out.
   */
  send(command: Command): Promise<Response> {
    return this.sendRaw(command);
  }

  /**
   * Low-level send that accepts the command and returns the parsed response.
   * Exposed for tests that want to inject a custom transport.
   */
  sendRaw(command: Command, transport?: WebSocketTransport): Promise<Response> {
    const sendImpl = transport ?? this.openSocket.bind(this);
    return sendImpl(command, this.timeoutMs);
  }

  /**
   * Probe whether the daemon is reachable. Resolves with `true` if a
   * WebSocket handshake succeeds, `false` otherwise. Never rejects.
   */
  async ping(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        socket.terminate();
        resolve(false);
      }, Math.min(this.timeoutMs, 2000));
      socket.once('open', () => {
        clearTimeout(timer);
        socket.close();
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /**
   * Open a WebSocket, send the serialized command, and resolve with the
   * parsed response. This is the default transport used by {@link send}.
   */
  private openSocket(command: Command, timeoutMs: number): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        reject(toConnectionError(err, this.url));
        return;
      }

      const timer = setTimeout(() => {
        socket.terminate();
        reject(new DaemonConnectionError(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.once('open', () => {
        socket.send(JSON.stringify(command));
      });

      socket.once('message', (data: unknown) => {
        clearTimeout(timer);
        const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          reject(
            new DaemonConnectionError('Malformed response from daemon', err as Error),
          );
          socket.close();
          return;
        }
        socket.close();
        resolve(parsed as Response);
      });

      socket.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(toConnectionError(err, this.url));
      });
    });
  }
}

/**
 * A pluggable transport function — used to mock the WebSocket layer in tests.
 * Takes a command and a timeout, returns a promise of the response.
 */
export type WebSocketTransport = (command: Command, timeoutMs: number) => Promise<Response>;

/**
 * Convert a raw WebSocket/network error into a human-readable
 * {@link DaemonConnectionError}.
 */
function toConnectionError(err: unknown, url: string): DaemonConnectionError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ECONNREFUSED')) {
    return new DaemonConnectionError(
      `Cannot connect to daemon at ${url}. Is it running? Try 'secretary start'.`,
      err instanceof Error ? err : undefined,
    );
  }
  return new DaemonConnectionError(`Daemon connection failed: ${msg}`, err instanceof Error ? err : undefined);
}
