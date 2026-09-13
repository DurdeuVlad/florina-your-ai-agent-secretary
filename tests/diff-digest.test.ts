import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import {
  StorageDatabase,
  EventRepository,
  ProjectRepository,
  TaskRepository,
  AgentRepository,
  SessionRepository,
} from '../src/storage/index.js';
import { buildEvent, buildProject, buildTask, buildAgent, buildSession } from '../src/domain/index.js';
import {
  DiffAnalyzer,
  collectTestResults,
} from '../src/attention/diff-analyzer.js';
import type { DiffDigest, PathCategory } from '../src/attention/diff-digest.js';

/* ------------------------------------------------------------------ *
 * Helpers: create a real temporary git repo for integration tests.
 * ------------------------------------------------------------------ */

/**
 * Create a fresh temporary git repository with one initial commit and return
 * its absolute path. The caller is responsible for removing the parent temp
 * directory in `afterEach`.
 */
function createTempGitRepo(): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'florina-diff-'));
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

/** Write a file and stage + commit it in the given repo. */
function commitFile(repoPath: string, relPath: string, content: string, message: string): void {
  const fullPath = path.join(repoPath, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  git(['add', relPath], repoPath);
  git(['commit', '-m', message], repoPath);
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('diff-analyzer: classifyPath covers every category', () => {
  const analyzer = new DiffAnalyzer();

  const cases: Array<{ path: string; category: PathCategory; sensitive: boolean }> = [
    { path: 'src/auth/login.ts', category: 'secrets-auth', sensitive: true },
    { path: 'src/secret/manager.ts', category: 'secrets-auth', sensitive: true },
    { path: 'config/keys/token.json', category: 'secrets-auth', sensitive: true },
    { path: 'src/credential/store.ts', category: 'secrets-auth', sensitive: true },
    { path: '.env', category: 'secrets-auth', sensitive: true },
    { path: 'db/migrations/0001_init.sql', category: 'migrations', sensitive: true },
    { path: 'src/migrate/users.ts', category: 'migrations', sensitive: true },
    { path: 'db/schema.sql', category: 'migrations', sensitive: true },
    { path: '.github/workflows/ci.yml', category: 'ci-deploy', sensitive: true },
    { path: 'Dockerfile', category: 'ci-deploy', sensitive: true },
    { path: 'docker-compose.yml', category: 'ci-deploy', sensitive: true },
    { path: '.circleci/config.yml', category: 'ci-deploy', sensitive: true },
    { path: 'Jenkinsfile', category: 'ci-deploy', sensitive: true },
    { path: 'scripts/deploy.sh', category: 'ci-deploy', sensitive: true },
    { path: 'package-lock.json', category: 'lockfile', sensitive: false },
    { path: 'yarn.lock', category: 'lockfile', sensitive: false },
    { path: 'pnpm-lock.yaml', category: 'lockfile', sensitive: false },
    { path: 'Cargo.lock', category: 'lockfile', sensitive: false },
    { path: 'go.sum', category: 'lockfile', sensitive: false },
    { path: 'poetry.lock', category: 'lockfile', sensitive: false },
    { path: '.eslintrc.json', category: 'config-security', sensitive: true },
    { path: 'tsconfig.json', category: 'config-security', sensitive: true },
    { path: '.prettierrc', category: 'config-security', sensitive: true },
    { path: 'security/policy.md', category: 'config-security', sensitive: true },
    { path: 'src/permission/roles.ts', category: 'config-security', sensitive: true },
    { path: 'src/auth.test.ts', category: 'test', sensitive: false },
    { path: 'tests/login.spec.ts', category: 'test', sensitive: false },
    { path: 'src/utils.test.js', category: 'test', sensitive: false },
    { path: 'src/utils.spec.js', category: 'test', sensitive: false },
    { path: 'src/invoice/service.ts', category: 'source', sensitive: false },
    { path: 'lib/index.js', category: 'source', sensitive: false },
  ];

  for (const { path: p, category, sensitive } of cases) {
    it(`classifies "${p}" as ${category}`, () => {
      const result = analyzer.classifyPath(p);
      expect(result.category).toBe(category);
      expect(result.isSensitive).toBe(sensitive);
      expect(result.path).toBe(p);
    });
  }

  it('handles Windows-style backslash paths', () => {
    const result = analyzer.classifyPath('src\\auth\\login.ts');
    expect(result.category).toBe('secrets-auth');
  });
});

describe('diff-analyzer: analyze (integration with a real temp git repo)', () => {
  let repoPath: string;
  let tmpRoot: string;

  beforeEach(() => {
    repoPath = createTempGitRepo();
    tmpRoot = path.dirname(repoPath);
  });

  afterEach(() => {
    try {
      git(['worktree', 'prune'], repoPath);
    } catch {
      /* ignore */
    }
    rmrf(tmpRoot);
  });

  it('produces a DiffDigest with no LLM calls (deterministic)', () => {
    // Add a source file and a test file in a second commit.
    commitFile(repoPath, 'src/invoice.ts', 'export const x = 1;\n', 'add invoice');
    commitFile(repoPath, 'src/invoice.test.ts', 'test("x", () => {});\n', 'add invoice test');

    const baseCommit = git(['rev-parse', 'HEAD'], repoPath).trim();
    // Make one more commit to diff against the base.
    commitFile(repoPath, 'src/auth/login.ts', 'export const login = () => {};\n', 'add login');

    const analyzer = new DiffAnalyzer();
    const digest = analyzer.analyze(repoPath, baseCommit);

    expect(digest).toBeDefined();
    expect(digest.branch).toBe('main');
    expect(digest.baseCommit).toBe(baseCommit);
    expect(digest.headCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(digest.author).toBe('Test <test@example.com>');
    expect(digest.commitMessage).toBe('add login');

    // The changed file is the auth file added in the head commit.
    const paths = digest.changedFiles.map((f) => f.path);
    expect(paths).toContain('src/auth/login.ts');

    // It is classified as secrets-auth (sensitive).
    const authClass = digest.pathClassifications.find((c) => c.path === 'src/auth/login.ts');
    expect(authClass).toBeDefined();
    expect(authClass!.category).toBe('secrets-auth');
    expect(authClass!.isSensitive).toBe(true);

    // diffStat is a non-empty string.
    expect(typeof digest.diffStat).toBe('string');
    expect(digest.diffStat.length).toBeGreaterThan(0);

    // No test results when no journal is provided.
    expect(digest.testResults).toBeUndefined();
  });

  it('detects renames and reports renamedFrom', () => {
    // Create a file, commit it, then rename it.
    commitFile(repoPath, 'src/old-name.ts', 'export const y = 2;\n', 'add old-name');
    const baseCommit = git(['rev-parse', 'HEAD'], repoPath).trim();

    // Rename via git mv so the rename is detected with -M.
    git(['mv', 'src/old-name.ts', 'src/new-name.ts'], repoPath);
    git(['commit', '-m', 'rename file'], repoPath);

    const analyzer = new DiffAnalyzer();
    const digest = analyzer.analyze(repoPath, baseCommit);

    const renamed = digest.changedFiles.filter((f) => f.status === 'renamed');
    expect(renamed.length).toBeGreaterThanOrEqual(1);

    const rename = renamed.find((f) => f.path === 'src/new-name.ts');
    expect(rename).toBeDefined();
    expect(rename!.renamedFrom).toBe('src/old-name.ts');

    // detectRenames helper returns the renamed subset.
    expect(analyzer.detectRenames(digest.changedFiles)).toEqual(renamed);
  });

  it('flags unexpected lockfile change (lockfile without source change)', () => {
    const baseCommit = git(['rev-parse', 'HEAD'], repoPath).trim();
    // Only touch the lockfile — no source change.
    commitFile(repoPath, 'package-lock.json', '{"lockfileVersion": 3}\n', 'bump lockfile');

    const analyzer = new DiffAnalyzer();
    const digest = analyzer.analyze(repoPath, baseCommit);

    expect(digest.unexpectedLockfileChange).toBe(true);
    const lockfileClass = digest.pathClassifications.find((c) => c.path === 'package-lock.json');
    expect(lockfileClass?.category).toBe('lockfile');
  });

  it('does not flag lockfile change when source also changed', () => {
    const baseCommit = git(['rev-parse', 'HEAD'], repoPath).trim();
    commitFile(repoPath, 'src/feature.ts', 'export const z = 3;\n', 'add feature');
    commitFile(repoPath, 'package-lock.json', '{"lockfileVersion": 3}\n', 'bump lockfile');

    const analyzer = new DiffAnalyzer();
    const digest = analyzer.analyze(repoPath, baseCommit);

    expect(digest.unexpectedLockfileChange).toBe(false);
  });

  it('classifies migrations and CI/deploy paths as sensitive', () => {
    const baseCommit = git(['rev-parse', 'HEAD'], repoPath).trim();
    commitFile(repoPath, 'db/migrations/0001_init.sql', 'CREATE TABLE x;\n', 'add migration');
    commitFile(repoPath, '.github/workflows/ci.yml', 'name: ci\n', 'add ci');

    const analyzer = new DiffAnalyzer();
    const digest = analyzer.analyze(repoPath, baseCommit);

    const migration = digest.pathClassifications.find((c) =>
      c.path.includes('migrations/0001_init.sql'),
    );
    expect(migration?.category).toBe('migrations');
    expect(migration?.isSensitive).toBe(true);

    const ci = digest.pathClassifications.find((c) => c.path.includes('workflows/ci.yml'));
    expect(ci?.category).toBe('ci-deploy');
    expect(ci?.isSensitive).toBe(true);
  });

  it('reports commit metadata: branch, base, head, author, message', () => {
    const baseCommit = git(['rev-parse', 'HEAD'], repoPath).trim();
    commitFile(repoPath, 'src/a.ts', 'export const a = 1;\n', 'feat: add a');

    const analyzer = new DiffAnalyzer();
    const digest: DiffDigest = analyzer.analyze(repoPath, baseCommit);

    expect(digest.branch).toBe('main');
    expect(digest.baseCommit).toBe(baseCommit);
    expect(digest.headCommit).not.toBe(baseCommit);
    expect(digest.author).toBe('Test <test@example.com>');
    expect(digest.commitMessage).toBe('feat: add a');
  });

  it('diffs the whole initial commit when base is the root commit', () => {
    // No base provided; HEAD has one parent (the initial commit), so the diff
    // is just the head commit's changes.
    commitFile(repoPath, 'src/only.ts', 'export const only = 1;\n', 'second commit');

    const analyzer = new DiffAnalyzer();
    const digest = analyzer.analyze(repoPath);

    // baseCommit resolves to the initial commit (HEAD's parent).
    const initial = git(['rev-list', '--max-parents=0', 'HEAD'], repoPath).trim();
    expect(digest.baseCommit).toBe(initial);
    expect(digest.changedFiles.map((f) => f.path)).toContain('src/only.ts');
  });
});

describe('collectTestResults: aggregates TestStarted/TestFinished from the journal', () => {
  let db: StorageDatabase;
  let events: EventRepository;
  let taskId: string;
  let sessionId: string;

  beforeEach(() => {
    db = new StorageDatabase({ path: ':memory:' });
    db.open();
    const raw = db.connection;
    events = new EventRepository(raw);

    // Use the real repositories to satisfy FK constraints.
    const projectRepo = new ProjectRepository(raw);
    const taskRepo = new TaskRepository(raw);
    const agentRepo = new AgentRepository(raw);
    const sessionRepo = new SessionRepository(raw);

    const project = buildProject({ name: 'p', repo: { path: '/tmp/repo' } });
    projectRepo.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'test objective' });
    taskRepo.insert(task);
    const agent = buildAgent({
      name: 'codex',
      provider: 'codex',
      fidelityTier: 'A',
      runtime: { kind: 'cli', command: 'codex' },
    });
    agentRepo.insert(agent);
    const session = buildSession({ taskId: task.id, agentId: agent.id });
    sessionRepo.insert(session);

    taskId = task.id;
    sessionId = session.id;
  });

  afterEach(() => {
    db.close();
  });

  it('aggregates a passing and a failing test run', () => {
    const start1 = buildEvent({
      sessionId,
      taskId,
      kind: 'TestStarted',
      payload: { target: 'src/auth.test.ts', framework: 'vitest' },
    });
    const finish1 = buildEvent({
      sessionId,
      taskId,
      kind: 'TestFinished',
      payload: { target: 'src/auth.test.ts', passed: 5, failed: 0, skipped: 0, durationMs: 1200 },
    });
    const start2 = buildEvent({
      sessionId,
      taskId,
      kind: 'TestStarted',
      payload: { target: 'src/db.test.ts' },
    });
    const finish2 = buildEvent({
      sessionId,
      taskId,
      kind: 'TestFinished',
      payload: { target: 'src/db.test.ts', passed: 2, failed: 1, skipped: 0, durationMs: 800 },
    });

    // Insert in chronological order.
    events.insert(start1);
    events.insert(finish1);
    events.insert(start2);
    events.insert(finish2);

    const results = collectTestResults(taskId, events);
    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe('src/auth.test.ts');
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.duration).toBe(1200);
    expect(results[1]!.name).toBe('src/db.test.ts');
    expect(results[1]!.passed).toBe(false);
    expect(results[1]!.duration).toBe(800);
  });

  it('handles a TestFinished with no preceding TestStarted', () => {
    const finish = buildEvent({
      sessionId,
      taskId,
      kind: 'TestFinished',
      payload: { target: 'src/lonely.test.ts', passed: 3, failed: 0, skipped: 0 },
    });
    events.insert(finish);

    const results = collectTestResults(taskId, events);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('src/lonely.test.ts');
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.duration).toBeUndefined();
  });

  it('returns an empty array when there are no test events', () => {
    const results = collectTestResults(taskId, events);
    expect(results).toEqual([]);
  });

  it('ignores non-test events', () => {
    const other = buildEvent({
      sessionId,
      taskId,
      kind: 'FileChanged',
      payload: { path: 'src/a.ts' },
    });
    events.insert(other);

    const results = collectTestResults(taskId, events);
    expect(results).toEqual([]);
  });
});
