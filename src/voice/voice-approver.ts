/**
 * Voice approver — handles the spoken voice interaction for an approval
 * (issue #23, DEC-010, DEC-011, DEC-021).
 *
 * {@link VoiceApprover} speaks a prompt via the realtime voice bridge, listens
 * for the human's spoken response, parses it into a deterministic
 * {@link ApprovalDecision}, and enforces the risk-based confirmation rules:
 *
 * - **Medium risk**: a single yes/no response is sufficient.
 * - **High risk**: if the first response is affirmative, the approver asks
 *   "Are you sure?" and requires a second affirmative response before
 *   granting. Any negative or uncertain response at either step denies.
 * - **Low risk**: handled identically to medium when reached via voice (the
 *   {@link ApprovalRouter} may auto-approve low risk without invoking the
 *   approver at all).
 * - **Critical risk**: never reaches the approver — the
 *   {@link ApprovalRouter} rejects it as not voice-approvable.
 *
 * Fail-safe (DEC-011): on timeout (no spoken response within the configurable
 * window) or on any uncertain parse, the approver returns a **deny**. The
 * Secretary narrows permissions, never silently widens them.
 *
 * The approver depends on a minimal {@link VoiceInteractionBridge} interface
 * rather than {@link RealtimeBridge} directly, so the voice interaction logic
 * is fully testable without a microphone, speakers, or a network connection.
 * A thin adapter wraps {@link RealtimeBridge} in production.
 */
import type { RiskLevel } from '../domain/events.js';
import { CapabilityRiskLevel } from '../domain/capabilities.js';
import { parseApprovalResponse } from './response-parser.js';

/* ================================================================== *
 * Types
 * ================================================================== */

/** The outcome of a voice approval interaction. */
export interface ApprovalDecision {
  /** Whether the capability was granted or denied. */
  readonly decision: 'grant' | 'deny';
  /**
   * Coarse confidence in [0, 1] — the confidence of the parsed response(s).
   * `1.0` for an exact phrase match; `0.5` for an uncertain/timeout fallback.
   */
  readonly confidence: number;
  /** The raw transcribed spoken response that drove the decision. */
  readonly rawResponse: string;
  /** Why the decision was reached (e.g. "confirmed", "timeout", "denied"). */
  readonly reason: ApprovalDecisionReason;
}

/** Why an approval decision was reached. */
export type ApprovalDecisionReason =
  | 'granted'
  | 'confirmed'
  | 'denied'
  | 'uncertain'
  | 'timeout';

/* ================================================================== *
 * VoiceInteractionBridge — pluggable voice I/O
 * ================================================================== */

/**
 * Minimal voice I/O interface the {@link VoiceApprover} depends on.
 *
 * The {@link RealtimeBridge} does not expose a single "speak and listen"
 * method — it streams audio and transcripts via callbacks. A thin adapter
 * wraps the bridge to satisfy this interface in production; tests supply a
 * mock that returns predetermined responses.
 *
 * `speakAndListen` should:
 * 1. Speak the prompt (TTS / Realtime response.create).
 * 2. Begin listening for the human's spoken response.
 * 3. Resolve with the transcribed text once a final transcript arrives, or
 *    reject with a {@link VoiceInteractionTimeout} if `timeoutMs` elapses.
 */
export interface VoiceInteractionBridge {
  /**
   * Speak `prompt` and listen for a spoken response.
   *
   * @returns The transcribed spoken response text.
   * @throws {VoiceInteractionTimeout} when no response arrives within
   *   `timeoutMs`.
   */
  speakAndListen(prompt: string, timeoutMs: number): Promise<string>;
}

/** Error thrown when a voice interaction times out with no response. */
export class VoiceInteractionTimeout extends Error {
  constructor(message = 'Voice interaction timed out') {
    super(message);
    this.name = 'VoiceInteractionTimeout';
  }
}

/* ================================================================== *
 * Configuration
 * ================================================================== */

/** Default response timeout in milliseconds (DEC-011 fail-safe). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

/** Options for {@link VoiceApprover}. */
export interface VoiceApproverOptions {
  /**
   * Response timeout in ms. If no spoken response arrives within this window
   * the approver denies (DEC-011 fail-safe). Default 30s.
   */
  readonly timeoutMs?: number;
}

/* ================================================================== *
 * VoiceApprover
 * ================================================================== */

/**
 * Handles the spoken voice interaction for a single approval request.
 *
 * Construct with a {@link VoiceInteractionBridge} (mock in tests, a
 * RealtimeBridge adapter in production), then call
 * {@link VoiceApprover.requestApproval} with a spoken prompt and the risk
 * level. The risk level determines whether a confirmation step is required.
 */
export class VoiceApprover {
  private readonly bridge: VoiceInteractionBridge;
  private readonly timeoutMs: number;

  constructor(bridge: VoiceInteractionBridge, options?: VoiceApproverOptions) {
    this.bridge = bridge;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /**
   * Run the spoken approval interaction for `prompt` at `riskLevel`.
   *
   * - Medium / Low risk: a single yes/no round.
   * - High risk: if the first response is affirmative, a second "Are you
   *   sure?" confirmation round is required; both must be affirmative to
   *   grant.
   * - Critical risk: never voice-approvable — the approver denies immediately
   *   with reason `denied` (the {@link ApprovalRouter} should not invoke the
   *   approver for critical risk, but this is a defensive backstop).
   *
   * Fail-safe: timeout and uncertain parses both yield a deny.
   *
   * @returns An {@link ApprovalDecision}.
   */
  async requestApproval(
    prompt: string,
    riskLevel: RiskLevel,
  ): Promise<ApprovalDecision> {
    // Critical risk is never voice-approvable (defensive backstop).
    if (riskLevel === CapabilityRiskLevel.Critical) {
      return {
        decision: 'deny',
        confidence: 1.0,
        rawResponse: '',
        reason: 'denied',
      };
    }

    // First round: speak the prompt and listen for the response.
    const first = await this.askOnce(prompt);
    if (first.decision === 'deny') {
      return first;
    }
    // Uncertain first response -> deny (fail-safe).
    if (first.decision !== 'grant') {
      return first;
    }

    // High risk requires an explicit confirmation round.
    if (riskLevel === CapabilityRiskLevel.High) {
      const confirm = await this.askOnce('Are you sure?');
      if (confirm.decision === 'grant') {
        return {
          decision: 'grant',
          confidence: Math.min(first.confidence, confirm.confidence),
          rawResponse: `${first.rawResponse} | ${confirm.rawResponse}`,
          reason: 'confirmed',
        };
      }
      // deny / uncertain / timeout on confirmation -> deny.
      return confirm;
    }

    // Medium / low risk: the single affirmative response is sufficient.
    return { ...first, reason: 'granted' };
  }

  /* ---------------------------------------------------------------- *
   * Internal
   * ---------------------------------------------------------------- */

  /**
   * Speak `prompt`, listen for one response, and parse it into a decision.
   * Timeout and uncertain parses yield a deny (DEC-011 fail-safe).
   */
  private async askOnce(prompt: string): Promise<ApprovalDecision> {
    let raw: string;
    try {
      raw = await this.bridge.speakAndListen(prompt, this.timeoutMs);
    } catch {
      // Timeout (or transport error) -> deny, fail-safe.
      return {
        decision: 'deny',
        confidence: 0,
        rawResponse: '',
        reason: 'timeout',
      };
    }

    const parsed = parseApprovalResponse(raw);
    if (parsed.intent === 'grant') {
      return {
        decision: 'grant',
        confidence: parsed.confidence,
        rawResponse: raw,
        reason: 'granted',
      };
    }
    if (parsed.intent === 'deny') {
      return {
        decision: 'deny',
        confidence: parsed.confidence,
        rawResponse: raw,
        reason: 'denied',
      };
    }
    // Uncertain -> deny, fail-safe.
    return {
      decision: 'deny',
      confidence: parsed.confidence,
      rawResponse: raw,
      reason: 'uncertain',
    };
  }
}
