/**
 * Digest & diff viewer view-layer types (DEC-009, DEC-012, issue #27).
 *
 * These are pure, JSON-serializable data structures describing display-ready
 * representations of a {@link CompletionDigest} (#16) and a {@link DiffDigest}
 * (#17). No DOM, no React, no framework. The desktop renderer (or any other
 * surface) consumes them and projects them onto whatever concrete rendering
 * technology it uses.
 *
 * Per DEC-012, the digest is a *projection* over the immutable event journal —
 * it never replaces the source events. Per DEC-009, the differentiator is the
 * executive digest before deep review: these view models surface the
 * deterministic, scannable summary so the human can decide whether to drill
 * into the diff.
 *
 * All fields are readonly primitives or plain records so the whole view is
 * JSON-serializable and can cross the IPC boundary (DEC-028).
 */
import type { ChangedFileStatus } from '../../../../core/application/use-cases/attention/diff-digest.js';
import type { RiskHighlight } from '../../../../core/application/use-cases/attention/completion-digest.js';

/* ------------------------------------------------------------------ *
 * Semantic color tokens
 * ------------------------------------------------------------------ */

/**
 * A semantic color token used by the digest/diff viewer. Each rendering
 * surface maps it to its own palette.
 *
 * - `green`  — passing tests, additions, success
 * - `red`    — failing tests, deletions, failure
 * - `orange` — risk highlights (warning level)
 * - `amber`  — pending approvals
 * - `slate`  — neutral / muted
 */
export type DigestColor = 'green' | 'red' | 'orange' | 'amber' | 'slate';

/* ------------------------------------------------------------------ *
 * Test results
 * ------------------------------------------------------------------ */

/**
 * Display-ready test results (PRODUCT_DESIGN.md "Verification").
 *
 * Aggregates the pass/fail counts from a {@link CompletionDigest} into a
 * structure with semantic color indicators so templates don't need to compute
 * them.
 */
export interface TestResultsView {
  /** Total number of test cases executed. */
  readonly run: number;
  /** Number of tests that passed. */
  readonly passed: number;
  /** Number of tests that failed. */
  readonly failed: number;
  /** Whether every test passed. */
  readonly allPassed: boolean;
  /** Whether no tests were run. */
  readonly noneRun: boolean;
  /** Semantic color token for the pass indicator (`green` when all pass). */
  readonly passColor: DigestColor;
  /** Semantic color token for the fail indicator (`red` when any fail). */
  readonly failColor: DigestColor;
  /** Human-readable one-line summary (e.g. "23/23 passing"). */
  readonly summary: string;
}

/* ------------------------------------------------------------------ *
 * Approval stats
 * ------------------------------------------------------------------ */

/**
 * Display-ready approval statistics (DEC-010 / DEC-011).
 *
 * Aggregates the granted/denied/pending counts from a
 * {@link CompletionDigest}. `pending` is derived: the number of requested
 * approvals that were neither granted nor denied.
 */
export interface ApprovalStatsView {
  /** Number of approval requests issued by the agent. */
  readonly requested: number;
  /** Number of approvals that were granted. */
  readonly granted: number;
  /** Number of approvals that were denied. */
  readonly denied: number;
  /** Number of approvals still pending (requested − granted − denied). */
  readonly pending: number;
  /** Human-readable one-line summary (e.g. "2 granted, 0 denied, 1 pending"). */
  readonly summary: string;
}

/* ------------------------------------------------------------------ *
 * Risk highlights
 * ------------------------------------------------------------------ */

/**
 * Display-ready risk highlight (PRODUCT_DESIGN.md "Risk").
 *
 * Wraps a {@link RiskHighlight} with a semantic color token so templates can
 * render it without re-deriving the color.
 */
export interface RiskHighlightView {
  /** Category of risk. */
  readonly kind: RiskHighlight['kind'];
  /** Human-readable description of the risk. */
  readonly message: string;
  /** Semantic color token (`red` for critical/blocking, `orange` otherwise). */
  readonly color: DigestColor;
}

/* ------------------------------------------------------------------ *
 * File change (diff viewer)
 * ------------------------------------------------------------------ */

/**
 * Display-ready representation of a single changed file.
 *
 * Adds display metadata (`isBinary`, `isLargeChange`, `totalChanged`) to the
 * deterministic {@link ChangedFile} so templates don't need to recompute.
 */
export interface FileChangeView {
  /** Repository-relative path of the file after the change. */
  readonly path: string;
  /** Nature of the change. */
  readonly status: ChangedFileStatus;
  /** Lines added. */
  readonly additions: number;
  /** Lines deleted. */
  readonly deletions: number;
  /** Total lines changed (additions + deletions). */
  readonly totalChanged: number;
  /** Previous path, only for `renamed` changes. */
  readonly renamedFrom?: string;
  /** Whether the file is binary (heuristic: non-deleted with 0 line changes). */
  readonly isBinary: boolean;
  /** Whether this is a large change (>100 lines changed). */
  readonly isLargeChange: boolean;
}

/* ------------------------------------------------------------------ *
 * Diff stats & grouping
 * ------------------------------------------------------------------ */

/**
 * Summary statistics for a diff.
 */
export interface DiffStatsView {
  /** Total number of files changed. */
  readonly totalFiles: number;
  /** Total lines added across all files. */
  readonly totalAdditions: number;
  /** Total lines deleted across all files. */
  readonly totalDeletions: number;
  /** Net line change (additions − deletions). */
  readonly netChange: number;
  /** Number of files flagged as large changes (>100 lines). */
  readonly largeChangeCount: number;
}

/**
 * Files grouped by their change status (added / modified / deleted / renamed).
 *
 * Empty groups are omitted from the view data.
 */
export interface FileGroupView {
  /** The change status this group represents. */
  readonly status: ChangedFileStatus;
  /** Files in this group. */
  readonly files: readonly FileChangeView[];
  /** Number of files in this group. */
  readonly count: number;
}

/* ------------------------------------------------------------------ *
 * DigestViewData
 * ------------------------------------------------------------------ */

/**
 * Display-ready representation of a {@link CompletionDigest}.
 *
 * {@link DigestViewModel.buildView} transforms a {@link CompletionDigest} into
 * this structure, formatting duration, test results, approval stats, and risk
 * highlights into display-ready fields. All fields are readonly primitives or
 * plain records so the whole view is JSON-serializable.
 */
export interface DigestViewData {
  /** Identifier of the Task this digest summarizes. */
  readonly taskId: string;
  /** Identifier of the Session (run) the digest was built from. */
  readonly sessionId: string;
  /** Identifier of the agent that executed the session. */
  readonly agentId: string;
  /** ISO-8601 timestamp of the first event. */
  readonly startedAt: string;
  /** ISO-8601 timestamp of the completion event. */
  readonly completedAt: string;
  /** Wall-clock duration in milliseconds (raw, for sorting / display). */
  readonly durationMs: number;
  /** Human-readable duration (e.g. "2m 34s"). */
  readonly durationLabel: string;
  /** Concise, scannable, human-readable summary. */
  readonly summary: string;
  /** Number of files changed. */
  readonly filesChangedCount: number;
  /** Repository-relative paths of changed files. */
  readonly filesChanged: readonly string[];
  /** Display-ready test results. */
  readonly testResults: TestResultsView;
  /** Display-ready approval statistics. */
  readonly approvalStats: ApprovalStatsView;
  /** Display-ready risk highlights. */
  readonly riskHighlights: readonly RiskHighlightView[];
  /** Decision Ledger references (DEC-NNN + note). */
  readonly decisions: readonly {
    readonly id: string;
    readonly note: string;
  }[];
  /** Head commit hash, when available. */
  readonly commitHash?: string;
  /** Branch name, when available. */
  readonly branchName?: string;
  /** Whether the run had any risk highlights. */
  readonly hasRisks: boolean;
}

/* ------------------------------------------------------------------ *
 * DiffViewData
 * ------------------------------------------------------------------ */

/**
 * Display-ready representation of a {@link DiffDigest}.
 *
 * {@link DiffViewModel.buildView} transforms a {@link DiffDigest} into this
 * structure, grouping changed files by status and computing summary stats.
 */
export interface DiffViewData {
  /** Current branch name of the worktree. */
  readonly branch: string;
  /** Base commit SHA the diff is measured from. */
  readonly baseCommit: string;
  /** Head commit SHA of the worktree HEAD. */
  readonly headCommit: string;
  /** Author of the head commit. */
  readonly author: string;
  /** Commit message (subject line) of the head commit. */
  readonly commitMessage: string;
  /** Files grouped by change status (empty groups omitted). */
  readonly fileGroups: readonly FileGroupView[];
  /** All changed files as flat display-ready list. */
  readonly files: readonly FileChangeView[];
  /** Summary statistics. */
  readonly stats: DiffStatsView;
  /** Raw `git diff --stat` output for drill-down. */
  readonly diffStat: string;
  /** Whether any file is flagged as a large change. */
  readonly hasLargeChanges: boolean;
  /** Files flagged as large changes (>100 lines). */
  readonly largeChanges: readonly FileChangeView[];
}
