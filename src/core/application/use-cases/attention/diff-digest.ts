/**
 * Diff Intelligence Level A — deterministic git digest (DEC-014 / #17).
 *
 * This module defines the structured `DiffDigest` produced entirely from
 * deterministic git plumbing and the immutable event journal — **no LLM
 * calls**. The digest feeds both the attention engine's ELEVATE rules
 * (secrets/auth, migrations, CI/deploy, unexpected lockfile changes) and the
 * Completion Digest's "Observed changes" section
 * (PRODUCT_DESIGN.md "Deliverable Review" / "Diff Intelligence Levels").
 *
 * Level B (explicit deep review via a dedicated code-review agent) is layered
 * on top of this digest only when requested or when policy dictates high risk.
 */

/* ------------------------------------------------------------------ *
 * Changed file
 * ------------------------------------------------------------------ */

/** Nature of a single file change, mirroring `git diff --name-status`. */
export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/**
 * A single file changed between the base and head commits of a worktree.
 *
 * `additions` / `deletions` are line counts from `git diff --numstat`.
 * `renamedFrom` is populated only when `status` is `'renamed'`.
 */
export interface ChangedFile {
  /** Repository-relative path of the file after the change. */
  readonly path: string;
  /** Lines added (from `git diff --numstat`). */
  readonly additions: number;
  /** Lines deleted (from `git diff --numstat`). */
  readonly deletions: number;
  /** Nature of the change. */
  readonly status: ChangedFileStatus;
  /** Previous path, only for `renamed` changes. */
  readonly renamedFrom?: string;
}

/* ------------------------------------------------------------------ *
 * Path classification
 * ------------------------------------------------------------------ */

/**
 * The seven deterministic path categories used by the attention engine's
 * ELEVATE rules (PRODUCT_DESIGN.md "Attention Model").
 *
 * - `secrets-auth`     — secrets / auth boundaries → always ELEVATE
 * - `migrations`       — schema migrations → always ELEVATE
 * - `ci-deploy`        — CI / deploy config → always ELEVATE
 * - `lockfile`         — lockfiles → ELEVATE when unexpected
 * - `test`             — test files → batched, but tracked
 * - `config-security`  — config / security policy → ELEVATE
 * - `source`           — ordinary source → batched
 */
export type PathCategory =
  'secrets-auth' | 'migrations' | 'ci-deploy' | 'lockfile' | 'test' | 'config-security' | 'source';

/**
 * Result of classifying a single changed path.
 *
 * `isSensitive` is `true` for every category that triggers an ELEVATE rule
 * (`secrets-auth`, `migrations`, `ci-deploy`, `config-security`) and for
 * unexpected lockfile changes (computed by the analyzer, not by the
 * classifier alone).
 */
export interface PathClassification {
  /** Repository-relative path of the classified file. */
  readonly path: string;
  /** Deterministic category. */
  readonly category: PathCategory;
  /**
   * Whether this path is attention-sensitive (feeds ELEVATE rules).
   *
   * For lockfiles this is `false` from the classifier itself; the analyzer
   * may mark an *unexpected* lockfile change as sensitive separately.
   */
  readonly isSensitive: boolean;
}

/* ------------------------------------------------------------------ *
 * Test results (from the event journal)
 * ------------------------------------------------------------------ */

/**
 * Aggregated result of a single test run, collected from `TestStarted` /
 * `TestFinished` events in the immutable event journal (DEC-019).
 */
export interface TestResult {
  /** Name of the test target (file / suite / command), when known. */
  readonly name: string;
  /** Whether the run passed (zero failures). */
  readonly passed: boolean;
  /** Wall-clock duration in milliseconds, when reported. */
  readonly duration?: number;
}

/* ------------------------------------------------------------------ *
 * Diff digest
 * ------------------------------------------------------------------ */

/**
 * The Level A deterministic diff digest.
 *
 * Every field is derived from git plumbing or the event journal — never from
 * an LLM. This is the "Observed changes" + "Verification" backbone of the
 * Completion Digest; inferred behavior / risk are layered on top by the LLM
 * in a separate, clearly-labeled step (PRODUCT_DESIGN.md "Deliverable
 * Review").
 */
export interface DiffDigest {
  /** Current branch name of the worktree (e.g. `florina/add-pagination`). */
  readonly branch: string;
  /** Base commit SHA the diff is measured from. */
  readonly baseCommit: string;
  /** Head commit SHA of the worktree HEAD. */
  readonly headCommit: string;
  /** Author of the head commit (`Name <email>`). */
  readonly author: string;
  /** Commit message (subject line) of the head commit. */
  readonly commitMessage: string;
  /** Files changed between base and head. */
  readonly changedFiles: readonly ChangedFile[];
  /** Raw `git diff --stat` output for human-readable drill-down. */
  readonly diffStat: string;
  /** Test results aggregated from the event journal, when available. */
  readonly testResults?: readonly TestResult[];
  /** Deterministic classification of every changed path. */
  readonly pathClassifications: readonly PathClassification[];
  /**
   * `true` when a lockfile changed without any corresponding source change
   * (an "unexpected lockfile change" — ELEVATE per PRODUCT_DESIGN.md).
   */
  readonly unexpectedLockfileChange: boolean;
}
