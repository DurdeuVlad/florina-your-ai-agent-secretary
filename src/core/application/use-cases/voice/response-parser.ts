/**
 * Spoken approval response parser (issue #23, DEC-010, DEC-011).
 *
 * Maps natural-language spoken responses into a deterministic approval
 * intent so the {@link VoiceApprover} can route a grant/deny back to the
 * daemon. The parser operates on transcribed text only — it never trusts an
 * LLM summary of the capability itself (DEC-010). It only interprets the
 * human's spoken yes/no, which is a separate concern from the structured
 * capability fields that were read aloud.
 *
 * Design rules:
 * - Affirmative and negative phrase lists are explicit and lowercase-matched
 *   so the mapping is auditable and deterministic.
 * - Anything that does not clearly match either set is `uncertain`. The
 *   {@link VoiceApprover} treats `uncertain` as a deny (DEC-011 fail-safe).
 * - `confidence` is a coarse score: 1.0 for an exact phrase match, 0.5 for an
 *   uncertain fallback. This keeps the decision auditable without pretending
 *   to a probabilistic model we do not have.
 */

/** Intent expressed by a spoken approval response. */
export type ApprovalIntent = 'grant' | 'deny' | 'uncertain';

/** Result of parsing a spoken approval response. */
export interface ParsedApprovalResponse {
  /** The interpreted intent: grant, deny, or uncertain. */
  readonly intent: ApprovalIntent;
  /**
   * Coarse confidence in [0, 1]. `1.0` for an exact affirmative/negative
   * phrase match; `0.5` for the uncertain fallback.
   */
  readonly confidence: number;
  /** The matched phrase that determined the intent, when applicable. */
  readonly matchedPhrase?: string;
}

/**
 * Affirmative phrases that map to a `grant` intent.
 *
 * Kept as a readonly tuple so the list is frozen and auditable. Matching is
 * case-insensitive and word-boundary tolerant (see {@link matchesPhrase}).
 */
export const AFFIRMATIVE_PHRASES: readonly string[] = [
  'yes',
  'yeah',
  'sure',
  'ok',
  'okay',
  'allow',
  'go ahead',
  'approve',
  'confirm',
  'do it',
  'yep',
];

/**
 * Negative phrases that map to a `deny` intent.
 *
 * Kept as a readonly tuple so the list is frozen and auditable.
 */
export const NEGATIVE_PHRASES: readonly string[] = [
  'no',
  'nope',
  'deny',
  'stop',
  "don't",
  'cancel',
  'reject',
  'negative',
];

/** Confidence assigned to an exact phrase match. */
const MATCH_CONFIDENCE = 1.0;
/** Confidence assigned to the uncertain fallback. */
const UNCERTAIN_CONFIDENCE = 0.5;

/**
 * Normalize spoken text for matching: lowercase, trim, collapse whitespace,
 * and strip trailing punctuation so "Yes." / " yeah " / "OK," all match.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?;]+$/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Test whether `normalized` contains `phrase` as a whole-word match. Uses a
 * word-boundary-aware check so "no" does not match inside "now" or "know".
 */
function matchesPhrase(normalized: string, phrase: string): boolean {
  if (phrase.length === 0) {
    return false;
  }
  // "don't" contains an apostrophe which is a non-word character; escape it
  // for the regex and use a tolerant boundary on both sides.
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i');
  return pattern.test(normalized);
}

/**
 * Parse a spoken approval response into a deterministic intent.
 *
 * The parser checks the affirmative list first, then the negative list. If
 * neither matches, the intent is `uncertain` — the {@link VoiceApprover}
 * treats uncertain as a deny per DEC-011 (fail safe).
 *
 * @param text - The transcribed spoken response (may be empty / whitespace).
 * @returns A {@link ParsedApprovalResponse} with intent, confidence, and the
 *   matched phrase (when applicable).
 */
export function parseApprovalResponse(text: string): ParsedApprovalResponse {
  const normalized = normalize(text ?? '');
  if (normalized.length === 0) {
    return { intent: 'uncertain', confidence: UNCERTAIN_CONFIDENCE };
  }

  for (const phrase of AFFIRMATIVE_PHRASES) {
    if (matchesPhrase(normalized, phrase)) {
      return {
        intent: 'grant',
        confidence: MATCH_CONFIDENCE,
        matchedPhrase: phrase,
      };
    }
  }

  for (const phrase of NEGATIVE_PHRASES) {
    if (matchesPhrase(normalized, phrase)) {
      return {
        intent: 'deny',
        confidence: MATCH_CONFIDENCE,
        matchedPhrase: phrase,
      };
    }
  }

  return { intent: 'uncertain', confidence: UNCERTAIN_CONFIDENCE };
}
