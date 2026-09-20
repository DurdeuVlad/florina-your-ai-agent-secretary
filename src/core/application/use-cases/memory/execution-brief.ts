/**
 * Execution Brief compiler (DEC-039 §6, issue #191/#207).
 *
 * `docs/RULES_MEMORY_AND_SUPERVISION.md` §6: rule *selection* is a
 * deterministic filter (tag-match -> scope-filter -> conflict-resolution),
 * never an LLM call — only the compiled Brief's prose wording (not
 * implemented here; no child issue under #192 asks for it) would ever
 * touch a model. This module is the selection pipeline plus structural
 * assembly into the §6.4 Brief shape; it is a pure function of its inputs.
 */
import type { MemoryItem, MemoryScope } from '../../../domain/memory.js';
import { isMemoryActive } from '../../../domain/memory.js';
import type { ExecutionBrief, ExecutionBriefRuleLine } from '../../../domain/execution-brief.js';

export type { ExecutionBrief, ExecutionBriefRuleLine } from '../../../domain/execution-brief.js';

export interface ExecutionBriefRequest {
  readonly taskId: string;
  readonly objective: string;
  readonly projectId?: string;
  /** Topic tags inferred for this request (e.g. `['bugfix', 'verification']`). */
  readonly topics: readonly string[];
  /** Project-knowledge / prior-work strings not sourced from memory items. */
  readonly relevantContext?: readonly string[];
  readonly constraints?: readonly string[];
  readonly requiredVerification?: readonly string[];
  readonly definitionOfDone?: string;
  readonly providerRationale?: string;
  /** Structured scope-boundary path patterns (#214); see `ExecutionBrief.scopePaths`. */
  readonly scopePaths?: readonly string[];
}

/** Lower rank wins a same-topic conflict. Hard policies rank above everything. */
function provenanceRank(item: MemoryItem): number {
  if (item.kind === 'hard-policy') return 0;
  switch (item.provenance) {
    case 'explicit':
      return 1;
    case 'inferred-repeated':
      return 2;
    case 'inferred-single':
      return 3;
    case 'observed':
      return 4;
  }
}

/** Project/task scope beats global on the same topic (§6.2 step 3). */
function scopeRank(scope: MemoryScope): number {
  return scope.type === 'global' ? 1 : 0;
}

/** Deterministic conflict-resolution ordering; earlier = wins. */
function compareForConflict(a: MemoryItem, b: MemoryItem): number {
  const pr = provenanceRank(a) - provenanceRank(b);
  if (pr !== 0) return pr;
  const sr = scopeRank(a.scope) - scopeRank(b.scope);
  if (sr !== 0) return sr;
  // Most recent wins ties.
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function inScope(scope: MemoryScope, request: ExecutionBriefRequest): boolean {
  if (scope.type === 'global') return true;
  if (scope.type === 'project') return scope.projectId === request.projectId;
  return scope.taskId === request.taskId;
}

function matchedTags(item: MemoryItem, topics: readonly string[]): readonly string[] {
  if (item.tags === undefined) return [];
  return item.tags.filter((tag) => topics.includes(tag));
}

/**
 * Tag-match -> scope-filter -> conflict-resolve -> compile (§6.2).
 *
 * "Conflict" here means an explicit `conflictsWith` link (§5's
 * write-time contradiction detection, e.g. a project rule overriding a
 * global one on the same decision) — not merely sharing a topic tag.
 * Two rules that share a tag but say unrelated things (e.g. "reproduce
 * bugs first" and "keep bug-fix diffs scoped" both tagged `bugfix`) are
 * not in conflict and both apply. Hard policies are never dropped by
 * this resolution, per §6.2's "unioned in unconditionally."
 */
export function compileExecutionBrief(
  request: ExecutionBriefRequest,
  candidates: readonly MemoryItem[],
): ExecutionBrief {
  const eligible = candidates.filter(
    (item) => isMemoryActive(item) && inScope(item.scope, request) && matchedTags(item, request.topics).length > 0,
  );
  const byId = new Map(eligible.map((item) => [item.id, item]));
  const dropped = new Set<string>();

  for (const item of eligible) {
    for (const otherId of item.conflictsWith ?? []) {
      const other = byId.get(otherId);
      if (other === undefined) continue; // the conflicting item isn't itself a candidate here
      if (item.kind === 'hard-policy') continue; // hard policies are never dropped
      if (other.kind === 'hard-policy') {
        dropped.add(item.id);
        continue;
      }
      const loser = compareForConflict(item, other) <= 0 ? other : item;
      dropped.add(loser.id);
    }
  }

  const surviving = eligible.filter((item) => !dropped.has(item.id));
  const projectKnowledge = surviving.filter((item) => item.kind === 'project-knowledge');
  const ruleLike = surviving.filter((item) => item.kind !== 'project-knowledge');

  const applicableRules: ExecutionBriefRuleLine[] = [...ruleLike]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => ({
      id: item.id,
      statement: item.statement,
      provenance: item.provenance,
      scope: item.scope,
    }));

  return {
    objective: request.objective,
    relevantContext: [...(request.relevantContext ?? []), ...projectKnowledge.map((i) => i.statement)],
    applicableRules,
    constraints: request.constraints ?? [],
    requiredVerification: request.requiredVerification ?? [],
    definitionOfDone: request.definitionOfDone ?? '',
    providerRationale: request.providerRationale ?? '',
    ...(request.scopePaths !== undefined ? { scopePaths: request.scopePaths } : {}),
  };
}
