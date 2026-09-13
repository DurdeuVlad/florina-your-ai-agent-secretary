/**
 * MCP composition root (DEC-018, DEC-037, issue #63).
 *
 * Wires the inbound MCP adapter family to the daemon's live core services:
 * each incoming manager request is resolved to a project
 * (`x-secretary-project` header or `?project=` query param), then a fresh
 * {@link ManagerToolService} is composed for that project — the
 * CapacityRouter is rebuilt per request so preference-profile edits take
 * effect immediately.
 */
import type { CommandApi } from '../core/application/use-cases/tasks/command-api.js';
import {
  ManagerToolService,
  type ManagerTaskStore,
  type ManagerWorktreePort,
} from '../core/application/use-cases/managers/manager-tools.js';
import { CapacityRouter } from '../core/application/use-cases/routing/capacity-router.js';
import type { QuotaLedger } from '../core/application/use-cases/routing/quota-ledger.js';
import type { ProjectRepositoryPort } from '../core/application/ports/outbound/repositories.js';
import type { PreferenceProfilePort } from '../core/application/ports/outbound/preference-profile.js';
import { mcpProjectId, type ManagerServiceFactory } from '../adapters/inbound/mcp/http-server.js';

/** Dependencies the manager-service factory needs from the daemon. */
export interface ManagerServiceFactoryDeps {
  /** The daemon's typed command surface. */
  readonly commandApi: CommandApi;
  /** Task persistence (the real repository — shared with the state machine). */
  readonly taskStore: ManagerTaskStore;
  /** Worktree lifecycle for spawned tasks (DEC-024). */
  readonly worktreeManager: ManagerWorktreePort;
  /** Live quota ledger (DEC-029). */
  readonly quotaLedger: QuotaLedger;
  /** Durable preference profile — read per request for fresh rules. */
  readonly preferenceStore: PreferenceProfilePort;
  /** Project lookup for scoping the manager service (DEC-003). */
  readonly projects: Pick<ProjectRepositoryPort, 'getById'>;
  /**
   * Resolves the daemon's MCP HTTP URL lazily (the server binds after the
   * factory is composed). Manager-role spawns register this URL in their
   * launch config (issue #63); worker spawns don't need it.
   */
  readonly mcpUrl?: () => string | undefined;
}

/**
 * Build the {@link ManagerServiceFactory} the MCP HTTP server uses to
 * resolve a request to a per-project {@link ManagerToolService}.
 *
 * Throws (→ HTTP 404) when the request carries no project scope or names
 * an unknown project — a manager can only ever act on its own project.
 */
export function managerServiceFactory(deps: ManagerServiceFactoryDeps): ManagerServiceFactory {
  return (request) => {
    const projectId = mcpProjectId(request);
    if (projectId === null) {
      throw new Error(
        'manager connection is missing its project scope ' +
          '(x-secretary-project header or ?project= query param)',
      );
    }
    const project = deps.projects.getById(projectId);
    if (project === null) {
      throw new Error(`unknown project: ${projectId}`);
    }
    // The router is rebuilt per request so profile edits apply at once.
    const router = new CapacityRouter({
      ledger: deps.quotaLedger,
      profile: deps.preferenceStore.toProfile(),
    });
    const mcpUrl = deps.mcpUrl?.();
    return new ManagerToolService({
      commandApi: deps.commandApi,
      router,
      taskStore: deps.taskStore,
      worktreeManager: deps.worktreeManager,
      repoPath: project.repo.path,
      projectId,
      ...(mcpUrl !== undefined ? { mcpUrl } : {}),
    });
  };
}
