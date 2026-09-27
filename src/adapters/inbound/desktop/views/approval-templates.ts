/**
 * Template functions for capability approval cards (DEC-010, DEC-011, issue #26).
 *
 * Each template returns a {@link RenderTree} — a plain, serializable object
 * describing a renderable element (`{ tag, props, children }`). No DOM, no
 * React, no framework. Any renderer (desktop webview, TUI, test harness) can
 * walk the tree and project it onto its own surface.
 *
 * Style hints (risk colors, icons, spacing) are embedded in `props` as
 * semantic tokens, so each surface maps them to its own palette/layout. Event
 * handlers are expressed as **string command identifiers** (never closures)
 * so the whole tree is JSON-serializable and can cross the IPC boundary.
 *
 * Per DEC-010, the structured deterministic fields are the authorization
 * basis and are rendered prominently. Per DEC-011, higher-authority actions
 * cannot be one-click approved — the grant button is disabled for those
 * capabilities and a confirmation hint is shown instead.
 */
import type { CapabilityRiskLevel } from '../../../../core/domain/capabilities.js';
import type { RenderTree } from './view-types.js';
import type { ApprovalAction, ApprovalCardData } from './approval-types.js';
import { RISK_LABELS } from './approval-card.js';

/* ------------------------------------------------------------------ *
 * Primitive element helpers
 * ------------------------------------------------------------------ */

/** Create a {@link RenderTree} node. */
function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** A text node (represented as a plain string child). */
function text(value: string): string {
  return value;
}

/* ------------------------------------------------------------------ *
 * Approval card templates
 * ------------------------------------------------------------------ */

/**
 * Render a full capability approval card as a {@link RenderTree}.
 *
 * The card surfaces the risk badge, human-readable summary, structured
 * capability details (the authorization basis per DEC-010), risk factors, and
 * action buttons. Action buttons carry string command identifiers in
 * `props.command` so the renderer can dispatch them to the typed command API
 * without closures (keeping the tree JSON-serializable).
 *
 * @param card - The display-ready approval card data.
 * @returns A serializable RenderTree describing the card.
 */
export function renderApprovalCard(card: ApprovalCardData): RenderTree {
  return el(
    'ApprovalCard',
    {
      capability: card.capability,
      riskLevel: card.riskAssessment.level,
      riskColor: card.riskAssessment.color,
      oneClickAllowed: card.oneClickAllowed,
      spacing: 'md',
    },
    [
      renderRiskBadge(card.riskAssessment.level),
      renderSummary(card),
      renderCapabilityDetails(card),
      renderRiskFactors(card.riskAssessment.factors),
      renderRecommendedAction(card),
      renderApprovalActions(card),
    ],
  );
}

/**
 * Render the risk badge: a colored pill showing the risk level label.
 *
 * @param riskLevel - The risk level to render.
 * @returns A serializable RenderTree for the badge.
 */
export function renderRiskBadge(riskLevel: CapabilityRiskLevel): RenderTree {
  const color = riskColorFor(riskLevel);
  return el('RiskBadge', { riskLevel, color, icon: riskIconFor(riskLevel), weight: 'bold' }, [
    text(RISK_LABELS[riskLevel]),
  ]);
}

/**
 * Render the structured capability details — the deterministic authorization
 * basis (DEC-010). Each field (capability, destination, command, working
 * directory, scope) is rendered as a labeled row so the human can verify the
 * exact capability being authorized.
 *
 * @param card - The display-ready approval card data.
 * @returns A serializable RenderTree for the details section.
 */
export function renderCapabilityDetails(card: ApprovalCardData): RenderTree {
  const rows: RenderTree[] = [
    detailRow('Capability', card.capabilityLabel),
    detailRow('Destination', card.destination || '—'),
    detailRow('Command', card.command || '—'),
    detailRow('Working directory', card.workingDir || '—'),
  ];

  // Scope rows.
  if (card.scope.length > 0) {
    const scopeText = card.scope
      .map((s) => `${s.type}(${s.targets.length > 0 ? s.targets.join(', ') : 'any'})`)
      .join('; ');
    rows.push(detailRow('Scope', scopeText));
  } else {
    rows.push(detailRow('Scope', '—'));
  }

  return el('CapabilityDetails', { layout: 'column', gap: 'xs', variant: 'deterministic' }, rows);
}

/**
 * Render the action buttons for an approval card: grant, deny, inspect.
 *
 * Each button carries a string command identifier in `props.command` so the
 * renderer can dispatch it to the typed command API without closures. Per
 * DEC-011, the grant button is disabled for higher-authority capabilities
 * (those set `oneClickAllowed = false`).
 *
 * @param card - The display-ready approval card data.
 * @returns A serializable RenderTree for the actions row.
 */
export function renderApprovalActions(card: ApprovalCardData): RenderTree {
  const grantCommand = commandFor('grant', card);
  const denyCommand = commandFor('deny', card);
  const inspectCommand = commandFor('inspect', card);

  return el('ApprovalActions', { layout: 'row', gap: 'sm' }, [
    el(
      'Button',
      {
        command: grantCommand,
        variant: 'primary',
        size: 'sm',
        disabled: !card.oneClickAllowed,
      },
      [text(card.oneClickAllowed ? 'Allow once' : 'Confirm visually')],
    ),
    el(
      'Button',
      {
        command: denyCommand,
        variant: 'danger',
        size: 'sm',
        confirm: 'Deny this request? The denial is journaled.',
      },
      [text('Deny')],
    ),
    el('Button', { command: inspectCommand, variant: 'ghost', size: 'sm' }, [text('Inspect')]),
  ]);
}

/**
 * Render the risk factors as a bulleted list. Factors are deterministic,
 * derived from the structured fields — never from an LLM assessment
 * (DEC-010 / DEC-011).
 *
 * @param factors - Human-readable risk factors.
 * @returns A serializable RenderTree for the risk factors list.
 */
export function renderRiskFactors(factors: readonly string[]): RenderTree {
  if (factors.length === 0) {
    return el('RiskFactors', { layout: 'column', gap: 'xs', color: 'muted' }, [
      text('No specific risk factors identified.'),
    ]);
  }
  return el(
    'RiskFactors',
    { layout: 'column', gap: 'xs', variant: 'deterministic' },
    factors.map((factor) => el('RiskFactor', { icon: 'dot', color: 'muted' }, [text(factor)])),
  );
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Render the human-readable summary line (supplemental, DEC-010). */
function renderSummary(card: ApprovalCardData): RenderTree {
  return el('ApprovalSummary', { weight: 'semibold', variant: 'supplemental' }, [
    text(card.summary),
  ]);
}

/** Render the recommended action hint. */
function renderRecommendedAction(card: ApprovalCardData): RenderTree {
  return el(
    'RecommendedAction',
    {
      riskLevel: card.riskAssessment.level,
      color: card.riskAssessment.color,
      icon: 'info',
      variant: 'supplemental',
    },
    [text(card.riskAssessment.recommendedAction)],
  );
}

/** Render a single labeled detail row. */
function detailRow(label: string, value: string): RenderTree {
  return el('DetailRow', { layout: 'row', gap: 'sm' }, [
    el('DetailLabel', { color: 'muted', weight: 'medium' }, [text(label)]),
    el('DetailValue', { selectable: true }, [text(value)]),
  ]);
}

/** Build a string command identifier for an approval action. */
function commandFor(action: ApprovalAction, card: ApprovalCardData): string {
  return `approval:${action}:${card.capability}:${card.destination}`;
}

/** Semantic color token for a risk level. */
function riskColorFor(level: CapabilityRiskLevel): string {
  switch (level) {
    case 'critical':
      return 'red';
    case 'high':
      return 'orange';
    case 'medium':
      return 'yellow';
    case 'low':
      return 'green';
    default:
      return 'slate';
  }
}

/** Icon identifier for a risk level. */
function riskIconFor(level: CapabilityRiskLevel): string {
  switch (level) {
    case 'critical':
      return 'flame';
    case 'high':
      return 'alert';
    case 'medium':
      return 'warning';
    case 'low':
      return 'check-circle';
    default:
      return 'info';
  }
}
