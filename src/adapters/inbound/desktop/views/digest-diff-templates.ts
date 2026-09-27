/**
 * Template functions for the side-by-side digest & diff viewer (issue #27).
 *
 * Each template returns a {@link RenderTree} — a plain, serializable object
 * describing a renderable element (`{ tag, props, children }`). No DOM, no
 * React, no framework. Any renderer (desktop webview, TUI, test harness) can
 * walk the tree and project it onto its own surface.
 *
 * The combined viewer renders a split-pane layout:
 * - **Left pane**: the Completion Digest (8 fields), with observed fields
 *   visually distinguished from LLM-inferred fields (solid vs dashed border,
 *   distinct background).
 * - **Right pane**: the diff viewer (file tree grouped by status + summary
 *   stats), paginated for large diffs.
 *
 * Style hints are embedded in `props` as semantic tokens. Event handlers are
 * expressed as **string command identifiers** (never closures) so the whole
 * tree is JSON-serializable and can cross the IPC boundary.
 *
 * Per DEC-009, the digest surfaces the executive summary before deep review.
 * Per DEC-012, the digest is a projection — observed (deterministic) fields
 * are rendered with a solid border, inferred (LLM/heuristic) fields with a
 * dashed border and a distinct background, so the human can weigh them
 * appropriately (PRODUCT_DESIGN.md "Deliverable Review").
 */
import type { RenderTree } from './view-types.js';
import type {
  DigestDiffViewerData,
  DigestFieldView,
  DiffPageView,
  PaginationView,
  RiskHotspotView,
} from './digest-diff-types.js';
import type { DigestViewData, FileChangeView } from './digest-types.js';
import {
  renderDigestSummary,
  renderTestResults,
  renderApprovalStats,
  renderDiffStats,
} from './digest-templates.js';

/* ------------------------------------------------------------------ *
 * Primitive element helpers
 * ------------------------------------------------------------------ */

/** Create a {@link RenderTree} node. */
function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** A text node (represented as a plain string child). */
function text(value: string): string {
  return value;
}

/* ------------------------------------------------------------------ *
 * Split-pane container
 * ------------------------------------------------------------------ */

/**
 * Render the full side-by-side viewer as a {@link RenderTree}.
 *
 * Produces a `DigestDiffViewer` root with two panes: a `DigestPane` (left)
 * and a `DiffPane` (right). The left pane renders the 8 digest fields with
 * observed/inferred visual distinction and clickable risk hotspots. The
 * right pane renders the diff file tree (paginated) and summary stats. A
 * `Create PR` action button is included in the viewer toolbar.
 *
 * @param data - The combined viewer data.
 * @param page - Optional pre-computed diff page to render (from
 *   `DigestDiffViewerModel.buildDiffPage`). When omitted, the renderer is
 *   expected to lazily compute pages from `data.diff` using the pagination
 *   metadata; this template still emits the pagination controls.
 * @returns A serializable RenderTree describing the side-by-side viewer.
 */
export function renderDigestDiffViewer(
  data: DigestDiffViewerData,
  page?: DiffPageView | null,
): RenderTree {
  const children: (RenderTree | string)[] = [
    renderViewerToolbar(data),
    el('SplitPane', { layout: 'row', gap: 'md', split: '50/50', resizable: true }, [
      renderDigestPane(data),
      renderDiffPane(data, page ?? null),
    ]),
  ];
  return el('DigestDiffViewer', { taskId: data.taskId, spacing: 'md' }, children);
}

/* ------------------------------------------------------------------ *
 * Viewer toolbar (Create PR action)
 * ------------------------------------------------------------------ */

/**
 * Render the viewer toolbar with the "Create PR" action button.
 *
 * The button carries a `create-pr:<taskId>` command identifier so the
 * renderer dispatches it to the daemon's typed command API (issue #27:
 * "Create PR action invokes the daemon").
 */
function renderViewerToolbar(data: DigestDiffViewerData): RenderTree {
  const buttons: RenderTree[] = [
    el(
      'Button',
      {
        command: `create-pr:${data.taskId}`,
        variant: 'primary',
        size: 'md',
        icon: 'git-pull-request',
        confirm: 'Create a pull request for this work? The PR is created on the remote.',
      },
      [text('Create PR')],
    ),
  ];
  if (data.hasDiff) {
    buttons.unshift(
      el(
        'Button',
        {
          command: `open-diff:${data.taskId}`,
          variant: 'ghost',
          size: 'md',
          icon: 'diff',
        },
        [text('Open raw diff')],
      ),
    );
  }
  return el('ViewerToolbar', { layout: 'row', gap: 'sm', align: 'end' }, buttons);
}

/* ------------------------------------------------------------------ *
 * Left pane — digest with observed/inferred separation
 * ------------------------------------------------------------------ */

/**
 * Render the left pane: the Completion Digest with observed/inferred
 * separation.
 *
 * Each of the 8 digest fields is wrapped in a `DigestField` element whose
 * `provenance` prop (`observed` or `inferred`) drives the visual treatment:
 * - `observed` → `borderStyle: 'solid'`, neutral background.
 * - `inferred` → `borderStyle: 'dashed'`, `background: 'inferred'`, plus an
 *   `InferredTag` badge so the human can tell at a glance it is interpretive.
 */
function renderDigestPane(data: DigestDiffViewerData): RenderTree {
  const view = data.digest;
  const fields: RenderTree[] = [
    renderDigestField('header', 'Task', 'observed', renderDigestHeader(view)),
    renderDigestField('summary', 'Summary', 'inferred', renderDigestSummary(view)),
    renderDigestField('testResults', 'Tests', 'observed', renderTestResults(view.testResults)),
    renderDigestField(
      'approvalStats',
      'Approvals',
      'observed',
      renderApprovalStats(view.approvalStats),
    ),
    renderDigestField(
      'riskHighlights',
      'Risk hotspots',
      'inferred',
      renderRiskHotspots(data.riskHotspots),
    ),
    renderDigestField('decisions', 'Decisions', 'observed', renderDecisions(view.decisions)),
    renderDigestField(
      'filesChanged',
      'Files changed',
      'observed',
      renderChangedFilesList(view.filesChanged),
    ),
    renderDigestField('commitInfo', 'Commit', 'observed', renderCommitInfo(view)),
  ];
  return el('DigestPane', { side: 'left', scrollable: true, spacing: 'md' }, fields);
}

/**
 * Render a single digest field with its provenance-driven visual treatment.
 *
 * `observed` fields get a solid border; `inferred` fields get a dashed
 * border, a distinct background token, and an `InferredTag` badge label.
 */
function renderDigestField(
  id: string,
  label: string,
  provenance: DigestFieldView['provenance'],
  content: RenderTree,
): RenderTree {
  const props: Record<string, unknown> = {
    fieldId: id,
    label,
    provenance,
    borderStyle: provenance === 'observed' ? 'solid' : 'dashed',
    layout: 'column',
    gap: 'xs',
  };
  if (provenance === 'inferred') {
    props.background = 'inferred';
  }
  const children: (RenderTree | string)[] = [
    el('FieldLabel', { weight: 'semibold', color: 'muted' }, [text(label)]),
  ];
  if (provenance === 'inferred') {
    children.push(el('InferredTag', { color: 'amber', icon: 'sparkles' }, [text('inferred')]));
  }
  children.push(content);
  return el('DigestField', props, children);
}

/**
 * Render the digest header: task id, agent, duration, branch, commit.
 */
function renderDigestHeader(view: DigestViewData): RenderTree {
  const rows: RenderTree[] = [
    detailRow('Task', view.taskId),
    detailRow('Agent', view.agentId),
    detailRow('Duration', view.durationLabel),
  ];
  if (view.branchName) rows.push(detailRow('Branch', view.branchName));
  if (view.commitHash) rows.push(detailRow('Commit', view.commitHash));
  return el('DigestHeader', { layout: 'column', gap: 'xs' }, rows);
}

/**
 * Render risk hotspots as a clickable, color-coded list.
 *
 * Each hotspot carries a `command` string identifier encoding its kind and
 * drill-down target so the renderer can navigate to the relevant diff
 * location on click. Hotspots with a `drillTarget` are marked `clickable`.
 */
function renderRiskHotspots(hotspots: readonly RiskHotspotView[]): RenderTree {
  if (hotspots.length === 0) {
    return el('RiskHotspots', { layout: 'column', gap: 'xs', empty: true }, [
      el('EmptyHint', { color: 'slate' }, [text('No risk hotspots.')]),
    ]);
  }
  return el(
    'RiskHotspots',
    { layout: 'column', gap: 'xs' },
    hotspots.map((h) =>
      el(
        'RiskHotspot',
        {
          kind: h.kind,
          color: h.color,
          icon: riskIconFor(h.kind),
          command: h.command,
          drillTarget: h.drillTarget,
          clickable: h.drillTarget !== null,
        },
        [text(h.message)],
      ),
    ),
  );
}

/**
 * Render Decision Ledger references as a labeled list.
 */
function renderDecisions(decisions: readonly { id: string; note: string }[]): RenderTree {
  if (decisions.length === 0) {
    return el('Decisions', { layout: 'column', gap: 'xs', empty: true }, [
      el('EmptyHint', { color: 'slate' }, [text('No decision references.')]),
    ]);
  }
  return el(
    'Decisions',
    { layout: 'column', gap: 'xs', variant: 'deterministic' },
    decisions.map((d) =>
      el('DecisionRef', { id: d.id, icon: 'bookmark' }, [
        el('DecisionId', { weight: 'semibold' }, [text(d.id)]),
        el('DecisionNote', { color: 'muted' }, [text(d.note)]),
      ]),
    ),
  );
}

/**
 * Render the changed-files list (paths only, from the digest).
 */
function renderChangedFilesList(paths: readonly string[]): RenderTree {
  if (paths.length === 0) {
    return el('ChangedFiles', { layout: 'column', gap: 'xs', empty: true }, [
      el('EmptyHint', { color: 'slate' }, [text('No files changed.')]),
    ]);
  }
  return el(
    'ChangedFiles',
    { layout: 'column', gap: 'xs', count: paths.length },
    paths.map((p) =>
      el('FilePath', { selectable: true, icon: 'file', command: `drill-file:${p}` }, [text(p)]),
    ),
  );
}

/**
 * Render the commit/branch info section.
 */
function renderCommitInfo(view: DigestViewData): RenderTree {
  const rows: RenderTree[] = [];
  if (view.branchName) rows.push(detailRow('Branch', view.branchName));
  if (view.commitHash) rows.push(detailRow('Commit', view.commitHash));
  if (rows.length === 0) {
    return el('CommitInfo', { layout: 'column', gap: 'xs', empty: true }, [
      el('EmptyHint', { color: 'slate' }, [text('No commit info.')]),
    ]);
  }
  return el('CommitInfo', { layout: 'column', gap: 'xs' }, rows);
}

/* ------------------------------------------------------------------ *
 * Right pane — diff viewer (file tree + stats, paginated)
 * ------------------------------------------------------------------ */

/**
 * Render the right pane: the diff viewer.
 *
 * When `data.hasDiff` is `false`, an empty state is rendered. Otherwise the
 * pane shows the diff header, summary stats, the file tree for the current
 * page (grouped by status), and pagination controls. Only the current
 * page's file rows are included so the DOM stays small for large diffs.
 */
function renderDiffPane(data: DigestDiffViewerData, page: DiffPageView | null): RenderTree {
  if (!data.hasDiff || data.diff === null) {
    return el('DiffPane', { side: 'right', scrollable: true, empty: true }, [
      el('EmptyDiff', { color: 'slate', icon: 'diff' }, [text('No diff available for this task.')]),
    ]);
  }
  const diff = data.diff;
  const children: (RenderTree | string)[] = [renderDiffHeader(diff), renderDiffStats(diff.stats)];
  if (page !== null) {
    for (const group of page.fileGroups) {
      children.push(renderFileGroup(group.status, group.files));
    }
  } else {
    // No pre-computed page: render the first page slice from the flat list
    // using the pagination metadata so the template is usable standalone.
    const start = data.pagination.page * data.pagination.pageSize;
    const end = start + data.pagination.pageSize;
    const slice = diff.files.slice(start, end);
    const groups = groupFilesByStatus(slice);
    for (const group of groups) {
      children.push(renderFileGroup(group.status, group.files));
    }
  }
  if (diff.hasLargeChanges) {
    children.push(renderLargeChangesCallout(diff.largeChanges));
  }
  children.push(renderPaginationControls(data.pagination));
  return el(
    'DiffPane',
    {
      side: 'right',
      scrollable: true,
      branch: diff.branch,
      headCommit: diff.headCommit,
      spacing: 'md',
    },
    children,
  );
}

/**
 * Render the diff header: branch, base..head, author, commit message.
 */
function renderDiffHeader(diff: DigestDiffViewerData['diff']): RenderTree {
  if (diff === null) return el('DiffHeader', {}, []);
  return el('DiffHeader', { layout: 'column', gap: 'xs' }, [
    detailRow('Branch', diff.branch),
    detailRow('Range', `${diff.baseCommit}..${diff.headCommit}`),
    detailRow('Author', diff.author),
    detailRow('Commit', diff.commitMessage),
  ]);
}

/**
 * Render a file group (a status section) with its file rows.
 */
function renderFileGroup(status: string, files: readonly FileChangeView[]): RenderTree {
  return el('FileGroup', { status, layout: 'column', gap: 'xs', count: files.length }, [
    el('FileGroupLabel', { weight: 'semibold', color: statusColorFor(status) }, [
      text(`${status} (${files.length})`),
    ]),
    el(
      'FileList',
      { layout: 'column', gap: 'xs', count: files.length },
      files.map((f) => renderFileRow(f)),
    ),
  ]);
}

/**
 * Render a single file row with status badge, path, and line counts.
 */
function renderFileRow(file: FileChangeView): RenderTree {
  const children: (RenderTree | string)[] = [
    el('StatusBadge', { status: file.status, color: statusColorFor(file.status) }, [
      text(file.status),
    ]),
    el('FilePath', { selectable: true, icon: 'file', command: `drill-file:${file.path}` }, [
      text(file.path),
    ]),
  ];
  if (file.renamedFrom) {
    children.push(el('RenamedFrom', { color: 'muted' }, [text(`(from ${file.renamedFrom})`)]));
  }
  if (file.isBinary) {
    children.push(el('BinaryTag', { color: 'slate' }, [text('binary')]));
  } else {
    children.push(
      el('Additions', { color: 'green' }, [text(`+${file.additions}`)]),
      el('Deletions', { color: 'red' }, [text(`-${file.deletions}`)]),
    );
  }
  if (file.isLargeChange) {
    children.push(
      el('LargeChangeFlag', { color: 'orange', icon: 'alert' }, [text('large change')]),
    );
  }
  return el(
    'FileRow',
    {
      path: file.path,
      status: file.status,
      isLargeChange: file.isLargeChange,
      isBinary: file.isBinary,
      command: `drill-file:${file.path}`,
      layout: 'row',
      gap: 'sm',
    },
    children,
  );
}

/**
 * Render a callout highlighting large changes (>100 lines).
 */
function renderLargeChangesCallout(largeChanges: readonly FileChangeView[]): RenderTree {
  return el('LargeChangesCallout', { color: 'orange', icon: 'alert', count: largeChanges.length }, [
    el('CalloutTitle', { weight: 'semibold' }, [
      text(`${largeChanges.length} large change(s) (>100 lines)`),
    ]),
    el(
      'CalloutFiles',
      { layout: 'column', gap: 'xs' },
      largeChanges.map((f) =>
        el('CalloutFile', { path: f.path, command: `drill-file:${f.path}` }, [
          text(`${f.path} (+${f.additions}/-${f.deletions})`),
        ]),
      ),
    ),
  ]);
}

/**
 * Render pagination controls for the diff pane.
 *
 * Prev/next buttons carry `prev-page` / `next-page` command identifiers and
 * are disabled (`enabled: false`) when at the first/last page. The current
 * page indicator is emitted as a labeled stat.
 */
function renderPaginationControls(p: PaginationView): RenderTree {
  return el('PaginationControls', { layout: 'row', gap: 'sm', align: 'center' }, [
    el(
      'Button',
      {
        command: 'prev-page',
        variant: 'ghost',
        size: 'sm',
        icon: 'chevron-left',
        enabled: p.hasPrev,
      },
      [text('Prev')],
    ),
    el('PageIndicator', { color: 'slate' }, [
      text(`Page ${p.page + 1} of ${p.totalPages} (${p.totalFiles} files)`),
    ]),
    el(
      'Button',
      {
        command: 'next-page',
        variant: 'ghost',
        size: 'sm',
        icon: 'chevron-right',
        enabled: p.hasNext,
      },
      [text('Next')],
    ),
  ]);
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Render a single labeled detail row. */
function detailRow(label: string, value: string): RenderTree {
  return el('DetailRow', { layout: 'row', gap: 'sm' }, [
    el('DetailLabel', { color: 'muted', weight: 'medium' }, [text(label)]),
    el('DetailValue', { selectable: true }, [text(value)]),
  ]);
}

/** Icon identifier for a risk highlight kind. */
function riskIconFor(kind: RiskHotspotView['kind']): string {
  switch (kind) {
    case 'failed-tests':
      return 'alert';
    case 'denied-approval':
      return 'shield';
    case 'critical-action':
      return 'flame';
    case 'blocked':
      return 'pause';
    default:
      return 'info';
  }
}

/** Semantic color token for a file change status. */
function statusColorFor(status: string): string {
  switch (status) {
    case 'added':
      return 'green';
    case 'modified':
      return 'amber';
    case 'deleted':
      return 'red';
    case 'renamed':
      return 'blue';
    default:
      return 'slate';
  }
}

/**
 * Group a list of display-ready files by their change status.
 *
 * Groups follow added → modified → deleted → renamed; empty groups omitted.
 * Used when no pre-computed page is supplied.
 */
function groupFilesByStatus(
  files: readonly FileChangeView[],
): { status: string; files: readonly FileChangeView[]; count: number }[] {
  const order = ['added', 'modified', 'deleted', 'renamed'];
  const groups: { status: string; files: readonly FileChangeView[]; count: number }[] = [];
  for (const status of order) {
    const bucket = files.filter((f) => f.status === status);
    if (bucket.length > 0) {
      groups.push({ status, files: bucket, count: bucket.length });
    }
  }
  return groups;
}
