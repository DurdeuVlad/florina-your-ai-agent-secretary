import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  AttentionInbox,
  type AttentionInboxFilter,
  type AttentionInboxSnapshot,
} from '../src/attention/attention-inbox.js';
import {
  AttentionAggregator,
  riskLevelToPriority,
  DEFAULT_DEDUP_WINDOW_MS,
} from '../src/attention/attention-aggregator.js';
import {
  createAttentionItem,
  compareAttentionItems,
  PRIORITY_RANK,
  type AttentionItem,
  type AttentionItemPriority,
} from '../src/attention/attention-item.js';
import { EventBus } from '../src/daemon/event-stream.js';
import type {
  ApprovalRequestedEvent,
  AgentFailedEvent,
  AgentCompletedEvent,
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

/** Build an ApprovalRequested event with the given capability and risk. */
function approvalEvent(
  riskLevel: string,
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
    riskLevel: riskLevel as ApprovalRequestedEvent['riskLevel'],
    ...overrides,
  };
}

/** Build an AgentFailed event. */
function failedEvent(overrides: Partial<AgentFailedEvent> = {}): AgentFailedEvent {
  return {
    ...base,
    type: 'AgentFailed',
    error: 'Non-zero exit code',
    recoverable: true,
    ...overrides,
  };
}

/** Build an AgentCompleted event. */
function completedEvent(overrides: Partial<AgentCompletedEvent> = {}): AgentCompletedEvent {
  return {
    ...base,
    type: 'AgentCompleted',
    summary: 'Task done',
    deliverables: [{ type: 'commit', ref: 'abc123' }],
    exitCode: 0,
    ...overrides,
  };
}

/** Build an attention item with explicit id and createdAt for deterministic tests. */
function item(
  id: string,
  priority: AttentionItemPriority,
  createdAt: string,
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  return createAttentionItem({
    id,
    taskId: overrides.taskId ?? 'task-42',
    kind: overrides.kind ?? 'Custom',
    priority,
    createdAt,
    payload: overrides.payload,
    status: overrides.status,
  });
}

/* ------------------------------------------------------------------ *
 * AttentionItem
 * ------------------------------------------------------------------ */

describe('AttentionItem', () => {
  it('creates an item with sensible defaults', () => {
    const it_ = createAttentionItem({
      taskId: 'task-1',
      kind: 'FailedRun',
      priority: 'High',
    });
    expect(it_.taskId).toBe('task-1');
    expect(it_.kind).toBe('FailedRun');
    expect(it_.priority).toBe('High');
    expect(it_.status).toBe('Pending');
    expect(it_.payload).toEqual({});
    expect(it_.id).toMatch(/^attn_/);
    expect(it_.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respects explicit overrides', () => {
    const it_ = createAttentionItem({
      id: 'custom-id',
      taskId: 'task-1',
      kind: 'ApprovalRequest',
      priority: 'Critical',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      payload: { foo: 'bar' },
      status: 'Acknowledged',
    });
    expect(it_.id).toBe('custom-id');
    expect(it_.expiresAt).toBe('2026-01-02T00:00:00.000Z');
    expect(it_.payload).toEqual({ foo: 'bar' });
    expect(it_.status).toBe('Acknowledged');
  });

  it('PRIORITY_RANK orders Critical > High > Medium > Low', () => {
    expect(PRIORITY_RANK.Critical).toBeGreaterThan(PRIORITY_RANK.High);
    expect(PRIORITY_RANK.High).toBeGreaterThan(PRIORITY_RANK.Medium);
    expect(PRIORITY_RANK.Medium).toBeGreaterThan(PRIORITY_RANK.Low);
  });

  describe('compareAttentionItems', () => {
    it('orders by priority descending (Critical first)', () => {
      const low = item('1', 'Low', '2026-01-01T00:00:00.000Z');
      const crit = item('2', 'Critical', '2026-01-01T00:00:00.000Z');
      const high = item('3', 'High', '2026-01-01T00:00:00.000Z');
      const med = item('4', 'Medium', '2026-01-01T00:00:00.000Z');
      const sorted = [low, crit, high, med].sort(compareAttentionItems);
      expect(sorted.map((i) => i.priority)).toEqual(['Critical', 'High', 'Medium', 'Low']);
    });

    it('breaks ties by createdAt ascending (FIFO within same priority)', () => {
      const early = item('1', 'High', '2026-01-01T00:00:00.000Z');
      const late = item('2', 'High', '2026-01-02T00:00:00.000Z');
      const sorted = [late, early].sort(compareAttentionItems);
      expect(sorted[0].id).toBe('1');
      expect(sorted[1].id).toBe('2');
    });

    it('is stable when priority and createdAt are equal (id tie-break)', () => {
      const a = item('aaa', 'High', '2026-01-01T00:00:00.000Z');
      const b = item('bbb', 'High', '2026-01-01T00:00:00.000Z');
      const sorted = [b, a].sort(compareAttentionItems);
      expect(sorted[0].id).toBe('aaa');
      expect(sorted[1].id).toBe('bbb');
    });
  });
});

/* ------------------------------------------------------------------ *
 * AttentionInbox
 * ------------------------------------------------------------------ */

describe('AttentionInbox', () => {
  let inbox: AttentionInbox;

  beforeEach(() => {
    inbox = new AttentionInbox();
  });

  describe('add / size / pendingCount', () => {
    it('starts empty', () => {
      expect(inbox.size).toBe(0);
      expect(inbox.pendingCount).toBe(0);
    });

    it('adds items and tracks size', () => {
      inbox.add(item('1', 'Low', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('2', 'High', '2026-01-01T00:00:00.000Z'));
      expect(inbox.size).toBe(2);
      expect(inbox.pendingCount).toBe(2);
    });

    it('replaces an item with the same id', () => {
      inbox.add(item('1', 'Low', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('1', 'Critical', '2026-01-01T00:00:00.000Z'));
      expect(inbox.size).toBe(1);
      expect(inbox.peek()?.priority).toBe('Critical');
    });
  });

  describe('priority ordering (peek / take)', () => {
    it('peek returns the highest-priority Pending item', () => {
      inbox.add(item('1', 'Low', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('2', 'Critical', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('3', 'High', '2026-01-01T00:00:00.000Z'));
      expect(inbox.peek()?.id).toBe('2');
    });

    it('take returns and removes the highest-priority Pending item', () => {
      inbox.add(item('1', 'Low', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('2', 'Critical', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('3', 'High', '2026-01-01T00:00:00.000Z'));
      const taken = inbox.take();
      expect(taken?.id).toBe('2');
      expect(inbox.size).toBe(2);
      expect(inbox.peek()?.id).toBe('3');
    });

    it('drains in priority then FIFO order', () => {
      inbox.add(item('low-1', 'Low', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('crit-1', 'Critical', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('high-1', 'High', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('crit-2', 'Critical', '2026-01-02T00:00:00.000Z'));
      inbox.add(item('high-2', 'High', '2026-01-02T00:00:00.000Z'));
      const order: string[] = [];
      while (inbox.pendingCount > 0) {
        const i = inbox.take();
        order.push(i!.id);
      }
      // Critical first (FIFO), then High (FIFO), then Low.
      expect(order).toEqual(['crit-1', 'crit-2', 'high-1', 'high-2', 'low-1']);
    });

    it('peek/take skip non-Pending items', () => {
      const pending = item('1', 'Low', '2026-01-01T00:00:00.000Z');
      const acked = item('2', 'Critical', '2026-01-01T00:00:00.000Z', {
        status: 'Acknowledged',
      });
      inbox.add(pending);
      inbox.add(acked);
      // Critical item is Acknowledged, so the Low Pending item wins.
      expect(inbox.peek()?.id).toBe('1');
      expect(inbox.take()?.id).toBe('1');
    });

    it('peek/take return undefined when no Pending items remain', () => {
      expect(inbox.peek()).toBeUndefined();
      expect(inbox.take()).toBeUndefined();
      inbox.add(item('1', 'High', '2026-01-01T00:00:00.000Z', { status: 'Resolved' }));
      expect(inbox.peek()).toBeUndefined();
      expect(inbox.take()).toBeUndefined();
    });
  });

  describe('FIFO within same priority', () => {
    it('returns earlier createdAt first when priorities are equal', () => {
      inbox.add(item('late', 'High', '2026-01-02T00:00:00.000Z'));
      inbox.add(item('early', 'High', '2026-01-01T00:00:00.000Z'));
      expect(inbox.take()?.id).toBe('early');
      expect(inbox.take()?.id).toBe('late');
    });
  });

  describe('acknowledge', () => {
    it('marks an item as Acknowledged', () => {
      inbox.add(item('1', 'High', '2026-01-01T00:00:00.000Z'));
      expect(inbox.acknowledge('1')).toBe(true);
      const found = inbox.list().find((i) => i.id === '1');
      expect(found?.status).toBe('Acknowledged');
      expect(inbox.pendingCount).toBe(0);
    });

    it('still visible in list after acknowledge', () => {
      inbox.add(item('1', 'High', '2026-01-01T00:00:00.000Z'));
      inbox.acknowledge('1');
      expect(inbox.size).toBe(1);
      expect(inbox.list().length).toBe(1);
    });

    it('returns false for unknown id', () => {
      expect(inbox.acknowledge('nope')).toBe(false);
    });
  });

  describe('resolve', () => {
    it('marks an item as Resolved', () => {
      inbox.add(item('1', 'High', '2026-01-01T00:00:00.000Z'));
      expect(inbox.resolve('1')).toBe(true);
      const found = inbox.list().find((i) => i.id === '1');
      expect(found?.status).toBe('Resolved');
      expect(inbox.pendingCount).toBe(0);
    });

    it('resolved items are not returned by take', () => {
      inbox.add(item('1', 'Critical', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('2', 'Low', '2026-01-01T00:00:00.000Z'));
      inbox.resolve('1');
      expect(inbox.take()?.id).toBe('2');
    });

    it('returns false for unknown id', () => {
      expect(inbox.resolve('nope')).toBe(false);
    });
  });

  describe('escalate', () => {
    it('boosts priority to Critical and status to Escalated', () => {
      inbox.add(item('1', 'Low', '2026-01-01T00:00:00.000Z'));
      expect(inbox.escalate('1')).toBe(true);
      const found = inbox.list().find((i) => i.id === '1');
      expect(found?.priority).toBe('Critical');
      expect(found?.status).toBe('Escalated');
    });

    it('escalated item jumps to the front of the queue', () => {
      inbox.add(item('low', 'Low', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('high', 'High', '2026-01-01T00:00:00.000Z'));
      inbox.escalate('low');
      expect(inbox.take()?.id).toBe('low');
    });

    it('returns false for unknown id', () => {
      expect(inbox.escalate('nope')).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes an item entirely', () => {
      inbox.add(item('1', 'High', '2026-01-01T00:00:00.000Z'));
      expect(inbox.remove('1')).toBe(true);
      expect(inbox.size).toBe(0);
    });

    it('returns false for unknown id', () => {
      expect(inbox.remove('nope')).toBe(false);
    });
  });

  describe('list with filters', () => {
    beforeEach(() => {
      inbox.add(item('1', 'Critical', '2026-01-01T00:00:00.000Z', { kind: 'ApprovalRequest' }));
      inbox.add(item('2', 'High', '2026-01-01T00:00:00.000Z', { kind: 'FailedRun' }));
      inbox.add(item('3', 'Medium', '2026-01-01T00:00:00.000Z', { kind: 'FailedRun' }));
      inbox.add(
        item('4', 'Low', '2026-01-01T00:00:00.000Z', {
          kind: 'Digest',
          taskId: 'task-99',
        }),
      );
      inbox.add(
        item('5', 'High', '2026-01-01T00:00:00.000Z', {
          kind: 'ApprovalRequest',
          status: 'Acknowledged',
        }),
      );
    });

    it('returns all items ordered by priority when no filter', () => {
      const all = inbox.list();
      // Critical(1) > High: id tie-break '2' < '5' (2,5) > Medium(3) > Low(4)
      expect(all.map((i) => i.id)).toEqual(['1', '2', '5', '3', '4']);
    });

    it('filters by status', () => {
      const filter: AttentionInboxFilter = { status: 'Acknowledged' };
      expect(inbox.list(filter).map((i) => i.id)).toEqual(['5']);
    });

    it('filters by kind', () => {
      const filter: AttentionInboxFilter = { kind: 'FailedRun' };
      expect(inbox.list(filter).map((i) => i.id)).toEqual(['2', '3']);
    });

    it('filters by taskId', () => {
      const filter: AttentionInboxFilter = { taskId: 'task-99' };
      expect(inbox.list(filter).map((i) => i.id)).toEqual(['4']);
    });

    it('filters by priority', () => {
      const filter: AttentionInboxFilter = { priority: 'High' };
      // Both High; id tie-break '2' < '5'.
      expect(inbox.list(filter).map((i) => i.id)).toEqual(['2', '5']);
    });

    it('combines multiple filter fields (AND)', () => {
      const filter: AttentionInboxFilter = { kind: 'ApprovalRequest', status: 'Pending' };
      expect(inbox.list(filter).map((i) => i.id)).toEqual(['1']);
    });

    it('returns a new array (does not expose internals)', () => {
      const all = inbox.list();
      all.pop();
      expect(inbox.list().length).toBe(5);
    });
  });

  describe('snapshot / restore', () => {
    it('snapshot is serializable and a deep copy', () => {
      inbox.add(item('1', 'High', '2026-01-01T00:00:00.000Z'));
      const snap: AttentionInboxSnapshot = inbox.snapshot();
      expect(JSON.parse(JSON.stringify(snap))).toEqual(JSON.parse(JSON.stringify(snap)));
      expect(snap.items.length).toBe(1);
      // Mutating the inbox after snapshot does not affect the snapshot.
      inbox.add(item('2', 'Low', '2026-01-01T00:00:00.000Z'));
      expect(snap.items.length).toBe(1);
    });

    it('restore produces an inbox with the same items', () => {
      inbox.add(item('1', 'Critical', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('2', 'Low', '2026-01-01T00:00:00.000Z'));
      const snap = inbox.snapshot();
      const restored = AttentionInbox.restore(snap);
      expect(restored.size).toBe(2);
      expect(restored.peek()?.id).toBe('1');
    });

    it('restored inbox is independent of the snapshot', () => {
      inbox.add(item('1', 'High', '2026-01-01T00:00:00.000Z'));
      const snap = inbox.snapshot();
      const restored = AttentionInbox.restore(snap);
      restored.take();
      // Snapshot and original inbox are unaffected.
      expect(snap.items.length).toBe(1);
      expect(inbox.size).toBe(1);
    });

    it('round-trips through snapshot → restore → snapshot', () => {
      inbox.add(item('1', 'Critical', '2026-01-01T00:00:00.000Z'));
      inbox.add(item('2', 'High', '2026-01-01T00:00:00.000Z'));
      const snap1 = inbox.snapshot();
      const restored = AttentionInbox.restore(snap1);
      const snap2 = restored.snapshot();
      expect(snap2.items.length).toBe(2);
      expect(snap2.items.sort(compareAttentionItems).map((i) => i.id)).toEqual(['1', '2']);
    });
  });
});

/* ------------------------------------------------------------------ *
 * AttentionAggregator
 * ------------------------------------------------------------------ */

describe('AttentionAggregator', () => {
  let inbox: AttentionInbox;
  let bus: EventBus;
  let aggregator: AttentionAggregator;

  beforeEach(() => {
    inbox = new AttentionInbox();
    bus = new EventBus();
    aggregator = new AttentionAggregator(inbox, bus, { dedupWindowMs: 1000 });
    aggregator.start();
  });

  afterEach(() => {
    aggregator.stop();
  });

  describe('riskLevelToPriority', () => {
    it('maps critical -> Critical', () => {
      expect(riskLevelToPriority('critical')).toBe('Critical');
    });
    it('maps high -> High', () => {
      expect(riskLevelToPriority('high')).toBe('High');
    });
    it('maps medium -> Medium', () => {
      expect(riskLevelToPriority('medium')).toBe('Medium');
    });
    it('maps low -> Low', () => {
      expect(riskLevelToPriority('low')).toBe('Low');
    });
  });

  it('DEFAULT_DEDUP_WINDOW_MS is 30 seconds', () => {
    expect(DEFAULT_DEDUP_WINDOW_MS).toBe(30_000);
  });

  describe('ApprovalRequested events', () => {
    it('creates an ApprovalRequest item with priority from riskLevel', () => {
      bus.publish(approvalEvent('critical'));
      const items = inbox.list();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('ApprovalRequest');
      expect(items[0].priority).toBe('Critical');
      expect(items[0].payload['capability']).toBe('network');
      expect(items[0].payload['destination']).toBe('example.com');
      expect(items[0].payload['riskLevel']).toBe('critical');
    });

    it('maps high risk to High priority', () => {
      bus.publish(approvalEvent('high'));
      expect(inbox.list()[0].priority).toBe('High');
    });

    it('maps medium risk to Medium priority', () => {
      bus.publish(approvalEvent('medium'));
      expect(inbox.list()[0].priority).toBe('Medium');
    });

    it('maps low risk to Low priority', () => {
      bus.publish(approvalEvent('low'));
      expect(inbox.list()[0].priority).toBe('Low');
    });

    it('uses the event timestamp as createdAt', () => {
      bus.publish(approvalEvent('high', { timestamp: '2026-03-01T10:00:00.000Z' }));
      expect(inbox.list()[0].createdAt).toBe('2026-03-01T10:00:00.000Z');
    });
  });

  describe('AgentFailed events', () => {
    it('creates a FailedRun item with High priority', () => {
      bus.publish(failedEvent());
      const items = inbox.list();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('FailedRun');
      expect(items[0].priority).toBe('High');
      expect(items[0].payload['error']).toBe('Non-zero exit code');
    });
  });

  describe('AgentCompleted events', () => {
    it('creates a Digest item with Low priority', () => {
      bus.publish(completedEvent());
      const items = inbox.list();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('Digest');
      expect(items[0].priority).toBe('Low');
      expect(items[0].payload['summary']).toBe('Task done');
    });
  });

  describe('non-attention events', () => {
    it('does not create items for routine events', () => {
      bus.publish({
        ...base,
        type: 'AgentStarted',
        objective: 'Do stuff',
        workingDir: '/repo',
      });
      bus.publish({
        ...base,
        type: 'AgentProgress',
        message: 'Working...',
      });
      expect(inbox.size).toBe(0);
    });
  });

  describe('handleEvent (direct)', () => {
    it('can process events without the bus', () => {
      const localInbox = new AttentionInbox();
      const localBus = new EventBus();
      const agg = new AttentionAggregator(localInbox, localBus);
      agg.handleEvent(failedEvent());
      expect(localInbox.size).toBe(1);
      expect(localInbox.list()[0].kind).toBe('FailedRun');
    });
  });

  describe('report methods (non-event sources)', () => {
    it('reportDirtyWorktree creates a DirtyWorktree item', () => {
      aggregator.reportDirtyWorktree('task-1', '/repo/.florina-worktrees/task-1', 'florina/task-1');
      const items = inbox.list();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('DirtyWorktree');
      expect(items[0].priority).toBe('Medium');
      expect(items[0].payload['worktreePath']).toBe('/repo/.florina-worktrees/task-1');
      expect(items[0].payload['branch']).toBe('florina/task-1');
    });

    it('reportLivenessTimeout creates an IdleAgent item', () => {
      aggregator.reportLivenessTimeout('task-1', 600_000);
      const items = inbox.list();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('IdleAgent');
      expect(items[0].priority).toBe('High');
      expect(items[0].payload['idleMs']).toBe(600_000);
    });

    it('reportStaleTask creates a StaleTask item', () => {
      aggregator.reportStaleTask('task-1', 86_400_000);
      const items = inbox.list();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('StaleTask');
      expect(items[0].priority).toBe('Medium');
    });
  });

  describe('deduplication', () => {
    it('does not create a duplicate for same taskId+kind within the window', () => {
      bus.publish(failedEvent());
      bus.publish(failedEvent());
      bus.publish(failedEvent());
      expect(inbox.size).toBe(1);
    });

    it('creates a new item after the dedup window elapses', () => {
      let clock = 1_000_000;
      const dedupInbox = new AttentionInbox();
      const dedupBus = new EventBus();
      const agg = new AttentionAggregator(dedupInbox, dedupBus, {
        dedupWindowMs: 1000,
        now: () => clock,
      });
      agg.start();

      agg.handleEvent(failedEvent());
      expect(dedupInbox.size).toBe(1);

      // Advance past the dedup window.
      clock += 2000;
      agg.handleEvent(failedEvent());
      expect(dedupInbox.size).toBe(2);

      agg.stop();
    });

    it('deduplicates independently per kind', () => {
      bus.publish(failedEvent());
      bus.publish(completedEvent());
      // Different kinds → both kept.
      expect(inbox.size).toBe(2);
    });

    it('deduplicates independently per taskId', () => {
      bus.publish(failedEvent({ taskId: 'task-a' }));
      bus.publish(failedEvent({ taskId: 'task-b' }));
      // Different taskIds → both kept.
      expect(inbox.size).toBe(2);
    });

    it('report methods also deduplicate', () => {
      aggregator.reportLivenessTimeout('task-1', 1000);
      aggregator.reportLivenessTimeout('task-1', 2000);
      expect(inbox.size).toBe(1);
    });
  });

  describe('start / stop', () => {
    it('start is idempotent', () => {
      aggregator.start();
      aggregator.start();
      bus.publish(failedEvent());
      expect(inbox.size).toBe(1);
    });

    it('stop unsubscribes from the bus', () => {
      aggregator.stop();
      bus.publish(failedEvent());
      expect(inbox.size).toBe(0);
    });

    it('stop is safe when not started', () => {
      const agg = new AttentionAggregator(new AttentionInbox(), new EventBus());
      expect(() => agg.stop()).not.toThrow();
    });
  });
});
