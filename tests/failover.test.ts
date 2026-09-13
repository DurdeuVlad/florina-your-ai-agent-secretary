import { describe, it, expect, beforeEach } from 'vitest';

import { FailoverService } from '../src/core/application/use-cases/tasks/failover.js';
import { buildFailoverPrompt } from '../src/core/application/use-cases/tasks/failover.js';
import { CommandApi } from '../src/core/application/use-cases/tasks/command-api.js';
import type { CommandApiDeps } from '../src/core/application/use-cases/tasks/command-api.js';
import { SessionManager } from '../src/core/application/use-cases/tasks/session-manager.js';
import { CapacityRouter } from '../src/core/application/use-cases/routing/capacity-router.js';
import { QuotaLedger } from '../src/core/application/use-cases/routing/quota-ledger.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { MetricsCollector } from '../src/core/application/use-cases/metrics.js';
import { TaskStateMachine } from '../src/core/application/use-cases/tasks/task-lifecycle.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  ApprovalRepository,
  SessionRepository,
  ContextCapsuleRepository,
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import { buildProject, buildTask, buildTaskCapsule, TaskState } from '../src/core/domain/index.js';
import type { SupervisorEvent } from '../src/core/domain/events.js';
import type {
  AgentRuntimePort,
  SessionConfig,
  StartRunResult,
} from '../src/core/application/ports/outbound/agent-runtime.js';

/** Fake adapter that records lifecycle calls — proves freeze/resume semantics. */
class FakeAdapter implements AgentRuntimePort {
  readonly id: string;
  readonly fidelityTier = 'B' as const;
  connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  connectCalls = 0;
  disconnectCalls = 0;
  cancelCalls: string[] = [];
  runs: { taskId: string; config: SessionConfig }[] = [];
  private seq = 0;

  constructor(id: string) {
    this.id = id;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connectionState = 'connected';
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.seq += 1;
    this.runs.push({ taskId, config: sessionConfig });
    return { sessionId: `${this.id}-run-${this.seq}`, started: true };
  }

  streamEvents(): AsyncIterable<SupervisorEvent> {
    // Stays open until cancelled — the failover test freezes via stopSession.
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<SupervisorEvent>>(() => {}),
      }),
    };
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connectionState = 'disconnected';
  }
}

interface Fixture {
  service: FailoverService;
  api: CommandApi;
  ledger: QuotaLedger;
  bus: EventBus;
  taskRepo: TaskRepository;
  eventRepo: EventRepository;
  capsuleRepo: ContextCapsuleRepository;
  sessionManager: SessionManager;
  stateMachine: TaskStateMachine;
  adapters: Map<string, FakeAdapter>;
  published: SupervisorEvent[];
  projectId: string;
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

  for (const providerId of ['codex', 'claude-code', 'devin']) {
    raw
      .prepare(
        'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(providerId, providerId, providerId, 'D', '{}', new Date().toISOString());
  }

  const taskRepo = new TaskRepository(raw);
  const eventRepo = new EventRepository(raw);
  const approvalRepo = new ApprovalRepository(raw);
  const sessionRepo = new SessionRepository(raw);
  const capsuleRepo = new ContextCapsuleRepository(raw);
  const bus = new EventBus();
  const sessionManager = new SessionManager(bus);
  const stateMachine = new TaskStateMachine(taskRepo, eventRepo);

  const adapters = new Map<string, FakeAdapter>();
  const registry = {
    create(agentId: string): AgentRuntimePort {
      let adapter = adapters.get(agentId);
      if (adapter === undefined) {
        adapter = new FakeAdapter(agentId);
        adapters.set(agentId, adapter);
      }
      return adapter;
    },
  };

  const deps: CommandApiDeps = {
    eventBus: bus,
    taskStateMachine: stateMachine,
    attentionInbox: new AttentionInbox(),
    metricsCollector: new MetricsCollector(),
    worktreeManager: { pruneWorktree: () => {}, detectDirty: () => false } as never,
    eventRepository: eventRepo,
    taskStore: taskRepo,
    approvalStore: approvalRepo,
    sessionStore: sessionRepo,
    sessionManager,
    adapterRegistry: registry,
  };
  const api = new CommandApi(deps);

  const ledger = new QuotaLedger();
  const router = new CapacityRouter({
    ledger,
    profile: {
      rules: [{ provider: 'codex' }, { provider: 'claude-code' }, { provider: 'devin' }],
      denied: [],
    },
  });

  const service = new FailoverService({
    commandApi: api,
    taskStateMachine: stateMachine,
    sessionManager,
    router,
    taskStore: taskRepo,
    eventBus: bus,
    journal: eventRepo,
    capsuleStore: capsuleRepo,
  });

  const published: SupervisorEvent[] = [];
  bus.onEvent((event) => published.push(event));

  return {
    service,
    api,
    ledger,
    bus,
    taskRepo,
    eventRepo,
    capsuleRepo,
    sessionManager,
    stateMachine,
    adapters,
    published,
    projectId: project.id,
  };
}

/** Insert a task and start it on `provider`, leaving it `running`. */
async function startRunningTask(
  fx: Fixture,
  provider: string,
  worktreePath = '/repo/.secretary-worktrees/task-1',
): Promise<{ taskId: string; sessionId: string }> {
  const task = buildTask({
    projectId: fx.projectId,
    objective: 'implement the widget',
    worktreePath,
  });
  fx.taskRepo.insert(task);
  const res = await fx.api.execute({
    kind: 'start-task',
    taskId: task.id,
    agentId: provider,
    sessionConfig: { workingDir: worktreePath },
  });
  expect(res.ok).toBe(true);
  if (!('sessionId' in res)) throw new Error('expected sessionId');
  // Mirror production: the first adapter progress event moves the task
  // delegated -> running.
  fx.stateMachine.transition(task.id, TaskState.Delegated, TaskState.Running, {
    sessionId: res.sessionId,
    agentId: provider,
  });
  return { taskId: task.id, sessionId: res.sessionId };
}

describe('FailoverService', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  it('freezes the session and resumes on the next provider in the same worktree', async () => {
    const { taskId } = await startRunningTask(fx, 'codex');
    const codex = fx.adapters.get('codex')!;

    const res = await fx.service.failover({ taskId, reason: 'quota_exhausted' });

    expect(res.kind).toBe('failed-over');
    if (res.kind !== 'failed-over') return;
    expect(res.fromProvider).toBe('codex');
    expect(res.toProvider).toBe('claude-code');

    // Freeze: the old adapter was cancelled (with its run id) and disconnected.
    expect(codex.cancelCalls).toHaveLength(1);
    expect(codex.cancelCalls[0]).toBe('codex-run-1');
    expect(codex.disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(fx.sessionManager.hasSession(taskId)).toBe(true); // new session

    // Resume: the new adapter started in the SAME worktree with a briefing prompt.
    const claude = fx.adapters.get('claude-code')!;
    expect(claude.runs).toHaveLength(1);
    expect(claude.runs[0].config.workingDir).toBe('/repo/.secretary-worktrees/task-1');
    expect(claude.runs[0].config.objective).toContain('[failover briefing]');
    expect(claude.runs[0].config.objective).toContain('implement the widget');

    // Task state: running again, both providers recorded.
    const task = fx.taskRepo.getById(taskId)!;
    expect(task.state).toBe(TaskState.Running);
    expect(task.agentIds).toContain('codex');
    expect(task.agentIds).toContain('claude-code');

    // Journal: AgentBlocked (freeze) + TaskFailedOver (handoff).
    const journal = fx.eventRepo.listByTask(taskId);
    const kinds = journal.map((e) => e.kind);
    expect(kinds).toContain('AgentBlocked');
    expect(kinds).toContain('TaskFailedOver');
    const failedOver = journal.find((e) => e.kind === 'TaskFailedOver')!;
    expect(failedOver.payload).toMatchObject({
      fromProvider: 'codex',
      toProvider: 'claude-code',
      reason: 'quota_exhausted',
    });
    expect(failedOver.payload.routingReason).toBeTruthy();

    // Live subscribers saw it too.
    expect(fx.published.some((e) => e.type === 'TaskFailedOver')).toBe(true);
  });

  it('parks the task in blocked state when every candidate is exhausted', async () => {
    const { taskId } = await startRunningTask(fx, 'codex');
    fx.ledger.markExhausted('claude-code', { resetsAt: '2099-01-01T00:00:00.000Z' });
    fx.ledger.markExhausted('devin', { resetsAt: '2099-01-01T00:00:00.000Z' });

    const res = await fx.service.failover({ taskId, reason: 'quota_exhausted' });

    expect(res.kind).toBe('parked');
    if (res.kind !== 'parked') return;
    expect(res.resumeAt).toBe('2099-01-01T00:00:00.000Z');
    expect(fx.taskRepo.getById(taskId)!.state).toBe(TaskState.Blocked);
    expect(fx.sessionManager.hasSession(taskId)).toBe(false);

    const kinds = fx.eventRepo.listByTask(taskId).map((e) => e.kind);
    expect(kinds).toContain('TaskParked');
    // No new session was started on any provider.
    expect(fx.adapters.get('claude-code')).toBeUndefined();
  });

  it('resumes a parked task once capacity returns and journals TaskResumed', async () => {
    const { taskId } = await startRunningTask(fx, 'codex');
    fx.ledger.markExhausted('claude-code');
    fx.ledger.markExhausted('devin');
    const parked = await fx.service.failover({ taskId, reason: 'quota_exhausted' });
    expect(parked.kind).toBe('parked');

    // markExhausted writes a 'reactive' window — a fresh 'allowed'
    // observation for the same window key supersedes it (capacity returns).
    for (const provider of ['claude-code', 'devin']) {
      fx.ledger.recordWindow({
        provider,
        window: 'reactive',
        usedPct: 0.2,
        resetsAt: null,
        status: 'allowed',
        source: 'poller',
        observedAt: new Date(Date.now() + 1000).toISOString(),
      });
    }

    const res = await fx.service.resumeTask(taskId);
    expect(res.kind).toBe('resumed');
    if (res.kind !== 'resumed') return;
    // resumeTask re-routes through normal preference order — codex is the
    // first rule and never lost capacity, so the task resumes there.
    expect(res.provider).toBe('codex');
    expect(fx.taskRepo.getById(taskId)!.state).toBe(TaskState.Running);
    // A second run on the codex adapter, still in the same worktree.
    const codexRuns = fx.adapters.get('codex')!.runs;
    expect(codexRuns).toHaveLength(2);
    expect(codexRuns[1].config.workingDir).toBe('/repo/.secretary-worktrees/task-1');

    const kinds = fx.eventRepo.listByTask(taskId).map((e) => e.kind);
    expect(kinds).toContain('TaskResumed');
  });

  it('resumeParkedTasks resumes every blocked task with capacity', async () => {
    const a = await startRunningTask(fx, 'codex');
    fx.ledger.markExhausted('claude-code');
    fx.ledger.markExhausted('devin');
    await fx.service.failover({ taskId: a.taskId, reason: 'quota_exhausted' });
    fx.ledger.recordWindow({
      provider: 'devin',
      window: 'reactive',
      usedPct: 0.1,
      resetsAt: null,
      status: 'allowed',
      source: 'poller',
      observedAt: new Date(Date.now() + 1000).toISOString(),
    });

    const results = await fx.service.resumeParkedTasks();
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('resumed');
  });

  it('still-parks when resume finds no capacity', async () => {
    const { taskId } = await startRunningTask(fx, 'codex');
    fx.ledger.markExhausted('claude-code');
    fx.ledger.markExhausted('devin');
    await fx.service.failover({ taskId, reason: 'quota_exhausted' });

    // The whole fleet is dry — resume finds no candidate.
    fx.ledger.markExhausted('codex');
    const res = await fx.service.resumeTask(taskId);
    expect(res.kind).toBe('still-parked');
    expect(fx.taskRepo.getById(taskId)!.state).toBe(TaskState.Blocked);
  });

  it('rejects failover for tasks not in a resumable state', async () => {
    const task = buildTask({ projectId: fx.projectId, objective: 'x' });
    fx.taskRepo.insert(task);
    const res = await fx.service.failover({ taskId: task.id, reason: 'manual' });
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error).toContain('created');
  });

  it('rejects resumeTask for tasks that are not parked', async () => {
    const { taskId } = await startRunningTask(fx, 'codex');
    const res = await fx.service.resumeTask(taskId);
    expect(res.kind).toBe('error');
  });

  it('returns an error for unknown tasks', async () => {
    const res = await fx.service.failover({ taskId: 'task_nope', reason: 'error' });
    expect(res).toEqual({ kind: 'error', taskId: 'task_nope', error: 'Task not found: task_nope' });
  });

  it('folds Task Capsule run history into the failover prompt', async () => {
    const task = buildTask({
      projectId: fx.projectId,
      objective: 'ship the thing',
      worktreePath: '/wt',
    });
    fx.taskRepo.insert(task);
    const capsule = buildTaskCapsule({
      ownerId: task.id,
      content: {
        objective: task.objective,
        agentIds: ['codex'],
        runHistory: [
          {
            sessionId: 'sess_1',
            status: 'completed',
            startedAt: '2025-01-01T00:00:00.000Z',
            endedAt: '2025-01-01T01:00:00.000Z',
          },
        ],
        deliverableIds: [],
        rolledUpEventSummaries: ['Implemented 3 of 5 endpoints'],
      },
    });
    // Record the capsule on the task row the way the daemon does.
    fx.capsuleRepo.insert(capsule);
    fx.taskRepo.update({ ...task, capsuleId: capsule.id });

    const res = await fx.api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId: 'codex',
      sessionConfig: { workingDir: '/wt' },
    });
    expect(res.ok).toBe(true);

    const failover = await fx.service.failover({ taskId: task.id, reason: 'error' });
    expect(failover.kind).toBe('failed-over');
    const claude = fx.adapters.get('claude-code')!;
    const prompt = claude.runs[0].config.objective;
    expect(prompt).toContain('sess_1');
    expect(prompt).toContain('Implemented 3 of 5 endpoints');
    expect(prompt).toContain('ship the thing');
  });

  it('buildFailoverPrompt includes objective, worktree hint, and prior providers', () => {
    const task = buildTask({
      projectId: 'p1',
      objective: 'do the work',
      worktreePath: '/wt',
    });
    const prompt = buildFailoverPrompt({ ...task, agentIds: ['codex'], sessionIds: ['s1'] });
    expect(prompt).toContain('do the work');
    expect(prompt).toContain('same git worktree');
    expect(prompt).toContain('codex');
    expect(prompt).toContain('Prior sessions: 1');
  });
});
