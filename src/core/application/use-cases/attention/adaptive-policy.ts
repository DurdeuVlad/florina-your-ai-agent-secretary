/**
 * Adaptive attention policy (DEC-014, issue #32).
 *
 * {@link AdaptivePolicy} wraps the deterministic {@link AttentionEngine} and
 * an {@link AttentionTuner}, and adjusts the tuning thresholds based on
 * observed behaviour — without making the control loop non-deterministic
 * (DEC-014). Adjustments are computed from a sliding window of recent
 * {@link SupervisorEvent}s and explicit inbox-size observations, and are
 * always clamped to the bounds defined in {@link ./attention-tuning.js}.
 *
 * Adaptive rules:
 * - **Failure rate**: if > 50 % of terminating events in the recent window
 *   are `AgentFailed`, lower `failureThreshold` (min 1).
 * - **Approval response time**: if the average approval response time exceeds
 *   60 s, increase `escalationDelayMs` so approvals are not escalated while
 *   the human is still (slowly) responding.
 * - **Inbox pressure**: if the inbox is frequently observed at its max size,
 *   decrease `maxInboxSize` and shorten `autoResolveCompletedAfterMs`.
 *
 * Every adjustment is bounded (never below {@link MIN_TUNING_BOUNDS}, never
 * above {@link MAX_TUNING_BOUNDS}) and subscribers are notified via
 * {@link AdaptivePolicy.onConfigChange} whenever the adjusted config changes.
 */
import type { SupervisorEvent } from '../../../domain/events.js';
import { AttentionEngine } from './engine.js';
import {
  AttentionTuner,
  DEFAULT_TUNING_CONFIG,
  MAX_TUNING_BOUNDS,
  MIN_TUNING_BOUNDS,
  type AttentionTuningConfig,
} from './attention-tuning.js';

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
 * AdaptivePolicy
 * ------------------------------------------------------------------ */

/** Options for constructing an {@link AdaptivePolicy}. */
export interface AdaptivePolicyOptions {
  /** Initial tuning config (defaults to {@link DEFAULT_TUNING_CONFIG}). */
  readonly config?: AttentionTuningConfig;
  /**
   * Sliding-window size: the number of most-recent events used to compute
   * the failure rate. Default: 20.
   */
  readonly windowSize?: number;
  /**
   * Number of inbox-size observations retained to detect "frequently at max".
   * Default: 10.
   */
  readonly inboxSampleSize?: number;
  /**
   * Fraction of retained inbox samples that must be at/over max size before
   * the inbox-pressure rule fires. Default: 0.5.
   */
  readonly inboxPressureFraction?: number;
  /**
   * Threshold (ms) above which the average approval response time triggers an
   * increase to `escalationDelayMs`. Default: 60 000 (60 s).
   */
  readonly approvalTimeThresholdMs?: number;
  /**
   * Failure-rate threshold above which `failureThreshold` is lowered.
   * Default: 0.5.
   */
  readonly failureRateThreshold?: number;
}

/**
 * Wraps the deterministic {@link AttentionEngine} and adjusts tuning
 * thresholds based on observed behaviour.
 *
 * Feed events with {@link AdaptivePolicy.trackEvent} and inbox-size
 * observations with {@link AdaptivePolicy.observeInboxSize}. The adjusted
 * config is available via {@link AdaptivePolicy.getAdjustedConfig} and
 * changes are published to {@link AdaptivePolicy.onConfigChange} subscribers.
 */
export class AdaptivePolicy {
  private readonly tuner: AttentionTuner;
  private readonly engine: AttentionEngine;
  /** Fixed baseline config; adjustments are computed relative to this. */
  private readonly baseline: AttentionTuningConfig;
  private readonly windowSize: number;
  private readonly inboxSampleSize: number;
  private readonly inboxPressureFraction: number;
  private readonly approvalTimeThresholdMs: number;
  private readonly failureRateThreshold: number;

  /** Sliding window of recent events (most-recent last). */
  private readonly recentEvents: SupervisorEvent[] = [];
  /** Inbox-size observations (most-recent last). */
  private readonly inboxSamples: number[] = [];
  /** Pending `ApprovalRequested` start timestamps (epoch ms) by taskId. */
  private readonly pendingApprovals = new Map<string, number>();
  /** Recorded approval response times (epoch ms deltas). */
  private readonly approvalResponseTimes: number[] = [];

  /** Subscribers notified whenever the adjusted config changes. */
  private readonly subscribers = new Set<(config: AttentionTuningConfig) => void>();

  constructor(options: AdaptivePolicyOptions = {}) {
    const initial = options.config ?? { ...DEFAULT_TUNING_CONFIG };
    this.baseline = { ...initial };
    this.tuner = new AttentionTuner(initial);
    this.engine = new AttentionEngine({
      failureThreshold: this.tuner.getConfig().failureThreshold,
      livenessTimeoutMs: this.tuner.getConfig().livenessTimeoutMs,
    });
    this.windowSize = options.windowSize ?? 20;
    this.inboxSampleSize = options.inboxSampleSize ?? 10;
    this.inboxPressureFraction = options.inboxPressureFraction ?? 0.5;
    this.approvalTimeThresholdMs = options.approvalTimeThresholdMs ?? 60_000;
    this.failureRateThreshold = options.failureRateThreshold ?? 0.5;
  }

  /** The wrapped deterministic attention engine. */
  get attentionEngine(): AttentionEngine {
    return this.engine;
  }

  /** The underlying {@link AttentionTuner}. */
  get tunerInstance(): AttentionTuner {
    return this.tuner;
  }

  /**
   * Feed a {@link SupervisorEvent} to the adaptive policy.
   *
   * The event is forwarded to the wrapped {@link AttentionEngine} (for its
   * normal side-effects) and used to update the adaptive window / approval
   * timing. If the new observations trigger an adjustment, subscribers are
   * notified.
   */
  trackEvent(event: SupervisorEvent): void {
    // Forward to the deterministic engine for its normal side-effects.
    // classify() resets liveness / failure trackers as appropriate.
    this.engine.classify(event, event.adapterFidelityTier);

    // Track approval response times: when an ApprovalRequested arrives, record
    // its start; when any subsequent event for the same task arrives, treat
    // the delta as the approval response time.
    const ts = toEpochMs(event.timestamp);
    if (event.type === 'ApprovalRequested') {
      if (!Number.isNaN(ts)) {
        this.pendingApprovals.set(event.taskId, ts);
      }
    } else {
      const start = this.pendingApprovals.get(event.taskId);
      if (start !== undefined && !Number.isNaN(ts) && ts >= start) {
        this.approvalResponseTimes.push(ts - start);
        this.pendingApprovals.delete(event.taskId);
      }
    }

    // Maintain the sliding window.
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.windowSize) {
      this.recentEvents.shift();
    }

    this.reevaluate();
  }

  /**
   * Feed an inbox-size observation to the adaptive policy.
   *
   * The most recent {@link inboxSampleSize} observations are retained; if the
   * inbox is frequently at / over its configured max size, the inbox-pressure
   * rule fires.
   */
  observeInboxSize(size: number): void {
    this.inboxSamples.push(size);
    if (this.inboxSamples.length > this.inboxSampleSize) {
      this.inboxSamples.shift();
    }
    this.reevaluate();
  }

  /**
   * The current adjusted tuning configuration (a defensive copy).
   */
  getAdjustedConfig(): AttentionTuningConfig {
    return this.tuner.getConfig();
  }

  /**
   * Subscribe to config changes. The callback is invoked with the new config
   * whenever an adaptive adjustment is applied.
   *
   * @returns An unsubscribe function.
   */
  onConfigChange(callback: (config: AttentionTuningConfig) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /* ---------------------------------------------------------------- *
   * Internal adaptive logic
   * ---------------------------------------------------------------- */

  /**
   * Recompute adaptive adjustments from the current observations and apply
   * them to the tuner if any field would change. Adjustments are computed
   * relative to the fixed {@link baseline} config so repeated triggers do not
   * compound. Subscribers are notified exactly once per actual config change.
   */
  private reevaluate(): void {
    const adjustment: Partial<AttentionTuningConfig> = {};

    // --- Failure rate --------------------------------------------------
    const terminated = this.recentEvents.filter(
      (e) => e.type === 'AgentCompleted' || e.type === 'AgentFailed',
    );
    if (terminated.length >= 4) {
      const failures = terminated.filter((e) => e.type === 'AgentFailed').length;
      const rate = failures / terminated.length;
      if (rate > this.failureRateThreshold) {
        adjustment.failureThreshold = clamp(
          this.baseline.failureThreshold - 1,
          MIN_TUNING_BOUNDS.failureThreshold,
          MAX_TUNING_BOUNDS.failureThreshold,
        );
      }
    }

    // --- Approval response time ---------------------------------------
    if (this.approvalResponseTimes.length >= 3) {
      const avg =
        this.approvalResponseTimes.reduce((a, b) => a + b, 0) / this.approvalResponseTimes.length;
      if (avg > this.approvalTimeThresholdMs) {
        adjustment.escalationDelayMs = clamp(
          this.baseline.escalationDelayMs + 60_000,
          MIN_TUNING_BOUNDS.escalationDelayMs,
          MAX_TUNING_BOUNDS.escalationDelayMs,
        );
      }
    }

    // --- Inbox pressure ------------------------------------------------
    if (
      this.inboxSamples.length >= Math.max(1, this.inboxPressureFraction * this.inboxSampleSize)
    ) {
      const atMax = this.inboxSamples.filter((s) => s >= this.baseline.maxInboxSize).length;
      const fraction = atMax / this.inboxSamples.length;
      if (fraction >= this.inboxPressureFraction) {
        adjustment.maxInboxSize = clamp(
          this.baseline.maxInboxSize - 10,
          MIN_TUNING_BOUNDS.maxInboxSize,
          MAX_TUNING_BOUNDS.maxInboxSize,
        );
        adjustment.autoResolveCompletedAfterMs = clamp(
          this.baseline.autoResolveCompletedAfterMs - 60_000,
          MIN_TUNING_BOUNDS.autoResolveCompletedAfterMs,
          MAX_TUNING_BOUNDS.autoResolveCompletedAfterMs,
        );
      }
    }

    // Build the absolute target config from the baseline + adjustments.
    const target: AttentionTuningConfig = { ...this.baseline, ...adjustment };

    const before = this.tuner.getConfig();
    if (configEquals(before, target)) return;

    this.tuner.setConfig(target);
    this.notify(this.tuner.getConfig());
  }

  /** Notify all subscribers of a new config. */
  private notify(config: AttentionTuningConfig): void {
    for (const cb of this.subscribers) {
      cb(config);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Shallow equality check for two configs. */
function configEquals(a: AttentionTuningConfig, b: AttentionTuningConfig): boolean {
  return (
    a.livenessTimeoutMs === b.livenessTimeoutMs &&
    a.failureThreshold === b.failureThreshold &&
    a.escalationDelayMs === b.escalationDelayMs &&
    a.staleTaskThresholdMs === b.staleTaskThresholdMs &&
    a.maxInboxSize === b.maxInboxSize &&
    a.priorityBoostOnRepeat === b.priorityBoostOnRepeat &&
    a.autoResolveCompletedAfterMs === b.autoResolveCompletedAfterMs
  );
}
