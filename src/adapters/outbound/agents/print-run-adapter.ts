/**
 * Print-run adapter (issue #306): drives a provider whose headless mode
 * is "write the objective to a file, run once, read stdout" — no ACP,
 * no NDJSON, no login protocol. Aider is the motivating provider
 * (`aider --message-file <f> --yes-always --no-stream --no-pretty`).
 *
 * Honest event mapping — plain stdout is the only signal:
 * - every stdout line → `AgentProgress` (what the user would watch)
 * - exit 0 → `AgentCompleted` with the last progress line as summary
 * - nonzero/signal exit → `AgentFailed` with the stderr tail
 * - cancel → `AgentStopped`
 *
 * The provider can ask questions mid-run (aider does); the manifest's
 * args are expected to carry its "assume yes / non-interactive" flags,
 * so a prompt it can't suppress may stall — that is this transport's
 * documented fidelity limit, surfaced as silence rather than a lie.
 */
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { BaseAdapter, type SessionConfig, type StartRunResult } from './base.js';
import { AdapterFidelityTier } from '../../../core/domain/enums.js';
import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { EventPublisherPort } from '../../../core/application/ports/outbound/event-stream.js';
import { spawnCli } from './spawn-cli.js';

/** A spawned print-mode run — same minimal surface as AgyProcess. */
export interface PrintRunProcess {
  onLine(handler: (line: string) => void): void;
  onStderrLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  /**
   * Async spawn failure (ENOENT on non-Windows, where the provider
   * binary itself is exec'd — cmd.exe wraps win32, so 'exit' always
   * fires there). Without this an async spawn error would hang the
   * stream. Optional: fakes may not emit it.
   */
  onError?(handler: (error: Error) => void): void;
  kill(): void;
}

/** Spawns the provider's print-mode command; `env` carries scoped
 * secret injections resolved per-session (issue #293). */
export type PrintRunSpawner = (
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
) => PrintRunProcess;

/** Default spawner: spawnCli so .cmd/.bat shims survive on win32. */
export const nodePrintRunSpawner: PrintRunSpawner = (command, args, cwd, env) => {
  const child: ChildProcess = spawnCli(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
  });
  const out = createInterface({ input: child.stdout! });
  const err = createInterface({ input: child.stderr! });
  return {
    onLine: (h) => out.on('line', h),
    onStderrLine: (h) => err.on('line', h),
    // 'close', not 'exit': aider's error block sits at the END of
    // stdout, and piped data buffered at process death still arrives
    // after 'exit'. 'close' fires once stdio is flushed and closed —
    // only then is tail-window failure matching (and the Completed/
    // Failed decision) actually seeing the whole output.
    onExit: (h) => child.on('close', h),
    onError: (h) => child.on('error', h),
    kill: () => {
      if (process.platform === 'win32' && child.pid !== undefined) {
        // spawnCli wraps the provider in cmd.exe; killing the wrapper
        // orphans the real process — aider would keep editing the
        // worktree after AgentStopped. Kill the whole tree.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
          'error',
          () => child.kill(),
        );
      } else {
        child.kill();
      }
    },
  };
};

export interface PrintRunAdapterOptions {
  /** Adapter/provider id (must equal the manifest id). */
  readonly id: string;
  /** Resolved executable path or command name. */
  readonly command: string;
  /**
   * Invocation args — `{messageFile}` is substituted with a temp file
   * holding the objective. `{model}` is substituted only when the
   * session supplies one (the arg is dropped otherwise).
   */
  readonly args: readonly string[];
  readonly fidelityTier?: AdapterFidelityTier;
  /** Injectable spawner — tests substitute a fake process. */
  readonly spawner?: PrintRunSpawner;
  /** Injectable temp dir — tests land the message file under tmp(). */
  readonly tempDir?: string;
  /**
   * Cap on a stdout line's length inside an AgentProgress — aider's
   * diffs can run long, and the journal carries every event.
   */
  readonly maxLineChars?: number;
  /**
   * Regexes evaluated against the LAST {@link failureTailLines} output
   * lines when the process exits 0. A hit means the run failed even
   * on a clean exit — aider's print mode swallows litellm errors and
   * exits 0, so exit code alone is not task success. Matching is
   * tail-windowed on purpose: a litellm error aider retried past, or
   * the model echoing `litellm.X` mid-reply, scrolls out of the tail
   * when the run genuinely completes.
   */
  readonly failurePatterns?: readonly RegExp[];
  /**
   * How many trailing output lines (stdout+stderr, interleaved by
   * arrival) the failure patterns inspect on a clean exit.
   */
  readonly failureTailLines?: number;
  /**
   * Cap on AgentProgress events per run — aider replies can run to
   * thousands of stdout lines and every one is journaled. Past the
   * cap, one truncation marker is emitted and the rest are counted,
   * not dropped silently.
   */
  readonly maxProgressEvents?: number;
}

/** Stderr tail kept for the AgentFailed detail. */
const STDERR_TAIL_CHARS = 2000;

export class PrintRunAdapter extends BaseAdapter {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly spawner: PrintRunSpawner;
  private readonly tempDir: string;
  private readonly maxLineChars: number;
  private readonly failurePatterns: readonly RegExp[];
  private readonly failureTailLines: number;
  private readonly maxProgressEvents: number;
  /** Trailing output lines (stdout+stderr by arrival) for failure matching. */
  private tail: string[] = [];
  private progressCount = 0;
  private suppressedLines = 0;
  private truncationMarked = false;
  private process: PrintRunProcess | null = null;
  private session: SessionConfig | null = null;
  private messageDir: string | null = null;
  private stderrTail = '';
  private lastProgress = '';
  private eventQueue: SupervisorEvent[] = [];
  private eventResolvers: Array<() => void> = [];
  private streamComplete = false;
  private cancelled = false;
  private terminalEmitted = false;

  constructor(bus: EventPublisherPort | null | undefined, options: PrintRunAdapterOptions) {
    super(options.id, options.fidelityTier ?? AdapterFidelityTier.E, bus);
    this.command = options.command;
    this.args = options.args;
    this.spawner = options.spawner ?? nodePrintRunSpawner;
    this.tempDir = options.tempDir ?? tmpdir();
    this.maxLineChars = options.maxLineChars ?? 500;
    this.failurePatterns = options.failurePatterns ?? [];
    this.failureTailLines = options.failureTailLines ?? 16;
    this.maxProgressEvents = options.maxProgressEvents ?? 1000;
  }

  async connect(): Promise<void> {
    this.setConnectionState('connecting');
    this.setConnectionState('connected');
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.requireConnected();
    if (this.session !== null) {
      throw new Error(
        `${this.id} adapter already has an active session: ${this.session.sessionId}`,
      );
    }
    this.session = sessionConfig;
    this.streamComplete = false;
    this.terminalEmitted = false;
    this.cancelled = false;
    this.eventQueue = [];
    this.stderrTail = '';
    this.lastProgress = '';
    this.tail = [];
    this.progressCount = 0;
    this.suppressedLines = 0;
    this.truncationMarked = false;

    // The objective rides a file, not argv — prompt text never lands
    // on a command line where quoting or length limits could mangle
    // it. (Aider parses `--message-file` content as message text only
    // — `commands.run` never sees it — so `/`-leading lines are safe.)
    let args: string[];
    try {
      this.messageDir = mkdtempSync(join(this.tempDir, `florina-${this.id}-`));
      const messageFile = join(this.messageDir, 'message.txt');
      writeFileSync(messageFile, sessionConfig.objective, 'utf8');
      args = this.args
        .map((a) =>
          a.replaceAll('{messageFile}', messageFile).replaceAll('{messageDir}', this.messageDir!),
        )
        .flatMap((a) =>
          a.includes('{model}')
            ? sessionConfig.model !== undefined && sessionConfig.model !== ''
              ? [a.replaceAll('{model}', sessionConfig.model)]
              : []
            : [a],
        );
      this.process = this.spawner(this.command, args, sessionConfig.workingDir, sessionConfig.env);
    } catch (err) {
      // A synchronous failure (ENOENT on a vanished binary, EACCES on
      // a candidate, unwritable temp dir) must not wedge the adapter —
      // no AgentStarted was emitted yet, so roll the session back and
      // let the readiness layer classify the failure honestly. The
      // event stream is left parked, not completed: a retried run's
      // events must still reach a subscriber already streaming.
      this.cleanupMessageDir();
      this.session = null;
      throw err;
    }
    this.process.onError?.((error) => {
      // Async spawn failure — no 'exit' will follow on non-Windows.
      this.stderrTail = error.message;
      this.handleExit(null, null);
    });
    this.process.onLine((line) => {
      this.pushTail(line);
      this.handleLine(line);
    });
    this.process.onStderrLine((line) => {
      this.pushTail(line);
      // Diagnostics only — kept for the failure detail.
      this.stderrTail = (this.stderrTail + line + '\n').slice(-STDERR_TAIL_CHARS);
    });
    this.process.onExit((code, signal) => this.handleExit(code, signal));

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
    } as SupervisorEvent);
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
    if (this.session?.sessionId !== sessionId) return;
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
    this.cleanupMessageDir();
    if (this.connectionState !== 'disconnected') {
      this.setConnectionState('disconnected');
    }
  }

  /* ---------------------------------------------------------------- *
   * stdout → events
   * ---------------------------------------------------------------- */

  private handleLine(line: string): void {
    const trimmed = line.trimEnd();
    if (trimmed.trim().length === 0) return;
    const message =
      trimmed.length > this.maxLineChars ? `${trimmed.slice(0, this.maxLineChars)}…` : trimmed;
    this.lastProgress = message;
    this.progressCount += 1;
    if (this.progressCount > this.maxProgressEvents) {
      // Journal stays bounded — one honest marker, then count silently.
      this.suppressedLines += 1;
      if (!this.truncationMarked) {
        this.truncationMarked = true;
        const base = this.eventBase();
        this.enqueue({
          type: 'AgentProgress',
          ...base,
          message: `… output continues — further lines are counted, not journaled`,
        } as SupervisorEvent);
      }
      return;
    }
    const base = this.eventBase();
    this.enqueue({ type: 'AgentProgress', ...base, message } as SupervisorEvent);
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.cleanupMessageDir();
    const base = this.eventBase();
    if (this.cancelled) {
      this.emitTerminal({ type: 'AgentStopped', ...base, reason: 'user' } as SupervisorEvent);
      return;
    }
    if (code === 0) {
      // Clean exit — but a failure-pattern hit in the tail still means
      // the run failed: aider exits 0 after printing litellm auth/
      // quota/model errors, so process exit alone is not task success
      // (DEC-019). Tail-windowed: an error aider retried past, or the
      // model merely *mentioning* `litellm.X`, has scrolled out by the
      // time real completion output arrives.
      const matched = this.tailMatch();
      if (matched !== undefined) {
        this.emitTerminal({
          type: 'AgentFailed',
          ...base,
          error: matched,
          exitCode: 0,
          recoverable: true,
        } as SupervisorEvent);
        return;
      }
      const omitted =
        this.suppressedLines > 0
          ? ` (${this.suppressedLines} further output lines not journaled)`
          : '';
      this.emitTerminal({
        type: 'AgentCompleted',
        ...base,
        summary:
          this.lastProgress !== ''
            ? this.lastProgress + omitted
            : `${this.id} finished — see the task's event log for its output${omitted}`,
        deliverables: [],
        exitCode: 0,
      } as SupervisorEvent);
      return;
    }
    const detail =
      this.stderrTail.trim() !== ''
        ? this.stderrTail.trim()
        : `exited ${signal !== null ? `on signal ${signal}` : `with code ${String(code)}`}`;
    this.emitTerminal({
      type: 'AgentFailed',
      ...base,
      error: detail,
      exitCode: code ?? undefined,
      recoverable: true,
    } as SupervisorEvent);
  }

  private pushTail(line: string): void {
    this.tail.push(line);
    if (this.tail.length > this.failureTailLines) this.tail.shift();
  }

  /** First failure-pattern hit within the tail window, newest last. */
  private tailMatch(): string | undefined {
    for (const line of this.tail) {
      for (const pattern of this.failurePatterns) {
        if (pattern.test(line)) {
          return line.length > this.maxLineChars ? `${line.slice(0, this.maxLineChars)}…` : line;
        }
      }
    }
    return undefined;
  }

  private eventBase(): {
    timestamp: string;
    taskId: string;
    sessionId: string;
    agentId: string;
    adapterFidelityTier: AdapterFidelityTier;
  } {
    const session = this.session;
    return {
      timestamp: new Date().toISOString(),
      taskId: session?.taskId ?? '',
      sessionId: session?.sessionId ?? '',
      agentId: session?.agentId ?? this.id,
      adapterFidelityTier: this.fidelityTier,
    };
  }

  private emitTerminal(event: SupervisorEvent): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.enqueue(event);
    this.completeStream();
  }

  private cleanupMessageDir(): void {
    if (this.messageDir === null) return;
    const dir = this.messageDir;
    this.messageDir = null;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort — a locked temp file must not fail the run's end.
    }
  }

  private completeStream(): void {
    this.streamComplete = true;
    for (const resolve of this.eventResolvers.splice(0)) resolve();
  }

  private enqueue(event: SupervisorEvent): void {
    this.eventQueue.push(event);
    for (const resolve of this.eventResolvers.splice(0)) resolve();
  }
}
