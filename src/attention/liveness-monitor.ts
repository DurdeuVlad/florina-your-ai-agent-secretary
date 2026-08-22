/**
 * Liveness monitor for the deterministic attention engine (DEC-014).
 *
 * Tracks the timestamp of the last *meaningful* event per task. A meaningful
 * event is one that indicates active progress: `FileChanged`, `ToolStarted`,
 * `ToolFinished`, `TestStarted`, or `TestFinished`. If no meaningful event is
 * observed for a configurable duration (default 5 minutes), the task is
 * considered to have a liveness timeout and an attention item is surfaced.
 *
 * The monitor is stateful but deterministic: given the same sequence of
 * `resetOnEvent` calls and the same `now` value, {@link checkLiveness} always
 * returns the same result.
 */
import type { SupervisorEvent } from '../domain/events.js';

/** Configuration for {@link LivenessMonitor}. */
export interface LivenessMonitorConfig {
  /** Maximum idle duration (ms) before a liveness timeout is raised.
   * Default: 5 minutes (300 000 ms). */
  readonly timeoutMs?: number;
  /** Provider for the current time (ms since epoch). Defaults to `Date.now`.
   * Override in tests for deterministic time control. */
  readonly now?: () => number;
}

/** Default liveness timeout: 5 minutes (DEC-014). */
export const DEFAULT_LIVENESS_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Event types that count as "meaningful" for liveness tracking — i.e. events
 * that indicate the agent is actively making progress.
 */
export const MEANINGFUL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'FileChanged',
  'ToolStarted',
  'ToolFinished',
  'TestStarted',
  'TestFinished',
]);

/**
 * Tracks liveness per task based on meaningful event timestamps.
 *
 * Usage:
 * - Call {@link resetOnEvent} for every incoming event; the timer is only
 *   reset when the event type is meaningful.
 * - Call {@link checkLiveness} to determine whether a task has been idle
 *   beyond the configured timeout.
 * - Call {@link getLastMeaningfulEventTime} to inspect the raw timestamp.
 */
export class LivenessMonitor {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly lastEventTime = new Map<string, number>();

  constructor(config: LivenessMonitorConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
    this.now = config.now ?? (() => Date.now());
  }

  /** The configured liveness timeout in milliseconds. */
  get livenessTimeoutMs(): number {
    return this.timeoutMs;
  }

  /**
   * Whether an event type is "meaningful" for liveness purposes.
   * Meaningful events: `FileChanged`, `ToolStarted`, `ToolFinished`,
   * `TestStarted`, `TestFinished`.
   */
  static isMeaningfulEvent(event: SupervisorEvent): boolean {
    return MEANINGFUL_EVENT_TYPES.has(event.type);
  }

  /**
   * Process an incoming event. If the event is meaningful, the liveness
   * timer for the event's task is reset to the event's timestamp.
   */
  resetOnEvent(event: SupervisorEvent): void {
    if (LivenessMonitor.isMeaningfulEvent(event)) {
      this.lastEventTime.set(event.taskId, this.now());
    }
  }

  /**
   * Seed the liveness timer for a task with an explicit timestamp (ms since
   * epoch). Useful when restoring state from the event journal on startup.
   */
  seed(taskId: string, timestampMs: number): void {
    this.lastEventTime.set(taskId, timestampMs);
  }

  /**
   * Whether the liveness timeout has been exceeded for the given task.
   *
   * Returns `false` if no meaningful event has ever been recorded for the
   * task (a task that has not started cannot be timed out).
   */
  checkLiveness(taskId: string): boolean {
    const last = this.lastEventTime.get(taskId);
    if (last === undefined) {
      return false;
    }
    return this.now() - last > this.timeoutMs;
  }

  /** The timestamp (ms since epoch) of the last meaningful event, or
   * `undefined` if none has been recorded. */
  getLastMeaningfulEventTime(taskId: string): number | undefined {
    return this.lastEventTime.get(taskId);
  }

  /** Remove all tracked liveness state. Useful for tests. */
  clear(): void {
    this.lastEventTime.clear();
  }
}
