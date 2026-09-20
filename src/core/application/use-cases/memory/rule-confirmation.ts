/**
 * Proposed-rule confirmation flow (DEC-039 §3/§5, issue #191/#193/#211).
 * See `docs/UX_FLOWS.md` flow I for the exact wording pattern this
 * follows: low-friction, asked once, never silently activated.
 */
import type { ISODateString } from '../../../domain/types.js';
import type { MemoryItem, MemoryScope } from '../../../domain/memory.js';

export interface ProposedRuleConfirmation {
  readonly item: MemoryItem;
  /** Low-friction wording per `docs/UX_FLOWS.md` flow I's worked example. */
  readonly prompt: string;
}

function confirmationPrompt(item: MemoryItem): string {
  const scopeQualifier = item.scope.type === 'project' ? ' for this project' : '';
  return (
    `You've mentioned "${item.statement}" a couple of times — should I make ` +
    `that a standing rule${scopeQualifier}, or just for this task?`
  );
}

/**
 * Find `proposed` items that tag-match this request — "the next time it's
 * about to apply" — deduplicated by item id within this one call (fires
 * once per application occasion; whether the same item gets asked again
 * on a *later*, separate occasion depends on whether it's still
 * `proposed` by then, which `resolveProposedConfirmation` changes as soon
 * as an answer comes back).
 */
export function findProposedConfirmations(
  request: { readonly topics: readonly string[] },
  candidates: readonly MemoryItem[],
): readonly ProposedRuleConfirmation[] {
  const seen = new Set<string>();
  const result: ProposedRuleConfirmation[] = [];
  for (const item of candidates) {
    if (item.status !== 'proposed') continue;
    if (seen.has(item.id)) continue;
    const tags = item.tags ?? [];
    if (!tags.some((tag) => request.topics.includes(tag))) continue;
    seen.add(item.id);
    result.push({ item, prompt: confirmationPrompt(item) });
  }
  return result;
}

export type ConfirmationAnswer = 'confirm' | 'decline';

/**
 * Resolve an explicit confirmation answer. `confirm` promotes to `active`
 * with `confidence: high` (§3: "after confirmation it behaves like
 * explicit"); `decline` retires it (soft-delete, kept for provenance,
 * per §5). Never called automatically — only from a recorded user
 * answer, which is what makes activation non-silent.
 */
export function resolveProposedConfirmation(
  item: MemoryItem,
  answer: ConfirmationAnswer,
  now: ISODateString,
  narrowedScope?: MemoryScope,
): MemoryItem {
  if (item.status !== 'proposed') {
    throw new RangeError(
      `resolveProposedConfirmation: item ${item.id} is not in 'proposed' status (got '${item.status}')`,
    );
  }
  if (answer === 'decline') {
    return { ...item, status: 'retired', updatedAt: now };
  }
  return {
    ...item,
    status: 'active',
    confidence: 'high',
    scope: narrowedScope ?? item.scope,
    updatedAt: now,
  };
}
