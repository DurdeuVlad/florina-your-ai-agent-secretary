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
  mapCodexNotification,
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
  /**
   * Protocol generation mode: 'modern' (thread/turn), 'legacy' (codex.startTurn), or 'auto' (probe).
   * Defaults to 'auto'.
   */
  readonly protocolMode?: 'modern' | 'legacy' | 'auto';
  /**
   * Optional hook for responding to server approval requests (default: decline per DEC-011).
   */
  readonly permissionResponder?: (
    method: string,
    params: unknown,
  ) => Promise<'accept' | 'decline' | 'cancel' | null> | 'accept' | 'decline' | 'cancel' | null;
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
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Active thread id tracked for modern protocol turns. */
  private activeThreadId: string | null = null;
  /** Active turn id tracked for modern protocol turns. */
  private activeTurnId: string | null = null;
  /** Server metadata returned by the initialize handshake. */
  private serverInfo: { userAgent?: string; platformOs?: string } | null = null;
  /** Whether the connected app-server supports the modern thread/turn protocol. */
  private isModernProtocol: boolean | null = null;

  /** Internal queue of mapped SupervisorEvents awaiting consumption by streamEvents. */
  private eventQueue: SupervisorEvent[] = [];
  /** Resolve functions waiting for events in streamEvents. */
  private eventResolvers: Array<() => void> = [];
  /** Whether the stream has been marked complete (run finished / cancelled). */
  private streamComplete = false;

  constructor(bus?: EventPublisherPort | null, options?: CodexAdapterOptions) {
    super(CODEX_ADAPTER_ID, AdapterFidelityTier.A, bus);
    this.options = options ?? { endpoint: 'ws://127.0.0.1:0' };
    if (this.options.protocolMode === 'legacy') {
      this.isModernProtocol = false;
    } else if (this.options.protocolMode === 'modern') {
      this.isModernProtocol = true;
    }
  }

  /** Expose detected server metadata (userAgent, platform). */
  get serverMetadata(): { userAgent?: string; platformOs?: string } | null {
    return this.serverInfo;
  }

  /** Whether the connected app-server speaks the modern thread/turn protocol. */
  get isModern(): boolean | null {
    return this.isModernProtocol;
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

    // Attempt the modern initialize handshake if protocolMode allows it.
    if (this.options.protocolMode !== 'legacy') {
      try {
        const initTimeout = this.options.connectTimeoutMs ?? 5000;
        const initResult = (await this.sendRequest(
          'initialize',
          {
            clientInfo: { name: 'florina', version: '0.1.0' },
            capabilities: null,
          },
          initTimeout,
        )) as { userAgent?: string; platformOs?: string } | null;
        this.serverInfo = initResult;
        this.isModernProtocol = true;
        // Notify the server that initialization is complete per protocol specification
        try {
          this.transport?.send(
            JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }),
          );
        } catch {
          // Transport might be closed
        }
      } catch (err) {
        if (this.options.protocolMode === 'auto') {
          this.isModernProtocol = false;
        } else {
          // Modern mode explicitly requested; do not downgrade to legacy
          this.isModernProtocol = true;
          throw err;
        }
      }
    }
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.requireConnected();
    if (this.activeSession !== null) {
      throw new Error(
        `Codex adapter already has an active session: ${this.activeSession.sessionId}`,
      );
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

    void taskId; // taskId is carried in sessionConfig; kept for interface parity.

    // 1. Try modern thread/start + turn/start unless confirmed legacy.
    if (this.isModernProtocol !== false) {
      try {
        const threadResult = (await this.sendRequest('thread/start', {
          cwd: sessionConfig.workingDir,
          model: sessionConfig.model,
          approvalPolicy: 'on-request',
        })) as { thread?: { id?: string } } | null;
        const threadId = threadResult?.thread?.id ?? sessionConfig.sessionId;
        this.activeThreadId = threadId;

        const turnResult = (await this.sendRequest('turn/start', {
          threadId,
          input: [
            {
              type: 'text',
              text: sessionConfig.objective ?? '',
              text_elements: [],
            },
          ],
          cwd: sessionConfig.workingDir,
          model: sessionConfig.model,
        })) as { turn?: { id?: string } } | null;
        this.activeTurnId = turnResult?.turn?.id ?? null;
        this.isModernProtocol = true;
        return { sessionId: sessionConfig.sessionId, started: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isMethodNotFound =
          msg.includes('-32601') ||
          msg.includes('unknown variant') ||
          msg.includes('Method not found') ||
          msg.includes('not recognized');
        if (!isMethodNotFound || this.options.protocolMode === 'modern') {
          throw err;
        }
        // Fall back to legacy codex.startTurn
        this.isModernProtocol = false;
      }
    }

    // 2. Legacy fallback: send codex.startTurn
    try {
      const result = await this.sendRequest('codex.startTurn', {
        threadId: sessionConfig.sessionId,
        objective: sessionConfig.objective,
        workingDir: sessionConfig.workingDir,
        model: sessionConfig.model,
      });
      this.activeThreadId = sessionConfig.sessionId;
      const started = result !== null;
      return { sessionId: sessionConfig.sessionId, started };
    } catch (legacyErr) {
      throw new Error(
        `Codex app-server rejected both thread/start and codex.startTurn protocol generations: ${
          legacyErr instanceof Error ? legacyErr.message : String(legacyErr)
        }`,
      );
    }
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
    // Send cancel request as fire-and-forget.
    if (this.transport) {
      const id = this.nextRequestId++;
      if (this.isModernProtocol && this.activeThreadId) {
        const request: JsonRpcRequest = {
          jsonrpc: '2.0',
          id,
          method: 'turn/interrupt',
          params: {
            threadId: this.activeThreadId,
            turnId: this.activeTurnId ?? '',
          },
        };
        try {
          this.transport.send(JSON.stringify(request));
        } catch {
          // Transport may already be closed; we still emit AgentStopped locally.
        }
      } else {
        const request: JsonRpcRequest = {
          jsonrpc: '2.0',
          id,
          method: 'codex.cancelTurn',
          params: { threadId: this.activeThreadId ?? sessionId },
        };
        try {
          this.transport.send(JSON.stringify(request));
        } catch {
          // Transport may already be closed; we still emit AgentStopped locally.
        }
      }
    }
    // If the server doesn't send a stopped event, emit one ourselves.
    if (!this.streamComplete && this.mapperCtx) {
      this.enqueueEvent({
        type: 'AgentStopped',
        timestamp: new Date().toISOString(),
        taskId: this.mapperCtx.taskId,
        sessionId: this.mapperCtx.sessionId,
        agentId: this.mapperCtx.agentId,
        adapterFidelityTier: this.mapperCtx.adapterFidelityTier,
        reason: 'user',
        details: 'Cancelled by Florina',
      });
      this.completeStream();
    }
    this.activeSession = null;
    this.activeThreadId = null;
    this.activeTurnId = null;
  }

  async disconnect(): Promise<void> {
    this.completeStream();
    this.activeSession = null;
    this.activeThreadId = null;
    this.activeTurnId = null;
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
    timeoutMs = 10000,
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
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`JSON-RPC request "${method}" (id=${id}) timed out`));
        }
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.transport!.send(JSON.stringify(request));
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
    try {
      const msg = parsed as Record<string, unknown>;
      if (msg['method'] !== undefined && msg['id'] !== undefined) {
        // JSON-RPC request from server (e.g. approval prompt).
        void this.handleServerRequest(msg as unknown as JsonRpcRequest);
      } else if (msg['method'] !== undefined && msg['id'] === undefined) {
        // JSON-RPC notification (streamed event).
        this.handleNotification(msg as unknown as JsonRpcNotification);
      } else if (msg['id'] !== undefined) {
        // JSON-RPC response (matches a pending request).
        this.handleResponse(msg as unknown as JsonRpcResponse);
      }
    } catch {
      // Ignore errors caused by corrupt message payloads.
    }
  }

  /**
   * Handle an incoming JSON-RPC request from the server (e.g. approval prompt).
   * Enqueues an ApprovalRequested event and responds per DEC-011 (decline by default).
   */
  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    if (this.activeSession && !this.streamComplete && this.mapperCtx) {
      const mapped = mapCodexNotification(request.method, request.params, this.mapperCtx);
      if (mapped) {
        this.enqueueEvent(mapped);
      }
    }

    const responder = this.options.permissionResponder;
    let decision: 'accept' | 'decline' | 'cancel' = 'decline';
    if (responder) {
      try {
        const choice = await responder(request.method, request.params);
        if (choice) {
          decision = choice;
        }
      } catch {
        decision = 'decline';
      }
    }

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: request.id,
      result: { decision },
    };
    try {
      this.transport?.send(JSON.stringify(response));
    } catch {
      // Transport may already be closed.
    }
  }

  /**
   * Handle a JSON-RPC notification: map the Codex event/notification to a
   * SupervisorEvent and enqueue it for streamEvents.
   */
  private handleNotification(notification: JsonRpcNotification): void {
    if (!this.activeSession || this.streamComplete || !this.mapperCtx) {
      return;
    }
    const mapped = mapCodexNotification(
      notification.method,
      notification.params,
      this.mapperCtx,
    );
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
    clearTimeout(pending.timer);
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
    // Reject all pending requests and clear timers.
    for (const [, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error(`Transport closed (code=${code}, reason=${reason})`));
    }
    this.pendingRequests.clear();
    // Update connection state to disconnected if not already disconnected.
    if (this.connectionState !== 'disconnected') {
      this.setConnectionState('disconnected');
    }
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
