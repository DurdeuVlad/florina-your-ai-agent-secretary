/**
 * View model for the Completion Digest viewer (DEC-009, DEC-012, issue #27).
 *
 * {@link DigestViewModel} transforms a {@link CompletionDigest} (#16) into
 * display-ready {@link DigestViewData}. It formats the wall-clock duration as
 * a human-readable label, aggregates test results into pass/fail counts with
 * semantic color indicators, aggregates approval stats into
 * granted/denied/pending counts, and maps risk highlights to color tokens.
 *
 * Per DEC-012, the digest is a *projection* over the immutable event journal —
 * it never replaces the source events. Per DEC-009, the differentiator is the
 * executive digest before deep review: this view model surfaces the
 * deterministic, scannable summary so the human can decide whether to drill
 * into the diff.
 *
 * The view model is pure and synchronous: no DOM, no framework, no side
 * effects. This keeps the digest view logic fully testable with vitest and
 * identical across rendering surfaces (desktop webview, TUI, CLI).
 */
import type { CompletionDigest, RiskHighlight } from '../../../../core/application/use-cases/attention/completion-digest.js';
import type {
  ApprovalStatsView,
  DigestViewData,
  RiskHighlightView,
  TestResultsView,
} from './digest-types.js';

/* ------------------------------------------------------------------ *
 * DigestViewModel
 * ------------------------------------------------------------------ */

/**
 * Transforms a {@link CompletionDigest} into display-ready view data.
 *
 * The view model is stateless, so a single instance can be reused. Use
 * {@link buildView} to produce a {@link DigestViewData} from a digest.
 */
export class DigestViewModel {
  /**
   * Build the digest view data from a {@link CompletionDigest}.
   *
   * Extracts task info, duration, summary, file changes, test results,
   * approval stats, risk highlights, decisions, and commit/branch info,
   * formatting each into display-ready fields. The returned structure is
   * JSON-serializable.
   *
   * @param digest - The source completion digest (read-only; not mutated).
   * @returns Display-ready digest view data.
   */
  buildView(digest: CompletionDigest): DigestViewData {
    const testResults = this.buildTestResults(digest);
    const approvalStats = this.buildApprovalStats(digest);
    const riskHighlights = this.buildRiskHighlights(digest.riskHighlights);

    return {
      taskId: digest.taskId,
      sessionId: digest.sessionId,
      agentId: digest.agentId,
      startedAt: digest.startedAt,
      completedAt: digest.completedAt,
      durationMs: digest.duration,
      durationLabel: formatDuration(digest.duration),
      summary: digest.summary,
      filesChangedCount: digest.filesChangedCount,
      filesChanged: [...digest.filesChanged],
      testResults,
      approvalStats,
      riskHighlights,
      decisions: digest.decisions.map((d) => ({ id: d.id, note: d.note })),
      commitHash: digest.commitHash,
      branchName: digest.branchName,
      hasRisks: riskHighlights.length > 0,
    };
  }

  /**
   * Build display-ready test results from a digest.
   *
   * Derives `allPassed`, `noneRun`, semantic color tokens, and a one-line
   * summary so templates don't need to recompute them.
   */
  buildTestResults(digest: CompletionDigest): TestResultsView {
    const run = digest.testsRun;
    const passed = digest.testsPassed;
    const failed = digest.testsFailed;
    const allPassed = run > 0 && failed === 0;
    const noneRun = run === 0;
    const passColor = allPassed ? 'green' : noneRun ? 'slate' : 'amber';
    const failColor = failed > 0 ? 'red' : 'slate';
    const summary = noneRun
      ? 'No tests run'
      : allPassed
        ? `${passed}/${run} passing`
        : `${passed}/${run} passing, ${failed} failed`;
    return { run, passed, failed, allPassed, noneRun, passColor, failColor, summary };
  }

  /**
   * Build display-ready approval stats from a digest.
   *
   * `pending` is derived: the number of requested approvals that were neither
   * granted nor denied (clamped to be non-negative).
   */
  buildApprovalStats(digest: CompletionDigest): ApprovalStatsView {
    const requested = digest.approvalsRequested;
    const granted = digest.approvalsGranted;
    const denied = digest.approvalsDenied;
    const pending = Math.max(0, requested - granted - denied);
    const parts: string[] = [`${granted} granted`];
    if (denied > 0) parts.push(`${denied} denied`);
    if (pending > 0) parts.push(`${pending} pending`);
    const summary = parts.join(', ');
    return { requested, granted, denied, pending, summary };
  }

  /**
   * Build display-ready risk highlights, mapping each to a semantic color.
   *
   * `failed-tests` and `denied-approval` map to `red` (blocking); other kinds
   * map to `orange` (warning).
   */
  buildRiskHighlights(highlights: readonly RiskHighlight[]): RiskHighlightView[] {
    return highlights.map((h) => ({
      kind: h.kind,
      message: h.message,
      color: riskColorFor(h.kind),
    }));
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/**
 * Format a duration in milliseconds as a human-readable label.
 *
 * Examples:
 * - 0        → "0s"
 * - 500      → "0s"
 * - 1500     → "1s"
 * - 154000   → "2m 34s"
 * - 3723000  → "1h 2m 3s"
 *
 * Hours and minutes components are omitted when zero (except the seconds
 * component, which is always present).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Map a risk highlight kind to a semantic color token.
 *
 * `failed-tests` and `denied-approval` are blocking → `red`. `critical-action`
 * and `blocked` are warnings → `orange`.
 */
function riskColorFor(kind: RiskHighlight['kind']): RiskHighlightView['color'] {
  switch (kind) {
    case 'failed-tests':
    case 'denied-approval':
      return 'red';
    case 'critical-action':
    case 'blocked':
      return 'orange';
    default:
      return 'orange';
  }
}
