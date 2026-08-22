/**
 * Claude Code CLI PTY adapter — fidelity tier B (DEC-013, issue #11).
 *
 * Wraps the user's installed Claude Code CLI by spawning it in a pseudo-
 * terminal (PTY) and parsing the unstructured terminal output into the
 * canonical {@link SupervisorEvent} schema (DEC-019). Tier B is lower
 * fidelity than the Codex app-server (tier A, structured JSON-RPC) because
 * PTY output is unstructured and version-drifting: tool calls, file changes,
 * and permission prompts are recognized best-effort via regex (see
 * {@link claude-mapper}).
 *
 * Per DEC-010, permission prompts map to `ApprovalRequested` with structured
 * capability fields. Because PTY output does not expose structured fields,
 * unparseable values fall back to `unknown`/conservative defaults, and the
 * risk level defaults to `critical` so the attention engine never
 * auto-approves an unparseable prompt (DEC-011: never silently widen
 * permissions).
 *
 * Per DEC-027, the adapter relies on Claude Code's own agent-native
 * sandboxing; it does not provision execution environments.
 *
 * Lifecycle:
 * 1. `connect()` — spawn the Claude CLI subprocess via a PTY.
 * 2. `startRun(taskId, sessionConfig)` — send the objective as a prompt to
 *    the CLI.
 * 3. `streamEvents()` — async generator yielding normalized SupervisorEvents
 *    as PTY output arrives.
 * 4. `cancel(sessionId)` — send Ctrl-C (ETX, 0x03) to the PTY and emit
 *    `AgentStopped`.
 * 5. `disconnect()` — kill the PTY process.
 *
 * The PTY spawn is abstracted behind a {@link PtySpawner}/{@link PtyProcess}
 * interface so the same adapter logic works with `node-pty` in production and
 * an in-memory mock in tests. `node-pty` is lazy-imported only inside
 * `connect()` so the module type-checks and builds without the native
 * dependency installed.
 */
import { AdapterFidelityTier } from '../domain/enums.js';
import type { SupervisorEvent } from '../domain/events.js';
import type { EventBus } from '../daemon/event-stream.js';
import { BaseAdapter, type SessionConfig, type StartRunResult } from './base.js';
import {
  parsePtyLine,
  mapPtyChunk,
  type ClaudeMapperContext,
} from './claude-mapper.js';

/** Stable id for the Claude Code adapter. */
export const CLAUDE_ADAPTER_ID = 'claude-code';

/** Ctrl-C (ETX) byte sent to the PTY to interrupt the CLI. */
const CTRL_C = '\x03';

/** Newline used to submit a prompt to the CLI. */
const ENTER = '\r';

/**
 * A handle on a spawned PTY process. This is the minimal surface the adapter
 * relies on; it is satisfied by `node-pty`'s `IPty` as well as test mocks.
 */
export interface PtyProcess {
  /** Write a string to the PTY master (sent to the child as keystrokes). */
  write(data: string): void;
  /** Register a handler for PTY data output (child stdout/stderr). */
  onData(handler: (data: string) => void): void;
  /** Register a handler for PTY process exit. */
  onExit(handler: (exitCode: number, signal?: number) => void): void;
  /** Kill the PTY process. */
  kill(signal?: string): void;
  /** The OS pid of the child process, if available. */
  readonly pid: number;
}

/** Input for a {@link PtySpawner}: the command and environment to run. */
export interface PtySpawnOptions {
  /** The CLI executable to spawn (e.g. `claude`). */
  readonly file: string;
  /** Arguments to pass to the executable. */
  readonly args: readonly string[];
  /** Working directory for the child process. */
  readonly cwd: string;
  /** Environment variables for the child process. */
  readonly env?: Record<string, string>;
  /** Initial terminal columns. */
  readonly cols?: number;
  /** Initial terminal rows. */
  readonly rows?: number;
}

/**
 * Factory that spawns a PTY process. The default implementation lazy-imports
 * `node-pty`; tests inject a mock spawner.
 */
export interface PtySpawner {
  spawn(options: PtySpawnOptions): PtyProcess;
}

/**
 * Configuration for the Claude Code adapter.
 */
export interface ClaudeAdapterOptions {
  /**
   * The Claude Code CLI executable to spawn. Defaults to `claude`.
   */
  readonly command?: string;
  /**
   * Extra arguments to pass to the CLI. Defaults to none; the adapter
   * appends the objective as a positional prompt on `startRun`.
   */
  readonly args?: readonly string[];
  /**
   * Optional PTY spawner. When omitted, `connect()` lazy-imports `node-pty`
   * and uses its `spawn`. Tests inject a mock spawner to avoid spawning a
   * real CLI process.
   */
  readonly spawner?: PtySpawner;
  /** Initial terminal columns. Defaults to 120. */
  readonly cols?: number;
  /** Initial terminal rows. Defaults to 40. */
  readonly rows?: number;
}

/**
 * Claude Code CLI PTY adapter (Tier B).
 *
 * Spawns the user's installed Claude Code CLI in a PTY, sends the delegated
 * objective as a prompt, and streams best-effort normalized
 * {@link SupervisorEvent}s parsed from the terminal output.
 */
export class ClaudeAdapter extends BaseAdapter {
  private readonly options: ClaudeAdapterOptions;
  private pty: PtyProcess | null = null;
  private activeSession: SessionConfig | null = null;
  private mapperCtx: ClaudeMapperContext | null = null;

  /** Internal queue of mapped SupervisorEvents awaiting streamEvents. */
  private eventQueue: SupervisorEvent[] = [];
  /** Resolve functions waiting for events in streamEvents. */
  private eventResolvers: Array<() => void> = [];
  /** Whether the stream has been marked complete (run finished / cancelled). */
  private streamComplete = false;
  /** Buffered partial line awaiting a newline from the PTY. */
  private lineBuffer = '';

  constructor(bus?: EventBus | null, options: ClaudeAdapterOptions = {}) {
    super(CLAUDE_ADAPTER_ID, AdapterFidelityTier.B, bus);
    this.options = options;
  }

  async connect(): Promise<void> {
    this.setConnectionState('connecting');
    const spawner = this.options.spawner ?? (await createNodePtySpawner());
    // Spawn the CLI in interactive mode; the prompt is sent on startRun.
    // We do not pass the objective here — it is sent as a keystroke prompt so
    // the CLI's interactive REPL receives it.
    this.pty = spawner.spawn({
      file: this.options.command ?? 'claude',
      args: this.options.args ?? [],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      cols: this.options.cols ?? 120,
      rows: this.options.rows ?? 40,
    });
    this.pty.onData((data) => this.handlePtyData(data));
    this.pty.onExit((exitCode, _signal) => this.handlePtyExit(exitCode));
    this.setConnectionState('connected');
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.requireConnected();
    if (this.activeSession !== null) {
      throw new Error(
        `Claude adapter already has an active session: ${this.activeSession.sessionId}`,
      );
    }
    if (!this.pty) {
      throw new Error('Claude adapter has no PTY process');
    }
    this.activeSession = sessionConfig;
    this.streamComplete = false;
    this.eventQueue = [];
    this.lineBuffer = '';
    this.mapperCtx = {
      taskId: sessionConfig.taskId,
      sessionId: sessionConfig.sessionId,
      agentId: sessionConfig.agentId,
      adapterFidelityTier: this.fidelityTier,
      objective: sessionConfig.objective,
      workingDir: sessionConfig.workingDir,
    };

    // Emit AgentStarted immediately — the CLI does not emit a structured
    // "started" marker, so the adapter synthesizes it from the run config.
    this.enqueueEvent({
      type: 'AgentStarted',
      timestamp: new Date().toISOString(),
      taskId: sessionConfig.taskId,
      sessionId: sessionConfig.sessionId,
      agentId: sessionConfig.agentId,
      adapterFidelityTier: this.fidelityTier,
      objective: sessionConfig.objective,
      workingDir: sessionConfig.workingDir,
      model: sessionConfig.model,
      autonomyLevel: sessionConfig.autonomyLevel,
    });

    // Send the objective as a prompt to the CLI's interactive REPL.
    this.pty.write(`${sessionConfig.objective}${ENTER}`);

    void taskId; // taskId is carried in sessionConfig; kept for interface parity.
    return { sessionId: sessionConfig.sessionId, started: true };
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
    // Send Ctrl-C (ETX) to interrupt the CLI.
    if (this.pty) {
      try {
        this.pty.write(CTRL_C);
      } catch {
        // PTY may already be dead; we still emit AgentStopped locally.
      }
    }
    if (!this.streamComplete && this.mapperCtx) {
      this.enqueueEvent({
        type: 'AgentStopped',
        timestamp: new Date().toISOString(),
        taskId: this.mapperCtx.taskId,
        sessionId: this.mapperCtx.sessionId,
        agentId: this.mapperCtx.agentId,
        adapterFidelityTier: this.mapperCtx.adapterFidelityTier,
        reason: 'user',
        details: 'Cancelled by secretary (Ctrl-C sent to PTY)',
      });
      this.completeStream();
    }
    this.activeSession = null;
  }

  async disconnect(): Promise<void> {
    this.completeStream();
    this.activeSession = null;
    this.mapperCtx = null;
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        // Process may already be dead.
      }
      this.pty = null;
    }
    if (this.connectionState !== 'disconnected') {
      this.setConnectionState('disconnected');
    }
  }

  /* ---------------------------------------------------------------- *
   * Internal: PTY output handling
   * ---------------------------------------------------------------- */

  /**
   * Handle incoming PTY data. Splits on newlines, parses each complete line,
   * and enqueues mapped events. A trailing partial line is buffered until the
   * next data chunk.
   */
  private handlePtyData(data: string): void {
    if (!this.mapperCtx) {
      return;
    }
    this.lineBuffer += data;
    let nlIndex: number;
    while ((nlIndex = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, nlIndex);
      this.lineBuffer = this.lineBuffer.slice(nlIndex + 1);
      this.processLine(line);
    }
  }

  /**
   * Parse a single PTY line and enqueue any mapped events. When a mapped
   * event is terminal (`AgentCompleted`, `AgentFailed`, `AgentStopped`), the
   * stream is marked complete so a subsequent process exit does not emit a
   * duplicate terminal event.
   */
  private processLine(line: string): void {
    if (!this.mapperCtx) {
      return;
    }
    const chunk = parsePtyLine(line);
    const events = mapPtyChunk(chunk, this.mapperCtx);
    for (const event of events) {
      this.enqueueEvent(event);
      if (
        event.type === 'AgentCompleted' ||
        event.type === 'AgentFailed' ||
        event.type === 'AgentStopped'
      ) {
        this.completeStream();
        this.activeSession = null;
      }
    }
  }

  /**
   * Handle PTY process exit. A zero exit code completes the run; a non-zero
   * exit code emits `AgentFailed` (unless the stream was already completed by
   * a cancel/completion marker).
   */
  private handlePtyExit(exitCode: number): void {
    if (this.streamComplete || !this.mapperCtx) {
      return;
    }
    if (exitCode === 0) {
      // No structured completion marker may have been parsed; synthesize one.
      this.enqueueEvent({
        type: 'AgentCompleted',
        timestamp: new Date().toISOString(),
        taskId: this.mapperCtx.taskId,
        sessionId: this.mapperCtx.sessionId,
        agentId: this.mapperCtx.agentId,
        adapterFidelityTier: this.mapperCtx.adapterFidelityTier,
        summary: 'Claude CLI exited successfully',
        deliverables: [],
        exitCode,
      });
    } else {
      this.enqueueEvent({
        type: 'AgentFailed',
        timestamp: new Date().toISOString(),
        taskId: this.mapperCtx.taskId,
        sessionId: this.mapperCtx.sessionId,
        agentId: this.mapperCtx.agentId,
        adapterFidelityTier: this.mapperCtx.adapterFidelityTier,
        error: `Claude CLI exited with code ${exitCode}`,
        exitCode,
        recoverable: true,
      });
    }
    this.completeStream();
    this.activeSession = null;
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
    while (this.eventResolvers.length > 0) {
      const resolver = this.eventResolvers.shift()!;
      resolver();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Default node-pty spawner (lazy-imported)
 * ------------------------------------------------------------------ */

/**
 * Create a {@link PtySpawner} backed by `node-pty`. The module is lazy-imported
 * so this file type-checks and builds without the native dependency installed;
 * the import only runs when `connect()` is called without an injected spawner
 * (i.e. in production, not in tests).
 *
 * If `node-pty` is not installed, `connect()` rejects with a clear error.
 */
async function createNodePtySpawner(): Promise<PtySpawner> {
  let ptyModule: {
    spawn: (
      file: string,
      args: readonly string[],
      options: {
        name?: string;
        cols?: number;
        rows?: number;
        cwd: string;
        env: Record<string, string>;
      },
    ) => NodePtyHandle;
  };
  try {
    // Use a variable specifier so the type-checker does not statically resolve
    // the `node-pty` module (which may not be installed). The cast keeps the
    // surface minimal and decoupled from `@types/node-pty`.
    const moduleName = 'node-pty';
    ptyModule = (await import(/* @vite-ignore */ moduleName)) as unknown as typeof ptyModule;
  } catch {
    throw new Error(
      'Claude adapter requires the "node-pty" dependency to spawn a real PTY. ' +
        'Install it (`npm install node-pty`) or inject a mock spawner via ' +
        'ClaudeAdapterOptions.spawner for testing.',
    );
  }
  return {
    spawn(options: PtySpawnOptions): PtyProcess {
      const proc = ptyModule.spawn(options.file, options.args, {
        name: 'xterm-256color',
        cols: options.cols ?? 120,
        rows: options.rows ?? 40,
        cwd: options.cwd,
        env: options.env ?? {},
      });
      return new NodePtyProcess(proc);
    },
  };
}

/**
 * Minimal structural type for the `node-pty` IPty surface the adapter uses.
 * Kept local to avoid a hard type dependency on `@types/node-pty`.
 */
interface NodePtyHandle {
  write(data: string): void;
  onData(handler: (data: string) => void): { dispose(): void };
  onExit(handler: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  readonly pid: number;
}

/**
 * Adapter wrapping a `node-pty` IPty instance into the adapter's
 * {@link PtyProcess} interface.
 */
class NodePtyProcess implements PtyProcess {
  private readonly proc: NodePtyHandle;

  constructor(proc: NodePtyHandle) {
    this.proc = proc;
  }

  get pid(): number {
    return this.proc.pid;
  }

  write(data: string): void {
    this.proc.write(data);
  }

  onData(handler: (data: string) => void): void {
    this.proc.onData(handler);
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.proc.onExit((e) => handler(e.exitCode, e.signal));
  }

  kill(signal?: string): void {
    this.proc.kill(signal);
  }
}
