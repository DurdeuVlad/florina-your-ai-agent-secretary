/**
 * Approval card view-layer types (DEC-010, DEC-011, issue #26).
 *
 * These are pure, JSON-serializable data structures describing a display-ready
 * capability approval card. No DOM, no React, no framework. The desktop
 * renderer (or any other surface) consumes them and projects them onto
 * whatever concrete rendering technology it uses.
 *
 * Per DEC-010, the approval authorizes the underlying deterministic
 * {@link CapabilityRequest} fields — never an LLM summary. The card surfaces
 * those structured fields as the authorization basis; any LLM explanation is
 * rendered in a visually subordinate, clearly-labeled supplemental section.
 *
 * Per DEC-011, higher-authority actions (push/PR/merge/deploy/destructive)
 * cannot be one-click approved — they require explicit visual confirmation.
 * The {@link RiskAssessmentDisplay.recommendedAction} encodes that guidance.
 */
import type {
  CapabilityRequest,
  CapabilityRiskLevel,
  CapabilityType,
} from '../../../../core/domain/capabilities.js';

/**
 * A semantic color token for risk display. Each rendering surface maps it to
 * its own palette (DEC-010 / DEC-011).
 *
 * - `critical` → red
 * - `high` → orange
 * - `medium` → yellow
 * - `low` → green
 */
export type RiskColor = 'red' | 'orange' | 'yellow' | 'green';

/**
 * Display-ready risk assessment for a capability request.
 *
 * Encodes the risk level, its semantic color token, the human-readable risk
 * factors, and a recommended action that respects the DEC-011 security
 * hierarchy (higher-authority actions require explicit visual confirmation
 * and cannot be one-click approved).
 */
export interface RiskAssessmentDisplay {
  /** The determined risk level (low / medium / high / critical). */
  readonly level: CapabilityRiskLevel;
  /** Semantic color token for the risk badge. */
  readonly color: RiskColor;
  /** Human-readable risk factors contributing to the assessment. */
  readonly factors: readonly string[];
  /**
   * Recommended action for the human, respecting the DEC-011 security
   * hierarchy. Higher-authority actions recommend explicit visual
   * confirmation rather than one-click approval.
   */
  readonly recommendedAction: string;
}

/**
 * Contextual metadata for an approval card: who is asking, for what task, and
 * in which session. All fields optional — the card degrades gracefully when
 * context is unavailable.
 */
export interface ApprovalContext {
  /** Display name of the agent requesting the capability (e.g. `Codex`). */
  readonly agentName?: string;
  /** Human-readable task name/objective the request belongs to. */
  readonly taskName?: string;
  /** Session identifier or label, if known. */
  readonly sessionInfo?: string;
}

/**
 * A string command identifier for an approval action (DEC-028 / issue #25).
 *
 * Commands are plain strings so the whole card stays JSON-serializable and can
 * cross the IPC boundary. The renderer dispatches them to the typed command
 * API without closures.
 *
 * - `grant` — approve the capability (one-time, where permitted).
 * - `deny` — explicitly deny the capability.
 * - `inspect` — open the inspector for full structured detail.
 */
export type ApprovalAction = 'grant' | 'deny' | 'inspect';

/**
 * Display-ready approval card data (DEC-010, DEC-011, issue #26).
 *
 * {@link ApprovalCardViewModel.buildCard} transforms a
 * {@link CapabilityRequest} (from an `ApprovalRequested` event) into this
 * structure. All fields are readonly primitives or plain records so the whole
 * card is JSON-serializable and can be persisted / sent over IPC.
 *
 * The structured deterministic fields (`capability`, `destination`, `command`,
 * `workingDir`, `scope`, `riskAssessment`) are the authorization basis. The
 * `summary` is a human-readable rendering of those fields — supplemental
 * convenience text, never the basis of approval.
 */
export interface ApprovalCardData {
  /** The capability type being requested (filesystem, network, shell, ...). */
  readonly capability: CapabilityType;
  /** Human-readable label for the capability type. */
  readonly capabilityLabel: string;
  /** Destination/resource the capability targets (host, path, repo, ...). */
  readonly destination: string;
  /** The exact command or operation to be performed, if applicable. */
  readonly command: string;
  /** Working directory in which the capability would execute. */
  readonly workingDir: string;
  /** Structured scope boundaries for the requested capability. */
  readonly scope: readonly {
    readonly type: CapabilityType;
    readonly targets: readonly string[];
  }[];
  /** Display-ready risk assessment (level, color, factors, recommended action). */
  readonly riskAssessment: RiskAssessmentDisplay;
  /**
   * Human-readable summary of the request (e.g.
   * "Codex wants to execute: npm install --production"). Supplemental only —
   * the structured fields are the authorization basis (DEC-010).
   */
  readonly summary: string;
  /** Contextual metadata (agent name, task name, session info). */
  readonly context: ApprovalContext;
  /**
   * Whether one-click approval is permitted. Higher-authority actions
   * (push/PR/merge/deploy/destructive) require explicit visual confirmation
   * and set this to `false` (DEC-011).
   */
  readonly oneClickAllowed: boolean;
  /** The verbatim structured capability request this card was built from. */
  readonly request: CapabilityRequest;
}
