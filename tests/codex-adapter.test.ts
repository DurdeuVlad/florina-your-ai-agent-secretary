import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { AdapterFidelityTier } from '../src/domain/enums.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import { validateEvent } from '../src/domain/events.js';
import { CapabilityType } from '../src/domain/capabilities.js';

import {
  CodexAdapter,
  CODEX_ADAPTER_ID,
  type CodexAdapterOptions,
  type CodexTransport,
  type SessionConfig,
} from '../src/adapters/index.js';
import {
  mapCodexEvent,
  mapPermissionRequest,
  isCodexEvent,
  mapModernTurnStarted,
  mapModernTurnCompleted,
  mapModernItemStarted,
  mapModernItemCompleted,
  mapModernMessageDelta,
  mapCommandExecutionApproval,
  mapFileChangeApproval,
  mapPermissionsApproval,
  mapCodexNotification,
  type CodexEvent,
  type CodexPermissionRequestEvent,
  type MapperContext,
} from '../src/adapters/codex-mapper.js';

/* ------------------------------------------------------------------ *
 * Mock Codex app-server (speaks JSON-RPC 2.0 over WebSocket)
 * ------------------------------------------------------------------ */

/** A scripted sequence of Codex events to stream to the client. */
type ScriptedEvent = CodexEvent;

interface MockServerOptions {
  /** Port to listen on. 0 = ephemeral. */
  readonly port?: number;
  /** Events to stream after a `codex.startTurn` request. */
  readonly events?: ScriptedEvent[];
  /** Whether to send `thread.stopped` on `codex.cancelTurn`. */
  readonly emitStopOnCancel?: boolean;
}

/**
 * A minimal mock Codex app-server that speaks JSON-RPC 2.0 over WebSocket.
 *
 * On `codex.startTurn` it responds with a success result and then streams
 * the scripted events as `codex.event` notifications. On `codex.cancelTurn`
 * it responds with success and (optionally) emits a `thread.stopped` event.
 */
class MockCodexServer {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  readonly events: ScriptedEvent[];
  readonly emitStopOnCancel: boolean;
  readonly port: number;

  constructor(options: MockServerOptions = {}) {
    this.events = options.events ? [...options.events] : [];
    this.emitStopOnCancel = options.emitStopOnCancel ?? true;
    this.port = options.port ?? 0;
    this.wss = new WebSocketServer({ port: this.port });
  }

  /** Start listening and return the actual port. */
  async start(): Promise<number> {
    const actualPort =
      this.wss.address() instanceof Object
        ? (this.wss.address() as { port: number }).port
        : this.port;
    return Promise.resolve(actualPort);
  }

  /** Get the actual port the server is listening on. */
  get actualPort(): number {
    return this.wss.address() instanceof Object
      ? (this.wss.address() as { port: number }).port
      : this.port;
  }

  /** Get the WebSocket URL the server is listening on. */
  get url(): string {
    return `ws://127.0.0.1:${this.actualPort}`;
  }

  /** Stop the server and close all connections. */
  async close(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  /**
   * Send a JSON-RPC notification to the connected client.
   */
  sendNotification(method: string, params: unknown): void {
    if (!this.client || this.client.readyState !== this.client.OPEN) {
      return;
    }
    const notification = { jsonrpc: '2.0', method, params };
    this.client.send(JSON.stringify(notification));
  }

  /**
   * Send a Codex event as a `codex.event` notification.
   */
  sendCodexEvent(event: CodexEvent): void {
    this.sendNotification('codex.event', event);
  }

  /**
   * Wire up the connection handler. Must be called before the client
   * connects.
   */
  setupHandlers(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.client = ws;
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const str =
          data instanceof Buffer
            ? data.toString('utf8')
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString('utf8')
              : Buffer.concat(data).toString('utf8');
        this.handleMessage(ws, str);
      });
    });
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const msg = parsed as Record<string, unknown>;
    const id = msg['id'];
    const method = msg['method'];

    if (method === 'initialize') {
      this.sendResponse(ws, id, {
        userAgent: 'codex/0.1.0',
        platformOs: 'windows',
        platformFamily: 'windows',
        codexHome: '/codex',
      });
    } else if (method === 'thread/start') {
      this.sendResponse(ws, id, {
        thread: {
          id: (msg['params'] as Record<string, unknown>)?.['threadId'] ?? 'sess-codex-1',
        },
      });
    } else if (method === 'turn/start') {
      this.sendResponse(ws, id, {
        turn: { id: 'turn-1' },
      });
      // Stream the scripted events.
      for (const event of this.events) {
        this.sendCodexEvent(event);
      }
    } else if (method === 'turn/interrupt') {
      this.sendResponse(ws, id, { cancelled: true });
      if (this.emitStopOnCancel) {
        const threadId = (msg['params'] as Record<string, unknown>)?.['threadId'] as string;
        this.sendCodexEvent({
          type: 'thread.stopped',
          threadId: threadId ?? 'sess-codex-1',
          turnId: 'turn-1',
          reason: 'user',
          details: 'Cancelled by client',
        });
      }
    } else if (method === 'codex.startTurn') {
      // Respond with success.
      this.sendResponse(ws, id, {
        threadId: (msg['params'] as Record<string, unknown>)?.['threadId'],
      });
      // Stream the scripted events.
      for (const event of this.events) {
        this.sendCodexEvent(event);
      }
    } else if (method === 'codex.cancelTurn') {
      // Respond with success.
      this.sendResponse(ws, id, { cancelled: true });
      // Optionally emit a thread.stopped event.
      if (this.emitStopOnCancel) {
        const threadId = (msg['params'] as Record<string, unknown>)?.['threadId'] as string;
        this.sendCodexEvent({
          type: 'thread.stopped',
          threadId,
          turnId: 'turn-1',
          reason: 'user',
          details: 'Cancelled by client',
        });
      }
    } else {
      this.sendError(ws, id, -32601, `unknown variant ${method}`);
    }
  }

  private sendResponse(ws: WebSocket, id: unknown, result: unknown): void {
    const response = { jsonrpc: '2.0', id, result };
    ws.send(JSON.stringify(response));
  }

  private sendError(ws: WebSocket, id: unknown, code: number, message: string): void {
    const response = { jsonrpc: '2.0', id, error: { code, message } };
    ws.send(JSON.stringify(response));
  }
}

/* ------------------------------------------------------------------ *
 * Mock transport (no real WebSocket needed)
 * ------------------------------------------------------------------ */

/**
 * An in-memory transport that directly connects to a MockCodexServer
 * without opening a real WebSocket. Useful for unit tests that don't need
 * the full WebSocket round-trip.
 */
class MockTransport implements CodexTransport {
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private readonly sentMessages: string[] = [];

  send(data: string): void {
    this.sentMessages.push(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  close(): void {
    if (this.closeHandler) {
      this.closeHandler(1000, 'normal closure');
    }
  }

  /** Simulate receiving a message from the server. */
  receive(data: string): void {
    if (this.messageHandler) {
      this.messageHandler(data);
    }
  }

  /** Simulate a transport error. */
  error(err: Error): void {
    if (this.errorHandler) {
      this.errorHandler(err);
    }
  }

  /** Get all messages sent by the adapter to the server. */
  get sent(): readonly string[] {
    return this.sentMessages;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A minimal valid SessionConfig for Codex runs. */
function sampleSessionConfig(): SessionConfig {
  return {
    taskId: 'task-codex-1',
    sessionId: 'sess-codex-1',
    agentId: 'codex',
    workingDir: '/repo/codex',
    objective: 'Fix the pagination bug',
    model: 'gpt-5',
  };
}

/** Build a MapperContext matching the sample session config. */
function sampleMapperCtx(): MapperContext {
  return {
    taskId: 'task-codex-1',
    sessionId: 'sess-codex-1',
    agentId: 'codex',
    adapterFidelityTier: AdapterFidelityTier.A,
    objective: 'Fix the pagination bug',
    workingDir: '/repo/codex',
  };
}

/** Collect all events from an async iterable into an array. */
async function collectEvents(iter: AsyncIterable<SupervisorEvent>): Promise<SupervisorEvent[]> {
  const events: SupervisorEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

/** A full scripted Codex event sequence covering all mapped variants. */
function fullEventSequence(): CodexEvent[] {
  return [
    {
      type: 'thread.started',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      objective: 'Fix the pagination bug',
      workingDir: '/repo/codex',
      model: 'gpt-5',
    },
    {
      type: 'thread.progress',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      message: 'Analyzing repository structure',
      step: 1,
      totalSteps: 5,
    },
    {
      type: 'tool.started',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      toolName: 'shell',
      args: { cmd: 'grep -r "pagination" src/' },
    },
    {
      type: 'tool.finished',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      toolName: 'shell',
      success: true,
      durationMs: 120,
      result: { stdout: 'src/api/invoices.ts:42: pagination' },
    },
    {
      type: 'file.changed',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      path: 'src/api/invoices.ts',
      changeType: 'modified',
      additions: 15,
      deletions: 3,
    },
    {
      type: 'permission.request',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      requestId: 'req-1',
      capability: 'network',
      destination: 'registry.npmjs.org',
      command: 'npm install',
      workingDir: '/repo/codex',
      scope: [{ type: 'network', targets: ['registry.npmjs.org'] }],
      riskLevel: 'low',
    },
    {
      type: 'test.started',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      framework: 'vitest',
      target: 'tests/invoices.test.ts',
      command: 'npm test',
    },
    {
      type: 'test.finished',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      framework: 'vitest',
      passed: 10,
      failed: 0,
      skipped: 1,
      durationMs: 2300,
    },
    {
      type: 'thread.completed',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      summary: 'Added cursor pagination to invoices API',
      deliverables: [{ type: 'commit', ref: 'abc123', summary: 'Fix pagination' }],
      exitCode: 0,
      durationMs: 45000,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 1. Mapper unit tests
 * ------------------------------------------------------------------ */
describe('Codex mapper', () => {
  const ctx = sampleMapperCtx();

  it('maps thread.started → AgentStarted', () => {
    const event: CodexEvent = {
      type: 'thread.started',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      objective: 'Fix the pagination bug',
      workingDir: '/repo/codex',
      model: 'gpt-5',
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('AgentStarted');
    expect(mapped.taskId).toBe('task-codex-1');
    expect(mapped.sessionId).toBe('sess-codex-1');
    expect(mapped.agentId).toBe('codex');
    expect(mapped.adapterFidelityTier).toBe('A');
    if (mapped.type === 'AgentStarted') {
      expect(mapped.objective).toBe('Fix the pagination bug');
      expect(mapped.workingDir).toBe('/repo/codex');
      expect(mapped.model).toBe('gpt-5');
    }
  });

  it('maps thread.progress → AgentProgress', () => {
    const event: CodexEvent = {
      type: 'thread.progress',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      message: 'Analyzing',
      step: 2,
      totalSteps: 5,
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('AgentProgress');
    if (mapped.type === 'AgentProgress') {
      expect(mapped.message).toBe('Analyzing');
      expect(mapped.step).toBe(2);
      expect(mapped.totalSteps).toBe(5);
    }
  });

  it('maps thread.completed → AgentCompleted', () => {
    const event: CodexEvent = {
      type: 'thread.completed',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      summary: 'Done',
      deliverables: [{ type: 'commit', ref: 'abc', summary: 'work' }],
      exitCode: 0,
      durationMs: 1000,
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('AgentCompleted');
    if (mapped.type === 'AgentCompleted') {
      expect(mapped.summary).toBe('Done');
      expect(mapped.deliverables).toHaveLength(1);
      expect(mapped.deliverables[0].ref).toBe('abc');
      expect(mapped.exitCode).toBe(0);
      expect(mapped.durationMs).toBe(1000);
    }
  });

  it('maps thread.failed → AgentFailed', () => {
    const event: CodexEvent = {
      type: 'thread.failed',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      error: 'Non-zero exit',
      exitCode: 1,
      recoverable: true,
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('AgentFailed');
    if (mapped.type === 'AgentFailed') {
      expect(mapped.error).toBe('Non-zero exit');
      expect(mapped.exitCode).toBe(1);
      expect(mapped.recoverable).toBe(true);
    }
  });

  it('maps thread.stopped → AgentStopped', () => {
    const event: CodexEvent = {
      type: 'thread.stopped',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      reason: 'user',
      details: 'Cancelled',
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('AgentStopped');
    if (mapped.type === 'AgentStopped') {
      expect(mapped.reason).toBe('user');
      expect(mapped.details).toBe('Cancelled');
    }
  });

  it('maps tool.started → ToolStarted', () => {
    const event: CodexEvent = {
      type: 'tool.started',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      toolName: 'shell',
      args: { cmd: 'ls' },
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('ToolStarted');
    if (mapped.type === 'ToolStarted') {
      expect(mapped.toolName).toBe('shell');
      expect(mapped.args).toEqual({ cmd: 'ls' });
    }
  });

  it('maps tool.finished → ToolFinished', () => {
    const event: CodexEvent = {
      type: 'tool.finished',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      toolName: 'shell',
      success: true,
      durationMs: 50,
      result: { stdout: 'ok' },
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('ToolFinished');
    if (mapped.type === 'ToolFinished') {
      expect(mapped.toolName).toBe('shell');
      expect(mapped.success).toBe(true);
      expect(mapped.durationMs).toBe(50);
    }
  });

  it('maps file.changed → FileChanged', () => {
    const event: CodexEvent = {
      type: 'file.changed',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      path: 'src/foo.ts',
      changeType: 'modified',
      additions: 5,
      deletions: 2,
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('FileChanged');
    if (mapped.type === 'FileChanged') {
      expect(mapped.path).toBe('src/foo.ts');
      expect(mapped.changeType).toBe('modified');
      expect(mapped.additions).toBe(5);
      expect(mapped.deletions).toBe(2);
    }
  });

  it('maps test.started → TestStarted', () => {
    const event: CodexEvent = {
      type: 'test.started',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      framework: 'vitest',
      target: 'tests/foo.test.ts',
      command: 'npm test',
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('TestStarted');
    if (mapped.type === 'TestStarted') {
      expect(mapped.framework).toBe('vitest');
      expect(mapped.target).toBe('tests/foo.test.ts');
      expect(mapped.command).toBe('npm test');
    }
  });

  it('maps test.finished → TestFinished', () => {
    const event: CodexEvent = {
      type: 'test.finished',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      framework: 'vitest',
      passed: 5,
      failed: 1,
      skipped: 0,
      durationMs: 1000,
      failures: [{ name: 'test foo', message: 'assertion failed' }],
    };
    const mapped = mapCodexEvent(event, ctx)!;
    expect(mapped.type).toBe('TestFinished');
    if (mapped.type === 'TestFinished') {
      expect(mapped.passed).toBe(5);
      expect(mapped.failed).toBe(1);
      expect(mapped.skipped).toBe(0);
      expect(mapped.failures).toHaveLength(1);
      expect(mapped.failures![0].name).toBe('test foo');
    }
  });

  it('maps permission.request → ApprovalRequested with structured fields (DEC-010)', () => {
    const event: CodexPermissionRequestEvent = {
      type: 'permission.request',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      requestId: 'req-1',
      capability: 'network',
      destination: 'registry.npmjs.org',
      command: 'npm install',
      workingDir: '/repo/codex',
      scope: [{ type: 'network', targets: ['registry.npmjs.org'] }],
      riskLevel: 'low',
    };
    const mapped = mapPermissionRequest(event, ctx);
    expect(mapped.type).toBe('ApprovalRequested');
    if (mapped.type === 'ApprovalRequested') {
      // DEC-010: full structured fields
      expect(mapped.task).toBe('Fix the pagination bug');
      expect(mapped.agent).toBe('codex');
      expect(mapped.capability).toBe(CapabilityType.Network);
      expect(mapped.destination).toBe('registry.npmjs.org');
      expect(mapped.command).toBe('npm install');
      expect(mapped.workingDir).toBe('/repo/codex');
      expect(mapped.scope).toHaveLength(1);
      expect(mapped.scope[0].type).toBe(CapabilityType.Network);
      expect(mapped.scope[0].targets).toEqual(['registry.npmjs.org']);
      expect(mapped.riskLevel).toBe('low');
    }
  });

  it('maps filesystem permission.request → ApprovalRequested with filesystem capability', () => {
    const event: CodexPermissionRequestEvent = {
      type: 'permission.request',
      threadId: 'sess-codex-1',
      turnId: 'turn-1',
      requestId: 'req-2',
      capability: 'filesystem',
      destination: '/repo/codex/.env',
      command: 'write',
      workingDir: '/repo/codex',
      scope: [{ type: 'filesystem', targets: ['/repo/codex/.env'] }],
      riskLevel: 'high',
    };
    const mapped = mapPermissionRequest(event, ctx);
    expect(mapped.type).toBe('ApprovalRequested');
    if (mapped.type === 'ApprovalRequested') {
      expect(mapped.capability).toBe(CapabilityType.Filesystem);
      expect(mapped.destination).toBe('/repo/codex/.env');
      expect(mapped.scope[0].type).toBe(CapabilityType.Filesystem);
      expect(mapped.scope[0].targets).toEqual(['/repo/codex/.env']);
      expect(mapped.riskLevel).toBe('high');
    }
  });

  it('returns null for unrecognized event types', () => {
    const unknown = { type: 'unknown.event', threadId: 'x', turnId: 'y' } as unknown as CodexEvent;
    const mapped = mapCodexEvent(unknown, ctx);
    expect(mapped).toBeNull();
  });

  it('isCodexEvent recognizes valid events and rejects invalid ones', () => {
    expect(isCodexEvent({ type: 'thread.started', threadId: 'x', turnId: 'y' })).toBe(true);
    expect(isCodexEvent({ type: 'unknown', threadId: 'x', turnId: 'y' })).toBe(false);
    expect(isCodexEvent(null)).toBe(false);
    expect(isCodexEvent('not-an-object')).toBe(false);
    expect(isCodexEvent([])).toBe(false);
  });

  it('produces events that pass validateEvent', () => {
    for (const event of fullEventSequence()) {
      const mapped = mapCodexEvent(event, ctx)!;
      expect(() => validateEvent(mapped)).not.toThrow();
    }
  });

  it('maps modern turn/started -> AgentStarted', () => {
    const mapped = mapModernTurnStarted({ threadId: 'thread-1', turn: { id: 'turn-1' } }, ctx);
    expect(mapped.type).toBe('AgentStarted');
    expect(mapped.taskId).toBe('task-codex-1');
    expect(mapped.sessionId).toBe('sess-codex-1');
  });

  it('maps modern turn/completed with status completed -> AgentCompleted', () => {
    const mapped = mapModernTurnCompleted(
      { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', durationMs: 2500 } },
      ctx,
    );
    expect(mapped.type).toBe('AgentCompleted');
    if (mapped.type === 'AgentCompleted') {
      expect(mapped.durationMs).toBe(2500);
    }
  });

  it('maps modern turn/completed with status failed -> AgentFailed', () => {
    const mapped = mapModernTurnCompleted(
      { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'Out of tokens' } } },
      ctx,
    );
    expect(mapped.type).toBe('AgentFailed');
    if (mapped.type === 'AgentFailed') {
      expect(mapped.error).toBe('Out of tokens');
      expect(mapped.recoverable).toBe(true);
    }
  });

  it('maps modern turn/completed with status interrupted -> AgentStopped', () => {
    const mapped = mapModernTurnCompleted(
      { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
      ctx,
    );
    expect(mapped.type).toBe('AgentStopped');
    if (mapped.type === 'AgentStopped') {
      expect(mapped.reason).toBe('user');
    }
  });

  it('maps modern item/started and item/completed for commandExecution -> ToolStarted / ToolFinished', () => {
    const started = mapModernItemStarted(
      {
        threadId: 't1',
        turnId: 'turn-1',
        item: { id: 'i1', type: 'commandExecution', command: 'pytest', cwd: '/repo/tests' },
      },
      ctx,
    )!;
    expect(started.type).toBe('ToolStarted');
    if (started.type === 'ToolStarted') {
      expect(started.toolName).toBe('shell');
      expect(started.args).toEqual({ command: 'pytest', cwd: '/repo/tests' });
    }

    const finished = mapModernItemCompleted(
      {
        threadId: 't1',
        turnId: 'turn-1',
        item: {
          id: 'i1',
          type: 'commandExecution',
          command: 'pytest',
          exitCode: 0,
          aggregatedOutput: '2 passed',
          durationMs: 120,
        },
      },
      ctx,
    )!;
    expect(finished.type).toBe('ToolFinished');
    if (finished.type === 'ToolFinished') {
      expect(finished.success).toBe(true);
      expect(finished.durationMs).toBe(120);
    }
  });

  it('maps modern item/started for plan and reasoning -> AgentProgress', () => {
    const plan = mapModernItemStarted(
      { threadId: 't1', turnId: 'turn-1', item: { id: 'i1', type: 'plan', text: 'Step 1: Check logs' } },
      ctx,
    )!;
    expect(plan.type).toBe('AgentProgress');
    if (plan.type === 'AgentProgress') {
      expect(plan.message).toBe('Step 1: Check logs');
    }

    const reasoning = mapModernItemStarted(
      { threadId: 't1', turnId: 'turn-1', item: { id: 'i2', type: 'reasoning', summary: ['Thinking about fix'] } },
      ctx,
    )!;
    expect(reasoning.type).toBe('AgentProgress');
    if (reasoning.type === 'AgentProgress') {
      expect(reasoning.message).toBe('Thinking about fix');
    }
  });

  it('maps modern item/agentMessage/delta -> AgentProgress', () => {
    const delta = mapModernMessageDelta({ threadId: 't1', turnId: 'turn-1', delta: 'Partial chunk' }, ctx);
    expect(delta.type).toBe('AgentProgress');
    if (delta.type === 'AgentProgress') {
      expect(delta.message).toBe('Partial chunk');
    }
  });

  it('maps modern approval requests with structured DEC-010 fields', () => {
    const cmdApproval = mapCommandExecutionApproval(
      { threadId: 't1', turnId: 'turn-1', itemId: 'i1', command: 'git checkout main', cwd: '/repo' },
      ctx,
    );
    expect(cmdApproval.type).toBe('ApprovalRequested');
    if (cmdApproval.type === 'ApprovalRequested') {
      expect(cmdApproval.capability).toBe(CapabilityType.Shell);
      expect(cmdApproval.command).toBe('git checkout main');
      expect(cmdApproval.riskLevel).toBe('high');
    }

    const patchApproval = mapFileChangeApproval(
      {
        threadId: 't1',
        turnId: 'turn-1',
        itemId: 'i2',
        changes: [{ path: 'package.json', kind: 'modify', diff: '...' }],
      },
      ctx,
    );
    expect(patchApproval.type).toBe('ApprovalRequested');
    if (patchApproval.type === 'ApprovalRequested') {
      expect(patchApproval.capability).toBe(CapabilityType.Filesystem);
      expect(patchApproval.destination).toBe('package.json');
    }

    const permApproval = mapPermissionsApproval(
      { threadId: 't1', turnId: 'turn-1', itemId: 'i3', reason: 'Access to camera' },
      ctx,
    );
    expect(permApproval.type).toBe('ApprovalRequested');
    if (permApproval.type === 'ApprovalRequested') {
      expect(permApproval.destination).toBe('Access to camera');
    }
  });

  it('mapCodexNotification routes all modern and legacy variants', () => {
    expect(mapCodexNotification('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }, ctx)?.type).toBe(
      'AgentStarted',
    );
    expect(
      mapCodexNotification('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed' } }, ctx)
        ?.type,
    ).toBe('AgentCompleted');
    expect(
      mapCodexNotification(
        'codex.event',
        { type: 'thread.progress', threadId: 't1', turnId: 'turn-1', message: 'Hi' },
        ctx,
      )?.type,
    ).toBe('AgentProgress');
    expect(mapCodexNotification('unrecognized/method', {}, ctx)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2. CodexAdapter unit tests (mock transport)
 * ------------------------------------------------------------------ */
describe('CodexAdapter (mock transport)', () => {
  it('declares fidelity tier A', () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0' });
    expect(adapter.fidelityTier).toBe(AdapterFidelityTier.A);
    expect(adapter.id).toBe(CODEX_ADAPTER_ID);
  });

  it('connects via injected transport', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0' });
    const transport = new MockTransport();
    adapter.setTransport(transport);
    expect(adapter.connectionState).toBe('connected');
  });

  it('starts a run and streams mapped events', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'legacy' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const sessionConfig = sampleSessionConfig();
    // Start the run; the mock transport will receive the startTurn request.
    const startPromise = adapter.startRun('task-codex-1', sessionConfig);

    // Simulate the server responding to the startTurn request.
    const startMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: startMsg.id, result: { threadId: 'sess-codex-1' } }),
    );

    const startResult = await startPromise;
    expect(startResult.started).toBe(true);
    expect(startResult.sessionId).toBe('sess-codex-1');

    // Simulate the server streaming events.
    const streaming = collectEvents(adapter.streamEvents());
    for (const event of fullEventSequence()) {
      transport.receive(JSON.stringify({ jsonrpc: '2.0', method: 'codex.event', params: event }));
    }
    const events = await streaming;

    // Should have mapped all 9 events (thread.started through thread.completed).
    expect(events).toHaveLength(9);
    expect(events[0].type).toBe('AgentStarted');
    expect(events[1].type).toBe('AgentProgress');
    expect(events[2].type).toBe('ToolStarted');
    expect(events[3].type).toBe('ToolFinished');
    expect(events[4].type).toBe('FileChanged');
    expect(events[5].type).toBe('ApprovalRequested');
    expect(events[6].type).toBe('TestStarted');
    expect(events[7].type).toBe('TestFinished');
    expect(events[8].type).toBe('AgentCompleted');

    // All events should pass validation.
    for (const event of events) {
      expect(() => validateEvent(event)).not.toThrow();
    }

    await adapter.disconnect();
  });

  it('surfaces permission requests as ApprovalRequested with structured fields', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'legacy' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const sessionConfig = sampleSessionConfig();
    const startPromise = adapter.startRun('task-codex-1', sessionConfig);
    const startMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: startMsg.id, result: { threadId: 'sess-codex-1' } }),
    );
    await startPromise;

    const streaming = collectEvents(adapter.streamEvents());

    // Send a network permission request.
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'codex.event',
        params: {
          type: 'permission.request',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          requestId: 'req-net',
          capability: 'network',
          destination: 'api.github.com',
          command: 'git push',
          workingDir: '/repo/codex',
          scope: [{ type: 'network', targets: ['api.github.com'] }],
          riskLevel: 'medium',
        } satisfies CodexPermissionRequestEvent,
      }),
    );

    // Send a filesystem permission request.
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'codex.event',
        params: {
          type: 'permission.request',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          requestId: 'req-fs',
          capability: 'filesystem',
          destination: '/repo/codex/.env',
          command: 'write',
          workingDir: '/repo/codex',
          scope: [{ type: 'filesystem', targets: ['/repo/codex/.env'] }],
          riskLevel: 'high',
        } satisfies CodexPermissionRequestEvent,
      }),
    );

    // Complete the stream.
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'codex.event',
        params: {
          type: 'thread.completed',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          summary: 'Done',
          deliverables: [],
          exitCode: 0,
        },
      }),
    );

    const events = await streaming;
    const approvals = events.filter((e) => e.type === 'ApprovalRequested');
    expect(approvals).toHaveLength(2);

    const netApproval = approvals[0];
    expect(netApproval.type).toBe('ApprovalRequested');
    if (netApproval.type === 'ApprovalRequested') {
      expect(netApproval.capability).toBe(CapabilityType.Network);
      expect(netApproval.destination).toBe('api.github.com');
      expect(netApproval.command).toBe('git push');
      expect(netApproval.scope[0].type).toBe(CapabilityType.Network);
      expect(netApproval.scope[0].targets).toEqual(['api.github.com']);
      expect(netApproval.riskLevel).toBe('medium');
    }

    const fsApproval = approvals[1];
    if (fsApproval.type === 'ApprovalRequested') {
      expect(fsApproval.capability).toBe(CapabilityType.Filesystem);
      expect(fsApproval.destination).toBe('/repo/codex/.env');
      expect(fsApproval.scope[0].type).toBe(CapabilityType.Filesystem);
      expect(fsApproval.riskLevel).toBe('high');
    }

    await adapter.disconnect();
  });

  it('cancel stops the run and emits AgentStopped', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'legacy' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const sessionConfig = sampleSessionConfig();
    const startPromise = adapter.startRun('task-codex-1', sessionConfig);
    const startMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: startMsg.id, result: { threadId: 'sess-codex-1' } }),
    );
    await startPromise;

    const streaming = collectEvents(adapter.streamEvents());

    // Send a progress event so the stream is active.
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'codex.event',
        params: {
          type: 'thread.progress',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          message: 'Working...',
        },
      }),
    );

    // Cancel the run. The adapter sends a cancelTurn request (fire-and-forget)
    // and emits AgentStopped locally without waiting for the server.
    const cancelPromise = adapter.cancel('sess-codex-1');

    // Verify the cancelTurn request was sent.
    const cancelMsg = JSON.parse(transport.sent[1]);
    expect(cancelMsg.method).toBe('codex.cancelTurn');

    await cancelPromise;
    const events = await streaming;

    const stopped = events.filter((e) => e.type === 'AgentStopped');
    expect(stopped).toHaveLength(1);
    if (stopped[0].type === 'AgentStopped') {
      expect(stopped[0].reason).toBe('user');
    }

    await adapter.disconnect();
  });

  it('cancel emits AgentStopped even if server does not respond', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'legacy' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const sessionConfig = sampleSessionConfig();
    const startPromise = adapter.startRun('task-codex-1', sessionConfig);
    const startMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: startMsg.id, result: { threadId: 'sess-codex-1' } }),
    );
    await startPromise;

    const streaming = collectEvents(adapter.streamEvents());

    // Cancel without simulating any server response.
    // Use a short delay to let the streamEvents generator start waiting.
    const cancelPromise = adapter.cancel('sess-codex-1');
    await cancelPromise;

    const events = await streaming;
    const stopped = events.filter((e) => e.type === 'AgentStopped');
    expect(stopped).toHaveLength(1);
    if (stopped[0].type === 'AgentStopped') {
      expect(stopped[0].reason).toBe('user');
    }

    await adapter.disconnect();
  });

  it('emits AgentFailed when transport closes unexpectedly', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'legacy' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const sessionConfig = sampleSessionConfig();
    const startPromise = adapter.startRun('task-codex-1', sessionConfig);
    const startMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: startMsg.id, result: { threadId: 'sess-codex-1' } }),
    );
    await startPromise;

    const streaming = collectEvents(adapter.streamEvents());

    // Simulate unexpected transport closure.
    transport.close();

    const events = await streaming;
    const failed = events.filter((e) => e.type === 'AgentFailed');
    expect(failed).toHaveLength(1);
    if (failed[0].type === 'AgentFailed') {
      expect(failed[0].recoverable).toBe(true);
    }

    await adapter.disconnect();
  });

  it('throws when startRun is called before connect', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'legacy' });
    await expect(adapter.startRun('task-1', sampleSessionConfig())).rejects.toThrow();
  });

  it('throws when startRun is called with an active session', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'legacy' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const sessionConfig = sampleSessionConfig();
    const startPromise = adapter.startRun('task-codex-1', sessionConfig);
    const startMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: startMsg.id, result: { threadId: 'sess-codex-1' } }),
    );
    await startPromise;

    await expect(adapter.startRun('task-codex-1', sessionConfig)).rejects.toThrow();
    await adapter.disconnect();
  });

  it('starts a run with modern thread/start and turn/start', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'modern' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const sessionConfig = sampleSessionConfig();
    const startPromise = adapter.startRun('task-codex-1', sessionConfig);

    // 1. Server receives thread/start
    expect(transport.sent).toHaveLength(1);
    const threadStartMsg = JSON.parse(transport.sent[0]);
    expect(threadStartMsg.method).toBe('thread/start');
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: threadStartMsg.id, result: { thread: { id: 'thread-777' } } }),
    );

    // Wait a tick so startRun proceeds to turn/start
    await new Promise((r) => setTimeout(r, 10));

    // 2. Server receives turn/start
    expect(transport.sent).toHaveLength(2);
    const turnStartMsg = JSON.parse(transport.sent[1]);
    expect(turnStartMsg.method).toBe('turn/start');
    expect(turnStartMsg.params.threadId).toBe('thread-777');
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: turnStartMsg.id, result: { turn: { id: 'turn-888' } } }),
    );

    const startResult = await startPromise;
    expect(startResult.started).toBe(true);

    // 3. Stream modern notifications
    const streaming = collectEvents(adapter.streamEvents());
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/started',
        params: { threadId: 'thread-777', turn: { id: 'turn-888' } },
      }),
    );
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'item/started',
        params: {
          threadId: 'thread-777',
          turnId: 'turn-888',
          item: { id: 'item-1', type: 'commandExecution', command: 'git status', cwd: '/repo' },
        },
      }),
    );
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: 'thread-777', turn: { id: 'turn-888', status: 'completed' } },
      }),
    );

    const events = await streaming;
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('AgentStarted');
    expect(events[1].type).toBe('ToolStarted');
    expect(events[2].type).toBe('AgentCompleted');

    await adapter.disconnect();
  });

  it('cancel sends turn/interrupt for modern session', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'modern' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const startPromise = adapter.startRun('task-codex-1', sampleSessionConfig());
    const threadMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: threadMsg.id, result: { thread: { id: 'thread-999' } } }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const turnMsg = JSON.parse(transport.sent[1]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: turnMsg.id, result: { turn: { id: 'turn-999' } } }),
    );
    await startPromise;

    const streaming = collectEvents(adapter.streamEvents());
    await adapter.cancel('sess-codex-1');

    expect(transport.sent).toHaveLength(3);
    const cancelMsg = JSON.parse(transport.sent[2]);
    expect(cancelMsg.method).toBe('turn/interrupt');
    expect(cancelMsg.params.threadId).toBe('thread-999');
    expect(cancelMsg.params.turnId).toBe('turn-999');

    const events = await streaming;
    expect(events.some((e) => e.type === 'AgentStopped')).toBe(true);
    await adapter.disconnect();
  });

  it('handles server approval requests with decline and enqueues ApprovalRequested (DEC-011)', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'modern' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const startPromise = adapter.startRun('task-codex-1', sampleSessionConfig());
    const threadMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: threadMsg.id, result: { thread: { id: 't1' } } }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const turnMsg = JSON.parse(transport.sent[1]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: turnMsg.id, result: { turn: { id: 'turn-1' } } }),
    );
    await startPromise;

    const streaming = collectEvents(adapter.streamEvents());

    // Server sends an approval request (Server -> Client JSON-RPC request)
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 't1',
          turnId: 'turn-1',
          itemId: 'item-1',
          command: 'rm -rf /',
          cwd: '/repo',
        },
      }),
    );

    // Turn completes
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: 't1', turn: { id: 'turn-1', status: 'completed' } },
      }),
    );

    const events = await streaming;
    const approval = events.find((e) => e.type === 'ApprovalRequested');
    expect(approval).toBeDefined();

    // Check that adapter responded with decline per DEC-011
    const serverResponses = transport.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.id === 42);
    expect(serverResponses).toHaveLength(1);
    expect(serverResponses[0].result).toEqual({ decision: 'decline' });

    await adapter.disconnect();
  });

  it('handles server approval requests with custom permissionResponder', async () => {
    const adapter = new CodexAdapter(null, {
      endpoint: 'ws://127.0.0.1:0',
      protocolMode: 'modern',
      permissionResponder: async (method) => {
        if (method === 'item/commandExecution/requestApproval') return 'accept';
        return 'decline';
      },
    });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const startPromise = adapter.startRun('task-codex-1', sampleSessionConfig());
    const threadMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: threadMsg.id, result: { thread: { id: 't1' } } }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const turnMsg = JSON.parse(transport.sent[1]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: turnMsg.id, result: { turn: { id: 'turn-1' } } }),
    );
    await startPromise;

    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 't1',
          turnId: 'turn-1',
          itemId: 'item-1',
          command: 'npm test',
          cwd: '/repo',
        },
      }),
    );

    // Wait tick for responder promise
    await new Promise((r) => setTimeout(r, 10));

    const serverResponses = transport.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.id === 99);
    expect(serverResponses).toHaveLength(1);
    expect(serverResponses[0].result).toEqual({ decision: 'accept' });

    await adapter.disconnect();
  });

  it('protocolMode: auto falls back to codex.startTurn when thread/start receives -32601', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'auto' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const startPromise = adapter.startRun('task-codex-1', sampleSessionConfig());

    // Modern thread/start is sent first
    expect(transport.sent).toHaveLength(1);
    const req1 = JSON.parse(transport.sent[0]);
    expect(req1.method).toBe('thread/start');

    // Server responds with method not found (-32601)
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req1.id,
        error: { code: -32601, message: 'Method not found' },
      }),
    );

    // Wait tick for fallback to trigger
    await new Promise((r) => setTimeout(r, 10));

    // Adapter falls back to codex.startTurn
    expect(transport.sent).toHaveLength(2);
    const req2 = JSON.parse(transport.sent[1]);
    expect(req2.method).toBe('codex.startTurn');

    // Server responds to codex.startTurn
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req2.id,
        result: { threadId: 'sess-codex-1' },
      }),
    );

    const result = await startPromise;
    expect(result.started).toBe(true);
    await adapter.disconnect();
  });

  it('throws descriptive error when both thread/start and codex.startTurn fail', async () => {
    const adapter = new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0', protocolMode: 'auto' });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const startPromise = adapter.startRun('task-codex-1', sampleSessionConfig());

    const req1 = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req1.id,
        error: { code: -32601, message: 'Method not found' },
      }),
    );

    await new Promise((r) => setTimeout(r, 10));

    const req2 = JSON.parse(transport.sent[1]);
    transport.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req2.id,
        error: { code: -32601, message: 'codex.startTurn not found' },
      }),
    );

    await expect(startPromise).rejects.toThrow(/rejected both thread\/start and codex\.startTurn/);
    await adapter.disconnect();
  });
});

/* ------------------------------------------------------------------ *
 * 3. Integration test with a mock WebSocket Codex app-server
 * ------------------------------------------------------------------ */
describe('CodexAdapter integration (mock WebSocket app-server)', () => {
  let server: MockCodexServer;

  beforeEach(() => {
    server = new MockCodexServer({ events: fullEventSequence(), emitStopOnCancel: true });
    server.setupHandlers();
  });

  afterEach(async () => {
    await server.close();
  });

  it('connects to a mock Codex app-server over WebSocket', async () => {
    const port = await server.start();
    const options: CodexAdapterOptions = {
      endpoint: `ws://127.0.0.1:${port}`,
      connectTimeoutMs: 2000,
    };
    const adapter = new CodexAdapter(null, options);
    await adapter.connect();
    expect(adapter.connectionState).toBe('connected');
    await adapter.disconnect();
  });

  it('runs a full turn and streams all event variants', async () => {
    const port = await server.start();
    const adapter = new CodexAdapter(null, {
      endpoint: `ws://127.0.0.1:${port}`,
      connectTimeoutMs: 2000,
    });
    await adapter.connect();

    const sessionConfig = sampleSessionConfig();
    const result = await adapter.startRun('task-codex-1', sessionConfig);
    expect(result.started).toBe(true);

    const events = await collectEvents(adapter.streamEvents());

    // The full sequence has 9 events (thread.started through thread.completed).
    expect(events).toHaveLength(9);
    expect(events[0].type).toBe('AgentStarted');
    expect(events[events.length - 1].type).toBe('AgentCompleted');

    // Verify the full mapping chain.
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'AgentStarted',
      'AgentProgress',
      'ToolStarted',
      'ToolFinished',
      'FileChanged',
      'ApprovalRequested',
      'TestStarted',
      'TestFinished',
      'AgentCompleted',
    ]);

    // All events pass schema validation.
    for (const event of events) {
      expect(() => validateEvent(event)).not.toThrow();
    }

    // All events carry the correct envelope.
    for (const event of events) {
      expect(event.taskId).toBe('task-codex-1');
      expect(event.sessionId).toBe('sess-codex-1');
      expect(event.agentId).toBe('codex');
      expect(event.adapterFidelityTier).toBe('A');
    }

    await adapter.disconnect();
  });

  it('surfaces permission requests with structured DEC-010 fields', async () => {
    // Use a custom event sequence with permission requests.
    await server.close();
    server = new MockCodexServer({
      events: [
        {
          type: 'thread.started',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          objective: 'Fix the pagination bug',
          workingDir: '/repo/codex',
          model: 'gpt-5',
        },
        {
          type: 'permission.request',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          requestId: 'req-1',
          capability: 'network',
          destination: 'registry.npmjs.org',
          command: 'npm install',
          workingDir: '/repo/codex',
          scope: [{ type: 'network', targets: ['registry.npmjs.org'] }],
          riskLevel: 'low',
        },
        {
          type: 'permission.request',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          requestId: 'req-2',
          capability: 'filesystem',
          destination: '/repo/codex/secrets.env',
          command: 'write',
          workingDir: '/repo/codex',
          scope: [{ type: 'filesystem', targets: ['/repo/codex/secrets.env'] }],
          riskLevel: 'critical',
        },
        {
          type: 'thread.completed',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          summary: 'Done',
          deliverables: [],
          exitCode: 0,
        },
      ],
      emitStopOnCancel: true,
    });
    server.setupHandlers();
    const port = await server.start();

    const adapter = new CodexAdapter(null, {
      endpoint: `ws://127.0.0.1:${port}`,
      connectTimeoutMs: 2000,
    });
    await adapter.connect();

    await adapter.startRun('task-codex-1', sampleSessionConfig());
    const events = await collectEvents(adapter.streamEvents());

    const approvals = events.filter((e) => e.type === 'ApprovalRequested');
    expect(approvals).toHaveLength(2);

    // Network permission.
    if (approvals[0].type === 'ApprovalRequested') {
      expect(approvals[0].capability).toBe(CapabilityType.Network);
      expect(approvals[0].destination).toBe('registry.npmjs.org');
      expect(approvals[0].command).toBe('npm install');
      expect(approvals[0].scope).toHaveLength(1);
      expect(approvals[0].scope[0].type).toBe(CapabilityType.Network);
      expect(approvals[0].scope[0].targets).toEqual(['registry.npmjs.org']);
      expect(approvals[0].riskLevel).toBe('low');
      // DEC-010: task and agent are populated from the run context.
      expect(approvals[0].task).toBe('Fix the pagination bug');
      expect(approvals[0].agent).toBe('codex');
      expect(approvals[0].workingDir).toBe('/repo/codex');
    }

    // Filesystem permission.
    if (approvals[1].type === 'ApprovalRequested') {
      expect(approvals[1].capability).toBe(CapabilityType.Filesystem);
      expect(approvals[1].destination).toBe('/repo/codex/secrets.env');
      expect(approvals[1].riskLevel).toBe('critical');
      expect(approvals[1].scope[0].type).toBe(CapabilityType.Filesystem);
    }

    await adapter.disconnect();
  });

  it('cancel stops the run and emits AgentStopped', async () => {
    // Use a sequence that does NOT auto-complete (no terminal event).
    await server.close();
    server = new MockCodexServer({
      events: [
        {
          type: 'thread.started',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          objective: 'Fix the pagination bug',
          workingDir: '/repo/codex',
          model: 'gpt-5',
        },
        {
          type: 'thread.progress',
          threadId: 'sess-codex-1',
          turnId: 'turn-1',
          message: 'Working...',
          step: 1,
          totalSteps: 3,
        },
      ],
      emitStopOnCancel: true,
    });
    server.setupHandlers();
    const port = await server.start();

    const adapter = new CodexAdapter(null, {
      endpoint: `ws://127.0.0.1:${port}`,
      connectTimeoutMs: 2000,
    });
    await adapter.connect();

    await adapter.startRun('task-codex-1', sampleSessionConfig());

    // Start consuming events in the background.
    const streamingPromise = collectEvents(adapter.streamEvents());

    // Give the server a moment to stream the initial events.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Cancel the run.
    await adapter.cancel('sess-codex-1');

    const events = await streamingPromise;

    // Should have: AgentStarted, AgentProgress, AgentStopped.
    const stopped = events.filter((e) => e.type === 'AgentStopped');
    expect(stopped).toHaveLength(1);
    if (stopped[0].type === 'AgentStopped') {
      expect(stopped[0].reason).toBe('user');
    }

    await adapter.disconnect();
  });

  it('self-reports fidelity tier A', async () => {
    const port = await server.start();
    const adapter = new CodexAdapter(null, {
      endpoint: `ws://127.0.0.1:${port}`,
      connectTimeoutMs: 2000,
    });
    expect(adapter.fidelityTier).toBe('A');
    expect(adapter.fidelityTier).toBe(AdapterFidelityTier.A);
    await adapter.connect();
    expect(adapter.fidelityTier).toBe(AdapterFidelityTier.A);
    await adapter.disconnect();
  });
});
