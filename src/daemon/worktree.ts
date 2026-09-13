/**
 * Git worktree lifecycle management (DEC-024).
 *
 * In the MVP each Task maps 1:1 to one git worktree and one run
 * (DEC-020, PRODUCT_DESIGN.md "Task Lifecycle"). This module owns the
 * worktree lifecycle: creation on a deterministic branch, dirty-state
 * detection, status queries, pruning of clean worktrees, and listing.
 *
 * ## Branch naming convention (DEC-024 — resolved)
 *
 * Every task worktree is created on a branch named exactly:
 *
 *     secretary/<task-slug>
 *
 * where `<task-slug>` is a sanitized, filesystem- and git-safe identifier
 * derived from the task (e.g. `add-cursor-pagination`). The `secretary/`
 * prefix namespaces all Secretary-managed branches so they are clearly
 * distinguishable from human-authored feature branches and can be listed /
 * cleaned up safely. This convention is documented here, in AGENTS.md, and
 * recorded as the resolution of DEC-024 in the Decision Ledger.
 *
 * ## Prune policy (DEC-024 — resolved)
 *
 * Worktrees are retained until an explicit prune (`secretary prune`).
 * `pruneWorktree` removes a worktree only when it is **clean** (no
 * uncommitted changes). Dirty worktrees are never silently deleted —
 * `pruneWorktree` throws so the human can decide what to do with the
 * uncommitted work (DEC-011: the Secretary narrows permissions and never
 * silently widens them; destroying uncommitted work would be a destructive
 * widening).
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EntityId } from '../domain/types.js';
import type {
  WorktreeInfo,
  WorktreePort,
  WorktreeStatus,
} from '../core/application/ports/outbound/worktree.js';
import type { TaskRepository } from '../storage/repositories/task.js';

/**
 * Prefix for every Secretary-managed worktree branch (DEC-024).
 *
 * Branches are always created as `secretary/<task-slug>`.
 */
export const SECRETARY_BRANCH_PREFIX = 'secretary';

/**
 * Directory name (relative to the repository's parent) where Secretary
 * worktrees are placed. Keeping worktrees outside the main working tree
 * avoids nesting issues with `git worktree add` and keeps the main repo
 * clean.
 */
export const SECRETARY_WORKTREE_DIR = '.secretary-worktrees';

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
 * Error thrown when an operation is attempted on a dirty worktree that
 * requires a clean one (e.g. `pruneWorktree`). Dirty worktrees are never
 * silently deleted (DEC-024, DEC-011).
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
 * All git operations are performed via `child_process` (`git` must be on the
 * PATH). Commands are run synchronously because worktree creation is a
 * prerequisite for task delegation and must complete before the daemon
 * proceeds.
 */
export class WorktreeManager implements WorktreePort {
  private readonly taskRepository?: TaskRepository;

  constructor(options: WorktreeManagerOptions = {}) {
    this.taskRepository = options.taskRepository;
  }

  /**
   * Create a new git worktree for a task on the branch
   * `secretary/<task-slug>` (DEC-024).
   *
   * The worktree is placed at a deterministic path derived from the
   * repository path and the task slug:
   * `<parent-of-repo>/.secretary-worktrees/<repo-basename>-<task-slug>`.
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
  createWorktree(repoPath: string, taskSlug: string, taskId?: EntityId): string {
    const slug = sanitizeSlug(taskSlug);
    const branch = `${SECRETARY_BRANCH_PREFIX}/${slug}`;
    const worktreePath = this.worktreePathFor(repoPath, slug);

    // `git worktree add` creates the worktree directory itself, but its
    // parent must already exist.
    const parentDir = path.dirname(worktreePath);
    fs.mkdirSync(parentDir, { recursive: true });
    this.git(['worktree', 'add', worktreePath, '-b', branch], repoPath);

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

  /**
   * Detect whether a worktree has uncommitted changes.
   *
   * Runs `git status --porcelain` and returns `true` when any output is
   * produced (i.e. there are staged, unstaged, or untracked changes).
   *
   * @param worktreePath Absolute path of the worktree to inspect.
   * @returns `true` when the worktree is dirty.
   */
  detectDirty(worktreePath: string): boolean {
    const output = this.git(['status', '--porcelain'], worktreePath);
    return output.trim().length > 0;
  }

  /**
   * Return a status snapshot for a worktree: clean/dirty, current branch,
   * and the base commit SHA.
   *
   * The `dirty` flag surfaces as an attention-relevant status so callers
   * (e.g. the attention engine) can elevate a dirty completed/cancelled
   * worktree for human review (DEC-024).
   *
   * @param worktreePath Absolute path of the worktree to inspect.
   * @returns The {@link WorktreeStatus} snapshot.
   */
  worktreeStatus(worktreePath: string): WorktreeStatus {
    const porcelain = this.git(['status', '--porcelain'], worktreePath);
    const dirty = porcelain.trim().length > 0;
    const branch = this.git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).trim();
    const baseCommit = this.git(['rev-parse', 'HEAD'], worktreePath).trim();
    return {
      clean: !dirty,
      dirty,
      branch,
      baseCommit,
    };
  }

  /**
   * Remove (prune) a worktree.
   *
   * The worktree is removed **only when it is clean**. If the worktree is
   * dirty (uncommitted changes exist) this method throws a
   * {@link DirtyWorktreeError} and leaves the worktree untouched — dirty
   * worktrees are never silently deleted (DEC-024, DEC-011).
   *
   * @param worktreePath Absolute path of the worktree to remove.
   * @throws {DirtyWorktreeError} when the worktree has uncommitted changes.
   * @throws When the underlying `git worktree remove` command fails.
   */
  pruneWorktree(worktreePath: string): void {
    if (this.detectDirty(worktreePath)) {
      throw new DirtyWorktreeError(worktreePath);
    }
    // `git worktree remove` must be run from the main repository (or any
    // worktree of it); running it from inside the worktree being removed
    // would fail. Resolve the admin dir from the worktree path, then run
    // against the main repo.
    const repoPath = this.resolveMainRepoPath(worktreePath);
    this.git(['worktree', 'remove', worktreePath], repoPath);
  }

  /**
   * List all worktrees belonging to a repository.
   *
   * @param repoPath Absolute path of the main repository.
   * @returns An array of {@link WorktreeInfo} entries, including the main
   *          working tree as the first entry.
   */
  listWorktrees(repoPath: string): WorktreeInfo[] {
    const output = this.git(['worktree', 'list', '--porcelain'], repoPath);
    return parseWorktreeList(output);
  }

  /**
   * Compute the deterministic worktree path for a repository + slug.
   *
   * Worktrees are placed in a sibling `.secretary-worktrees` directory so
   * they never nest inside the main working tree (which `git worktree add`
   * refuses) and so the path is stable across runs.
   */
  worktreePathFor(repoPath: string, slug: string): string {
    const parent = path.dirname(repoPath);
    const repoBasename = path.basename(repoPath);
    return path.join(parent, SECRETARY_WORKTREE_DIR, `${repoBasename}-${slug}`);
  }

  /**
   * Resolve the main repository path from any linked worktree by reading
   * `git rev-parse --git-common-dir` and walking up to the repository root.
   */
  private resolveMainRepoPath(worktreePath: string): string {
    const commonDir = this.git(['rev-parse', '--git-common-dir'], worktreePath).trim();
    // `commonDir` is typically `<main-repo>/.git`. The main repo root is its
    // parent directory.
    const normalized = path.normalize(commonDir);
    if (path.basename(normalized) === '.git') {
      return path.dirname(normalized);
    }
    // Fallback: if for some reason the common dir is not under a `.git`
    // folder, return it as-is (git will still resolve the worktree admin
    // metadata correctly).
    return normalized;
  }

  /**
   * Run a git command synchronously and return its stdout.
   *
   * @throws When git exits with a non-zero status. The stderr is included in
   *         the error message for diagnostics.
   */
  private git(args: readonly string[], cwd: string): string {
    const result = execSync(`git ${args.map(shellQuote).join(' ')}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result;
  }
}

/**
 * Sanitize a task slug into a git- and filesystem-safe branch component.
 *
 * Lowercases the input, replaces any run of characters outside
 * `[a-z0-9-]` with a single hyphen, and trims leading/trailing hyphens.
 * Throws if the result is empty.
 */
export function sanitizeSlug(slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (sanitized.length === 0) {
    throw new Error(
      `Invalid task slug "${slug}": sanitized slug must be non-empty and ` +
        'contain only lowercase alphanumeric characters and hyphens.',
    );
  }
  return sanitized;
}

/**
 * Build the canonical Secretary branch name for a task slug (DEC-024).
 *
 * @param taskSlug The raw task slug (will be sanitized).
 * @returns `secretary/<sanitized-slug>`.
 */
export function secretaryBranchName(taskSlug: string): string {
  return `${SECRETARY_BRANCH_PREFIX}/${sanitizeSlug(taskSlug)}`;
}

/**
 * Quote a single argument for the POSIX/Windows shell so paths and branch
 * names with spaces or special characters are passed verbatim to git.
 */
function shellQuote(arg: string): string {
  // Wrap in double quotes and escape any embedded double quotes and
  // backslashes. This is sufficient for both cmd.exe and POSIX shells for
  // the argument shapes git accepts here.
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Parse the output of `git worktree list --porcelain` into structured
 * {@link WorktreeInfo} entries.
 *
 * The porcelain format is blocks separated by blank lines, each block
 * containing `worktree <path>`, `HEAD <sha>`, and optionally `branch <ref>`.
 */
function parseWorktreeList(output: string): WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  const blocks = output.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) {
      continue;
    }
    let worktreePath = '';
    let head = '';
    let branch = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        // `branch` is reported as `refs/heads/<name>`; strip the prefix.
        const ref = line.slice('branch '.length);
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      }
    }
    if (worktreePath.length > 0) {
      entries.push({ path: path.normalize(worktreePath), head, branch });
    }
  }
  return entries;
}
