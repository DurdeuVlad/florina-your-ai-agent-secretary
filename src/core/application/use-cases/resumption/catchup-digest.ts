/**
 * Catch-up digest: deterministic-facts-first "since you were last active"
 * query (DEC-042, issue #191/#195/#216). See
 * `docs/RULES_MEMORY_AND_SUPERVISION.md` § 9.
 *
 * Mirrors `completion-digest.ts`'s discipline: every field here is derived
 * directly from the task store, attention inbox, and event journal — no
 * field is invented or summarized by a model. An LLM narrative layer (not
 * implemented here — no child issue under #195 asks for one) would only
 * ever render *this* structure into prose, never originate a fact.
 */
import type { EntityId, ISODateString, Task } from '../../../domain/types.js';
import { TaskState } from '../../../domain/enums.js';
import type { TaskRepositoryPort, EventJournalPort } from '../../ports/outbound/repositories.js';
import type { CatchUpWatermarkPort } from '../../ports/outbound/catchup-watermark.js';
import type { AttentionInbox } from '../attention/attention-inbox.js';
import type { AttentionItem } from '../attention/attention-item.js';

/** The task states §9 step 2 treats as "notable since the watermark." */
const NOTABLE_STATES: ReadonlySet<string> = new Set([
  TaskState.Completed,
  TaskState.Failed,
  TaskState.AttentionNeeded,
]);

export interface CatchUpTaskSummary {
  readonly taskId: EntityId;
  readonly objective: string;
  readonly state: string;
  readonly updatedAt: ISODateString;
}

export interface CatchUpFailoverSummary {
  readonly taskId: EntityId;
  readonly fromProvider: string;
  readonly toProvider: string;
  readonly reason: string;
  readonly timestamp: ISODateString;
}

/**
 * The compiled digest. `notable` covers tasks that transitioned to
 * completed/failed/attention-needed since the watermark; `stillRunning`
 * is a live snapshot (not watermark-bound — a running task is running
 * regardless of when it started); `pendingAttention` is every currently
 * pending item (also a live snapshot, per §9 step 2's "currently
 * pending" wording, not "opened since the watermark").
 */
export interface CatchUpDigest {
  readonly since: ISODateString;
  readonly until: ISODateString;
  readonly notable: readonly CatchUpTaskSummary[];
  readonly stillRunning: readonly CatchUpTaskSummary[];
  readonly pendingAttention: readonly AttentionItem[];
  readonly failovers: readonly CatchUpFailoverSummary[];
  /** True when nothing notable, running, pending, or failed-over exists — the "nothing needs you" close (§9 step 4). */
  readonly isEmpty: boolean;
}

export interface CatchUpDigestDeps {
  readonly taskStore: Pick<TaskRepositoryPort, 'listAll'>;
  readonly inbox: Pick<AttentionInbox, 'list'>;
  readonly journal: Pick<EventJournalPort, 'listByTimestampRange'>;
}

function toSummary(task: Task): CatchUpTaskSummary {
  return { taskId: task.id, objective: task.objective, state: task.state, updatedAt: task.updatedAt };
}

/**
 * Compute the catch-up digest for the window `(since, until]`. Pure read
 * — safe to call repeatedly without side effects; advancing the
 * watermark (#217) is a separate, delivery-gated act.
 */
export function computeCatchUpDigest(
  deps: CatchUpDigestDeps,
  since: ISODateString,
  until: ISODateString,
): CatchUpDigest {
  const allTasks = deps.taskStore.listAll();

  const notable = allTasks
    .filter((t) => NOTABLE_STATES.has(t.state) && t.updatedAt > since && t.updatedAt <= until)
    .map(toSummary);

  const stillRunning = allTasks.filter((t) => t.state === TaskState.Running).map(toSummary);

  const pendingAttention = deps.inbox.list({ status: 'Pending' });

  const failovers = deps.journal
    .listByTimestampRange(since, until)
    .filter((e) => e.kind === 'TaskFailedOver')
    .map((e) => ({
      taskId: e.taskId,
      fromProvider: String(e.payload['fromProvider'] ?? ''),
      toProvider: String(e.payload['toProvider'] ?? ''),
      reason: String(e.payload['reason'] ?? ''),
      timestamp: e.timestamp,
    }));

  return {
    since,
    until,
    notable,
    stillRunning,
    pendingAttention,
    failovers,
    isEmpty:
      notable.length === 0 && stillRunning.length === 0 && pendingAttention.length === 0 && failovers.length === 0,
  };
}

/**
 * The watermark query semantics `computeCatchUpDigest` builds on: no
 * stored watermark yet (first-ever catch-up) reads as "since the
 * beginning of time," so nothing is excluded from `notable`.
 */
export function watermarkOrEpoch(watermark: ISODateString | null): ISODateString {
  return watermark ?? new Date(0).toISOString();
}

/**
 * Advance the watermark, but never backward — a delivery confirmation
 * that arrives out of order (or a caller passing a stale `until`) must
 * not regress the window and cause already-seen items to reappear on
 * the next catch-up. The actual *gating* on confirmed delivery (only
 * calling this after the client acks) is #217's job; this is the
 * monotonicity guarantee underneath it.
 */
export function advanceWatermark(store: CatchUpWatermarkPort, until: ISODateString): void {
  const current = store.get();
  if (current !== null && until <= current) return;
  store.set(until);
}
