/**
 * Configurable thresholds and tuning for the deterministic attention engine
 * (DEC-014, issue #32).
 *
 * The attention engine is intentionally deterministic (DEC-014): the same
 * inputs always yield the same outputs. Tuning does **not** introduce
 * non-determinism — it exposes the engine's numeric thresholds as a
 * configurable {@link AttentionTuningConfig} so operators (and the adaptive
 * layer in {@link ./adaptive-policy.js}) can adjust sensitivity without
 * changing the control-flow logic.
 *
 * {@link AttentionTuner} owns the live config and exposes pure decision
 * helpers (`shouldEscalate`, `shouldAutoResolve`, `isStale`) that the inbox /
 * aggregator consult. {@link AttentionTuner.tuneFromMetrics} derives
 * suggested adjustments from a {@link MetricsSnapshot} (DEC-015); the caller
 * decides whether to apply them, preserving the deterministic control loop.
 */
import type { AttentionItem } from './attention-item.js';
import type { MetricsSnapshot } from '../daemon/metrics.js';

/* ------------------------------------------------------------------ *
 * Config type & defaults
 * ------------------------------------------------------------------ */

/**
 * Configurable thresholds for the attention engine.
 *
 * Every field has a sensible default (see {@link DEFAULT_TUNING_CONFIG}) and a
 * hard minimum (see {@link MIN_TUNING_BOUNDS}) below which a value is not
 * considered safe / sensible. The adaptive layer clamps adjustments to these
 * bounds so tuning can never produce a degenerate configuration.
 */
export interface AttentionTuningConfig {
  /**
   * Liveness timeout in milliseconds. A task with no meaningful events for
   * longer than this is considered idle. Default: 2 minutes (120 000 ms).
   */
  livenessTimeoutMs: number;
  /**
   * Consecutive-failure threshold. After this many `AgentFailed` events in a
   * row for a task, a repeated-failure attention item is surfaced.
   * Default: 3.
   */
  failureThreshold: number;
  /**
   * Escalation delay in milliseconds. An active attention item older than
   * this is a candidate for escalation. Default: 5 minutes (300 000 ms).
   */
  escalationDelayMs: number;
  /**
   * Stale-task threshold in milliseconds. A task whose last activity is older
   * than this is considered stale. Default: 30 minutes (1 800 000 ms).
   */
  staleTaskThresholdMs: number;
  /**
   * Maximum number of items the inbox should hold before aggressive
   * auto-resolution kicks in. Default: 100.
   */
  maxInboxSize: number;
  /**
   * Whether a repeated failure should boost the attention item's priority.
   * Default: true.
   */
  priorityBoostOnRepeat: boolean;
  /**
   * Age (ms) after which a completed / acknowledged attention item is
   * auto-resolved (removed from the active queue). Default: 10 minutes
   * (600 000 ms).
   */
  autoResolveCompletedAfterMs: number;
}

/**
 * Default tuning configuration (DEC-014 baseline thresholds).
 */
export const DEFAULT_TUNING_CONFIG: AttentionTuningConfig = {
  livenessTimeoutMs: 120_000,
  failureThreshold: 3,
  escalationDelayMs: 300_000,
  staleTaskThresholdMs: 1_800_000,
  maxInboxSize: 100,
  priorityBoostOnRepeat: true,
  autoResolveCompletedAfterMs: 600_000,
} as const;

/**
 * Minimum sensible values for each numeric threshold.
 *
 * Adjustments (manual or adaptive) are clamped to these bounds so tuning can
 * never produce a degenerate configuration (e.g. a zero / negative timeout or
 * a failure threshold below 1).
 */
export const MIN_TUNING_BOUNDS: Readonly<
  Omit<AttentionTuningConfig, 'priorityBoostOnRepeat'>
> = {
  livenessTimeoutMs: 1_000,
  failureThreshold: 1,
  escalationDelayMs: 1_000,
  staleTaskThresholdMs: 1_000,
  maxInboxSize: 1,
  autoResolveCompletedAfterMs: 1_000,
} as const;

/**
 * Maximum sensible values for numeric thresholds. Used to bound upward
 * adaptive adjustments so a runaway loop cannot grow a timeout without limit.
 */
export const MAX_TUNING_BOUNDS: Readonly<
  Omit<AttentionTuningConfig, 'priorityBoostOnRepeat'>
> = {
  livenessTimeoutMs: 3_600_000,
  failureThreshold: 10,
  escalationDelayMs: 3_600_000,
  staleTaskThresholdMs: 86_400_000,
  maxInboxSize: 1_000,
  autoResolveCompletedAfterMs: 86_400_000,
} as const;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Clamp a numeric value to `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Parse an ISO-8601 timestamp to epoch milliseconds, or `NaN` if invalid. */
function toEpochMs(iso: string): number {
  return Date.parse(iso);
}

/* ------------------------------------------------------------------ *
 * AttentionTuner
 * ------------------------------------------------------------------ */

/**
 * Owns the live {@link AttentionTuningConfig} and exposes pure decision
 * helpers used by the inbox / aggregator.
 *
 * The tuner is stateful (it holds the current config) but deterministic: the
 * decision helpers are pure functions of `(item, now, config)`.
 */
export class AttentionTuner {
  private config: AttentionTuningConfig;

  constructor(config: AttentionTuningConfig = { ...DEFAULT_TUNING_CONFIG }) {
    this.config = { ...config };
  }

  /** The current tuning configuration (a defensive copy). */
  getConfig(): AttentionTuningConfig {
    return { ...this.config };
  }

  /**
   * Merge a partial config into the current configuration.
   *
   * Numeric fields are clamped to {@link MIN_TUNING_BOUNDS} /
   * {@link MAX_TUNING_BOUNDS} so the resulting config is always valid.
   */
  updateConfig(partial: Partial<AttentionTuningConfig>): void {
    const merged: AttentionTuningConfig = { ...this.config, ...partial };
    this.config = clampConfig(merged);
  }

  /** Reset the configuration to {@link DEFAULT_TUNING_CONFIG}. */
  resetToDefaults(): void {
    this.config = { ...DEFAULT_TUNING_CONFIG };
  }

  /**
   * Replace the configuration outright.
   *
   * Unlike {@link updateConfig} (which merges), this sets every field. Numeric
   * fields are still clamped to the configured bounds. Used by the adaptive
   * policy to apply an absolute adjusted config derived from a fixed baseline.
   */
  setConfig(config: AttentionTuningConfig): void {
    this.config = clampConfig(config);
  }

  /**
   * Whether an attention item should be escalated based on its age.
   *
   * An item is a candidate for escalation when it is still active (`Pending`
   * or `Acknowledged`) and its age (`now - createdAt`) has exceeded
   * {@link AttentionTuningConfig.escalationDelayMs}. Already-escalated or
   * resolved items are not re-escalated.
   *
   * @param item - The attention item to evaluate.
   * @param now  - Current epoch milliseconds.
   */
  shouldEscalate(item: AttentionItem, now: number): boolean {
    if (item.status !== 'Pending' && item.status !== 'Acknowledged') {
      return false;
    }
    const created = toEpochMs(item.createdAt);
    if (Number.isNaN(created)) return false;
    return now - created >= this.config.escalationDelayMs;
  }

  /**
   * Whether a completed / acknowledged attention item should be auto-resolved.
   *
   * An item is auto-resolved when it is in a terminal-ish state
   * (`Acknowledged` or `Resolved`) and its age has exceeded
   * {@link AttentionTuningConfig.autoResolveCompletedAfterMs}. This keeps the
   * inbox from accumulating stale seen items.
   *
   * @param item - The attention item to evaluate.
   * @param now  - Current epoch milliseconds.
   */
  shouldAutoResolve(item: AttentionItem, now: number): boolean {
    if (item.status !== 'Acknowledged' && item.status !== 'Resolved') {
      return false;
    }
    const created = toEpochMs(item.createdAt);
    if (Number.isNaN(created)) return false;
    return now - created >= this.config.autoResolveCompletedAfterMs;
  }

  /**
   * Whether a task is stale based on its last activity timestamp.
   *
   * @param taskLastActivity - Epoch milliseconds of the task's last meaningful
   *   activity.
   * @param now              - Current epoch milliseconds.
   */
  isStale(taskLastActivity: number, now: number): boolean {
    if (Number.isNaN(taskLastActivity)) return false;
    return now - taskLastActivity >= this.config.staleTaskThresholdMs;
  }

  /**
   * Suggest config adjustments based on a {@link MetricsSnapshot}.
   *
   * The returned partial is a **suggestion** — applying it is the caller's
   * decision, preserving the deterministic control loop (DEC-014). Suggestions
   * are clamped to the configured bounds.
   *
   * Heuristics:
   * - **High failure rate** (`tasksFailed / (completed + failed) > 0.5`):
   *   lower `failureThreshold` (more aggressive surfacing of repeated
   *   failures).
   * - **High approval response time** (histogram mean > 60 s): increase
   *   `escalationDelayMs` so approvals are not escalated while the human is
   *   still (slowly) responding.
   * - **Inbox at / over max size** (`inboxSize >= maxInboxSize`): lower
   *   `maxInboxSize` and shorten `autoResolveCompletedAfterMs` to make
   *   auto-resolution more aggressive.
   *
   * @param metrics - Snapshot of runtime metrics (DEC-015).
   * @returns A partial config with the suggested adjustments (empty if none).
   */
  tuneFromMetrics(metrics: MetricsSnapshot): Partial<AttentionTuningConfig> {
    const suggestion: Partial<AttentionTuningConfig> = {};
    const current = this.config;

    // --- Failure rate --------------------------------------------------
    const terminated =
      metrics.counters.tasksCompleted + metrics.counters.tasksFailed;
    if (terminated >= 4) {
      const failureRate = metrics.counters.tasksFailed / terminated;
      if (failureRate > 0.5) {
        const lowered = clamp(
          current.failureThreshold - 1,
          MIN_TUNING_BOUNDS.failureThreshold,
          MAX_TUNING_BOUNDS.failureThreshold,
        );
        if (lowered !== current.failureThreshold) {
          suggestion.failureThreshold = lowered;
        }
      }
    }

    // --- Approval response time ---------------------------------------
    const approvalMean = metrics.histograms.approvalResponseTime.mean;
    if (metrics.histograms.approvalResponseTime.count >= 3 && approvalMean > 60_000) {
      const raised = clamp(
        current.escalationDelayMs + 60_000,
        MIN_TUNING_BOUNDS.escalationDelayMs,
        MAX_TUNING_BOUNDS.escalationDelayMs,
      );
      if (raised !== current.escalationDelayMs) {
        suggestion.escalationDelayMs = raised;
      }
    }

    // --- Inbox pressure ------------------------------------------------
    if (metrics.gauges.inboxSize >= current.maxInboxSize && current.maxInboxSize > 1) {
      const loweredMax = clamp(
        current.maxInboxSize - 10,
        MIN_TUNING_BOUNDS.maxInboxSize,
        MAX_TUNING_BOUNDS.maxInboxSize,
      );
      if (loweredMax !== current.maxInboxSize) {
        suggestion.maxInboxSize = loweredMax;
      }
      // Also shorten the auto-resolve window to clear stale items faster.
      const shortened = clamp(
        current.autoResolveCompletedAfterMs - 60_000,
        MIN_TUNING_BOUNDS.autoResolveCompletedAfterMs,
        MAX_TUNING_BOUNDS.autoResolveCompletedAfterMs,
      );
      if (shortened !== current.autoResolveCompletedAfterMs) {
        suggestion.autoResolveCompletedAfterMs = shortened;
      }
    }

    return suggestion;
  }
}

/* ------------------------------------------------------------------ *
 * Internal config clamping
 * ------------------------------------------------------------------ */

/**
 * Clamp every numeric field of a config to the configured bounds.
 * `priorityBoostOnRepeat` is a boolean and is passed through unchanged.
 */
function clampConfig(config: AttentionTuningConfig): AttentionTuningConfig {
  return {
    livenessTimeoutMs: clamp(
      config.livenessTimeoutMs,
      MIN_TUNING_BOUNDS.livenessTimeoutMs,
      MAX_TUNING_BOUNDS.livenessTimeoutMs,
    ),
    failureThreshold: clamp(
      config.failureThreshold,
      MIN_TUNING_BOUNDS.failureThreshold,
      MAX_TUNING_BOUNDS.failureThreshold,
    ),
    escalationDelayMs: clamp(
      config.escalationDelayMs,
      MIN_TUNING_BOUNDS.escalationDelayMs,
      MAX_TUNING_BOUNDS.escalationDelayMs,
    ),
    staleTaskThresholdMs: clamp(
      config.staleTaskThresholdMs,
      MIN_TUNING_BOUNDS.staleTaskThresholdMs,
      MAX_TUNING_BOUNDS.staleTaskThresholdMs,
    ),
    maxInboxSize: clamp(
      config.maxInboxSize,
      MIN_TUNING_BOUNDS.maxInboxSize,
      MAX_TUNING_BOUNDS.maxInboxSize,
    ),
    priorityBoostOnRepeat: config.priorityBoostOnRepeat,
    autoResolveCompletedAfterMs: clamp(
      config.autoResolveCompletedAfterMs,
      MIN_TUNING_BOUNDS.autoResolveCompletedAfterMs,
      MAX_TUNING_BOUNDS.autoResolveCompletedAfterMs,
    ),
  };
}
