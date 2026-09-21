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
 * 3. Project scope — rules and denies carrying `projectId` apply only to
 *    requests for that project; unscoped entries are global (DEC-003
 *    need-to-know, issue #65). A request without `projectId` sees only
 *    global entries.
 * 4. Exclusions — providers already tried for this task (failover).
 * 5. Capacity — the provider must be available in the QuotaLedger.
 *
 * The router never asks the human; when nothing fits it parks with a reason
 * and a resume time (DEC-031 — parking is silently resumable, not a
 * decision).
 */
import type { ISODateString } from '../../../domain/types.js';
import type {
  DenyRule,
  PreferenceProfile,
  RoutingRule,
} from '../../ports/outbound/preference-profile.js';
import type { QuotaLedger } from './quota-ledger.js';

// The preference profile model is owned by the outbound preference-profile
// port (DEC-037); re-exported here for compatibility with existing imports.
export type { DenyRule, PreferenceProfile, RoutingRule };

/** What a piece of work needs routed. */
export interface RouteRequest {
  /** Optional work-type tag (e.g. `worker`, `thinking`, `image-gen`). */
  readonly workType?: string;
  /** Providers already tried for this task — excluded from failover picks. */
  readonly excludeProviders?: readonly string[];
  /**
   * A caller's preferred provider (e.g. a manager's pick). Honored first
   * when it survives deny rules, exclusions, and capacity; otherwise normal
   * preference-rule order applies (issue #63).
   */
  readonly preferProvider?: string;
  /** Model pin to use with {@link preferProvider}. */
  readonly preferModel?: string;
  /**
   * Project the request belongs to (issue #65). Rules and denies scoped
   * to a `projectId` apply only when it matches; unscoped profile entries
   * are global. Omit to route against global entries only.
   */
  readonly projectId?: string;
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
        const preferred =
          request.preferProvider !== undefined && rule.provider === request.preferProvider;
        return {
          kind: 'routed',
          provider: rule.provider,
          model: rule.model,
          reason: preferred
            ? `preferred provider: ${rule.provider}`
            : `rule: ${describeRule(rule)}`,
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
      (rule) =>
        inScope(rule, request.projectId) &&
        !this.isDenied(rule, request.projectId) &&
        !excluded.has(rule.provider),
    );
    const typed = eligible.filter(
      (rule) =>
        rule.workTypes !== undefined &&
        request.workType !== undefined &&
        rule.workTypes.includes(request.workType),
    );
    const catchAll = eligible.filter((rule) => rule.workTypes === undefined);
    // A preferred provider is tried first — but still passes deny rules and
    // exclusions (it may also duplicate a rule; the first pick wins either way).
    const preferred: RoutingRule[] =
      request.preferProvider !== undefined && !excluded.has(request.preferProvider)
        ? [{ provider: request.preferProvider, model: request.preferModel }].filter(
            (rule) => !this.isDenied(rule, request.projectId),
          )
        : [];
    // Typed matches take precedence over catch-alls (profile order within each).
    return [...preferred, ...typed, ...catchAll];
  }

  private isDenied(rule: RoutingRule, projectId?: string): boolean {
    return this.profile.denied.some((deny) => {
      if (!inScope(deny, projectId) || deny.provider !== rule.provider) return false;
      if (deny.model === undefined) return true;
      // A rule with no model pin was never matched by a model-scoped deny
      // (pre-#250 behavior, preserved for every provider) -- only the
      // family-normalized comparison below is new, and only for providers
      // with a registered normalizer.
      if (rule.model === undefined) return false;
      const family = modelFamilyOf(deny.provider);
      return family(deny.model) === family(rule.model);
    });
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

/**
 * DEC-003 need-to-know scope check: unscoped profile entries are global;
 * entries carrying `projectId` apply only to requests for that project.
 */
function inScope(entry: { readonly projectId?: string }, projectId?: string): boolean {
  return entry.projectId === undefined || entry.projectId === projectId;
}

function describeRule(rule: RoutingRule): string {
  const model = rule.model !== undefined ? ` model=${rule.model}` : '';
  const work = rule.workTypes !== undefined ? ` work=[${rule.workTypes.join(',')}]` : '';
  return `${rule.provider}${model}${work}`;
}

/**
 * Per-provider model-alias normalizers (issue #250): some provider CLIs
 * treat a short alias and a full model id as the same model — e.g. Claude
 * Code's `--model opus` and `--model claude-opus-5` launch the same
 * session — so a deny on one form must also block the other. Keyed by
 * provider so adding another provider's alias scheme later is a one-line
 * table entry, not another branch in {@link CapacityRouter.isDenied}.
 * Providers with no entry fall back to exact-string matching (the historic
 * behavior), which is correct for providers with no documented alias
 * convention (Codex, Devin, Gemini, Antigravity, as of #250).
 */
const MODEL_FAMILY_NORMALIZERS: Readonly<Record<string, (model: string) => string>> = {
  'claude-code': claudeModelFamily,
};

/** Exact-string fallback for providers with no registered alias scheme (unchanged pre-#250 behavior). */
function identityFamily(model: string): string {
  return model;
}

function modelFamilyOf(provider: string): (model: string) => string {
  return MODEL_FAMILY_NORMALIZERS[provider] ?? identityFamily;
}

/**
 * Known Claude model family names (the tier a deny like "never Opus"
 * actually refers to). A fixed positional regex (`claude-<family>-...`)
 * broke on dated ids where the family isn't the first segment, e.g.
 * `claude-3-opus-20240229` or `claude-3-5-sonnet-20241022` — so this
 * matches the family as a hyphen-delimited segment anywhere in the model
 * id instead of assuming a naming scheme.
 *
 * ponytail: whitelist has a ceiling — a future family name not listed
 * here falls through to exact-string comparison (safe: under-matches,
 * never over-matches). Add it here when Anthropic ships one.
 */
const CLAUDE_MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/**
 * Normalizes any spelling of a Claude model id down to its family name,
 * so `opus`, `claude-opus-5`, and `claude-3-opus-20240229` all converge.
 * A bare alias or an unrecognized string returns itself lowercased.
 */
function claudeModelFamily(model: string): string {
  const lower = model.toLowerCase();
  for (const family of CLAUDE_MODEL_FAMILIES) {
    if (
      lower === family ||
      lower.startsWith(`${family}-`) ||
      lower.endsWith(`-${family}`) ||
      lower.includes(`-${family}-`)
    ) {
      return family;
    }
  }
  return lower;
}
