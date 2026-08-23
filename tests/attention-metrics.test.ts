import { describe, it, expect, beforeEach } from 'vitest';

import {
  computeAttentionMetrics,
  MetricsQueryService,
  MetricsRecorder,
  type AttentionMetricsInput,
  type AttentionItemResolution,
  type ApprovalExecutionPair,
} from '../src/attention/attention-metrics.js';
import type { AttentionItem } from '../src/attention/attention-item.js';
import { createAttentionItem } from '../src/attention/attention-item.js';
import type {
  AgentStartedEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStoppedEvent,
  ApprovalRequestedEvent,
  ToolStartedEvent,
  FileChangedEvent,
  SupervisorEvent,
} from '../src/domain/events.js';
import type { CapabilityRequest } from '../src/domain/capabilities.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

const base = {
  timestamp: '2026-08-19T12:00:00.000Z',
  taskId: 'task-1',
  sessionId: 'sess-1',
  agentId: 'codex',
  adapterFidelityTier: 'A' as const,
};

function ts(offsetMs: number): string {
  return new Date(Date.parse(base.timestamp) + offsetMs).toISOString();
}

function agentStarted(overrides: Partial<AgentStartedEvent> = {}): AgentStartedEvent {
  return { ...base, type: 'AgentStarted', objective: 'Test', workingDir: '/repo', ...overrides };
}

function agentCompleted(overrides: Partial<AgentCompletedEvent> = {}): AgentCompletedEvent {
  return { ...base, type: 'AgentCompleted', summary: 'Done', deliverables: [], ...overrides };
}

function agentFailed(overrides: Partial<AgentFailedEvent> = {}): AgentFailedEvent {
  return { ...base, type: 'AgentFailed', error: 'Boom', recoverable: true, ...overrides };
}

function agentStopped(overrides: Partial<AgentStoppedEvent> = {}): AgentStoppedEvent {
  return { ...base, type: 'AgentStopped', reason: 'user', ...overrides };
}

function approvalRequested(
  overrides: Partial<ApprovalRequestedEvent> = {},
): ApprovalRequestedEvent {
  return {
    ...base,
    type: 'ApprovalRequested',
    task: 'Test',
    agent: 'codex',
    capability: 'network',
    destination: 'example.com',
    command: 'npm install',
    workingDir: '/repo',
    scope: [{ type: 'network', targets: ['example.com'] }],
    riskLevel: 'low',
    ...overrides,
  };
}

function toolStarted(overrides: Partial<ToolStartedEvent> = {}): ToolStartedEvent {
  return { ...base, type: 'ToolStarted', toolName: 'shell', ...overrides };
}

function fileChanged(overrides: Partial<FileChangedEvent> = {}): FileChangedEvent {
  return { ...base, type: 'FileChanged', path: 'src/foo.ts', changeType: 'modified', ...overrides };
}

function capability(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    task: 'Test',
    agent: 'codex',
    capability: 'network',
    destination: 'example.com',
    command: 'npm install',
    workingDir: '/repo',
    scope: [{ type: 'network', targets: ['example.com'] }],
    riskLevel: 'low',
    ...overrides,
  };
}

function inboxItem(
  taskId: string,
  kind: AttentionItem['kind'],
  createdAt: string,
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  return createAttentionItem({ taskId, kind, priority: 'Medium', createdAt, ...overrides });
}

function resolution(overrides: Partial<AttentionItemResolution> = {}): AttentionItemResolution {
  return {
    itemId: 'item-1',
    taskId: 'task-1',
    kind: 'ApprovalRequest',
    createdAt: base.timestamp,
    openedTerminal: false,
    ...overrides,
  };
}

function pair(overrides: Partial<ApprovalExecutionPair> = {}): ApprovalExecutionPair {
  return {
    taskId: 'task-1',
    approved: capability(),
    executed: capability(),
    timestamp: base.timestamp,
    ...overrides,
  };
}

function compute(input: Partial<AttentionMetricsInput> = {}) {
  return computeAttentionMetrics({
    events: [],
    attentionItems: [],
    resolutions: [],
    approvalExecutionPairs: [],
    fidelityTier: 'A',
    ...input,
  });
}

/* ------------------------------------------------------------------ *
 * ACR (north-star)
 * ------------------------------------------------------------------ */

describe('Attention Compression Ratio (ACR)', () => {
  it('is null when there are no interruptions', () => {
    const report = compute({
      events: [agentStarted(), toolStarted(), fileChanged()],
      attentionItems: [],
    });
    expect(report.acr).toBeNull();
    expect(report.counts.classifiableEvents).toBe(3);
    expect(report.counts.humanInterruptions).toBe(0);
  });

  it('computes ACR = classifiable events / human interruptions', () => {
    const events: SupervisorEvent[] = [
      agentStarted(),
      toolStarted(),
      fileChanged(),
      approvalRequested(),
      agentCompleted(),
    ];
    const items = [
      inboxItem('task-1', 'ApprovalRequest', ts(0)),
      inboxItem('task-1', 'Digest', ts(0)),
    ];
    const report = compute({ events, attentionItems: items });
    expect(report.counts.classifiableEvents).toBe(5);
    expect(report.counts.humanInterruptions).toBe(2);
    expect(report.acr).toBe(2.5);
  });

  it('is computable from a stored event window (project/task agnostic)', () => {
    const events = [
      agentStarted({ taskId: 'a', timestamp: ts(0) }),
      agentStarted({ taskId: 'b', timestamp: ts(10) }),
      agentCompleted({ taskId: 'a', timestamp: ts(20) }),
      agentCompleted({ taskId: 'b', timestamp: ts(30) }),
    ];
    const items = [inboxItem('a', 'Digest', ts(20))];
    const report = compute({ events, attentionItems: items });
    expect(report.acr).toBe(4);
  });
});

/* ------------------------------------------------------------------ *
 * Supplemental metric 1: human interventions per agent-hour
 * ------------------------------------------------------------------ */

describe('human interventions per agent-hour', () => {
  it('is null when there are no agent-hours', () => {
    const report = compute({
      events: [approvalRequested()],
      resolutions: [resolution({ resolvedAt: ts(1000) })],
    });
    expect(report.counts.agentHours).toBe(0);
    expect(report.supplemental.humanInterventionsPerAgentHour).toBeNull();
  });

  it('computes interventions / agent-hours from AgentStarted→terminal', () => {
    // Task runs for 1 hour (3_600_000 ms).
    const events = [
      agentStarted({ taskId: 't1', timestamp: ts(0) }),
      agentCompleted({ taskId: 't1', timestamp: ts(3_600_000) }),
    ];
    const resolutions = [
      resolution({ itemId: 'i1', resolvedAt: ts(1000) }),
      resolution({ itemId: 'i2', resolvedAt: ts(2000) }),
    ];
    const report = compute({ events, resolutions });
    expect(report.counts.agentHours).toBeCloseTo(1, 5);
    expect(report.counts.humanInterventions).toBe(2);
    expect(report.supplemental.humanInterventionsPerAgentHour).toBeCloseTo(2, 5);
  });

  it('sums agent-hours across multiple tasks', () => {
    const events = [
      agentStarted({ taskId: 't1', timestamp: ts(0) }),
      agentStarted({ taskId: 't2', timestamp: ts(0) }),
      agentCompleted({ taskId: 't1', timestamp: ts(1_800_000) }),
      agentFailed({ taskId: 't2', timestamp: ts(1_800_000) }),
    ];
    const report = compute({ events, resolutions: [] });
    // 0.5h + 0.5h = 1h
    expect(report.counts.agentHours).toBeCloseTo(1, 5);
  });

  it('counts AgentStopped as a terminal event', () => {
    const events = [
      agentStarted({ taskId: 't1', timestamp: ts(0) }),
      agentStopped({ taskId: 't1', timestamp: ts(3_600_000) }),
    ];
    const report = compute({ events, resolutions: [] });
    expect(report.counts.agentHours).toBeCloseTo(1, 5);
  });
});

/* ------------------------------------------------------------------ *
 * Supplemental metric 2: mean blocked time awaiting developer
 * ------------------------------------------------------------------ */

describe('mean blocked time awaiting developer', () => {
  it('is null when no approvals resolved', () => {
    const report = compute({ resolutions: [] });
    expect(report.supplemental.meanBlockedTimeAwaitingDeveloperMs).toBeNull();
  });

  it('averages resolvedAt - createdAt for ApprovalRequest items', () => {
    const resolutions = [
      resolution({
        itemId: 'a',
        kind: 'ApprovalRequest',
        createdAt: ts(0),
        resolvedAt: ts(10_000),
      }),
      resolution({
        itemId: 'b',
        kind: 'ApprovalRequest',
        createdAt: ts(0),
        resolvedAt: ts(30_000),
      }),
    ];
    const report = compute({ resolutions });
    expect(report.counts.approvalResolutions).toBe(2);
    expect(report.supplemental.meanBlockedTimeAwaitingDeveloperMs).toBe(20_000);
  });

  it('ignores non-ApprovalRequest resolutions', () => {
    const resolutions = [resolution({ kind: 'Digest', createdAt: ts(0), resolvedAt: ts(99_000) })];
    const report = compute({ resolutions });
    expect(report.supplemental.meanBlockedTimeAwaitingDeveloperMs).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Supplemental metric 3: completion-to-review latency
 * ------------------------------------------------------------------ */

describe('completion-to-review latency', () => {
  it('is null when no reviewed Digest items', () => {
    const report = compute({ resolutions: [] });
    expect(report.supplemental.completionToReviewLatencyMs).toBeNull();
  });

  it('uses acknowledgedAt - createdAt when available', () => {
    const resolutions = [
      resolution({
        kind: 'Digest',
        createdAt: ts(0),
        acknowledgedAt: ts(5_000),
        resolvedAt: ts(20_000),
      }),
    ];
    const report = compute({ resolutions });
    expect(report.supplemental.completionToReviewLatencyMs).toBe(5_000);
  });

  it('falls back to resolvedAt - createdAt when no acknowledgedAt', () => {
    const resolutions = [resolution({ kind: 'Digest', createdAt: ts(0), resolvedAt: ts(20_000) })];
    const report = compute({ resolutions });
    expect(report.supplemental.completionToReviewLatencyMs).toBe(20_000);
  });
});

/* ------------------------------------------------------------------ *
 * Supplemental metric 4: minutes of human review per completed task
 * ------------------------------------------------------------------ */

describe('minutes of human review per completed task', () => {
  it('is 0 when no completed tasks', () => {
    const report = compute({ resolutions: [] });
    expect(report.counts.completedTasks).toBe(0);
    expect(report.supplemental.minutesOfHumanReviewPerCompletedTask).toBe(0);
  });

  it('divides total review minutes by completed task count', () => {
    const events = [
      agentCompleted({ taskId: 't1', timestamp: ts(0) }),
      agentCompleted({ taskId: 't2', timestamp: ts(0) }),
    ];
    // Two digest reviews: 6 minutes and 12 minutes of active review.
    const resolutions = [
      resolution({
        kind: 'Digest',
        taskId: 't1',
        createdAt: ts(0),
        acknowledgedAt: ts(0),
        resolvedAt: ts(6 * 60_000),
      }),
      resolution({
        kind: 'Digest',
        taskId: 't2',
        createdAt: ts(0),
        acknowledgedAt: ts(0),
        resolvedAt: ts(12 * 60_000),
      }),
    ];
    const report = compute({ events, resolutions });
    expect(report.counts.completedTasks).toBe(2);
    // (6 + 12) / 2 = 9 minutes
    expect(report.supplemental.minutesOfHumanReviewPerCompletedTask).toBe(9);
  });
});

/* ------------------------------------------------------------------ *
 * Supplemental metric 5: % resolved without opening terminal
 * ------------------------------------------------------------------ */

describe('% resolved without opening terminal', () => {
  it('is null when no resolved items', () => {
    const report = compute({ resolutions: [] });
    expect(report.supplemental.percentResolvedWithoutTerminal).toBeNull();
  });

  it('counts resolved items without openedTerminal', () => {
    const resolutions = [
      resolution({ itemId: 'a', resolvedAt: ts(1), openedTerminal: false }),
      resolution({ itemId: 'b', resolvedAt: ts(2), openedTerminal: true }),
      resolution({ itemId: 'c', resolvedAt: ts(3), openedTerminal: false }),
      // Unresolved items do not count.
      resolution({ itemId: 'd', openedTerminal: false }),
    ];
    const report = compute({ resolutions });
    expect(report.counts.resolvedItems).toBe(3);
    expect(report.counts.resolvedWithoutTerminal).toBe(2);
    expect(report.supplemental.percentResolvedWithoutTerminal).toBeCloseTo((2 / 3) * 100, 5);
  });
});

/* ------------------------------------------------------------------ *
 * Supplemental metric 6: false-negative attention rate
 * ------------------------------------------------------------------ */

describe('false-negative attention rate', () => {
  it('is null when no should-surface events', () => {
    const report = compute({ events: [toolStarted(), fileChanged()] });
    expect(report.counts.shouldSurfaceEvents).toBe(0);
    expect(report.supplemental.falseNegativeAttentionRate).toBeNull();
  });

  it('counts should-surface events without a matching item', () => {
    // Two approval requests; only one has an inbox item.
    const events = [
      approvalRequested({ taskId: 't1', timestamp: ts(0) }),
      approvalRequested({ taskId: 't2', timestamp: ts(10) }),
    ];
    const items = [inboxItem('t1', 'ApprovalRequest', ts(0))];
    const report = compute({ events, attentionItems: items });
    expect(report.counts.shouldSurfaceEvents).toBe(2);
    expect(report.counts.falseNegatives).toBe(1);
    expect(report.supplemental.falseNegativeAttentionRate).toBe(0.5);
  });

  it('is 0 when every should-surface event has an item', () => {
    const events = [
      approvalRequested({ taskId: 't1', timestamp: ts(0) }),
      agentFailed({ taskId: 't1', timestamp: ts(10) }),
    ];
    const items = [inboxItem('t1', 'ApprovalRequest', ts(0)), inboxItem('t1', 'FailedRun', ts(10))];
    const report = compute({ events, attentionItems: items });
    expect(report.counts.falseNegatives).toBe(0);
    expect(report.supplemental.falseNegativeAttentionRate).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Supplemental metric 7: false-positive interruption rate
 * ------------------------------------------------------------------ */

describe('false-positive interruption rate', () => {
  it('is null when no event-sourced items', () => {
    const report = compute({
      attentionItems: [inboxItem('t1', 'DirtyWorktree', ts(0))],
    });
    expect(report.counts.eventSourcedItems).toBe(0);
    expect(report.supplemental.falsePositiveInterruptionRate).toBeNull();
  });

  it('counts event-sourced items with no matching should-surface event', () => {
    // A FailedRun item exists but no AgentFailed event triggered it.
    const events = [agentStarted({ taskId: 't1', timestamp: ts(0) })];
    const items = [inboxItem('t1', 'FailedRun', ts(10)), inboxItem('t1', 'ApprovalRequest', ts(0))];
    // Add an approval event so the ApprovalRequest item is a true positive.
    events.push(approvalRequested({ taskId: 't1', timestamp: ts(0) }));
    const report = compute({ events, attentionItems: items });
    expect(report.counts.eventSourcedItems).toBe(2);
    expect(report.counts.falsePositives).toBe(1);
    expect(report.supplemental.falsePositiveInterruptionRate).toBe(0.5);
  });

  it('excludes non-event-sourced items from the denominator', () => {
    const items = [inboxItem('t1', 'DirtyWorktree', ts(0))];
    const report = compute({ attentionItems: items });
    expect(report.counts.eventSourcedItems).toBe(0);
    expect(report.supplemental.falsePositiveInterruptionRate).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Supplemental metric 8: incorrect approval representation rate (security)
 * ------------------------------------------------------------------ */

describe('incorrect approval representation rate (security-critical)', () => {
  it('is null when no pairs', () => {
    const report = compute({ approvalExecutionPairs: [] });
    expect(report.supplemental.incorrectApprovalRepresentationRate).toBeNull();
  });

  it('is 0 when all approved fields match executed fields', () => {
    const pairs = [pair(), pair({ taskId: 't2' })];
    const report = compute({ approvalExecutionPairs: pairs });
    expect(report.counts.approvalExecutionPairs).toBe(2);
    expect(report.counts.incorrectApprovalRepresentations).toBe(0);
    expect(report.supplemental.incorrectApprovalRepresentationRate).toBe(0);
  });

  it('detects a mismatched capability (must trend to ~zero)', () => {
    const pairs = [
      pair(),
      pair({
        approved: capability({ capability: 'network' }),
        executed: capability({ capability: 'push' }),
      }),
    ];
    const report = compute({ approvalExecutionPairs: pairs });
    expect(report.counts.incorrectApprovalRepresentations).toBe(1);
    expect(report.supplemental.incorrectApprovalRepresentationRate).toBe(0.5);
  });

  it('detects mismatched destination, command, scope, and riskLevel', () => {
    const cases: Array<{ name: string; executed: CapabilityRequest }> = [
      { name: 'destination', executed: capability({ destination: 'evil.com' }) },
      { name: 'command', executed: capability({ command: 'rm -rf /' }) },
      { name: 'workingDir', executed: capability({ workingDir: '/etc' }) },
      { name: 'riskLevel', executed: capability({ riskLevel: 'critical' }) },
      {
        name: 'scope',
        executed: capability({ scope: [{ type: 'network', targets: ['evil.com'] }] }),
      },
      { name: 'task', executed: capability({ task: 'other' }) },
      { name: 'agent', executed: capability({ agent: 'evil-agent' }) },
    ];
    for (const c of cases) {
      const report = compute({
        approvalExecutionPairs: [pair({ approved: capability(), executed: c.executed })],
      });
      expect(report.counts.incorrectApprovalRepresentations, c.name).toBe(1);
      expect(report.supplemental.incorrectApprovalRepresentationRate, c.name).toBe(1);
    }
  });

  it('treats scope order differences as mismatches', () => {
    const pairs = [
      pair({
        approved: capability({
          scope: [
            { type: 'network', targets: ['a.com'] },
            { type: 'network', targets: ['b.com'] },
          ],
        }),
        executed: capability({
          scope: [
            { type: 'network', targets: ['b.com'] },
            { type: 'network', targets: ['a.com'] },
          ],
        }),
      }),
    ];
    const report = compute({ approvalExecutionPairs: pairs });
    expect(report.counts.incorrectApprovalRepresentations).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Determinism & no-LLM guarantee
 * ------------------------------------------------------------------ */

describe('determinism', () => {
  it('returns identical reports for identical inputs', () => {
    const events = [
      agentStarted({ taskId: 't1', timestamp: ts(0) }),
      approvalRequested({ taskId: 't1', timestamp: ts(100) }),
      agentCompleted({ taskId: 't1', timestamp: ts(2000) }),
    ];
    const items = [inboxItem('t1', 'ApprovalRequest', ts(100))];
    const resolutions = [
      resolution({ kind: 'ApprovalRequest', createdAt: ts(100), resolvedAt: ts(500) }),
    ];
    const input = { events, attentionItems: items, resolutions, approvalExecutionPairs: [] };
    const a = computeAttentionMetrics(input);
    const b = computeAttentionMetrics(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('sorts events chronologically before computing', () => {
    const ordered = [
      agentStarted({ taskId: 't1', timestamp: ts(0) }),
      agentCompleted({ taskId: 't1', timestamp: ts(2000) }),
    ];
    const reversed = [ordered[1]!, ordered[0]!];
    const a = computeAttentionMetrics({
      events: ordered,
      attentionItems: [],
      resolutions: [],
      approvalExecutionPairs: [],
    });
    const b = computeAttentionMetrics({
      events: reversed,
      attentionItems: [],
      resolutions: [],
      approvalExecutionPairs: [],
    });
    expect(a.counts.agentHours).toBeCloseTo(b.counts.agentHours, 6);
  });
});

/* ------------------------------------------------------------------ *
 * MetricsQueryService
 * ------------------------------------------------------------------ */

describe('MetricsQueryService', () => {
  it('queries metrics for a time window / project / task', () => {
    const events = [
      agentStarted({ taskId: 't1', timestamp: ts(0) }),
      approvalRequested({ taskId: 't1', timestamp: ts(100) }),
      agentCompleted({ taskId: 't1', timestamp: ts(2000) }),
    ];
    const items = [inboxItem('t1', 'ApprovalRequest', ts(100))];
    const resolutions = [
      resolution({ kind: 'ApprovalRequest', createdAt: ts(100), resolvedAt: ts(500) }),
    ];
    const service = new MetricsQueryService({
      listEvents: (opts) => (opts.taskId === 't1' ? events : events.filter(() => false)),
      listAttentionItems: (opts) => (opts.taskId === 't1' ? items : []),
      listResolutions: (opts) => (opts.taskId === 't1' ? resolutions : []),
      listApprovalExecutionPairs: () => [],
    });

    const report = service.query({ taskId: 't1' });
    expect(report.counts.classifiableEvents).toBe(3);
    expect(report.counts.humanInterruptions).toBe(1);
    expect(report.acr).toBe(3);

    const empty = service.query({ taskId: 'other' });
    expect(empty.counts.classifiableEvents).toBe(0);
    expect(empty.acr).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * MetricsRecorder (event hooks)
 * ------------------------------------------------------------------ */

describe('MetricsRecorder', () => {
  let recorder: MetricsRecorder;

  beforeEach(() => {
    recorder = new MetricsRecorder();
  });

  it('records and lists resolutions filtered by task and time', () => {
    recorder.recordResolution(resolution({ itemId: 'a', taskId: 't1', resolvedAt: ts(100) }));
    recorder.recordResolution(resolution({ itemId: 'b', taskId: 't2', resolvedAt: ts(500) }));

    expect(recorder.listResolutions({ taskId: 't1' })).toHaveLength(1);
    expect(recorder.listResolutions({ since: ts(200), until: ts(600) })).toHaveLength(1);
    expect(recorder.listResolutions()).toHaveLength(2);
  });

  it('records and lists approval-execution pairs filtered by task and time', () => {
    recorder.recordApprovalExecution(pair({ taskId: 't1', timestamp: ts(100) }));
    recorder.recordApprovalExecution(pair({ taskId: 't2', timestamp: ts(500) }));

    expect(recorder.listApprovalExecutionPairs({ taskId: 't2' })).toHaveLength(1);
    expect(recorder.listApprovalExecutionPairs({ since: ts(200) })).toHaveLength(1);
  });

  it('reset clears all recorded datapoints', () => {
    recorder.recordResolution(resolution());
    recorder.recordApprovalExecution(pair());
    recorder.reset();
    expect(recorder.listResolutions()).toHaveLength(0);
    expect(recorder.listApprovalExecutionPairs()).toHaveLength(0);
  });

  it('can serve as a MetricsQueryService source', () => {
    recorder.recordResolution(
      resolution({ kind: 'ApprovalRequest', createdAt: ts(0), resolvedAt: ts(1000) }),
    );
    const service = new MetricsQueryService({
      listEvents: () => [approvalRequested({ timestamp: ts(0) })],
      listAttentionItems: () => [inboxItem('task-1', 'ApprovalRequest', ts(0))],
      listResolutions: (opts) => recorder.listResolutions(opts),
      listApprovalExecutionPairs: (opts) => recorder.listApprovalExecutionPairs(opts),
    });
    const report = service.query({});
    expect(report.counts.classifiableEvents).toBe(1);
    expect(report.supplemental.meanBlockedTimeAwaitingDeveloperMs).toBe(1000);
  });
});
