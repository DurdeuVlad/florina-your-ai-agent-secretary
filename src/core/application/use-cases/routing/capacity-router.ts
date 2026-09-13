/**
 * CapacityRouter — quota-aware provider selection (DEC-029, issue #60).
 *
 * Given a task's routing request, the router walks the user's
 * {@link PreferenceProfile} — a model-level ruleset, not a provider ranking —
 * and returns the first rule whose provider currently has capacity in the
 * {@link QuotaLedger}. When every candidate is exhausted the task parks and
 * the router reports the earliest `resets_at` at which to retry.
 *
 * Rule evaluation order (deterministic, DEC-014 discipline):
 * 1. Work-type match — a rule with `workTypes` applies only to requests
 *    carrying one of those tags; untagged rules are catch-alls and apply to
 *    every request. Matching typed rules take precedence over catch-alls
 *    regardless of profile order (a `long-running` rule beats a generic
 *    fallback for long-running work). An untyped request only ever sees
 *    catch-all rules.
 * 2. Deny rules — a `denied` entry removes the matching provider/model
 *    combination (`{provider, model: undefined}` denies the provider
 *    entirely).
 * 3. Exclusions — providers already tried for this task (failover).
 * 4. Capacity — the provider must be available in the QuotaLedger.
 *
 * The router never asks the human; when nothing fits it parks with a reason
 * and a resume time (DEC-031 — parking is silently resumable, not a
 * decision).
 */
import type { ISODateString } from '../../../domain/types.js';
import type { QuotaLedger } from './quota-ledger.js';

/**
 * One ordered preference: use `provider` (optionally a specific `model`)
 * for the given work types.
 */
export interface RoutingRule {
  /** Provider id, matching the adapter id (e.g. `codex`, `claude-code`). */
  readonly provider: string;
  /** Optional model pin (e.g. `haiku`, `gpt-extra-high`). */
  readonly model?: string;
  /** Work-type tags this rule applies to; undefined = catch-all. */
  readonly workTypes?: readonly string[];
}

/**
 * A model-level deny rule. `{provider, model}` denies that model on that
 * provider; omitting `model` denies the provider entirely.
 */
export interface DenyRule {
  readonly provider: string;
  readonly model?: string;
}

/**
 * The user's preference profile (issue #65): ordered routing rules plus
 * model-level deny rules. Written by the Secretary's preference memories
 * (User-scope capsule) and editable via CLI.
 */
export interface PreferenceProfile {
  readonly rules: readonly RoutingRule[];
  readonly denied: readonly DenyRule[];
}

/** What a piece of work needs routed. */
export interface RouteRequest {
  /** Optional work-type tag (e.g. `worker`, `thinking`, `image-gen`). */
  readonly workType?: string;
  /** Providers already tried for this task — excluded from failover picks. */
  readonly excludeProviders?: readonly string[];
}

/** The router's verdict. */
export type RouteResult =
  | {
      readonly kind: 'routed';
      readonly provider: string;
      readonly model?: string;
      /** Human-readable explanation, journaled for audit (DEC-012). */
      readonly reason: string;
    }
  | {
      readonly kind: 'parked';
      /** Earliest known reset across candidate providers, or null if unknown. */
      readonly resumeAt: ISODateString | null;
      readonly reason: string;
    };

/** Options for {@link CapacityRouter}. */
export interface CapacityRouterOptions {
  readonly ledger: QuotaLedger;
  readonly profile: PreferenceProfile;
}

export class CapacityRouter {
  private readonly ledger: QuotaLedger;
  private readonly profile: PreferenceProfile;

  constructor(options: CapacityRouterOptions) {
    this.ledger = options.ledger;
    this.profile = options.profile;
  }

  /**
   * Pick a provider (and optionally a model) for a routing request.
   *
   * Returns `{kind: 'routed'}` with the first eligible preference rule, or
   * `{kind: 'parked'}` with the earliest resume time when every candidate is
   * exhausted or ruled out.
   */
  route(request: RouteRequest): RouteResult {
    const candidates = this.candidates(request);
    for (const rule of candidates) {
      if (this.ledger.hasCapacity(rule.provider)) {
        return {
          kind: 'routed',
          provider: rule.provider,
          model: rule.model,
          reason: `rule: ${describeRule(rule)}`,
        };
      }
    }
    return this.park(candidates, request);
  }

  /**
   * Re-route after a provider failure or quota exhaustion mid-task
   * (DEC-029 failover). Equivalent to {@link route} with the already-tried
   * providers excluded; callers add the failed provider to
   * `excludeProviders` and record the exhaustion via
   * `QuotaLedger.markExhausted` first.
   */
  failover(request: RouteRequest): RouteResult {
    return this.route(request);
  }

  /**
   * Preference rules eligible for this request, in profile order: work-type
   * filtered, deny rules applied, exclusions removed.
   */
  private candidates(request: RouteRequest): readonly RoutingRule[] {
    const excluded = new Set(request.excludeProviders ?? []);
    const eligible = this.profile.rules.filter(
      (rule) => !this.isDenied(rule) && !excluded.has(rule.provider),
    );
    const typed = eligible.filter(
      (rule) =>
        rule.workTypes !== undefined &&
        request.workType !== undefined &&
        rule.workTypes.includes(request.workType),
    );
    const catchAll = eligible.filter((rule) => rule.workTypes === undefined);
    // Typed matches take precedence over catch-alls (profile order within each).
    return [...typed, ...catchAll];
  }

  private isDenied(rule: RoutingRule): boolean {
    return this.profile.denied.some(
      (deny) =>
        deny.provider === rule.provider && (deny.model === undefined || deny.model === rule.model),
    );
  }

  /**
   * Build a parked result: the earliest future reset across the eligible
   * candidates (or the whole ledger when candidacy itself was empty), so the
   * daemon can schedule a resume.
   */
  private park(candidates: readonly RoutingRule[], request: RouteRequest): RouteResult {
    const candidateProviders = [...new Set(candidates.map((r) => r.provider))];
    const resumeAt = this.ledger.earliestReset(
      candidateProviders.length > 0 ? candidateProviders : undefined,
    );
    const reason =
      candidates.length === 0
        ? `no preference rule matches work type "${request.workType ?? 'any'}" after deny rules and exclusions`
        : 'all candidate providers are quota-exhausted';
    return { kind: 'parked', resumeAt, reason };
  }
}

function describeRule(rule: RoutingRule): string {
  const model = rule.model !== undefined ? ` model=${rule.model}` : '';
  const work = rule.workTypes !== undefined ? ` work=[${rule.workTypes.join(',')}]` : '';
  return `${rule.provider}${model}${work}`;
}
