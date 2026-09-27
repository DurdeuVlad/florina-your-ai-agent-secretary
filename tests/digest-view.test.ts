import { describe, it, expect } from 'vitest';

import type { CompletionDigest } from '../src/attention/completion-digest.js';
import type { DiffDigest } from '../src/attention/diff-digest.js';
import { DigestViewModel, formatDuration } from '../src/desktop/views/digest-view.js';
import { DiffViewModel, LARGE_CHANGE_THRESHOLD } from '../src/desktop/views/diff-view.js';
import {
  renderDigest,
  renderDigestSummary,
  renderTestResults,
  renderApprovalStats,
  renderRiskHighlights,
  renderDiffView,
  renderFileList,
  renderDiffStats,
} from '../src/desktop/views/digest-templates.js';
import type {
  DiffViewData,
  DigestViewData,
  FileChangeView,
} from '../src/desktop/views/digest-types.js';
import type { RenderTree as ViewRenderTree } from '../src/desktop/views/view-types.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

const digestViewModel = new DigestViewModel();
const diffViewModel = new DiffViewModel();

/** Recursively assert a value is JSON-serializable (no functions/symbols). */
function assertJsonSerializable(value: unknown, path = 'root'): void {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === 'function') {
    throw new Error(`Non-serializable function at ${path}`);
  }
  if (t === 'symbol') {
    throw new Error(`Non-serializable symbol at ${path}`);
  }
  if (t !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonSerializable(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertJsonSerializable(v, `${path}.${k}`);
  }
}

/** Build a CompletionDigest with sensible defaults. */
function makeDigest(overrides: Partial<CompletionDigest> = {}): CompletionDigest {
  return {
    taskId: 'add-pagination',
    sessionId: 'session-1',
    agentId: 'codex',
    startedAt: '2026-08-19T10:00:00.000Z',
    completedAt: '2026-08-19T10:02:34.000Z',
    duration: 154000,
    summary: 'Implementation complete. 9 files, +284/-71, 23/23 tests passing.',
    filesChangedCount: 9,
    filesChanged: ['src/pagination.ts', 'src/pagination-view.ts', 'tests/pagination.test.ts'],
    testsRun: 23,
    testsPassed: 23,
    testsFailed: 0,
    approvalsRequested: 2,
    approvalsGranted: 2,
    approvalsDenied: 0,
    decisions: [{ id: 'DEC-007', note: 'Autonomy is user-configurable.' }],
    riskHighlights: [],
    commitHash: 'abc1234',
    branchName: 'florina/add-pagination',
    ...overrides,
  };
}

/** Build a DiffDigest with sensible defaults. */
function makeDiff(overrides: Partial<DiffDigest> = {}): DiffDigest {
  return {
    branch: 'florina/add-pagination',
    baseCommit: 'base000',
    headCommit: 'head000',
    author: 'Test <test@example.com>',
    commitMessage: 'feat: add pagination',
    changedFiles: [
      { path: 'src/pagination.ts', additions: 120, deletions: 5, status: 'added' },
      { path: 'src/pagination-view.ts', additions: 40, deletions: 10, status: 'modified' },
      { path: 'src/old.ts', additions: 0, deletions: 80, status: 'deleted' },
      {
        path: 'src/renamed.ts',
        additions: 0,
        deletions: 0,
        status: 'renamed',
        renamedFrom: 'src/old-name.ts',
      },
      { path: 'assets/logo.png', additions: 0, deletions: 0, status: 'modified' },
    ],
    diffStat: '5 files changed, 160 insertions(+), 95 deletions(-)',
    pathClassifications: [],
    unexpectedLockfileChange: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * formatDuration
 * ------------------------------------------------------------------ */

describe('formatDuration', () => {
  it('formats 0ms as "0s"', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats sub-second durations as "0s"', () => {
    expect(formatDuration(500)).toBe('0s');
  });

  it('formats seconds', () => {
    expect(formatDuration(1500)).toBe('1s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(154000)).toBe('2m 34s');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatDuration(3723000)).toBe('1h 2m 3s');
  });

  it('formats exactly one minute', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
  });

  it('handles negative / invalid input as "0s"', () => {
    expect(formatDuration(-1)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});

/* ------------------------------------------------------------------ *
 * DigestViewModel.buildView
 * ------------------------------------------------------------------ */

describe('DigestViewModel.buildView', () => {
  it('transforms a CompletionDigest into display-ready view data', () => {
    const digest = makeDigest();
    const view = digestViewModel.buildView(digest);

    expect(view.taskId).toBe('add-pagination');
    expect(view.sessionId).toBe('session-1');
    expect(view.agentId).toBe('codex');
    expect(view.startedAt).toBe(digest.startedAt);
    expect(view.completedAt).toBe(digest.completedAt);
    expect(view.summary).toBe(digest.summary);
    expect(view.filesChangedCount).toBe(9);
    expect(view.filesChanged).toEqual(digest.filesChanged);
    expect(view.commitHash).toBe('abc1234');
    expect(view.branchName).toBe('florina/add-pagination');
  });

  it('formats the duration as a human-readable label', () => {
    const view = digestViewModel.buildView(makeDigest({ duration: 154000 }));
    expect(view.durationMs).toBe(154000);
    expect(view.durationLabel).toBe('2m 34s');
  });

  it('copies decisions into plain records', () => {
    const view = digestViewModel.buildView(
      makeDigest({
        decisions: [
          { id: 'DEC-007', note: 'Autonomy configurable.' },
          { id: 'DEC-011', note: 'Narrow permissions.' },
        ],
      }),
    );
    expect(view.decisions).toHaveLength(2);
    expect(view.decisions[0].id).toBe('DEC-007');
    expect(view.decisions[1].note).toBe('Narrow permissions.');
  });

  it('sets hasRisks to false when there are no risk highlights', () => {
    const view = digestViewModel.buildView(makeDigest({ riskHighlights: [] }));
    expect(view.hasRisks).toBe(false);
    expect(view.riskHighlights).toEqual([]);
  });

  it('sets hasRisks to true when there are risk highlights', () => {
    const view = digestViewModel.buildView(
      makeDigest({
        riskHighlights: [{ kind: 'failed-tests', message: '2 tests failed.' }],
      }),
    );
    expect(view.hasRisks).toBe(true);
    expect(view.riskHighlights).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Test results formatting
 * ------------------------------------------------------------------ */

describe('test results formatting', () => {
  it('formats all-passing tests with green color', () => {
    const results = digestViewModel.buildTestResults(
      makeDigest({ testsRun: 23, testsPassed: 23, testsFailed: 0 }),
    );
    expect(results.allPassed).toBe(true);
    expect(results.noneRun).toBe(false);
    expect(results.passColor).toBe('green');
    expect(results.failColor).toBe('slate');
    expect(results.summary).toBe('23/23 passing');
  });

  it('formats failing tests with red fail color', () => {
    const results = digestViewModel.buildTestResults(
      makeDigest({ testsRun: 10, testsPassed: 7, testsFailed: 3 }),
    );
    expect(results.allPassed).toBe(false);
    expect(results.passColor).toBe('amber');
    expect(results.failColor).toBe('red');
    expect(results.summary).toBe('7/10 passing, 3 failed');
  });

  it('formats no-tests-run with slate color', () => {
    const results = digestViewModel.buildTestResults(
      makeDigest({ testsRun: 0, testsPassed: 0, testsFailed: 0 }),
    );
    expect(results.noneRun).toBe(true);
    expect(results.allPassed).toBe(false);
    expect(results.passColor).toBe('slate');
    expect(results.summary).toBe('No tests run');
  });

  it('exposes results on the built view', () => {
    const view = digestViewModel.buildView(makeDigest());
    expect(view.testResults.allPassed).toBe(true);
    expect(view.testResults.summary).toBe('23/23 passing');
  });
});

/* ------------------------------------------------------------------ *
 * Approval stats
 * ------------------------------------------------------------------ */

describe('approval stats', () => {
  it('formats granted-only stats', () => {
    const stats = digestViewModel.buildApprovalStats(
      makeDigest({ approvalsRequested: 2, approvalsGranted: 2, approvalsDenied: 0 }),
    );
    expect(stats.requested).toBe(2);
    expect(stats.granted).toBe(2);
    expect(stats.denied).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.summary).toBe('2 granted');
  });

  it('computes pending as requested - granted - denied', () => {
    const stats = digestViewModel.buildApprovalStats(
      makeDigest({ approvalsRequested: 5, approvalsGranted: 2, approvalsDenied: 1 }),
    );
    expect(stats.pending).toBe(2);
    expect(stats.summary).toContain('2 granted');
    expect(stats.summary).toContain('1 denied');
    expect(stats.summary).toContain('2 pending');
  });

  it('handles no approvals requested', () => {
    const stats = digestViewModel.buildApprovalStats(
      makeDigest({ approvalsRequested: 0, approvalsGranted: 0, approvalsDenied: 0 }),
    );
    expect(stats.pending).toBe(0);
    expect(stats.summary).toBe('0 granted');
  });

  it('clamps pending to be non-negative', () => {
    const stats = digestViewModel.buildApprovalStats(
      makeDigest({ approvalsRequested: 1, approvalsGranted: 1, approvalsDenied: 1 }),
    );
    expect(stats.pending).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Risk highlights color mapping
 * ------------------------------------------------------------------ */

describe('risk highlights color mapping', () => {
  it('maps failed-tests to red', () => {
    const highlights = digestViewModel.buildRiskHighlights([
      { kind: 'failed-tests', message: '2 tests failed.' },
    ]);
    expect(highlights[0].color).toBe('red');
  });

  it('maps denied-approval to red', () => {
    const highlights = digestViewModel.buildRiskHighlights([
      { kind: 'denied-approval', message: '1 approval denied.' },
    ]);
    expect(highlights[0].color).toBe('red');
  });

  it('maps critical-action to orange', () => {
    const highlights = digestViewModel.buildRiskHighlights([
      { kind: 'critical-action', message: 'Critical capability requested.' },
    ]);
    expect(highlights[0].color).toBe('orange');
  });

  it('maps blocked to orange', () => {
    const highlights = digestViewModel.buildRiskHighlights([
      { kind: 'blocked', message: 'Agent blocked.' },
    ]);
    expect(highlights[0].color).toBe('orange');
  });
});

/* ------------------------------------------------------------------ *
 * DiffViewModel.buildView — file grouping
 * ------------------------------------------------------------------ */

describe('DiffViewModel.buildView — file grouping', () => {
  it('groups changed files by status (added, modified, deleted, renamed)', () => {
    const view = diffViewModel.buildView(makeDiff());
    const statuses = view.fileGroups.map((g) => g.status);
    expect(statuses).toEqual(['added', 'modified', 'deleted', 'renamed']);
  });

  it('omits empty groups', () => {
    const view = diffViewModel.buildView(
      makeDiff({
        changedFiles: [{ path: 'src/a.ts', additions: 10, deletions: 0, status: 'added' }],
      }),
    );
    expect(view.fileGroups).toHaveLength(1);
    expect(view.fileGroups[0].status).toBe('added');
  });

  it('counts files within each group', () => {
    const view = diffViewModel.buildView(makeDiff());
    const added = view.fileGroups.find((g) => g.status === 'added');
    const modified = view.fileGroups.find((g) => g.status === 'modified');
    expect(added?.count).toBe(1);
    expect(modified?.count).toBe(2); // pagination-view.ts and logo.png
  });

  it('preserves file paths and counts in each group', () => {
    const view = diffViewModel.buildView(makeDiff());
    const added = view.fileGroups.find((g) => g.status === 'added');
    expect(added?.files[0].path).toBe('src/pagination.ts');
    expect(added?.files[0].additions).toBe(120);
  });
});

/* ------------------------------------------------------------------ *
 * Diff stats calculation
 * ------------------------------------------------------------------ */

describe('diff stats calculation', () => {
  it('calculates total files, additions, deletions, and net change', () => {
    const view = diffViewModel.buildView(makeDiff());
    expect(view.stats.totalFiles).toBe(5);
    expect(view.stats.totalAdditions).toBe(160);
    expect(view.stats.totalDeletions).toBe(95);
    expect(view.stats.netChange).toBe(65);
  });

  it('calculates net change as negative when deletions exceed additions', () => {
    const view = diffViewModel.buildView(
      makeDiff({
        changedFiles: [{ path: 'a.ts', additions: 5, deletions: 50, status: 'modified' }],
      }),
    );
    expect(view.stats.netChange).toBe(-45);
  });

  it('counts large changes in stats', () => {
    const view = diffViewModel.buildView(makeDiff());
    // src/pagination.ts has 125 total changed (>100)
    expect(view.stats.largeChangeCount).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Per-file detail & large change highlighting
 * ------------------------------------------------------------------ */

describe('per-file detail', () => {
  it('derives totalChanged per file', () => {
    const view = diffViewModel.buildView(makeDiff());
    const pagination = view.files.find((f) => f.path === 'src/pagination.ts');
    expect(pagination?.totalChanged).toBe(125);
  });

  it('flags files with >100 lines changed as large changes', () => {
    const view = diffViewModel.buildView(makeDiff());
    const pagination = view.files.find((f) => f.path === 'src/pagination.ts');
    expect(pagination?.isLargeChange).toBe(true);
  });

  it('does not flag files with <=100 lines changed', () => {
    const view = diffViewModel.buildView(makeDiff());
    const modified = view.files.find((f) => f.path === 'src/pagination-view.ts');
    expect(modified?.totalChanged).toBe(50);
    expect(modified?.isLargeChange).toBe(false);
  });

  it('respects the LARGE_CHANGE_THRESHOLD constant', () => {
    expect(LARGE_CHANGE_THRESHOLD).toBe(100);
    const view = diffViewModel.buildView(
      makeDiff({
        changedFiles: [
          { path: 'exact.ts', additions: 100, deletions: 0, status: 'added' },
          { path: 'over.ts', additions: 101, deletions: 0, status: 'added' },
        ],
      }),
    );
    const exact = view.files.find((f) => f.path === 'exact.ts');
    const over = view.files.find((f) => f.path === 'over.ts');
    expect(exact?.isLargeChange).toBe(false);
    expect(over?.isLargeChange).toBe(true);
  });

  it('collects large changes into a dedicated list', () => {
    const view = diffViewModel.buildView(makeDiff());
    expect(view.hasLargeChanges).toBe(true);
    expect(view.largeChanges).toHaveLength(1);
    expect(view.largeChanges[0].path).toBe('src/pagination.ts');
  });

  it('detects binary files (non-deleted, non-renamed, 0/0)', () => {
    const view = diffViewModel.buildView(makeDiff());
    const logo = view.files.find((f) => f.path === 'assets/logo.png');
    expect(logo?.isBinary).toBe(true);
  });

  it('does not mark renamed 0/0 files as binary', () => {
    const view = diffViewModel.buildView(makeDiff());
    const renamed = view.files.find((f) => f.path === 'src/renamed.ts');
    expect(renamed?.isBinary).toBe(false);
  });

  it('preserves renamedFrom for renamed files', () => {
    const view = diffViewModel.buildView(makeDiff());
    const renamed = view.files.find((f) => f.path === 'src/renamed.ts');
    expect(renamed?.renamedFrom).toBe('src/old-name.ts');
  });
});

/* ------------------------------------------------------------------ *
 * Template functions — digest
 * ------------------------------------------------------------------ */

describe('digest template functions', () => {
  const digest = makeDigest({
    riskHighlights: [
      { kind: 'failed-tests', message: '2 tests failed.' },
      { kind: 'critical-action', message: 'Critical capability requested.' },
    ],
  });
  const view = digestViewModel.buildView(digest);

  it('renderDigest produces a serializable RenderTree', () => {
    const tree = renderDigest(view);
    expect(tree.tag).toBe('CompletionDigest');
    expect(tree.children).toBeDefined();
    expect(tree.children!.length).toBeGreaterThan(0);
    assertJsonSerializable(tree);
  });

  it('renderDigestSummary produces a serializable RenderTree', () => {
    const tree = renderDigestSummary(view);
    expect(tree.tag).toBe('DigestSummary');
    expect(tree.children![0]).toBe(view.summary);
    assertJsonSerializable(tree);
  });

  it('renderTestResults produces a colored summary', () => {
    const tree = renderTestResults(view.testResults);
    expect(tree.tag).toBe('TestResults');
    expect(tree.props!.passColor).toBe(view.testResults.passColor);
    expect(tree.props!.failColor).toBe(view.testResults.failColor);
    assertJsonSerializable(tree);
  });

  it('renderTestResults uses green when all pass', () => {
    const tree = renderTestResults(view.testResults);
    expect(tree.props!.passColor).toBe('green');
  });

  it('renderTestResults uses red fail color when tests fail', () => {
    const failing = digestViewModel.buildTestResults(
      makeDigest({ testsRun: 10, testsPassed: 7, testsFailed: 3 }),
    );
    const tree = renderTestResults(failing);
    expect(tree.props!.failColor).toBe('red');
  });

  it('renderApprovalStats produces granted/denied/pending chips', () => {
    const stats = digestViewModel.buildApprovalStats(
      makeDigest({ approvalsRequested: 5, approvalsGranted: 2, approvalsDenied: 1 }),
    );
    const tree = renderApprovalStats(stats);
    expect(tree.tag).toBe('ApprovalStats');
    const chips = tree.children as ViewRenderTree[];
    const texts = chips.map((c) => c.children![0]);
    expect(texts).toContain('2 granted');
    expect(texts).toContain('1 denied');
    expect(texts).toContain('2 pending');
    assertJsonSerializable(tree);
  });

  it('renderApprovalStats shows a none chip when no approvals requested', () => {
    const stats = digestViewModel.buildApprovalStats(
      makeDigest({ approvalsRequested: 0, approvalsGranted: 0, approvalsDenied: 0 }),
    );
    const tree = renderApprovalStats(stats);
    const chips = tree.children as ViewRenderTree[];
    expect(chips.some((c) => c.children![0] === 'No approvals requested')).toBe(true);
  });

  it('renderRiskHighlights produces a color-coded list', () => {
    const tree = renderRiskHighlights(view.riskHighlights);
    expect(tree.tag).toBe('RiskHighlights');
    expect(tree.children!.length).toBe(2);
    const items = tree.children as ViewRenderTree[];
    expect(items[0].props!.color).toBe('red'); // failed-tests
    expect(items[1].props!.color).toBe('orange'); // critical-action
    assertJsonSerializable(tree);
  });

  it('renderRiskHighlights carries a drill-down command per highlight', () => {
    const tree = renderRiskHighlights(view.riskHighlights);
    const items = tree.children as ViewRenderTree[];
    expect(items[0].props!.command).toBe('drill-risk:failed-tests');
  });

  it('renderDigest includes action buttons with command identifiers', () => {
    const tree = renderDigest(view);
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain('open-diff:add-pagination');
    expect(serialized).toContain('create-pr:add-pagination');
    expect(serialized).toContain('accept:add-pagination');
    /* #261: the create-pr button carries a confirm prompt */
    expect(serialized).toContain('Create a pull request for this work');
  });
});

/* ------------------------------------------------------------------ *
 * Template functions — diff
 * ------------------------------------------------------------------ */

describe('diff template functions', () => {
  const diff = makeDiff();
  const view = diffViewModel.buildView(diff);

  it('renderDiffView produces a serializable RenderTree', () => {
    const tree = renderDiffView(view);
    expect(tree.tag).toBe('DiffView');
    expect(tree.children).toBeDefined();
    expect(tree.children!.length).toBeGreaterThan(0);
    assertJsonSerializable(tree);
  });

  it('renderDiffView surfaces branch and head commit', () => {
    const tree = renderDiffView(view);
    expect(tree.props!.branch).toBe('florina/add-pagination');
    expect(tree.props!.headCommit).toBe('head000');
  });

  it('renderFileList produces a row per file', () => {
    const group = view.fileGroups.find((g) => g.status === 'added');
    const tree = renderFileList(group!.files);
    expect(tree.tag).toBe('FileList');
    expect(tree.children!.length).toBe(group!.files.length);
    assertJsonSerializable(tree);
  });

  it('renderFileList colors additions green and deletions red', () => {
    const file: FileChangeView = {
      path: 'src/a.ts',
      status: 'modified',
      additions: 30,
      deletions: 12,
      totalChanged: 42,
      isBinary: false,
      isLargeChange: false,
    };
    const tree = renderFileList([file]);
    const row = tree.children![0] as ViewRenderTree;
    const serialized = JSON.stringify(row);
    expect(serialized).toContain('"+30"');
    expect(serialized).toContain('"-12"');
  });

  it('renderFileList shows a binary tag for binary files', () => {
    const file: FileChangeView = {
      path: 'assets/logo.png',
      status: 'modified',
      additions: 0,
      deletions: 0,
      totalChanged: 0,
      isBinary: true,
      isLargeChange: false,
    };
    const tree = renderFileList([file]);
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain('binary');
  });

  it('renderFileList flags large changes', () => {
    const file: FileChangeView = {
      path: 'src/big.ts',
      status: 'added',
      additions: 150,
      deletions: 5,
      totalChanged: 155,
      isBinary: false,
      isLargeChange: true,
    };
    const tree = renderFileList([file]);
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain('large change');
  });

  it('renderFileList carries a drill-down command per file', () => {
    const tree = renderFileList(view.files);
    const row = tree.children![0] as ViewRenderTree;
    expect(row.props!.command).toBe('drill-file:src/pagination.ts');
  });

  it('renderDiffStats produces total files, additions, deletions, net', () => {
    const tree = renderDiffStats(view.stats);
    expect(tree.tag).toBe('DiffStats');
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain(String(view.stats.totalFiles));
    expect(serialized).toContain(`+${view.stats.totalAdditions}`);
    expect(serialized).toContain(`-${view.stats.totalDeletions}`);
    assertJsonSerializable(tree);
  });

  it('renderDiffStats colors net green when positive', () => {
    const tree = renderDiffStats({
      totalFiles: 1,
      totalAdditions: 50,
      totalDeletions: 10,
      netChange: 40,
      largeChangeCount: 0,
    });
    const stats = tree.children as ViewRenderTree[];
    const net = stats.find((s) => s.props!.label === 'net');
    expect(net?.props!.color).toBe('green');
  });

  it('renderDiffStats colors net red when negative', () => {
    const tree = renderDiffStats({
      totalFiles: 1,
      totalAdditions: 5,
      totalDeletions: 50,
      netChange: -45,
      largeChangeCount: 0,
    });
    const stats = tree.children as ViewRenderTree[];
    const net = stats.find((s) => s.props!.label === 'net');
    expect(net?.props!.color).toBe('red');
  });

  it('renderDiffView includes a large-changes callout when present', () => {
    const tree = renderDiffView(view);
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain('LargeChangesCallout');
    expect(serialized).toContain('large change');
  });
});

/* ------------------------------------------------------------------ *
 * JSON serializability
 * ------------------------------------------------------------------ */

describe('JSON serializability', () => {
  it('DigestViewData is JSON-serializable', () => {
    const view = digestViewModel.buildView(
      makeDigest({
        riskHighlights: [
          { kind: 'failed-tests', message: '2 tests failed.' },
          { kind: 'critical-action', message: 'Critical.' },
          { kind: 'denied-approval', message: 'Denied.' },
          { kind: 'blocked', message: 'Blocked.' },
        ],
      }),
    );
    assertJsonSerializable(view);
    // Round-trip through JSON.
    const json = JSON.stringify(view);
    const parsed = JSON.parse(json) as DigestViewData;
    expect(parsed.taskId).toBe(view.taskId);
    expect(parsed.testResults.summary).toBe(view.testResults.summary);
  });

  it('DiffViewData is JSON-serializable', () => {
    const view = diffViewModel.buildView(makeDiff());
    assertJsonSerializable(view);
    const json = JSON.stringify(view);
    const parsed = JSON.parse(json) as DiffViewData;
    expect(parsed.stats.totalFiles).toBe(view.stats.totalFiles);
    expect(parsed.fileGroups.length).toBe(view.fileGroups.length);
  });

  it('all template outputs are JSON-serializable', () => {
    const dview = digestViewModel.buildView(
      makeDigest({
        riskHighlights: [{ kind: 'failed-tests', message: 'x' }],
      }),
    );
    const diview = diffViewModel.buildView(makeDiff());
    assertJsonSerializable(renderDigest(dview));
    assertJsonSerializable(renderDigestSummary(dview));
    assertJsonSerializable(renderTestResults(dview.testResults));
    assertJsonSerializable(renderApprovalStats(dview.approvalStats));
    assertJsonSerializable(renderRiskHighlights(dview.riskHighlights));
    assertJsonSerializable(renderDiffView(diview));
    assertJsonSerializable(renderFileList(diview.files));
    assertJsonSerializable(renderDiffStats(diview.stats));
  });
});
