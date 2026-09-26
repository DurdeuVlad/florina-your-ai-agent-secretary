export interface WorktreeStatus {
  readonly clean: boolean;
  readonly dirty: boolean;
  readonly branch: string;
  readonly baseCommit: string;
}

export interface WorktreeInfo {
  readonly path: string;
  readonly head: string;
  readonly branch: string;
}

/**
 * Error thrown when an operation is attempted on a dirty worktree that
 * requires a clean one (e.g. `pruneWorktree`). Dirty worktrees are never
 * silently deleted (DEC-024, DEC-011).
 *
 * The error is owned by the port so use cases can catch it without
 * depending on the concrete worktree adapter.
 */
export class DirtyWorktreeError extends Error {
  /** The worktree path that was dirty. */
  readonly worktreePath: string;

  constructor(worktreePath: string) {
    super(
      `Worktree "${worktreePath}" has uncommitted changes and cannot be ` +
        'pruned. Commit or stash the changes first, or remove the worktree ' +
        'manually after reviewing the work (DEC-024).',
    );
    this.name = 'DirtyWorktreeError';
    this.worktreePath = worktreePath;
  }
}

export interface WorktreePort {
  /**
   * Create a worktree for a task slug and return its path. Persisting the
   * resulting path onto a Task is coordinated by the calling use case
   * through a separate port — the worktree adapter performs git operations
   * only.
   */
  createWorktree(repoPath: string, taskSlug: string): string;
  detectDirty(worktreePath: string): boolean;
  worktreeStatus(worktreePath: string): WorktreeStatus;
  pruneWorktree(worktreePath: string): void;
  listWorktrees(repoPath: string): WorktreeInfo[];
  worktreePathFor(repoPath: string, slug: string): string;
}
