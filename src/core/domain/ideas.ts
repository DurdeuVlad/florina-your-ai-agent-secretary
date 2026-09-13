/**
 * Idea ledger + Brief domain types (DEC-033, issue #69).
 *
 * The Secretary is a thinking partner during ideation: each idea gets a
 * persistent markdown ledger she maintains (spec, research notes, open
 * questions, decisions-in-progress). Nothing becomes agent work without
 * an explicit human gate — the compiled Brief is shown for review, and
 * confirming it is a journaled decision (DEC-012) before any task is
 * dispatched through the normal daemon path (DEC-018).
 */
import type { EntityId, ISODateString } from './types.js';

/**
 * Lifecycle of an idea ledger.
 *
 * - `open` — actively being worked on with the Secretary.
 * - `promoted` — moved into a project's directory once a project is
 *   specified (ideas precede project selection, DEC-033).
 * - `compiled` — a Brief was compiled from the ledger.
 * - `archived` — closed without dispatch (kept, never deleted).
 */
export type IdeaStatus = 'open' | 'promoted' | 'compiled' | 'archived';

export const IDEA_STATUSES: readonly IdeaStatus[] = [
  'open',
  'promoted',
  'compiled',
  'archived',
] as const;

/**
 * A per-idea markdown ledger. The file itself is the artifact — this
 * record is its index entry, reconstructed from YAML frontmatter plus
 * the file's location.
 */
export interface IdeaLedger {
  readonly id: EntityId;
  readonly title: string;
  readonly status: IdeaStatus;
  /** Absolute path of the ledger's `.md` file. */
  readonly path: string;
  /** Project the ledger was promoted into, when any. */
  readonly projectId?: EntityId;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/** One task inside a Brief's delegation plan. */
export interface DelegationPlanTask {
  /** What the worker should accomplish. */
  readonly objective: string;
  /** Optional work-type tag for work-type-specific routing rules. */
  readonly workType?: string;
  /** Preferred provider — honored when eligible (quota, denies). */
  readonly preferProvider?: string;
  /** Model pin to use with the preferred provider. */
  readonly preferModel?: string;
}

/**
 * The delegation half of a Brief: which project, and the task breakdown
 * with provider/model intent per task (DEC-033). Every plan task is
 * expected to carry its verification objective in the objective text —
 * testing/proving systems are first-class work, per DEC-032.
 */
export interface DelegationPlan {
  readonly projectId: EntityId;
  readonly tasks: readonly DelegationPlanTask[];
}

/** Lifecycle of a compiled Brief. */
export type BriefStatus = 'draft' | 'confirmed' | 'dispatched';

export const BRIEF_STATUSES: readonly BriefStatus[] = ['draft', 'confirmed', 'dispatched'] as const;

/**
 * A compiled, reviewable Brief: the frozen spec snapshot plus the
 * delegation plan. `draft` until the human confirms; `confirmed` once
 * the gate decision is journaled; `dispatched` once the dispatch loop
 * has finished (regardless of per-task spawn outcome — the results are
 * recorded alongside).
 */
export interface Brief {
  readonly id: EntityId;
  readonly ideaId: EntityId;
  readonly title: string;
  /** The ledger's markdown body, frozen at compile time. */
  readonly spec: string;
  readonly plan: DelegationPlan;
  readonly status: BriefStatus;
  readonly createdAt: ISODateString;
  readonly confirmedAt?: ISODateString;
  readonly confirmedBy?: string;
  readonly dispatchedAt?: ISODateString;
}

/** Per-task outcome of a confirmed Brief's dispatch pass. */
export interface BriefDispatchResult {
  readonly objective: string;
  readonly status: 'spawned' | 'parked' | 'error';
  readonly taskId?: EntityId;
  readonly provider?: string;
  /** Routing/parking explanation — surfaced for auditability. */
  readonly reason: string;
}
