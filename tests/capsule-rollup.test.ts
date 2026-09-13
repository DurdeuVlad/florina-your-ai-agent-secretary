import { describe, it, expect, beforeEach } from 'vitest';

import {
  CapsuleRollupService,
  extractiveEventSummarizer,
} from '../src/core/application/use-cases/context/capsule-rollup.js';
import type { CapsuleRollupOptions } from '../src/core/application/use-cases/context/capsule-rollup.js';
import { SessionManager } from '../src/core/application/use-cases/tasks/session-manager.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  SessionRepository,
  ContextCapsuleRepository,
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import { buildProject, buildTask, buildTaskCapsule } from '../src/core/domain/index.js';
import type { Event, Session } from '../src/core/domain/types.js';
import type { SupervisorEvent } from '../src/core/domain/events.js';
import type {
  AgentRuntimePort,
  SessionConfig,
  StartRunResult,
} from '../src/core/application/ports/outbound/agent-runtime.js';

class FakeAdapter implements AgentRuntimePort {
  readonly id = 'codex';
  readonly fidelityTier = 'B' as const;
  connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  async connect(): Promise<void> {
    this.connectionState = 'connected';
  }
  async startRun(_taskId: string, cfg: SessionConfig): Promise<StartRunResult> {
    return { sessionId: cfg.sessionId, started: true };
  }
  streamEvents(): AsyncIterable<SupervisorEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<SupervisorEvent>>(() => {}),
      }),
    };
  }
  async cancel(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.connectionState = 'disconnected';
  }
}

interface Fixture {
  rollup: CapsuleRollupService;
  eventRepo: EventRepository;
  sessionRepo: SessionRepository;
  capsuleRepo: ContextCapsuleRepository;
  bus: EventBus;
  published: SupervisorEvent[];
  taskId: string;
  insertSession: (id: string, status?: Session['status']) => Session;
  insertEvent: (sessionId: string, kind: string, payload?: Record<string, unknown>) => Event;
}

function createFixture(rollupOptions: Partial<CapsuleRollupOptions> = {}): Fixture {
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
    .run('codex', 'codex', 'codex', 'D', '{}', new Date().toISOString());

  const taskRepo = new TaskRepository(raw);
  const eventRepo = new EventRepository(raw);
  const sessionRepo = new SessionRepository(raw);
  const capsuleRepo = new ContextCapsuleRepository(raw);
  const bus = new EventBus();

  const task = buildTask({ projectId: project.id, objective: 'build it', worktreePath: '/wt' });
  taskRepo.insert(task);
  const capsule = buildTaskCapsule({
    ownerId: task.id,
    content: {
      objective: task.objective,
      agentIds: [],
      runHistory: [],
      deliverableIds: [],
      rolledUpEventSummaries: [],
    },
  });
  capsuleRepo.insert(capsule);
  taskRepo.update({ ...task, capsuleId: capsule.id });

  const rollup = new CapsuleRollupService({
    journal: eventRepo,
    capsuleStore: capsuleRepo,
    sessionStore: sessionRepo,
    eventBus: bus,
    ...rollupOptions,
  });

  const published: SupervisorEvent[] = [];
  bus.onEvent((e) => published.push(e));

  return {
    rollup,
    eventRepo,
    sessionRepo,
    capsuleRepo,
    bus,
    published,
    taskId: task.id,
    insertSession: (id, status = 'running') => {
      const session: Session = {
        id,
        taskId: task.id,
        agentId: 'codex',
        status,
        startedAt: '2025-01-01T00:00:00.000Z',
        ...(status === 'running' ? {} : { endedAt: '2025-01-01T01:00:00.000Z' }),
        eventIds: [],
        deliverableIds: [],
        capsuleId: `cap_${id}`,
      };
      sessionRepo.insert(session);
      return session;
    },
    insertEvent: (sessionId, kind, payload = {}) => {
      const event: Event = {
        id: `event_${Math.random().toString(36).slice(2, 12)}`,
        sessionId,
        taskId: task.id,
        timestamp: new Date().toISOString(),
        kind: kind as Event['kind'],
        payload,
      };
      eventRepo.insert(event);
      return event;
    },
  };
}

describe('CapsuleRollupService', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  it("rolls a session's journal events into the Task Capsule", async () => {
    const s = fx.insertSession('sess_1', 'completed');
    const e1 = fx.insertEvent(s.id, 'AgentStarted', { objective: 'build it' });
    const e2 = fx.insertEvent(s.id, 'AgentProgress');
    const e3 = fx.insertEvent(s.id, 'AgentCompleted');

    const result = await fx.rollup.rollUpSession(fx.taskId, s.id);

    expect(result).not.toBeNull();
    expect(result!.rolledUpEventIds).toEqual([e1.id, e2.id, e3.id]);

    const capsule = fx.capsuleRepo.loadByScope('task', fx.taskId)!;
    expect(capsule.scope).toBe('task');
    if (capsule.scope !== 'task') return;
    expect(capsule.content.rolledUpEventSummaries).toHaveLength(1);
    expect(capsule.content.rolledUpEventSummaries[0]).toContain('AgentStarted');
    expect(capsule.content.rolledUpEventSummaries[0]).toContain('3 events');
    expect(capsule.content.runHistory).toEqual([
      expect.objectContaining({ sessionId: 'sess_1', status: 'completed' }),
    ]);
  });

  it('journals and publishes a ContextCondensed provenance event', async () => {
    const s = fx.insertSession('sess_1', 'completed');
    const e1 = fx.insertEvent(s.id, 'AgentProgress');
    await fx.rollup.rollUpSession(fx.taskId, s.id);

    const journal = fx.eventRepo.listBySession(s.id);
    const condensed = journal.find((e) => e.kind === 'ContextCondensed')!;
    expect(condensed).toBeDefined();
    expect(condensed.payload.forgottenEventIds).toEqual([e1.id]);

    expect(fx.published.some((e) => e.type === 'ContextCondensed')).toBe(true);
  });

  it('does not delete source events — summaries are projections', async () => {
    const s = fx.insertSession('sess_1', 'completed');
    fx.insertEvent(s.id, 'AgentProgress');
    fx.insertEvent(s.id, 'AgentProgress');
    await fx.rollup.rollUpSession(fx.taskId, s.id);

    const remaining = fx.eventRepo.listBySession(s.id).filter((e) => e.kind === 'AgentProgress');
    expect(remaining).toHaveLength(2);
  });

  it('is idempotent per session', async () => {
    const s = fx.insertSession('sess_1', 'completed');
    fx.insertEvent(s.id, 'AgentProgress');
    const first = await fx.rollup.rollUpSession(fx.taskId, s.id);
    const second = await fx.rollup.rollUpSession(fx.taskId, s.id);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const capsule = fx.capsuleRepo.loadByScope('task', fx.taskId)!;
    if (capsule.scope !== 'task') throw new Error('wrong scope');
    expect(capsule.content.rolledUpEventSummaries).toHaveLength(1);
  });

  it('rollUpTask folds every unrolled session', async () => {
    const s1 = fx.insertSession('sess_1', 'completed');
    const s2 = fx.insertSession('sess_2', 'stopped');
    fx.insertEvent(s1.id, 'AgentStarted');
    fx.insertEvent(s2.id, 'AgentStopped');

    const results = await fx.rollup.rollUpTask(fx.taskId);
    expect(results).toHaveLength(2);

    const capsule = fx.capsuleRepo.loadByScope('task', fx.taskId)!;
    if (capsule.scope !== 'task') throw new Error('wrong scope');
    expect(capsule.content.runHistory.map((r) => r.sessionId)).toEqual(['sess_1', 'sess_2']);
  });

  it('returns null when the task has no capsule', async () => {
    const orphan = buildTask({ projectId: 'p2', objective: 'x' });
    const result = await fx.rollup.rollUpSession(orphan.id, 'sess_x');
    expect(result).toBeNull();
  });

  it('self-condenses the summary list past threshold, keeping the tail', async () => {
    const fx2 = createFixture({ maxSummaryEntries: 3, keepRecentEntries: 2 });
    for (let i = 1; i <= 5; i += 1) {
      const s = fx2.insertSession(`sess_${i}`, 'completed');
      fx2.insertEvent(s.id, 'AgentProgress', { reason: `run ${i}` });
      await fx2.rollup.rollUpSession(fx2.taskId, s.id);
    }

    const capsule = fx2.capsuleRepo.loadByScope('task', fx2.taskId)!;
    if (capsule.scope !== 'task') throw new Error('wrong scope');
    const summaries = capsule.content.rolledUpEventSummaries;
    // 4th rollup pushed the list to 4 > 3 → folded to [synopsis, ...2 kept],
    // then the 5th appended one more: 1 synopsis + 3 kept.
    expect(summaries.length).toBeLessThanOrEqual(4);
    expect(summaries[0]).toContain('task synopsis');
    // The most recent summaries stay verbatim.
    expect(summaries[summaries.length - 1]).toContain('run 5');
  });

  it('stopSession triggers the rollup via the onSessionEnd hook', async () => {
    const bus = new EventBus();
    const rollup = fx.rollup;
    const sm = new SessionManager(bus, {
      onSessionEnd: async (taskId, sessionId) => {
        await rollup.rollUpSession(taskId, sessionId);
      },
    });

    const s = fx.insertSession('sess_hook', 'running');
    fx.insertEvent(s.id, 'AgentStarted');
    await sm.startSession(fx.taskId, 'codex', new FakeAdapter(), {
      taskId: fx.taskId,
      sessionId: s.id,
      agentId: 'codex',
      workingDir: '/wt',
      objective: 'build it',
    });
    await sm.stopSession(fx.taskId);

    const capsule = fx.capsuleRepo.loadByScope('task', fx.taskId)!;
    if (capsule.scope !== 'task') throw new Error('wrong scope');
    expect(capsule.content.runHistory.map((r) => r.sessionId)).toContain('sess_hook');
  });
});

describe('extractiveEventSummarizer', () => {
  it('renders one line per event with the headline payload field', async () => {
    const summary = await extractiveEventSummarizer([
      {
        id: 'e1',
        sessionId: 's',
        taskId: 't',
        timestamp: '2025-01-01T00:00:00.000Z',
        kind: 'TaskFailedOver',
        payload: { fromProvider: 'codex', toProvider: 'claude' },
      },
    ]);
    expect(summary).toContain('TaskFailedOver');
    expect(summary).toContain('claude');
  });
});
