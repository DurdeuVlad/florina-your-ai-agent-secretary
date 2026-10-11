/**
 * Scheduler policy — capacity- and consent-gated parallelism (issue
 * #344, Agent Supervision Campaign M3.2).
 *
 * The default stance is serial-per-provider: a queued task waits while
 * any session on its provider is active. Parallel dispatch is opt-in
 * and requires BOTH:
 *   1. consent — the task's declared `parallelizable` flag or an
 *      explicit per-submission user request (`userRequestedParallel`);
 *   2. capacity — quota headroom on the target provider, read from the
 *      {@link QuotaLedger} exactly as {@link CapacityRouter} does.
 *
 * A consented-but-exhausted request parks in the queue with the
 * earliest known reset (`resumeAt`) — the same ledger surface the
 * router's park/resume path reports. This module is a pure function:
 * the caller (CommandApi's pump) supplies live facts and owns
 * journaling the verdict as a `RoutingDecision` event.
 */
import type { ISODateString } from '../../../domain/types.js';

/** Live facts the decider needs — supplied by the pump, faked in tests. */
export interface SchedulingInput {
  /** Any active session on the entry's provider (any project). */
  readonly providerBusy: boolean;
  /** The task's declared parallel consent (journaled on `TaskQueued`). */
  readonly parallelizable: boolean;
  /** The submission's explicit user parallel request (journaled). */
  readonly userRequestedParallel: boolean;
  /** `QuotaLedger.hasCapacity(provider)` — same call CapacityRouter makes. */
  readonly hasCapacity: boolean;
  /** `QuotaLedger.nextResetFor(provider)` — earliest known reset, when exhausted. */
  readonly resumeAt: ISODateString | null;
}

/** The policy's verdict for one queued entry. */
export type SchedulingDecision =
  | {
      readonly action: 'dispatch';
      readonly mode: 'serial' | 'parallel';
      readonly decision: 'serial-dispatch' | 'parallel-ok';
      readonly reason: string;
    }
  | {
      readonly action: 'wait';
      readonly decision: 'session-busy' | 'quota-blocked';
      readonly reason: string;
      /** Earliest known capacity reset — `quota-blocked` only, when known. */
      readonly resumeAt?: ISODateString;
    };

/**
 * Decide one queued entry's fate for this pump tick. Deterministic and
 * total: every input combination yields exactly one verdict, so the
 * journaled `RoutingDecision` can always be explained back to the same
 * four branches.
 */
export function decideScheduling(input: SchedulingInput): SchedulingDecision {
  const parallelConsented = input.parallelizable || input.userRequestedParallel;
  if (!input.providerBusy) {
    return {
      action: 'dispatch',
      mode: 'serial',
      decision: 'serial-dispatch',
      reason: 'provider session free — serial dispatch',
    };
  }
  if (!parallelConsented) {
    return {
      action: 'wait',
      decision: 'session-busy',
      reason: 'provider session busy and task did not consent to parallel',
    };
  }
  if (!input.hasCapacity) {
    const consent = input.userRequestedParallel ? 'user-requested' : 'task-declared';
    return {
      action: 'wait',
      decision: 'quota-blocked',
      reason: `parallel consented (${consent}) but provider quota exhausted`,
      ...(input.resumeAt !== null ? { resumeAt: input.resumeAt } : {}),
    };
  }
  const consent = input.userRequestedParallel ? 'user-requested' : 'task-declared';
  return {
    action: 'dispatch',
    mode: 'parallel',
    decision: 'parallel-ok',
    reason: `parallel consented (${consent}) and quota headroom present`,
  };
}
