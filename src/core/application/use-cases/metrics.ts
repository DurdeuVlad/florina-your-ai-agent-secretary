/**
 * Runtime metrics instrumentation (DEC-015, issue #18).
 *
 * {@link MetricsCollector} subscribes to the daemon {@link EventBus} and
 * derives counters, gauges, and histograms from the live `SupervisorEvent`
 * stream. All metrics are held in memory; {@link MetricsCollector.snapshot}
 * returns a serializable {@link MetricsSnapshot} that can be persisted to
 * SQLite via {@link MetricsRepository} (time-series) or surfaced on any of the
 * four client surfaces.
 *
 * Metric families:
 * - **Counters** (monotonically increasing): events emitted by type, tasks
 *   started/completed/failed, approvals requested/granted/denied, tools
 *   invoked by tool name.
 * - **Gauges** (current point-in-time value): active sessions, pending
 *   approvals, inbox size, pending attention items.
 * - **Histograms** (distribution of durations): task duration
 *   (`AgentStarted` → `AgentCompleted`/`AgentFailed`), approval response time
 *   (`ApprovalRequested` → granted/denied), tool duration
 *   (`ToolStarted` → `ToolFinished`).
 *
 * The north-star Attention Compression Ratio (DEC-015) is computed elsewhere
 * from the event journal; these supplemental metrics give operators live
 * visibility into throughput, latency, and approval load without recomputing
 * from source events.
 */
import type { SupervisorEvent } from '../../domain/events.js';
import type { EventSubscriberPort } from '../ports/outbound/event-stream.js';

/* ------------------------------------------------------------------ *
 * Histogram types
 * ------------------------------------------------------------------ */

/**
 * Default upper-bound buckets (in milliseconds) used for every histogram.
 * Durations are placed into the first bucket whose upper bound is >= the
 * value. The final `Infinity` bucket captures overflow.
 */
export const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = [
  100,
  500,
  1000,
  5000,
  10_000,
  30_000,
  60_000,
  300_000,
  Infinity,
] as const;

/**
 * Serializable summary of a histogram's recorded observations.
 */
export interface HistogramSummary {
  /** Number of observations recorded. */
  readonly count: number;
  /** Minimum observed value in milliseconds, or 0 when count is 0. */
  readonly min: number;
  /** Maximum observed value in milliseconds. */
  readonly max: number;
  /** Arithmetic mean of all observations in milliseconds. */
  readonly mean: number;
  /** Sum of all observations in milliseconds. */
  readonly sum: number;
  /**
   * Cumulative bucket counts keyed by upper-bound label (e.g. `"100"`,
   * `"500"`, `"+Inf"`). Each bucket includes all observations <= its upper
   * bound (cumulative, Prometheus-style).
   */
  readonly buckets: Readonly<Record<string, number>>;
}

/**
 * In-memory histogram with fixed buckets and running aggregates.
 */
class Histogram {
  private count = 0;
  private min = Infinity;
  private max = 0;
  private sum = 0;
  private readonly bucketUpperBounds: readonly number[];
  private readonly bucketCounts: number[];

  constructor(buckets: readonly number[] = DEFAULT_HISTOGRAM_BUCKETS) {
    this.bucketUpperBounds = buckets;
    this.bucketCounts = new Array(buckets.length).fill(0);
  }

  /** Record a single observation (duration in milliseconds). */
  observe(valueMs: number): void {
    if (valueMs < 0) return;
    this.count++;
    this.sum += valueMs;
    if (valueMs < this.min) this.min = valueMs;
    if (valueMs > this.max) this.max = valueMs;
    for (let i = 0; i < this.bucketUpperBounds.length; i++) {
      if (valueMs <= this.bucketUpperBounds[i]) {
        this.bucketCounts[i]++;
        break;
      }
    }
  }

  /** Return a serializable summary of the current observations. */
  summary(): HistogramSummary {
    const buckets: Record<string, number> = {};
    let cumulative = 0;
    for (let i = 0; i < this.bucketUpperBounds.length; i++) {
      cumulative += this.bucketCounts[i];
      const bound = this.bucketUpperBounds[i];
      const label = bound === Infinity ? '+Inf' : String(bound);
      buckets[label] = cumulative;
    }
    return {
      count: this.count,
      min: this.count === 0 ? 0 : this.min,
      max: this.max,
      mean: this.count === 0 ? 0 : this.sum / this.count,
      sum: this.sum,
      buckets,
    };
  }

  /** Reset the histogram to its initial empty state. */
  reset(): void {
    this.count = 0;
    this.min = Infinity;
    this.max = 0;
    this.sum = 0;
    this.bucketCounts.fill(0);
  }
}

/* ------------------------------------------------------------------ *
 * Snapshot types
 * ------------------------------------------------------------------ */

/**
 * Serializable snapshot of all collected metrics at a point in time.
 *
 * Produced by {@link MetricsCollector.snapshot}; safe to `JSON.stringify` and
 * persist via {@link MetricsRepository.saveSnapshot}.
 */
export interface MetricsSnapshot {
  /** ISO-8601 timestamp at which the snapshot was taken. */
  readonly timestamp: string;
  /** Monotonically increasing counters. */
  readonly counters: {
    /** Total events emitted, keyed by `SupervisorEvent` type. */
    readonly eventsEmitted: Readonly<Record<string, number>>;
    /** Number of `AgentStarted` events observed. */
    readonly tasksStarted: number;
    /** Number of `AgentCompleted` events observed. */
    readonly tasksCompleted: number;
    /** Number of `AgentFailed` events observed. */
    readonly tasksFailed: number;
    /** Number of `ApprovalRequested` events observed. */
    readonly approvalsRequested: number;
    /** Number of approvals granted (via `recordApprovalGranted`). */
    readonly approvalsGranted: number;
    /** Number of approvals denied (via `recordApprovalDenied`). */
    readonly approvalsDenied: number;
    /** Tool invocations observed, keyed by tool name. */
    readonly toolsInvoked: Readonly<Record<string, number>>;
    /**
     * `ContextHealthChanged` observations, keyed by status
     * (DEC-035, issue #77) — a rising degraded/critical count tracks
     * how often agents are running on exhausted context windows.
     */
    readonly contextHealthByStatus: Readonly<Record<string, number>>;
  };
  /** Current point-in-time gauges. */
  readonly gauges: {
    /** Currently active agent sessions (started but not yet terminated). */
    readonly activeSessions: number;
    /** Approval requests awaiting a human decision. */
    readonly pendingApprovals: number;
    /** Total items in the attention inbox (all statuses). */
    readonly inboxSize: number;
    /** Pending (unresolved) attention items. */
    readonly attentionItemsPending: number;
  };
  /** Duration histograms. */
  readonly histograms: {
    /** `AgentStarted` → `AgentCompleted` / `AgentFailed` duration. */
    readonly taskDuration: HistogramSummary;
    /** `ApprovalRequested` → granted / denied duration. */
    readonly approvalResponseTime: HistogramSummary;
    /** `ToolStarted` → `ToolFinished` duration. */
    readonly toolDuration: HistogramSummary;
  };
  /**
   * Supervision-ladder model-call cost (§7, issue #194/#203) — the
   * empirical check for the cost-bounded design claim: rule count and
   * concurrent task count should not translate into a proportional
   * explosion of model calls. Recorded explicitly via
   * {@link MetricsCollector.recordSupervisionStage} (the ladder/compiler
   * are pure functions, not bus events — same pattern as approval
   * granted/denied).
   */
  readonly supervisionCost: {
    /** Model calls per pipeline stage, summed across all tasks. */
    readonly modelCallsByStage: Readonly<Record<SupervisionStage, number>>;
    /** Total model calls per task, across every stage. */
    readonly modelCallsByTask: Readonly<Record<string, number>>;
  };
}

/**
 * The supervision-ladder pipeline stages this metric tracks (§7's table):
 * L0 (deterministic) makes no model call and is intentionally absent here.
 */
export type SupervisionStage =
  | 'l1-classification'
  | 'execution-brief-compile'
  | 'l2-manager-reasoning'
  | 'l3-florina-reasoning';

const SUPERVISION_STAGES: readonly SupervisionStage[] = [
  'l1-classification',
  'execution-brief-compile',
  'l2-manager-reasoning',
  'l3-florina-reasoning',
];

/* ------------------------------------------------------------------ *
 * MetricsCollector
 * ------------------------------------------------------------------ */

/**
 * Options for constructing a {@link MetricsCollector}.
 */
export interface MetricsCollectorOptions {
  /**
   * Time provider used for snapshot timestamps and gauge sampling. Defaults to
   * `Date.now`. Overridable for deterministic tests.
   */
  readonly now?: () => number;
  /**
   * Provider for the `inboxSize` gauge. When omitted the gauge reports 0.
   * Decouples the collector from the {@link AttentionInbox} implementation.
   */
  readonly inboxSizeProvider?: () => number;
  /**
   * Provider for the `attentionItemsPending` gauge. When omitted the gauge
   * reports 0.
   */
  readonly attentionItemsPendingProvider?: () => number;
  /**
   * Custom histogram buckets (milliseconds). Defaults to
   * {@link DEFAULT_HISTOGRAM_BUCKETS}.
   */
  readonly buckets?: readonly number[];
}

/**
 * Collects runtime metrics from the daemon {@link EventBus}.
 *
 * The collector subscribes to the event stream on construction (via
 * {@link MetricsCollector.attach}) and derives counters, gauges, and
 * histograms from the live `SupervisorEvent` flow. Approval resolutions
 * (granted/denied) are not part of the canonical event union (DEC-019), so
 * they are recorded explicitly via {@link MetricsCollector.recordApprovalGranted}
 * and {@link MetricsCollector.recordApprovalDenied} — typically called from
 * the control-plane approval handler.
 *
 * All state is in memory; call {@link MetricsCollector.snapshot} for a
 * serializable point-in-time copy and {@link MetricsCollector.reset} to clear.
 */
export class MetricsCollector {
  // --- Counters -------------------------------------------------------
  private readonly eventsEmitted = new Map<string, number>();
  private tasksStarted = 0;
  private tasksCompleted = 0;
  private tasksFailed = 0;
  private approvalsRequested = 0;
  private approvalsGranted = 0;
  private approvalsDenied = 0;
  private readonly toolsInvoked = new Map<string, number>();
  private readonly contextHealthByStatus = new Map<string, number>();
  private readonly supervisionCallsByStage = new Map<SupervisionStage, number>();
  private readonly supervisionCallsByTask = new Map<string, number>();

  // --- Gauges ---------------------------------------------------------
  private activeSessions = 0;
  private pendingApprovals = 0;

  // --- Histograms -----------------------------------------------------
  private readonly taskDuration: Histogram;
  private readonly approvalResponseTime: Histogram;
  private readonly toolDuration: Histogram;

  // --- In-flight tracking --------------------------------------------
  /** `AgentStarted` timestamp (ms) keyed by taskId, for taskDuration. */
  private readonly taskStarts = new Map<string, number>();
  /** `ApprovalRequested` timestamp (ms) keyed by taskId, for approvalResponseTime. */
  private readonly approvalStarts = new Map<string, number>();
  /** `ToolStarted` timestamp (ms) keyed by `${sessionId}:${toolName}`, for toolDuration. */
  private readonly toolStarts = new Map<string, number>();

  private readonly now: () => number;
  private readonly inboxSizeProvider: () => number;
  private readonly attentionItemsPendingProvider: () => number;
  private unsubscribe: (() => void) | null = null;

  constructor(options: MetricsCollectorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.inboxSizeProvider = options.inboxSizeProvider ?? (() => 0);
    this.attentionItemsPendingProvider = options.attentionItemsPendingProvider ?? (() => 0);
    const buckets = options.buckets ?? DEFAULT_HISTOGRAM_BUCKETS;
    this.taskDuration = new Histogram(buckets);
    this.approvalResponseTime = new Histogram(buckets);
    this.toolDuration = new Histogram(buckets);
  }

  /**
   * Subscribe the collector to an {@link EventBus}. Returns an unsubscribe
   * function. Calling {@link detach} also unsubscribes.
   */
  attach(bus: EventSubscriberPort): () => void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
    }
    this.unsubscribe = bus.onEvent((event) => this.handleEvent(event));
    return () => this.detach();
  }

  /** Unsubscribe from the event bus (no-op if not attached). */
  detach(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Record an approval being granted for a task.
   *
   * Computes the approval response time from the most recent
   * `ApprovalRequested` for the task and decrements the pending-approvals
   * gauge.
   */
  recordApprovalGranted(taskId: string): void {
    this.approvalsGranted++;
    this.resolveApproval(taskId);
  }

  /**
   * Record an approval being denied for a task.
   *
   * Computes the approval response time from the most recent
   * `ApprovalRequested` for the task and decrements the pending-approvals
   * gauge.
   */
  recordApprovalDenied(taskId: string): void {
    this.approvalsDenied++;
    this.resolveApproval(taskId);
  }

  /**
   * Record one model call at a supervision-ladder pipeline stage for a
   * task (§7, issue #203). Call this from wherever the ladder/compiler
   * actually invokes a model — the ladder and compiler themselves are
   * pure functions with no metrics dependency (DEC-014's "deterministic
   * first" — instrumentation lives at the call site, not inside the
   * pure decision logic).
   */
  recordSupervisionStage(stage: SupervisionStage, taskId: string): void {
    this.supervisionCallsByStage.set(stage, (this.supervisionCallsByStage.get(stage) ?? 0) + 1);
    this.supervisionCallsByTask.set(taskId, (this.supervisionCallsByTask.get(taskId) ?? 0) + 1);
  }

  /**
   * Return a serializable snapshot of all metrics at the current instant.
   */
  snapshot(): MetricsSnapshot {
    return {
      timestamp: new Date(this.now()).toISOString(),
      counters: {
        eventsEmitted: { ...this.mapToRecord(this.eventsEmitted) },
        tasksStarted: this.tasksStarted,
        tasksCompleted: this.tasksCompleted,
        tasksFailed: this.tasksFailed,
        approvalsRequested: this.approvalsRequested,
        approvalsGranted: this.approvalsGranted,
        approvalsDenied: this.approvalsDenied,
        toolsInvoked: { ...this.mapToRecord(this.toolsInvoked) },
        contextHealthByStatus: { ...this.mapToRecord(this.contextHealthByStatus) },
      },
      gauges: {
        activeSessions: this.activeSessions,
        pendingApprovals: this.pendingApprovals,
        inboxSize: this.inboxSizeProvider(),
        attentionItemsPending: this.attentionItemsPendingProvider(),
      },
      histograms: {
        taskDuration: this.taskDuration.summary(),
        approvalResponseTime: this.approvalResponseTime.summary(),
        toolDuration: this.toolDuration.summary(),
      },
      supervisionCost: {
        modelCallsByStage: this.supervisionCallsByStageRecord(),
        modelCallsByTask: { ...this.mapToRecord(this.supervisionCallsByTask) },
      },
    };
  }

  /** Every stage present in the record, even at 0 — a missing key reads ambiguously as "never happened" vs "zero." */
  private supervisionCallsByStageRecord(): Record<SupervisionStage, number> {
    const record = {} as Record<SupervisionStage, number>;
    for (const stage of SUPERVISION_STAGES) {
      record[stage] = this.supervisionCallsByStage.get(stage) ?? 0;
    }
    return record;
  }

  /** Clear all collected metrics and in-flight tracking state. */
  reset(): void {
    this.eventsEmitted.clear();
    this.toolsInvoked.clear();
    this.contextHealthByStatus.clear();
    this.supervisionCallsByStage.clear();
    this.supervisionCallsByTask.clear();
    this.tasksStarted = 0;
    this.tasksCompleted = 0;
    this.tasksFailed = 0;
    this.approvalsRequested = 0;
    this.approvalsGranted = 0;
    this.approvalsDenied = 0;
    this.activeSessions = 0;
    this.pendingApprovals = 0;
    this.taskDuration.reset();
    this.approvalResponseTime.reset();
    this.toolDuration.reset();
    this.taskStarts.clear();
    this.approvalStarts.clear();
    this.toolStarts.clear();
  }

  /* ---------------------------------------------------------------- *
   * Internal event handling
   * ---------------------------------------------------------------- */

  /**
   * Process a single supervisor event, updating counters, gauges, and
   * histograms as appropriate.
   */
  private handleEvent(event: SupervisorEvent): void {
    // Counter: events emitted by type.
    this.incrementMap(this.eventsEmitted, event.type);

    const ts = Date.parse(event.timestamp);

    switch (event.type) {
      case 'AgentStarted':
        this.tasksStarted++;
        this.activeSessions++;
        if (!Number.isNaN(ts)) this.taskStarts.set(event.taskId, ts);
        break;

      case 'AgentCompleted':
        this.tasksCompleted++;
        this.activeSessions = Math.max(0, this.activeSessions - 1);
        this.recordTaskDuration(event.taskId, ts);
        break;

      case 'AgentFailed':
        this.tasksFailed++;
        this.activeSessions = Math.max(0, this.activeSessions - 1);
        // AgentFailed also records task duration (edge case per issue).
        this.recordTaskDuration(event.taskId, ts);
        break;

      case 'AgentStopped':
        this.activeSessions = Math.max(0, this.activeSessions - 1);
        this.taskStarts.delete(event.taskId);
        break;

      case 'ApprovalRequested':
        this.approvalsRequested++;
        this.pendingApprovals++;
        // Record the start on the collector's clock so the response time is
        // measured against the same clock used on grant/deny.
        this.approvalStarts.set(event.taskId, this.now());
        break;

      case 'ToolStarted':
        this.incrementMap(this.toolsInvoked, event.toolName);
        if (!Number.isNaN(ts)) {
          this.toolStarts.set(this.toolKey(event.sessionId, event.toolName), ts);
        }
        break;

      case 'ToolFinished':
        this.recordToolDuration(event.sessionId, event.toolName, ts);
        break;

      case 'ContextHealthChanged':
        this.incrementMap(this.contextHealthByStatus, event.status);
        break;

      default:
        // Other event types only contribute to the eventsEmitted counter.
        break;
    }
  }

  /** Compute and record task duration from a stored start timestamp. */
  private recordTaskDuration(taskId: string, endTs: number): void {
    const startTs = this.taskStarts.get(taskId);
    this.taskStarts.delete(taskId);
    if (startTs !== undefined && !Number.isNaN(endTs) && endTs >= startTs) {
      this.taskDuration.observe(endTs - startTs);
    }
  }

  /** Compute and record tool duration from a stored start timestamp. */
  private recordToolDuration(sessionId: string, toolName: string, endTs: number): void {
    const key = this.toolKey(sessionId, toolName);
    const startTs = this.toolStarts.get(key);
    this.toolStarts.delete(key);
    if (startTs !== undefined && !Number.isNaN(endTs) && endTs >= startTs) {
      this.toolDuration.observe(endTs - startTs);
    }
  }

  /** Resolve a pending approval: record response time, decrement gauge. */
  private resolveApproval(taskId: string): void {
    const startTs = this.approvalStarts.get(taskId);
    this.approvalStarts.delete(taskId);
    const endTs = this.now();
    if (startTs !== undefined && endTs >= startTs) {
      this.approvalResponseTime.observe(endTs - startTs);
    }
    this.pendingApprovals = Math.max(0, this.pendingApprovals - 1);
  }

  /** Build a composite key for in-flight tool tracking. */
  private toolKey(sessionId: string, toolName: string): string {
    return `${sessionId}:${toolName}`;
  }

  /** Increment a counter map entry by 1. */
  private incrementMap(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  /** Convert a Map<string, number> to a plain record. */
  private mapToRecord(map: Map<string, number>): Record<string, number> {
    const record: Record<string, number> = {};
    for (const [key, value] of map) {
      record[key] = value;
    }
    return record;
  }
}

/**
 * Result of {@link checkSupervisionCostDiscipline}.
 */
export interface SupervisionCostCheck {
  readonly ok: boolean;
  /** Present only when `ok` is `false` — explains which invariant broke. */
  readonly reason?: string;
}

/**
 * The specific failure mode §7 is designed to prevent: L1 (cheap
 * classification) is supposed to fire only on events L0 already flagged
 * as ambiguous — a *subset* of total event volume, never more. If
 * L1 call count ever exceeds total events emitted, classification is
 * structurally running more than once per event (or on events that were
 * never emitted), which is exactly "L1-classification call volume
 * growing faster than event volume." A documented manual process for
 * the harder trend-over-time question (is the *ratio* creeping up
 * release over release) is described in this function's doc rather than
 * automated here — that needs historical snapshots this single-point
 * check doesn't have.
 */
export function checkSupervisionCostDiscipline(snapshot: MetricsSnapshot): SupervisionCostCheck {
  const totalEvents = Object.values(snapshot.counters.eventsEmitted).reduce((a, b) => a + b, 0);
  const l1Calls = snapshot.supervisionCost.modelCallsByStage['l1-classification'];
  if (l1Calls > totalEvents) {
    return {
      ok: false,
      reason: `L1 classification calls (${l1Calls}) exceed total events emitted (${totalEvents}) — L1 must fire on a subset of events, never more.`,
    };
  }
  return { ok: true };
}
