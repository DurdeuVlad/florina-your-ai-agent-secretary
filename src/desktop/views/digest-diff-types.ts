/**
 * Side-by-side Completion Digest & diff viewer types (issue #27).
 *
 * These are pure, JSON-serializable data structures describing the combined
 * viewer that renders the {@link CompletionDigest} (#16) on the left and the
 * {@link DiffDigest} (#17) on the right, with clear observed/inferred
 * separation in the digest and drill-down from risk hotspots into the diff.
 *
 * Per DEC-012, the digest is a *projection* over the immutable event journal
 * — it never replaces the source events. Per DEC-009, the digest surfaces the
 * executive summary before deep review; the diff pane is the drill-down
 * surface. Per PRODUCT_DESIGN.md "Deliverable Review", deterministic
 * (observed) fields are visually distinguished from LLM-inferred fields so
 * the human can weigh them appropriately.
 *
 * All fields are readonly primitives or plain records so the whole view is
 * JSON-serializable and can cross the IPC boundary (DEC-028).
 */
import type { RiskHighlight } from '../../attention/completion-digest.js';
import type { ChangedFileStatus } from '../../attention/diff-digest.js';
import type {
  DiffViewData,
  DigestViewData,
  FileChangeView,
} from './digest-types.js';

/* ------------------------------------------------------------------ *
 * Field provenance
 * ------------------------------------------------------------------ */

/**
 * Whether a digest field/section is **observed** (deterministic — derived
 * from the immutable event journal or git plumbing, never from an LLM) or
 * **inferred** (LLM-generated or heuristic-derived narrative/risk).
 *
 * Per PRODUCT_DESIGN.md "Deliverable Review", the human must be able to tell
 * at a glance which parts of the digest are hard facts versus interpretive.
 * The viewer renders observed fields with a solid border and inferred fields
 * with a dashed border + distinct background.
 */
export type FieldProvenance = 'observed' | 'inferred';

/**
 * A single digest field/section with its provenance classification.
 *
 * The viewer uses `provenance` to apply the visual distinction (solid vs
 * dashed border) and `id` to correlate the rendered section with its data.
 */
export interface DigestFieldView {
  /** Stable identifier for the field/section (e.g. `summary`, `testResults`). */
  readonly id: string;
  /** Human-readable label for the field/section. */
  readonly label: string;
  /** Whether this field is observed (deterministic) or inferred (LLM/heuristic). */
  readonly provenance: FieldProvenance;
}

/* ------------------------------------------------------------------ *
 * Risk hotspots (drill-down)
 * ------------------------------------------------------------------ */

/**
 * A risk hotspot in the digest that the human can click to drill down into
 * the relevant diff location.
 *
 * `drillTarget` is the repository-relative file path the hotspot navigates
 * to (when one can be determined), or `null` when no specific file applies.
 * `command` is the string command identifier the renderer dispatches to
 * perform the navigation (kept serializable for IPC).
 */
export interface RiskHotspotView {
  /** Category of risk (mirrors {@link RiskHighlight.kind}). */
  readonly kind: RiskHighlight['kind'];
  /** Human-readable description of the risk. */
  readonly message: string;
  /** Semantic color token (`red` for blocking, `orange` for warnings). */
  readonly color: string;
  /**
   * Repository-relative file path the hotspot drills into, or `null` when
   * no specific diff location applies to this risk kind.
   */
  readonly drillTarget: string | null;
  /** String command identifier for the drill-down navigation. */
  readonly command: string;
}

/* ------------------------------------------------------------------ *
 * Pagination (large diffs)
 * ------------------------------------------------------------------ */

/**
 * The default number of files rendered per page in the diff pane. Large
 * diffs are paginated so the viewer stays performant (issue #27 acceptance:
 * "Large diffs render performantly"). The renderer lazily mounts only the
 * current page's file rows.
 */
export const DEFAULT_DIFF_PAGE_SIZE = 50;

/**
 * Pagination metadata for the diff pane.
 *
 * The viewer model exposes the current page and total page count so the
 * renderer can render prev/next controls and lazily mount only the current
 * page's file rows. The full file list is retained in `DiffViewData.files`
 * for drill-down lookups, but only one page is rendered at a time.
 */
export interface PaginationView {
  /** Current page index (0-based). */
  readonly page: number;
  /** Number of files rendered per page. */
  readonly pageSize: number;
  /** Total number of files across all pages. */
  readonly totalFiles: number;
  /** Total number of pages. */
  readonly totalPages: number;
  /** Whether a next page exists. */
  readonly hasNext: boolean;
  /** Whether a previous page exists. */
  readonly hasPrev: boolean;
}

/**
 * A single page of diff files for lazy rendering.
 *
 * Carries the file rows for the current page plus the file-tree group
 * structure (by status) restricted to that page. The renderer mounts only
 * these rows, keeping the DOM small even for diffs with thousands of files.
 */
export interface DiffPageView {
  /** The pagination metadata for this page. */
  readonly pagination: PaginationView;
  /** File groups (by status) for the current page only. */
  readonly fileGroups: readonly {
    readonly status: ChangedFileStatus;
    readonly files: readonly FileChangeView[];
    readonly count: number;
  }[];
  /** Flat list of files on the current page. */
  readonly files: readonly FileChangeView[];
}

/* ------------------------------------------------------------------ *
 * DigestDiffViewerData
 * ------------------------------------------------------------------ */

/**
 * Display-ready data for the side-by-side digest & diff viewer (issue #27).
 *
 * Combines a {@link DigestViewData} (left pane) with a {@link DiffViewData}
 * (right pane), plus the provenance classification of each digest field, the
 * risk hotspots with their drill-down targets, and pagination metadata for
 * the diff pane. All fields are readonly and JSON-serializable.
 */
export interface DigestDiffViewerData {
  /** Identifier of the Task this viewer summarizes. */
  readonly taskId: string;
  /** Display-ready digest view data (left pane). */
  readonly digest: DigestViewData;
  /** Display-ready diff view data (right pane), or `null` when no diff. */
  readonly diff: DiffViewData | null;
  /** Provenance classification for each of the 8 digest fields/sections. */
  readonly fields: readonly DigestFieldView[];
  /** Risk hotspots with drill-down targets into the diff. */
  readonly riskHotspots: readonly RiskHotspotView[];
  /** Pagination metadata for the diff pane. */
  readonly pagination: PaginationView;
  /** Whether a diff is available to render in the right pane. */
  readonly hasDiff: boolean;
}
