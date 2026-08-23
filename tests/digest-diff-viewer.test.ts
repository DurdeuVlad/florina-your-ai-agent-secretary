import { describe, it, expect } from 'vitest';

import type { CompletionDigest } from '../src/attention/completion-digest.js';
import type { DiffDigest } from '../src/attention/diff-digest.js';
import { DigestViewModel } from '../src/desktop/views/digest-view.js';
import { DiffViewModel } from '../src/desktop/views/diff-view.js';
import {
  DigestDiffViewerModel,
  DIGEST_FIELD_COUNT,
} from '../src/desktop/views/digest-diff-viewer.js';
import { DEFAULT_DIFF_PAGE_SIZE } from '../src/desktop/views/digest-diff-types.js';
import { renderDigestDiffViewer } from '../src/desktop/views/digest-diff-templates.js';
import type { RenderTree as ViewRenderTree } from '../src/desktop/views/view-types.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

const viewerModel = new DigestDiffViewerModel(
  new DigestViewModel(),
  new DiffViewModel(),
);

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

/** Find all nodes in a RenderTree matching a predicate. */
function findNodes(
  tree: RenderTreeLike,
  pred: (node: RenderTreeLike) => boolean,
  acc: RenderTreeLike[] = [],
): RenderTreeLike[] {
  if (pred(tree)) acc.push(tree);
  const children = tree.children ?? [];
  for (const c of children) {
    if (typeof c !== 'string') findNodes(c, pred, acc);
  }
  return acc;
}

type RenderTreeLike = {
  tag: string;
  props?: Record<string, unknown>;
  children?: readonly (RenderTreeLike | string)[];
};

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
    filesChangedCount: 3,
    filesChanged: [
      'src/pagination.ts',
      'src/pagination-view.ts',
      'tests/pagination.test.ts',
    ],
    testsRun: 23,
    testsPassed: 23,
    testsFailed: 0,
    approvalsRequested: 2,
    approvalsGranted: 2,
    approvalsDenied: 0,
    decisions: [{ id: 'DEC-007', note: 'Autonomy is user-configurable.' }],
    riskHighlights: [],
    commitHash: 'abc1234',
    branchName: 'secretary/add-pagination',
    ...overrides,
  };
}

/** Build a DiffDigest with sensible defaults. */
function makeDiff(overrides: Partial<DiffDigest> = {}): DiffDigest {
  return {
    branch: 'secretary/add-pagination',
    baseCommit: 'base000',
    headCommit: 'head000',
    author: 'Test <test@example.com>',
    commitMessage: 'feat: add pagination',
    changedFiles: [
      { path: 'src/pagination.ts', additions: 120, deletions: 5, status: 'added' },
      { path: 'src/pagination-view.ts', additions: 40, deletions: 10, status: 'modified' },
      { path: 'tests/pagination.test.ts', additions: 20, deletions: 0, status: 'added' },
    ],
    diffStat: '3 files changed, 180 insertions(+), 15 deletions(-)',
    pathClassifications: [],
    unexpectedLockfileChange: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * DigestDiffViewerModel.buildView — combined panes
 * ------------------------------------------------------------------ */

describe('DigestDiffViewerModel.buildView', () => {
  it('combines digest and diff into a single viewer data object', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    expect(data.taskId).toBe('add-pagination');
    expect(data.hasDiff).toBe(true);
    expect(data.digest.taskId).toBe('add-pagination');
    expect(data.diff).not.toBeNull();
    expect(data.diff!.branch).toBe('secretary/add-pagination');
  });

  it('falls back to digest.diffSummary when no standalone diff is given', () => {
    const diff = makeDiff();
    const digest = makeDigest({ diffSummary: diff });
    const data = viewerModel.buildView(digest);
    expect(data.hasDiff).toBe(true);
    expect(data.diff).not.toBeNull();
    expect(data.diff!.headCommit).toBe('head000');
  });

  it('sets hasDiff to false when no diff is available', () => {
    const data = viewerModel.buildView(makeDigest());
    expect(data.hasDiff).toBe(false);
    expect(data.diff).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Observed vs inferred field classification
 * ------------------------------------------------------------------ */

describe('observed vs inferred field classification', () => {
  it('classifies exactly 8 digest fields', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    expect(data.fields).toHaveLength(8);
    expect(DIGEST_FIELD_COUNT).toBe(8);
  });

  it('marks summary and riskHighlights as inferred', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    const summary = data.fields.find((f) => f.id === 'summary');
    const risks = data.fields.find((f) => f.id === 'riskHighlights');
    expect(summary?.provenance).toBe('inferred');
    expect(risks?.provenance).toBe('inferred');
  });

  it('marks deterministic fields as observed', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    const observed = data.fields.filter((f) => f.provenance === 'observed');
    // 8 total - 2 inferred = 6 observed
    expect(observed).toHaveLength(6);
    const ids = observed.map((f) => f.id);
    expect(ids).toContain('header');
    expect(ids).toContain('testResults');
    expect(ids).toContain('approvalStats');
    expect(ids).toContain('decisions');
    expect(ids).toContain('filesChanged');
    expect(ids).toContain('commitInfo');
  });
});

/* ------------------------------------------------------------------ *
 * Risk hotspot drill-down
 * ------------------------------------------------------------------ */

describe('risk hotspot drill-down', () => {
  it('builds risk hotspots from the digest risk highlights', () => {
    const digest = makeDigest({
      riskHighlights: [
        { kind: 'failed-tests', message: '2 tests failed.' },
        { kind: 'critical-action', message: 'Critical capability requested.' },
      ],
    });
    const data = viewerModel.buildView(digest, makeDiff());
    expect(data.riskHotspots).toHaveLength(2);
    expect(data.riskHotspots[0].kind).toBe('failed-tests');
    expect(data.riskHotspots[0].color).toBe('red');
    expect(data.riskHotspots[1].kind).toBe('critical-action');
    expect(data.riskHotspots[1].color).toBe('orange');
  });

  it('drills failed-tests into the first test file in the diff', () => {
    const digest = makeDigest({
      riskHighlights: [{ kind: 'failed-tests', message: '2 tests failed.' }],
    });
    const data = viewerModel.buildView(digest, makeDiff());
    expect(data.riskHotspots[0].drillTarget).toBe('tests/pagination.test.ts');
    expect(data.riskHotspots[0].command).toBe(
      'drill-risk:failed-tests:tests/pagination.test.ts',
    );
  });

  it('returns null drillTarget for risks with no specific file', () => {
    const digest = makeDigest({
      riskHighlights: [{ kind: 'critical-action', message: 'Critical.' }],
    });
    const data = viewerModel.buildView(digest, makeDiff());
    expect(data.riskHotspots[0].drillTarget).toBeNull();
    expect(data.riskHotspots[0].command).toBe('drill-risk:critical-action');
  });

  it('returns null drillTarget when there is no diff', () => {
    const digest = makeDigest({
      riskHighlights: [{ kind: 'failed-tests', message: '2 tests failed.' }],
    });
    const data = viewerModel.buildView(digest);
    expect(data.riskHotspots[0].drillTarget).toBeNull();
  });

  it('returns null drillTarget for failed-tests when no test file exists in diff', () => {
    const digest = makeDigest({
      riskHighlights: [{ kind: 'failed-tests', message: '2 tests failed.' }],
    });
    const diff = makeDiff({
      changedFiles: [
        { path: 'src/pagination.ts', additions: 10, deletions: 0, status: 'added' },
      ],
    });
    const data = viewerModel.buildView(digest, diff);
    expect(data.riskHotspots[0].drillTarget).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Pagination (large diffs)
 * ------------------------------------------------------------------ */

describe('pagination for large diffs', () => {
  it('uses the default page size of 50 files', () => {
    expect(DEFAULT_DIFF_PAGE_SIZE).toBe(50);
  });

  it('computes a single page for small diffs', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    expect(data.pagination.totalFiles).toBe(3);
    expect(data.pagination.totalPages).toBe(1);
    expect(data.pagination.page).toBe(0);
    expect(data.pagination.hasNext).toBe(false);
    expect(data.pagination.hasPrev).toBe(false);
  });

  it('paginates large diffs across multiple pages', () => {
    const files = Array.from({ length: 125 }, (_, i) => ({
      path: `src/file${i}.ts`,
      additions: 5,
      deletions: 1,
      status: 'modified' as const,
    }));
    const diff = makeDiff({ changedFiles: files });
    const data = viewerModel.buildView(makeDigest(), diff, 0, 50);
    expect(data.pagination.totalFiles).toBe(125);
    expect(data.pagination.totalPages).toBe(3);
    expect(data.pagination.page).toBe(0);
    expect(data.pagination.hasNext).toBe(true);
    expect(data.pagination.hasPrev).toBe(false);
  });

  it('clamps the page index to the valid range', () => {
    const files = Array.from({ length: 125 }, (_, i) => ({
      path: `src/file${i}.ts`,
      additions: 5,
      deletions: 1,
      status: 'modified' as const,
    }));
    const diff = makeDiff({ changedFiles: files });
    const data = viewerModel.buildView(makeDigest(), diff, 99, 50);
    expect(data.pagination.page).toBe(2); // last valid page
    expect(data.pagination.hasNext).toBe(false);
    expect(data.pagination.hasPrev).toBe(true);
  });

  it('buildDiffPage returns only the files for the requested page', () => {
    const files = Array.from({ length: 125 }, (_, i) => ({
      path: `src/file${i}.ts`,
      additions: 5,
      deletions: 1,
      status: 'modified' as const,
    }));
    const diff = makeDiff({ changedFiles: files });
    const data = viewerModel.buildView(makeDigest(), diff, 0, 50);
    const page1 = viewerModel.buildDiffPage(data, 1);
    expect(page1).not.toBeNull();
    expect(page1!.pagination.page).toBe(1);
    expect(page1!.files).toHaveLength(50);
    expect(page1!.files[0].path).toBe('src/file50.ts');
    expect(page1!.files[49].path).toBe('src/file99.ts');
  });

  it('buildDiffPage returns the last partial page', () => {
    const files = Array.from({ length: 125 }, (_, i) => ({
      path: `src/file${i}.ts`,
      additions: 5,
      deletions: 1,
      status: 'modified' as const,
    }));
    const diff = makeDiff({ changedFiles: files });
    const data = viewerModel.buildView(makeDigest(), diff, 0, 50);
    const lastPage = viewerModel.buildDiffPage(data, 2);
    expect(lastPage).not.toBeNull();
    expect(lastPage!.files).toHaveLength(25);
    expect(lastPage!.files[0].path).toBe('src/file100.ts');
  });

  it('buildDiffPage returns null when there is no diff', () => {
    const data = viewerModel.buildView(makeDigest());
    expect(viewerModel.buildDiffPage(data, 0)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Create PR command
 * ------------------------------------------------------------------ */

describe('buildCreatePrCommand', () => {
  it('builds a create-pr command with the task id', () => {
    const cmd = viewerModel.buildCreatePrCommand('add-pagination');
    expect(cmd.kind).toBe('create-pr');
    expect(cmd.taskId).toBe('add-pagination');
    expect(cmd.title).toBeUndefined();
    expect(cmd.body).toBeUndefined();
  });

  it('includes optional title and body', () => {
    const cmd = viewerModel.buildCreatePrCommand('add-pagination', 'My PR', 'desc');
    expect(cmd.title).toBe('My PR');
    expect(cmd.body).toBe('desc');
  });
});

/* ------------------------------------------------------------------ *
 * Templates — side-by-side rendering
 * ------------------------------------------------------------------ */

describe('renderDigestDiffViewer', () => {
  it('produces a serializable RenderTree with a split-pane layout', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    const tree = renderDigestDiffViewer(data) as unknown as RenderTreeLike;
    expect(tree.tag).toBe('DigestDiffViewer');
    assertJsonSerializable(tree);
    const split = findNodes(tree, (n) => n.tag === 'SplitPane');
    expect(split).toHaveLength(1);
  });

  it('renders a DigestPane on the left and a DiffPane on the right', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    const tree = renderDigestDiffViewer(data) as unknown as RenderTreeLike;
    const panes = findNodes(tree, (n) => n.tag === 'DigestPane' || n.tag === 'DiffPane');
    expect(panes).toHaveLength(2);
    const digestPane = panes.find((p) => p.tag === 'DigestPane');
    const diffPane = panes.find((p) => p.tag === 'DiffPane');
    expect(digestPane?.props!.side).toBe('left');
    expect(diffPane?.props!.side).toBe('right');
  });

  it('renders an empty DiffPane when there is no diff', () => {
    const data = viewerModel.buildView(makeDigest());
    const tree = renderDigestDiffViewer(data) as unknown as RenderTreeLike;
    const diffPane = findNodes(tree, (n) => n.tag === 'DiffPane')[0];
    expect(diffPane.props!.empty).toBe(true);
    const empty = findNodes(tree, (n) => n.tag === 'EmptyDiff');
    expect(empty).toHaveLength(1);
  });

  it('visually distinguishes observed (solid) and inferred (dashed) fields', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    const tree = renderDigestDiffViewer(data) as unknown as RenderTreeLike;
    const fields = findNodes(tree, (n) => n.tag === 'DigestField');
    expect(fields.length).toBe(8);
    const observed = fields.filter((f) => f.props!.provenance === 'observed');
    const inferred = fields.filter((f) => f.props!.provenance === 'inferred');
    expect(observed.length).toBe(6);
    expect(inferred.length).toBe(2);
    for (const f of observed) {
      expect(f.props!.borderStyle).toBe('solid');
      expect(f.props!.background).toBeUndefined();
    }
    for (const f of inferred) {
      expect(f.props!.borderStyle).toBe('dashed');
      expect(f.props!.background).toBe('inferred');
    }
  });

  it('renders an InferredTag badge on inferred fields only', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    const tree = renderDigestDiffViewer(data) as unknown as RenderTreeLike;
    const fields = findNodes(tree, (n) => n.tag === 'DigestField');
    for (const f of fields) {
      const tags = (f.children ?? []).filter(
        (c): c is RenderTreeLike => typeof c !== 'string' && c.tag === 'InferredTag',
      );
      if (f.props!.provenance === 'inferred') {
        expect(tags).toHaveLength(1);
      } else {
        expect(tags).toHaveLength(0);
      }
    }
  });

  it('renders risk hotspots as clickable elements with drill-down commands', () => {
    const digest = makeDigest({
      riskHighlights: [
        { kind: 'failed-tests', message: '2 tests failed.' },
        { kind: 'critical-action', message: 'Critical.' },
      ],
    });
    const data = viewerModel.buildView(digest, makeDiff());
    const tree = renderDigestDiffViewer(data) as unknown as RenderTreeLike;
    const hotspots = findNodes(tree, (n) => n.tag === 'RiskHotspot');
    expect(hotspots).toHaveLength(2);
    // failed-tests has a drill target → clickable
    expect(hotspots[0].props!.clickable).toBe(true);
    expect(hotspots[0].props!.command).toBe(
      'drill-risk:failed-tests:tests/pagination.test.ts',
    );
    expect(hotspots[0].props!.drillTarget).toBe('tests/pagination.test.ts');
    // critical-action has no drill target → not clickable
    expect(hotspots[1].props!.clickable).toBe(false);
    expect(hotspots[1].props!.command).toBe('drill-risk:critical-action');
  });

  it('renders a Create PR action button that invokes the daemon', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    const tree = renderDigestDiffViewer(data) as unknown as RenderTreeLike;
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain('create-pr:add-pagination');
    const buttons = findNodes(
      tree,
      (n) => n.tag === 'Button' && n.props!.command === 'create-pr:add-pagination',
    );
    expect(buttons).toHaveLength(1);
  });

  it('renders pagination controls for the diff pane', () => {
    const files = Array.from({ length: 125 }, (_, i) => ({
      path: `src/file${i}.ts`,
      additions: 5,
      deletions: 1,
      status: 'modified' as const,
    }));
    const diff = makeDiff({ changedFiles: files });
    const data = viewerModel.buildView(makeDigest(), diff, 0, 50);
    const tree = renderDigestDiffViewer(data) as unknown as RenderTreeLike;
    const controls = findNodes(tree, (n) => n.tag === 'PaginationControls');
    expect(controls).toHaveLength(1);
    const indicator = findNodes(tree, (n) => n.tag === 'PageIndicator')[0];
    expect(indicator.children![0]).toContain('Page 1 of 3');
    expect(indicator.children![0]).toContain('125 files');
  });

  it('renders only the current page of file rows (lazy rendering)', () => {
    const files = Array.from({ length: 125 }, (_, i) => ({
      path: `src/file${i}.ts`,
      additions: 5,
      deletions: 1,
      status: 'modified' as const,
    }));
    const diff = makeDiff({ changedFiles: files });
    const data = viewerModel.buildView(makeDigest(), diff, 1, 50);
    const page = viewerModel.buildDiffPage(data, 1);
    const tree = renderDigestDiffViewer(data, page) as unknown as RenderTreeLike;
    const rows = findNodes(tree, (n) => n.tag === 'FileRow');
    expect(rows).toHaveLength(50);
    expect(rows[0].props!.path).toBe('src/file50.ts');
    expect(rows[49].props!.path).toBe('src/file99.ts');
  });

  it('renders file rows with drill-file commands', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    const tree = renderDigestDiffViewer(data) as unknown as RenderTreeLike;
    const rows = findNodes(tree, (n) => n.tag === 'FileRow');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].props!.command).toBe(`drill-file:${rows[0].props!.path}`);
  });
});

/* ------------------------------------------------------------------ *
 * JSON serializability
 * ------------------------------------------------------------------ */

describe('JSON serializability', () => {
  it('DigestDiffViewerData is JSON-serializable', () => {
    const data = viewerModel.buildView(
      makeDigest({
        riskHighlights: [
          { kind: 'failed-tests', message: '2 tests failed.' },
          { kind: 'critical-action', message: 'Critical.' },
        ],
      }),
      makeDiff(),
    );
    assertJsonSerializable(data);
    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);
    expect(parsed.taskId).toBe('add-pagination');
    expect(parsed.hasDiff).toBe(true);
  });

  it('the rendered viewer tree is JSON-serializable', () => {
    const data = viewerModel.buildView(makeDigest(), makeDiff());
    const tree = renderDigestDiffViewer(data);
    assertJsonSerializable(tree);
    // Round-trip through JSON.
    const json = JSON.stringify(tree);
    const parsed = JSON.parse(json) as ViewRenderTree;
    expect(parsed.tag).toBe('DigestDiffViewer');
  });
});
