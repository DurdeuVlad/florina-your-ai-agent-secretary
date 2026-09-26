/**
 * Approval authority mapping and voice approval constraints (DEC-010, DEC-011,
 * PRODUCT_DESIGN.md "Voice Experience").
 *
 * Maps each capability type to the minimum authority level required to grant
 * it, and implements the voice approval security hierarchy:
 *
 * - **Voice only**: read/status/pause — cannot approve any capability.
 * - **Voice + scoped phrase**: low-risk one-time permissions, only when the
 *   voice readback includes deterministic adapter fields (DEC-010).
 * - **Authenticated UI confirmation**: push/PR/network expansion — user must
 *   visually verify the structured approval card.
 * - **Strong device confirmation**: merge/deploy/destructive cloud action.
 *
 * `checkAuthority` returns:
 * - `allowed` — the authority level is sufficient to grant the capability.
 * - `stageToVisual` — the authority level is a voice tier that cannot fully
 *   approve this capability; the approval is staged to a visual confirmation
 *   card where the user verifies structured data before confirming
 *   (DEC-010 compatibility).
 * - `denied` — the authority level fundamentally cannot grant this capability
 *   (e.g. voice-only for any real capability, or insufficient authority with
 *   no visual staging path).
 */
import { ApprovalAuthorityLevel } from './enums.js';
import type { ApprovalAuthorityLevel as AuthorityLevel } from './enums.js';
import { CapabilityType, type CapabilityType as CapType } from './capabilities.js';

/** The outcome of an authority check. */
export type AuthorityCheckResult = 'allowed' | 'denied' | 'stageToVisual';

/** Ordered authority levels from weakest to strongest. */
export const AUTHORITY_LEVEL_ORDER: readonly AuthorityLevel[] = [
  ApprovalAuthorityLevel.VoiceOnly,
  ApprovalAuthorityLevel.VoiceScopedPhrase,
  ApprovalAuthorityLevel.AuthenticatedUI,
  ApprovalAuthorityLevel.StrongDevice,
] as const;

/** Numeric rank of an authority level (higher = stronger). */
export function authorityRank(level: AuthorityLevel): number {
  return AUTHORITY_LEVEL_ORDER.indexOf(level);
}

/**
 * The minimum authority level required to grant each capability type, per the
 * voice approval security hierarchy (PRODUCT_DESIGN.md).
 *
 * - `filesystem` / `secret`-free low-risk reads → voice+scoped phrase.
 * - `network`, `shell`, `push`, `createPR` → authenticated UI confirmation.
 * - `merge`, `deploy`, `destructive`, `git` (history-rewriting), `secret` →
 *   strong device confirmation.
 */
export const CAPABILITY_AUTHORITY_REQUIREMENTS: Readonly<Record<CapType, AuthorityLevel>> =
  Object.freeze({
    [CapabilityType.Filesystem]: ApprovalAuthorityLevel.VoiceScopedPhrase,
    [CapabilityType.Network]: ApprovalAuthorityLevel.AuthenticatedUI,
    [CapabilityType.Shell]: ApprovalAuthorityLevel.AuthenticatedUI,
    [CapabilityType.Git]: ApprovalAuthorityLevel.StrongDevice,
    [CapabilityType.Secret]: ApprovalAuthorityLevel.StrongDevice,
    [CapabilityType.Push]: ApprovalAuthorityLevel.AuthenticatedUI,
    [CapabilityType.Merge]: ApprovalAuthorityLevel.StrongDevice,
    [CapabilityType.Deploy]: ApprovalAuthorityLevel.StrongDevice,
    [CapabilityType.CreatePR]: ApprovalAuthorityLevel.AuthenticatedUI,
    [CapabilityType.Destructive]: ApprovalAuthorityLevel.StrongDevice,
    [CapabilityType.Other]: ApprovalAuthorityLevel.AuthenticatedUI,
  });

/**
 * The minimum authority level required to grant a capability type.
 */
export function requiredAuthorityFor(capability: CapType): AuthorityLevel {
  return CAPABILITY_AUTHORITY_REQUIREMENTS[capability];
}

/** Whether an authority level is a voice-tier (cannot fully approve). */
function isVoiceTier(level: AuthorityLevel): boolean {
  return (
    level === ApprovalAuthorityLevel.VoiceOnly || level === ApprovalAuthorityLevel.VoiceScopedPhrase
  );
}

/**
 * Check whether a given authority level is sufficient to approve a capability
 * type, per the voice approval security hierarchy.
 *
 * @param capability - The capability type being requested.
 * @param authorityLevel - The authority level attempting to grant it.
 * @returns
 *   - `allowed` if `authorityLevel` is at or above the required level.
 *   - `stageToVisual` if the authority level is a voice tier that cannot
 *     fully approve the capability — the approval is staged to a visual
 *     confirmation card (DEC-010).
 *   - `denied` if the authority level is voice-only (which can never approve
 *     a capability) or otherwise fundamentally insufficient.
 */
export function checkAuthority(
  capability: CapType,
  authorityLevel: AuthorityLevel,
): AuthorityCheckResult {
  const required = requiredAuthorityFor(capability);

  // Voice-only can never approve any capability — it handles read/status/pause
  // only (PRODUCT_DESIGN.md "Voice Experience").
  if (authorityLevel === ApprovalAuthorityLevel.VoiceOnly) {
    return 'denied';
  }

  if (authorityRank(authorityLevel) >= authorityRank(required)) {
    return 'allowed';
  }

  // A voice-tier authority (voice+scoped phrase) that is below the required
  // level cannot fully approve — stage to a visual confirmation card.
  if (isVoiceTier(authorityLevel)) {
    return 'stageToVisual';
  }

  // A non-voice tier below the required level (e.g. authenticated UI for a
  // strong-device capability) is denied — it must escalate to a stronger
  // device, not merely a visual card.
  return 'denied';
}

/**
 * Whether a capability request is eligible for voice+scoped-phrase approval
 * (DEC-010). Only low-risk, one-time requests with deterministic readback
 * fields may be approved via a scoped voice phrase; everything else stages to
 * a visual surface.
 *
 * @param capability - The capability type.
 * @param riskLevel - The risk level of the request.
 * @param isOneTime - Whether the request is one-time scoped.
 */
export function canApproveViaVoice(
  capability: CapType,
  riskLevel: 'low' | 'medium' | 'high' | 'critical',
  isOneTime: boolean,
): boolean {
  if (!isOneTime) return false;
  if (riskLevel !== 'low') return false;
  // Only capabilities whose required authority is voice+scoped phrase are
  // eligible. Anything requiring authenticated UI or strong device must stage
  // to a visual surface even if low-risk.
  return requiredAuthorityFor(capability) === ApprovalAuthorityLevel.VoiceScopedPhrase;
}
