/**
 * Context health tracking (DEC-035, issue #77) — per-agent window fill,
 * condensation-aware classification, journaled observations, and
 * attention elevation for degrading contexts.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { ContextHealthMonitor } from '../src/core/application/use-cases/context/context-health-monitor.js';
import { AttentionAggregator } from '../src/core/application/use-cases/attention/attention-aggregator.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { EventJournalWriter } from '../src/core/application/use-cases/journal/event-journal-writer.js';
import { MetricsCollector } from '../src/core/application/use-cases/metrics.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import { buildProject, buildTask } from '../src/core/domain/index.js';
import type {
  ContextCondensedEvent,
  ContextHealthChangedEvent,
  SupervisorEvent,
  UsageReportedEvent,
} from '../src/core/domain/events.js';

const SMALL_BUDGETS = { tokenBudget: 1000, eventBudget: 10, degradedFill: 0.75, criticalFill: 0.9 };

interface Fixture {
  bus: EventBus;
  monitor: ContextHealthMonitor;
  inbox: AttentionInbox;
  aggregator: AttentionAggregator;
  metrics: MetricsCollector;
  eventRepo: EventRepository;
  taskId: string;
  sessionId: string;
}

function createFixture(): Fixture {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const raw = db.connection;

  const project = buildProject({ name: 'p', repo: { path: '/repo' } });
  raw
    .prepare(
      'INSERT INTO projects (id, name, repo, policies, capsule_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      project.id,
      project.name,
      JSON.stringify(project.repo),
      JSON.stringify(project.policies),
      project.capsuleId,
      project.createdAt,
      project.updatedAt,
    );
  raw
    .prepare(
      'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('codex', 'codex', 'codex', 'B', '{}', new Date().toISOString());
  const taskRepo = new TaskRepository(raw);
  const task = buildTask({ projectId: project.id, objective: 'long task' });
  taskRepo.insert(task);
  raw
    .prepare(
      'INSERT INTO sessions (id, task_id, agent_id, status, started_at, capsule_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('sess-1', task.id, 'codex', 'running', new Date().toISOString(), 'capsule-1');

  const eventRepo = new EventRepository(raw);
  const bus = new EventBus();
  const writer = new EventJournalWriter({ journal: eventRepo, bus });
  writer.start();
  const monitor = new ContextHealthMonitor({ bus, config: SMALL_BUDGETS });
  monitor.start();
  const inbox = new AttentionInbox();
  const aggregator = new AttentionAggregator(inbox, bus);
  aggregator.start();
  const metrics = new MetricsCollector();
  metrics.attach(bus);

  return {
    bus,
    monitor,
    inbox,
    aggregator,
    metrics,
    eventRepo,
    taskId: task.id,
    sessionId: 'sess-1',
  };
}

let seq = 0;
function ts(): string {
  seq += 1;
  return `2026-09-21T00:00:${String(seq).padStart(2, '0')}.000Z`;
}

function progress(fx: Fixture): SupervisorEvent {
  return {
    type: 'AgentProgress',
    timestamp: ts(),
    taskId: fx.taskId,
    sessionId: fx.sessionId,
    agentId: 'codex',
    adapterFidelityTier: 'B',
    message: 'working',
    step: 1,
  };
}

function usage(fx: Fixture, totalTokens: number): UsageReportedEvent {
  return {
    type: 'UsageReported',
    timestamp: ts(),
    taskId: fx.taskId,
    sessionId: fx.sessionId,
    agentId: 'codex',
    adapterFidelityTier: 'B',
    provider: 'codex',
    totalTokens,
  };
}

function condensed(fx: Fixture, keptEventCount: number): ContextCondensedEvent {
  return {
    type: 'ContextCondensed',
    timestamp: ts(),
    taskId: fx.taskId,
    sessionId: fx.sessionId,
    agentId: 'codex',
    adapterFidelityTier: 'B',
    summary: 'rolled up',
    forgottenEventIds: ['e1'],
    keptEventCount,
  };
}

describe('ContextHealthMonitor', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  it('emits ContextHealthChanged when fill crosses the degraded threshold', () => {
    const observed: ContextHealthChangedEvent[] = [];
    fx.bus.onEvent((e) => {
      if (e.type === 'ContextHealthChanged') observed.push(e);
    });

    // eventBudget=10 → 8 events = 0.8 fill → degraded.
    for (let i = 0; i < 8; i++) fx.bus.publish(progress(fx));

    expect(observed).toHaveLength(1);
    expect(observed[0]!.status).toBe('degraded');
    expect(observed[0]!.windowFillPct).toBeGreaterThanOrEqual(0.75);
    expect(fx.monitor.snapshot('codex')!.status).toBe('degraded');
  });

  it('escalates to critical at the higher threshold', () => {
    const observed: ContextHealthChangedEvent[] = [];
    fx.bus.onEvent((e) => {
      if (e.type === 'ContextHealthChanged') observed.push(e);
    });

    for (let i = 0; i < 9; i++) fx.bus.publish(progress(fx));
    expect(observed[observed.length - 1]!.status).toBe('critical');
  });

  it('token signal drives fill independently of event count', () => {
    fx.bus.publish(usage(fx, 800)); // 800/1000 = 0.8 → degraded
    expect(fx.monitor.snapshot('codex')!.status).toBe('degraded');
    expect(fx.monitor.snapshot('codex')!.windowFillPct).toBeCloseTo(0.8);
  });

  it('a condensation resets the fill baseline — back to ok', () => {
    for (let i = 0; i < 9; i++) fx.bus.publish(progress(fx));
    expect(fx.monitor.snapshot('codex')!.status).toBe('critical');

    const observed: ContextHealthChangedEvent[] = [];
    fx.bus.onEvent((e) => {
      if (e.type === 'ContextHealthChanged') observed.push(e);
    });
    fx.bus.publish(condensed(fx, 2));

    const snap = fx.monitor.snapshot('codex')!;
    expect(snap.status).toBe('ok');
    expect(snap.condensationCount).toBe(1);
    expect(snap.lastCondensationAt).toBeDefined();
    expect(snap.eventsSinceCondensation).toBe(2);
    // Recovery transition was emitted.
    expect(observed[observed.length - 1]!.status).toBe('ok');
  });

  it('token accounting restarts from the condensation baseline', () => {
    fx.bus.publish(usage(fx, 700));
    fx.bus.publish(condensed(fx, 2));
    // 700 tokens are now the baseline; +200 more = 0.2 token fill,
    // while the event signal is (2 kept + 1 usage) / 10 = 0.3.
    fx.bus.publish(usage(fx, 900));
    const snap = fx.monitor.snapshot('codex')!;
    expect(snap.status).toBe('ok');
    expect(snap.windowFillPct).toBeCloseTo(0.3, 1);
  });

  it('status transitions are emitted once per crossing, not per event', () => {
    const observed: ContextHealthChangedEvent[] = [];
    fx.bus.onEvent((e) => {
      if (e.type === 'ContextHealthChanged') observed.push(e);
    });
    for (let i = 0; i < 12; i++) fx.bus.publish(progress(fx));
    // degraded at 8, critical at 9 → exactly 2 transitions, not 5.
    expect(observed.map((e) => e.status)).toEqual(['degraded', 'critical']);
  });

  it('adapter-reported ContextHealthChanged passes through as authoritative', () => {
    const native: ContextHealthChangedEvent = {
      type: 'ContextHealthChanged',
      timestamp: ts(),
      taskId: fx.taskId,
      sessionId: fx.sessionId,
      agentId: 'codex',
      adapterFidelityTier: 'A',
      status: 'degraded',
      windowFillPct: 0.82,
    };
    fx.bus.publish(native);
    expect(fx.monitor.snapshot('codex')!.status).toBe('degraded');
  });
});

describe('context health → attention + journal', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  it('degraded context creates a DegradedContext inbox item', () => {
    for (let i = 0; i < 8; i++) fx.bus.publish(progress(fx));
    const items = fx.inbox.list().filter((i) => i.kind === 'DegradedContext');
    expect(items).toHaveLength(1);
    expect(items[0]!.priority).toBe('Medium');
    expect(items[0]!.payload['agentId']).toBe('codex');
  });

  it('critical context escalates the existing card instead of duplicating', () => {
    for (let i = 0; i < 9; i++) fx.bus.publish(progress(fx));
    const items = fx.inbox.list().filter((i) => i.kind === 'DegradedContext');
    expect(items).toHaveLength(1);
    expect(items[0]!.priority).toBe('Critical');
    expect(items[0]!.status).toBe('Escalated');
  });

  it('ContextHealthChanged observations are journaled (DEC-012)', () => {
    for (let i = 0; i < 8; i++) fx.bus.publish(progress(fx));
    const journaled = fx.eventRepo
      .listByTask(fx.taskId)
      .filter((e) => e.kind === 'ContextHealthChanged');
    expect(journaled).toHaveLength(1);
    expect(journaled[0]!.payload['status']).toBe('degraded');
  });

  it('health observations feed the metrics layer per status', () => {
    for (let i = 0; i < 9; i++) fx.bus.publish(progress(fx));
    fx.bus.publish(condensed(fx, 2));
    const counts = fx.metrics.snapshot().counters.contextHealthByStatus;
    expect(counts['degraded']).toBe(1);
    expect(counts['critical']).toBe(1);
    expect(counts['ok']).toBe(1); // the recovery observation
  });

  it('recovery to ok does not create a new item', () => {
    for (let i = 0; i < 9; i++) fx.bus.publish(progress(fx));
    fx.bus.publish(condensed(fx, 2));
    const items = fx.inbox.list().filter((i) => i.kind === 'DegradedContext');
    expect(items).toHaveLength(1); // the earlier degraded/critical item only
  });
});
