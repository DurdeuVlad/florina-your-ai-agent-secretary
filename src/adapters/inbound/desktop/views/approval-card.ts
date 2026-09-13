/**
 * View model for capability approval cards (DEC-010, DEC-011, issue #26).
 *
 * {@link ApprovalCardViewModel} transforms a {@link CapabilityRequest} (from
 * an `ApprovalRequested` event) into a display-ready {@link ApprovalCardData}.
 * It extracts and formats the deterministic structured fields, generates a
 * human-readable summary, and derives a risk assessment display with color,
 * factors, and a recommended action that respects the DEC-011 security
 * hierarchy.
 *
 * Per DEC-010, the approval authorizes the underlying capability — the
 * structured adapter fields — never an LLM summary. The generated `summary`
 * is supplemental convenience text rendered from those deterministic fields.
 *
 * The view model is pure and synchronous: no DOM, no framework, no side
 * effects. This keeps the approval card logic fully testable with vitest and
 * identical across rendering surfaces (desktop webview, TUI, CLI).
 */
import {
  CapabilityRiskLevel,
  CapabilityType,
  type CapabilityRequest,
} from '../../../../core/domain/capabilities.js';
import type {
  ApprovalCardData,
  ApprovalContext,
  RiskAssessmentDisplay,
  RiskColor,
} from './approval-types.js';

/* ------------------------------------------------------------------ *
 * Display metadata tables
 * ------------------------------------------------------------------ */

/**
 * Human-readable labels for each {@link CapabilityType}.
 */
export const CAPABILITY_LABELS: Readonly<Record<CapabilityType, string>> = {
  [CapabilityType.Filesystem]: 'Filesystem',
  [CapabilityType.Network]: 'Network',
  [CapabilityType.Shell]: 'Shell',
  [CapabilityType.Git]: 'Git',
  [CapabilityType.Secret]: 'Secret',
  [CapabilityType.Push]: 'Push',
  [CapabilityType.Merge]: 'Merge',
  [CapabilityType.Deploy]: 'Deploy',
  [CapabilityType.CreatePR]: 'Create PR',
  [CapabilityType.Destructive]: 'Destructive',
  [CapabilityType.Other]: 'Other',
};

/**
 * Semantic color tokens for each risk level (DEC-010 / DEC-011).
 *
 * - critical → red
 * - high → orange
 * - medium → yellow
 * - low → green
 */
export const RISK_COLORS: Readonly<Record<CapabilityRiskLevel, RiskColor>> = {
  [CapabilityRiskLevel.Critical]: 'red',
  [CapabilityRiskLevel.High]: 'orange',
  [CapabilityRiskLevel.Medium]: 'yellow',
  [CapabilityRiskLevel.Low]: 'green',
};

/**
 * Human-readable labels for each risk level.
 */
export const RISK_LABELS: Readonly<Record<CapabilityRiskLevel, string>> = {
  [CapabilityRiskLevel.Critical]: 'Critical',
  [CapabilityRiskLevel.High]: 'High',
  [CapabilityRiskLevel.Medium]: 'Medium',
  [CapabilityRiskLevel.Low]: 'Low',
};

/**
 * Capability types that require higher authority and explicit visual
 * confirmation — they cannot be one-click approved (DEC-011).
 */
const HIGHER_AUTHORITY_CAPABILITIES: ReadonlySet<CapabilityType> = new Set([
  CapabilityType.Git,
  CapabilityType.Secret,
  CapabilityType.Push,
  CapabilityType.Merge,
  CapabilityType.Deploy,
  CapabilityType.CreatePR,
  CapabilityType.Destructive,
]);

/* ------------------------------------------------------------------ *
 * ApprovalCardViewModel
 * ------------------------------------------------------------------ */

/**
 * Transforms a {@link CapabilityRequest} into a display-ready
 * {@link ApprovalCardData}.
 *
 * The view model is stateless (aside from immutable metadata tables), so a
 * single instance can be reused. Use {@link buildCard} to produce a card from
 * a capability request, optionally enriching it with contextual metadata
 * (agent name, task name, session info).
 */
export class ApprovalCardViewModel {
  /**
   * Build a display-ready approval card from a {@link CapabilityRequest}.
   *
   * Extracts and formats the deterministic structured fields (capability,
   * destination, command, workingDir, scope), generates a human-readable
   * summary, and derives a risk assessment display with color, factors, and a
   * recommended action. The returned structure is JSON-serializable.
   *
   * @param request - The structured capability request (from an
   *   `ApprovalRequested` event).
   * @param context - Optional contextual metadata (agent name, task name,
   *   session info). Falls back to fields on the request when omitted.
   * @returns Display-ready approval card data.
   */
  buildCard(request: CapabilityRequest, context?: ApprovalContext): ApprovalCardData {
    const capabilityLabel = CAPABILITY_LABELS[request.capability] ?? 'Other';
    const riskAssessment = this.buildRiskAssessment(request);
    const summary = this.buildSummary(request, context);
    const oneClickAllowed = !HIGHER_AUTHORITY_CAPABILITIES.has(request.capability);

    return {
      capability: request.capability,
      capabilityLabel,
      destination: request.destination,
      command: request.command,
      workingDir: request.workingDir,
      scope: request.scope.map((s) => ({
        type: s.type,
        targets: [...s.targets],
      })),
      riskAssessment,
      summary,
      context: this.resolveContext(request, context),
      oneClickAllowed,
      request,
    };
  }

  /**
   * Build a display-ready risk assessment from a capability request.
   *
   * Derives the semantic color token, human-readable risk factors, and a
   * recommended action that respects the DEC-011 security hierarchy.
   */
  buildRiskAssessment(request: CapabilityRequest): RiskAssessmentDisplay {
    const level = request.riskLevel;
    const color = RISK_COLORS[level];
    const factors = deriveRiskFactors(request);
    const recommendedAction = deriveRecommendedAction(request);
    return { level, color, factors, recommendedAction };
  }

  /**
   * Generate a human-readable summary of the request.
   *
   * e.g. "Codex wants to execute: npm install --production" or
   * "codex wants network access to npmjs.org". Supplemental only — the
   * structured fields are the authorization basis (DEC-010).
   */
  buildSummary(request: CapabilityRequest, context?: ApprovalContext): string {
    const agent = this.resolveContext(request, context).agentName ?? request.agent;
    return summarizeRequest(request, agent);
  }

  /**
   * Resolve contextual metadata, falling back to fields on the request when
   * the explicit context is omitted or partial.
   */
  private resolveContext(
    request: CapabilityRequest,
    context?: ApprovalContext,
  ): ApprovalContext {
    return {
      agentName: context?.agentName ?? request.agent,
      taskName: context?.taskName ?? request.task,
      sessionInfo: context?.sessionInfo,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/**
 * Derive human-readable risk factors for a capability request.
 *
 * Factors are deterministic, derived from the structured fields — never from
 * an LLM assessment (DEC-010 / DEC-011).
 */
function deriveRiskFactors(request: CapabilityRequest): string[] {
  const factors: string[] = [];

  // Risk-level factor.
  factors.push(`${RISK_LABELS[request.riskLevel]} risk level`);

  // Higher-authority capability factor.
  if (HIGHER_AUTHORITY_CAPABILITIES.has(request.capability)) {
    factors.push(
      `${CAPABILITY_LABELS[request.capability]} requires higher authority (DEC-011)`,
    );
  }

  // Capability-specific factors.
  switch (request.capability) {
    case CapabilityType.Network:
      factors.push(`Network access to ${request.destination || 'unspecified host'}`);
      break;
    case CapabilityType.Shell:
      if (request.command) {
        factors.push(`Shell command: ${request.command}`);
      }
      break;
    case CapabilityType.Filesystem:
      if (request.destination) {
        factors.push(`Filesystem path: ${request.destination}`);
      }
      break;
    case CapabilityType.Git:
      if (request.command) {
        factors.push(`Git operation: ${request.command}`);
      }
      break;
    case CapabilityType.Push:
      factors.push(`Push to remote: ${request.destination || 'origin'}`);
      break;
    case CapabilityType.Merge:
      factors.push(`Merge target: ${request.destination || 'unspecified'}`);
      break;
    case CapabilityType.Deploy:
      factors.push(`Deploy target: ${request.destination || 'unspecified'}`);
      break;
    case CapabilityType.CreatePR:
      factors.push(`Create PR against: ${request.destination || 'unspecified'}`);
      break;
    case CapabilityType.Destructive:
      factors.push('Destructive operation — irreversible');
      break;
    case CapabilityType.Secret:
      factors.push('Secret access requested');
      break;
    default:
      break;
  }

  // Scope factor.
  if (request.scope.length > 0) {
    const targetCount = request.scope.reduce(
      (sum, s) => sum + s.targets.length,
      0,
    );
    if (targetCount > 0) {
      factors.push(`Scope covers ${targetCount} target${targetCount === 1 ? '' : 's'}`);
    }
  }

  return factors;
}

/**
 * Derive the recommended action for a capability request, respecting the
 * DEC-011 security hierarchy. Higher-authority actions require explicit visual
 * confirmation and cannot be one-click approved.
 */
function deriveRecommendedAction(request: CapabilityRequest): string {
  if (HIGHER_AUTHORITY_CAPABILITIES.has(request.capability)) {
    return 'Requires explicit visual confirmation — cannot be one-click approved.';
  }
  switch (request.riskLevel) {
    case CapabilityRiskLevel.Critical:
      return 'Deny unless explicitly verified. Critical risk requires strong confirmation.';
    case CapabilityRiskLevel.High:
      return 'Review carefully before approving. High risk.';
    case CapabilityRiskLevel.Medium:
      return 'Review the structured fields, then approve or deny.';
    case CapabilityRiskLevel.Low:
      return 'Low risk — safe to approve if the action matches expectations.';
    default:
      return 'Review the structured fields, then approve or deny.';
  }
}

/**
 * Generate a human-readable summary of the request for a given agent display
 * name. Supplemental only — the structured fields are the authorization basis
 * (DEC-010).
 */
function summarizeRequest(request: CapabilityRequest, agent: string): string {
  const verb = verbForCapability(request.capability);
  const detail = detailForCapability(request);
  if (detail) {
    return `${agent} wants to ${verb}: ${detail}`;
  }
  return `${agent} wants to ${verb}`;
}

/** Choose a human-readable verb for a capability type. */
function verbForCapability(capability: CapabilityType): string {
  switch (capability) {
    case CapabilityType.Shell:
      return 'execute';
    case CapabilityType.Network:
      return 'access network';
    case CapabilityType.Filesystem:
      return 'access filesystem';
    case CapabilityType.Git:
      return 'run a git operation';
    case CapabilityType.Push:
      return 'push to remote';
    case CapabilityType.Merge:
      return 'merge';
    case CapabilityType.Deploy:
      return 'deploy';
    case CapabilityType.CreatePR:
      return 'create a pull request';
    case CapabilityType.Destructive:
      return 'perform a destructive operation';
    case CapabilityType.Secret:
      return 'access a secret';
    default:
      return 'perform an operation';
  }
}

/** Choose the detail fragment for a capability type. */
function detailForCapability(request: CapabilityRequest): string {
  switch (request.capability) {
    case CapabilityType.Shell:
    case CapabilityType.Git:
      return request.command;
    case CapabilityType.Network:
      return request.destination;
    case CapabilityType.Filesystem:
      return request.destination;
    case CapabilityType.Push:
    case CapabilityType.Merge:
    case CapabilityType.Deploy:
    case CapabilityType.CreatePR:
      return request.destination;
    case CapabilityType.Destructive:
      return request.command || request.destination;
    case CapabilityType.Secret:
      return request.destination;
    default:
      return request.command || request.destination;
  }
}
