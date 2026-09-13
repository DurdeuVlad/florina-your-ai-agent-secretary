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
  SupervisorEvent,
} from '../../../domain/events.js';
import type { CapabilityRiskLevel } from '../../../domain/capabilities.js';
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
}

/** Default deduplication window: 30 seconds. */
export const DEFAULT_DEDUP_WINDOW_MS = 30_000;

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
  private unsubscribe?: () => void;
  /** Last creation time (ms) per dedup key `${taskId}:${kind}`. */
  private readonly lastCreated = new Map<string, number>();

  constructor(inbox: AttentionInbox, bus: EventSubscriberPort, config: AttentionAggregatorConfig = {}) {
    this.inbox = inbox;
    this.bus = bus;
    this.dedupWindowMs = config.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.now = config.now ?? (() => Date.now());
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
   */
  handleEvent(event: SupervisorEvent): void {
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

  /* ---------------------------------------------------------------- *
   * Event handlers
   * ---------------------------------------------------------------- */

  /** ApprovalRequested → ApprovalRequest, priority from riskLevel. */
  private addApprovalItem(event: ApprovalRequestedEvent): void {
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

  /** AgentCompleted → Digest, priority Low. */
  private addDigestItem(event: AgentCompletedEvent): void {
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
