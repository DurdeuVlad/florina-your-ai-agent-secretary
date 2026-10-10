/**
 * Verification runner — Florina-run objective checks (issue #339).
 *
 * The {@link VerificationGate} (DEC-032) judges a completion claim against
 * journaled `VerificationObserved` facts — but until now those facts came
 * only from adapter-normalized provider output, i.e. the agent's own
 * report. This runner produces *Florina-observed* facts: it re-reads the
 * `verifyCommands` declared at dispatch (journaled on the delegation
 * event, so the contract survives restarts and failover), executes each
 * command in the task worktree through the {@link CommandRunnerPort}, and
 * probes the worktree's clean/dirty state.
 *
 * Every probe is journaled as an individual `VerificationObserved` fact
 * (bounded output tails, never whole logs), followed by exactly one
 * terminal aggregate fact — the gate reads the *latest* fact as the
 * honest verdict, so the aggregate is written last:
 *
 * - all declared checks pass + clean worktree → `verified`
 * - any check fails/times out/can't run, or the worktree is dirty
 *   → `unverified` (the claim is not proven; the failing fact says why)
 * - no checks declared → `unverified` — degrades to the worktree gate
 *   only, reported honestly as unproven rather than passed
 *
 * Journal writes go through {@link EventJournalPort.insert} directly
 * (like the gate's own claim records) so the bus→journal writer never
 * double-records them. Insert failures are routed to `onJournalFailure`
 * (#264 provenance gap) and never thrown through the event pipeline.
 */
import type { EntityId, Event, Task } from '../../../domain/types.js';
import type { VerificationKind, VerificationObservedEvent } from '../../../domain/events.js';
import type { EventJournalPort, TaskRepositoryPort } from '../../ports/outbound/repositories.js';
import type { WorktreePort, WorktreeStatus } from '../../ports/outbound/worktree.js';
import type { CommandRunnerPort } from '../../ports/outbound/command-runner.js';
import { supervisorEventToJournalRow } from '../journal/event-journal-writer.js';

/** Default per-command timeout: ten minutes — generous for `npm test`,
 * bounded so a hung check cannot stall the completion pipeline forever. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Output tail kept per stream in journaled evidence — enough to
 * diagnose a failure, bounded so the journal stays a digest. */
const OUTPUT_TAIL_CHARS = 2000;

/** Result of one declared check. */
export interface VerifyCheckResult {
  readonly command: string;
  readonly kind: VerificationKind;
  readonly success: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly spawnFailed: boolean;
  /** e.g. `exit 0`, `exit 1`, `timed out`, `spawn failed`. */
  readonly summary: string;
}

/** Aggregate outcome of running a task's declared verification. */
export interface VerificationRunOutcome {
  /** `true` only when declared checks all passed AND the worktree is clean. */
  readonly verified: boolean;
  /** The checks declared at dispatch (empty when none were declared). */
  readonly declaredChecks: readonly string[];
  readonly checks: readonly VerifyCheckResult[];
  /** Worktree probe result; `null` when no worktree path was recorded. */
  readonly worktree:
    | { readonly clean: boolean; readonly dirty: boolean; readonly branch: string }
    | { readonly error: string }
    | null;
}

export interface VerificationRunnerDeps {
  readonly journal: EventJournalPort;
  readonly tasks: TaskRepositoryPort;
  readonly worktree: WorktreePort;
  readonly runner: CommandRunnerPort;
  /** Per-command timeout; defaults to {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Sink for journal-insert failures (#264) — MUST NOT throw. */
  readonly onJournalFailure?: (err: unknown, row: Event) => void;
}

export class VerificationRunner {
  private readonly journal: EventJournalPort;
  private readonly tasks: TaskRepositoryPort;
  private readonly worktree: WorktreePort;
  private readonly runner: CommandRunnerPort;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly onJournalFailure?: (err: unknown, row: Event) => void;
  /**
   * Monotonic sequence for fact timestamps: the journal orders by the
   * observed `timestamp`, and same-millisecond ties have undefined order.
   * A strictly increasing stamp per fact guarantees the terminal
   * aggregate is always the latest fact the gate reads.
   */
  private seq = 0;

  constructor(deps: VerificationRunnerDeps) {
    this.journal = deps.journal;
    this.tasks = deps.tasks;
    this.worktree = deps.worktree;
    this.runner = deps.runner;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.now = deps.now ?? (() => new Date());
    this.onJournalFailure = deps.onJournalFailure;
  }

  /**
   * Run the task's declared verification and journal the facts. Invoked
   * when a completion claim (`AgentCompleted`) is about to publish, before
   * the verification gate assesses it — facts must precede judgement.
   *
   * Returns the aggregate outcome for the caller; the durable evidence is
   * the journal. Never throws — a broken probe is an unverified claim,
   * not a crashed event pipeline.
   */
  async run(
    taskId: EntityId,
    sessionId: EntityId,
    agentId: string,
  ): Promise<VerificationRunOutcome> {
    const task = this.tasks.getById(taskId);
    if (task === null) {
      // No task row means journal inserts would fail their FK — skip
      // writes entirely; the claim stays unproven either way.
      return { verified: false, declaredChecks: [], checks: [], worktree: null };
    }

    const declaredChecks = this.declaredChecks(taskId);
    const worktree = this.probeWorktree(task, sessionId, agentId, taskId);
    const checks = await this.runChecks(
      declaredChecks,
      task.worktreePath,
      taskId,
      sessionId,
      agentId,
    );

    const worktreeClean = worktree !== null && 'clean' in worktree ? worktree.clean : false;
    const declared = declaredChecks.length > 0;
    const allPassed = checks.every((c) => c.success);
    const verified = declared && allPassed && worktreeClean;

    const failed = checks.filter((c) => !c.success);
    const summary = verified
      ? `verified: ${checks.length} declared check(s) passed, worktree clean`
      : !declared
        ? `unverified: no declared checks — worktree gate only (worktree ${worktreeClean ? 'clean' : 'not clean'})`
        : !worktreeClean
          ? 'unverified: worktree is not clean or status unavailable'
          : `unverified: ${failed.length} of ${checks.length} declared check(s) failed`;

    this.journalFact({
      type: 'VerificationObserved',
      taskId,
      sessionId,
      agentId,
      adapterFidelityTier: 'B',
      kind: 'other',
      success: verified,
      command: 'florina:task-verification',
      summary,
      evidence: {
        declaredChecks: [...declaredChecks],
        checks: checks.map((c) => ({
          command: c.command,
          success: c.success,
          exitCode: c.exitCode,
          timedOut: c.timedOut,
        })),
        worktree,
      },
    });

    return { verified, declaredChecks, checks, worktree };
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  /**
   * The verification contract the task was dispatched with — read from
   * the newest journaled event carrying the `verifyCommands` key
   * (delegation or re-dispatch/failover). The latest declaration wins —
   * including an explicit `null` ("this dispatch declared nothing"),
   * which must NOT fall through to an older dispatch's contract.
   */
  private declaredChecks(taskId: EntityId): readonly string[] {
    const rows = this.journal.listByTask(taskId);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const payload = rows[i]?.payload;
      if (payload === undefined || !('verifyCommands' in payload)) {
        continue;
      }
      const cmds = payload['verifyCommands'];
      if (!Array.isArray(cmds)) {
        return [];
      }
      return cmds.filter((c): c is string => typeof c === 'string' && c.length > 0);
    }
    return [];
  }

  /**
   * Probe worktree cleanliness — the one gate that runs even when no
   * commands were declared: a task that left uncommitted work has not
   * landed its deliverable in a stable state.
   */
  private probeWorktree(
    task: Task,
    sessionId: EntityId,
    agentId: string,
    taskId: EntityId,
  ): VerificationRunOutcome['worktree'] {
    if (task.worktreePath === undefined || task.worktreePath === null) {
      this.journalProbe(taskId, sessionId, agentId, {
        command: 'florina:worktree-status',
        success: false,
        summary: 'no worktree path recorded for task',
      });
      return null;
    }
    let status: WorktreeStatus;
    try {
      status = this.worktree.worktreeStatus(task.worktreePath);
    } catch (err) {
      const summary = `worktree status probe failed: ${err instanceof Error ? err.message : String(err)}`;
      this.journalProbe(taskId, sessionId, agentId, {
        command: 'florina:worktree-status',
        success: false,
        summary,
      });
      return { error: summary };
    }
    this.journalProbe(taskId, sessionId, agentId, {
      command: 'florina:worktree-status',
      success: status.clean,
      summary: status.clean
        ? `worktree clean (branch ${status.branch})`
        : `worktree dirty — uncommitted changes on ${status.branch}`,
      evidence: { clean: status.clean, dirty: status.dirty, branch: status.branch },
    });
    return { clean: status.clean, dirty: status.dirty, branch: status.branch };
  }

  /** Execute each declared check in the task worktree; journal a fact per check. */
  private async runChecks(
    commands: readonly string[],
    cwd: string | undefined,
    taskId: EntityId,
    sessionId: EntityId,
    agentId: string,
  ): Promise<readonly VerifyCheckResult[]> {
    const results: VerifyCheckResult[] = [];
    for (const command of commands) {
      const kind = inferKind(command);
      if (cwd === undefined) {
        const result: VerifyCheckResult = {
          command,
          kind,
          success: false,
          exitCode: null,
          timedOut: false,
          spawnFailed: true,
          summary: 'no worktree to run in',
        };
        results.push(result);
        this.journalCheck(taskId, sessionId, agentId, result, '');
        continue;
      }
      let result: VerifyCheckResult;
      try {
        const r = await this.runner.run(command, cwd, this.timeoutMs);
        const success = r.exitCode === 0 && !r.timedOut && !r.spawnFailed;
        const summary = r.timedOut
          ? `timed out after ${this.timeoutMs}ms`
          : r.spawnFailed
            ? 'spawn failed'
            : r.signal !== null
              ? `killed by ${r.signal}`
              : `exit ${r.exitCode ?? 'null'}`;
        result = {
          command,
          kind,
          success,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          spawnFailed: r.spawnFailed,
          summary,
        };
        const output = `${r.stdout}\n${r.stderr}`.trim();
        this.journalCheck(taskId, sessionId, agentId, result, output);
      } catch (err) {
        // The port resolves on every outcome; a throw is a runner bug —
        // still journal it as a failed check rather than crash the pipe.
        result = {
          command,
          kind,
          success: false,
          exitCode: null,
          timedOut: false,
          spawnFailed: true,
          summary: `runner error: ${err instanceof Error ? err.message : String(err)}`,
        };
        results.push(result);
        this.journalCheck(taskId, sessionId, agentId, result, '');
        continue;
      }
      results.push(result);
    }
    return results;
  }

  /** Journal one declared-check fact with a bounded output tail. */
  private journalCheck(
    taskId: EntityId,
    sessionId: EntityId,
    agentId: string,
    result: VerifyCheckResult,
    output: string,
  ): void {
    this.journalFact({
      type: 'VerificationObserved',
      taskId,
      sessionId,
      agentId,
      adapterFidelityTier: 'B',
      kind: result.kind,
      success: result.success,
      command: result.command,
      summary: result.summary,
      evidence: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        spawnFailed: result.spawnFailed,
        florinaRun: true,
        outputTail: output.slice(-OUTPUT_TAIL_CHARS),
      },
    });
  }

  /** Journal one worktree-probe fact. */
  private journalProbe(
    taskId: EntityId,
    sessionId: EntityId,
    agentId: string,
    probe: {
      command: string;
      success: boolean;
      summary: string;
      evidence?: Record<string, unknown>;
    },
  ): void {
    this.journalFact({
      type: 'VerificationObserved',
      taskId,
      sessionId,
      agentId,
      adapterFidelityTier: 'B',
      kind: 'other',
      success: probe.success,
      command: probe.command,
      summary: probe.summary,
      evidence: { florinaRun: true, ...probe.evidence },
    });
  }

  /** Strictly increasing observed timestamp for the next journaled fact. */
  private stamp(): string {
    const stamped = new Date(this.now().getTime() + this.seq).toISOString();
    this.seq += 1;
    return stamped;
  }

  /** Convert + insert; failures go to the provenance-gap sink, never thrown. */
  private journalFact(event: Omit<VerificationObservedEvent, 'timestamp'>): void {
    const row = supervisorEventToJournalRow({ ...event, timestamp: this.stamp() });
    try {
      this.journal.insert(row);
    } catch (err) {
      try {
        this.onJournalFailure?.(err, row);
      } catch {
        /* the sink itself must never break verification */
      }
    }
  }
}

/**
 * Best-effort classification of a declared command into a
 * {@link VerificationKind} — drives the gate's informational `missing`
 * categories. First match wins; unmatched commands are 'other'. This only
 * affects reporting, never the pass/fail verdict (exit code decides that).
 */
function inferKind(command: string): VerificationKind {
  const c = command.toLowerCase();
  if (/(^|[^a-z])(vitest|jest|pytest|mocha|ava|cargo\s+test|go\s+test|test)([^a-z]|$)/.test(c)) {
    return 'test';
  }
  if (/(typecheck|tsc|mypy|pyright)/.test(c)) {
    return 'typecheck';
  }
  if (/(^|[^a-z])(build|compile|bundle)([^a-z]|$)/.test(c)) {
    return 'build';
  }
  if (/(lint|eslint|clippy|ruff|flake8)/.test(c)) {
    return 'lint';
  }
  if (/(e2e|playwright|cypress|verify|smoke|check)/.test(c)) {
    return 'behavioral';
  }
  return 'other';
}
