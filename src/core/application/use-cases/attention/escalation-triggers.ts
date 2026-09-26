/**
 * Named escalation-trigger detectors for the supervision ladder (issue
 * #194/#215). See `docs/RULES_MEMORY_AND_SUPERVISION.md` § 7's trigger
 * list and `supervision-ladder.ts`.
 *
 * Each detector is a pure function: given deterministic state (no model
 * call), it returns a {@link SupervisionSignal} when its named trigger
 * condition is met, or `null` otherwise. A `null` result means "this
 * detector has nothing to say," not "resolved" — detectors identify
 * triggers, they don't decide whether the ladder's L2/L3 resolvers can
 * handle them.
 *
 * Two of § 7's named triggers are intentionally not detectors here:
 * - **Rule conflict** depends on the rule-learning pipeline (#193, not
 *   yet built) to know what "conflicts" means; tracked there, not faked
 *   here with a stub that would just always return `null`.
 * - **Ambiguous product decision** and **cross-project priority
 *   conflict** have no deterministic detector by definition — they are
 *   judgment calls, which is exactly what makes them L3/L4 material. The
 *   ladder (#213) already reaches L4 correctly for any signal no
 *   resolver claims, so these need no special-cased detector: the
 *   absence of a match *is* the correct behavior.
 *
 * Two triggers already have full L0 handling elsewhere and are
 * deliberately **not** re-detected here to avoid a second, divergent
 * signal path for the same fact:
 * - Repeated `AgentFailed` past threshold already surfaces via
 *   {@link FailureTracker} + the deterministic engine (`engine.ts`).
 * - A permission request already flows through `ApprovalGate` /
 *   {@link AttentionAggregator} directly.
 */
import type { ContextHealthChangedEvent } from '../../../domain/events.js';
import type { QuotaWindowStatus } from '../../ports/outbound/quota-reader.js';
import type { SupervisionSignal } from './supervision-ladder.js';
import type { LivenessMonitor } from './liveness-monitor.js';

/** One provider quota window observation, as read from the quota ledger. */
export interface QuotaObservation {
  readonly taskId: string;
  readonly provider: string;
  readonly window: string;
  readonly status: QuotaWindowStatus;
}

/** Quota exhaustion — `status: 'exhausted'` on any window blocks further dispatch on that provider. */
export function detectQuotaExhaustion(obs: QuotaObservation): SupervisionSignal | null {
  if (obs.status !== 'exhausted') return null;
  return {
    taskId: obs.taskId,
    reason: `provider quota exhausted (${obs.provider}/${obs.window})`,
    evidence: { provider: obs.provider, window: obs.window, status: obs.status },
  };
}

/** Context-window degradation (DEC-035) — `degraded`/`critical` status warrants escalation. */
export function detectContextDegradation(
  taskId: string,
  event: ContextHealthChangedEvent,
): SupervisionSignal | null {
  if (event.status === 'ok') return null;
  return {
    taskId,
    reason: `context health ${event.status}`,
    evidence: {
      status: event.status,
      windowFillPct: event.windowFillPct,
      lastCondensationAt: event.lastCondensationAt,
    },
  };
}

/**
 * Retry-loop ceiling — distinct from the consecutive-*failure* streak
 * FailureTracker already surfaces: this counts attempts at the *same*
 * objective regardless of pass/fail, catching a worker that keeps
 * retrying without making progress rather than one that keeps failing
 * outright.
 */
export function detectRetryCeiling(
  taskId: string,
  attemptCount: number,
  ceiling: number,
): SupervisionSignal | null {
  if (attemptCount < ceiling) return null;
  return {
    taskId,
    reason: `retry ceiling exceeded (${attemptCount}/${ceiling} attempts)`,
    evidence: { attemptCount, ceiling },
  };
}

/**
 * Inactivity beyond the liveness timeout — wires the existing
 * {@link LivenessMonitor} into the named-trigger shape the ladder expects.
 */
export function detectInactivity(taskId: string, monitor: LivenessMonitor): SupervisionSignal | null {
  if (!monitor.checkLiveness(taskId)) return null;
  return {
    taskId,
    reason: `inactivity exceeded liveness timeout (${monitor.livenessTimeoutMs}ms)`,
    evidence: { livenessTimeoutMs: monitor.livenessTimeoutMs },
  };
}
