/**
 * Nudge loop — bounded corrective re-dispatch on verify failure (issue
 * #340). "Smack the agent on the head until the work is real", mechanized
 * and bounded: never unbounded retries, never silent quota burn.
 *
 * Flow per completion claim that fails {@link VerificationRunner}:
 *
 *   AgentCompleted claim
 *     → VerificationRunner journals per-check facts + terminal aggregate
 *     → this loop journals `TaskVerifyFailed` (run ordinal + evidence)
 *     → attempts spent < budget  → pending nudge recorded; the actual
 *         re-dispatch happens in {@link dispatchPending} once the session
 *         slot frees (`onSessionEnd`), because `beforePublish` fires while
 *         the old session is still tracked.
 *     → attempts spent ≥ budget → `TaskParked` + `running → blocked` +
 *         a Critical attention item carrying the full attempt history;
 *         the human resumes, re-budgets, or cancels through existing
 *         commands (`start-task`, `stop-task`).
 *
 * Attempt count and budget are read from the journal — `TaskNudged` rows
 * are the durable attempt history (DEC-012), `verifyBudget` is journaled
 * on the dispatch event beside `verifyCommands` (latest declaration wins;
 * explicit null → the default). No schema, no hidden state: a daemon
 * restart mid-loop resumes with the same count.
 *
 * Re-dispatch uses a fresh `start-task` run — the provider has no
 * send/continue surface until M2 (#341/#342). Documented, not hidden: the
 * nudge prompt carries the failure evidence forward explicitly.
 */
import type { EntityId, Event } from '../../../domain/types.js';
import type {
  SupervisorEvent,
  TaskNudgedEvent,
  TaskParkedEvent,
  TaskVerifyFailedEvent,
} from '../../../domain/events.js';
import type { EventJournalPort, TaskRepositoryPort } from '../../ports/outbound/repositories.js';
import type { TaskStateMachine } from './task-lifecycle.js';
import { TaskState } from '../../../domain/enums.js';
import type { CommandExecutor, Response } from './command-api.js';
import type { AttentionInbox } from '../attention/attention-inbox.js';
import { createAttentionItem } from '../attention/attention-item.js';
import { supervisorEventToJournalRow } from '../journal/event-journal-writer.js';
import type { VerificationRunOutcome } from '../verification/verification-runner.js';

/** Default corrective budget: the original run plus two nudges. */
const DEFAULT_BUDGET = 2;

/** Per-failed-check output tail carried into the nudge prompt. */
const PROMPT_TAIL_CHARS = 1000;

/** Minimal command surface the loop needs to re-dispatch a task. */
export type NudgeCommandExecutor = CommandExecutor;

export interface NudgeLoopDeps {
  readonly journal: EventJournalPort;
  readonly tasks: TaskRepositoryPort;
  readonly stateMachine: TaskStateMachine;
  readonly commandApi: NudgeCommandExecutor;
  readonly inbox: AttentionInbox;
  /** Corrective budget when the dispatch declared none. */
  readonly defaultBudget?: number;
  readonly now?: () => Date;
  /** Sink for journal-insert failures (#264) — MUST NOT throw. */
  readonly onJournalFailure?: (err: unknown, row: Event) => void;
}

/** A verify failure queued for re-dispatch once the session slot frees. */
interface PendingNudge {
  readonly sessionId: EntityId;
  readonly agentId: string;
  /** Run ordinal being dispatched (2 for the first nudge). */
  readonly attempt: number;
  readonly budget: number;
  readonly prompt: string;
  readonly verifyCommands: readonly string[];
}

export class NudgeLoop {
  private readonly journal: EventJournalPort;
  private readonly tasks: TaskRepositoryPort;
  private readonly stateMachine: TaskStateMachine;
  private readonly commandApi: NudgeCommandExecutor;
  private readonly inbox: AttentionInbox;
  private readonly defaultBudget: number;
  private readonly now: () => Date;
  private readonly onJournalFailure?: (err: unknown, row: Event) => void;
  private readonly pending = new Map<string, PendingNudge>();
  private seq = 0;

  constructor(deps: NudgeLoopDeps) {
    this.journal = deps.journal;
    this.tasks = deps.tasks;
    this.stateMachine = deps.stateMachine;
    this.commandApi = deps.commandApi;
    this.inbox = deps.inbox;
    this.defaultBudget = deps.defaultBudget ?? DEFAULT_BUDGET;
    this.now = deps.now ?? (() => new Date());
    this.onJournalFailure = deps.onJournalFailure;
  }

  /**
   * React to a failed verification on a completion claim. Called inside
   * `SessionManager.beforePublish` before the claim reaches the bus:
   * journals `TaskVerifyFailed`, then either records a pending nudge
   * (dispatched at `onSessionEnd`) or parks + escalates at budget.
   *
   * Never throws — a supervision failure must not swallow the claim.
   */
  onVerifyFailed(
    taskId: EntityId,
    sessionId: EntityId,
    agentId: string,
    outcome: VerificationRunOutcome,
  ): 'nudge-pending' | 'parked' | 'ignored' {
    const task = this.tasks.getById(taskId);
    if (task === null) {
      return 'ignored';
    }
    // A task that declared no verification contract cannot be corrected
    // by re-dispatch — the unverified claim follows the ordinary
    // attention path (#339) rather than burning corrective attempts.
    if (outcome.declaredChecks.length === 0) {
      return 'ignored';
    }
    try {
      const priorNudges = this.journal
        .listByTask(taskId)
        .filter((e) => e.kind === 'TaskNudged').length;
      const budget = this.declaredBudget(taskId);
      // attempt = run ordinal that just failed: 1 is the original run,
      // N+1 after N nudges have been dispatched.
      const attempt = priorNudges + 1;

      const failedChecks = outcome.checks.filter((c) => !c.success);
      const summary =
        failedChecks.length > 0
          ? `attempt ${attempt}: ${failedChecks.length} of ${outcome.checks.length} declared check(s) failed`
          : `attempt ${attempt}: declared checks passed but the worktree gate failed`;

      this.journalEvent<TaskVerifyFailedEvent>({
        type: 'TaskVerifyFailed',
        taskId,
        sessionId,
        agentId,
        adapterFidelityTier: 'B',
        attempt,
        summary,
        failedChecks: failedChecks.map((c) => c.command),
      });

      if (priorNudges < budget) {
        this.pending.set(taskId, {
          sessionId,
          agentId,
          attempt: attempt + 1,
          budget,
          prompt: buildNudgePrompt({
            attempt: attempt + 1,
            budget,
            objective: task.objective,
            outcome,
          }),
          verifyCommands: outcome.declaredChecks,
        });
        return 'nudge-pending';
      }

      // Budget exhausted — park the task for the human with the whole
      // history; the loop stops spending quota here by construction.
      this.journalEvent<TaskParkedEvent>({
        type: 'TaskParked',
        taskId,
        sessionId,
        agentId,
        adapterFidelityTier: 'B',
        reason: `verify retry budget exhausted (${budget} nudge(s) spent)`,
        resumeAt: null,
      });
      this.park(taskId, sessionId, agentId);
      this.escalate(taskId, attempt, budget, summary);
      return 'parked';
    } catch {
      return 'ignored';
    }
  }

  /**
   * Re-dispatch a pending nudge. Invoked from `onSessionEnd` — the old
   * session row is already freed and the capsule rolled up, so the new
   * attempt starts with a clean slot and a fresh digest behind it.
   * Journals `TaskNudged` before dispatch so the attempt exists in the
   * immutable record even if dispatch fails.
   */
  async dispatchPending(taskId: EntityId): Promise<void> {
    const nudge = this.pending.get(taskId);
    if (nudge === undefined) {
      return;
    }
    this.pending.delete(taskId);

    const task = this.tasks.getById(taskId);
    if (task === null || task.state !== TaskState.Running) {
      // Stopped/cancelled between claim and session end — honest skip.
      return;
    }

    // running -> blocked opens a dispatch slot in the lifecycle (blocked
    // is startable) and journals the park as AgentBlocked.
    try {
      this.stateMachine.transition(taskId, TaskState.Running, TaskState.Blocked, {
        sessionId: nudge.sessionId,
        agentId: nudge.agentId,
        payload: { reason: 'verify-nudge-dispatch' },
      });
    } catch {
      return; // state raced elsewhere — leave the record intact
    }

    this.journalEvent<TaskNudgedEvent>({
      type: 'TaskNudged',
      taskId,
      sessionId: nudge.sessionId,
      agentId: nudge.agentId,
      adapterFidelityTier: 'B',
      attempt: nudge.attempt,
      budget: nudge.budget,
      prompt: nudge.prompt,
    });

    let res: Response;
    try {
      res = await this.commandApi.execute({
        kind: 'start-task',
        taskId,
        agentId: nudge.agentId,
        sessionConfig: {
          workingDir: task.worktreePath ?? '',
          prompt: nudge.prompt,
          verifyCommands: nudge.verifyCommands,
          verifyBudget: nudge.budget,
        },
      });
    } catch (err) {
      res = { ok: false, taskId, sessionId: '', error: String(err) };
    }
    if (!('ok' in res) || res.ok !== true) {
      this.escalate(
        taskId,
        nudge.attempt,
        nudge.budget,
        `nudge dispatch failed: ${'error' in res ? res.error : 'unknown'} — task parked`,
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  /** The retry budget the latest dispatch declared; default when absent. */
  private declaredBudget(taskId: EntityId): number {
    const rows = this.journal.listByTask(taskId);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const payload = rows[i]?.payload;
      if (payload === undefined || !('verifyBudget' in payload)) {
        continue;
      }
      const value = payload['verifyBudget'];
      return typeof value === 'number' && value >= 0 ? value : this.defaultBudget;
    }
    return this.defaultBudget;
  }

  /** Park the task for the human (blocked is resumable via start-task). */
  private park(taskId: EntityId, sessionId: EntityId, agentId: string): void {
    try {
      this.stateMachine.transition(taskId, TaskState.Running, TaskState.Blocked, {
        sessionId,
        agentId,
        payload: { reason: 'verify-budget-exhausted' },
      });
    } catch {
      // Already left running (cancelled/failed concurrently) — the
      // attention item below still records the exhausted budget.
    }
  }

  /** Critical item carrying the full attempt history for the human. */
  private escalate(taskId: EntityId, attempt: number, budget: number, reason: string): void {
    const history = this.journal
      .listByTask(taskId)
      .filter((e) => e.kind === 'TaskVerifyFailed' || e.kind === 'TaskNudged')
      .map((e) => ({
        kind: e.kind,
        timestamp: e.timestamp,
        attempt: e.payload['attempt'],
        summary: e.payload['summary'],
      }));
    this.inbox.add(
      createAttentionItem({
        taskId,
        kind: 'Custom',
        priority: 'Critical',
        payload: {
          reason: `verify budget exhausted — ${budget} nudge(s) spent, run ${attempt} still failing: ${reason}`,
          attempts: history,
          resolution:
            'Approve the worktree as-is, re-dispatch with a larger ' +
            'verifyBudget (start-task), or cancel (stop-task).',
        },
      }),
    );
  }

  /** Convert + insert; failures go to the provenance-gap sink, never thrown. */
  private journalEvent<T extends SupervisorEvent>(event: Omit<T, 'timestamp'>): void {
    const stamped = new Date(this.now().getTime() + this.seq).toISOString();
    this.seq += 1;
    const row = supervisorEventToJournalRow({ ...event, timestamp: stamped } as T);
    try {
      this.journal.insert(row);
    } catch (err) {
      try {
        this.onJournalFailure?.(err, row);
      } catch {
        /* the sink itself must never break the loop */
      }
    }
  }
}

/** Deterministic corrective prompt — failure evidence forward, not "try again". */
function buildNudgePrompt(input: {
  attempt: number;
  budget: number;
  objective: string;
  outcome: VerificationRunOutcome;
}): string {
  const { attempt, budget, objective, outcome } = input;
  const failed = outcome.checks.filter((c) => !c.success);
  const lines: string[] = [
    `[CORRECTIVE DISPATCH — attempt ${attempt} of ${budget}]`,
    'Your previous attempt claimed completion but failed objective verification.',
    '',
  ];
  if (failed.length > 0) {
    lines.push('Failed checks:');
    for (const c of failed) {
      lines.push(`- ${c.command}: ${c.summary}`);
      const tail = c.outputTail.trim();
      if (tail.length > 0) {
        lines.push('  output tail:', indent(tail.slice(-PROMPT_TAIL_CHARS)));
      }
    }
  } else {
    // Reachable only when declared checks passed but the worktree gate
    // failed — a contract-less task never enters the loop.
    lines.push('Declared checks passed, but the worktree gate failed.');
  }
  const wt = outcome.worktree;
  if (wt !== null && 'clean' in wt && !wt.clean) {
    lines.push('', `Worktree is dirty (branch ${wt.branch}) — uncommitted work must be finalized.`);
  }
  lines.push(
    '',
    `Original objective: ${objective}`,
    '',
    'Fix the failures so every declared check passes. ' +
      'Do not claim completion again until the checks actually pass.',
  );
  return lines.join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}
