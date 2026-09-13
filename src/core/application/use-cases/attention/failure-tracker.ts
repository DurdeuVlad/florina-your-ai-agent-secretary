/**
 * Consecutive failure tracker for the deterministic attention engine (DEC-014).
 *
 * Tracks the number of consecutive `AgentFailed` events per task. When the
 * count reaches a configurable threshold (default 3), the attention engine
 * surfaces a repeated-failure attention item. The counter is reset to zero
 * whenever the task succeeds (`AgentCompleted`) or is explicitly reset.
 *
 * This tracker is stateful but deterministic: given the same sequence of
 * `recordFailure` / `resetOnSuccess` calls, it always produces the same
 * counts.
 */

/** Configuration for {@link FailureTracker}. */
export interface FailureTrackerConfig {
  /** Number of consecutive failures before a repeated-failure attention item
   * is surfaced. Default: 3. */
  readonly threshold?: number;
}

/** Default consecutive-failure threshold (DEC-014). */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * Tracks consecutive `AgentFailed` events per task.
 *
 * Usage:
 * - Call {@link recordFailure} when an `AgentFailed` event is observed.
 * - Call {@link resetOnSuccess} when an `AgentCompleted` event is observed.
 * - Call {@link getFailureCount} to read the current streak.
 * - Call {@link isThresholdExceeded} to check whether the streak warrants an
 *   always-surface attention item.
 */
export class FailureTracker {
  private readonly threshold: number;
  private readonly counts = new Map<string, number>();

  constructor(config: FailureTrackerConfig = {}) {
    this.threshold = config.threshold ?? DEFAULT_FAILURE_THRESHOLD;
  }

  /** The configured failure threshold. */
  get failureThreshold(): number {
    return this.threshold;
  }

  /**
   * Record a consecutive failure for the given task, incrementing the
   * counter by one.
   */
  recordFailure(taskId: string): void {
    const current = this.counts.get(taskId) ?? 0;
    this.counts.set(taskId, current + 1);
  }

  /**
   * Reset the failure counter for a task to zero. Called when the task
   * succeeds (`AgentCompleted`) or is explicitly cleared.
   */
  resetOnSuccess(taskId: string): void {
    this.counts.delete(taskId);
  }

  /** The current consecutive failure count for the given task (0 if none). */
  getFailureCount(taskId: string): number {
    return this.counts.get(taskId) ?? 0;
  }

  /** Whether the consecutive failure count has reached the threshold. */
  isThresholdExceeded(taskId: string): boolean {
    return this.getFailureCount(taskId) >= this.threshold;
  }

  /** Remove all tracked failure counts. Useful for tests. */
  clear(): void {
    this.counts.clear();
  }
}
