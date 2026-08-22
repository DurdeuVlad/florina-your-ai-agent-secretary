import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { CompletionDigestBuilder, DigestBuilder } from '../src/attention/index.js';
import type { CompletionDigest } from '../src/attention/index.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import type { DiffDigest } from '../src/attention/diff-digest.js';
import { StorageDatabase, CompletionDigestRepository } from '../src/storage/index.js';

/* ------------------------------------------------------------------ *
 * Event factory helpers
 * ------------------------------------------------------------------ */

const BASE = {
  taskId: 'task-42',
  sessionId: 'sess-7',
  agentId: 'codex',
  adapterFidelityTier: 'A' as const,
};

function ts(seconds: number): string {
  return new Date(2026, 0, 1, 12, 0, 0, seconds * 1000).toISOString();
}

function agentStarted(overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'AgentStarted',
    timestamp: ts(0),
    ...BASE,
    objective: 'Add cursor pagination to invoices',
    workingDir: '/repo/invoices',
    model: 'gpt-5',
    ...overrides,
  } as SupervisorEvent;
}

function agentProgress(overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'AgentProgress',
    timestamp: ts(5),
    ...BASE,
    message: 'Analyzing repository structure',
    step: 1,
    totalSteps: 5,
    ...overrides,
  } as SupervisorEvent;
}

function toolStarted(overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'ToolStarted',
    timestamp: ts(10),
    ...BASE,
    toolName: 'shell',
    args: { cmd: 'npm test' },
    ...overrides,
  } as SupervisorEvent;
}

function toolFinished(overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'ToolFinished',
    timestamp: ts(15),
    ...BASE,
    toolName: 'shell',
    success: true,
    durationMs: 5000,
    ...overrides,
  } as SupervisorEvent;
}

function fileChanged(path: string, overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'FileChanged',
    timestamp: ts(20),
    ...BASE,
    path,
    changeType: 'modified' as const,
    additions: 10,
    deletions: 2,
    ...overrides,
  } as SupervisorEvent;
}

function testStarted(overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'TestStarted',
    timestamp: ts(30),
    ...BASE,
    framework: 'vitest',
    target: 'src/auth.test.ts',
    command: 'npm test',
    ...overrides,
  } as SupervisorEvent;
}

function testFinished(
  passed: number,
  failed: number,
  overrides: Partial<SupervisorEvent> = {},
): SupervisorEvent {
  return {
    type: 'TestFinished',
    timestamp: ts(35),
    ...BASE,
    framework: 'vitest',
    target: 'src/auth.test.ts',
    passed,
    failed,
    skipped: 0,
    durationMs: 4500,
    ...overrides,
  } as SupervisorEvent;
}

function approvalRequested(overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'ApprovalRequested',
    timestamp: ts(40),
    ...BASE,
    task: 'Add cursor pagination to invoices',
    agent: 'codex',
    capability: 'network' as const,
    destination: 'registry.npmjs.org',
    command: 'npm install',
    workingDir: '/repo/invoices',
    scope: [{ type: 'network' as const, targets: ['registry.npmjs.org'] }],
    riskLevel: 'low' as const,
    ...overrides,
  } as SupervisorEvent;
}

function agentBlocked(overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'AgentBlocked',
    timestamp: ts(45),
    ...BASE,
    reason: 'Waiting on PR review',
    blockerType: 'dependency' as const,
    retryable: true,
    ...overrides,
  } as SupervisorEvent;
}

function agentCompleted(overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'AgentCompleted',
    timestamp: ts(60),
    ...BASE,
    summary: 'Added cursor pagination to invoices API',
    deliverables: [{ type: 'commit', ref: 'abc123def', summary: 'Add cursor pagination' }],
    exitCode: 0,
    durationMs: 60000,
    ...overrides,
  } as SupervisorEvent;
}

/* ------------------------------------------------------------------ *
 * Diff digest helper
 * ------------------------------------------------------------------ */

function makeDiffDigest(overrides: Partial<DiffDigest> = {}): DiffDigest {
  return {
    branch: 'secretary/add-pagination',
    baseCommit: 'base456',
    headCommit: 'abc123def',
    author: 'Test <test@example.com>',
    commitMessage: 'Add cursor pagination',
    changedFiles: [
      { path: 'src/invoices.ts', additions: 28, deletions: 5, status: 'modified' },
      { path: 'src/invoices.test.ts', additions: 15, deletions: 0, status: 'modified' },
    ],
    diffStat: '2 files changed, 43 insertions(+), 5 deletions(-)',
    pathClassifications: [
      { path: 'src/invoices.ts', category: 'source', isSensitive: false },
      { path: 'src/invoices.test.ts', category: 'test', isSensitive: false },
    ],
    unexpectedLockfileChange: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Tests: CompletionDigestBuilder
 * ------------------------------------------------------------------ */

describe('CompletionDigestBuilder', () => {
  const builder = new CompletionDigestBuilder();

  describe('build — full event sequence', () => {
    it('aggregates all fields from a complete event sequence', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        agentProgress(),
        toolStarted(),
        toolFinished(),
        fileChanged('src/invoices.ts'),
        fileChanged('src/invoices.test.ts'),
        fileChanged('src/invoices.ts'), // duplicate path — should be deduped
        testStarted(),
        testFinished(23, 0),
        approvalRequested(),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      expect(digest.taskId).toBe('task-42');
      expect(digest.sessionId).toBe('sess-7');
      expect(digest.agentId).toBe('codex');
      expect(digest.startedAt).toBe(ts(0));
      expect(digest.completedAt).toBe(ts(60));
      expect(digest.duration).toBe(60000);
      expect(digest.filesChangedCount).toBe(2);
      expect(digest.filesChanged).toEqual(['src/invoices.test.ts', 'src/invoices.ts']);
      expect(digest.testsRun).toBe(23);
      expect(digest.testsPassed).toBe(23);
      expect(digest.testsFailed).toBe(0);
      expect(digest.approvalsRequested).toBe(1);
      expect(digest.approvalsGranted).toBe(1);
      expect(digest.approvalsDenied).toBe(0);
      expect(digest.commitHash).toBe('abc123def');
      expect(digest.branchName).toBeUndefined();
    });

    it('includes the diff summary when provided', () => {
      const events: SupervisorEvent[] = [agentStarted(), agentCompleted()];
      const diff = makeDiffDigest();

      const digest = builder.build('task-42', 'sess-7', events, diff);

      expect(digest.diffSummary).toEqual(diff);
      expect(digest.branchName).toBe('secretary/add-pagination');
      expect(digest.commitHash).toBe('abc123def');
    });

    it('prefers diff digest commit hash over completion deliverable', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        agentCompleted({
          deliverables: [{ type: 'commit', ref: 'fromevent' }],
        } as Partial<SupervisorEvent>),
      ];
      const diff = makeDiffDigest({ headCommit: 'fromdiff' });

      const digest = builder.build('task-42', 'sess-7', events, diff);

      expect(digest.commitHash).toBe('fromdiff');
    });

    it('falls back to completion deliverable for commit hash when no diff', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        agentCompleted({
          deliverables: [
            { type: 'commit', ref: 'fromevent' },
            { type: 'diff', ref: 'somediff' },
          ],
        } as Partial<SupervisorEvent>),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      expect(digest.commitHash).toBe('fromevent');
    });
  });

  describe('build — human-readable summary', () => {
    it('generates a concise, scannable summary on success', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        fileChanged('src/a.ts'),
        fileChanged('src/b.ts'),
        testFinished(10, 0),
        agentCompleted({ summary: 'Added pagination' } as Partial<SupervisorEvent>),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      expect(digest.summary).toContain('Added pagination');
      expect(digest.summary).toContain('2 file(s) changed');
      expect(digest.summary).toContain('10/10 tests passing');
      expect(digest.summary).not.toContain('failed');
    });

    it('includes failed test count in summary', () => {
      const events: SupervisorEvent[] = [agentStarted(), testFinished(8, 2), agentCompleted()];

      const digest = builder.build('task-42', 'sess-7', events);

      expect(digest.summary).toContain('8/10 tests passing, 2 failed');
    });

    it('includes approval count in summary', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        approvalRequested(),
        approvalRequested({ capability: 'filesystem' as const } as Partial<SupervisorEvent>),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      expect(digest.summary).toContain('2 approval(s) requested');
    });

    it('includes branch name in summary when diff digest is provided', () => {
      const events: SupervisorEvent[] = [agentStarted(), agentCompleted()];
      const diff = makeDiffDigest({ branch: 'secretary/feature-x' });

      const digest = builder.build('task-42', 'sess-7', events, diff);

      expect(digest.summary).toContain('branch: secretary/feature-x');
    });

    it('handles missing completion event gracefully', () => {
      const events: SupervisorEvent[] = [agentStarted(), fileChanged('src/a.ts')];

      const digest = builder.build('task-42', 'sess-7', events);

      expect(digest.summary).toContain('Task run ended (no completion event)');
      expect(digest.completedAt).toBe(ts(20));
    });
  });

  describe('build — risk highlights', () => {
    it('extracts failed tests as a risk highlight', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        testFinished(8, 2, {
          failures: [
            { name: 'should paginate results', message: 'AssertionError' },
            { name: 'should handle empty pages', message: 'TimeoutError' },
          ],
        } as Partial<SupervisorEvent>),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      const failedRisk = digest.riskHighlights.find((r) => r.kind === 'failed-tests');
      expect(failedRisk).toBeDefined();
      expect(failedRisk!.message).toContain('2 test(s) failed');
      expect(failedRisk!.message).toContain('should paginate results');
      expect(failedRisk!.message).toContain('should handle empty pages');
    });

    it('extracts critical-risk approval requests as risk highlights', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        approvalRequested({
          capability: 'push' as const,
          destination: 'origin/main',
          riskLevel: 'critical' as const,
        } as Partial<SupervisorEvent>),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      const criticalRisk = digest.riskHighlights.find((r) => r.kind === 'critical-action');
      expect(criticalRisk).toBeDefined();
      expect(criticalRisk!.message).toContain('push');
      expect(criticalRisk!.message).toContain('origin/main');
    });

    it('extracts agent blocked as a risk highlight', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        agentBlocked({ reason: 'Waiting on dependency' } as Partial<SupervisorEvent>),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      const blockedRisk = digest.riskHighlights.find((r) => r.kind === 'blocked');
      expect(blockedRisk).toBeDefined();
      expect(blockedRisk!.message).toContain('Waiting on dependency');
    });

    it('produces no risk highlights for a clean run', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        fileChanged('src/a.ts'),
        testFinished(10, 0),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      expect(digest.riskHighlights).toHaveLength(0);
    });

    it('truncates long failure lists with ellipsis', () => {
      const failures = Array.from({ length: 5 }, (_, i) => ({
        name: `test-${i}`,
        message: 'fail',
      }));
      const events: SupervisorEvent[] = [
        agentStarted(),
        testFinished(0, 5, { failures } as Partial<SupervisorEvent>),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      const failedRisk = digest.riskHighlights.find((r) => r.kind === 'failed-tests');
      expect(failedRisk).toBeDefined();
      expect(failedRisk!.message).toContain('…');
    });
  });

  describe('build — decisions', () => {
    it('extracts DEC references from approval requests', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        approvalRequested({
          capability: 'push' as const,
          destination: 'origin/main',
          riskLevel: 'high' as const,
        } as Partial<SupervisorEvent>),
        approvalRequested({
          capability: 'network' as const,
          destination: 'registry.npmjs.org',
          riskLevel: 'low' as const,
        } as Partial<SupervisorEvent>),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      expect(digest.decisions.length).toBeGreaterThan(0);
      const decIds = digest.decisions.map((d) => d.id);
      expect(decIds).toContain('DEC-010');
      expect(decIds).toContain('DEC-007');
    });

    it('extracts DEC-011 for critical risk actions', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        approvalRequested({
          capability: 'destructive' as const,
          destination: 'production-db',
          riskLevel: 'critical' as const,
        } as Partial<SupervisorEvent>),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      const decIds = digest.decisions.map((d) => d.id);
      expect(decIds).toContain('DEC-011');
    });

    it('deduplicates decision references', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        approvalRequested({ capability: 'network' as const } as Partial<SupervisorEvent>),
        approvalRequested({ capability: 'network' as const } as Partial<SupervisorEvent>),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      const dec007 = digest.decisions.filter((d) => d.id === 'DEC-007');
      expect(dec007).toHaveLength(1);
    });
  });

  describe('build — edge cases', () => {
    it('handles empty event list', () => {
      const digest = builder.build('task-42', 'sess-7', []);

      expect(digest.taskId).toBe('task-42');
      expect(digest.sessionId).toBe('sess-7');
      expect(digest.agentId).toBe('');
      expect(digest.startedAt).toBe('');
      expect(digest.completedAt).toBe('');
      expect(digest.duration).toBe(0);
      expect(digest.filesChangedCount).toBe(0);
      expect(digest.testsRun).toBe(0);
      expect(digest.riskHighlights).toHaveLength(0);
    });

    it('handles events out of order', () => {
      const events: SupervisorEvent[] = [agentCompleted(), agentStarted(), testFinished(10, 0)];

      const digest = builder.build('task-42', 'sess-7', events);

      // Builder sorts by timestamp internally
      expect(digest.startedAt).toBe(ts(0));
      expect(digest.completedAt).toBe(ts(60));
    });

    it('aggregates multiple test runs', () => {
      const events: SupervisorEvent[] = [
        agentStarted(),
        testFinished(10, 0, { target: 'src/a.test.ts' } as Partial<SupervisorEvent>),
        testFinished(5, 2, { target: 'src/b.test.ts' } as Partial<SupervisorEvent>),
        agentCompleted(),
      ];

      const digest = builder.build('task-42', 'sess-7', events);

      expect(digest.testsRun).toBe(17);
      expect(digest.testsPassed).toBe(15);
      expect(digest.testsFailed).toBe(2);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Tests: DigestBuilder orchestrator
 * ------------------------------------------------------------------ */

describe('DigestBuilder orchestrator', () => {
  it('builds a digest via buildDigestForTask', () => {
    const orchestrator = new DigestBuilder();
    const events: SupervisorEvent[] = [
      agentStarted(),
      fileChanged('src/a.ts'),
      testFinished(5, 0),
      agentCompleted(),
    ];

    const digest = orchestrator.buildDigestForTask({
      taskId: 'task-99',
      sessionId: 'sess-1',
      events,
    });

    expect(digest.taskId).toBe('task-99');
    expect(digest.sessionId).toBe('sess-1');
    expect(digest.filesChangedCount).toBe(1);
    expect(digest.testsPassed).toBe(5);
  });

  it('passes diff digest through to the builder', () => {
    const orchestrator = new DigestBuilder();
    const events: SupervisorEvent[] = [agentStarted(), agentCompleted()];
    const diff = makeDiffDigest();

    const digest = orchestrator.buildDigestForTask({
      taskId: 'task-99',
      sessionId: 'sess-1',
      events,
      diffDigest: diff,
    });

    expect(digest.diffSummary).toEqual(diff);
    expect(digest.branchName).toBe('secretary/add-pagination');
  });
});

/* ------------------------------------------------------------------ *
 * Tests: CompletionDigestRepository (SQLite persistence)
 * ------------------------------------------------------------------ */

describe('CompletionDigestRepository', () => {
  let db: StorageDatabase;
  let repo: CompletionDigestRepository;

  beforeEach(() => {
    db = new StorageDatabase({ path: ':memory:' });
    db.open();
    repo = new CompletionDigestRepository(db.connection);
  });

  afterEach(() => {
    db.close();
  });

  function makeDigest(overrides: Partial<CompletionDigest> = {}): CompletionDigest {
    const builder = new CompletionDigestBuilder();
    const events: SupervisorEvent[] = [
      agentStarted(),
      fileChanged('src/a.ts'),
      testFinished(10, 0),
      agentCompleted(),
    ];
    const base = builder.build('task-42', 'sess-7', events, makeDiffDigest());
    return { ...base, ...overrides };
  }

  it('saves and retrieves a digest by task ID', () => {
    const digest = makeDigest();

    repo.save(digest);

    const retrieved = repo.findByTaskId('task-42');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.taskId).toBe('task-42');
    expect(retrieved!.sessionId).toBe('sess-7');
    expect(retrieved!.summary).toBe(digest.summary);
    expect(retrieved!.filesChangedCount).toBe(1);
    expect(retrieved!.testsPassed).toBe(10);
    expect(retrieved!.commitHash).toBe('abc123def');
    expect(retrieved!.branchName).toBe('secretary/add-pagination');
  });

  it('saves and retrieves a digest by session ID', () => {
    const digest = makeDigest();

    repo.save(digest);

    const retrieved = repo.findBySessionId('sess-7');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.sessionId).toBe('sess-7');
    expect(retrieved!.taskId).toBe('task-42');
  });

  it('returns null when no digest exists for a task', () => {
    expect(repo.findByTaskId('nonexistent')).toBeNull();
  });

  it('returns null when no digest exists for a session', () => {
    expect(repo.findBySessionId('nonexistent')).toBeNull();
  });

  it('retrieves the latest digest when multiple exist for a task', () => {
    const earlier = makeDigest({
      completedAt: ts(100),
    } as Partial<CompletionDigest>);
    const later = makeDigest({
      completedAt: ts(200),
      sessionId: 'sess-8',
    } as Partial<CompletionDigest>);

    repo.save(earlier);
    repo.save(later);

    const retrieved = repo.findByTaskId('task-42');
    expect(retrieved).not.toBeNull();
    // The latest (most recent completedAt) should be returned
    expect(retrieved!.completedAt).toBe(ts(200));
    expect(retrieved!.sessionId).toBe('sess-8');
  });

  it('lists recent digests ordered by completion time desc', () => {
    const d1 = makeDigest({
      taskId: 'task-1',
      sessionId: 'sess-1',
      completedAt: ts(100),
    } as Partial<CompletionDigest>);
    const d2 = makeDigest({
      taskId: 'task-2',
      sessionId: 'sess-2',
      completedAt: ts(200),
    } as Partial<CompletionDigest>);
    const d3 = makeDigest({
      taskId: 'task-3',
      sessionId: 'sess-3',
      completedAt: ts(300),
    } as Partial<CompletionDigest>);

    repo.save(d1);
    repo.save(d2);
    repo.save(d3);

    const all = repo.list();
    expect(all).toHaveLength(3);
    expect(all[0].taskId).toBe('task-3');
    expect(all[1].taskId).toBe('task-2');
    expect(all[2].taskId).toBe('task-1');
  });

  it('respects the limit option when listing', () => {
    for (let i = 0; i < 5; i++) {
      repo.save(
        makeDigest({
          taskId: `task-${i}`,
          sessionId: `sess-${i}`,
          completedAt: ts(100 + i),
        } as Partial<CompletionDigest>),
      );
    }

    const limited = repo.list({ limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].taskId).toBe('task-4');
    expect(limited[1].taskId).toBe('task-3');
  });

  it('round-trips complex nested fields (riskHighlights, decisions, diffSummary)', () => {
    const builder = new CompletionDigestBuilder();
    const events: SupervisorEvent[] = [
      agentStarted(),
      testFinished(8, 2, {
        failures: [{ name: 'failing test', message: 'boom' }],
      } as Partial<SupervisorEvent>),
      approvalRequested({
        capability: 'push' as const,
        riskLevel: 'critical' as const,
        destination: 'origin/main',
      } as Partial<SupervisorEvent>),
      agentBlocked({ reason: 'blocked for test' } as Partial<SupervisorEvent>),
      agentCompleted(),
    ];
    const digest = builder.build('task-42', 'sess-7', events, makeDiffDigest());

    repo.save(digest);
    const retrieved = repo.findByTaskId('task-42');

    expect(retrieved).not.toBeNull();
    expect(retrieved!.riskHighlights.length).toBeGreaterThan(0);
    expect(retrieved!.riskHighlights.some((r) => r.kind === 'failed-tests')).toBe(true);
    expect(retrieved!.riskHighlights.some((r) => r.kind === 'critical-action')).toBe(true);
    expect(retrieved!.riskHighlights.some((r) => r.kind === 'blocked')).toBe(true);
    expect(retrieved!.decisions.length).toBeGreaterThan(0);
    expect(retrieved!.diffSummary).toEqual(makeDiffDigest());
  });

  it('defaults to 50 when no limit is provided', () => {
    for (let i = 0; i < 55; i++) {
      repo.save(
        makeDigest({
          taskId: `task-${i}`,
          sessionId: `sess-${i}`,
          completedAt: ts(100 + i),
        } as Partial<CompletionDigest>),
      );
    }

    const all = repo.list();
    expect(all).toHaveLength(50);
  });
});
