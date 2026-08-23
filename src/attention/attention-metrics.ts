/**
 * Attention Compression Ratio (ACR) and supplemental metrics computation
 * (DEC-015, issue #18).
 *
 * The north-star metric — **Attention Compression Ratio** — and the seven
 * supplemental metrics defined in `BUSINESS.md` / DEC-015 are computed here
 * from the stored event journal and the attention items it produced. Every
 * computation is **deterministic** and requires **no LLM calls**: the inputs
 * are the canonical `SupervisorEvent` stream, the surfaced
 * {@link AttentionItem}s, per-item {@link AttentionItemResolution} records,
 * and {@link ApprovalExecutionPair} records that pair an approved capability
 * request with what the adapter actually executed.
 *
 * Metric families:
 *
 * - **ACR** (north-star): `classifiable agent events processed by the
 *   attention engine / actual human interruptions surfaced`.
 * - **Supplemental**:
 *   1. Human interventions per agent-hour.
 *   2. Mean blocked time awaiting developer (ms).
 *   3. Completion-to-review latency (ms).
 *   4. Minutes of human review per completed task.
 *   5. % attention items resolved without opening the agent terminal.
 *   6. False-negative attention rate.
 *   7. False-positive interruption rate.
 *   8. Incorrect approval representation rate (security-critical, ~zero).
 *
 * The {@link AttentionMetricsComputer} is a pure, side-effect-free calculator.
 * {@link MetricsQueryService} is the query API that retrieves inputs for a
 * time window, project, or task and delegates to the computer.
 * {@link MetricsRecorder} is the event-hook sink that records the per-item
 * resolution and approval-execution datapoints that are not already part of
 * the canonical event journal.
 */
import type { SupervisorEvent } from '../domain/events.js';
import type { CapabilityRequest } from '../domain/capabilities.js';
import type { AdapterFidelityTier } from '../domain/enums.js';
import type { AttentionItem, AttentionItemKind } from './attention-item.js';
import { AttentionEngine, type AttentionAction } from './engine.js';

/* ------------------------------------------------------------------ *
 * Input / output types
 * ------------------------------------------------------------------ */

/**
 * A per-item resolution record capturing the lifecycle timestamps and whether
 * the human opened the agent terminal to resolve it.
 *
 * These datapoints are not part of the canonical `SupervisorEvent` union;
 * they are recorded by the {@link MetricsRecorder} event hooks when the
 * inbox acknowledges / resolves an item.
 */
export interface AttentionItemResolution {
  /** Stable identifier matching the {@link AttentionItem.id}. */
  readonly itemId: string;
  /** Task the item belongs to. */
  readonly taskId: string;
  /** Attention item kind. */
  readonly kind: AttentionItemKind;
  /** ISO-8601 timestamp the item was created (surfaced to the human). */
  readonly createdAt: string;
  /** ISO-8601 timestamp the human first acknowledged the item, if any. */
  readonly acknowledgedAt?: string;
  /** ISO-8601 timestamp the item was resolved, if any. */
  readonly resolvedAt?: string;
  /**
   * Whether resolving the item required opening the agent terminal. Used for
   * the "% resolved without opening agent terminal" supplemental metric.
   */
  readonly openedTerminal: boolean;
}

/**
 * A pair pairing the approved capability request with the capability the
 * adapter actually executed (DEC-010, security-critical).
 *
 * The incorrect-approval-representation rate compares the deterministic
 * structured fields of `approved` against `executed`. Any field mismatch is a
 * representation failure: the human authorized one capability and the adapter
 * executed another. This rate must trend to ~zero.
 */
export interface ApprovalExecutionPair {
  /** Task the approval belongs to. */
  readonly taskId: string;
  /** The exact capability request the human authorized. */
  readonly approved: CapabilityRequest;
  /** The capability request the adapter actually executed. */
  readonly executed: CapabilityRequest;
  /** ISO-8601 timestamp of the execution. */
  readonly timestamp: string;
}

/**
 * The full input bundle for {@link computeAttentionMetrics}.
 *
 * All collections are scoped to the same query window / project / task by the
 * caller; the computer itself applies no filtering.
 */
export interface AttentionMetricsInput {
  /** Classifiable agent events processed by the attention engine. */
  readonly events: readonly SupervisorEvent[];
  /** Attention items surfaced to the human (actual interruptions). */
  readonly attentionItems: readonly AttentionItem[];
  /** Per-item resolution datapoints (lifecycle + terminal usage). */
  readonly resolutions: readonly AttentionItemResolution[];
  /** Approved-vs-executed capability pairs (security audit). */
  readonly approvalExecutionPairs: readonly ApprovalExecutionPair[];
  /**
   * Adapter fidelity tier to use when re-classifying events through the
   * attention engine for false-negative / false-positive detection. Defaults
   * to `'A'` when omitted.
   */
  readonly fidelityTier?: AdapterFidelityTier;
}

/**
 * The computed attention metrics report (DEC-015).
 *
 * Every rate/ratio field is `null` when its denominator is zero (not
 * computable for the given window). The raw `counts` are always populated so
 * callers can derive their own ratios.
 */
export interface AttentionMetricsReport {
  /** The query window the report was computed for (echoed from input). */
  readonly window: { readonly start?: string; readonly end?: string };
  /** North-star: Attention Compression Ratio. `null` when no interruptions. */
  readonly acr: number | null;
  /** The seven (eight, counting the security-critical one) supplemental metrics. */
  readonly supplemental: {
    /** 1. Human interventions per agent-hour. `null` when no agent-hours. */
    readonly humanInterventionsPerAgentHour: number | null;
    /** 2. Mean blocked time awaiting developer (ms). `null` when no approvals resolved. */
    readonly meanBlockedTimeAwaitingDeveloperMs: number | null;
    /** 3. Completion-to-review latency (ms). `null` when no reviewed completions. */
    readonly completionToReviewLatencyMs: number | null;
    /** 4. Minutes of human review per completed task. `0` when no completions. */
    readonly minutesOfHumanReviewPerCompletedTask: number;
    /**
     * 5. % attention items resolved without opening the agent terminal.
     * `null` when no resolved items.
     */
    readonly percentResolvedWithoutTerminal: number | null;
    /** 6. False-negative attention rate [0,1]. `null` when no should-surface events. */
    readonly falseNegativeAttentionRate: number | null;
    /** 7. False-positive interruption rate [0,1]. `null` when no event-sourced items. */
    readonly falsePositiveInterruptionRate: number | null;
    /**
     * 8. Incorrect approval representation rate [0,1] (security-critical).
     * `null` when no approval-execution pairs.
     */
    readonly incorrectApprovalRepresentationRate: number | null;
  };
  /** Raw counts backing every derived metric. */
  readonly counts: {
    /** Total classifiable agent events processed by the attention engine. */
    readonly classifiableEvents: number;
    /** Actual human interruptions surfaced (attention items in window). */
    readonly humanInterruptions: number;
    /** Total agent active time in hours. */
    readonly agentHours: number;
    /** Human interventions (resolved attention items). */
    readonly humanInterventions: number;
    /** Number of completed tasks (`AgentCompleted` events). */
    readonly completedTasks: number;
    /** Number of approval resolutions used for blocked-time mean. */
    readonly approvalResolutions: number;
    /** Number of completions with a review-latency datapoint. */
    readonly reviewedCompletions: number;
    /** Number of resolved attention items. */
    readonly resolvedItems: number;
    /** Number resolved without opening the agent terminal. */
    readonly resolvedWithoutTerminal: number;
    /** Events the engine classified as should-surface (always-surface/elevate). */
    readonly shouldSurfaceEvents: number;
    /** Should-surface events with no matching attention item (missed). */
    readonly falseNegatives: number;
    /** Event-sourced attention items (ApprovalRequest/FailedRun/Digest). */
    readonly eventSourcedItems: number;
    /** Event-sourced items with no matching should-surface event (spurious). */
    readonly falsePositives: number;
    /** Total approval-execution pairs audited. */
    readonly approvalExecutionPairs: number;
    /** Pairs where approved fields differ from executed fields. */
    readonly incorrectApprovalRepresentations: number;
  };
}

/* ------------------------------------------------------------------ *
 * Query API types
 * ------------------------------------------------------------------ */

/** Query filter for retrieving metrics for a time window, project, or task. */
export interface MetricsQueryOptions {
  /** ISO-8601 lower bound (inclusive). */
  readonly since?: string;
  /** ISO-8601 upper bound (inclusive). */
  readonly until?: string;
  /** Restrict to a project. */
  readonly projectId?: string;
  /** Restrict to a single task. */
  readonly taskId?: string;
}

/**
 * Sources the {@link MetricsQueryService} consults to gather inputs for a
 * query. Each source applies the supplied {@link MetricsQueryOptions} filter
 * itself and returns the matching records in chronological order.
 */
export interface MetricsQuerySources {
  /** List classifiable events matching the filter. */
  readonly listEvents: (opts: MetricsQueryOptions) => readonly SupervisorEvent[];
  /** List attention items matching the filter. */
  readonly listAttentionItems: (opts: MetricsQueryOptions) => readonly AttentionItem[];
  /** List per-item resolutions matching the filter. */
  readonly listResolutions: (opts: MetricsQueryOptions) => readonly AttentionItemResolution[];
  /** List approval-execution pairs matching the filter. */
  readonly listApprovalExecutionPairs: (
    opts: MetricsQueryOptions,
  ) => readonly ApprovalExecutionPair[];
}

/* ------------------------------------------------------------------ *
 * Constants & helpers
 * ------------------------------------------------------------------ */

/** Event types the {@link AttentionAggregator} maps to inbox items. */
const EVENT_SOURCED_KIND_MAP: Readonly<Record<string, AttentionItemKind>> = {
  ApprovalRequested: 'ApprovalRequest',
  AgentFailed: 'FailedRun',
  AgentCompleted: 'Digest',
};

/** Attention item kinds produced directly from events. */
const EVENT_SOURCED_KINDS: ReadonlySet<AttentionItemKind> = new Set([
  'ApprovalRequest',
  'FailedRun',
  'Digest',
]);

/** Parse an ISO-8601 timestamp to epoch milliseconds, or `NaN` if invalid. */
function toEpochMs(iso: string | undefined): number {
  if (iso === undefined) return NaN;
  return Date.parse(iso);
}

/** Mean of an array of numbers, or `null` when empty. */
function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Deep structural equality for JSON-serializable capability fields. */
function capabilityRequestsEqual(a: CapabilityRequest, b: CapabilityRequest): boolean {
  return (
    a.task === b.task &&
    a.agent === b.agent &&
    a.capability === b.capability &&
    a.destination === b.destination &&
    a.command === b.command &&
    a.workingDir === b.workingDir &&
    a.riskLevel === b.riskLevel &&
    deepEqualScope(a.scope, b.scope)
  );
}

/** Deep equality for the `scope` arrays (order-sensitive). */
function deepEqualScope(
  a: readonly CapabilityRequest['scope'][number][],
  b: readonly CapabilityRequest['scope'][number][],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai.type !== bi.type) return false;
    if (ai.targets.length !== bi.targets.length) return false;
    for (let j = 0; j < ai.targets.length; j++) {
      if (ai.targets[j] !== bi.targets[j]) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Core computation
 * ------------------------------------------------------------------ */

/**
 * Compute the full {@link AttentionMetricsReport} from a window of events,
 * attention items, resolutions, and approval-execution pairs.
 *
 * Pure and deterministic: the same inputs always yield the same report. No
 * LLM calls are made. Events are re-classified through a fresh
 * {@link AttentionEngine} (fed in chronological order so the failure tracker
 * and liveness monitor accumulate deterministically within the window) to
 * derive the false-negative and false-positive rates.
 *
 * @param input - The scoped input bundle.
 * @returns The computed metrics report.
 */
export function computeAttentionMetrics(input: AttentionMetricsInput): AttentionMetricsReport {
  const events = [...input.events].sort(byTimestamp);
  const items = input.attentionItems;
  const resolutions = input.resolutions;
  const pairs = input.approvalExecutionPairs;
  const fidelityTier = input.fidelityTier ?? 'A';

  // --- ACR -----------------------------------------------------------
  const classifiableEvents = events.length;
  const humanInterruptions = items.length;
  const acr = humanInterruptions > 0 ? classifiableEvents / humanInterruptions : null;

  // --- Agent-hours (active time) -------------------------------------
  const agentHours = computeAgentHours(events);

  // --- Human interventions per agent-hour ----------------------------
  const humanInterventions = countHumanInterventions(resolutions);
  const humanInterventionsPerAgentHour = agentHours > 0 ? humanInterventions / agentHours : null;

  // --- Mean blocked time awaiting developer --------------------------
  const blockedTimes = collectBlockedTimes(resolutions);
  const meanBlockedTimeAwaitingDeveloperMs = meanOrNull(blockedTimes);
  const approvalResolutions = blockedTimes.length;

  // --- Completion-to-review latency ----------------------------------
  const reviewLatencies = collectReviewLatencies(resolutions);
  const completionToReviewLatencyMs = meanOrNull(reviewLatencies);
  const reviewedCompletions = reviewLatencies.length;

  // --- Minutes of human review per completed task --------------------
  const completedTasks = countByType(events, 'AgentCompleted');
  const reviewMinutes = collectReviewMinutes(resolutions);
  const totalReviewMinutes = reviewMinutes.reduce((s, v) => s + v, 0);
  const minutesOfHumanReviewPerCompletedTask =
    completedTasks > 0 ? totalReviewMinutes / completedTasks : 0;

  // --- % resolved without opening terminal ---------------------------
  const resolvedItems = resolutions.filter((r) => r.resolvedAt !== undefined).length;
  const resolvedWithoutTerminal = resolutions.filter(
    (r) => r.resolvedAt !== undefined && !r.openedTerminal,
  ).length;
  const percentResolvedWithoutTerminal =
    resolvedItems > 0 ? (resolvedWithoutTerminal / resolvedItems) * 100 : null;

  // --- False-negative / false-positive (re-classify events) ----------
  const { shouldSurfaceEvents, falseNegatives, eventSourcedItems, falsePositives } =
    classifyAccuracy(events, items, fidelityTier);
  const falseNegativeAttentionRate =
    shouldSurfaceEvents > 0 ? falseNegatives / shouldSurfaceEvents : null;
  const falsePositiveInterruptionRate =
    eventSourcedItems > 0 ? falsePositives / eventSourcedItems : null;

  // --- Incorrect approval representation rate (security-critical) ----
  const incorrectApprovalRepresentations = pairs.filter(
    (p) => !capabilityRequestsEqual(p.approved, p.executed),
  ).length;
  const incorrectApprovalRepresentationRate =
    pairs.length > 0 ? incorrectApprovalRepresentations / pairs.length : null;

  const windowStart = events.length > 0 ? events[0]!.timestamp : undefined;
  const windowEnd = events.length > 0 ? events[events.length - 1]!.timestamp : undefined;

  return {
    window: { start: windowStart, end: windowEnd },
    acr,
    supplemental: {
      humanInterventionsPerAgentHour,
      meanBlockedTimeAwaitingDeveloperMs,
      completionToReviewLatencyMs,
      minutesOfHumanReviewPerCompletedTask,
      percentResolvedWithoutTerminal,
      falseNegativeAttentionRate,
      falsePositiveInterruptionRate,
      incorrectApprovalRepresentationRate,
    },
    counts: {
      classifiableEvents,
      humanInterruptions,
      agentHours,
      humanInterventions,
      completedTasks,
      approvalResolutions,
      reviewedCompletions,
      resolvedItems,
      resolvedWithoutTerminal,
      shouldSurfaceEvents,
      falseNegatives,
      eventSourcedItems,
      falsePositives,
      approvalExecutionPairs: pairs.length,
      incorrectApprovalRepresentations,
    },
  };
}

/** Chronological sort by `timestamp`. */
function byTimestamp(a: SupervisorEvent, b: SupervisorEvent): number {
  if (a.timestamp < b.timestamp) return -1;
  if (a.timestamp > b.timestamp) return 1;
  return 0;
}

/**
 * Compute total agent active time in hours from `AgentStarted` → terminal
 * event (`AgentCompleted` / `AgentFailed` / `AgentStopped`) pairs per task.
 */
function computeAgentHours(events: readonly SupervisorEvent[]): number {
  const starts = new Map<string, number>();
  let totalMs = 0;
  for (const event of events) {
    const ts = toEpochMs(event.timestamp);
    if (Number.isNaN(ts)) continue;
    if (event.type === 'AgentStarted') {
      starts.set(event.taskId, ts);
    } else if (
      event.type === 'AgentCompleted' ||
      event.type === 'AgentFailed' ||
      event.type === 'AgentStopped'
    ) {
      const start = starts.get(event.taskId);
      if (start !== undefined && ts >= start) {
        totalMs += ts - start;
        starts.delete(event.taskId);
      }
    }
  }
  return totalMs / 3_600_000;
}

/** Count events of a given type. */
function countByType(events: readonly SupervisorEvent[], type: SupervisorEvent['type']): number {
  let n = 0;
  for (const e of events) if (e.type === type) n++;
  return n;
}

/** Count human interventions = resolved attention items. */
function countHumanInterventions(resolutions: readonly AttentionItemResolution[]): number {
  let n = 0;
  for (const r of resolutions) if (r.resolvedAt !== undefined) n++;
  return n;
}

/**
 * Collect blocked-time-awaiting-developer durations (ms) from approval
 * resolutions: `resolvedAt - createdAt` for `ApprovalRequest` items.
 */
function collectBlockedTimes(resolutions: readonly AttentionItemResolution[]): number[] {
  const out: number[] = [];
  for (const r of resolutions) {
    if (r.kind !== 'ApprovalRequest') continue;
    const created = toEpochMs(r.createdAt);
    const resolved = toEpochMs(r.resolvedAt);
    if (!Number.isNaN(created) && !Number.isNaN(resolved) && resolved >= created) {
      out.push(resolved - created);
    }
  }
  return out;
}

/**
 * Collect completion-to-review latencies (ms) from `Digest` items: time from
 * creation (the `AgentCompleted` event) to first human acknowledgement (or
 * resolution when acknowledgement is unavailable).
 */
function collectReviewLatencies(resolutions: readonly AttentionItemResolution[]): number[] {
  const out: number[] = [];
  for (const r of resolutions) {
    if (r.kind !== 'Digest') continue;
    const created = toEpochMs(r.createdAt);
    const ack = toEpochMs(r.acknowledgedAt);
    const resolved = toEpochMs(r.resolvedAt);
    const reviewStart = Number.isNaN(ack) ? resolved : ack;
    if (!Number.isNaN(created) && !Number.isNaN(reviewStart) && reviewStart >= created) {
      out.push(reviewStart - created);
    }
  }
  return out;
}

/**
 * Collect per-task human review durations in minutes from `Digest` items:
 * `resolvedAt - acknowledgedAt` (the active review session), in minutes.
 */
function collectReviewMinutes(resolutions: readonly AttentionItemResolution[]): number[] {
  const out: number[] = [];
  for (const r of resolutions) {
    if (r.kind !== 'Digest') continue;
    const ack = toEpochMs(r.acknowledgedAt);
    const resolved = toEpochMs(r.resolvedAt);
    if (!Number.isNaN(ack) && !Number.isNaN(resolved) && resolved >= ack) {
      out.push((resolved - ack) / 60_000);
    }
  }
  return out;
}

/**
 * Re-classify events through a fresh attention engine and compare against the
 * surfaced attention items to derive false-negative and false-positive
 * counts.
 *
 * - **should-surface** = engine action is `always-surface` or `elevate`.
 * - **false negative** = a should-surface event with no matching attention
 *   item (the system missed an interruption it should have raised).
 * - **false positive** = an event-sourced attention item with no matching
 *   should-surface event (the system interrupted when it should not have).
 *
 * Matching is by `taskId` + kind (the aggregator maps `ApprovalRequested` →
 * `ApprovalRequest`, `AgentFailed` → `FailedRun`, `AgentCompleted` →
 * `Digest`). Non-event-sourced items (e.g. `DirtyWorktree`) are excluded from
 * the false-positive denominator because they are surfaced by other daemon
 * subsystems, not from a classifiable event.
 */
function classifyAccuracy(
  events: readonly SupervisorEvent[],
  items: readonly AttentionItem[],
  fidelityTier: AdapterFidelityTier,
): {
  readonly shouldSurfaceEvents: number;
  readonly falseNegatives: number;
  readonly eventSourcedItems: number;
  readonly falsePositives: number;
} {
  // A single fresh engine fed in chronological order so the failure tracker
  // and liveness monitor accumulate deterministically within the window.
  const engine = new AttentionEngine();
  const itemsByTaskKind = new Map<string, Set<AttentionItemKind>>();
  for (const item of items) {
    const key = `${item.taskId}:${item.kind}`;
    let set = itemsByTaskKind.get(key);
    if (set === undefined) {
      set = new Set();
      itemsByTaskKind.set(key, set);
    }
    set.add(item.kind);
  }

  let shouldSurfaceEvents = 0;
  let falseNegatives = 0;
  const shouldSurfaceKeys = new Set<string>();

  for (const event of events) {
    const classification = engine.classify(event, event.adapterFidelityTier ?? fidelityTier);
    const action: AttentionAction = classification.action;
    const shouldSurface = action === 'always-surface' || action === 'elevate';
    if (!shouldSurface) continue;
    shouldSurfaceEvents++;
    const kind = EVENT_SOURCED_KIND_MAP[event.type];
    if (kind === undefined) {
      // Should-surface event with no inbox-item mapping (e.g.
      // HumanInputRequested, sandbox violation, liveness timeout). These are
      // surfaced through other channels; we do not count them as inbox false
      // negatives to avoid conflating inbox coverage with surfacing in
      // general.
      continue;
    }
    shouldSurfaceKeys.add(`${event.taskId}:${kind}`);
    const hasItem = itemsByTaskKind.has(`${event.taskId}:${kind}`);
    if (!hasItem) falseNegatives++;
  }

  // False positives: event-sourced items with no matching should-surface
  // event (the system interrupted when the engine would have batched).
  let eventSourcedItems = 0;
  let falsePositives = 0;
  for (const item of items) {
    if (!EVENT_SOURCED_KINDS.has(item.kind)) continue;
    eventSourcedItems++;
    if (!shouldSurfaceKeys.has(`${item.taskId}:${item.kind}`)) {
      falsePositives++;
    }
  }

  return { shouldSurfaceEvents, falseNegatives, eventSourcedItems, falsePositives };
}

/* ------------------------------------------------------------------ *
 * MetricsQueryService — query API for a time window / project / task
 * ------------------------------------------------------------------ */

/**
 * Query API for attention metrics (DEC-015).
 *
 * Retrieves events, attention items, resolutions, and approval-execution
 * pairs for a {@link MetricsQueryOptions} filter (time window, project, or
 * task) from the injected {@link MetricsQuerySources} and computes the
 * {@link AttentionMetricsReport} via {@link computeAttentionMetrics}.
 *
 * All computation is deterministic and requires no LLM calls.
 */
export class MetricsQueryService {
  private readonly sources: MetricsQuerySources;

  constructor(sources: MetricsQuerySources) {
    this.sources = sources;
  }

  /**
   * Compute the attention metrics report for the given query filter.
   *
   * @param opts - Time window / project / task filter.
   * @returns The computed metrics report.
   */
  query(opts: MetricsQueryOptions = {}): AttentionMetricsReport {
    const events = this.sources.listEvents(opts);
    const attentionItems = this.sources.listAttentionItems(opts);
    const resolutions = this.sources.listResolutions(opts);
    const approvalExecutionPairs = this.sources.listApprovalExecutionPairs(opts);
    return computeAttentionMetrics({
      events,
      attentionItems,
      resolutions,
      approvalExecutionPairs,
    });
  }
}

/* ------------------------------------------------------------------ *
 * MetricsRecorder — event-hook sink for non-event datapoints
 * ------------------------------------------------------------------ */

/**
 * In-memory recorder for the metric datapoints that are not part of the
 * canonical `SupervisorEvent` journal: per-item resolutions and
 * approval-execution pairs.
 *
 * The daemon wires the inbox's acknowledge/resolve hooks and the capability
 * broker's execution hook to {@link recordResolution} and
 * {@link recordApprovalExecution}. The recorded datapoints are then available
 * to a {@link MetricsQueryService} via {@link listResolutions} and
 * {@link listApprovalExecutionPairs}, which apply the supplied
 * {@link MetricsQueryOptions} filter.
 */
export class MetricsRecorder {
  private readonly resolutions: AttentionItemResolution[] = [];
  private readonly pairs: ApprovalExecutionPair[] = [];

  /** Record an attention-item resolution datapoint. */
  recordResolution(resolution: AttentionItemResolution): void {
    this.resolutions.push({ ...resolution });
  }

  /** Record an approved-vs-executed capability pair (security audit). */
  recordApprovalExecution(pair: ApprovalExecutionPair): void {
    this.pairs.push({ ...pair });
  }

  /** List recorded resolutions matching the optional filter. */
  listResolutions(opts: MetricsQueryOptions = {}): readonly AttentionItemResolution[] {
    return this.resolutions.filter((r) => matchesResolution(r, opts));
  }

  /** List recorded approval-execution pairs matching the optional filter. */
  listApprovalExecutionPairs(opts: MetricsQueryOptions = {}): readonly ApprovalExecutionPair[] {
    return this.pairs.filter((p) => matchesPair(p, opts));
  }

  /** Clear all recorded datapoints. */
  reset(): void {
    this.resolutions.length = 0;
    this.pairs.length = 0;
  }
}

/** Whether a resolution falls within the query filter. */
function matchesResolution(r: AttentionItemResolution, opts: MetricsQueryOptions): boolean {
  if (opts.taskId !== undefined && r.taskId !== opts.taskId) return false;
  const ts = r.resolvedAt ?? r.acknowledgedAt ?? r.createdAt;
  if (opts.since !== undefined && ts < opts.since) return false;
  if (opts.until !== undefined && ts > opts.until) return false;
  return true;
}

/** Whether an approval-execution pair falls within the query filter. */
function matchesPair(p: ApprovalExecutionPair, opts: MetricsQueryOptions): boolean {
  if (opts.taskId !== undefined && p.taskId !== opts.taskId) return false;
  if (opts.since !== undefined && p.timestamp < opts.since) return false;
  if (opts.until !== undefined && p.timestamp > opts.until) return false;
  return true;
}
