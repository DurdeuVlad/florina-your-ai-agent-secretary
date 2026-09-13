/**
 * View model for the diff viewer (DEC-009, DEC-012, issue #27).
 *
 * {@link DiffViewModel} transforms a {@link DiffDigest} (#17) into
 * display-ready {@link DiffViewData}. It groups changed files by status
 * (added / modified / deleted / renamed), computes summary stats (total files,
 * additions, deletions, net change), derives per-file display metadata
 * (`isBinary`, `isLargeChange`), and highlights large changes (>100 lines).
 *
 * Per DEC-012, the diff digest is a *projection* over deterministic git
 * plumbing — it never replaces the source events. Per DEC-009, the diff viewer
 * is the drill-down surface complementing the executive digest.
 *
 * The view model is pure and synchronous: no DOM, no framework, no side
 * effects. This keeps the diff view logic fully testable with vitest and
 * identical across rendering surfaces (desktop webview, TUI, CLI).
 */
import type {
  ChangedFile,
  ChangedFileStatus,
  DiffDigest,
} from '../../../../core/application/use-cases/attention/diff-digest.js';
import type {
  DiffStatsView,
  DiffViewData,
  FileChangeView,
  FileGroupView,
} from './digest-types.js';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/**
 * The threshold (in total lines changed) above which a file change is flagged
 * as a "large change" requiring extra attention (PRODUCT_DESIGN.md "Risk").
 */
export const LARGE_CHANGE_THRESHOLD = 100;

/**
 * The ordered list of file statuses used for grouping. Matches the order
 * `git diff --name-status` reports them, with `added` first.
 */
const STATUS_ORDER: readonly ChangedFileStatus[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
];

/* ------------------------------------------------------------------ *
 * DiffViewModel
 * ------------------------------------------------------------------ */

/**
 * Transforms a {@link DiffDigest} into display-ready view data.
 *
 * The view model is stateless, so a single instance can be reused. Use
 * {@link buildView} to produce a {@link DiffViewData} from a diff digest.
 */
export class DiffViewModel {
  /**
   * Build the diff view data from a {@link DiffDigest}.
   *
   * Groups changed files by status (added / modified / deleted / renamed,
   * empty groups omitted), computes summary stats (total files, additions,
   * deletions, net change), derives per-file display metadata, and collects
   * large changes (>100 lines). The returned structure is JSON-serializable.
   *
   * @param diff - The source diff digest (read-only; not mutated).
   * @returns Display-ready diff view data.
   */
  buildView(diff: DiffDigest): DiffViewData {
    const files = diff.changedFiles.map((f) => this.toFileChangeView(f));
    const fileGroups = this.groupByStatus(files);
    const stats = this.computeStats(files);
    const largeChanges = files.filter((f) => f.isLargeChange);

    return {
      branch: diff.branch,
      baseCommit: diff.baseCommit,
      headCommit: diff.headCommit,
      author: diff.author,
      commitMessage: diff.commitMessage,
      fileGroups,
      files,
      stats,
      diffStat: diff.diffStat,
      hasLargeChanges: largeChanges.length > 0,
      largeChanges,
    };
  }

  /**
   * Convert a deterministic {@link ChangedFile} into a display-ready
   * {@link FileChangeView}.
   *
   * Derives `totalChanged`, `isBinary` (heuristic: a non-deleted file with
   * zero line changes is likely binary), and `isLargeChange` (>100 lines).
   */
  toFileChangeView(file: ChangedFile): FileChangeView {
    const totalChanged = file.additions + file.deletions;
    // Heuristic: `git diff --numstat` reports `0	0` for binary files. A
    // non-deleted, non-renamed file with zero line changes is likely binary.
    // Renamed files with 0/0 are usually pure renames, not binary content.
    const isBinary =
      file.status !== 'deleted' &&
      file.status !== 'renamed' &&
      file.additions === 0 &&
      file.deletions === 0;
    return {
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      totalChanged,
      renamedFrom: file.renamedFrom,
      isBinary,
      isLargeChange: totalChanged > LARGE_CHANGE_THRESHOLD,
    };
  }

  /**
   * Group display-ready files by their change status.
   *
   * Groups follow {@link STATUS_ORDER} (added → modified → deleted → renamed).
   * Empty groups are omitted.
   */
  groupByStatus(files: readonly FileChangeView[]): FileGroupView[] {
    const byStatus = new Map<ChangedFileStatus, FileChangeView[]>();
    for (const status of STATUS_ORDER) {
      byStatus.set(status, []);
    }
    for (const file of files) {
      byStatus.get(file.status)?.push(file);
    }
    const groups: FileGroupView[] = [];
    for (const status of STATUS_ORDER) {
      const bucket = byStatus.get(status);
      if (bucket === undefined || bucket.length === 0) continue;
      groups.push({ status, files: bucket, count: bucket.length });
    }
    return groups;
  }

  /**
   * Compute summary stats from a list of display-ready files.
   *
   * @param files - The flat list of display-ready file changes.
   * @returns Aggregated stats (total files, additions, deletions, net change,
   *   large-change count).
   */
  computeStats(files: readonly FileChangeView[]): DiffStatsView {
    let totalAdditions = 0;
    let totalDeletions = 0;
    let largeChangeCount = 0;
    for (const file of files) {
      totalAdditions += file.additions;
      totalDeletions += file.deletions;
      if (file.isLargeChange) largeChangeCount++;
    }
    return {
      totalFiles: files.length,
      totalAdditions,
      totalDeletions,
      netChange: totalAdditions - totalDeletions,
      largeChangeCount,
    };
  }
}
