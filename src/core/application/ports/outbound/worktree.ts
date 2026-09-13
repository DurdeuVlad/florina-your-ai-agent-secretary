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
