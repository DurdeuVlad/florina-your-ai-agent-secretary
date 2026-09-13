/**
 * Generic ACP (Agent Client Protocol) adapter — fidelity tier C
 * (DEC-030, issue #61).
 *
 * One implementation drives every ACP-speaking provider CLI —
 * `devin acp`, `gemini --acp`, and any future agent that implements the
 * protocol — by parameterizing only the spawn command. ACP is JSON-RPC 2.0
 * over stdio (newline-delimited JSON).
 *
 * Protocol surface used:
 * - Client→Agent requests: `initialize`, `session/new`, `session/prompt`.
 * - Client→Agent notification: `session/cancel`.
 * - Agent→Client notifications: `session/update` (message chunks, tool
 *   calls, plan updates, usage).
 * - Agent→Client requests: `session/request_permission` — forwarded to a
 *   `permissionResponder` hook; default is `cancelled` (Tier C never
 *   silently approves without policy).
 * - Agent→Client `fs/*`/`terminal/*` requests are answered
 *   method-not-found: the daemon owns the worktree; the adapter does not
 *   grant implicit host access.
 *
 * Quota/usage: `usage_update` notifications map to `UsageReported`;
 * exhaustion surfaces as JSON-RPC errors or `AgentFailed`, which daemon
 * wiring feeds to {@link reportExhaustion} (issue #71).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { AdapterFidelityTier } from '../domain/enums.js';
import type { SupervisorEvent } from '../domain/events.js';
import type { EventBus } from '../daemon/event-stream.js';
import { BaseAdapter, type SessionConfig, type StartRunResult } from './base.js';

/* ------------------------------------------------------------------ *
 * Process seam — injectable for tests
 * ------------------------------------------------------------------ */

/** A line-oriented stdio process speaking ACP. */
export interface AcpProcess {
  /** Write one JSON-RPC message (a newline is appended by the process). */
  send(line: string): void;
  /** Register a handler for each incoming stdout line. */
  onLine(handler: (line: string) => void): void;
  /** Register a handler for process exit. */
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  /** Terminate the process. */
  kill(): void;
}

/** Spawns an ACP-speaking child process. */
export type AcpSpawner = (command: string, args: readonly string[], cwd: string) => AcpProcess;

/** Default spawner: child_process with newline-delimited stdout framing. */
export const nodeAcpSpawner: AcpSpawner = (command, args, cwd) => {
  const child: ChildProcess = spawn(command, [...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const rl = createInterface({ input: child.stdout! });
  return {
    send(line) {
      child.stdin!.write(line + '\n');
    },
    onLine(handler) {
      rl.on('line', handler);
    },
    onExit(handler) {
      child.on('exit', handler);
    },
    kill() {
      child.kill();
    },
  };
};

/* ------------------------------------------------------------------ *
 * Wire shapes (subset of the ACP schema we consume)
 * ------------------------------------------------------------------ */

interface JsonRpcRequestMsg {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationMsg {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponseMsg {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: { path?: string }[];
  rawInput?: unknown;
}

interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: AcpToolCall;
  options?: AcpPermissionOption[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * Adapter options
 * ------------------------------------------------------------------ */

/** How to resolve a `session/request_permission` from the agent. */
export type PermissionResponder = (
  request: AcpPermissionRequest,
) => Promise<{ optionId: string } | null>;

/** Options for {@link AcpAdapter}. */
export interface AcpAdapterOptions {
  /** Adapter id, matching the provider name (e.g. `devin`, `gemini`). */
  readonly id: string;
  /** Command to spawn (e.g. `devin`). */
  readonly command: string;
  /** Args putting the command into ACP mode (e.g. `['acp']`, `['--acp']`). */
  readonly args?: readonly string[];
  /** Injectable process spawner (tests substitute a fake). */
  readonly spawner?: AcpSpawner;
  /**
   * Resolve permission requests. Default: cancel — Tier C adapters never
   * silently approve (DEC-011); daemon wiring composes this with the
   * attention engine / scope grants (issue #67).
   */
  readonly permissionResponder?: PermissionResponder;
  /** Working directory to spawn the CLI in (defaults to process cwd). */
  readonly cwd?: string;
}

const ACP_PROTOCOL_VERSION = 1;

/**
 * Generic ACP adapter (Tier C).
 *
 * Normalizes `session/update` notifications into {@link SupervisorEvent}s.
 * Emits `ApprovalRequested` on `session/request_permission` and resolves it
 * through the configured {@link PermissionResponder}.
 */
export class AcpAdapter extends BaseAdapter {
  private readonly options: AcpAdapterOptions;
  private process: AcpProcess | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventQueue: SupervisorEvent[] = [];
  private eventResolvers: Array<() => void> = [];
  private streamComplete = false;
  private session: SessionConfig | null = null;
  private acpSessionId: string | null = null;

  constructor(bus: EventBus | null | undefined, options: AcpAdapterOptions) {
    super(options.id, AdapterFidelityTier.C, bus);
    this.options = options;
  }

  async connect(): Promise<void> {
    this.setConnectionState('connecting');
    const spawner = this.options.spawner ?? nodeAcpSpawner;
    this.process = spawner(
      this.options.command,
      this.options.args ?? [],
      this.options.cwd ?? process.cwd(),
    );
    this.process.onLine((line) => this.handleLine(line));
    this.process.onExit((code, signal) => this.handleExit(code, signal));
    await this.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    this.setConnectionState('connected');
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.requireConnected();
    this.session = sessionConfig;
    this.streamComplete = false;
    this.eventQueue = [];

    const created = (await this.request('session/new', {
      cwd: sessionConfig.workingDir,
      mcpServers: [],
    })) as { sessionId?: string } | null;
    this.acpSessionId = created?.sessionId ?? sessionConfig.sessionId;

    this.enqueue({
      type: 'AgentStarted',
      timestamp: new Date().toISOString(),
      taskId,
      sessionId: sessionConfig.sessionId,
      agentId: sessionConfig.agentId,
      adapterFidelityTier: this.fidelityTier,
      objective: sessionConfig.objective,
      workingDir: sessionConfig.workingDir,
      model: sessionConfig.model,
    });

    // Prompt is fire-and-forget for startRun: the run streams via
    // session/update; the prompt response resolves when the turn ends.
    void this.prompt(sessionConfig.objective).catch(() => {
      // Prompt failures are already turned into AgentFailed events.
    });
    return { sessionId: sessionConfig.sessionId, started: true };
  }

  /** Send `session/prompt` and map the turn-ending response. */
  private async prompt(objective: string): Promise<void> {
    const ctx = this.session;
    if (ctx === null || this.acpSessionId === null) {
      return;
    }
    try {
      const result = (await this.request('session/prompt', {
        sessionId: this.acpSessionId,
        prompt: [{ type: 'text', text: objective }],
      })) as { stopReason?: string } | null;
      const stopReason = result?.stopReason ?? 'end_turn';
      if (stopReason === 'cancelled') {
        this.enqueue(this.terminal('AgentStopped', { reason: 'user' as const }));
      } else {
        this.enqueue(
          this.terminal('AgentCompleted', {
            summary: `ACP turn ended (${stopReason})`,
            deliverables: [],
          }),
        );
      }
    } catch (err) {
      this.enqueue(
        this.terminal('AgentFailed', {
          error: err instanceof Error ? err.message : String(err),
          recoverable: true,
        }),
      );
    } finally {
      this.completeStream();
    }
  }

  async *streamEvents(): AsyncIterable<SupervisorEvent> {
    this.requireConnected();
    while (!this.streamComplete || this.eventQueue.length > 0) {
      if (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()!;
        this.emitEvent(event);
        yield event;
      } else {
        await new Promise<void>((resolve) => {
          this.eventResolvers.push(resolve);
        });
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.session?.sessionId !== sessionId || this.acpSessionId === null) {
      return;
    }
    this.notify('session/cancel', { sessionId: this.acpSessionId });
    if (!this.streamComplete) {
      this.enqueue(this.terminal('AgentStopped', { reason: 'user' as const }));
      this.completeStream();
    }
    this.session = null;
  }

  async disconnect(): Promise<void> {
    this.completeStream();
    this.session = null;
    this.acpSessionId = null;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    for (const [, { reject }] of this.pending) {
      reject(new Error('ACP adapter disconnected'));
    }
    this.pending.clear();
    if (this.connectionState !== 'disconnected') {
      this.setConnectionState('disconnected');
    }
  }

  /* ---------------------------------------------------------------- *
   * JSON-RPC plumbing
   * ---------------------------------------------------------------- */

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.process === null) {
      return Promise.reject(new Error('ACP adapter has no process'));
    }
    const id = this.nextRequestId++;
    const msg: JsonRpcRequestMsg = { jsonrpc: '2.0', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`ACP request "${method}" (id=${id}) timed out`));
        }
      }, 30000);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.process?.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  private respond(id: number, result: unknown): void {
    this.process?.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  private respondError(id: number, code: number, message: string): void {
    this.process?.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) {
        return;
      }
      msg = parsed;
    } catch {
      return;
    }
    if (msg['method'] !== undefined && msg['id'] !== undefined) {
      void this.handleAgentRequest(msg as unknown as JsonRpcRequestMsg);
    } else if (msg['method'] !== undefined) {
      this.handleNotification(msg as unknown as JsonRpcNotificationMsg);
    } else if (msg['id'] !== undefined) {
      this.handleResponse(msg as unknown as JsonRpcResponseMsg);
    }
  }

  private handleResponse(response: JsonRpcResponseMsg): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (response.error !== undefined) {
      pending.reject(new Error(`ACP error ${response.error.code}: ${response.error.message}`));
    } else {
      pending.resolve(response.result ?? null);
    }
  }

  /** Agent→Client requests (permission prompts, fs/terminal access). */
  private async handleAgentRequest(request: JsonRpcRequestMsg): Promise<void> {
    if (request.method === 'session/request_permission') {
      const params = (request.params ?? {}) as AcpPermissionRequest;
      this.enqueuePermission(params);
      const responder = this.options.permissionResponder;
      const choice = responder === undefined ? null : await responder(params);
      if (choice === null) {
        this.respond(request.id, { outcome: { outcome: 'cancelled' } });
      } else {
        this.respond(request.id, {
          outcome: { outcome: 'selected', optionId: choice.optionId },
        });
      }
      return;
    }
    // fs/*, terminal/*, and anything else: not implemented — the daemon
    // owns the worktree; adapters never grant implicit host access.
    this.respondError(request.id, -32601, `method not implemented: ${request.method}`);
  }

  private handleNotification(notification: JsonRpcNotificationMsg): void {
    if (notification.method !== 'session/update' || !isObject(notification.params)) {
      return;
    }
    const params = notification.params as Record<string, unknown>;
    const update = params['update'];
    if (!isObject(update) || typeof update['sessionUpdate'] !== 'string') {
      return;
    }
    this.mapUpdate(update['sessionUpdate'], update);
  }

  /* ---------------------------------------------------------------- *
   * session/update mapping
   * ---------------------------------------------------------------- */

  private mapUpdate(kind: string, update: Record<string, unknown>): void {
    const ctx = this.session;
    if (ctx === null) {
      return;
    }
    const base = {
      timestamp: new Date().toISOString(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: this.fidelityTier,
    } as const;

    switch (kind) {
      case 'agent_message_chunk': {
        const content = update['content'];
        const text =
          isObject(content) && typeof content['text'] === 'string' ? content['text'] : '';
        if (text.length > 0) {
          this.enqueue({ ...base, type: 'AgentProgress', message: text });
        }
        return;
      }
      case 'tool_call': {
        const call = update as unknown as AcpToolCall;
        this.enqueue({
          ...base,
          type: 'ToolStarted',
          toolName: call.title ?? call.toolCallId ?? 'unknown',
          args: isObject(call.rawInput) ? (call.rawInput as Record<string, unknown>) : undefined,
        });
        return;
      }
      case 'tool_call_update': {
        const call = update as unknown as AcpToolCall;
        const status = call.status;
        if (status === 'completed' || status === 'failed') {
          this.enqueue({
            ...base,
            type: 'ToolFinished',
            toolName: call.title ?? call.toolCallId ?? 'unknown',
            success: status === 'completed',
            error: status === 'failed' ? 'tool call failed' : undefined,
          });
        }
        return;
      }
      case 'plan': {
        const entries = update['entries'];
        const count = Array.isArray(entries) ? entries.length : 0;
        this.enqueue({ ...base, type: 'AgentProgress', message: `plan update (${count} items)` });
        return;
      }
      case 'usage_update': {
        const used = update['used'];
        this.enqueue({
          ...base,
          type: 'UsageReported',
          provider: this.id,
          totalTokens: typeof used === 'number' ? used : undefined,
        });
        return;
      }
      default:
        return; // available_commands_update, current_mode_update, etc.
    }
  }

  private enqueuePermission(request: AcpPermissionRequest): void {
    const ctx = this.session;
    if (ctx === null) {
      return;
    }
    const call = request.toolCall ?? {};
    this.enqueue({
      type: 'ApprovalRequested',
      timestamp: new Date().toISOString(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: this.fidelityTier,
      task: ctx.objective,
      agent: ctx.agentId,
      capability: acpKindToCapability(call.kind),
      destination: call.locations?.[0]?.path ?? call.title ?? 'unknown',
      command: call.title ?? call.toolCallId ?? 'unknown',
      workingDir: ctx.workingDir,
      scope: [
        {
          type: acpKindToCapability(call.kind),
          targets: call.locations?.map((l) => l.path ?? 'unknown') ?? ['unknown'],
        },
      ],
      riskLevel: 'low',
    });
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  private terminal(
    type: 'AgentCompleted' | 'AgentFailed' | 'AgentStopped',
    fields: Record<string, unknown>,
  ): SupervisorEvent {
    const ctx = this.session!;
    return {
      type,
      timestamp: new Date().toISOString(),
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      adapterFidelityTier: this.fidelityTier,
      ...fields,
    } as SupervisorEvent;
  }

  private enqueue(event: SupervisorEvent): void {
    this.eventQueue.push(event);
    this.eventResolvers.shift()?.();
  }

  private completeStream(): void {
    this.streamComplete = true;
    while (this.eventResolvers.length > 0) {
      this.eventResolvers.shift()!();
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    for (const [, { reject }] of this.pending) {
      reject(new Error(`ACP process exited (code=${code}, signal=${signal})`));
    }
    this.pending.clear();
    if (!this.streamComplete && this.session !== null) {
      this.enqueue(
        this.terminal('AgentFailed', {
          error: `ACP process exited unexpectedly (code=${code}, signal=${signal})`,
          recoverable: true,
        }),
      );
      this.completeStream();
    }
    if (this.connectionState === 'connected') {
      this.setConnectionState('disconnected');
    }
  }
}

/** Map an ACP tool-call kind onto the DEC-010 capability vocabulary. */
function acpKindToCapability(kind: string | undefined): 'shell' | 'filesystem' | 'network' | 'other' {
  switch (kind) {
    case 'execute':
      return 'shell';
    case 'edit':
    case 'delete':
    case 'move':
    case 'create':
    case 'read':
      return 'filesystem';
    case 'fetch':
      return 'network';
    default:
      return 'other';
  }
}

/* ------------------------------------------------------------------ *
 * Provider factories
 * ------------------------------------------------------------------ */

/** Devin CLI in ACP mode (`devin acp`). Local CLI only — no Devin Cloud. */
export function devinAcpAdapter(
  bus: EventBus | null,
  options: Omit<AcpAdapterOptions, 'id' | 'command'> = {},
): AcpAdapter {
  return new AcpAdapter(bus, { ...options, id: 'devin', command: 'devin', args: ['acp'] });
}

/** Gemini CLI in ACP mode (`gemini --acp`). */
export function geminiAcpAdapter(
  bus: EventBus | null,
  options: Omit<AcpAdapterOptions, 'id' | 'command'> = {},
): AcpAdapter {
  return new AcpAdapter(bus, { ...options, id: 'gemini', command: 'gemini', args: ['--acp'] });
}
