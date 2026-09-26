/**
 * Supervision ladder scaffold: L0-L4 escalation routing (DEC-014 extension,
 * issue #194/#213). See `docs/RULES_MEMORY_AND_SUPERVISION.md` § 7.
 *
 * L0 (deterministic three-action classification) and its immediate
 * always-surface/elevate item creation already exist and are unchanged —
 * that's {@link AttentionEngine} plus {@link AttentionAggregator}. This
 * module names and implements the two levels that were previously
 * implicit in "manager reasoning": an ambiguous signal that L0/L1 cannot
 * resolve deterministically is offered to L2 resolvers, then L3 resolvers,
 * in order; if none resolve it, exactly one {@link AttentionItem} is
 * created at L4. A signal is never resolved twice and never produces more
 * than one inbox item, regardless of how many levels it passed through.
 *
 * The concrete L2/L3 resolvers (retry-ceiling, quota, context health,
 * out-of-scope edits, rule conflicts, etc.) are added by #214/#215 as
 * `SupervisionResolver` implementations passed into this ladder — this
 * issue only provides the routing structure and the single-item guarantee.
 *
 * "Done without evidence" (DEC-032) is a **hard L0 block**, not a signal
 * this ladder ever sees: {@link AttentionAggregator}'s direct
 * `VerificationGate` integration routes it back to the worker as a
 * verification objective before anything reaches L1-L4. This module does
 * not touch that path — it's unaffected by construction, since nothing
 * feeds a completion claim into `SupervisionLadder.escalate`.
 */
import { createAttentionItem, type AttentionItem } from './attention-item.js';
import type { AttentionInbox } from './attention-inbox.js';

/** The five supervision levels, named per § 7's table. */
export const SupervisionLevel = {
  L0Deterministic: 'L0-deterministic',
  L1CheapClassification: 'L1-cheap-classification',
  L2ManagerReasoning: 'L2-manager-reasoning',
  L3FlorinaReasoning: 'L3-florina-reasoning',
  L4Human: 'L4-human',
} as const;

export type SupervisionLevel = (typeof SupervisionLevel)[keyof typeof SupervisionLevel];

/**
 * An ambiguous event that L0/L1 flagged but could not resolve
 * deterministically — the unit this ladder routes through L2/L3/L4.
 */
export interface SupervisionSignal {
  readonly taskId: string;
  /** Human-readable trigger description (e.g. "3 consecutive test failures"). */
  readonly reason: string;
  /** Structured evidence backing the trigger — deterministic facts, not narrative. */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/**
 * One level's attempt to resolve a signal without escalating further.
 * Resolvers are pure decision points — how they actually recover a
 * worker, retry a task, or reroute a provider is their own concern; this
 * ladder only asks "did you handle it."
 */
export interface SupervisionResolver {
  /** Attempt to resolve. `true` stops escalation; `false` passes to the next level. */
  resolve(signal: SupervisionSignal): boolean;
}

export interface SupervisionOutcome {
  readonly level: SupervisionLevel;
  /** `true` when a resolver at L2/L3 handled it; `false` when it reached L4. */
  readonly resolved: boolean;
  /** Set only when `resolved` is `false` — the single item created at L4. */
  readonly attentionItem?: AttentionItem;
}

export interface SupervisionLadderDeps {
  readonly inbox: AttentionInbox;
  /** L2 (manager reasoning) resolvers, tried in order before L3. */
  readonly l2Resolvers?: readonly SupervisionResolver[];
  /** L3 (Florina reasoning) resolvers, tried in order before L4. */
  readonly l3Resolvers?: readonly SupervisionResolver[];
}

export class SupervisionLadder {
  private readonly inbox: AttentionInbox;
  private readonly l2Resolvers: readonly SupervisionResolver[];
  private readonly l3Resolvers: readonly SupervisionResolver[];

  constructor(deps: SupervisionLadderDeps) {
    this.inbox = deps.inbox;
    this.l2Resolvers = deps.l2Resolvers ?? [];
    this.l3Resolvers = deps.l3Resolvers ?? [];
  }

  /**
   * Route a signal through L2 -> L3 -> L4. Stops at the first resolver
   * that returns `true`; creates exactly one {@link AttentionItem} if
   * none do. Never calls a resolver again once one has resolved, and
   * never creates more than one item for a single call.
   */
  escalate(signal: SupervisionSignal): SupervisionOutcome {
    for (const resolver of this.l2Resolvers) {
      if (resolver.resolve(signal)) {
        return { level: SupervisionLevel.L2ManagerReasoning, resolved: true };
      }
    }
    for (const resolver of this.l3Resolvers) {
      if (resolver.resolve(signal)) {
        return { level: SupervisionLevel.L3FlorinaReasoning, resolved: true };
      }
    }

    const item = createAttentionItem({
      taskId: signal.taskId,
      kind: 'Custom',
      priority: 'High',
      payload: { reason: signal.reason, ...signal.evidence },
    });
    this.inbox.add(item);
    return { level: SupervisionLevel.L4Human, resolved: false, attentionItem: item };
  }
}
