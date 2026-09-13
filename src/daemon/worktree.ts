/**
 * Git worktree lifecycle management (DEC-024) — compatibility wrapper.
 *
 * The canonical worktree adapter is {@link GitWorktreeAdapter} in
 * `src/adapters/outbound/git/worktree-manager.ts` (issue #92). This module
 * retains the legacy {@link WorktreeManager} surface: an optional
 * `taskRepository` plus an optional `taskId` on `createWorktree` that
 * registers the worktree path on the task row after creation. Task
 * persistence stays here — the canonical adapter is pure git.
 *
 * ## Branch naming convention (DEC-024 — resolved)
 *
 * Every task worktree is created on a branch named exactly:
 *
 *     florina/<task-slug>
 *
 * where `<task-slug>` is a sanitized, filesystem- and git-safe identifier
 * derived from the task (e.g. `add-cursor-pagination`). The `florina/`
 * prefix namespaces all Florina-managed branches so they are clearly
 * distinguishable from human-authored feature branches and can be listed /
 * cleaned up safely. This convention is documented here, in AGENTS.md, and
 * recorded as the resolution of DEC-024 in the Decision Ledger.
 *
 * ## Prune policy (DEC-024 — resolved)
 *
 * Worktrees are retained until an explicit prune (`florina prune`).
 * `pruneWorktree` removes a worktree only when it is **clean** (no
 * uncommitted changes). Dirty worktrees are never silently deleted —
 * `pruneWorktree` throws so the human can decide what to do with the
 * uncommitted work (DEC-011: the Florina narrows permissions and never
 * silently widens them; destroying uncommitted work would be a destructive
 * widening).
 */
import type { EntityId } from '../core/domain/types.js';
import { DirtyWorktreeError } from '../core/application/ports/outbound/worktree.js';
import type { TaskRepository } from '../storage/repositories/task.js';
import { GitWorktreeAdapter } from '../adapters/outbound/git/worktree-manager.js';

/**
 * Re-export the canonical Git constants and helpers so daemon consumers can
 * keep importing them here. The source of truth is
 * `src/adapters/outbound/git/worktree-manager.ts` (issue #92).
 */
export {
  FLORINA_BRANCH_PREFIX,
  FLORINA_WORKTREE_DIR,
  sanitizeSlug,
  florinaBranchName,
} from '../adapters/outbound/git/worktree-manager.js';

/**
 * Re-export the core-owned worktree contract types so daemon consumers can
 * keep importing them here. The source of truth is
 * `src/core/application/ports/outbound/worktree.ts` (DEC-037).
 */
export type {
  WorktreeInfo,
  WorktreeStatus,
} from '../core/application/ports/outbound/worktree.js';

/**
 * `DirtyWorktreeError` is owned by the core worktree port (DEC-037) so use
 * cases can catch it without depending on this concrete adapter; re-exported
 * here for compatibility with existing daemon-path imports.
 */
export { DirtyWorktreeError };

/**
 * Options for constructing a {@link WorktreeManager}.
 */
export interface WorktreeManagerOptions {
  /**
   * Optional {@link TaskRepository} used to register the worktree path in a
   * task's metadata when {@link WorktreeManager.createWorktree} is called
   * with a `taskId`.
   */
  readonly taskRepository?: TaskRepository;
}

/**
 * Manages the git worktree lifecycle for tasks (DEC-024).
 *
 * Extends the canonical {@link GitWorktreeAdapter} with the legacy task
 * persistence seam: when `createWorktree` is given a `taskId` (and a
 * `taskRepository` was supplied to the constructor) the worktree path is
 * registered on the task via `taskRepository.update`.
 */
export class WorktreeManager extends GitWorktreeAdapter {
  private readonly taskRepository?: TaskRepository;

  constructor(options: WorktreeManagerOptions = {}) {
    super();
    this.taskRepository = options.taskRepository;
  }

  /**
   * Create a new git worktree for a task on the branch
   * `florina/<task-slug>` (DEC-024).
   *
   * The worktree is placed at a deterministic path derived from the
   * repository path and the task slug:
   * `<parent-of-repo>/.florina-worktrees/<repo-basename>-<task-slug>`.
   *
   * @param repoPath   Absolute path to the main repository (the worktree's
   *                   base).
   * @param taskSlug   Task slug used for the branch name and worktree path.
   *                   Sanitized to be git- and filesystem-safe.
   * @param taskId     Optional task id. When provided (and a
   *                   `taskRepository` was supplied to the constructor) the
   *                   worktree path is registered on the task via
   *                   `taskRepository.update`.
   * @returns The absolute path of the created worktree.
   * @throws When the git command fails (e.g. the branch already exists or
   *         the worktree path is in use).
   */
  override createWorktree(repoPath: string, taskSlug: string, taskId?: EntityId): string {
    const worktreePath = super.createWorktree(repoPath, taskSlug);

    if (taskId !== undefined && this.taskRepository !== undefined) {
      const task = this.taskRepository.getById(taskId);
      if (task !== null) {
        this.taskRepository.update({
          ...task,
          worktreePath,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return worktreePath;
  }
}
