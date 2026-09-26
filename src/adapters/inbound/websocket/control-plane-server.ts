/**
 * WebSocket control-plane server — inbound adapter (DEC-008, issue #93).
 *
 * Owns the localhost-only `ws` server for the daemon control plane: binding,
 * connection lifecycle, and routing of the two protocols that share the
 * socket:
 *
 *   - Command objects ({ kind: "start-task", ... })  → the command use case
 *   - ApiRequest envelopes ({ id, method, params })  → the control-plane API
 *   - Event-stream control messages ({ type: "subscribe" }) are handled by
 *     the EventStream's own listener installed via `register`.
 *
 * It composes core use cases and the sibling {@link EventStream} only — it
 * never imports storage, outbound adapters, or bootstrap; the composition
 * root supplies every collaborator.
 */
import { WebSocketServer, type WebSocket } from 'ws';

import type {
  Command,
  CommandApi,
  Response,
} from '../../../core/application/use-cases/tasks/command-api.js';
import {
  dispatch,
  parseApiRequest,
} from '../../../core/application/use-cases/control-plane/control-plane-api.js';
import type { ControlPlaneApi } from '../../../core/application/use-cases/control-plane/control-plane-api.js';
import { EventStream } from './event-stream.js';

/** The WebSocket type used by the control-plane surface (ws). */
export type WebSocketConnection = WebSocket;

/**
 * Configuration for {@link WebSocketControlPlaneServer}.
 */
export interface WebSocketControlPlaneServerOptions {
  /** Localhost port to bind. Pass `0` to let the OS assign a port. */
  readonly port: number;
  /** The typed command surface; only `execute` is required. */
  readonly commandApi: Pick<CommandApi, 'execute'>;
  /** The legacy typed control-plane API. */
  readonly controlPlaneApi: ControlPlaneApi;
  /** The live event stream that owns subscribe/unsubscribe control messages. */
  readonly eventStream: EventStream;
  /** Invoked for each accepted connection (e.g. to re-emit a daemon event). */
  readonly onConnection?: (socket: WebSocket) => void;
  /** Invoked for server errors after listening has started. */
  readonly onError?: (error: Error) => void;
  /**
   * Shared-secret auth for remote parents (DEC-036, issue #78). When
   * set, a connection's first message must be `{type:'auth', token}`;
   * until authenticated the socket is not registered with the event
   * stream and commands are rejected. Unset → every connection is
   * implicitly trusted (localhost-only mode, DEC-008).
   */
  readonly authToken?: string;
  /**
   * Capability scoping for remote connections (DEC-011, issue #78):
   * when set, only the listed command `kind`s may be executed — a
   * parent can narrow its own reach, never widen the child's policy.
   * Unset → all commands allowed.
   */
  readonly allowedCommands?: readonly string[];
}

/**
 * The localhost WebSocket server for the control plane.
 *
 * Bound to 127.0.0.1 only — the control plane is never exposed to the
 * network in MVP (DEC-008).
 */
export class WebSocketControlPlaneServer {
  private readonly options: WebSocketControlPlaneServerOptions;
  private wss: WebSocketServer | null = null;
  private boundPort: number;
  /** Registered-connection cleanup functions for shutdown. */
  private readonly unregisters = new Set<() => void>();

  constructor(options: WebSocketControlPlaneServerOptions) {
    this.options = options;
    this.boundPort = options.port;
  }

  /** The bound port (OS-assigned value when `0` was requested). */
  get port(): number {
    return this.boundPort;
  }

  /** Whether the server is currently listening. */
  get isListening(): boolean {
    return this.wss !== null;
  }

  /**
   * Bind 127.0.0.1 and begin accepting connections. When the requested port
   * is `0`, the OS-assigned port is captured and returned.
   *
   * @returns the actual bound port.
   */
  start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let listening = false;
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.options.port,
      });
      this.wss = wss;

      wss.on('connection', (socket) => this.handleConnection(socket));

      wss.on('error', (err) => {
        if (!listening) {
          reject(err);
        } else {
          this.options.onError?.(err);
        }
      });

      wss.on('listening', () => {
        listening = true;
        // If port 0 was requested, capture the OS-assigned port so callers
        // (notably tests) can connect to the actual bound port.
        const addr = wss.address();
        if (typeof addr === 'object' && addr !== null) {
          this.boundPort = addr.port;
        }
        resolve(this.boundPort);
      });
    });
  }

  /**
   * Stop accepting connections and unregister every registered connection
   * so its event-stream subscription and message listeners are released.
   */
  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      for (const unregister of this.unregisters) {
        unregister();
      }
      this.unregisters.clear();
      if (!this.wss) {
        resolve();
        return;
      }
      const wss = this.wss;
      this.wss = null;
      wss.close(() => resolve());
    });
  }

  /**
   * Wire an accepted connection: register it with the event stream, then
   * route each incoming message to the command or control-plane surface.
   */
  private handleConnection(socket: WebSocket): void {
    this.options.onConnection?.(socket);

    // Federation auth (issue #78): when authToken is configured, the
    // connection must authenticate before anything else — including
    // event-stream subscription. Registration is deferred until then.
    const authRequired = this.options.authToken !== undefined;
    let authenticated = !authRequired;
    let release: (() => void) | null = null;
    const registerStream = (): void => {
      const unregister = this.options.eventStream.register(socket);
      release = (): void => {
        unregister();
        this.unregisters.delete(release!);
      };
      this.unregisters.add(release);
    };
    if (authenticated) registerStream();

    socket.on('message', async (data) => {
      // Parse the raw JSON once so we can discriminate between the two
      // protocols that share this socket:
      //   - Command objects ({ kind: "start-task", ... })  → CommandApi
      //   - ApiRequest envelopes ({ id, method, params })  → ControlPlaneApi
      //   - Event-stream control messages ({ type: "subscribe" }) are
      //     handled by the EventStream's own listener installed via register.
      const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not valid JSON; let the event-stream listener handle control msgs.
        return;
      }

      // Auth handshake: the only message honored before authentication.
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { type?: unknown }).type === 'auth'
      ) {
        const token = (parsed as { token?: unknown }).token;
        if (!authRequired || token === this.options.authToken) {
          // Tolerate auth handshakes on an unauthenticated-free server so
          // token-bearing clients interoperate with older daemons. Only
          // register the stream once — open connections already registered.
          if (!authenticated) {
            authenticated = true;
            registerStream();
          }
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'auth', ok: true }));
          }
        } else {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'auth', ok: false, error: 'bad token' }));
          }
          socket.close();
        }
        return;
      }

      if (!authenticated) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ ok: false, error: 'authentication required' }));
        }
        return;
      }

      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { kind?: unknown }).kind === 'string'
      ) {
        const kind = (parsed as { kind: string }).kind;
        // Capability scoping (DEC-011, issue #78): remote connections
        // may only invoke the permitted command kinds.
        if (
          this.options.allowedCommands !== undefined &&
          !this.options.allowedCommands.includes(kind)
        ) {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ ok: false, error: `command not permitted: ${kind}` }));
          }
          return;
        }
        // Command dispatch path (issue #33).
        const response: Response = await this.options.commandApi.execute(parsed as Command);
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(response));
        }
        return;
      }

      // Legacy ControlPlaneApi dispatch path — pass the already-parsed
      // object; raw byte decoding is this transport's job, done above.
      const request = parseApiRequest(parsed);
      if (!request) {
        // Not an API request; the event stream's own control-message
        // listener (installed via register) handles subscribe/unsubscribe.
        return;
      }
      const response = await dispatch(this.options.controlPlaneApi, request);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(response));
      }
    });

    socket.on('close', () => {
      release?.();
    });
    socket.on('error', () => {
      release?.();
    });
  }
}
