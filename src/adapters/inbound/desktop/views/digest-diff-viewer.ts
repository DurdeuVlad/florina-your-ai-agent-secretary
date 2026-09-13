/**
 * View model for the side-by-side Completion Digest & diff viewer (issue #27).
 *
 * {@link DigestDiffViewerModel} combines a {@link CompletionDigest} (#16) and
 * a {@link DiffDigest} (#17) into a single {@link DigestDiffViewerData} that
 * the renderer projects onto a split-pane layout: digest on the left, diff on
 * the right.
 *
 * Responsibilities:
 * - **Observed vs inferred separation**: classifies each of the 8 digest
 *   fields/sections as `observed` (deterministic — from the event journal or
 *   git plumbing) or `inferred` (LLM/heuristic narrative or risk), so the
 *   renderer can apply distinct visual treatment (solid vs dashed border).
 * - **Risk hotspot drill-down**: maps each risk highlight to a diff file
 *   target so a click navigates to the relevant diff location.
 * - **Large-diff pagination**: slices the flat file list into pages so the
 *   renderer lazily mounts only the current page (performant for diffs with
 *   thousands of files).
 * - **Create PR action**: exposes a {@link buildCreatePrCommand} helper that
 *   produces the typed `create-pr` command to invoke the daemon.
 *
 * Per DEC-012, the digest is a *projection* over the immutable event journal
 * — it never replaces the source events. Per DEC-009, the digest surfaces the
 * executive summary before deep review; the diff pane is the drill-down
 * surface.
 *
 * The view model is pure and synchronous: no DOM, no framework, no side
 * effects. This keeps the viewer logic fully testable with vitest and
 * identical across rendering surfaces (desktop webview, TUI, CLI).
 */
import type { CompletionDigest } from '../../../../core/application/use-cases/attention/completion-digest.js';
import type { DiffDigest } from '../../../../core/application/use-cases/attention/diff-digest.js';
import type { RiskHighlight } from '../../../../core/application/use-cases/attention/completion-digest.js';
import type { ChangedFileStatus } from '../../../../core/application/use-cases/attention/diff-digest.js';
import type {
  DiffViewData,
  FileChangeView,
} from './digest-types.js';
import type { DigestViewModel } from './digest-view.js';
import type { DiffViewModel } from './diff-view.js';
import type {
  DigestDiffViewerData,
  DigestFieldView,
  DiffPageView,
  PaginationView,
  RiskHotspotView,
} from './digest-diff-types.js';
import { DEFAULT_DIFF_PAGE_SIZE } from './digest-diff-types.js';

/* ------------------------------------------------------------------ *
 * Field provenance classification
 * ------------------------------------------------------------------ */

/**
 * The 8 digest fields/sections rendered in the left pane, each classified as
 * observed (deterministic) or inferred (LLM/heuristic).
 *
 * Observed fields are derived from the immutable event journal (DEC-012) or
 * deterministic git plumbing (#17) — they are hard facts. Inferred fields
 * (`summary`, `riskHighlights`) are interpretive: the summary is a narrative
 * and risk highlights are an assessment, both of which a human should weigh
 * differently from raw counts (PRODUCT_DESIGN.md "Deliverable Review").
 */
const DIGEST_FIELDS: readonly DigestFieldView[] = [
  { id: 'header', label: 'Task', provenance: 'observed' },
  { id: 'summary', label: 'Summary', provenance: 'inferred' },
  { id: 'testResults', label: 'Tests', provenance: 'observed' },
  { id: 'approvalStats', label: 'Approvals', provenance: 'observed' },
  { id: 'riskHighlights', label: 'Risk hotspots', provenance: 'inferred' },
  { id: 'decisions', label: 'Decisions', provenance: 'observed' },
  { id: 'filesChanged', label: 'Files changed', provenance: 'observed' },
  { id: 'commitInfo', label: 'Commit', provenance: 'observed' },
] as const;

/** The number of digest fields rendered in the left pane. */
export const DIGEST_FIELD_COUNT = DIGEST_FIELDS.length;

/* ------------------------------------------------------------------ *
 * Status ordering for file-tree grouping (mirrors DiffViewModel)
 * ------------------------------------------------------------------ */

const STATUS_ORDER: readonly ChangedFileStatus[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
];

/* ------------------------------------------------------------------ *
 * DigestDiffViewerModel
 * ------------------------------------------------------------------ */

/**
 * Combines a {@link CompletionDigest} and a {@link DiffDigest} into
 * display-ready {@link DigestDiffViewerData} for the side-by-side viewer.
 *
 * The view model is stateless except for the injected {@link DigestViewModel}
 * and {@link DiffViewModel} (which are themselves stateless), so a single
 * instance can be reused across renders.
 */
export class DigestDiffViewerModel {
  private readonly digestViewModel: DigestViewModel;
  private readonly diffViewModel: DiffViewModel;

  /**
   * @param digestViewModel - Transforms a CompletionDigest into DigestViewData.
   * @param diffViewModel   - Transforms a DiffDigest into DiffViewData.
   */
  constructor(digestViewModel: DigestViewModel, diffViewModel: DiffViewModel) {
    this.digestViewModel = digestViewModel;
    this.diffViewModel = diffViewModel;
  }

  /**
   * Build the combined viewer data from a {@link CompletionDigest} and an
   * optional {@link DiffDigest}.
   *
   * When `diff` is omitted, the digest's embedded `diffSummary` is used as a
   * fallback (the daemon's `get-digest` command returns a digest whose
   * `diffSummary` carries the deterministic diff). When neither is available,
   * `hasDiff` is `false` and the right pane renders an empty state.
   *
   * @param digest - The source completion digest (read-only; not mutated).
   * @param diff   - Optional standalone diff digest (overrides digest.diffSummary).
   * @param page   - The 0-based diff page to expose (default 0).
   * @param pageSize - Files per page (default {@link DEFAULT_DIFF_PAGE_SIZE}).
   * @returns Display-ready combined viewer data.
   */
  buildView(
    digest: CompletionDigest,
    diff?: DiffDigest,
    page = 0,
    pageSize = DEFAULT_DIFF_PAGE_SIZE,
  ): DigestDiffViewerData {
    const digestView = this.digestViewModel.buildView(digest);
    const resolvedDiff = diff ?? digest.diffSummary ?? null;
    const diffView = resolvedDiff ? this.diffViewModel.buildView(resolvedDiff) : null;

    const pagination = this.computePagination(
      diffView ? diffView.files.length : 0,
      page,
      pageSize,
    );
    const riskHotspots = this.buildRiskHotspots(digest, diffView);

    return {
      taskId: digest.taskId,
      digest: digestView,
      diff: diffView,
      fields: DIGEST_FIELDS,
      riskHotspots,
      pagination,
      hasDiff: diffView !== null,
    };
  }

  /**
   * Build a single page of diff files for lazy rendering.
   *
   * Returns the file groups (by status) and flat file list restricted to the
   * requested page, plus updated pagination metadata. The renderer mounts
   * only these rows, keeping the DOM small for large diffs.
   *
   * @param data - The combined viewer data (from {@link buildView}).
   * @param page - The 0-based page index to render.
   * @returns A {@link DiffPageView} for the requested page, or `null` when
   *   there is no diff.
   */
  buildDiffPage(data: DigestDiffViewerData, page: number): DiffPageView | null {
    if (data.diff === null) return null;
    const pageSize = data.pagination.pageSize;
    const pagination = this.computePagination(
      data.diff.files.length,
      page,
      pageSize,
    );
    const start = pagination.page * pageSize;
    const end = start + pageSize;
    const pageFiles = data.diff.files.slice(start, end);
    const fileGroups = this.groupByStatus(pageFiles);
    return { pagination, fileGroups, files: pageFiles };
  }

  /**
   * Build the risk hotspots with drill-down targets into the diff.
   *
   * Each risk highlight is mapped to a diff file target when one can be
   * determined from the risk kind and the available changed files:
   * - `failed-tests` → the first test file in the diff (a `.test.`/`.spec.`
   *   path), since failed tests point at test source.
   * - `critical-action` / `denied-approval` / `blocked` → no specific file
   *   (`null`); the drill-down focuses the diff pane's top instead.
   *
   * The `command` string encodes the kind and target so the renderer can
   * dispatch it without closures (IPC-serializable).
   *
   * @param digest   - The source completion digest.
   * @param diffView - The display-ready diff view data (may be `null`).
   * @returns Risk hotspots with drill-down targets.
   */
  buildRiskHotspots(
    digest: CompletionDigest,
    diffView: DiffViewData | null,
  ): RiskHotspotView[] {
    return digest.riskHighlights.map((h) => {
      const target = this.resolveDrillTarget(h, diffView);
      return {
        kind: h.kind,
        message: h.message,
        color: riskColorFor(h.kind),
        drillTarget: target,
        command:
          target !== null
            ? `drill-risk:${h.kind}:${target}`
            : `drill-risk:${h.kind}`,
      };
    });
  }

  /**
   * Build the typed `create-pr` command for the daemon's command API.
   *
   * The viewer's "Create PR" action dispatches this command through the
   * daemon's typed {@link CommandApi.execute}, invoking the daemon to create
   * a pull request for the task's branch. The command is returned as a plain
   * object so it can cross the IPC boundary.
   *
   * @param taskId - The task to create a PR for.
   * @param title  - Optional PR title (defaults to the commit message).
   * @param body   - Optional PR body.
   * @returns A `create-pr` command object.
   */
  buildCreatePrCommand(
    taskId: string,
    title?: string,
    body?: string,
  ): { readonly kind: 'create-pr'; readonly taskId: string; readonly title?: string; readonly body?: string } {
    const cmd: { kind: 'create-pr'; taskId: string; title?: string; body?: string } = {
      kind: 'create-pr',
      taskId,
    };
    if (title !== undefined) cmd.title = title;
    if (body !== undefined) cmd.body = body;
    return cmd;
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  /**
   * Compute pagination metadata for a file count.
   *
   * `page` is clamped to the valid range `[0, totalPages - 1]` (or `0` when
   * there are no files). `totalPages` is at least 1 so the renderer always
   * has a valid page to render (even an empty one).
   */
  private computePagination(
    totalFiles: number,
    page: number,
    pageSize: number,
  ): PaginationView {
    const safePageSize = pageSize > 0 ? pageSize : DEFAULT_DIFF_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(totalFiles / safePageSize));
    const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
    return {
      page: clampedPage,
      pageSize: safePageSize,
      totalFiles,
      totalPages,
      hasNext: clampedPage < totalPages - 1,
      hasPrev: clampedPage > 0,
    };
  }

  /**
   * Resolve the drill-down file target for a risk highlight.
   *
   * `failed-tests` maps to the first test file in the diff (a path matching
   * `.test.` or `.spec.`). Other kinds have no specific file target.
   */
  private resolveDrillTarget(
    highlight: RiskHighlight,
    diffView: DiffViewData | null,
  ): string | null {
    if (diffView === null) return null;
    if (highlight.kind === 'failed-tests') {
      const testFile = diffView.files.find((f) => /\.(test|spec)\./.test(f.path));
      return testFile ? testFile.path : null;
    }
    return null;
  }

  /**
   * Group a list of display-ready files by their change status.
   *
   * Groups follow {@link STATUS_ORDER} (added → modified → deleted → renamed).
   * Empty groups are omitted. Mirrors {@link DiffViewModel.groupByStatus} but
   * operates on an arbitrary page slice.
   */
  private groupByStatus(files: readonly FileChangeView[]): DiffPageView['fileGroups'] {
    const byStatus = new Map<ChangedFileStatus, FileChangeView[]>();
    for (const status of STATUS_ORDER) {
      byStatus.set(status, []);
    }
    for (const file of files) {
      byStatus.get(file.status)?.push(file);
    }
    const groups: Array<{ status: ChangedFileStatus; files: readonly FileChangeView[]; count: number }> = [];
    for (const status of STATUS_ORDER) {
      const bucket = byStatus.get(status);
      if (bucket === undefined || bucket.length === 0) continue;
      groups.push({ status, files: bucket, count: bucket.length });
    }
    return groups;
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/**
 * Map a risk highlight kind to a semantic color token.
 *
 * `failed-tests` and `denied-approval` are blocking → `red`. `critical-action`
 * and `blocked` are warnings → `orange`.
 */
function riskColorFor(kind: RiskHighlight['kind']): string {
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
