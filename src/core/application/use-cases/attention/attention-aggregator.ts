/**
 * Attention aggregator — turns {@link SupervisorEvent}s into
 * {@link AttentionItem}s in the {@link AttentionInbox} (DEC-006, DEC-014).
 *
 * The aggregator subscribes to the daemon {@link EventSubscriberPort} and, for each
 * event that warrants human attention, creates an {@link AttentionItem} and
 * inserts it into the inbox. Daemon subsystems that do not emit
 * `SupervisorEvent`s (worktree dirty detection, liveness timeout) call the
 * dedicated `report*` methods directly.
 *
 * Deduplication: the same `taskId + kind` combination within a short
 * configurable window does not create a duplicate item. This prevents a
 * burst of identical events (e.g. repeated approval requests) from flooding
 * the inbox.
 */
import type { EventSubscriberPort } from '../../ports/outbound/event-stream.js';
import type {
  AgentCompletedEvent,
  AgentFailedEvent,
  ApprovalRequestedEvent,
  ContextHealthChangedEvent,
  SupervisorEvent,
} from '../../../domain/events.js';
import type { CapabilityRiskLevel } from '../../../domain/capabilities.js';
import type { Event } from '../../../domain/types.js';
import type { VerificationGate } from '../verification/verification-gate.js';
import {
  type AttentionItem,
  type AttentionItemKind,
  type AttentionItemPriority,
  createAttentionItem,
} from './attention-item.js';
import type { AttentionInbox } from './attention-inbox.js';

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/**
 * Scoped-approval gate (issue #67). When configured, the aggregator asks
 * the gate before creating an `ApprovalRequest` inbox item: a request
 * covered by an active capability grant is auto-approved (journaled by
 * the gate) and never reaches the inbox. Uncovered requests escalate
 * normally.
 */
export interface ApprovalGate {
  /**
   * Evaluate an `ApprovalRequested` event against the active grants.
   *
   * @returns `'auto-approved'` when a covering grant authorized the
   *   request (no inbox item is created), `'escalate'` otherwise.
   */
  evaluateApprovalRequest(event: ApprovalRequestedEvent): 'auto-approved' | 'escalate';
}

/** Configuration for {@link AttentionAggregator}. */
export interface AttentionAggregatorConfig {
  /**
   * Deduplication window in milliseconds. Two items with the same
   * `taskId + kind` created within this window are collapsed into one.
   * Default: 30 seconds.
   */
  readonly dedupWindowMs?: number;
  /** Time provider (ms since epoch) for deterministic testing. */
  readonly now?: () => number;
  /**
   * Optional scoped-approval gate (issue #67). Auto-approves
   * `ApprovalRequested` events covered by an active grant.
   */
  readonly approvalGate?: ApprovalGate;
  /**
   * Optional verification gate (DEC-032, issue #68). When set, an
   * `AgentCompleted` claim is assessed against journaled evidence:
   * verified → `Digest` item; unverified → `UnverifiedCompletion` item
   * carrying a re-verification objective instead of surfacing as done.
   */
  readonly verificationGate?: VerificationGate;
}

/** Default deduplication window: 30 seconds. */
export const DEFAULT_DEDUP_WINDOW_MS = 30_000;

/**
 * Maximum failed journal rows a single JournalFailure card retains
 * (issue #264) — bounds the payload serialized into every inbox push
 * during a sustained write outage; excess rows are counted in
 * `droppedCount` rather than silently dropped.
 */
export const MAX_RETAINED_JOURNAL_WRITES = 50;

/* ------------------------------------------------------------------ *
 * AttentionAggregator
 * ------------------------------------------------------------------ */

/**
 * Subscribes to the {@link EventSubscriberPort} and populates an {@link AttentionInbox}
 * with {@link AttentionItem}s derived from {@link SupervisorEvent}s.
 *
 * Event → item mapping:
 * - `ApprovalRequested` → `ApprovalRequest`, priority from `riskLevel`.
 * - `AgentFailed` → `FailedRun`, priority `High`.
 * - `AgentCompleted` → `Digest`, priority `Low`.
 *
 * Non-event sources call the dedicated report methods:
 * - {@link reportDirtyWorktree} → `DirtyWorktree`, priority `Medium`.
 * - {@link reportLivenessTimeout} → `IdleAgent`, priority `High`.
 * - {@link reportStaleTask} → `StaleTask`, priority `Medium`.
 */
export class AttentionAggregator {
  private readonly inbox: AttentionInbox;
  private readonly bus: EventSubscriberPort;
  private readonly dedupWindowMs: number;
  private readonly now: () => number;
  private readonly approvalGate?: ApprovalGate;
  private readonly verificationGate?: VerificationGate;
  private unsubscribe?: () => void;
  /** Last creation time (ms) per dedup key `${taskId}:${kind}`. */
  private readonly lastCreated = new Map<string, number>();

  constructor(
    inbox: AttentionInbox,
    bus: EventSubscriberPort,
    config: AttentionAggregatorConfig = {},
  ) {
    this.inbox = inbox;
    this.bus = bus;
    this.dedupWindowMs = config.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.now = config.now ?? (() => Date.now());
    this.approvalGate = config.approvalGate;
    this.verificationGate = config.verificationGate;
  }

  /**
   * Begin listening to the {@link EventSubscriberPort}. Safe to call once; subsequent
   * calls are no-ops. Pair with {@link stop}.
   */
  start(): void {
    if (this.unsubscribe !== undefined) return;
    this.unsubscribe = this.bus.onEvent((event) => this.handleEvent(event));
  }

  /** Stop listening to the {@link EventSubscriberPort}. Safe to call when not started. */
  stop(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /**
   * Process a single {@link SupervisorEvent} and create an attention item
   * if the event warrants one.
   *
   * Exposed publicly so callers can feed events directly (e.g. when
   * replaying the event journal on startup) without going through the bus.
   *
   * `provenance: 'observed'` events (DEC-041, issue #197 — provider-native
   * activity Florina did not dispatch) never reach the switch below: no
   * auto-approval evaluation, no attention item of any kind. They remain
   * visible only in the journal/inspector's raw event stream, which reads
   * the journal directly rather than through this pipeline.
   */
  handleEvent(event: SupervisorEvent): void {
    if (event.provenance === 'observed') {
      return;
    }
    switch (event.type) {
      case 'ApprovalRequested':
        this.addApprovalItem(event);
        break;
      case 'AgentFailed':
        this.addFailedRunItem(event);
        break;
      case 'AgentCompleted':
        this.addDigestItem(event);
        break;
      case 'ContextHealthChanged':
        this.addDegradedContextItem(event);
        break;
      default:
        // Other event types do not directly produce inbox items.
        break;
    }
  }

  /* ---------------------------------------------------------------- *
   * Non-event report methods
   * ---------------------------------------------------------------- */

  /** Report a dirty worktree for human review (DEC-024). */
  reportDirtyWorktree(taskId: string, worktreePath: string, branch?: string): void {
    this.maybeAddItem({
      taskId,
      kind: 'DirtyWorktree',
      priority: 'Medium',
      payload: { worktreePath, branch },
    });
  }

  /** Report a liveness timeout (idle agent) from the attention engine. */
  reportLivenessTimeout(taskId: string, idleMs?: number): void {
    this.maybeAddItem({
      taskId,
      kind: 'IdleAgent',
      priority: 'High',
      payload: { idleMs },
    });
  }

  /** Report a stale task that has not progressed beyond its deadline. */
  reportStaleTask(taskId: string, staleForMs?: number): void {
    this.maybeAddItem({
      taskId,
      kind: 'StaleTask',
      priority: 'Medium',
      payload: { staleForMs },
    });
  }

  /**
   * Report a journaled-write failure (issue #264). `write` is the
   * converted journal row retained for the card's Inspect + Retry path;
   * `retryable` distinguishes transient failures (busy/IO) from
   * permanent ones (constraint violations a retry can never satisfy).
   *
   * The 30s dedup window collapses a burst (e.g. repeated SQLITE_BUSY)
   * into one card rather than a storm — but collapsing must not lose
   * writes: each additional failed row folds into the open card's
   * `writes` list so Retry can still land every retained row.
   *
   * Known limit (issue #272): the inbox is in-memory — a daemon restart
   * loses the card and its retained rows. Persistence is a separate
   * follow-up; until then "retained for retry" means retained *while
   * the daemon runs*.
   */
  reportJournalFailure(failure: {
    readonly source: string;
    readonly error: string;
    readonly write?: Event;
    readonly retryable: boolean;
  }): void {
    const taskId = failure.write?.taskId ?? '';
    const key = dedupKey(taskId, 'JournalFailure');
    const nowMs = this.now();
    const last = this.lastCreated.get(key);
    // Any unresolved card for the same task absorbs the burst — not just
    // Pending ones: an acknowledged/escalated card must still collect
    // every failed row, or those rows vanish silently while the card
    // stays open.
    const open = this.inbox
      .list({ kind: 'JournalFailure', taskId })
      .filter((i) => i.status !== 'Resolved')
      .at(-1);
    if (open !== undefined && last !== undefined && nowMs - last < this.dedupWindowMs) {
      const prev = Array.isArray(open.payload['writes']) ? (open.payload['writes'] as Event[]) : [];
      const dropped =
        typeof open.payload['droppedCount'] === 'number'
          ? (open.payload['droppedCount'] as number)
          : 0;
      const failures =
        typeof open.payload['failures'] === 'number' ? (open.payload['failures'] as number) : 1;
      // Cap retention: a sustained outage must not serialize an
      // unbounded row array into every inbox push — excess rows are
      // counted and surfaced, not silently lost.
      const overflow = failure.write !== undefined && prev.length >= MAX_RETAINED_JOURNAL_WRITES;
      const writes = failure.write !== undefined && !overflow ? [...prev, failure.write] : prev;
      const droppedCount = overflow ? dropped + 1 : dropped;
      const total = failures + 1;
      this.inbox.mergePayload(open.id, {
        writes,
        failures: total,
        droppedCount,
        reason: failure.error,
        message:
          `${failure.source}: ${total} writes failed (latest: ${failure.error})` +
          `; ${writes.length} retained for retry` +
          (droppedCount > 0 ? `, ${droppedCount} dropped past the retention cap` : ''),
        retryable: open.payload['retryable'] === true || failure.retryable,
      });
      this.lastCreated.set(key, nowMs); // sliding window for a continuous storm
      return;
    }
    // No open card to fold into (first failure, card resolved, or the
    // window expired) — a fresh card must always be creatable here, so
    // the stale window timestamp from a previous card cannot suppress it.
    this.lastCreated.delete(key);
    this.maybeAddItem({
      taskId,
      kind: 'JournalFailure',
      priority: 'High',
      payload: {
        source: failure.source,
        reason: failure.error,
        message: failure.write
          ? `${failure.source} write failed — ${failure.error}; the row is retained for retry`
          : `${failure.source} write failed — ${failure.error}; no row was retained for retry`,
        retryable: failure.retryable,
        writes: failure.write !== undefined ? [failure.write] : [],
        failures: 1,
        droppedCount: 0,
      },
    });
  }

  /* ---------------------------------------------------------------- *
   * Event handlers
   * ---------------------------------------------------------------- */

  /** ApprovalRequested → ApprovalRequest, priority from riskLevel. */
  private addApprovalItem(event: ApprovalRequestedEvent): void {
    // Scoped approvals (issue #67): a request covered by an active grant
    // is auto-approved and journaled by the gate — no inbox item.
    if (this.approvalGate?.evaluateApprovalRequest(event) === 'auto-approved') {
      return;
    }
    const priority = riskLevelToPriority(event.riskLevel);
    this.maybeAddItem({
      taskId: event.taskId,
      kind: 'ApprovalRequest',
      priority,
      createdAt: event.timestamp,
      payload: {
        capability: event.capability,
        destination: event.destination,
        command: event.command,
        workingDir: event.workingDir,
        riskLevel: event.riskLevel,
        scope: event.scope,
        sessionId: event.sessionId,
        agentId: event.agentId,
      },
    });
  }

  /**
   * ContextHealthChanged → DegradedContext (DEC-035, issue #77).
   *
   * A degrading context is a liveness-adjacent risk — the agent is about
   * to get dumber. `critical` maps to High priority, `degraded` to
   * Medium; a recovery to `ok` is informational and does not create an
   * item (the deduped DegradedContext item ages out naturally).
   */
  private addDegradedContextItem(event: ContextHealthChangedEvent): void {
    if (event.status === 'ok') {
      return;
    }
    // Worsening health on an already-open card escalates it rather than
    // stacking a duplicate — the dedup window would otherwise swallow the
    // `degraded` → `critical` upgrade.
    if (event.status === 'critical') {
      const open = this.inbox
        .list()
        .find(
          (i) =>
            i.taskId === event.taskId &&
            i.kind === 'DegradedContext' &&
            (i.status === 'Pending' || i.status === 'Acknowledged'),
        );
      if (open !== undefined) {
        this.inbox.escalate(open.id);
        return;
      }
    }
    this.maybeAddItem({
      taskId: event.taskId,
      kind: 'DegradedContext',
      priority: event.status === 'critical' ? 'High' : 'Medium',
      createdAt: event.timestamp,
      payload: {
        status: event.status,
        windowFillPct: event.windowFillPct,
        lastCondensationAt: event.lastCondensationAt,
        details: event.details,
        sessionId: event.sessionId,
        agentId: event.agentId,
      },
    });
  }

  /** AgentFailed → FailedRun, priority High. */
  private addFailedRunItem(event: AgentFailedEvent): void {
    this.maybeAddItem({
      taskId: event.taskId,
      kind: 'FailedRun',
      priority: 'High',
      createdAt: event.timestamp,
      payload: {
        error: event.error,
        exitCode: event.exitCode,
        recoverable: event.recoverable,
        sessionId: event.sessionId,
        agentId: event.agentId,
      },
    });
  }

  /**
   * AgentCompleted → Digest (verified) or UnverifiedCompletion (DEC-032).
   *
   * "Done means proven": when a {@link VerificationGate} is configured,
   * the completion claim is assessed against journaled evidence. A
   * verified claim produces the normal `Digest` item; an unverified one
   * produces a `UnverifiedCompletion` item (High — a failure mode, not
   * a normal state) carrying the re-verification objective for routing
   * back to the worker or its manager.
   */
  private addDigestItem(event: AgentCompletedEvent): void {
    const gate = this.verificationGate;
    const assessment = gate?.gateCompletion(event.taskId, event.sessionId, event.agentId);

    if (gate !== undefined && assessment !== undefined && assessment.verdict === 'unverified') {
      this.maybeAddItem({
        taskId: event.taskId,
        kind: 'UnverifiedCompletion',
        priority: 'High',
        createdAt: event.timestamp,
        payload: {
          summary: event.summary,
          deliverables: event.deliverables,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          sessionId: event.sessionId,
          agentId: event.agentId,
          verified: false,
          evidenceCount: assessment.facts.length,
          missing: [...assessment.missing],
          verificationObjective: gate.verificationObjective(assessment),
        },
      });
      return;
    }

    this.maybeAddItem({
      taskId: event.taskId,
      kind: 'Digest',
      priority: 'Low',
      createdAt: event.timestamp,
      payload: {
        summary: event.summary,
        deliverables: event.deliverables,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        sessionId: event.sessionId,
        agentId: event.agentId,
        ...(assessment !== undefined
          ? {
              verified: assessment.verdict === 'verified',
              evidenceCount: assessment.facts.length,
            }
          : {}),
      },
    });
  }

  /* ---------------------------------------------------------------- *
   * Dedup-aware insertion
   * ---------------------------------------------------------------- */

  /**
   * Insert an item unless a duplicate (same `taskId + kind`) was created
   * within the dedup window.
   *
   * @returns the created item, or `undefined` when deduplicated away.
   */
  maybeAddItem(input: {
    readonly taskId: string;
    readonly kind: AttentionItemKind;
    readonly priority: AttentionItemPriority;
    readonly createdAt?: string;
    readonly expiresAt?: string;
    readonly payload?: Record<string, unknown>;
  }): AttentionItem | undefined {
    const key = dedupKey(input.taskId, input.kind);
    const nowMs = this.now();
    const last = this.lastCreated.get(key);
    if (last !== undefined && nowMs - last < this.dedupWindowMs) {
      // Within the dedup window — skip this duplicate.
      return undefined;
    }
    const item = createAttentionItem({
      taskId: input.taskId,
      kind: input.kind,
      priority: input.priority,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      payload: input.payload,
    });
    this.lastCreated.set(key, nowMs);
    this.inbox.add(item);
    return item;
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Build the dedup key for a task + kind pair. */
function dedupKey(taskId: string, kind: AttentionItemKind): string {
  return `${taskId}:${kind}`;
}

/**
 * Map a capability risk level to an attention item priority.
 *
 * - `critical` → `Critical`
 * - `high` → `High`
 * - `medium` → `Medium`
 * - `low` → `Low`
 */
export function riskLevelToPriority(risk: CapabilityRiskLevel): AttentionItemPriority {
  switch (risk) {
    case 'critical':
      return 'Critical';
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
    default:
      return 'Low';
  }
}
