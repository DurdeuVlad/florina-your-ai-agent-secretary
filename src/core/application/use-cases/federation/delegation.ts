/**
 * Federated delegation service (DEC-036, issue #78) — the child-side
 * entry point for remote delegations.
 *
 * A parent Secretary sends `delegate-task` to a child daemon; this
 * service resolves the named project (the repo must exist on this
 * machine — the Task Capsule crosses the wire, worktrees stay local),
 * then dispatches through the same route → create → worktree → start
 * machinery every spawn uses. The remote pool is just more capacity in
 * the child's router: quota, preferences, and journaling are identical
 * to a local spawn.
 */
import type { CommandExecutor } from '../tasks/command-api.js';
import type { CapacityRouter } from '../routing/capacity-router.js';
import type {
  ManagerTaskStore,
  ManagerWorktreePort,
  SpawnTaskResult,
} from '../managers/manager-tools.js';
import { ManagerToolService } from '../managers/manager-tools.js';
import type { ProjectRepositoryPort } from '../../ports/outbound/repositories.js';

/** Dependencies the delegation service needs from the daemon. */
export interface DelegationServiceDeps {
  /** The child's typed command surface. */
  readonly commandApi: CommandExecutor;
  /**
   * Quota- and preference-aware routing for the delegation. A factory so
   * each delegation reads a fresh preference profile.
   */
  readonly router: () => CapacityRouter;
  /** Task persistence (shared with the state machine). */
  readonly taskStore: ManagerTaskStore;
  /** Worktree lifecycle for spawned tasks (DEC-024). */
  readonly worktreeManager: ManagerWorktreePort;
  /** Project lookup — the repo must live on this machine. */
  readonly projects: Pick<ProjectRepositoryPort, 'getById'>;
}

/** Input to {@link DelegationService.delegate} (`delegate-task`). */
export interface DelegateTaskInput {
  /** Child-side project the task attaches to (DEC-004). */
  readonly projectId: string;
  /** What the remote worker should accomplish (the Task Capsule objective). */
  readonly objective: string;
  /** Optional work-type tag for work-type-specific routing rules. */
  readonly workType?: string;
  /** Parent's preferred provider — honored when eligible (quota, denies). */
  readonly preferProvider?: string;
  /** Model pin to use with the preferred provider. */
  readonly preferModel?: string;
  /** Providers to exclude (e.g. providers the parent already tried). */
  readonly excludeProviders?: readonly string[];
}

/** Raised when a delegation cannot be accepted. */
export class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationError';
  }
}

/**
 * Accepts remote delegations on a child daemon. Each call composes a
 * {@link ManagerToolService} scoped to the named project — the same
 * shape the MCP server builds per request, so remote delegation and
 * manager spawning are one code path.
 */
export class DelegationService {
  private readonly deps: DelegationServiceDeps;

  constructor(deps: DelegationServiceDeps) {
    this.deps = deps;
  }

  /**
   * Create + start a task for a remote parent. Throws
   * {@link DelegationError} when the project is unknown — the parent
   * cannot delegate into a project this machine does not have.
   */
  async delegate(input: DelegateTaskInput): Promise<SpawnTaskResult> {
    if (!input.objective || input.objective.trim().length === 0) {
      return { status: 'error', error: 'objective is required' };
    }
    const project = this.deps.projects.getById(input.projectId);
    if (project === null) {
      return { status: 'error', error: `unknown project: ${input.projectId}` };
    }
    const service = new ManagerToolService({
      commandApi: this.deps.commandApi,
      router: this.deps.router(),
      taskStore: this.deps.taskStore,
      worktreeManager: this.deps.worktreeManager,
      repoPath: project.repo.path,
      projectId: input.projectId,
    });
    return service.spawnTask({
      objective: input.objective,
      ...(input.workType !== undefined ? { workType: input.workType } : {}),
      ...(input.preferProvider !== undefined
        ? { preferProvider: input.preferProvider }
        : {}),
      ...(input.preferModel !== undefined ? { preferModel: input.preferModel } : {}),
      ...(input.excludeProviders !== undefined
        ? { excludeProviders: input.excludeProviders }
        : {}),
    });
  }
}
