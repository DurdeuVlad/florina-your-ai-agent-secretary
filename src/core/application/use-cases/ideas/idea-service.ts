/**
 * Idea ledger + Brief service (DEC-033, issue #69).
 *
 * The mechanical half of the idea-to-delegation pipeline:
 *
 *   monologue → ledger (this service) → compile → Brief draft
 *           → human confirms (journaled) → dispatch via the normal path
 *
 * The service owns ledger bookkeeping and the hard delegation gate. It
 * never dispatches without an explicit `confirmBrief`; the confirmation
 * is recorded on the Brief row itself (the journaled decision, DEC-012)
 * before a single `spawnTask` runs — same normal daemon path every
 * manager uses (DEC-018), no special channel.
 *
 * Voice/monologue capture and the Florina's editorial role in the
 * ledger arrive with #73 — this service is the surface they drive.
 */
import type {
  Brief,
  BriefDispatchResult,
  DelegationPlan,
  IdeaLedger,
  IdeaStatus,
} from '../../../domain/ideas.js';
import type { EntityId } from '../../../domain/types.js';
import type { IdeaLedgerPort } from '../../ports/outbound/idea-ledger.js';
import type { BriefRepositoryPort } from '../../ports/outbound/repositories.js';
import type { SpawnTaskInput, SpawnTaskResult } from '../managers/manager-tools.js';

/**
 * Dispatch surface for confirmed Briefs. The daemon satisfies it by
 * constructing the per-project {@link ManagerToolService} — the same
 * routing/worktree/start path `florina_spawn_task` uses.
 */
export interface BriefDispatcherPort {
  spawnTask(projectId: string, input: SpawnTaskInput): Promise<SpawnTaskResult>;
}

export interface IdeaServiceDeps {
  readonly ledger: IdeaLedgerPort;
  readonly briefs: BriefRepositoryPort;
  /**
   * Dispatch for confirmed Briefs. Optional so callers that only need
   * ledger bookkeeping don't have to wire the full spawn path; a
   * `brief-confirm` without it returns an explicit error rather than
   * silently succeeding.
   */
  readonly dispatcher?: BriefDispatcherPort;
  readonly now?: () => Date;
  readonly generateId?: (prefix: string) => EntityId;
}

/** Result of {@link IdeaService.confirmBrief}. */
export interface ConfirmBriefResult {
  readonly brief: Brief;
  readonly results: readonly BriefDispatchResult[];
}

export class IdeaService {
  private readonly deps: IdeaServiceDeps;

  constructor(deps: IdeaServiceDeps) {
    this.deps = deps;
  }

  /* ---------------------------------------------------------------- *
   * Ledger bookkeeping
   * ---------------------------------------------------------------- */

  /** Open a new idea ledger in the global ideas directory. */
  createIdea(title: string, body?: string): IdeaLedger {
    if (title.trim().length === 0) {
      throw new Error('idea title is required');
    }
    return this.deps.ledger.create({
      id: this.genId('idea'),
      title: title.trim(),
      ...(body !== undefined ? { body } : {}),
      now: this.now(),
    });
  }

  getIdea(id: string): IdeaLedger | null {
    return this.deps.ledger.get(id);
  }

  listIdeas(): IdeaLedger[] {
    return this.deps.ledger.list();
  }

  /**
   * Append a titled section — research notes, open questions, decisions
   * in progress. The file is the artifact; the human can edit it too.
   */
  appendToIdea(id: string, heading: string, body: string): IdeaLedger {
    this.mustGet(id);
    return this.deps.ledger.append(id, heading, body, this.now());
  }

  /** The ledger's markdown body (for compiling or reading back). */
  readIdeaBody(id: string): string | null {
    return this.deps.ledger.readBody(id);
  }

  /**
   * Promote the ledger into a project once one is specified — the file
   * moves into `targetDir` (DEC-033: ledgers precede project selection).
   */
  promoteIdea(id: string, projectId: string, targetDir: string): IdeaLedger {
    this.mustGet(id);
    return this.deps.ledger.promote(id, projectId, targetDir, this.now());
  }

  /* ---------------------------------------------------------------- *
   * Compile → gate → dispatch
   * ---------------------------------------------------------------- */

  /**
   * Compile the ledger into a reviewable Brief — the spec is the frozen
   * markdown snapshot; the caller (the Florina, today; voice later)
   * supplies the delegation plan. Returns the persisted `draft`.
   */
  compileBrief(ideaId: string, plan: DelegationPlan): Brief {
    const ledger = this.mustGet(ideaId);
    const spec = this.deps.ledger.readBody(ideaId) ?? '';
    const brief: Brief = {
      id: this.genId('brief'),
      ideaId,
      title: ledger.title,
      spec,
      plan,
      status: 'draft',
      createdAt: this.now(),
    };
    this.deps.briefs.insert(brief);
    this.setStatus(ideaId, 'compiled');
    return brief;
  }

  getBrief(id: string): Brief | null {
    return this.deps.briefs.getById(id);
  }

  listBriefs(): Brief[] {
    return this.deps.briefs.list();
  }

  /**
   * The hard delegation gate: confirm a Brief and dispatch its plan.
   *
   * The confirmation is journaled on the Brief row (`confirmedAt` /
   * `confirmedBy`, DEC-012) **before** dispatch — the record of the
   * human's decision exists even if every spawn then fails. Dispatch
   * runs each plan task through the normal manager spawn path, which
   * routes per provider/model intent under quota + preference rules.
   *
   * @throws when the brief is missing, already confirmed, or no
   *   dispatcher is wired.
   */
  async confirmBrief(briefId: string, confirmedBy: string): Promise<ConfirmBriefResult> {
    const brief = this.deps.briefs.getById(briefId);
    if (brief === null) {
      throw new Error(`brief not found: ${briefId}`);
    }
    if (brief.status !== 'draft') {
      throw new Error(`brief ${briefId} is already ${brief.status} — the gate is single-shot`);
    }
    if (this.deps.dispatcher === undefined) {
      throw new Error('no dispatcher wired — brief cannot be confirmed without a spawn path');
    }

    // Journal the gate decision first, then dispatch.
    const confirmed: Brief = {
      ...brief,
      status: 'confirmed',
      confirmedAt: this.now(),
      confirmedBy,
    };
    this.deps.briefs.update(confirmed);

    const results: BriefDispatchResult[] = [];
    for (const task of brief.plan.tasks) {
      const input: SpawnTaskInput = {
        objective: task.objective,
        ...(task.workType !== undefined ? { workType: task.workType } : {}),
        ...(task.preferProvider !== undefined ? { preferProvider: task.preferProvider } : {}),
        ...(task.preferModel !== undefined ? { preferModel: task.preferModel } : {}),
      };
      const result = await this.deps.dispatcher.spawnTask(brief.plan.projectId, input);
      results.push(this.toDispatchResult(task.objective, result));
    }

    const dispatched: Brief = { ...confirmed, status: 'dispatched', dispatchedAt: this.now() };
    this.deps.briefs.update(dispatched);
    return { brief: dispatched, results };
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  private mustGet(id: string): IdeaLedger {
    const ledger = this.deps.ledger.get(id);
    if (ledger === null) {
      throw new Error(`idea ledger not found: ${id}`);
    }
    return ledger;
  }

  private setStatus(id: string, status: IdeaStatus): void {
    this.deps.ledger.setStatus(id, status, this.now());
  }

  private toDispatchResult(objective: string, result: SpawnTaskResult): BriefDispatchResult {
    switch (result.status) {
      case 'spawned':
        return {
          objective,
          status: 'spawned',
          taskId: result.taskId,
          provider: result.provider,
          reason: result.reason,
        };
      case 'parked':
        return { objective, status: 'parked', reason: result.reason };
      case 'error':
        return { objective, status: 'error', reason: result.error };
    }
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private genId(prefix: string): EntityId {
    return (
      this.deps.generateId?.(prefix) ??
      `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
    );
  }
}
