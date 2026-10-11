/**
 * Durable task queue (issue #343, Agent Supervision Campaign M3).
 *
 * Submission stops being spawn-or-fail: `start-task` enters a journaled
 * queue (`TaskQueued`), a scheduler drains lanes per capacity policy,
 * and every exit is journaled (`TaskDequeued`). Queue membership at any
 * instant is provable from the journal alone (DEC-012) — the in-memory
 * entries are a projection rebuilt on boot, never the source of truth:
 *
 * - **Rebuild rule**: a task is queued iff its latest `TaskQueued` is
 *   not followed by a closing event (`TaskDequeued`, `AgentStarted`,
 *   `AgentStopped`). `AgentStarted`/`AgentStopped` count so a crash
 *   between dispatch and the dequeue journal can't double-dispatch —
 *   and at-least-once beats never.
 * - **Ordering**: per-lane FIFO (`enqueuedAt` asc), with the task's
 *   declared `priority` promoting earlier entries (journaled on the
 *   enqueue event, never inferred).
 * - **Wait reason**: computed at snapshot time, never stored — "waiting:
 *   session busy" when the lane holds an active session, "waiting:
 *   provider" after a failed dispatch attempt, "waiting: quota" when
 *   the last failure classified as capacity.
 */
import type { EventJournalPort } from '../../ports/outbound/repositories.js';
import type { McpServerSpec } from '../../ports/outbound/agent-runtime.js';
import type { Event } from '../../../domain/types.js';
import type { ExecutionBrief } from '../../../domain/execution-brief.js';
import type {
  TaskQueuedEvent,
  TaskDequeuedEvent,
  TaskDequeueReason,
  SupervisorEvent,
} from '../../../domain/events.js';

/** Id generator matching the repo's prefix-scoped convention. */
function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** The provider+project lane key a task waits in (same shape as the session pool). */
export function queueKeyOf(agentId: string, projectId?: string): string {
  return `${agentId}::${projectId ?? ''}`;
}

/** The dispatch spec journaled on `TaskQueued` — everything needed to re-dispatch cold. */
export interface QueuedDispatchSpec {
  readonly workingDir: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly autonomyLevel?: string;
  readonly verifyCommands?: readonly string[];
  readonly verifyBudget?: number;
  /** Manager-role MCP servers — a queued manager task keeps its tool surface. */
  readonly mcpServers?: readonly McpServerSpec[];
  /** Compiled Execution Brief carried through the queue, when supplied. */
  readonly executionBrief?: ExecutionBrief;
  /** Caller-declared adapter tier, when supplied. */
  readonly adapterFidelityTier?: string;
}

/** A durable queue entry — journaled identity plus derived bookkeeping. */
export interface QueuedTask {
  readonly taskId: string;
  /** Run id reserved for the eventual dispatch. */
  readonly sessionId: string;
  readonly agentId: string;
  readonly projectId?: string;
  readonly queueKey: string;
  readonly priority: string;
  readonly enqueuedAt: string;
  readonly spec: QueuedDispatchSpec;
  /** Fidelity tier journaled on `TaskQueued` — re-emitted on `TaskDequeued`. */
  readonly agentTier: SupervisorEvent['adapterFidelityTier'];
  /** Most recent dispatch failure — in-memory only, never journaled. */
  readonly lastError?: string;
}

/** What a snapshot row reports for a queued task. */
export interface QueueSnapshotEntry extends QueuedTask {
  /** 1-based position within its lane after priority+FIFO ordering. */
  readonly position: number;
  /** Why the task is still waiting — computed, never inferred state. */
  readonly waitReason: string;
}

export interface TaskQueueOptions {
  readonly journal: EventJournalPort;
  /**
   * Publishes queue lifecycle events on the live bus so the journal
   * writer and subscribers see them like every supervisor event.
   * Optional: absent → journal-only.
   */
  readonly publish?: (event: SupervisorEvent) => void;
  /**
   * Whether a lane currently holds an active session. Supplied by the
   * composition root (SessionManager's live map); absent → lanes are
   * never busy.
   */
  readonly isLaneBusy?: (queueKey: string) => boolean;
  /** Idle time after which a queued task dequeues as `expired` (default 30 min). */
  readonly queuedTtlMs?: number;
  /** Injectable clock — deterministic expiry/ordering tests. */
  readonly now?: () => number;
}

const DEFAULT_QUEUE_TTL_MS = 30 * 60 * 1000;
const PRIORITY_RANK: Readonly<Record<string, number>> = {
  HIGH: 0,
  MED: 1,
  LOW: 2,
};

/**
 * The journaled task queue: enqueue/dequeue facts plus materialized
 * lane state. Dispatch decisions live in the caller (CommandApi's
 * `pumpQueue`); this class owns membership, ordering, expiry, and the
 * restart-rebuild projection.
 */
export class TaskQueue {
  private readonly journal: EventJournalPort;
  private readonly publish?: (event: SupervisorEvent) => void;
  private readonly isLaneBusy?: (queueKey: string) => boolean;
  private readonly queuedTtlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, QueuedTask>();

  constructor(options: TaskQueueOptions) {
    this.journal = options.journal;
    this.publish = options.publish;
    this.isLaneBusy = options.isLaneBusy;
    this.queuedTtlMs = options.queuedTtlMs ?? DEFAULT_QUEUE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Enter the queue: journal `TaskQueued` carrying the full dispatch
   * spec, then track the entry. Returns the entry with its reserved
   * session id — a second submission for the same task is a no-op that
   * returns the existing entry (queue membership is idempotent).
   */
  enqueue(input: {
    taskId: string;
    agentId: string;
    projectId?: string;
    priority: string;
    spec: QueuedDispatchSpec;
    agentTier: SupervisorEvent['adapterFidelityTier'];
    /** Caller-reserved run id — the pending session row uses it (FK). */
    sessionId?: string;
  }): QueuedTask {
    const existing = this.entries.get(input.taskId);
    if (existing !== undefined) {
      return existing;
    }
    const queueKey = queueKeyOf(input.agentId, input.projectId);
    const entry: QueuedTask = {
      taskId: input.taskId,
      sessionId: input.sessionId ?? generateId('session'),
      agentId: input.agentId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      queueKey,
      priority: input.priority,
      enqueuedAt: new Date(this.now()).toISOString(),
      spec: input.spec,
      agentTier: input.agentTier,
    };
    const event: TaskQueuedEvent = {
      type: 'TaskQueued',
      timestamp: entry.enqueuedAt,
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      adapterFidelityTier: input.agentTier,
      queueKey,
      priority: entry.priority,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      workingDir: input.spec.workingDir,
      ...(input.spec.prompt !== undefined ? { prompt: input.spec.prompt } : {}),
      ...(input.spec.model !== undefined ? { model: input.spec.model } : {}),
      ...(input.spec.autonomyLevel !== undefined
        ? { autonomyLevel: input.spec.autonomyLevel }
        : {}),
      ...(input.spec.verifyCommands !== undefined
        ? { verifyCommands: input.spec.verifyCommands }
        : {}),
      ...(input.spec.verifyBudget !== undefined ? { verifyBudget: input.spec.verifyBudget } : {}),
      ...(input.spec.mcpServers !== undefined ? { mcpServers: input.spec.mcpServers } : {}),
      ...(input.spec.executionBrief !== undefined
        ? { executionBrief: input.spec.executionBrief }
        : {}),
    };
    this.journalEvent(event);
    this.entries.set(entry.taskId, entry);
    return entry;
  }

  /**
   * Leave the queue: journal `TaskDequeued` with the reason and drop
   * the entry. Returns `false` when the task was not queued — dequeue
   * is honest about no-ops.
   */
  dequeue(
    taskId: string,
    reason: TaskDequeueReason,
    opts: { detail?: string; agentTier?: SupervisorEvent['adapterFidelityTier'] } = {},
  ): boolean {
    const entry = this.entries.get(taskId);
    if (entry === undefined) {
      return false;
    }
    const event: TaskDequeuedEvent = {
      type: 'TaskDequeued',
      timestamp: new Date(this.now()).toISOString(),
      taskId,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      adapterFidelityTier: opts.agentTier ?? entry.agentTier,
      queueKey: entry.queueKey,
      reason,
      ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    };
    // Journal BEFORE mutating memory — a failed write leaves the entry
    // tracked so the caller can surface the failure honestly.
    this.journalEvent(event);
    this.entries.delete(taskId);
    return true;
  }

  /** Whether the task currently sits in the queue. */
  isQueued(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  /** The queued entry for a task, when present. */
  get(taskId: string): QueuedTask | undefined {
    return this.entries.get(taskId);
  }

  /**
   * The ordered head of a lane after expiry pruning — the entry the
   * scheduler should try next, or `undefined` when the lane is empty
   * (or only held expired entries, which this call also drains).
   */
  head(queueKey: string): QueuedTask | undefined {
    this.pruneExpired();
    return this.lane(queueKey)[0];
  }

  /** All queued tasks in a lane, in schedule order (priority desc, FIFO). */
  lane(queueKey: string): readonly QueuedTask[] {
    return [...this.entries.values()]
      .filter((e) => e.queueKey === queueKey)
      .sort(compareQueueOrder);
  }

  /**
   * The materialized queue: every entry with its 1-based lane position
   * and computed wait reason. Reasons are facts derived from live state
   * (lane busy, last dispatch failure, expiry pending), never stored.
   */
  snapshot(): QueueSnapshotEntry[] {
    this.pruneExpired();
    const lanes = new Map<string, QueuedTask[]>();
    for (const entry of this.entries.values()) {
      const list = lanes.get(entry.queueKey) ?? [];
      list.push(entry);
      lanes.set(entry.queueKey, list);
    }
    const out: QueueSnapshotEntry[] = [];
    for (const [key, lane] of lanes) {
      lane.sort(compareQueueOrder);
      const busy = this.isLaneBusy?.(key) === true;
      lane.forEach((entry, i) => {
        out.push({
          ...entry,
          position: i + 1,
          waitReason: waitReasonFor(entry, busy, i),
        });
      });
    }
    return out.sort(compareQueueOrder);
  }

  /** Record a failed dispatch attempt — the error tail becomes the wait reason. */
  recordDispatchFailure(taskId: string, error: string): void {
    const entry = this.entries.get(taskId);
    if (entry !== undefined) {
      this.entries.set(taskId, { ...entry, lastError: error });
    }
  }

  /** Clear the dispatch-failure mark after a successful attempt. */
  clearDispatchFailure(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (entry !== undefined && entry.lastError !== undefined) {
      const { lastError: _, ...rest } = entry;
      this.entries.set(taskId, rest);
    }
  }

  /** Distinct lanes currently holding entries — the scheduler's pump set. */
  laneKeys(): readonly string[] {
    return [...new Set([...this.entries.values()].map((e) => e.queueKey))];
  }

  /** Queue size — visibility for status surfaces and tests. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Rebuild queue membership from the journal (DEC-012): scan queue
   * lifecycle events in time order and fold — latest `TaskQueued` with
   * no closing event re-enters the queue; `TaskDequeued`, `AgentStarted`,
   * and `AgentStopped` close it. Called once at daemon boot.
   */
  rebuild(): void {
    this.entries.clear();
    const events = this.journal.listByTimestampRange(
      new Date(0).toISOString(),
      new Date(this.now()).toISOString(),
    );
    // Closing kinds per task: dequeue, or evidence the task already
    // left the queue another way (dispatched or stopped pre-rebuild).
    const open = new Map<string, Event>();
    for (const event of events) {
      switch (event.kind) {
        case 'TaskQueued': {
          open.set(event.taskId, event);
          break;
        }
        case 'TaskDequeued':
        case 'AgentStarted':
        case 'AgentStopped': {
          open.delete(event.taskId);
          break;
        }
        default:
          break;
      }
    }
    for (const event of open.values()) {
      const p = event.payload;
      this.entries.set(event.taskId, {
        taskId: event.taskId,
        sessionId: event.sessionId,
        agentId: typeof p['agentId'] === 'string' ? p['agentId'] : '',
        ...(typeof p['projectId'] === 'string' ? { projectId: p['projectId'] } : {}),
        queueKey: typeof p['queueKey'] === 'string' ? p['queueKey'] : '',
        priority: typeof p['priority'] === 'string' ? p['priority'] : 'MED',
        enqueuedAt: event.timestamp,
        agentTier:
          typeof p['adapterFidelityTier'] === 'string'
            ? (p['adapterFidelityTier'] as SupervisorEvent['adapterFidelityTier'])
            : 'E',
        spec: {
          workingDir: typeof p['workingDir'] === 'string' ? p['workingDir'] : '',
          ...(typeof p['prompt'] === 'string' ? { prompt: p['prompt'] } : {}),
          ...(typeof p['model'] === 'string' ? { model: p['model'] } : {}),
          ...(typeof p['autonomyLevel'] === 'string' ? { autonomyLevel: p['autonomyLevel'] } : {}),
          ...(Array.isArray(p['verifyCommands'])
            ? { verifyCommands: p['verifyCommands'] as readonly string[] }
            : {}),
          ...(typeof p['verifyBudget'] === 'number' ? { verifyBudget: p['verifyBudget'] } : {}),
          ...(Array.isArray(p['mcpServers'])
            ? { mcpServers: p['mcpServers'] as readonly McpServerSpec[] }
            : {}),
          ...(typeof p['executionBrief'] === 'object' && p['executionBrief'] !== null
            ? { executionBrief: p['executionBrief'] as ExecutionBrief }
            : {}),
        },
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  /** Drop entries older than the TTL — journaled as `expired`. */
  private pruneExpired(): void {
    const cutoff = this.now() - this.queuedTtlMs;
    for (const entry of [...this.entries.values()]) {
      if (Date.parse(entry.enqueuedAt) < cutoff) {
        this.dequeue(entry.taskId, 'expired', {
          detail: `queued longer than ${this.queuedTtlMs}ms without dispatch`,
        });
      }
    }
  }

  /**
   * Journal then publish a queue lifecycle event. A failed journal
   * write throws — durability is the queue's whole contract, so a
   * caller must see the failure and roll back rather than let an
   * in-memory entry masquerade as persistent. Bus publish failures are
   * non-fatal (the journal holds the record).
   */
  private journalEvent(event: SupervisorEvent): void {
    this.journal.insert(eventToRow(event));
    try {
      this.publish?.(event);
    } catch {
      /* the journal holds the record; a bus hiccup is non-fatal */
    }
  }
}

/** Schedule order: declared priority first (journaled), then FIFO. */
function compareQueueOrder(a: QueuedTask, b: QueuedTask): number {
  const pa = PRIORITY_RANK[a.priority] ?? 1;
  const pb = PRIORITY_RANK[b.priority] ?? 1;
  if (pa !== pb) {
    return pa - pb;
  }
  if (a.enqueuedAt !== b.enqueuedAt) {
    return a.enqueuedAt < b.enqueuedAt ? -1 : 1;
  }
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/** The computed wait reason — a derived fact, never stored state. */
function waitReasonFor(entry: QueuedTask, laneBusy: boolean, laneIndex: number): string {
  if (laneBusy) {
    return 'waiting: session busy';
  }
  if (entry.lastError !== undefined) {
    const quotaish = /quota|capacity|rate.?limit/i.test(entry.lastError);
    return quotaish
      ? `waiting: quota — ${entry.lastError}`
      : `waiting: provider — ${entry.lastError}`;
  }
  return laneIndex === 0 ? 'waiting: dispatch' : 'waiting: behind higher-priority task';
}

/**
 * Project a SupervisorEvent into the journal row shape — same envelope
 * convention as `supervisorEventToJournalRow` (kind from `type`, every
 * typed field retained in payload for re-expansion).
 */
function eventToRow(event: SupervisorEvent): Event {
  const { type, timestamp, taskId, sessionId, agentId, adapterFidelityTier, ...rest } = event;
  return {
    id: generateId('evt'),
    taskId,
    sessionId,
    timestamp,
    kind: type,
    payload: { taskId, sessionId, agentId, adapterFidelityTier, ...rest },
  };
}
