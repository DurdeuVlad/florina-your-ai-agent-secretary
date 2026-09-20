/**
 * Never-auto-learn exclusion guard (DEC-039 §4, issue #191/#206).
 *
 * `docs/RULES_MEMORY_AND_SUPERVISION.md` §4: autonomy/approval loosening,
 * credentials/capability-broker (DEC-022), hard-policy/safety-boundary
 * changes, and deploy/merge/push-trigger changes must never be written from
 * `inferred-*` provenance, regardless of repetition. This is the structural
 * gate that enforces it in the write path itself — every future memory
 * writer (the rule-learning pipeline, #193; any manual import) must go
 * through {@link guardMemoryWrite} or {@link writeMemoryItem}, not
 * `MemoryStorePort.insert` directly.
 */
import type { MemoryItem } from '../../../domain/memory.js';
import type { MemoryStorePort } from '../../ports/outbound/memory-store.js';

/**
 * Keyword heuristic for the three topic-based exclusion categories (the
 * fourth — hard-policy items — is enforced structurally via `kind` below,
 * no keyword guessing needed).
 *
 * ponytail: this is a keyword match, not semantic understanding — it will
 * miss paraphrases and can false-positive on unrelated statements that
 * happen to contain a keyword. Upgrade path: once the rule-learning
 * pipeline (#193) exists, route candidate statements through the same
 * topic-classification step it already needs, instead of matching here.
 * Until then, false positives just mean an extra explicit confirmation —
 * the safe direction to fail in.
 */
const EXCLUDED_TOPIC_KEYWORDS: readonly string[] = [
  // autonomy / approval loosening
  'auto-approve',
  'auto approve',
  'always approve',
  'skip approval',
  'without approval',
  'no approval needed',
  'stop asking',
  // credentials / capability broker (DEC-022)
  'credential',
  'password',
  'secret',
  'api key',
  'access token',
  'capability broker',
  // deploy/merge/push triggers
  'deploy',
  'merge to main',
  'merge to master',
  'push access',
  'who can merge',
  'who can push',
];

/** True when a statement's topic falls in the keyword-matched exclusion set. */
export function isExcludedTopic(statement: string): boolean {
  const lower = statement.toLowerCase();
  return EXCLUDED_TOPIC_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export interface MemoryWriteAccepted {
  readonly outcome: 'accepted';
  readonly item: MemoryItem;
}

export interface MemoryWriteRejected {
  readonly outcome: 'rejected';
  readonly item: MemoryItem;
  readonly reason: string;
}

export type MemoryWriteResult = MemoryWriteAccepted | MemoryWriteRejected;

/**
 * Evaluate whether a memory item may be written as-is. Only `inferred-*`
 * provenance is gated — `explicit` (the user said so directly) and
 * `observed` (deterministic state, not conversational inference) are never
 * blocked by this guard, per §4's exact scope ("never written from
 * `inferred-*` provenance").
 */
export function guardMemoryWrite(item: MemoryItem): MemoryWriteResult {
  const isInferred = item.provenance === 'inferred-repeated' || item.provenance === 'inferred-single';
  if (!isInferred) {
    return { outcome: 'accepted', item };
  }
  if (item.kind === 'hard-policy') {
    return {
      outcome: 'rejected',
      item,
      reason: 'hard-policy / safety-boundary items require explicit provenance',
    };
  }
  if (isExcludedTopic(item.statement)) {
    return {
      outcome: 'rejected',
      item,
      reason: 'statement matches an excluded safety-adjacent topic and requires explicit confirmation',
    };
  }
  return { outcome: 'accepted', item };
}

/**
 * Apply the guard and persist only when accepted. Callers that need to
 * surface a rejected item as a Decision (per §4: "captured as a candidate
 * rule and surfaced as a Decision") do so with the returned result — this
 * use case only enforces the gate, it does not raise the Decision itself.
 */
export function writeMemoryItem(store: MemoryStorePort, item: MemoryItem): MemoryWriteResult {
  const result = guardMemoryWrite(item);
  if (result.outcome === 'accepted') {
    store.insert(result.item);
  }
  return result;
}
