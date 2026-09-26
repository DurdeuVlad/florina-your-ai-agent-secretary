import { describe, it, expect } from 'vitest';
import {
  computeCatchUpDigest,
  watermarkOrEpoch,
  advanceWatermark,
} from '../src/core/application/use-cases/resumption/catchup-digest.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { createAttentionItem } from '../src/core/application/use-cases/attention/attention-item.js';
import type { Task, Event, EntityId } from '../src/core/domain/types.js';
import type { CatchUpWatermarkPort } from '../src/core/application/ports/outbound/catchup-watermark.js';

class InMemoryWatermarkStore implements CatchUpWatermarkPort {
  private value: string | null = null;
  get(): string | null {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'state' | 'updatedAt'>): Task {
  return {
    projectId: 'proj-1',
    objective: 'do the thing',
    agentIds: [],
    sessionIds: [],
    deliverableIds: [],
    attentionItemIds: [],
    capsuleId: 'capsule-1',
    createdAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

class FakeTaskStore {
  constructor(private readonly tasks: Task[]) {}
  listAll(): Task[] {
    return this.tasks;
  }
}

class FakeJournal {
  constructor(private readonly events: Event[]) {}
  listByTimestampRange(start: string, end: string): Event[] {
    return this.events.filter((e) => e.timestamp >= start && e.timestamp <= end);
  }
}

function failoverEvent(taskId: EntityId, timestamp: string): Event {
  return {
    id: `event-${taskId}-${timestamp}`,
    taskId,
    sessionId: 'sess-1',
    timestamp,
    kind: 'TaskFailedOver',
    payload: { fromProvider: 'codex', toProvider: 'claude-code', reason: 'quota' },
  };
}

const SINCE = '2026-09-20T00:00:00.000Z';
const UNTIL = '2026-09-21T00:00:00.000Z';

describe('computeCatchUpDigest', () => {
  it('is empty when there is nothing notable, running, pending, or failed-over', () => {
    const digest = computeCatchUpDigest(
      { taskStore: new FakeTaskStore([]), inbox: new AttentionInbox(), journal: new FakeJournal([]) },
      SINCE,
      UNTIL,
    );
    expect(digest.isEmpty).toBe(true);
    expect(digest.notable).toEqual([]);
  });

  it('includes tasks that transitioned to completed/failed/attention-needed within the window', () => {
    const tasks = [
      task({ id: 't-completed', state: 'completed', updatedAt: '2026-09-20T12:00:00.000Z' }),
      task({ id: 't-failed', state: 'failed', updatedAt: '2026-09-20T13:00:00.000Z' }),
      task({ id: 't-attn', state: 'attention-needed', updatedAt: '2026-09-20T14:00:00.000Z' }),
    ];
    const digest = computeCatchUpDigest(
      { taskStore: new FakeTaskStore(tasks), inbox: new AttentionInbox(), journal: new FakeJournal([]) },
      SINCE,
      UNTIL,
    );
    expect(digest.notable.map((t) => t.taskId).sort()).toEqual(['t-attn', 't-completed', 't-failed']);
    expect(digest.isEmpty).toBe(false);
  });

  it('excludes notable-state tasks outside the (since, until] window', () => {
    const tasks = [
      task({ id: 't-before', state: 'completed', updatedAt: '2026-09-19T00:00:00.000Z' }),
      task({ id: 't-at-since', state: 'completed', updatedAt: SINCE }), // exclusive lower bound
      task({ id: 't-after', state: 'completed', updatedAt: '2026-09-22T00:00:00.000Z' }),
    ];
    const digest = computeCatchUpDigest(
      { taskStore: new FakeTaskStore(tasks), inbox: new AttentionInbox(), journal: new FakeJournal([]) },
      SINCE,
      UNTIL,
    );
    expect(digest.notable).toEqual([]);
  });

  it('does not include ordinary lifecycle states (created/delegated/blocked/etc) as notable', () => {
    const tasks = [
      task({ id: 't-created', state: 'created', updatedAt: '2026-09-20T12:00:00.000Z' }),
      task({ id: 't-delegated', state: 'delegated', updatedAt: '2026-09-20T12:00:00.000Z' }),
      task({ id: 't-blocked', state: 'blocked', updatedAt: '2026-09-20T12:00:00.000Z' }),
    ];
    const digest = computeCatchUpDigest(
      { taskStore: new FakeTaskStore(tasks), inbox: new AttentionInbox(), journal: new FakeJournal([]) },
      SINCE,
      UNTIL,
    );
    expect(digest.notable).toEqual([]);
  });

  it('lists still-running tasks as a live snapshot, independent of the window', () => {
    const tasks = [task({ id: 't-running', state: 'running', updatedAt: '2026-09-01T00:00:00.000Z' })];
    const digest = computeCatchUpDigest(
      { taskStore: new FakeTaskStore(tasks), inbox: new AttentionInbox(), journal: new FakeJournal([]) },
      SINCE,
      UNTIL,
    );
    expect(digest.stillRunning.map((t) => t.taskId)).toEqual(['t-running']);
    expect(digest.isEmpty).toBe(false);
  });

  it('lists currently pending attention items as a live snapshot', () => {
    const inbox = new AttentionInbox();
    inbox.add(createAttentionItem({ taskId: 't-1', kind: 'ApprovalRequest', priority: 'High' }));
    const digest = computeCatchUpDigest(
      { taskStore: new FakeTaskStore([]), inbox, journal: new FakeJournal([]) },
      SINCE,
      UNTIL,
    );
    expect(digest.pendingAttention).toHaveLength(1);
    expect(digest.isEmpty).toBe(false);
  });

  it('excludes resolved attention items', () => {
    const inbox = new AttentionInbox();
    const item = createAttentionItem({ taskId: 't-1', kind: 'ApprovalRequest', priority: 'High' });
    inbox.add(item);
    inbox.resolve(item.id);
    const digest = computeCatchUpDigest(
      { taskStore: new FakeTaskStore([]), inbox, journal: new FakeJournal([]) },
      SINCE,
      UNTIL,
    );
    expect(digest.pendingAttention).toHaveLength(0);
  });

  it('includes provider failovers within the window with before/after provider named', () => {
    const journal = new FakeJournal([failoverEvent('t-1', '2026-09-20T15:00:00.000Z')]);
    const digest = computeCatchUpDigest(
      { taskStore: new FakeTaskStore([]), inbox: new AttentionInbox(), journal },
      SINCE,
      UNTIL,
    );
    expect(digest.failovers).toHaveLength(1);
    expect(digest.failovers[0]).toMatchObject({
      taskId: 't-1',
      fromProvider: 'codex',
      toProvider: 'claude-code',
      reason: 'quota',
    });
    expect(digest.isEmpty).toBe(false);
  });
});

describe('watermarkOrEpoch', () => {
  it('returns the epoch for a null watermark (first-ever catch-up)', () => {
    expect(watermarkOrEpoch(null)).toBe(new Date(0).toISOString());
  });

  it('returns the stored value unchanged when present', () => {
    expect(watermarkOrEpoch('2026-09-20T00:00:00.000Z')).toBe('2026-09-20T00:00:00.000Z');
  });
});

describe('advanceWatermark', () => {
  it('sets the watermark on first use (from null)', () => {
    const store = new InMemoryWatermarkStore();
    advanceWatermark(store, '2026-09-20T00:00:00.000Z');
    expect(store.get()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('advances forward normally', () => {
    const store = new InMemoryWatermarkStore();
    store.set('2026-09-20T00:00:00.000Z');
    advanceWatermark(store, '2026-09-21T00:00:00.000Z');
    expect(store.get()).toBe('2026-09-21T00:00:00.000Z');
  });

  it('never regresses backward on a stale/out-of-order call', () => {
    const store = new InMemoryWatermarkStore();
    store.set('2026-09-21T00:00:00.000Z');
    advanceWatermark(store, '2026-09-20T00:00:00.000Z');
    expect(store.get()).toBe('2026-09-21T00:00:00.000Z');
  });

  it('is a no-op when the new value equals the current one', () => {
    const store = new InMemoryWatermarkStore();
    store.set('2026-09-20T00:00:00.000Z');
    advanceWatermark(store, '2026-09-20T00:00:00.000Z');
    expect(store.get()).toBe('2026-09-20T00:00:00.000Z');
  });
});
