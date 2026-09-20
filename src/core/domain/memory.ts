/**
 * Rule/memory taxonomy (DEC-039, issue #191/#204).
 *
 * Generalizes DEC-029's provider-preference memory into a general-purpose
 * memory envelope covering all eight kinds a user's statements or Florina's
 * own observations can produce. See `docs/RULES_MEMORY_AND_SUPERVISION.md`
 * §§ 2-4 for the full doctrine this implements; this module only carries
 * the domain shape, not the write-path guard (that's #206) or the
 * Execution Brief compiler that consumes it (#192).
 */
import type { EntityId, ISODateString } from './types.js';

/**
 * The eight memory kinds (§ 2). Internal classification only — the user
 * never picks a kind directly; it's inferred from how the statement was
 * made.
 */
export const MemoryKind = {
  Fact: 'fact',
  Preference: 'preference',
  Rule: 'rule',
  HardPolicy: 'hard-policy',
  ProjectKnowledge: 'project-knowledge',
  Decision: 'decision',
  TemporaryInstruction: 'temporary-instruction',
  LearnedPattern: 'learned-pattern',
} as const;

export type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

/**
 * Where a memory item applies. A project-scoped item is visible to that
 * project's manager only; a task-scoped item expires when the task closes.
 * Mirrors the User/Project capsule split (DEC-020) plus a temporary,
 * task-bound tier for one-off instructions.
 */
export type MemoryScope =
  | { readonly type: 'global' }
  | { readonly type: 'project'; readonly projectId: EntityId }
  | { readonly type: 'task'; readonly taskId: EntityId };

/**
 * How a memory item entered the system (§ 3). Confidence and write
 * eligibility both key off this — see `MemoryConfidence` and the § 4
 * never-auto-learn guard (#206).
 */
export const MemoryProvenance = {
  /** The user said "remember this" or gave a direct instruction. */
  Explicit: 'explicit',
  /** The same correction observed >=2 times across distinct sessions. */
  InferredRepeated: 'inferred-repeated',
  /** A single strong rule-shaped statement that hasn't repeated. */
  InferredSingle: 'inferred-single',
  /** Derived from deterministic state (git, tests, adapter events). */
  Observed: 'observed',
} as const;

export type MemoryProvenance = (typeof MemoryProvenance)[keyof typeof MemoryProvenance];

/**
 * Coarse three-value confidence (§ 3) — deliberately not a numeric score,
 * which would imply precision the underlying signal doesn't have.
 */
export const MemoryConfidence = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
} as const;

export type MemoryConfidence = (typeof MemoryConfidence)[keyof typeof MemoryConfidence];

/**
 * Lifecycle status (§ 5):
 * `candidate`/`proposed` (unconfirmed) -> `active` -> `conflict` (a new
 * rule contradicts this one) -> `retired` | `superseded`. Retirement and
 * superseding are soft — the row is kept for provenance (DEC-012 journal
 * discipline), never physically erased.
 */
export const MemoryStatus = {
  /** Single unrepeated inference; surfaced passively, never enforced. */
  Candidate: 'candidate',
  /** Repeated inference awaiting one user confirmation. */
  Proposed: 'proposed',
  /** Confirmed or explicit; applied to Execution Briefs (#192). */
  Active: 'active',
  /** Contradicts another active item; not applied until resolved. */
  Conflict: 'conflict',
  /** Soft-deleted; kept for provenance, never applied. */
  Retired: 'retired',
  /** Replaced by a newer explicit item on the same topic. */
  Superseded: 'superseded',
} as const;

export type MemoryStatus = (typeof MemoryStatus)[keyof typeof MemoryStatus];

/**
 * One persisted unit of memory — the envelope every kind shares (§ 2).
 * `statement` is the natural-language content; structured routing fields
 * (e.g. `PreferenceProfile`'s `RoutingRule`) live in kind-specific ports
 * that reference a memory item's `id`, not inline here — this envelope
 * stays kind-agnostic so a generic store/list/audit surface (#200) never
 * needs to know about routing-specific shapes.
 */
export interface MemoryItem {
  readonly id: EntityId;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly statement: string;
  readonly provenance: MemoryProvenance;
  readonly confidence: MemoryConfidence;
  readonly status: MemoryStatus;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  /** Id of the memory item this one replaces, when `status: superseded`. */
  readonly supersedes?: EntityId;
  /** Id(s) of active items this one contradicts, when `status: conflict`. */
  readonly conflictsWith?: readonly EntityId[];
}

/** True when two scopes refer to the same place (used for retrieval/matching). */
export function sameMemoryScope(a: MemoryScope, b: MemoryScope): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'project' && b.type === 'project') return a.projectId === b.projectId;
  if (a.type === 'task' && b.type === 'task') return a.taskId === b.taskId;
  return a.type === 'global';
}

/** True when a memory item is enforceable (applied to an Execution Brief). */
export function isMemoryActive(item: MemoryItem): boolean {
  return item.status === 'active';
}
