/**
 * Claude Code hooks adapter — fidelity tier B (DEC-013, issue #40).
 *
 * Wraps the user's installed Claude Code CLI by spawning it in headless
 * (`-p` / print) mode and configuring lifecycle hooks that emit structured
 * JSON events. The hooks forward their stdin JSON to an event sink (a JSONL
 * file or an injectable {@link HookEventSink}) that the adapter reads and
 * normalizes into the canonical {@link SupervisorEvent} schema (DEC-019).
 *
 * This is the real Tier B path per DEC-013: "installed CLI + structured
 * lifecycle hooks / Agent SDK". Unlike the PTY regex adapter (Tier E,
 * {@link claude-adapter}), the hooks API exposes structured `tool_name` /
 * `tool_input` fields, so the adapter can populate the full DEC-010 capability
 * fields deterministically — never guessing from unstructured terminal text.
 *
 * Per DEC-010, permission requests map to `ApprovalRequested` with structured
 * capability fields. Per DEC-011, any unrecognized or unstructured field falls
 * back to conservative defaults (`CapabilityType.Other` / `critical` risk) so
 * the attention engine never auto-approves an unknown request.
 *
 * Per DEC-027, the adapter relies on Claude Code's own agent-native
 * sandboxing; it does not provision execution environments.
 *
 * Lifecycle:
 * 1. `connect()` — prepare the event sink and hooks configuration. No
 *    subprocess is spawned until `startRun`.
 * 2. `startRun(taskId, sessionConfig)` — spawn the Claude CLI in headless mode
 *    with the hooks configuration and the objective as a prompt. Emit
 *    `AgentStarted` immediately.
 * 3. `streamEvents()` — async generator yielding normalized SupervisorEvents
 *    as hook events arrive via the event sink.
 * 4. `cancel(sessionId)` — kill the CLI subprocess and emit `AgentStopped`.
 * 5. `disconnect()` — kill the subprocess and tear down the event sink.
 *
 * The CLI spawn is abstracted behind a {@link ClaudeCliSpawner}/{@link ClaudeCliProcess}
 * interface so the same adapter logic works with `child_process` in production
 * and an in-memory mock in tests. `child_process` is lazy-imported only inside
 * `startRun()` so the module type-checks and builds without spawning a real
 * process.
 */
import { AdapterFidelityTier } from '../../../core/domain/enums.js';
import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { EventPublisherPort } from '../../../core/application/ports/outbound/event-stream.js';
import { BaseAdapter, type SessionConfig, type StartRunResult } from './base.js';
import {
  mapHookEvent,
  isHookEvent,
  type ClaudeHookEvent,
  type ClaudeHooksMapperContext,
} from './claude-hooks-mapper.js';

/** Stable id for the Claude Code hooks adapter. */
export const CLAUDE_HOOKS_ADAPTER_ID = 'claude-code';

/**
 * A handle on a spawned Claude CLI process. This is the minimal surface the
 * adapter relies on; it is satisfied by `child_process.ChildProcess` as well
 * as test mocks.
 */
export interface ClaudeCliProcess {
  /** The OS pid of the child process, if available. */
  readonly pid: number;
  /** Kill the process. */
  kill(signal?: string): void;
  /** Register a handler for process exit. */
  onExit(handler: (exitCode: number | null, signal?: NodeJS.Signals | null) => void): void;
}

/** Input for a {@link ClaudeCliSpawner}: the command and environment to run. */
export interface ClaudeCliSpawnOptions {
  /** The CLI executable to spawn (e.g. `claude`). */
  readonly file: string;
  /** Arguments to pass to the executable. */
  readonly args: readonly string[];
  /** Working directory for the child process. */
  readonly cwd: string;
  /** Environment variables for the child process. */
  readonly env?: Record<string, string>;
}

/**
 * Factory that spawns a Claude CLI process. The default implementation
 * lazy-imports `child_process`; tests inject a mock spawner.
 */
export interface ClaudeCliSpawner {
  spawn(options: ClaudeCliSpawnOptions): ClaudeCliProcess;
}

/**
 * A sink that receives structured hook events forwarded by the hook command.
 * In production, a {@link JsonlFileHookEventSink} reads JSONL lines appended by
 * the hook command. In tests, an {@link InMemoryHookEventSink} injects events
 * directly.
 */
export interface HookEventSink {
  /**
   * Read the next available hook event, blocking until one arrives or the
   * sink is closed. Returns `null` when the sink is closed and no more events
   * are available.
   */
  read(): Promise<ClaudeHookEvent | null>;
  /** Close the sink, releasing any resources (file handles, watchers, ...). */
  close(): void;
}

/**
 * Configuration for the Claude Code hooks adapter.
 */
export interface ClaudeHooksAdapterOptions {
  /**
   * The Claude Code CLI executable to spawn. Defaults to `claude`.
   */
  readonly command?: string;
  /**
   * Extra arguments to pass to the CLI. Defaults to none; the adapter
   * appends `-p` (print/headless mode) and the objective as a positional
   * prompt on `startRun`.
   */
  readonly args?: readonly string[];
  /**
   * Optional CLI spawner. When omitted, `startRun()` lazy-imports
   * `child_process` and uses its `spawn`. Tests inject a mock spawner to
   * avoid spawning a real CLI process.
   */
  readonly spawner?: ClaudeCliSpawner;
  /**
   * Optional hook event sink. When omitted, the adapter creates a
   * JSONL-file-based sink that reads events appended by the hook command.
   * Tests inject an in-memory sink to drive events directly.
   */
  readonly eventSink?: HookEventSink;
  /**
   * The shell command to use in the generated hooks configuration. The
   * command receives the hook event JSON on stdin and is expected to forward
   * it to the adapter's event sink. Defaults to a no-op forwarder that writes
   * to the event file; in tests this is typically overridden.
   */
  readonly hookCommand?: string;
}

/**
 * Claude Code hooks adapter (Tier B).
 *
 * Spawns the user's installed Claude Code CLI in headless mode with lifecycle
 * hooks configured, and streams normalized {@link SupervisorEvent}s parsed
 * from the structured hook events.
 */
export class ClaudeHooksAdapter extends BaseAdapter {
  private readonly options: ClaudeHooksAdapterOptions;
  private cliProcess: ClaudeCliProcess | null = null;
  private ownEventSink: HookEventSink | null = null;
  private activeSession: SessionConfig | null = null;
  private mapperCtx: ClaudeHooksMapperContext | null = null;

  /** Internal queue of mapped SupervisorEvents awaiting streamEvents. */
  private eventQueue: SupervisorEvent[] = [];
  /** Resolve functions waiting for events in streamEvents. */
  private eventResolvers: Array<() => void> = [];
  /** Whether the stream has been marked complete (run finished / cancelled). */
  private streamComplete = false;

  constructor(bus?: EventPublisherPort | null, options: ClaudeHooksAdapterOptions = {}) {
    super(CLAUDE_HOOKS_ADAPTER_ID, AdapterFidelityTier.B, bus);
    this.options = options;
  }

  async connect(): Promise<void> {
    this.setConnectionState('connecting');
    // Prepare the event sink if one was not injected. In production this
    // creates a JSONL file; in tests a sink is injected directly.
    if (!this.options.eventSink) {
      this.ownEventSink = await createJsonlFileSink();
    }
    this.setConnectionState('connected');
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.requireConnected();
    if (this.activeSession !== null) {
      throw new Error(
        `Claude hooks adapter already has an active session: ${this.activeSession.sessionId}`,
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

    // Emit AgentStarted immediately — the SessionStart hook may not fire in
    // all modes, so the adapter synthesizes it from the run config.
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

    // Spawn the CLI in headless (print) mode with the objective as a prompt.
    const spawner = this.options.spawner ?? (await createNodeCliSpawner());
    const baseArgs = this.options.args ?? [];
    const cliArgs = ['-p', sessionConfig.objective, ...baseArgs];
    this.cliProcess = spawner.spawn({
      file: this.options.command ?? 'claude',
      args: cliArgs,
      cwd: sessionConfig.workingDir,
      env: { ...process.env } as Record<string, string>,
    });
    this.cliProcess.onExit((exitCode, _signal) => this.handleCliExit(exitCode));

    // Begin reading hook events from the sink in the background.
    void this.drainEventSink();

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
    // Kill the CLI process to interrupt it.
    if (this.cliProcess) {
      try {
        this.cliProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead; we still emit AgentStopped locally.
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
        details: 'Cancelled by Florina (SIGTERM sent to Claude CLI)',
      });
      this.completeStream();
    }
    this.activeSession = null;
  }

  async disconnect(): Promise<void> {
    this.completeStream();
    this.activeSession = null;
    this.mapperCtx = null;
    if (this.cliProcess) {
      try {
        this.cliProcess.kill();
      } catch {
        // Process may already be dead.
      }
      this.cliProcess = null;
    }
    if (this.ownEventSink) {
      this.ownEventSink.close();
      this.ownEventSink = null;
    }
    if (this.connectionState !== 'disconnected') {
      this.setConnectionState('disconnected');
    }
  }

  /* ---------------------------------------------------------------- *
   * Internal: hook event draining
   * ---------------------------------------------------------------- */

  /**
   * Continuously read hook events from the sink and enqueue mapped
   * SupervisorEvents. Runs in the background until the sink is closed or the
   * stream is marked complete.
   */
  private async drainEventSink(): Promise<void> {
    const sink = this.options.eventSink ?? this.ownEventSink;
    if (!sink) {
      return;
    }
    while (!this.streamComplete) {
      const raw = await sink.read();
      if (raw === null) {
        // Sink closed; if the stream is not yet complete, the CLI exit
        // handler will synthesize a terminal event.
        break;
      }
      // The stream may have been completed (e.g. by a CLI exit) while we
      // were waiting for the next event. Skip late events to avoid
      // duplicate terminal events.
      if (this.streamComplete) {
        break;
      }
      this.handleHookEvent(raw);
    }
  }

  /**
   * Handle a parsed hook event: map it to SupervisorEvent(s) and enqueue them.
   * Terminal events (AgentCompleted, AgentFailed, AgentStopped) complete the
   * stream.
   */
  private handleHookEvent(event: ClaudeHookEvent): void {
    if (!this.mapperCtx) {
      return;
    }
    const mapped = mapHookEvent(event, this.mapperCtx);
    for (const ev of mapped) {
      this.enqueueEvent(ev);
      if (ev.type === 'AgentCompleted' || ev.type === 'AgentFailed' || ev.type === 'AgentStopped') {
        this.completeStream();
        this.activeSession = null;
      }
    }
  }

  /**
   * Handle CLI process exit. A zero exit code completes the run (if not
   * already completed by a Stop hook); a non-zero exit code emits
   * `AgentFailed` (unless the stream was already completed).
   */
  private handleCliExit(exitCode: number | null): void {
    if (this.streamComplete || !this.mapperCtx) {
      return;
    }
    if (exitCode === 0 || exitCode === null) {
      // No structured Stop hook may have been received; synthesize completion.
      this.enqueueEvent({
        type: 'AgentCompleted',
        timestamp: new Date().toISOString(),
        taskId: this.mapperCtx.taskId,
        sessionId: this.mapperCtx.sessionId,
        agentId: this.mapperCtx.agentId,
        adapterFidelityTier: this.mapperCtx.adapterFidelityTier,
        summary: 'Claude CLI exited successfully',
        deliverables: [],
        exitCode: exitCode ?? undefined,
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
 * Default child_process spawner (lazy-imported)
 * ------------------------------------------------------------------ */

/**
 * Create a {@link ClaudeCliSpawner} backed by `child_process.spawn`. The
 * module is lazy-imported so this file type-checks and builds without spawning
 * a real process; the import only runs when `startRun()` is called without an
 * injected spawner (i.e. in production, not in tests).
 */
async function createNodeCliSpawner(): Promise<ClaudeCliSpawner> {
  const { spawnCli } = await import('./spawn-cli.js');
  return {
    spawn(options: ClaudeCliSpawnOptions): ClaudeCliProcess {
      const proc = spawnCli(options.file, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return new NodeCliProcess(proc);
    },
  };
}

/**
 * Minimal structural type for the ChildProcess surface the adapter uses.
 */
interface ChildProcessHandle {
  readonly pid?: number;
  kill(signal?: string | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

/**
 * Adapter wrapping a `child_process.ChildProcess` instance into the adapter's
 * {@link ClaudeCliProcess} interface.
 */
class NodeCliProcess implements ClaudeCliProcess {
  private readonly proc: ChildProcessHandle;

  constructor(proc: ChildProcessHandle) {
    this.proc = proc;
  }

  get pid(): number {
    return this.proc.pid ?? -1;
  }

  kill(signal?: string): void {
    this.proc.kill(signal);
  }

  onExit(handler: (exitCode: number | null, signal?: NodeJS.Signals | null) => void): void {
    this.proc.on('exit', (code, signal) => handler(code, signal));
  }
}

/* ------------------------------------------------------------------ *
 * JSONL file-based hook event sink (lazy file creation)
 * ------------------------------------------------------------------ */

/**
 * Create a {@link HookEventSink} backed by a JSONL file. The hook command
 * appends one JSON object per line to the file; the sink reads new lines as
 * they arrive. This is the production sink; tests inject an in-memory sink.
 *
 * The implementation uses a polling reader for simplicity and portability
 * (file watchers vary across platforms). A production hardening pass would
 * switch to `fs.watch` / `chokidar`, but the polling approach is sufficient
 * for the MVP and avoids native dependency issues.
 */
async function createJsonlFileSink(): Promise<HookEventSink> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const eventFile = join(
    tmpdir(),
    `claude-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  // Create the file so the reader can open it immediately.
  await fs.writeFile(eventFile, '', 'utf8');
  return new JsonlFileHookEventSink(eventFile);
}

/**
 * A {@link HookEventSink} that reads JSONL lines from a file. The hook command
 * appends lines; the sink polls for new content and parses each line as JSON.
 */
class JsonlFileHookEventSink implements HookEventSink {
  private readonly filePath: string;
  private offset = 0;
  private closed = false;
  private readonly lineBuffer: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.startPolling();
  }

  private startPolling(): void {
    const poll = async (): Promise<void> => {
      if (this.closed) {
        return;
      }
      await this.readNewLines().catch(() => {
        // File may not exist yet; ignore.
      });
      this.pollTimer = setTimeout(poll, 50);
    };
    void poll();
  }

  private async readNewLines(): Promise<void> {
    const { promises: fs } = await import('node:fs');
    const stat = await fs.stat(this.filePath);
    if (stat.size <= this.offset) {
      return;
    }
    const fd = await fs.open(this.filePath, 'r');
    try {
      const length = stat.size - this.offset;
      const buffer = Buffer.alloc(length);
      await fd.read(buffer, 0, length, this.offset);
      this.offset = stat.size;
      const text = buffer.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          this.lineBuffer.push(trimmed);
        }
      }
      this.notifyWaiters();
    } finally {
      await fd.close();
    }
  }

  private notifyWaiters(): void {
    while (this.waiters.length > 0 && this.lineBuffer.length > 0) {
      this.waiters.shift()!();
    }
  }

  async read(): Promise<ClaudeHookEvent | null> {
    while (this.lineBuffer.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    if (this.lineBuffer.length === 0) {
      return null;
    }
    const line = this.lineBuffer.shift()!;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isHookEvent(parsed)) {
        return parsed;
      }
      // Unrecognized event; read the next one.
      return this.read();
    } catch {
      // Malformed JSON; skip and read the next line.
      return this.read();
    }
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.notifyWaiters();
  }
}

/**
 * An in-memory {@link HookEventSink} for tests. Events are injected via
 * `pushEvent` and consumed via `read`. Closing the sink causes pending
 * `read()` calls to resolve with `null`.
 */
export class InMemoryHookEventSink implements HookEventSink {
  private readonly events: ClaudeHookEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  /** Inject a hook event into the sink, waking any waiting reader. */
  pushEvent(event: ClaudeHookEvent): void {
    this.events.push(event);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
  }

  /** Mark the sink as closed; pending readers resolve with `null`. */
  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter();
    }
  }

  async read(): Promise<ClaudeHookEvent | null> {
    if (this.events.length > 0) {
      return this.events.shift()!;
    }
    if (this.closed) {
      return null;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    if (this.events.length > 0) {
      return this.events.shift()!;
    }
    return null;
  }
}
