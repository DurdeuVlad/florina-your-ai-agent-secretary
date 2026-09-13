/**
 * Template functions for the digest & diff viewer (DEC-009, DEC-012, issue #27).
 *
 * Each template returns a {@link RenderTree} — a plain, serializable object
 * describing a renderable element (`{ tag, props, children }`). No DOM, no
 * React, no framework. Any renderer (desktop webview, TUI, test harness) can
 * walk the tree and project it onto its own surface.
 *
 * Style hints (pass/fail colors, additions/deletions colors, risk colors,
 * icons, spacing) are embedded in `props` as semantic tokens, so each surface
 * maps them to its own palette/layout. Event handlers are expressed as
 * **string command identifiers** (never closures) so the whole tree is
 * JSON-serializable and can cross the IPC boundary.
 *
 * Per DEC-009, the digest surfaces the executive summary before deep review.
 * Per DEC-012, the digest is a projection — the structured deterministic
 * fields are rendered prominently, with observed vs inferred clearly labeled.
 */
import type { ChangedFileStatus } from '../../../../core/application/use-cases/attention/diff-digest.js';
import type { RenderTree } from './view-types.js';
import type {
  ApprovalStatsView,
  DiffStatsView,
  DiffViewData,
  DigestViewData,
  FileChangeView,
  RiskHighlightView,
  TestResultsView,
} from './digest-types.js';

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
 * Digest templates
 * ------------------------------------------------------------------ */

/**
 * Render a full completion digest as a {@link RenderTree}.
 *
 * Surfaces the task header (task id, agent, branch, commit), the executive
 * summary, test results, approval stats, risk highlights, decisions, and the
 * changed-files list. Action buttons carry string command identifiers so the
 * renderer can dispatch them to the typed command API without closures.
 *
 * @param view - The display-ready digest view data.
 * @returns A serializable RenderTree describing the digest.
 */
export function renderDigest(view: DigestViewData): RenderTree {
  const children: (RenderTree | string)[] = [
    renderDigestHeader(view),
    renderDigestSummary(view),
    renderTestResults(view.testResults),
    renderApprovalStats(view.approvalStats),
  ];
  if (view.riskHighlights.length > 0) {
    children.push(renderRiskHighlights(view.riskHighlights));
  }
  if (view.decisions.length > 0) {
    children.push(renderDecisions(view.decisions));
  }
  if (view.filesChanged.length > 0) {
    children.push(renderChangedFilesList(view.filesChanged));
  }
  children.push(renderDigestActions(view));
  return el('CompletionDigest', { taskId: view.taskId, spacing: 'md' }, children);
}

/**
 * Render the digest header: task id, agent, duration, branch, and commit.
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
 * Render the executive summary line (DEC-009).
 *
 * @param view - The display-ready digest view data.
 * @returns A serializable RenderTree for the summary section.
 */
export function renderDigestSummary(view: DigestViewData): RenderTree {
  return el('DigestSummary', { weight: 'semibold', variant: 'executive' }, [text(view.summary)]);
}

/**
 * Render test results as a colored pass/fail summary.
 *
 * Uses semantic color tokens: `green` when all pass, `red` when any fail,
 * `slate` when no tests were run.
 *
 * @param results - The display-ready test results.
 * @returns A serializable RenderTree for the test results section.
 */
export function renderTestResults(results: TestResultsView): RenderTree {
  return el(
    'TestResults',
    {
      passColor: results.passColor,
      failColor: results.failColor,
      allPassed: results.allPassed,
      noneRun: results.noneRun,
      layout: 'row',
      gap: 'sm',
    },
    [
      el('Icon', { name: testIcon(results), color: results.passColor }, []),
      el('TestSummary', { color: results.passColor, weight: 'medium' }, [text(results.summary)]),
    ],
  );
}

/**
 * Render approval stats as granted/denied/pending counts.
 *
 * @param stats - The display-ready approval statistics.
 * @returns A serializable RenderTree for the approval stats section.
 */
export function renderApprovalStats(stats: ApprovalStatsView): RenderTree {
  const chips: RenderTree[] = [
    el('ApprovalChip', { kind: 'granted', color: 'green' }, [text(`${stats.granted} granted`)]),
  ];
  if (stats.denied > 0) {
    chips.push(
      el('ApprovalChip', { kind: 'denied', color: 'red' }, [text(`${stats.denied} denied`)]),
    );
  }
  if (stats.pending > 0) {
    chips.push(
      el('ApprovalChip', { kind: 'pending', color: 'amber' }, [text(`${stats.pending} pending`)]),
    );
  }
  if (stats.requested === 0) {
    chips.push(
      el('ApprovalChip', { kind: 'none', color: 'slate' }, [text('No approvals requested')]),
    );
  }
  return el('ApprovalStats', { layout: 'row', gap: 'sm', wrap: true }, chips);
}

/**
 * Render risk highlights as a bulleted, color-coded list.
 *
 * Each highlight carries its semantic color token (`red` for blocking,
 * `orange` for warnings) and a string command identifier so the renderer can
 * wire drill-down from a risk hotspot to the relevant diff location.
 *
 * @param highlights - The display-ready risk highlights.
 * @returns A serializable RenderTree for the risk highlights section.
 */
export function renderRiskHighlights(highlights: readonly RiskHighlightView[]): RenderTree {
  return el(
    'RiskHighlights',
    { layout: 'column', gap: 'xs' },
    highlights.map((h) =>
      el(
        'RiskHighlight',
        {
          kind: h.kind,
          color: h.color,
          icon: riskIconFor(h.kind),
          command: `drill-risk:${h.kind}`,
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
  return el(
    'ChangedFiles',
    { layout: 'column', gap: 'xs', count: paths.length },
    paths.map((p) => el('FilePath', { selectable: true, icon: 'file' }, [text(p)])),
  );
}

/**
 * Render the digest action buttons. Each carries a string command identifier.
 */
function renderDigestActions(view: DigestViewData): RenderTree {
  return el('DigestActions', { layout: 'row', gap: 'sm' }, [
    el('Button', { command: `open-diff:${view.taskId}`, variant: 'ghost', size: 'sm' }, [
      text('Open diff'),
    ]),
    el('Button', { command: `create-pr:${view.taskId}`, variant: 'primary', size: 'sm' }, [
      text('Create PR'),
    ]),
    el('Button', { command: `accept:${view.taskId}`, variant: 'ghost', size: 'sm' }, [
      text('Accept'),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Diff templates
 * ------------------------------------------------------------------ */

/**
 * Render the full diff view as a {@link RenderTree}.
 *
 * Surfaces the commit metadata header, summary stats, file groups (by
 * status), and the large-changes callout. Each file row carries a string
 * command identifier so the renderer can wire drill-down to the file's diff.
 *
 * @param view - The display-ready diff view data.
 * @returns A serializable RenderTree describing the diff view.
 */
export function renderDiffView(view: DiffViewData): RenderTree {
  const children: (RenderTree | string)[] = [renderDiffHeader(view), renderDiffStats(view.stats)];
  for (const group of view.fileGroups) {
    children.push(renderFileList(group.files));
  }
  if (view.hasLargeChanges) {
    children.push(renderLargeChangesCallout(view.largeChanges));
  }
  return el(
    'DiffView',
    { branch: view.branch, headCommit: view.headCommit, spacing: 'md' },
    children,
  );
}

/**
 * Render the diff header: branch, base..head, author, commit message.
 */
function renderDiffHeader(view: DiffViewData): RenderTree {
  return el('DiffHeader', { layout: 'column', gap: 'xs' }, [
    detailRow('Branch', view.branch),
    detailRow('Range', `${view.baseCommit}..${view.headCommit}`),
    detailRow('Author', view.author),
    detailRow('Commit', view.commitMessage),
  ]);
}

/**
 * Render a list of files (a single status group) as a {@link RenderTree}.
 *
 * Each file row shows the path, status badge, additions/deletions counts
 * (colored green/red), and a large-change flag when applicable. Rows carry a
 * `command` string identifier for drill-down.
 *
 * @param files - The display-ready file changes in this group.
 * @returns A serializable RenderTree for the file list.
 */
export function renderFileList(files: readonly FileChangeView[]): RenderTree {
  return el(
    'FileList',
    { layout: 'column', gap: 'xs', count: files.length },
    files.map((f) => renderFileRow(f)),
  );
}

/**
 * Render a single file row.
 */
function renderFileRow(file: FileChangeView): RenderTree {
  const children: (RenderTree | string)[] = [
    el('StatusBadge', { status: file.status, color: statusColorFor(file.status) }, [
      text(file.status),
    ]),
    el('FilePath', { selectable: true, icon: 'file' }, [text(file.path)]),
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
 * Render the diff summary stats (total files, additions, deletions, net).
 *
 * Additions are colored green, deletions red, and the net change is colored
 * green when positive and red when negative.
 *
 * @param stats - The display-ready diff stats.
 * @returns A serializable RenderTree for the stats section.
 */
export function renderDiffStats(stats: DiffStatsView): RenderTree {
  const netColor = stats.netChange >= 0 ? 'green' : 'red';
  const netSign = stats.netChange >= 0 ? '+' : '';
  return el('DiffStats', { layout: 'row', gap: 'md', wrap: true }, [
    el('Stat', { label: 'files', color: 'slate' }, [text(String(stats.totalFiles))]),
    el('Stat', { label: 'additions', color: 'green' }, [text(`+${stats.totalAdditions}`)]),
    el('Stat', { label: 'deletions', color: 'red' }, [text(`-${stats.totalDeletions}`)]),
    el('Stat', { label: 'net', color: netColor }, [text(`${netSign}${stats.netChange}`)]),
  ]);
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

/** Icon identifier for a test-results state. */
function testIcon(results: TestResultsView): string {
  if (results.noneRun) return 'minus';
  return results.allPassed ? 'check-circle' : 'alert';
}

/** Icon identifier for a risk highlight kind. */
function riskIconFor(kind: RiskHighlightView['kind']): string {
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
function statusColorFor(status: ChangedFileStatus): string {
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
