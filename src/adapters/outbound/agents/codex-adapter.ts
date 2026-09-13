/**
 * Codex app-server JSON-RPC adapter — fidelity tier A (DEC-013, issue #10).
 *
 * Connects to a local Codex `app-server` instance via a WebSocket transport
 * speaking JSON-RPC 2.0. The adapter normalizes Codex thread/turn lifecycle
 * events, tool calls, file changes, test runs, and structured permission
 * requests into the canonical {@link SupervisorEvent} schema (DEC-019).
 *
 * Tier A is the highest fidelity tier: Codex exposes structured permission
 * requests (filesystem, network) with full DEC-010 fields, so the attention
 * engine can apply auto-approve policies for low-risk capabilities.
 *
 * Transport: WebSocket (`ws`). The endpoint is configurable via
 * {@link CodexAdapterOptions.endpoint}. For MVP we support a single
 * configurable endpoint; stdio transport can be added later behind the same
 * adapter interface.
 *
 * Lifecycle:
 * 1. `connect()` — open a WebSocket to the Codex app-server endpoint.
 * 2. `startRun(taskId, sessionConfig)` — send a `codex.startTurn` JSON-RPC
 *    request; the server begins streaming events.
 * 3. `streamEvents()` — async generator yielding normalized SupervisorEvents
 *    as Codex notifications arrive over the WebSocket.
 * 4. `cancel(sessionId)` — send `codex.cancelTurn`; the server emits
 *    `thread.stopped` which maps to `AgentStopped`.
 * 5. `disconnect()` — close the WebSocket.
 */
import type { WebSocket as WsWebSocket } from 'ws';

import { AdapterFidelityTier } from '../../../core/domain/enums.js';
import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { EventPublisherPort } from '../../../core/application/ports/outbound/event-stream.js';
import { BaseAdapter, type SessionConfig, type StartRunResult } from './base.js';
import {
  mapCodexEvent,
  isCodexEvent,
  type CodexEvent,
  type MapperContext,
} from './codex-mapper.js';

/** Stable id for the Codex adapter. */
export const CODEX_ADAPTER_ID = 'codex';

/**
 * Configuration for the Codex adapter.
 */
export interface CodexAdapterOptions {
  /**
   * WebSocket endpoint of the local Codex app-server
   * (e.g. `ws://127.0.0.1:8080`). Required for WebSocket transport.
   */
  readonly endpoint: string;
  /**
   * Connection timeout in milliseconds. Defaults to 5000.
   */
  readonly connectTimeoutMs?: number;
}

/** JSON-RPC 2.0 request envelope (client → server). */
interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 notification envelope (server → client, no id). */
interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params: unknown;
}

/** JSON-RPC 2.0 response envelope (server → client, matches a request id). */
interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/**
 * A transport interface that the Codex adapter uses to communicate with the
 * app-server. This abstraction allows swapping WebSocket for stdio without
 * changing the adapter logic.
 */
export interface CodexTransport {
  /** Send a string message to the server. */
  send(data: string): void;
  /** Register a handler for incoming messages. */
  onMessage(handler: (data: string) => void): void;
  /** Register a handler for connection close. */
  onClose(handler: (code: number, reason: string) => void): void;
  /** Register a handler for connection errors. */
  onError(handler: (error: Error) => void): void;
  /** Close the transport connection. */
  close(): void;
}

/**
 * Codex app-server adapter (Tier A).
 *
 * Normalizes Codex JSON-RPC events into {@link SupervisorEvent}s and streams
 * them to the daemon. The adapter uses a pluggable {@link CodexTransport} so
 * the same logic works over WebSocket or stdio.
 */
export class CodexAdapter extends BaseAdapter {
  private readonly options: CodexAdapterOptions;
  private transport: CodexTransport | null = null;
  private activeSession: SessionConfig | null = null;
  private mapperCtx: MapperContext | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  /** Internal queue of mapped SupervisorEvents awaiting consumption by streamEvents. */
  private eventQueue: SupervisorEvent[] = [];
  /** Resolve functions waiting for events in streamEvents. */
  private eventResolvers: Array<() => void> = [];
  /** Whether the stream has been marked complete (run finished / cancelled). */
  private streamComplete = false;

  constructor(bus?: EventPublisherPort | null, options?: CodexAdapterOptions) {
    super(CODEX_ADAPTER_ID, AdapterFidelityTier.A, bus);
    this.options = options ?? { endpoint: 'ws://127.0.0.1:0' };
  }

  async connect(): Promise<void> {
    this.setConnectionState('connecting');
    // Lazy-import ws to avoid a hard dependency at type-check time in
    // environments that only use the stub adapter.
    const wsModule = await import('ws');
    const WebSocketImpl = wsModule.WebSocket;
    const ws: WsWebSocket = new WebSocketImpl(this.options.endpoint);
    this.transport = this.createWebSocketTransport(ws);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Codex app-server connection timed out at ${this.options.endpoint}`));
      }, this.options.connectTimeoutMs ?? 5000);

      ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to connect to Codex app-server: ${err.message}`));
      });
    });

    this.setConnectionState('connected');
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.requireConnected();
    if (this.activeSession !== null) {
      throw new Error(`Codex adapter already has an active session: ${this.activeSession.sessionId}`);
    }
    this.activeSession = sessionConfig;
    this.streamComplete = false;
    this.eventQueue = [];
    this.mapperCtx = {
      taskId: sessionConfig.taskId,
      sessionId: sessionConfig.sessionId,
      agentId: sessionConfig.agentId,
      adapterFidelityTier: this.fidelityTier,
      objective: sessionConfig.objective,
      workingDir: sessionConfig.workingDir,
    };

    // Send the startTurn JSON-RPC request to the Codex app-server.
    const result = await this.sendRequest('codex.startTurn', {
      threadId: sessionConfig.sessionId,
      objective: sessionConfig.objective,
      workingDir: sessionConfig.workingDir,
      model: sessionConfig.model,
    });

    void taskId; // taskId is carried in sessionConfig; kept for interface parity.
    const started = result !== null;
    return { sessionId: sessionConfig.sessionId, started };
  }

  async *streamEvents(): AsyncIterable<SupervisorEvent> {
    this.requireConnected();
    if (this.mapperCtx === null) {
      return;
    }

    while (!this.streamComplete || this.eventQueue.length > 0) {
      if (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()!;
        this.emitEvent(event);
        yield event;
      } else {
        // Wait for the next event or stream completion.
        await new Promise<void>((resolve) => {
          this.eventResolvers.push(resolve);
        });
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.activeSession?.sessionId !== sessionId) {
      return;
    }
    // Send the cancelTurn request as fire-and-forget. We don't block on the
    // response because the server may be unresponsive; we emit AgentStopped
    // locally regardless. If the server does respond with thread.stopped,
    // handleNotification will map it (but completeStream below prevents
    // duplicate emission).
    if (this.transport) {
      const id = this.nextRequestId++;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method: 'codex.cancelTurn',
        params: { threadId: sessionId },
      };
      try {
        this.transport.send(JSON.stringify(request));
      } catch {
        // Transport may already be closed; we still emit AgentStopped locally.
      }
    }
    // If the server doesn't send a thread.stopped, emit one ourselves.
    if (!this.streamComplete && this.mapperCtx) {
      this.enqueueEvent({
        type: 'AgentStopped',
        timestamp: new Date().toISOString(),
        taskId: this.mapperCtx.taskId,
        sessionId: this.mapperCtx.sessionId,
        agentId: this.mapperCtx.agentId,
        adapterFidelityTier: this.mapperCtx.adapterFidelityTier,
        reason: 'user',
        details: 'Cancelled by secretary',
      });
      this.completeStream();
    }
    this.activeSession = null;
  }

  async disconnect(): Promise<void> {
    this.completeStream();
    this.activeSession = null;
    this.mapperCtx = null;
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
    if (this.connectionState !== 'disconnected') {
      this.setConnectionState('disconnected');
    }
  }

  /* ---------------------------------------------------------------- *
   * Internal: transport wiring
   * ---------------------------------------------------------------- */

  /**
   * Wrap a `ws` WebSocket instance into a {@link CodexTransport}.
   * Exposed as a method so tests can inject a mock transport.
   */
  protected createWebSocketTransport(ws: WsWebSocket): CodexTransport {
    const transport = new WebSocketTransport(ws);
    transport.onMessage((data) => this.handleMessage(data));
    transport.onClose((code, reason) => this.handleClose(code, reason));
    transport.onError((err) => this.handleError(err));
    return transport;
  }

  /**
   * Set an explicit transport (used by tests to inject a mock without
   * opening a real WebSocket).
   */
  setTransport(transport: CodexTransport): void {
    this.transport = transport;
    transport.onMessage((data) => this.handleMessage(data));
    transport.onClose((code, reason) => this.handleClose(code, reason));
    transport.onError((err) => this.handleError(err));
    // When a transport is injected directly, we are effectively connected.
    if (this.connectionState === 'disconnected' || this.connectionState === 'connecting') {
      this.setConnectionState('connecting');
      this.setConnectionState('connected');
    }
  }

  /* ---------------------------------------------------------------- *
   * Internal: JSON-RPC message handling
   * ---------------------------------------------------------------- */

  /**
   * Send a JSON-RPC request and await the response. Returns the `result`
   * field, or `null` if the server returns an empty result.
   */
  private sendRequest(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.transport) {
      return Promise.reject(new Error('Codex adapter has no transport'));
    }
    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    };
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.transport!.send(JSON.stringify(request));
      // Timeout: reject if no response within 10s.
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`JSON-RPC request "${method}" (id=${id}) timed out`));
        }
      }, 10000);
    });
  }

  /**
   * Handle an incoming raw message string from the transport. Parses it as
   * JSON and dispatches to the notification or response handler.
   */
  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Ignore malformed messages.
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const msg = parsed as Record<string, unknown>;
    if (msg['method'] !== undefined && msg['id'] === undefined) {
      // JSON-RPC notification (streamed event).
      this.handleNotification(msg as unknown as JsonRpcNotification);
    } else if (msg['id'] !== undefined) {
      // JSON-RPC response (matches a pending request).
      this.handleResponse(msg as unknown as JsonRpcResponse);
    }
  }

  /**
   * Handle a JSON-RPC notification: map the Codex event to a
   * SupervisorEvent and enqueue it for streamEvents.
   */
  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'codex.event') {
      return;
    }
    const event = notification.params;
    if (!isCodexEvent(event)) {
      return;
    }
    if (!this.mapperCtx) {
      return;
    }
    const mapped = mapCodexEvent(event as CodexEvent, this.mapperCtx);
    if (mapped) {
      this.enqueueEvent(mapped);
      // Terminal events complete the stream.
      if (
        mapped.type === 'AgentCompleted' ||
        mapped.type === 'AgentFailed' ||
        mapped.type === 'AgentStopped'
      ) {
        this.completeStream();
      }
    }
  }

  /**
   * Handle a JSON-RPC response: resolve or reject the matching pending
   * request.
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result ?? null);
    }
  }

  /**
   * Handle unexpected transport closure.
   */
  private handleClose(code: number, reason: string): void {
    // Reject all pending requests.
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error(`Transport closed (code=${code}, reason=${reason})`));
    }
    this.pendingRequests.clear();
    // If the stream is not yet complete, emit a failure event.
    if (!this.streamComplete && this.mapperCtx && this.activeSession) {
      this.enqueueEvent({
        type: 'AgentFailed',
        timestamp: new Date().toISOString(),
        taskId: this.mapperCtx.taskId,
        sessionId: this.mapperCtx.sessionId,
        agentId: this.mapperCtx.agentId,
        adapterFidelityTier: this.mapperCtx.adapterFidelityTier,
        error: `Codex app-server connection closed unexpectedly (code=${code})`,
        recoverable: true,
      });
      this.completeStream();
      this.activeSession = null;
    }
  }

  /**
   * Handle a transport error.
   */
  private handleError(_error: Error): void {
    // Errors are also surfaced via handleClose in most cases.
    // Nothing additional to do here; the close handler covers recovery.
  }

  /* ---------------------------------------------------------------- *
   * Internal: event queue management
   * ---------------------------------------------------------------- */

  /**
   * Enqueue a mapped SupervisorEvent and wake up any waiting streamEvents
   * consumer.
   */
  private enqueueEvent(event: SupervisorEvent): void {
    this.eventQueue.push(event);
    const resolver = this.eventResolvers.shift();
    if (resolver) {
      resolver();
    }
  }

  /**
   * Mark the stream as complete and wake up any waiting consumers so they
   * can exit their loop.
   */
  private completeStream(): void {
    this.streamComplete = true;
    // Wake up all waiting consumers.
    while (this.eventResolvers.length > 0) {
      const resolver = this.eventResolvers.shift()!;
      resolver();
    }
  }
}

/* ------------------------------------------------------------------ *
 * WebSocket transport implementation
 * ------------------------------------------------------------------ */

/**
 * A {@link CodexTransport} backed by a `ws` WebSocket instance.
 */
export class WebSocketTransport implements CodexTransport {
  private readonly ws: WsWebSocket;

  constructor(ws: WsWebSocket) {
    this.ws = ws;
  }

  send(data: string): void {
    this.ws.send(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.ws.on('message', (data: unknown) => {
      let str: string;
      if (typeof data === 'string') {
        str = data;
      } else if (data instanceof Buffer) {
        str = data.toString('utf8');
      } else if (data instanceof ArrayBuffer) {
        str = Buffer.from(data).toString('utf8');
      } else if (Array.isArray(data)) {
        str = Buffer.concat(data as readonly Uint8Array[]).toString('utf8');
      } else {
        str = String(data);
      }
      handler(str);
    });
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.ws.on('close', (code: number, reason: Buffer) => {
      handler(code, reason.toString('utf8'));
    });
  }

  onError(handler: (error: Error) => void): void {
    this.ws.on('error', handler);
  }

  close(): void {
    this.ws.close();
  }
}
