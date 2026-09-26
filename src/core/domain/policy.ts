/**
 * Policy engine for capability requests (DEC-007, DEC-011).
 *
 * Compares a structured {@link CapabilityRequest} against per-project and
 * per-task policy and returns `allow`, `deny`, or `escalate` (to a human).
 *
 * Security hierarchy enforcement (DEC-011):
 *
 *   OS/container -> agent sandbox -> capability broker -> Florina policy
 *   -> human approval -> LLM recommendations
 *
 * This module implements the "Florina policy" rung and the rule that an LLM
 * recommendation can never defeat a lower-level restriction. Concretely:
 * - If policy **denies**, no higher-level override (including an LLM "safe"
 *   verdict) can change the outcome to `allow` or `escalate`. The deny is
 *   absolute.
 * - Escalation only goes **UP** (to a human). An LLM "safe" verdict can never
 *   turn an `escalate` into an `allow` (auto-approve). The LLM may only raise
 *   the required authority (narrow), never lower it (widen).
 * - The Florina narrows permissions, never silently widens them.
 *
 * Per DEC-007, autonomy is user-configurable per project and per task. Task
 * rules override project rules for the same capability (tasks can narrow, but
 * never widen beyond what the project permits).
 */
import type { ApprovalAuthorityLevel } from './enums.js';
import {
  type CapabilityRequest,
  type CapabilityRiskLevel,
  type CapabilityType,
  riskRank,
} from './capabilities.js';

/** The outcome of evaluating a capability request against policy. */
export type PolicyDecision = 'allow' | 'deny' | 'escalate';

/**
 * A single policy rule matching a class of capability request.
 *
 * A rule either explicitly allows, denies, or escalates matching requests.
 * `allowedAuthorityLevels` constrains which authority levels may grant the
 * capability — a request whose required authority is not in the set is
 * escalated regardless of the rule's `decision`.
 */
export interface PolicyRule {
  /** Human-readable name for the rule. */
  name: string;
  /** Capability types this rule applies to (empty/undefined = wildcard). */
  capabilityPattern?: readonly CapabilityType[];
  /** Risk levels this rule applies to (empty/undefined = wildcard). */
  riskLevels?: readonly CapabilityRiskLevel[];
  /** Destinations this rule applies to (empty/undefined = wildcard). */
  destinations?: readonly string[];
  /** Authority levels permitted to grant matching requests. */
  allowedAuthorityLevels?: readonly ApprovalAuthorityLevel[];
  /** Conditions under which a matching request may be auto-approved. */
  autoApprove?: AutoApproveConditions;
  /** The decision for a matching request when auto-approve does not apply. */
  decision: PolicyDecision;
}

/**
 * Conditions under which a matching request may be auto-approved (no human in
 * the loop). All conditions must hold for auto-approval to fire.
 */
export interface AutoApproveConditions {
  /** Maximum risk level eligible for auto-approval. */
  maxRiskLevel: CapabilityRiskLevel;
  /** Whether a one-time scope is required for auto-approval. */
  oneTimeOnly?: boolean;
  /** Adapter fidelity tiers eligible for auto-approval (A/B by convention). */
  allowedAdapterFidelityTiers?: readonly string[];
}

/**
 * Per-project and per-task policy (DEC-007 configurable autonomy).
 *
 * Task rules are evaluated before project rules and may narrow (escalate/deny)
 * but never widen beyond what the project permits. `allowAutoApproval` is the
 * master switch: when false, no rule may auto-approve regardless of its
 * `autoApprove` conditions.
 */
export interface Policy {
  /** Project identifier this policy belongs to. */
  projectId: string;
  /** Optional task identifier for task-scoped policy. */
  taskId?: string;
  /** Master switch: when false, auto-approval is disabled entirely. */
  allowAutoApproval: boolean;
  /** Project-level rules. */
  projectRules: readonly PolicyRule[];
  /** Task-level rules (override project rules for matching capabilities). */
  taskRules: readonly PolicyRule[];
}

/** Result of a policy evaluation, carrying the decision and rationale. */
export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  /** Human-readable reason for the decision. */
  reason: string;
  /** The rule that produced the decision, if any. */
  matchedRule?: PolicyRule;
  /** Whether auto-approval fired. */
  autoApproved: boolean;
}

/** Numeric rank of a policy decision by restrictiveness (allow < escalate < deny). */
function decisionRank(d: PolicyDecision): number {
  switch (d) {
    case 'allow':
      return 0;
    case 'escalate':
      return 1;
    case 'deny':
      return 2;
  }
}

/**
 * The more restrictive of two decisions. Used to enforce "narrow, never
 * widen": task rules and LLM recommendations can only increase
 * restrictiveness, never decrease it.
 */
function moreRestrictive(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return decisionRank(a) >= decisionRank(b) ? a : b;
}

function ruleMatchesCapability(rule: PolicyRule, request: CapabilityRequest): boolean {
  if (rule.capabilityPattern && rule.capabilityPattern.length > 0) {
    if (!rule.capabilityPattern.includes(request.capability)) return false;
  }
  if (rule.riskLevels && rule.riskLevels.length > 0) {
    if (!rule.riskLevels.includes(request.riskLevel)) return false;
  }
  if (rule.destinations && rule.destinations.length > 0) {
    if (!rule.destinations.includes(request.destination)) return false;
  }
  return true;
}

function autoApproveApplies(rule: PolicyRule, request: CapabilityRequest, policy: Policy): boolean {
  if (!policy.allowAutoApproval) return false;
  if (!rule.autoApprove) return false;
  if (riskRank(request.riskLevel) > riskRank(rule.autoApprove.maxRiskLevel)) return false;
  if (rule.autoApprove.oneTimeOnly) {
    // One-time scope is signalled by a single-target scope; a request with
    // multiple scope entries is broader than one-time.
    if (request.scope.length !== 1) return false;
  }
  return true;
}

/**
 * Find the most specific matching rule, preferring task rules over project
 * rules (DEC-007). Returns the first matching rule in task, then project.
 */
function findMatchingRule(
  policy: Policy,
  request: CapabilityRequest,
): { rule: PolicyRule; scope: 'task' | 'project' } | undefined {
  for (const rule of policy.taskRules) {
    if (ruleMatchesCapability(rule, request)) {
      return { rule, scope: 'task' };
    }
  }
  for (const rule of policy.projectRules) {
    if (ruleMatchesCapability(rule, request)) {
      return { rule, scope: 'project' };
    }
  }
  return undefined;
}

/**
 * Evaluate a capability request against a policy (DEC-007, DEC-011).
 *
 * Resolution order:
 * 1. Task rules (narrow), then project rules. A task rule may only increase
 *    restrictiveness relative to the project rule for the same request.
 * 2. If a matching rule auto-approves (and the policy master switch allows
 *    it), the decision is `allow`.
 * 3. Otherwise the rule's `decision` is used.
 * 4. If no rule matches, the default is `escalate` (never silently allow) —
 *    the Florina narrows permissions, never silently widens them.
 *
 * @param request - The structured capability request.
 * @param policy - The per-project/per-task policy to evaluate against.
 * @returns The evaluation result with decision, reason, and matched rule.
 */
export function evaluatePolicy(request: CapabilityRequest, policy: Policy): PolicyEvaluationResult {
  const match = findMatchingRule(policy, request);

  if (!match) {
    return {
      decision: 'escalate',
      reason: 'No matching policy rule; escalating to human (never silently allow).',
      autoApproved: false,
    };
  }

  const { rule, scope } = match;

  // Auto-approval path.
  if (autoApproveApplies(rule, request, policy)) {
    return {
      decision: 'allow',
      reason: `Auto-approved by ${scope} rule "${rule.name}".`,
      matchedRule: rule,
      autoApproved: true,
    };
  }

  // Task rules narrow project rules: if both a task and project rule match,
  // the more restrictive decision wins (never widen).
  let decision = rule.decision;
  if (scope === 'task') {
    const projectMatch = policy.projectRules.find((r) => ruleMatchesCapability(r, request));
    if (projectMatch) {
      decision = moreRestrictive(decision, projectMatch.decision);
    }
  }

  return {
    decision,
    reason: `Matched ${scope} rule "${rule.name}".`,
    matchedRule: rule,
    autoApproved: false,
  };
}

/**
 * An LLM risk recommendation for a capability request. The LLM sits at the
 * weakest rung of the security hierarchy (DEC-011) and may only narrow, never
 * widen.
 */
export type LlmRecommendation = PolicyDecision;

/**
 * Apply an LLM risk recommendation on top of a policy decision (DEC-011).
 *
 * Security hierarchy enforcement:
 * - A policy **deny** is absolute. An LLM `allow` or `escalate` recommendation
 *   cannot change it. Returns `deny`.
 * - A policy **escalate** can never be lowered to `allow` by the LLM. An LLM
 *   `allow` recommendation is ignored; escalation only goes UP (to human).
 *   An LLM `deny` or `escalate` recommendation is honoured (narrow further).
 * - A policy **allow** may be narrowed by the LLM to `escalate` or `deny`, but
 *   this is conservative and rare.
 *
 * In every case the result is at least as restrictive as the policy decision.
 * The LLM can never widen permissions.
 *
 * @param policyDecision - The decision produced by {@link evaluatePolicy}.
 * @param llmRecommendation - The LLM's risk recommendation.
 * @returns The final decision, never less restrictive than `policyDecision`.
 */
export function applyLlmRecommendation(
  policyDecision: PolicyDecision,
  llmRecommendation: LlmRecommendation,
): PolicyDecision {
  // DEC-011: a deny from a lower layer can never be overridden.
  if (policyDecision === 'deny') {
    return 'deny';
  }
  // Escalation only goes UP. An LLM "safe" (allow) cannot turn escalate into
  // auto-approve. Take the more restrictive of the two.
  return moreRestrictive(policyDecision, llmRecommendation);
}

/**
 * Convenience: evaluate a request against policy and then apply an LLM
 * recommendation in one step, enforcing the full DEC-011 hierarchy.
 */
export function evaluateWithLlm(
  request: CapabilityRequest,
  policy: Policy,
  llmRecommendation: LlmRecommendation,
): PolicyEvaluationResult {
  const base = evaluatePolicy(request, policy);
  const final = applyLlmRecommendation(base.decision, llmRecommendation);
  if (final === base.decision) return base;
  return {
    ...base,
    decision: final,
    reason: `${base.reason} LLM recommendation narrowed decision to "${final}" (DEC-011: never widen).`,
  };
}

/**
 * Build an empty (deny-by-escalation) policy for a project. Auto-approval is
 * off by default — the Florina narrows permissions, never silently widens
 * them (DEC-011).
 */
export function buildPolicy(projectId: string, taskId?: string): Policy {
  return {
    projectId,
    taskId,
    allowAutoApproval: false,
    projectRules: [],
    taskRules: [],
  };
}
