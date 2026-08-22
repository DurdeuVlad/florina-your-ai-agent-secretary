import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import { StorageDatabase, TaskRepository, ProjectRepository } from '../src/storage/index.js';
import { buildProject, buildTask } from '../src/domain/index.js';
import {
  WorktreeManager,
  DirtyWorktreeError,
  secretaryBranchName,
  SECRETARY_BRANCH_PREFIX,
} from '../src/daemon/worktree.js';

/* ------------------------------------------------------------------ *
 * Helpers: create a real temporary git repo for integration tests.
 * ------------------------------------------------------------------ */

/**
 * Create a fresh temporary git repository with one initial commit and return
 * its absolute path. The caller is responsible for removing the parent temp
 * directory in `afterEach`.
 */
function createTempGitRepo(): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-wt-'));
  const repoPath = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(['init', '--initial-branch=main'], repoPath);
  git(['config', 'user.name', 'Test'], repoPath);
  git(['config', 'user.email', 'test@example.com'], repoPath);
  // Seed an initial commit so the repo has a HEAD to branch from.
  const readme = path.join(repoPath, 'README.md');
  fs.writeFileSync(readme, '# test repo\n');
  git(['add', 'README.md'], repoPath);
  git(['commit', '-m', 'initial'], repoPath);
  return repoPath;
}

/** Run a git command synchronously in the given cwd, returning stdout. */
function git(args: readonly string[], cwd: string): string {
  return execSync(`git ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, {
    cwd,
    encoding: 'utf8',
  });
}

/** Recursively remove a directory, ignoring missing paths. */
function rmrf(p: string): void {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('worktree: branch naming convention (DEC-024)', () => {
  it('secretaryBranchName produces secretary/<slug>', () => {
    expect(secretaryBranchName('add-pagination')).toBe('secretary/add-pagination');
  });

  it('sanitizes slugs with spaces and uppercase', () => {
    expect(secretaryBranchName('Add Cursor Pagination!')).toBe('secretary/add-cursor-pagination');
  });

  it('SECRETARY_BRANCH_PREFIX is "secretary"', () => {
    expect(SECRETARY_BRANCH_PREFIX).toBe('secretary');
  });
});

describe('worktree: lifecycle (integration with a real temp git repo)', () => {
  let repoPath: string;
  let tmpRoot: string;

  beforeEach(() => {
    repoPath = createTempGitRepo();
    tmpRoot = path.dirname(repoPath);
  });

  afterEach(() => {
    // Worktrees must be removed before their parent directory can be deleted
    // on some platforms (Windows locks). Prune via git first.
    try {
      git(['worktree', 'prune'], repoPath);
    } catch {
      /* ignore */
    }
    rmrf(tmpRoot);
  });

  it('createWorktree creates a worktree on branch secretary/<slug>', () => {
    const manager = new WorktreeManager();
    const wtPath = manager.createWorktree(repoPath, 'fix-cache-bug');

    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true);

    // The worktree is checked out on the secretary branch.
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath).trim();
    expect(branch).toBe('secretary/fix-cache-bug');

    // The branch exists in the main repo.
    const branches = git(['branch', '--list'], repoPath);
    expect(branches).toContain('secretary/fix-cache-bug');
  });

  it('createWorktree registers the worktree path on the task via TaskRepository', () => {
    const db = new StorageDatabase({ path: ':memory:' });
    db.open();
    const raw = db.connection;
    const projects = new ProjectRepository(raw);
    const tasks = new TaskRepository(raw);

    const project = buildProject({ name: 'p', repo: { path: repoPath } });
    projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'Fix the cache' });
    tasks.insert(task);

    const manager = new WorktreeManager({ taskRepository: tasks });
    const wtPath = manager.createWorktree(repoPath, 'fix-cache', task.id);

    const retrieved = tasks.getById(task.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.worktreePath).toBe(wtPath);

    db.close();
  });

  it('detectDirty returns false for a fresh worktree and true after a change', () => {
    const manager = new WorktreeManager();
    const wtPath = manager.createWorktree(repoPath, 'dirty-detect');

    expect(manager.detectDirty(wtPath)).toBe(false);

    // Introduce an untracked file -> dirty.
    fs.writeFileSync(path.join(wtPath, 'new-file.txt'), 'hello');
    expect(manager.detectDirty(wtPath)).toBe(true);

    // Commit the change -> clean again.
    git(['add', 'new-file.txt'], wtPath);
    git(['commit', '-m', 'add file'], wtPath);
    expect(manager.detectDirty(wtPath)).toBe(false);
  });

  it('worktreeStatus reports clean/dirty, branch, and baseCommit', () => {
    const manager = new WorktreeManager();
    const wtPath = manager.createWorktree(repoPath, 'status-check');

    const status = manager.worktreeStatus(wtPath);
    expect(status.clean).toBe(true);
    expect(status.dirty).toBe(false);
    expect(status.branch).toBe('secretary/status-check');
    expect(status.baseCommit).toMatch(/^[0-9a-f]{7,40}$/);

    // Make it dirty and re-check.
    fs.writeFileSync(path.join(wtPath, 'dirty.txt'), 'x');
    const dirtyStatus = manager.worktreeStatus(wtPath);
    expect(dirtyStatus.dirty).toBe(true);
    expect(dirtyStatus.clean).toBe(false);
  });

  it('pruneWorktree removes a clean worktree', () => {
    const manager = new WorktreeManager();
    const wtPath = manager.createWorktree(repoPath, 'prune-clean');

    expect(fs.existsSync(wtPath)).toBe(true);
    expect(manager.detectDirty(wtPath)).toBe(false);

    manager.pruneWorktree(wtPath);

    expect(fs.existsSync(wtPath)).toBe(false);
    // The worktree no longer appears in `git worktree list`.
    const list = manager.listWorktrees(repoPath);
    expect(list.find((w) => w.path === wtPath)).toBeUndefined();
  });

  it('pruneWorktree refuses a dirty worktree (throws DirtyWorktreeError)', () => {
    const manager = new WorktreeManager();
    const wtPath = manager.createWorktree(repoPath, 'prune-dirty');

    // Introduce uncommitted changes.
    fs.writeFileSync(path.join(wtPath, 'uncommitted.txt'), 'uncommitted');

    expect(() => manager.pruneWorktree(wtPath)).toThrow(DirtyWorktreeError);
    // The worktree is still present — never silently deleted.
    expect(fs.existsSync(wtPath)).toBe(true);

    // Committing the change makes it prunable.
    git(['add', 'uncommitted.txt'], wtPath);
    git(['commit', '-m', 'commit it'], wtPath);
    manager.pruneWorktree(wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it('listWorktrees shows the created worktree on the secretary branch', () => {
    const manager = new WorktreeManager();
    const wtPath = manager.createWorktree(repoPath, 'list-me');

    const list = manager.listWorktrees(repoPath);
    // The main working tree is always the first entry.
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].path).toBe(path.normalize(repoPath));

    const entry = list.find((w) => w.path === path.normalize(wtPath));
    expect(entry).toBeDefined();
    expect(entry!.branch).toBe('secretary/list-me');
    expect(entry!.head).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
