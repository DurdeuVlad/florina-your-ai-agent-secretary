import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { EventBus } from '../src/daemon/event-stream.js';
import {
  MetricsCollector,
  checkSupervisionCostDiscipline,
  type MetricsSnapshot,
} from '../src/daemon/metrics.js';
import { StorageDatabase, MetricsRepository } from '../src/storage/index.js';
import type {
  AgentStartedEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStoppedEvent,
  ApprovalRequestedEvent,
  ToolStartedEvent,
  ToolFinishedEvent,
  AgentProgressEvent,
} from '../src/domain/events.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

/** Common envelope shared by every test event. */
const base = {
  timestamp: '2026-08-19T12:00:00.000Z',
  taskId: 'task-42',
  sessionId: 'sess-7',
  agentId: 'codex',
  adapterFidelityTier: 'A' as const,
};

function agentStarted(overrides: Partial<AgentStartedEvent> = {}): AgentStartedEvent {
  return {
    ...base,
    type: 'AgentStarted',
    objective: 'Test task',
    workingDir: '/repo',
    ...overrides,
  };
}

function agentCompleted(overrides: Partial<AgentCompletedEvent> = {}): AgentCompletedEvent {
  return {
    ...base,
    type: 'AgentCompleted',
    summary: 'Done',
    deliverables: [],
    ...overrides,
  };
}

function agentFailed(overrides: Partial<AgentFailedEvent> = {}): AgentFailedEvent {
  return {
    ...base,
    type: 'AgentFailed',
    error: 'Crashed',
    recoverable: true,
    ...overrides,
  };
}

function agentStopped(overrides: Partial<AgentStoppedEvent> = {}): AgentStoppedEvent {
  return {
    ...base,
    type: 'AgentStopped',
    reason: 'user',
    ...overrides,
  };
}

function approvalRequested(
  overrides: Partial<ApprovalRequestedEvent> = {},
): ApprovalRequestedEvent {
  return {
    ...base,
    type: 'ApprovalRequested',
    task: 'Test task',
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

function toolStarted(
  toolName: string,
  overrides: Partial<ToolStartedEvent> = {},
): ToolStartedEvent {
  return {
    ...base,
    type: 'ToolStarted',
    toolName,
    ...overrides,
  };
}

function toolFinished(
  toolName: string,
  overrides: Partial<ToolFinishedEvent> = {},
): ToolFinishedEvent {
  return {
    ...base,
    type: 'ToolFinished',
    toolName,
    success: true,
    ...overrides,
  };
}

function progressEvent(overrides: Partial<AgentProgressEvent> = {}): AgentProgressEvent {
  return {
    ...base,
    type: 'AgentProgress',
    message: 'Working...',
    ...overrides,
  };
}

/** ISO timestamp at a given millisecond offset from the base time. */
function ts(offsetMs: number): string {
  return new Date(Date.parse(base.timestamp) + offsetMs).toISOString();
}

/* ------------------------------------------------------------------ *
 * MetricsCollector
 * ------------------------------------------------------------------ */

describe('MetricsCollector', () => {
  let bus: EventBus;
  let collector: MetricsCollector;

  beforeEach(() => {
    bus = new EventBus();
    collector = new MetricsCollector();
    collector.attach(bus);
  });

  afterEach(() => {
    collector.detach();
  });

  describe('counters', () => {
    it('increments eventsEmitted by event type', () => {
      bus.publish(agentStarted());
      bus.publish(progressEvent());
      bus.publish(agentStarted({ taskId: 'task-43' }));

      const snap = collector.snapshot();
      expect(snap.counters.eventsEmitted['AgentStarted']).toBe(2);
      expect(snap.counters.eventsEmitted['AgentProgress']).toBe(1);
    });

    it('increments tasksStarted on AgentStarted', () => {
      bus.publish(agentStarted());
      bus.publish(agentStarted({ taskId: 'task-43' }));
      expect(collector.snapshot().counters.tasksStarted).toBe(2);
    });

    it('increments tasksCompleted on AgentCompleted', () => {
      bus.publish(agentStarted());
      bus.publish(agentCompleted());
      expect(collector.snapshot().counters.tasksCompleted).toBe(1);
    });

    it('increments tasksFailed on AgentFailed', () => {
      bus.publish(agentStarted());
      bus.publish(agentFailed());
      expect(collector.snapshot().counters.tasksFailed).toBe(1);
    });

    it('increments approvalsRequested on ApprovalRequested', () => {
      bus.publish(approvalRequested());
      expect(collector.snapshot().counters.approvalsRequested).toBe(1);
    });

    it('increments approvalsGranted via recordApprovalGranted', () => {
      bus.publish(approvalRequested());
      collector.recordApprovalGranted('task-42');
      expect(collector.snapshot().counters.approvalsGranted).toBe(1);
    });

    it('increments approvalsDenied via recordApprovalDenied', () => {
      bus.publish(approvalRequested());
      collector.recordApprovalDenied('task-42');
      expect(collector.snapshot().counters.approvalsDenied).toBe(1);
    });

    it('increments toolsInvoked by tool name on ToolStarted', () => {
      bus.publish(toolStarted('shell'));
      bus.publish(toolStarted('shell'));
      bus.publish(toolStarted('editor'));
      const tools = collector.snapshot().counters.toolsInvoked;
      expect(tools['shell']).toBe(2);
      expect(tools['editor']).toBe(1);
    });
  });

  describe('gauges', () => {
    it('tracks activeSessions across start/complete', () => {
      bus.publish(agentStarted({ taskId: 't1' }));
      bus.publish(agentStarted({ taskId: 't2' }));
      expect(collector.snapshot().gauges.activeSessions).toBe(2);

      bus.publish(agentCompleted({ taskId: 't1' }));
      expect(collector.snapshot().gauges.activeSessions).toBe(1);
    });

    it('decrements activeSessions on AgentFailed', () => {
      bus.publish(agentStarted());
      bus.publish(agentFailed());
      expect(collector.snapshot().gauges.activeSessions).toBe(0);
    });

    it('decrements activeSessions on AgentStopped', () => {
      bus.publish(agentStarted());
      bus.publish(agentStopped());
      expect(collector.snapshot().gauges.activeSessions).toBe(0);
    });

    it('never lets activeSessions go negative', () => {
      bus.publish(agentCompleted());
      expect(collector.snapshot().gauges.activeSessions).toBe(0);
    });

    it('tracks pendingApprovals across request/grant', () => {
      bus.publish(approvalRequested({ taskId: 't1' }));
      bus.publish(approvalRequested({ taskId: 't2' }));
      expect(collector.snapshot().gauges.pendingApprovals).toBe(2);

      collector.recordApprovalGranted('t1');
      expect(collector.snapshot().gauges.pendingApprovals).toBe(1);
    });

    it('decrements pendingApprovals on deny', () => {
      bus.publish(approvalRequested());
      collector.recordApprovalDenied('task-42');
      expect(collector.snapshot().gauges.pendingApprovals).toBe(0);
    });

    it('reads inboxSize and attentionItemsPending from providers', () => {
      let inbox = 0;
      let pending = 0;
      const c = new MetricsCollector({
        inboxSizeProvider: () => inbox,
        attentionItemsPendingProvider: () => pending,
      });
      c.attach(bus);
      inbox = 5;
      pending = 3;
      const snap = c.snapshot();
      expect(snap.gauges.inboxSize).toBe(5);
      expect(snap.gauges.attentionItemsPending).toBe(3);
      c.detach();
    });

    it('defaults inboxSize and attentionItemsPending to 0 without providers', () => {
      const snap = collector.snapshot();
      expect(snap.gauges.inboxSize).toBe(0);
      expect(snap.gauges.attentionItemsPending).toBe(0);
    });
  });

  describe('histograms', () => {
    it('records taskDuration from AgentStarted to AgentCompleted', () => {
      bus.publish(agentStarted({ taskId: 't1', timestamp: ts(0) }));
      bus.publish(agentCompleted({ taskId: 't1', timestamp: ts(5000) }));

      const h = collector.snapshot().histograms.taskDuration;
      expect(h.count).toBe(1);
      expect(h.sum).toBe(5000);
      expect(h.min).toBe(5000);
      expect(h.max).toBe(5000);
    });

    it('records taskDuration on AgentFailed (edge case)', () => {
      bus.publish(agentStarted({ taskId: 't1', timestamp: ts(0) }));
      bus.publish(agentFailed({ taskId: 't1', timestamp: ts(2000) }));

      const h = collector.snapshot().histograms.taskDuration;
      expect(h.count).toBe(1);
      expect(h.sum).toBe(2000);
    });

    it('records approvalResponseTime from ApprovalRequested to grant', () => {
      let clock = 1000;
      const c = new MetricsCollector({ now: () => clock });
      c.attach(bus);
      bus.publish(approvalRequested({ taskId: 't1', timestamp: ts(0) }));
      clock = 4000;
      c.recordApprovalGranted('t1');

      const h = c.snapshot().histograms.approvalResponseTime;
      expect(h.count).toBe(1);
      expect(h.sum).toBe(3000);
      c.detach();
    });

    it('records approvalResponseTime from ApprovalRequested to deny', () => {
      let clock = 1000;
      const c = new MetricsCollector({ now: () => clock });
      c.attach(bus);
      bus.publish(approvalRequested({ taskId: 't1', timestamp: ts(0) }));
      clock = 2500;
      c.recordApprovalDenied('t1');

      const h = c.snapshot().histograms.approvalResponseTime;
      expect(h.count).toBe(1);
      expect(h.sum).toBe(1500);
      c.detach();
    });

    it('records toolDuration from ToolStarted to ToolFinished', () => {
      bus.publish(toolStarted('shell', { timestamp: ts(0) }));
      bus.publish(toolFinished('shell', { timestamp: ts(1200) }));

      const h = collector.snapshot().histograms.toolDuration;
      expect(h.count).toBe(1);
      expect(h.sum).toBe(1200);
    });

    it('tracks tool durations per session+tool independently', () => {
      bus.publish(toolStarted('shell', { sessionId: 's1', timestamp: ts(0) }));
      bus.publish(toolStarted('shell', { sessionId: 's2', timestamp: ts(0) }));
      bus.publish(toolFinished('shell', { sessionId: 's1', timestamp: ts(100) }));
      bus.publish(toolFinished('shell', { sessionId: 's2', timestamp: ts(200) }));

      const h = collector.snapshot().histograms.toolDuration;
      expect(h.count).toBe(2);
      expect(h.sum).toBe(300);
    });

    it('populates cumulative buckets', () => {
      bus.publish(agentStarted({ taskId: 't1', timestamp: ts(0) }));
      bus.publish(agentCompleted({ taskId: 't1', timestamp: ts(500) }));

      const h = collector.snapshot().histograms.taskDuration;
      expect(h.count).toBe(1);
      // 500ms falls in the <=500 bucket and all higher cumulative buckets.
      expect(h.buckets['100']).toBe(0);
      expect(h.buckets['500']).toBe(1);
      expect(h.buckets['1000']).toBe(1);
      expect(h.buckets['+Inf']).toBe(1);
    });

    it('does not record duration when events arrive out of order', () => {
      // AgentCompleted before AgentStarted — no start timestamp recorded.
      bus.publish(agentCompleted({ taskId: 't1', timestamp: ts(5000) }));
      bus.publish(agentStarted({ taskId: 't1', timestamp: ts(0) }));

      const h = collector.snapshot().histograms.taskDuration;
      expect(h.count).toBe(0);
    });

    it('does not record toolDuration when ToolFinished has no matching start', () => {
      bus.publish(toolFinished('shell', { timestamp: ts(100) }));
      expect(collector.snapshot().histograms.toolDuration.count).toBe(0);
    });
  });

  describe('snapshot()', () => {
    it('returns a serializable snapshot capturing all metrics', () => {
      bus.publish(agentStarted({ taskId: 't1', timestamp: ts(0) }));
      bus.publish(approvalRequested({ taskId: 't1', timestamp: ts(100) }));
      bus.publish(toolStarted('shell', { timestamp: ts(200) }));
      bus.publish(toolFinished('shell', { timestamp: ts(300) }));
      collector.recordApprovalDenied('t1');
      bus.publish(agentFailed({ taskId: 't1', timestamp: ts(1000) }));

      const snap = collector.snapshot();

      // Must be JSON-serializable.
      const json = JSON.stringify(snap);
      const roundTrip = JSON.parse(json) as MetricsSnapshot;
      expect(roundTrip.counters.tasksStarted).toBe(1);
      expect(roundTrip.counters.tasksFailed).toBe(1);
      expect(roundTrip.counters.approvalsDenied).toBe(1);
      expect(roundTrip.gauges.activeSessions).toBe(0);
      expect(roundTrip.histograms.toolDuration.count).toBe(1);
      expect(roundTrip.histograms.taskDuration.count).toBe(1);
      expect(typeof snap.timestamp).toBe('string');
    });

    it('snapshot is a deep copy (mutating JSON does not affect collector)', () => {
      bus.publish(agentStarted());
      const snap = collector.snapshot();
      const mutated = snap.counters.eventsEmitted as Record<string, number>;
      mutated['AgentStarted'] = 999;

      const fresh = collector.snapshot();
      expect(fresh.counters.eventsEmitted['AgentStarted']).toBe(1);
    });
  });

  describe('reset()', () => {
    it('clears all metrics', () => {
      bus.publish(agentStarted());
      bus.publish(approvalRequested());
      bus.publish(toolStarted('shell'));
      collector.recordApprovalGranted('task-42');

      collector.reset();
      const snap = collector.snapshot();

      expect(snap.counters.tasksStarted).toBe(0);
      expect(snap.counters.approvalsRequested).toBe(0);
      expect(snap.counters.approvalsGranted).toBe(0);
      expect(snap.counters.toolsInvoked['shell']).toBeUndefined();
      expect(snap.gauges.activeSessions).toBe(0);
      expect(snap.gauges.pendingApprovals).toBe(0);
      expect(snap.histograms.taskDuration.count).toBe(0);
      expect(snap.histograms.approvalResponseTime.count).toBe(0);
      expect(snap.histograms.toolDuration.count).toBe(0);
    });

    it('allows collecting fresh metrics after reset', () => {
      bus.publish(agentStarted());
      collector.reset();
      bus.publish(agentStarted({ taskId: 't2' }));
      const snap = collector.snapshot();
      expect(snap.counters.tasksStarted).toBe(1);
      expect(snap.gauges.activeSessions).toBe(1);
    });
  });

  describe('attach/detach', () => {
    it('stops collecting after detach', () => {
      collector.detach();
      bus.publish(agentStarted());
      expect(collector.snapshot().counters.tasksStarted).toBe(0);
    });

    it('reattaches to a new bus', () => {
      collector.detach();
      const bus2 = new EventBus();
      collector.attach(bus2);
      bus2.publish(agentStarted());
      expect(collector.snapshot().counters.tasksStarted).toBe(1);
      collector.detach();
    });
  });

  describe('supervision cost (§7, issue #203)', () => {
    it('recordSupervisionStage increments both the by-stage and by-task counters', () => {
      collector.recordSupervisionStage('l1-classification', 'task-1');
      collector.recordSupervisionStage('l1-classification', 'task-2');
      collector.recordSupervisionStage('execution-brief-compile', 'task-1');

      const snap = collector.snapshot();
      expect(snap.supervisionCost.modelCallsByStage['l1-classification']).toBe(2);
      expect(snap.supervisionCost.modelCallsByStage['execution-brief-compile']).toBe(1);
      expect(snap.supervisionCost.modelCallsByStage['l2-manager-reasoning']).toBe(0);
      expect(snap.supervisionCost.modelCallsByStage['l3-florina-reasoning']).toBe(0);
      expect(snap.supervisionCost.modelCallsByTask['task-1']).toBe(2);
      expect(snap.supervisionCost.modelCallsByTask['task-2']).toBe(1);
    });

    it('every stage key is present even at 0 (not silently missing)', () => {
      const snap = collector.snapshot();
      expect(Object.keys(snap.supervisionCost.modelCallsByStage).sort()).toEqual(
        ['execution-brief-compile', 'l1-classification', 'l2-manager-reasoning', 'l3-florina-reasoning'].sort(),
      );
    });

    it('reset() clears supervision-cost counters', () => {
      collector.recordSupervisionStage('l1-classification', 'task-1');
      collector.reset();
      const snap = collector.snapshot();
      expect(snap.supervisionCost.modelCallsByStage['l1-classification']).toBe(0);
      expect(snap.supervisionCost.modelCallsByTask).toEqual({});
    });
  });
});

/* ------------------------------------------------------------------ *
 * checkSupervisionCostDiscipline (§7, issue #203)
 * ------------------------------------------------------------------ */

describe('checkSupervisionCostDiscipline', () => {
  function snapshotWith(eventsEmitted: Record<string, number>, l1Calls: number): MetricsSnapshot {
    return {
      timestamp: '2026-09-21T00:00:00.000Z',
      counters: {
        eventsEmitted,
        tasksStarted: 0,
        tasksCompleted: 0,
        tasksFailed: 0,
        approvalsRequested: 0,
        approvalsGranted: 0,
        approvalsDenied: 0,
        toolsInvoked: {},
        contextHealthByStatus: {},
      },
      gauges: { activeSessions: 0, pendingApprovals: 0, inboxSize: 0, attentionItemsPending: 0 },
      histograms: {
        taskDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
        approvalResponseTime: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
        toolDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
      },
      supervisionCost: {
        modelCallsByStage: {
          'l1-classification': l1Calls,
          'execution-brief-compile': 0,
          'l2-manager-reasoning': 0,
          'l3-florina-reasoning': 0,
        },
        modelCallsByTask: {},
      },
    };
  }

  it('passes when L1 calls are a subset of total events', () => {
    const check = checkSupervisionCostDiscipline(snapshotWith({ AgentStarted: 10, ToolStarted: 5 }, 3));
    expect(check.ok).toBe(true);
  });

  it('passes at the boundary — L1 calls equal to total events', () => {
    const check = checkSupervisionCostDiscipline(snapshotWith({ AgentStarted: 5 }, 5));
    expect(check.ok).toBe(true);
  });

  it('fails when L1 calls exceed total events emitted', () => {
    const check = checkSupervisionCostDiscipline(snapshotWith({ AgentStarted: 5 }, 6));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('exceed total events emitted');
  });

  it('fails when there are L1 calls but zero events emitted at all', () => {
    const check = checkSupervisionCostDiscipline(snapshotWith({}, 1));
    expect(check.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * MetricsRepository (SQLite persistence)
 * ------------------------------------------------------------------ */

describe('MetricsRepository', () => {
  let db: StorageDatabase;
  let repo: MetricsRepository;

  beforeEach(() => {
    db = new StorageDatabase({ path: ':memory:' });
    db.open();
    repo = new MetricsRepository(db.connection);
  });

  afterEach(() => {
    db.close();
  });

  it('saves and retrieves a snapshot', () => {
    const snap: MetricsSnapshot = {
      timestamp: '2026-08-19T12:00:00.000Z',
      counters: {
        eventsEmitted: { AgentStarted: 1 },
        tasksStarted: 1,
        tasksCompleted: 0,
        tasksFailed: 0,
        approvalsRequested: 0,
        approvalsGranted: 0,
        approvalsDenied: 0,
        toolsInvoked: {},
      },
      gauges: {
        activeSessions: 1,
        pendingApprovals: 0,
        inboxSize: 3,
        attentionItemsPending: 2,
      },
      histograms: {
        taskDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
        approvalResponseTime: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
        toolDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
      },
    };

    const id = repo.saveSnapshot(snap);
    expect(id).toBeGreaterThan(0);

    const latest = repo.getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(id);
    expect(latest!.snapshot.counters.tasksStarted).toBe(1);
    expect(latest!.snapshot.gauges.inboxSize).toBe(3);
  });

  it('getLatestSnapshot returns null when empty', () => {
    expect(repo.getLatestSnapshot()).toBeNull();
  });

  it('lists snapshots in chronological order', () => {
    const snap1 = makeSnapshot('2026-08-19T12:00:00.000Z', 1);
    const snap2 = makeSnapshot('2026-08-19T12:01:00.000Z', 2);
    const snap3 = makeSnapshot('2026-08-19T12:02:00.000Z', 3);
    repo.saveSnapshot(snap1);
    repo.saveSnapshot(snap2);
    repo.saveSnapshot(snap3);

    const all = repo.listSnapshots();
    expect(all).toHaveLength(3);
    expect(all[0].snapshot.counters.tasksStarted).toBe(1);
    expect(all[2].snapshot.counters.tasksStarted).toBe(3);
  });

  it('filters snapshots by since timestamp', () => {
    repo.saveSnapshot(makeSnapshot('2026-08-19T12:00:00.000Z', 1));
    repo.saveSnapshot(makeSnapshot('2026-08-19T12:01:00.000Z', 2));
    repo.saveSnapshot(makeSnapshot('2026-08-19T12:02:00.000Z', 3));

    const filtered = repo.listSnapshots({ since: '2026-08-19T12:01:00.000Z' });
    expect(filtered).toHaveLength(2);
    expect(filtered[0].snapshot.counters.tasksStarted).toBe(2);
  });

  it('respects the limit option', () => {
    repo.saveSnapshot(makeSnapshot('2026-08-19T12:00:00.000Z', 1));
    repo.saveSnapshot(makeSnapshot('2026-08-19T12:01:00.000Z', 2));
    repo.saveSnapshot(makeSnapshot('2026-08-19T12:02:00.000Z', 3));

    const limited = repo.listSnapshots({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('getLatestSnapshot returns the most recent by id', () => {
    repo.saveSnapshot(makeSnapshot('2026-08-19T12:00:00.000Z', 1));
    repo.saveSnapshot(makeSnapshot('2026-08-19T12:01:00.000Z', 2));

    const latest = repo.getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(latest!.snapshot.counters.tasksStarted).toBe(2);
  });

  it('round-trips a snapshot from a real MetricsCollector', () => {
    const bus = new EventBus();
    const collector = new MetricsCollector();
    collector.attach(bus);
    bus.publish(agentStarted({ taskId: 't1', timestamp: ts(0) }));
    bus.publish(agentCompleted({ taskId: 't1', timestamp: ts(3000) }));
    const snap = collector.snapshot();
    collector.detach();

    repo.saveSnapshot(snap);
    const latest = repo.getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(latest!.snapshot.histograms.taskDuration.count).toBe(1);
    expect(latest!.snapshot.histograms.taskDuration.sum).toBe(3000);
  });
});

/** Build a minimal snapshot with a given timestamp and tasksStarted value. */
function makeSnapshot(timestamp: string, tasksStarted: number): MetricsSnapshot {
  return {
    timestamp,
    counters: {
      eventsEmitted: { AgentStarted: tasksStarted },
      tasksStarted,
      tasksCompleted: 0,
      tasksFailed: 0,
      approvalsRequested: 0,
      approvalsGranted: 0,
      approvalsDenied: 0,
      toolsInvoked: {},
    },
    gauges: {
      activeSessions: 0,
      pendingApprovals: 0,
      inboxSize: 0,
      attentionItemsPending: 0,
    },
    histograms: {
      taskDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
      approvalResponseTime: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
      toolDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
    },
  };
}
