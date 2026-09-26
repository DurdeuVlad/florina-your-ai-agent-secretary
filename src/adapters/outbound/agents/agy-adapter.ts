/**
 * Antigravity `agy` headless adapter — fidelity tier D (issue #62).
 *
 * `agy -p "<prompt>" --output-format stream-json` emits NDJSON events on
 * stdout — a structured-JSON surface, so this is NOT Tier E scraping. Each
 * run is one process; there is no persistent session to connect.
 *
 * Caveats from the research:
 * - Non-TTY stdout bug (upstream #76): `agy -p` may print nothing when
 *   stdout is a pipe. Production deployments should wrap the spawn in a PTY
 *   (agy-headless-bridge pattern); the seam here is {@link AgySpawner}, so
 *   a PTY-backed spawner drops in without adapter changes.
 * - No quota API: exhaustion is detected reactively by daemon wiring via
 *   {@link reportExhaustion} (issue #71); this adapter just maps the error.
 * - Tier D: no auto-approval — permission-like events always escalate.
 *
 * The `stream-json` schema is treated tolerantly: the mapper recognizes the
 * common event vocabulary (`system`/`assistant`/`tool_use`/`tool_result`/
 * `result`/`error`) and ignores shapes it does not know.
 */
import { type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { spawnCli } from './spawn-cli.js';

import { AdapterFidelityTier } from '../../../core/domain/enums.js';
import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { EventPublisherPort } from '../../../core/application/ports/outbound/event-stream.js';
import { BaseAdapter, type SessionConfig, type StartRunResult } from './base.js';

/** Stable id for the Antigravity adapter. */
export const AGY_ADAPTER_ID = 'antigravity';

/* ------------------------------------------------------------------ *
 * Process seam
 * ------------------------------------------------------------------ */

/** A spawned `agy` headless run. */
export interface AgyProcess {
  /** Register a handler for each stdout line. */
  onLine(handler: (line: string) => void): void;
  /** Register a handler for stderr lines (diagnostics). */
  onStderrLine(handler: (line: string) => void): void;
  /** Register a handler for process exit. */
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  /** Terminate the process. */
  kill(): void;
}

/** Spawns an `agy -p` headless run. */
export type AgySpawner = (command: string, args: readonly string[], cwd: string) => AgyProcess;

/** Default spawner: plain child_process. Swap for a PTY spawner to work
 * around the non-TTY stdout bug (upstream #76). */
export const nodeAgySpawner: AgySpawner = (command, args, cwd) => {
  const child: ChildProcess = spawnCli(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = createInterface({ input: child.stdout! });
  const err = createInterface({ input: child.stderr! });
  return {
    onLine: (h) => out.on('line', h),
    onStderrLine: (h) => err.on('line', h),
    onExit: (h) => child.on('exit', h),
    kill: () => child.kill(),
  };
};

/** Options for {@link AgyAdapter}. */
export interface AgyAdapterOptions {
  /** `agy` binary (default `agy`). */
  readonly command?: string;
  /** Injectable spawner (tests substitute a fake; prod may use a PTY). */
  readonly spawner?: AgySpawner;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObject(c) && typeof c['text'] === 'string' ? c['text'] : ''))
      .join('');
  }
  if (isObject(content)) {
    if (typeof content['text'] === 'string') {
      return content['text'];
    }
    if (content['content'] !== undefined) {
      return textOf(content['content']);
    }
  }
  return '';
}

/**
 * Tier D adapter for Google Antigravity's `agy` CLI headless mode.
 *
 * Each `startRun` spawns `agy -p <objective> --output-format stream-json`
 * in the task worktree and maps NDJSON events to {@link SupervisorEvent}s
 * until the process exits.
 */
export class AgyAdapter extends BaseAdapter {
  private readonly command: string;
  private readonly spawner: AgySpawner;
  private process: AgyProcess | null = null;
  private session: SessionConfig | null = null;
  private eventQueue: SupervisorEvent[] = [];
  private eventResolvers: Array<() => void> = [];
  private streamComplete = false;
  private cancelled = false;
  private terminalEmitted = false;

  constructor(bus: EventPublisherPort | null | undefined, options: AgyAdapterOptions = {}) {
    super(AGY_ADAPTER_ID, AdapterFidelityTier.D, bus);
    this.command = options.command ?? 'agy';
    this.spawner = options.spawner ?? nodeAgySpawner;
  }

  async connect(): Promise<void> {
    this.setConnectionState('connecting');
    this.setConnectionState('connected');
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.requireConnected();
    if (this.session !== null) {
      throw new Error(`agy adapter already has an active session: ${this.session.sessionId}`);
    }
    this.session = sessionConfig;
    this.streamComplete = false;
    this.terminalEmitted = false;
    this.cancelled = false;
    this.eventQueue = [];

    const args = ['-p', sessionConfig.objective, '--output-format', 'stream-json'];
    if (sessionConfig.model !== undefined) {
      args.push('--model', sessionConfig.model);
    }
    this.process = this.spawner(this.command, args, sessionConfig.workingDir);
    this.process.onLine((line) => this.handleLine(line));
    this.process.onStderrLine(() => {
      /* diagnostics only — stream-json stays on stdout */
    });
    this.process.onExit((code) => this.handleExit(code));

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
    return { sessionId: sessionConfig.sessionId, started: true };
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
    if (this.session?.sessionId !== sessionId) {
      return;
    }
    this.cancelled = true;
    this.process?.kill();
    // handleExit emits the AgentStopped terminal.
  }

  async disconnect(): Promise<void> {
    this.cancelled = true;
    this.process?.kill();
    this.completeStream();
    this.process = null;
    this.session = null;
    if (this.connectionState !== 'disconnected') {
      this.setConnectionState('disconnected');
    }
  }

  /* ---------------------------------------------------------------- *
   * stream-json line mapping
   * ---------------------------------------------------------------- */

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isObject(parsed)) {
        return;
      }
      msg = parsed;
    } catch {
      return;
    }
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

    const type = msg['type'];
    switch (type) {
      case 'system':
        return; // init line — nothing to surface
      case 'assistant':
      case 'message': {
        const text = textOf(msg['message'] ?? msg['content']);
        if (text.length > 0) {
          this.enqueue({ ...base, type: 'AgentProgress', message: text });
        }
        return;
      }
      case 'tool_use':
      case 'tool_call': {
        const name =
          typeof msg['name'] === 'string'
            ? msg['name']
            : typeof msg['tool'] === 'string'
              ? msg['tool']
              : 'unknown';
        this.enqueue({
          ...base,
          type: 'ToolStarted',
          toolName: name,
          args: isObject(msg['input']) ? (msg['input'] as Record<string, unknown>) : undefined,
        });
        return;
      }
      case 'tool_result': {
        const name =
          typeof msg['name'] === 'string'
            ? msg['name']
            : typeof msg['tool'] === 'string'
              ? msg['tool']
              : 'unknown';
        const isError = msg['is_error'] === true || msg['isError'] === true;
        this.enqueue({
          ...base,
          type: 'ToolFinished',
          toolName: name,
          success: !isError,
          error: isError ? textOf(msg['content']) || 'tool error' : undefined,
        });
        return;
      }
      case 'result': {
        // Terminal: exit 0 => completed; non-zero handled in handleExit.
        this.emitTerminal({
          type: 'AgentCompleted',
          ...base,
          summary: textOf(msg['result'] ?? msg['summary']) || 'agy run finished',
          deliverables: [],
          durationMs: typeof msg['duration_ms'] === 'number' ? msg['duration_ms'] : undefined,
        } as SupervisorEvent);
        return;
      }
      case 'error': {
        this.emitTerminal({
          type: 'AgentFailed',
          ...base,
          error: textOf(msg['error'] ?? msg['message']) || 'agy reported an error',
          recoverable: true,
        } as SupervisorEvent);
        return;
      }
      default:
        return; // unknown stream-json shapes are ignored, not fatal
    }
  }

  private handleExit(code: number | null): void {
    const ctx = this.session;
    this.process = null;
    if (ctx !== null && !this.terminalEmitted) {
      const base = {
        timestamp: new Date().toISOString(),
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        adapterFidelityTier: this.fidelityTier,
      } as const;
      if (this.cancelled) {
        this.emitTerminal({ type: 'AgentStopped', ...base, reason: 'user' } as SupervisorEvent);
      } else if (code === 0) {
        this.emitTerminal({
          type: 'AgentCompleted',
          ...base,
          summary: 'agy run finished (exit 0, no result event)',
          deliverables: [],
          exitCode: 0,
        } as SupervisorEvent);
      } else {
        this.emitTerminal({
          type: 'AgentFailed',
          ...base,
          error: `agy exited with code ${code}`,
          exitCode: code ?? undefined,
          recoverable: true,
        } as SupervisorEvent);
      }
    }
    this.completeStream();
    this.session = null;
  }

  /** Emit a terminal event exactly once, then complete the stream. */
  private emitTerminal(event: SupervisorEvent): void {
    if (this.terminalEmitted) {
      return;
    }
    this.terminalEmitted = true;
    this.enqueue(event);
    this.completeStream();
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
}
