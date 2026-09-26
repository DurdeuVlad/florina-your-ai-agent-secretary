/**
 * Exclusion-list always-confirm surfacing, and rule-conflict recording
 * (DEC-039 §4/§5, issue #191/#193/#212).
 */
import type { ISODateString } from '../../../domain/types.js';
import type { MemoryItem } from '../../../domain/memory.js';
import { isExclusionListed } from './rule-learning.js';
import { findProposedConfirmations, type ProposedRuleConfirmation } from './rule-confirmation.js';

/**
 * Everything `findProposedConfirmations` (#211) surfaces, plus
 * exclusion-listed `candidate` items — which must always route through
 * explicit confirmation regardless of repetition count (§4), unlike an
 * ordinary candidate that only surfaces once promoted to `proposed`.
 */
export function findConfirmationsNeeded(
  request: { readonly topics: readonly string[] },
  candidates: readonly MemoryItem[],
): readonly ProposedRuleConfirmation[] {
  const ordinary = findProposedConfirmations(request, candidates);
  const seen = new Set(ordinary.map((c) => c.item.id));
  const result = [...ordinary];

  for (const item of candidates) {
    if (item.status !== 'candidate' || !isExclusionListed(item)) continue;
    if (seen.has(item.id)) continue;
    const tags = item.tags ?? [];
    if (!tags.some((tag) => request.topics.includes(tag))) continue;
    seen.add(item.id);
    result.push({
      item,
      prompt: `"${item.statement}" touches an autonomy/credential/deploy-sensitive area, so I need you to confirm it explicitly before it applies — every time, not just once repeated.`,
    });
  }
  return result;
}

/**
 * Record that a newly-observed item contradicts an existing *active*
 * item on the same topic+scope. The caller has already identified this
 * pair (deciding *that* two statements are contradictory is a semantic
 * judgment out of scope here, matching #210's clustering boundary — e.g.
 * both tag-matched the exact same decision and are mutually exclusive).
 * The existing active item is untouched — not overwritten, not silently
 * replaced (§5) — only the new item is written, with `status: conflict`.
 */
export function recordConflict(
  newItem: MemoryItem,
  existingActiveItem: MemoryItem,
  now: ISODateString,
): MemoryItem {
  if (existingActiveItem.status !== 'active') {
    throw new RangeError('recordConflict: existingActiveItem must be active');
  }
  return {
    ...newItem,
    status: 'conflict',
    conflictsWith: [...(newItem.conflictsWith ?? []), existingActiveItem.id],
    updatedAt: now,
  };
}

export type ConflictResolution = 'keep-new' | 'keep-existing';

/**
 * Resolve a recorded conflict from an explicit user answer (flow K):
 * the winner becomes `active`; the loser becomes `superseded` (kept for
 * provenance, never re-applied, per §5). The winner's `supersedes` field
 * records what it replaced.
 */
export function resolveConflict(
  newItem: MemoryItem,
  existingItem: MemoryItem,
  resolution: ConflictResolution,
  now: ISODateString,
): { readonly winner: MemoryItem; readonly loser: MemoryItem } {
  if (newItem.status !== 'conflict') {
    throw new RangeError(`resolveConflict: newItem ${newItem.id} is not in 'conflict' status`);
  }
  if (existingItem.status !== 'active') {
    throw new RangeError(`resolveConflict: existingItem ${existingItem.id} is not 'active'`);
  }

  if (resolution === 'keep-new') {
    return {
      winner: { ...newItem, status: 'active', confidence: 'high', supersedes: existingItem.id, updatedAt: now },
      loser: { ...existingItem, status: 'superseded', updatedAt: now },
    };
  }
  return {
    winner: { ...existingItem, updatedAt: now },
    loser: { ...newItem, status: 'superseded', updatedAt: now },
  };
}
