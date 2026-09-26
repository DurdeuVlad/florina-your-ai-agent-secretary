/**
 * Diff Intelligence Level A — deterministic git digest analyzer (#17).
 *
 * `DiffAnalyzer` produces a {@link DiffDigest} entirely from git plumbing
 * (`git diff --stat`, `git diff --numstat`, `git diff --name-status -M`,
 * `git log`) and the immutable event journal — **no LLM calls**. The digest
 * feeds both the attention engine's ELEVATE rules and the Completion Digest's
 * "Observed changes" section (PRODUCT_DESIGN.md "Deliverable Review" /
 * "Diff Intelligence Levels").
 *
 * `collectTestResults` aggregates `TestStarted` / `TestFinished` events from
 * the journal into {@link TestResult} entries.
 */
import type { GitClientPort } from '../../ports/outbound/git-client.js';
import type { EventSourcePort } from '../../ports/outbound/context-sources.js';
import type {
  ChangedFile,
  ChangedFileStatus,
  DiffDigest,
  PathCategory,
  PathClassification,
  TestResult,
} from './diff-digest.js';

/* ------------------------------------------------------------------ *
 * Path classification patterns
 * ------------------------------------------------------------------ */

/**
 * Filename substrings / exact names that mark a path as a lockfile.
 * Order matters: lockfiles are matched as exact basename *or* substring.
 */
const LOCKFILE_NAMES: readonly string[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
];

/** Substrings that mark a path as secrets / auth boundary. */
const SECRETS_AUTH_PATTERNS: readonly string[] = [
  'auth',
  'secret',
  'key',
  'token',
  'credential',
  '.env',
];

/** Substrings that mark a path as a schema migration. */
const MIGRATION_PATTERNS: readonly string[] = ['migration', 'migrate', 'schema.sql'];

/** Substrings that mark a path as CI / deploy configuration. */
const CI_DEPLOY_PATTERNS: readonly string[] = [
  '.github/workflows',
  'Dockerfile',
  'docker-compose',
  '.circleci',
  'Jenkinsfile',
  'deploy',
];

/** Substrings that mark a path as config / security policy. */
const CONFIG_SECURITY_PATTERNS: readonly string[] = [
  '.eslintrc',
  'tsconfig.json',
  '.prettierrc',
  'security',
  'permission',
];

/** Substrings that mark a path as a test file. */
const TEST_PATTERNS: readonly string[] = ['test', 'spec', '.test.', '.spec.'];

/**
 * Categories that are always attention-sensitive (drive ELEVATE rules).
 * Lockfiles are handled separately because they are only sensitive when
 * *unexpected*.
 */
const ALWAYS_SENSITIVE_CATEGORIES: readonly PathCategory[] = [
  'secrets-auth',
  'migrations',
  'ci-deploy',
  'config-security',
];

/* ------------------------------------------------------------------ *
 * DiffAnalyzer
 * ------------------------------------------------------------------ */

/**
 * Produces deterministic {@link DiffDigest}s from a git worktree.
 *
 * All git operations run through the injected {@link GitClientPort}; the
 * concrete client owns subprocess execution and shell quoting.
 */
export class DiffAnalyzer {
  constructor(private readonly git: GitClientPort) {}

  /**
   * Analyze a worktree and produce a deterministic {@link DiffDigest}.
   *
   * @param worktreePath Absolute path of the git worktree to analyze.
   * @param baseCommit   Optional base commit SHA to diff from. When omitted,
   *                     the first parent of HEAD is used (i.e. the diff of
   *                     the head commit), falling back to the root when HEAD
   *                     has no parent (initial commit).
   * @returns The {@link DiffDigest}.
   */
  analyze(worktreePath: string, baseCommit?: string): DiffDigest {
    const head = this.git.run(['rev-parse', 'HEAD'], worktreePath).trim();
    const base = baseCommit ?? this.resolveBaseCommit(worktreePath, head);

    const branch = this.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).trim();
    const author = this.git.run(['log', '-1', '--format=%an <%ae>'], worktreePath).trim();
    const commitMessage = this.git.run(['log', '-1', '--format=%s'], worktreePath).trim();

    const diffStat = this.git.run(['diff', '--stat', `${base}..${head}`], worktreePath).trim();

    const changedFiles = this.collectChangedFiles(worktreePath, base, head);
    const pathClassifications = changedFiles.map((f) => this.classifyPath(f.path));

    const unexpectedLockfileChange = this.detectUnexpectedLockfileChanges(
      changedFiles,
      pathClassifications,
    );

    return {
      branch,
      baseCommit: base,
      headCommit: head,
      author,
      commitMessage,
      changedFiles,
      diffStat,
      pathClassifications,
      unexpectedLockfileChange,
    };
  }

  /**
   * Classify a single file path into one of the seven deterministic
   * {@link PathCategory} values.
   *
   * Classification precedence (first match wins):
   * 1. `secrets-auth`   — secrets / auth boundaries
   * 2. `migrations`     — schema migrations
   * 3. `ci-deploy`      — CI / deploy config
   * 4. `lockfile`       — known lockfile basenames
   * 5. `config-security`— config / security policy
   * 6. `test`           — test files
   * 7. `source`         — everything else
   *
   * `isSensitive` is `true` for the always-sensitive categories. Lockfiles
   * are *not* sensitive from the classifier alone; the analyzer flags
   * unexpected lockfile changes separately via
   * {@link DiffAnalyzer.detectUnexpectedLockfileChanges}.
   *
   * @param path Repository-relative (or absolute) file path to classify.
   * @returns The {@link PathClassification}.
   */
  classifyPath(filePath: string): PathClassification {
    const normalized = filePath.replace(/\\/g, '/');
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);

    // Explicit test-file markers (`.test.`, `.spec.`) take precedence over
    // the sensitive substring matches: a change to `auth.test.ts` is a test
    // change, not a secrets/auth boundary change. The broader `test`/`spec`
    // substring match runs later so that words like "latest" or "special" do
    // not steal sensitive paths (e.g. `latest-token.ts`).
    if (/\.(test|spec)\./.test(normalized)) {
      return { path: filePath, category: 'test', isSensitive: false };
    }
    if (matchesAny(normalized, SECRETS_AUTH_PATTERNS)) {
      return { path: filePath, category: 'secrets-auth', isSensitive: true };
    }
    if (matchesAny(normalized, MIGRATION_PATTERNS)) {
      return { path: filePath, category: 'migrations', isSensitive: true };
    }
    if (matchesAny(normalized, CI_DEPLOY_PATTERNS)) {
      return { path: filePath, category: 'ci-deploy', isSensitive: true };
    }
    if (LOCKFILE_NAMES.some((name) => basename === name || normalized.endsWith(`/${name}`))) {
      return { path: filePath, category: 'lockfile', isSensitive: false };
    }
    if (matchesAny(normalized, TEST_PATTERNS)) {
      return { path: filePath, category: 'test', isSensitive: false };
    }
    if (matchesAny(normalized, CONFIG_SECURITY_PATTERNS)) {
      return { path: filePath, category: 'config-security', isSensitive: true };
    }
    return { path: filePath, category: 'source', isSensitive: false };
  }

  /**
   * Detect renames from `git diff --name-status -M`.
   *
   * Returns the subset of {@link ChangedFile}s whose `status` is `'renamed'`,
   * each carrying the previous path in `renamedFrom`.
   */
  detectRenames(changedFiles: readonly ChangedFile[]): readonly ChangedFile[] {
    return changedFiles.filter((f) => f.status === 'renamed');
  }

  /**
   * Flag an *unexpected* lockfile change: a lockfile changed without any
   * corresponding source change.
   *
   * Per PRODUCT_DESIGN.md, unexpected lockfile changes drive an ELEVATE
   * attention rule. "Corresponding source change" means at least one
   * non-lockfile, non-test path was also changed.
   *
   * @param changedFiles       The full set of changed files.
   * @param pathClassifications Classifications for the same paths (same order).
   * @returns `true` when a lockfile changed with no source/migration/etc. change.
   */
  detectUnexpectedLockfileChanges(
    changedFiles: readonly ChangedFile[],
    pathClassifications: readonly PathClassification[],
  ): boolean {
    const hasLockfile = pathClassifications.some((c) => c.category === 'lockfile');
    if (!hasLockfile) {
      return false;
    }
    // A "corresponding" change is any non-lockfile, non-test change. Test-only
    // changes alongside a lockfile bump are still considered unexpected.
    const hasCorresponding = pathClassifications.some(
      (c) => c.category !== 'lockfile' && c.category !== 'test',
    );
    // Only consider lockfile changes that are not deletions (a deleted lockfile
    // is not an unexpected *bump*).
    const lockfileBumped = changedFiles.some((f, i) => {
      const cat = pathClassifications[i]?.category;
      return cat === 'lockfile' && f.status !== 'deleted';
    });
    return lockfileBumped && !hasCorresponding;
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  /**
   * Resolve the base commit for a diff. When `baseCommit` is not supplied we
   * use the first parent of HEAD; if HEAD has no parent (initial commit) we
   * use the empty tree so the entire initial commit is diffed.
   */
  private resolveBaseCommit(worktreePath: string, head: string): string {
    const parents = this.git
      .run(['rev-list', '--parents', '-n', '1', head], worktreePath)
      .trim()
      .split(/\s+/);
    // Output: "<sha> <parent1> [<parent2> ...]"
    if (parents.length >= 2) {
      return parents[1]!;
    }
    // No parent → initial commit. Use the well-known empty tree SHA.
    return EMPTY_TREE_SHA;
  }

  /**
   * Collect {@link ChangedFile}s by combining `git diff --numstat` (line
   * counts) with `git diff --name-status -M` (status + renames).
   */
  private collectChangedFiles(worktreePath: string, base: string, head: string): ChangedFile[] {
    const range = `${base}..${head}`;
    const numstat = this.git.run(['diff', '--numstat', range], worktreePath);
    const nameStatus = this.git.run(['diff', '--name-status', '-M', range], worktreePath);

    const statsByPath = new Map<string, { additions: number; deletions: number }>();
    for (const line of numstat.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      // Format: "<additions>\t<deletions>\t<path>"
      // Binary files report "-\t-\t<path>".
      const parts = line.split('\t');
      if (parts.length < 3) {
        continue;
      }
      const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0]!, 10);
      const deletions = parts[1] === '-' ? 0 : Number.parseInt(parts[1]!, 10);
      const p = parts.slice(2).join('\t');
      statsByPath.set(p, { additions, deletions });
    }

    const files: ChangedFile[] = [];
    for (const line of nameStatus.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      // Format: "<status>\t<path>" or "<status>\t<old>\t<new>" (rename/copy).
      const parts = line.split('\t');
      const statusChar = parts[0]!;
      const status = parseStatusChar(statusChar[0]!);

      if (statusChar.startsWith('R') || statusChar.startsWith('C')) {
        // Rename / copy: <old>\t<new>
        const renamedFrom = parts[1]!;
        const newPath = parts[2]!;
        const stat = statsByPath.get(newPath) ?? { additions: 0, deletions: 0 };
        files.push({
          path: newPath,
          additions: stat.additions,
          deletions: stat.deletions,
          status,
          renamedFrom,
        });
      } else {
        const filePath = parts[1]!;
        const stat = statsByPath.get(filePath) ?? { additions: 0, deletions: 0 };
        files.push({
          path: filePath,
          additions: stat.additions,
          deletions: stat.deletions,
          status,
        });
      }
    }

    return files;
  }
}

/* ------------------------------------------------------------------ *
 * Test result aggregation from the event journal
 * ------------------------------------------------------------------ */

/**
 * Aggregate `TestStarted` / `TestFinished` events from the immutable event
 * journal into {@link TestResult} entries.
 *
 * Each `TestFinished` event is paired with the most recent preceding
 * `TestStarted` event for the same task (and session, when available) to
 * produce one {@link TestResult}. A `TestFinished` with no preceding
 * `TestStarted` is still reported (named by its target or "unknown").
 *
 * @param taskId           The task whose test events to aggregate.
 * @param eventRepository  The event journal source.
 * @returns Aggregated test results, in chronological order.
 */
export function collectTestResults(taskId: string, eventRepository: EventSourcePort): TestResult[] {
  const events = eventRepository.listByTask(taskId);

  const results: TestResult[] = [];
  let pendingStart: { target?: string; sessionId?: string } | null = null;

  for (const event of events) {
    if (event.kind === 'TestStarted') {
      const payload = event.payload as { target?: string };
      pendingStart = { target: payload.target, sessionId: event.sessionId };
    } else if (event.kind === 'TestFinished') {
      const payload = event.payload as {
        target?: string;
        passed?: number;
        failed?: number;
        durationMs?: number;
      };
      const name = payload.target ?? pendingStart?.target ?? 'unknown';
      const failed = payload.failed ?? 0;
      const passed = payload.passed ?? 0;
      const duration = payload.durationMs;
      results.push({
        name,
        passed: failed === 0 && passed >= 0,
        ...(duration !== undefined ? { duration } : {}),
      });
      pendingStart = null;
    }
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * Internal utilities
 * ------------------------------------------------------------------ */

/** The well-known SHA-1 of the empty git tree (used as a base for the root commit). */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Return `true` when the path contains any of the substrings (case-sensitive
 * for path segments, case-insensitive for the whole path to catch `Auth` /
 * `AUTH`).
 */
function matchesAny(path: string, patterns: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

/** Map a `git diff --name-status` status code to a {@link ChangedFileStatus}. */
function parseStatusChar(ch: string): ChangedFileStatus {
  switch (ch) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      // A copy is treated as an add for attention purposes.
      return 'added';
    default:
      // T (type change), U (unmerged), etc. default to modified.
      return 'modified';
  }
}

/**
 * Re-export the always-sensitive category list so attention-rule consumers
 * can reuse the same source of truth.
 */
export const SENSITIVE_CATEGORIES: readonly PathCategory[] = ALWAYS_SENSITIVE_CATEGORIES;
