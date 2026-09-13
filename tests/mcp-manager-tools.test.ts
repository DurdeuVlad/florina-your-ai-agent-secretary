import { describe, it, expect, beforeEach, vi } from 'vitest';

import { ManagerToolService } from '../src/core/application/use-cases/managers/manager-tools.js';
import { CommandApi } from '../src/core/application/use-cases/tasks/command-api.js';
import type { CommandApiDeps } from '../src/core/application/use-cases/tasks/command-api.js';
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
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import { buildProject, TaskState } from '../src/core/domain/index.js';
import type { Task } from '../src/core/domain/types.js';

interface Fixture {
  service: ManagerToolService;
  api: CommandApi;
  inbox: AttentionInbox;
  taskStore: TaskRepository;
  ledger: QuotaLedger;
  createWorktree: ReturnType<typeof vi.fn>;
  projectId: string;
}

function createFixture(
  rules: { provider: string; model?: string; workTypes?: string[] }[],
): Fixture {
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

  // Provider ids are used as agent ids when the router picks a provider;
  // the sessions.agent_id FK requires matching agent rows.
  for (const providerId of ['codex', 'claude-code', 'devin', 'gemini']) {
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

  const inbox = new AttentionInbox();

  // The service and CommandApi share the real task repository: the state
  // machine reads what the service writes.
  const deps: CommandApiDeps = {
    eventBus: new EventBus(),
    taskStateMachine: new TaskStateMachine(taskRepo, eventRepo),
    attentionInbox: inbox,
    metricsCollector: new MetricsCollector(),
    worktreeManager: { pruneWorktree: vi.fn(), detectDirty: vi.fn(() => false) } as never,
    eventRepository: eventRepo,
    taskStore: taskRepo,
    approvalStore: approvalRepo,
    sessionStore: sessionRepo,
  };
  const api = new CommandApi(deps);

  const ledger = new QuotaLedger();
  const router = new CapacityRouter({
    ledger,
    profile: { rules, denied: [] },
  });

  const createWorktree = vi.fn(() => '/repo/.secretary-worktrees/task-1');
  const service = new ManagerToolService({
    commandApi: api,
    router,
    taskStore: taskRepo,
    worktreeManager: { createWorktree },
    repoPath: '/repo',
    projectId: project.id,
  });
  return {
    service,
    api,
    inbox,
    taskStore: taskRepo,
    ledger,
    createWorktree,
    projectId: project.id,
  };
}

describe('ManagerToolService', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture([{ provider: 'codex' }, { provider: 'claude-code' }]);
  });

  it('spawnTask routes, creates the task + worktree, and starts a session', async () => {
    const res = await fx.service.spawnTask({ objective: 'implement the widget' });
    expect(res.status).toBe('spawned');
    if (res.status !== 'spawned') return;
    expect(res.provider).toBe('codex');
    expect(res.sessionId).toBeTruthy();
    expect(fx.createWorktree).toHaveBeenCalledOnce();
    const task = fx.taskStore.getById(res.taskId);
    expect(task).not.toBeNull();
    expect(task!.projectId).toBe(fx.projectId);
    expect(task!.worktreePath).toBe('/repo/.secretary-worktrees/task-1');
    const status = await fx.service.getTaskStatus({ taskId: res.taskId });
    expect(status).not.toBeNull();
  });

  it('honors the manager preferred provider when eligible', async () => {
    const res = await fx.service.spawnTask({
      objective: 'do the thing',
      preferProvider: 'claude-code',
    });
    expect(res).toMatchObject({ status: 'spawned', provider: 'claude-code' });
  });

  it('falls back to preference rules when the preferred provider is exhausted', async () => {
    fx.ledger.markExhausted('claude-code');
    const res = await fx.service.spawnTask({
      objective: 'do the thing',
      preferProvider: 'claude-code',
    });
    expect(res).toMatchObject({ status: 'spawned', provider: 'codex' });
  });

  it('parks instead of creating a task when all candidates are exhausted', async () => {
    fx.ledger.markExhausted('codex');
    fx.ledger.markExhausted('claude-code');
    const res = await fx.service.spawnTask({ objective: 'do the thing' });
    expect(res.status).toBe('parked');
    expect(fx.createWorktree).not.toHaveBeenCalled();
    expect(fx.taskStore.listAll()).toHaveLength(0);
  });

  it('rejects empty objectives without side effects', async () => {
    const res = await fx.service.spawnTask({ objective: '   ' });
    expect(res.status).toBe('error');
    expect(fx.taskStore.listAll()).toHaveLength(0);
  });

  it('requestHumanInput raises an inbox item through the command API', async () => {
    const res = await fx.service.requestHumanInput({
      taskId: 'task_x',
      question: 'Which DB should this project use?',
      priority: 'High',
    });
    expect(res.ok).toBe(true);
    const items = await fx.service.getInbox();
    expect(items).toHaveLength(1);
    expect(items[0].taskId).toBe('task_x');
    expect(items[0].priority).toBe('High');
    expect(items[0].payload).toMatchObject({
      summary: 'Which DB should this project use?',
      source: 'manager',
    });
  });

  it('requestHumanInput validates input', async () => {
    const res = await fx.service.requestHumanInput({ taskId: 'task_x', question: '' });
    expect(res.ok).toBe(false);
    expect(fx.inbox.list()).toHaveLength(0);
  });

  it('listTasks filters by state', async () => {
    await fx.service.spawnTask({ objective: 'one' });
    const all = await fx.service.listTasks();
    expect(all).toHaveLength(1);
    const running = await fx.service.listTasks({ status: TaskState.Running });
    const cancelled = await fx.service.listTasks({ status: TaskState.Cancelled });
    expect(cancelled).toHaveLength(0);
    expect(running.length + cancelled.length).toBeLessThanOrEqual(1);
  });
});
