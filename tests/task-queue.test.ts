/**
 * TaskQueue + queued dispatch integration tests (issue #343).
 *
 * Two layers:
 *  - Unit: durable queue semantics — journal-backed enqueue/dequeue,
 *    FIFO-per-lane ordering, priority promotion, expiry, wait reasons,
 *    and restart rebuild from journaled events (DEC-012).
 *  - Integration: `CommandApi` with a real SessionManager — start-task
 *    enters the queue instead of racing for a session, cancellation of a
 *    queued task removes it without spawning anything, a freed lane
 *    drains the next entry, and a rebuilt queue reproduces the same
 *    membership and dispatch identity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  AgentRuntimePort,
  SessionConfig,
  StartRunResult,
} from '../src/core/application/ports/outbound/agent-runtime.js';
import { SessionManager } from '../src/core/application/use-cases/tasks/session-manager.js';
import { CommandApi } from '../src/daemon/command-api.js';
import type {
  CommandApiDeps,
  StartTaskResponse,
  FleetResponse,
} from '../src/daemon/command-api.js';
import { TaskQueue } from '../src/core/application/use-cases/scheduling/task-queue.js';
import { EventJournalWriter } from '../src/core/application/use-cases/journal/event-journal-writer.js';
import { QuotaLedger } from '../src/daemon/quota-ledger.js';
import { EventBus } from '../src/daemon/event-stream.js';
import { TaskStateMachine } from '../src/daemon/task-lifecycle.js';
import { AttentionInbox } from '../src/attention/attention-inbox.js';
import { MetricsCollector } from '../src/daemon/metrics.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  SessionRepository,
  AgentRepository,
} from '../src/storage/index.js';
import { buildProject, buildTask, buildAgent, TaskState } from '../src/domain/index.js';
import { AdapterFidelityTier } from '../src/domain/index.js';
import type { Task, SupervisorEvent, Event } from '../src/domain/types.js';
import type { TaskStore, ApprovalStore } from '../src/daemon/command-api.js';
import type { Approval } from '../src/domain/types.js';
import type { WorktreePort } from '../src/core/application/ports/outbound/worktree.js';

/* ================================================================== *
 * Scripted adapters
 * ================================================================== */

/** Never yields and never ends — holds the lane until cancelled. */
class BlockingAdapter implements AgentRuntimePort {
  readonly id = 'codex';
  readonly fidelityTier = AdapterFidelityTier.B;
  readonly capabilities = { sendMessage: false, resume: false, compact: false } as const;
  readonly runs: SessionConfig[] = [];
  cancelled = false;
  async connect(): Promise<void> {}
  async startRun(_taskId: string, cfg: SessionConfig): Promise<StartRunResult> {
    this.runs.push(cfg);
    return { sessionId: cfg.sessionId, started: true };
  }
  streamEvents(): AsyncIterable<SupervisorEvent> {
    const cancelled = () => this.cancelled;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<SupervisorEvent>>((resolve) => {
            const tick = setInterval(() => {
              if (cancelled()) {
                clearInterval(tick);
                resolve({ done: true, value: undefined });
              }
            }, 5);
          }),
      }),
    };
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
  }
  async disconnect(): Promise<void> {}
}

async function settle(cond: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries && !cond(); i += 1) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

/* ================================================================== *
 * Fixture
 * ================================================================== */

class MemoryTaskStore implements TaskStore {
  constructor(private readonly repo: TaskRepository) {}
  getById(taskId: string): Task | null {
    return this.repo.getById(taskId);
  }
  listAll(): readonly Task[] {
    return this.repo.listAll();
  }
  update(task: Task): void {
    this.repo.update(task);
  }
}

class MemoryApprovalStore implements ApprovalStore {
  private readonly approvals = new Map<string, Approval>();
  insert(approval: Approval): void {
    this.approvals.set(approval.id, { ...approval });
  }
  getById(id: string): Approval | null {
    return this.approvals.get(id) ?? null;
  }
  update(approval: Approval): void {
    this.approvals.set(approval.id, { ...approval });
  }
}

interface Fixture {
  db: StorageDatabase;
  eventRepo: EventRepository;
  sessionRepo: SessionRepository;
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  taskStore: MemoryTaskStore;
  sm: TaskStateMachine;
  eventBus: EventBus;
  projectId: string;
  agentId: string;
  queue: TaskQueue;
  smRef: { current?: SessionManager };
  insertTask: (task: Task) => void;
  insertSession: (taskId: string, sessionId: string, status?: string) => void;
  eventsOf: (taskId: string, kind: string) => Event[];
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

  const agent = buildAgent({
    name: 'codex',
    provider: 'codex',
    fidelityTier: 'B',
    runtime: { kind: 'cli' },
  });
  raw
    .prepare(
      'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      agent.id,
      agent.name,
      agent.provider,
      agent.fidelityTier,
      JSON.stringify(agent.runtime),
      agent.createdAt,
    );

  const eventRepo = new EventRepository(raw);
  const sessionRepo = new SessionRepository(raw);
  const agentRepo = new AgentRepository(raw);
  const taskRepo = new TaskRepository(raw);
  const taskStore = new MemoryTaskStore(taskRepo);
  const sm = new TaskStateMachine(taskRepo, eventRepo);
  const eventBus = new EventBus();

  // Lane busy-ness is read from whichever SessionManager the test wires
  // — same shape as the daemon's composition (live map, not stored).
  const smRef: { current?: SessionManager } = {};
  const queue = new TaskQueue({
    journal: eventRepo,
    publish: (e) => eventBus.publish(e),
    isProviderBusy: (agentId) => {
      const manager = smRef.current;
      if (manager === undefined) {
        return false;
      }
      for (const session of manager.getActiveSessions().values()) {
        if (session.agentId === agentId) {
          return true;
        }
      }
      return false;
    },
  });

  const insertSession = (taskId: string, sessionId: string, status = 'running'): void => {
    raw
      .prepare(
        'INSERT OR IGNORE INTO sessions (id, task_id, agent_id, status, started_at, event_ids, deliverable_ids, capsule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(sessionId, taskId, agent.id, status, new Date().toISOString(), '[]', '[]', 'cap_x');
  };

  return {
    db,
    eventRepo,
    sessionRepo,
    agentRepo,
    taskRepo,
    taskStore,
    sm,
    eventBus,
    projectId: project.id,
    agentId: agent.id,
    queue,
    smRef,
    insertTask: (task) => taskRepo.insert(task),
    insertSession,
    eventsOf: (taskId, kind) => eventRepo.listByTask(taskId).filter((e) => e.kind === kind),
  };
}

function makeTask(fixture: Fixture, overrides: Partial<Task> = {}): Task {
  const task: Task = {
    ...buildTask({ projectId: fixture.projectId, objective: 'do the thing' }),
    ...overrides,
  };
  fixture.insertTask(task);
  return task;
}

/** Minimal CommandApi deps for the queue integration path. */
function queueDeps(fixture: Fixture, adapter: AgentRuntimePort): CommandApiDeps {
  return {
    eventBus: fixture.eventBus,
    taskStateMachine: fixture.sm,
    attentionInbox: new AttentionInbox(),
    metricsCollector: new MetricsCollector(),
    worktreeManager: {
      createWorktree: () => '/repo/wt',
      detectDirty: () => false,
      worktreeStatus: () => ({
        clean: true,
        dirty: false,
        branch: 'florina/t',
        baseCommit: 'x',
      }),
      pruneWorktree: () => {},
      listWorktrees: () => [],
      worktreePathFor: () => '/repo/wt',
    } satisfies WorktreePort,
    eventRepository: fixture.eventRepo,
    taskStore: fixture.taskStore,
    approvalStore: new MemoryApprovalStore(),
    sessionStore: fixture.sessionRepo,
    agentStore: fixture.agentRepo,
    adapterRegistry: { create: () => adapter, has: () => true, list: () => [adapter.id] },
    taskQueue: fixture.queue,
  };
}

/* ================================================================== *
 * Unit: durable queue semantics
 * ================================================================== */

describe('TaskQueue — durable membership', () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  const enqueue = (
    taskId: string,
    opts: Partial<Parameters<TaskQueue['enqueue']>[0]> = {},
  ): ReturnType<TaskQueue['enqueue']> => {
    const sessionId = opts.sessionId ?? `sess_${taskId}`;
    f.insertSession(taskId, sessionId, 'pending');
    return f.queue.enqueue({
      taskId,
      agentId: f.agentId,
      projectId: f.projectId,
      priority: 'MED',
      agentTier: 'B',
      sessionId,
      spec: { workingDir: '/repo/wt' },
      ...opts,
    });
  };

  it('enqueue journals TaskQueued and exposes position + wait reason', () => {
    const task = makeTask(f);
    const entry = enqueue(task.id);
    expect(entry.sessionId).toMatch(/^sess/);

    const journaled = f.eventsOf(task.id, 'TaskQueued');
    expect(journaled).toHaveLength(1);
    expect(journaled[0]!.sessionId).toBe(entry.sessionId);
    expect(journaled[0]!.payload['queueKey']).toBe(entry.queueKey);

    const snap = f.queue.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.position).toBe(1);
    expect(snap[0]!.waitReason).toBe('waiting: dispatch');
  });

  it('orders FIFO within a lane and keeps lanes independent', () => {
    const a = makeTask(f, { id: 'task_a' });
    const b = makeTask(f, { id: 'task_b' });
    const c = makeTask(f, { id: 'task_c' });
    enqueue(a.id);
    enqueue(b.id);
    // c in a different lane (other agent)
    f.insertSession(c.id, 'sess_c', 'pending');
    f.queue.enqueue({
      taskId: c.id,
      agentId: 'other-agent',
      projectId: f.projectId,
      priority: 'MED',
      agentTier: 'B',
      sessionId: 'sess_c',
      spec: { workingDir: '/repo/wt' },
    });

    const lane = f.queue.snapshot().filter((e) => e.agentId === f.agentId);
    expect(lane.map((e) => e.taskId)).toEqual([a.id, b.id]);
    expect(lane.map((e) => e.position)).toEqual([1, 2]);
    const otherLane = f.queue.snapshot().filter((e) => e.agentId === 'other-agent');
    expect(otherLane).toHaveLength(1);
    expect(otherLane[0]!.position).toBe(1);
  });

  it('promotes a higher-priority task ahead of FIFO order and journals it', () => {
    const low = makeTask(f, { id: 'task_low' });
    const high = makeTask(f, { id: 'task_high' });
    enqueue(low.id, { priority: 'LOW' });
    enqueue(high.id, { priority: 'HIGH' });

    const lane = f.queue.snapshot();
    expect(lane.map((e) => e.taskId)).toEqual([high.id, low.id]);
    expect(lane[0]!.priority).toBe('HIGH');
    // The promotion decision is journaled — the HIGH TaskQueued row
    // carries the declared priority, not an inference.
    const journaled = f.eventsOf(high.id, 'TaskQueued');
    expect(journaled[0]!.payload['priority']).toBe('HIGH');
  });

  it('dequeue removes the entry and journals TaskDequeued with the reason', () => {
    const task = makeTask(f);
    enqueue(task.id);
    expect(f.queue.dequeue(task.id, 'scheduled')).toBe(true);
    expect(f.queue.isQueued(task.id)).toBe(false);
    const rows = f.eventsOf(task.id, 'TaskDequeued');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload['reason']).toBe('scheduled');
    // A second dequeue is an honest no-op.
    expect(f.queue.dequeue(task.id, 'scheduled')).toBe(false);
  });

  it('expires entries past the queue TTL with reason expired', () => {
    let now = 1_000_000;
    const queue = new TaskQueue({
      journal: f.eventRepo,
      now: () => now,
      queuedTtlMs: 60_000,
    });
    const task = makeTask(f);
    f.insertSession(task.id, 'sess_ttl', 'pending');
    queue.enqueue({
      taskId: task.id,
      agentId: f.agentId,
      projectId: f.projectId,
      priority: 'MED',
      agentTier: 'B',
      sessionId: 'sess_ttl',
      spec: { workingDir: '/repo/wt' },
    });
    now += 120_000; // past the 60s TTL
    expect(queue.snapshot()).toHaveLength(0);
    expect(queue.isQueued(task.id)).toBe(false);
    const rows = f.eventsOf(task.id, 'TaskDequeued');
    expect(rows[0]!.payload['reason']).toBe('expired');
  });

  it('reports waiting: session busy when the lane is occupied', () => {
    const busyQueue = new TaskQueue({
      journal: f.eventRepo,
      isProviderBusy: () => true,
    });
    const task = makeTask(f);
    f.insertSession(task.id, 'sess_busy', 'pending');
    busyQueue.enqueue({
      taskId: task.id,
      agentId: f.agentId,
      projectId: f.projectId,
      priority: 'MED',
      agentTier: 'B',
      sessionId: 'sess_busy',
      spec: { workingDir: '/repo/wt' },
    });
    expect(busyQueue.snapshot()[0]!.waitReason).toBe('waiting: session busy');
  });

  it('a failed enqueue journals nothing and tracks nothing', () => {
    const failing = {
      insert: () => {
        throw new Error('disk full');
      },
      getById: () => null,
      listByTask: () => [],
      listBySession: () => [],
      listByTimestampRange: () => [],
    };
    const queue = new TaskQueue({ journal: failing });
    const task = makeTask(f);
    expect(() =>
      queue.enqueue({
        taskId: task.id,
        agentId: f.agentId,
        priority: 'MED',
        agentTier: 'B',
        spec: { workingDir: '/repo/wt' },
      }),
    ).toThrow('disk full');
    expect(queue.isQueued(task.id)).toBe(false);
  });

  it('re-enqueue of the same task is idempotent — same entry, one event', () => {
    const task = makeTask(f);
    const first = enqueue(task.id);
    const second = enqueue(task.id);
    expect(second.sessionId).toBe(first.sessionId);
    expect(f.eventsOf(task.id, 'TaskQueued')).toHaveLength(1);
  });
});

/* ================================================================== *
 * Integration: restart rebuild from the journal
 * ================================================================== */

describe('TaskQueue — restart rebuild', () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  it('rebuild materializes the same queue from journaled events', () => {
    const a = makeTask(f, { id: 'task_a' });
    const b = makeTask(f, { id: 'task_b', priority: 'HIGH' });
    const done = makeTask(f, { id: 'task_done' });

    for (const [task, priority] of [
      [a, 'MED'],
      [b, 'HIGH'],
      [done, 'MED'],
    ] as const) {
      f.insertSession(task.id, `sess_${task.id}`, 'pending');
      f.queue.enqueue({
        taskId: task.id,
        agentId: f.agentId,
        projectId: f.projectId,
        priority,
        agentTier: 'B',
        sessionId: `sess_${task.id}`,
        spec: { workingDir: '/repo/wt', verifyCommands: ['npm test'] },
      });
    }
    // `done` leaves the queue before the "restart".
    f.queue.dequeue(done.id, 'scheduled');

    // Simulate restart: a fresh queue on the same journal.
    const rebuilt = new TaskQueue({ journal: f.eventRepo });
    rebuilt.rebuild();

    const snap = rebuilt.snapshot();
    expect(snap.map((e) => e.taskId)).toEqual([b.id, a.id]); // HIGH first
    expect(snap[0]!.sessionId).toBe(`sess_${b.id}`);
    expect(snap[0]!.spec.verifyCommands).toEqual(['npm test']);
    expect(snap[0]!.spec.workingDir).toBe('/repo/wt');
    expect(snap[0]!.position).toBe(1);
    expect(snap.some((e) => e.taskId === done.id)).toBe(false);
  });

  it('a later AgentStarted or AgentStopped closes the entry — no stale re-queue', () => {
    const task = makeTask(f);
    f.insertSession(task.id, 'sess_1', 'pending');
    const entry = f.queue.enqueue({
      taskId: task.id,
      agentId: f.agentId,
      projectId: f.projectId,
      priority: 'MED',
      agentTier: 'B',
      sessionId: 'sess_1',
      spec: { workingDir: '/repo/wt' },
    });
    // A dispatch journaled AgentStarted on the reserved session id —
    // the dequeue journal entry was lost in a crash. Rebuild must still
    // close the entry: the session id proves the queue slot was used.
    f.sessionRepo.update({
      id: 'sess_1',
      taskId: task.id,
      agentId: f.agentId,
      status: 'running',
      startedAt: new Date().toISOString(),
      eventIds: [],
      deliverableIds: [],
      capsuleId: 'cap_x',
    });
    f.eventRepo.insert({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      taskId: task.id,
      sessionId: entry.sessionId,
      timestamp: new Date().toISOString(),
      kind: 'AgentStarted',
      payload: {},
    });

    const rebuilt = new TaskQueue({ journal: f.eventRepo });
    rebuilt.rebuild();
    expect(rebuilt.isQueued(task.id)).toBe(false);
  });
});

/* ================================================================== *
 * Integration: CommandApi enqueue → scheduled dispatch → cancel
 * ================================================================== */

describe('CommandApi — durable queue path', () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  function apiWithAdapter(adapter: AgentRuntimePort): {
    api: CommandApi;
    sm: SessionManager;
  } {
    let api!: CommandApi;
    const sm = new SessionManager(f.eventBus, {
      onSessionEnd: async () => {
        await api.drainQueue();
      },
    });
    f.smRef.current = sm;
    api = new CommandApi({ ...queueDeps(f, adapter), sessionManager: sm });
    return { api, sm };
  }

  const startTask = (api: CommandApi, taskId: string): Promise<StartTaskResponse> =>
    api.execute({
      kind: 'start-task',
      taskId,
      agentId: f.agentId,
      sessionConfig: { workingDir: '/repo/wt' },
    }) as Promise<StartTaskResponse>;

  it('dispatches immediately when the lane is idle — queued then scheduled', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const task = makeTask(f);

    const res = await startTask(api, task.id);
    expect(res.ok).toBe(true);
    expect(res.queued).not.toBe(true);
    expect(adapter.runs).toHaveLength(1);

    // Journal proves the path: enqueued, dispatched (AgentStarted),
    // dequeued as scheduled — all under the reserved session id.
    expect(f.eventsOf(task.id, 'TaskQueued')).toHaveLength(1);
    expect(f.eventsOf(task.id, 'TaskDequeued')[0]!.payload['reason']).toBe('scheduled');
    const session = f.sessionRepo.getById(res.sessionId);
    expect(session?.status).toBe('running');
    expect(f.queue.isQueued(task.id)).toBe(false);
  });

  it('queues behind a busy lane and reports position + wait reason', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const first = makeTask(f, { id: 'task_first' });
    const second = makeTask(f, { id: 'task_second' });

    await startTask(api, first.id); // occupies the lane
    const res = await startTask(api, second.id);

    expect(res.ok).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.queuePosition).toBe(1);
    expect(res.waitReason).toBe('waiting: session busy');
    expect(adapter.runs).toHaveLength(1); // nothing spawned for the queued task

    // The reserved session row exists as pending — the TaskQueued FK held.
    const pending = f.sessionRepo.getById(res.sessionId);
    expect(pending?.status).toBe('pending');
    expect(f.queue.isQueued(second.id)).toBe(true);
  });

  it('priority promotes a later submission ahead of an earlier queued one', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const busy = makeTask(f, { id: 'task_busy' });
    const normal = makeTask(f, { id: 'task_normal' });
    const urgent = makeTask(f, { id: 'task_urgent', priority: 'HIGH' });

    await startTask(api, busy.id);
    const r1 = await startTask(api, normal.id);
    const r2 = await startTask(api, urgent.id);
    expect(r1.queued).toBe(true);
    expect(r2.queued).toBe(true);
    // Promotion is visible in the materialized order: HIGH sits ahead
    // of the earlier MED submission even though it arrived second.
    const q = (await api.execute({ kind: 'query-queue' })) as {
      entries: { taskId: string; position: number }[];
    };
    expect(q.entries.map((e) => e.taskId)).toEqual([urgent.id, normal.id]);
    expect(r2.queuePosition).toBe(1); // promoted ahead of normal at submit
  });

  it('cancelling a queued task removes it without spawning anything', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const busy = makeTask(f, { id: 'task_busy' });
    const queued = makeTask(f, { id: 'task_queued' });

    await startTask(api, busy.id);
    const qres = await startTask(api, queued.id);
    expect(qres.queued).toBe(true);

    const stop = await api.execute({ kind: 'stop-task', taskId: queued.id });
    expect(stop.ok).toBe(true);

    expect(f.queue.isQueued(queued.id)).toBe(false);
    expect(f.eventsOf(queued.id, 'TaskDequeued')[0]!.payload['reason']).toBe('cancelled');
    // The reserved session never ran — marked stopped, not running.
    expect(f.sessionRepo.getById(qres.sessionId)?.status).toBe('stopped');
    // No second adapter run ever happened.
    expect(adapter.runs).toHaveLength(1);
    expect(f.sm.getCurrentState(queued.id)).toBe(TaskState.Cancelled);
  });

  it('a freed lane drains the queue and dispatches the waiting head', async () => {
    // The first dispatch holds the lane (blocking adapter); the second
    // queues. When the first session is stopped the lane frees, the
    // onSessionEnd hook drains the queue, and the queued task spawns —
    // on the second adapter, with its reserved session id.
    const first = new BlockingAdapter();
    let api!: CommandApi;
    let nextAdapter = new BlockingAdapter();
    const sm = new SessionManager(f.eventBus, {
      onSessionEnd: async () => {
        await api.drainQueue();
      },
    });
    f.smRef.current = sm;
    const api1 = new CommandApi({
      ...queueDeps(f, first),
      adapterRegistry: { create: () => first, has: () => true, list: () => ['codex'] },
      sessionManager: sm,
    });
    api = api1;
    const api2 = new CommandApi({
      ...queueDeps(f, nextAdapter),
      adapterRegistry: {
        create: () => nextAdapter,
        has: () => true,
        list: () => ['codex'],
      },
      sessionManager: sm,
    });
    api = api2; // drains dispatch through api2's registry

    const busy = makeTask(f, { id: 'task_busy' });
    const queued = makeTask(f, { id: 'task_queued' });

    const r1 = await startTask(api1, busy.id);
    expect(r1.ok).toBe(true);
    const r2 = await startTask(api2, queued.id);
    expect(r2.queued).toBe(true);
    const reservedId = r2.sessionId;

    // Stop the busy run — the session ends, the lane frees, the drain
    // dispatches the queued head through api2's adapter.
    await sm.stopSession(busy.id);
    await settle(() => nextAdapter.runs.length === 1);

    expect(f.queue.isQueued(queued.id)).toBe(false);
    expect(nextAdapter.runs[0]?.sessionId).toBe(reservedId);
    expect(f.sessionRepo.getById(reservedId)?.status).toBe('running');
    expect(f.eventsOf(queued.id, 'TaskDequeued')[0]!.payload['reason']).toBe('scheduled');
  });

  it('stop-task on a queued task leaves the running session untouched', async () => {
    const adapter = new BlockingAdapter();
    const { api, sm } = apiWithAdapter(adapter);
    const busy = makeTask(f, { id: 'task_busy' });
    const queued = makeTask(f, { id: 'task_queued' });

    await startTask(api, busy.id);
    await startTask(api, queued.id);
    await api.execute({ kind: 'stop-task', taskId: queued.id });

    expect(sm.activeCount).toBe(1); // the busy session is still running
  });

  it('query-queue exposes queued state; list-tasks annotates it', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const busy = makeTask(f, { id: 'task_busy' });
    const queued = makeTask(f, { id: 'task_queued' });
    await startTask(api, busy.id);
    await startTask(api, queued.id);

    const q = await api.execute({ kind: 'query-queue' });
    expect(q.ok).toBe(true);
    if (q.ok && 'entries' in q) {
      expect(q.entries).toHaveLength(1);
      expect(q.entries[0]!.taskId).toBe(queued.id);
      expect(q.entries[0]!.waitReason).toBe('waiting: session busy');
      expect(q.entries[0]!.position).toBe(1);
    }

    const list = await api.execute({ kind: 'list-tasks' });
    if (list.ok && 'tasks' in list) {
      const row = list.tasks.find((t) => t.id === queued.id);
      expect(row?.queueState?.position).toBe(1);
      expect(row?.queueState?.waitReason).toBe('waiting: session busy');
      // The busy task is not queue-annotated.
      const busyRow = list.tasks.find((t) => t.id === busy.id);
      expect(busyRow?.queueState).toBeUndefined();
    }
  });

  it('restart rebuild produces the same queue and dispatches the reserved session', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const busy = makeTask(f, { id: 'task_busy' });
    const queued = makeTask(f, { id: 'task_queued' });

    await startTask(api, busy.id);
    const qres = await startTask(api, queued.id);
    expect(qres.queued).toBe(true);
    const reservedId = qres.sessionId;

    // Simulate restart: a fresh queue + api over the same journal. The
    // new SessionManager has no live sessions — the lane reads as idle,
    // so the rebuilt head dispatches on drain with the reserved id.
    const q2 = new TaskQueue({
      journal: f.eventRepo,
      publish: (e) => f.eventBus.publish(e),
    });
    q2.rebuild();
    expect(q2.isQueued(queued.id)).toBe(true);
    const snap = q2.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.sessionId).toBe(reservedId);
    expect(snap[0]!.spec.workingDir).toBe('/repo/wt');

    const adapter2 = new BlockingAdapter();
    let api2!: CommandApi;
    const sm2 = new SessionManager(f.eventBus, {
      onSessionEnd: async () => {
        await api2.drainQueue();
      },
    });
    f.smRef.current = sm2;
    api2 = new CommandApi({
      ...queueDeps(f, adapter2),
      taskQueue: q2,
      sessionManager: sm2,
    });

    await api2.drainQueue();
    expect(q2.isQueued(queued.id)).toBe(false);
    expect(f.eventsOf(queued.id, 'TaskDequeued').at(-1)!.payload['reason']).toBe('scheduled');
    // The dispatch used the reserved run id — the pending row flipped
    // to running instead of a duplicate session being inserted.
    expect(adapter2.runs[0]?.sessionId).toBe(reservedId);
    expect(f.sessionRepo.getById(reservedId)?.status).toBe('running');
  });
});

/* ================================================================== *
 * Integration: capacity- and consent-gated parallelism (issue #344)
 * ================================================================== */

describe('start-task + scheduler policy (issue #344)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
  });
  afterEach(() => {
    f.db.close();
  });

  function apiWithAdapter(
    adapter: AgentRuntimePort,
    opts: { ledger?: QuotaLedger } = {},
  ): { api: CommandApi; sm: SessionManager; writer: EventJournalWriter } {
    let api!: CommandApi;
    const sm = new SessionManager(f.eventBus, {
      onSessionEnd: async () => {
        await api.drainQueue();
      },
    });
    f.smRef.current = sm;
    // The journal writer mirrors the daemon's composition — decisions
    // are bus-published facts the writer lands in the journal.
    const writer = new EventJournalWriter({ journal: f.eventRepo, bus: f.eventBus });
    writer.start();
    api = new CommandApi({
      ...queueDeps(f, adapter),
      sessionManager: sm,
      ...(opts.ledger !== undefined ? { quotaLedger: opts.ledger } : {}),
    });
    return { api, sm, writer };
  }

  const startTask = (
    api: CommandApi,
    taskId: string,
    opts: { parallel?: boolean } = {},
  ): Promise<StartTaskResponse> =>
    api.execute({
      kind: 'start-task',
      taskId,
      agentId: f.agentId,
      ...(opts.parallel === true ? { parallel: true } : {}),
      sessionConfig: { workingDir: '/repo/wt' },
    }) as Promise<StartTaskResponse>;

  it('a parallelizable task dispatches alongside a busy provider session', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const running = makeTask(f, { id: 'task_running' });
    const parallel = makeTask(f, { id: 'task_parallel', parallelizable: true });

    await startTask(api, running.id);
    const res = await startTask(api, parallel.id);

    expect(res.ok).toBe(true);
    expect(res.queued).not.toBe(true);
    expect(adapter.runs).toHaveLength(2);
    expect(f.queue.isQueued(parallel.id)).toBe(false);
    expect(f.eventsOf(parallel.id, 'TaskDequeued')[0]!.payload['reason']).toBe('scheduled');

    // The consent flag was journaled on the queue event, not inferred.
    const queued = f.eventsOf(parallel.id, 'TaskQueued');
    expect(queued[0]!.payload['parallelizable']).toBe(true);

    const decisions = f.eventsOf(parallel.id, 'RoutingDecision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload['decision']).toBe('parallel-ok');
    expect(decisions[0]!.payload['parallelRequested']).toBe(true);
  });

  it('a non-consented task stays queued behind a busy provider with a journaled reason', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const running = makeTask(f, { id: 'task_running' });
    const serial = makeTask(f, { id: 'task_serial' });

    await startTask(api, running.id);
    const res = await startTask(api, serial.id);

    expect(res.ok).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.waitReason).toBe('waiting: session busy');
    expect(adapter.runs).toHaveLength(1);

    const decisions = f.eventsOf(serial.id, 'RoutingDecision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload['decision']).toBe('session-busy');
    expect(decisions[0]!.payload['parallelRequested']).toBe(false);
  });

  it('a consented task with no quota headroom parks with the ledger resume time', async () => {
    const adapter = new BlockingAdapter();
    const ledger = new QuotaLedger();
    ledger.markExhausted(f.agentId, { resetsAt: '2026-10-11T06:00:00.000Z' });
    const { api } = apiWithAdapter(adapter, { ledger });
    const running = makeTask(f, { id: 'task_running' });
    const parked = makeTask(f, { id: 'task_parked', parallelizable: true });

    await startTask(api, running.id);
    const res = await startTask(api, parked.id);

    expect(res.ok).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.waitReason).toBe('waiting: quota — resets at 2026-10-11T06:00:00.000Z');
    expect(adapter.runs).toHaveLength(1);
    expect(f.queue.isQueued(parked.id)).toBe(true);

    const decisions = f.eventsOf(parked.id, 'RoutingDecision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload['decision']).toBe('quota-blocked');
    expect(decisions[0]!.payload['resumeAt']).toBe('2026-10-11T06:00:00.000Z');
  });

  it('a user parallel verb dispatches while the provider is busy', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const running = makeTask(f, { id: 'task_running' });
    const asked = makeTask(f, { id: 'task_asked' });

    await startTask(api, running.id);
    const res = await startTask(api, asked.id, { parallel: true });

    expect(res.ok).toBe(true);
    expect(adapter.runs).toHaveLength(2);
    expect(f.eventsOf(asked.id, 'TaskQueued')[0]!.payload['userRequestedParallel']).toBe(true);
    expect(f.eventsOf(asked.id, 'RoutingDecision')[0]!.payload['decision']).toBe('parallel-ok');
  });

  it('journals a wait verdict once — repeated pumps do not re-journal', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const running = makeTask(f, { id: 'task_running' });
    const serial = makeTask(f, { id: 'task_serial' });
    const serial2 = makeTask(f, { id: 'task_serial2' });

    await startTask(api, running.id);
    await startTask(api, serial.id);
    await startTask(api, serial2.id); // a second pump ticks over the lane

    expect(f.eventsOf(serial.id, 'RoutingDecision')).toHaveLength(1);
    expect(f.eventsOf(serial2.id, 'RoutingDecision')).toHaveLength(0); // never pumped — behind head
    expect(f.queue.snapshot().map((e) => e.waitReason)).toEqual([
      'waiting: session busy',
      'waiting: session busy',
    ]);
  });

  /* Fleet view (issue #345): the queue surface answers "where is my
   * task" from the same snapshot the scheduler holds — position,
   * provider lane, reserved session, computed wait reason, and the
   * journaled quota reset as the only clock estimate. */
  it('query-fleet reports queued tasks with position, reason, and reserved session', async () => {
    const adapter = new BlockingAdapter();
    const { api } = apiWithAdapter(adapter);
    const running = makeTask(f, { id: 'task_running' });
    const queued = makeTask(f, { id: 'task_queued', objective: 'queued probe' });

    await startTask(api, running.id);
    await startTask(api, queued.id);

    const res = (await api.execute({ kind: 'query-fleet' })) as FleetResponse;
    expect(res.ok).toBe(true);
    const row = res.queue.find((q) => q.taskId === queued.id);
    expect(row).toBeDefined();
    expect(row!.objective).toBe('queued probe');
    expect(row!.position).toBe(1);
    expect(row!.provider).toBe(f.agentId);
    expect(row!.waitReason).toBe('waiting: session busy');
    expect(row!.resumeAt).toBeNull();
    expect(row!.sessionId).toBe(f.queue.get(queued.id)!.sessionId);
    // A dispatched task does not linger in the queue section.
    expect(res.queue.some((q) => q.taskId === running.id)).toBe(false);
    // The scheduler's verdict is explainable in the decision feed too.
    expect(
      res.routingDecisions.some(
        (d) => d.kind === 'RoutingDecision' && d.summary.includes('session-busy'),
      ),
    ).toBe(true);
  });

  it('query-fleet carries the journaled quota reset for a blocked parallel entry', async () => {
    const adapter = new BlockingAdapter();
    const ledger = new QuotaLedger();
    ledger.markExhausted(f.agentId, { resetsAt: '2026-10-11T06:00:00.000Z' });
    const { api } = apiWithAdapter(adapter, { ledger });
    const running = makeTask(f, { id: 'task_running' });
    const parked = makeTask(f, { id: 'task_parked', parallelizable: true });

    await startTask(api, running.id);
    await startTask(api, parked.id);

    const res = (await api.execute({ kind: 'query-fleet' })) as FleetResponse;
    const row = res.queue.find((q) => q.taskId === parked.id);
    expect(row!.resumeAt).toBe('2026-10-11T06:00:00.000Z');
    expect(row!.waitReason).toContain('quota');
  });
});
