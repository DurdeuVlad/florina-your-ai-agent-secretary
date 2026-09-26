/**
 * Repeated-correction detection: candidate -> proposed promotion (DEC-039
 * §3/§5, issue #191/#193/#210).
 *
 * Semantic clustering of raw conversation text — deciding that "research
 * prior art first" and "look at prior art before deciding" are the same
 * direction — is out of scope here and belongs to whatever calls this
 * (an LLM classification step, most likely). This module's job starts
 * *after* that: given a set of observations the caller has already
 * grouped as "the same direction," it applies §3's deterministic
 * candidate/proposed promotion rule. That keeps the promotion decision
 * itself auditable and testable independent of the clustering step.
 */
import type { EntityId, ISODateString } from '../../../domain/types.js';
import type { MemoryItem, MemoryKind, MemoryScope } from '../../../domain/memory.js';
import { isExcludedTopic } from './write-guard.js';

/**
 * True when an item's kind/statement falls under §4's never-auto-learn
 * exclusion list (issue #212) — autonomy/credential/deploy-merge topics,
 * or `hard-policy` kind. Shared between the promotion cap below and
 * `exclusion-and-conflict.ts`'s always-confirm surfacing so both use the
 * exact same definition of "exclusion-listed."
 */
export function isExclusionListed(item: Pick<MemoryItem, 'kind' | 'statement'>): boolean {
  return item.kind === 'hard-policy' || isExcludedTopic(item.statement);
}

/** One occurrence of a same-direction statement, from a single conversation turn. */
export interface RuleObservation {
  readonly turnId: string;
  readonly statement: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly tags?: readonly string[];
}

/**
 * Classify a set of same-direction observations into a memory item.
 * One observation (or repeats within a single turn) -> `inferred-single` /
 * `candidate` (§3: "surfaced passively, never interrupts, never applied").
 * Two or more *distinct* turns -> `inferred-repeated` / `proposed` (§3:
 * "recorded as proposed until the user confirms it once").
 *
 * Exception (§4, issue #212): an exclusion-listed statement — autonomy
 * loosening, credentials, deploy/merge triggers, or `hard-policy` kind —
 * is capped at `candidate` *regardless of repetition count*. Repetition
 * never promotes it to `proposed`'s auto-surfacing; it always requires
 * `exclusion-and-conflict.ts`'s always-confirm path instead. `provenance`
 * still reflects the true repetition count (how it was observed);
 * `status` reflects the lifecycle cap (never silently escalated).
 *
 * The most recent observation's statement/kind/scope/tags represent the
 * item (later phrasing supersedes earlier phrasing of the same direction).
 */
export function classifyRepeatedObservations(
  observations: readonly RuleObservation[],
  id: EntityId,
  now: ISODateString,
): MemoryItem {
  if (observations.length === 0) {
    throw new RangeError('classifyRepeatedObservations requires at least one observation');
  }
  const latest = observations[observations.length - 1]!;
  const distinctTurns = new Set(observations.map((o) => o.turnId));
  const isRepeated = distinctTurns.size >= 2;
  const capped = isExclusionListed(latest);

  return {
    id,
    kind: latest.kind,
    scope: latest.scope,
    statement: latest.statement,
    provenance: isRepeated ? 'inferred-repeated' : 'inferred-single',
    confidence: isRepeated && !capped ? 'medium' : 'low',
    status: isRepeated && !capped ? 'proposed' : 'candidate',
    createdAt: now,
    updatedAt: now,
    ...(latest.tags !== undefined ? { tags: latest.tags } : {}),
    sourceTurnIds: [...distinctTurns],
  };
}
