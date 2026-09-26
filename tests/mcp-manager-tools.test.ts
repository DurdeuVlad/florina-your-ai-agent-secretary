import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  ManagerToolService,
  florinaMcpSpec,
} from '../src/core/application/use-cases/managers/manager-tools.js';
import { CommandApi } from '../src/core/application/use-cases/tasks/command-api.js';
import type { CommandApiDeps } from '../src/core/application/use-cases/tasks/command-api.js';
import { CapacityRouter } from '../src/core/application/use-cases/routing/capacity-router.js';
import { QuotaLedger } from '../src/core/application/use-cases/routing/quota-ledger.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import { EventJournalWriter } from '../src/core/application/use-cases/journal/event-journal-writer.js';
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

interface Fixture {
  service: ManagerToolService;
  api: CommandApi;
  inbox: AttentionInbox;
  taskStore: TaskRepository;
  eventRepo: EventRepository;
  ledger: QuotaLedger;
  createWorktree: ReturnType<typeof vi.fn>;
  projectId: string;
}

function createFixture(
  rules: { provider: string; model?: string; workTypes?: string[] }[],
  mcpUrl?: string,
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
  const eventBus = new EventBus();
  // Journals bus-published adapter/daemon events (e.g. AgentStarted) —
  // without this, CommandApi's eventBus.publish never reaches eventRepo.
  new EventJournalWriter({ journal: eventRepo, bus: eventBus }).start();

  // The service and CommandApi share the real task repository: the state
  // machine reads what the service writes.
  const deps: CommandApiDeps = {
    eventBus,
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

  const createWorktree = vi.fn(() => '/repo/.florina-worktrees/task-1');
  const service = new ManagerToolService({
    commandApi: api,
    router,
    taskStore: taskRepo,
    worktreeManager: { createWorktree },
    repoPath: '/repo',
    projectId: project.id,
    ...(mcpUrl !== undefined ? { mcpUrl } : {}),
  });
  return {
    service,
    api,
    inbox,
    taskStore: taskRepo,
    eventRepo,
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
    expect(task!.worktreePath).toBe('/repo/.florina-worktrees/task-1');
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

  it('carries a caller-compiled Execution Brief through to the journaled AgentStarted event (issue #209)', async () => {
    const executionBrief = {
      objective: 'implement the widget',
      relevantContext: ['This project uses hexagonal architecture.'],
      applicableRules: [
        {
          id: 'r-1',
          statement: 'Reproduce before fixing.',
          provenance: 'explicit' as const,
          scope: { type: 'global' as const },
        },
      ],
      constraints: ['Do not touch unrelated files.'],
      requiredVerification: ['npm test'],
      definitionOfDone: 'Widget implemented; tests pass.',
      providerRationale: 'Codex — routing preference for this work type.',
    };

    const res = await fx.service.spawnTask({ objective: 'implement the widget', executionBrief });
    expect(res.status).toBe('spawned');
    if (res.status !== 'spawned') return;

    // TaskStateMachine's own Created->Delegated transition journals a
    // *different* record that happens to reuse the same journal `kind`
    // string ('AgentStarted') for its own purposes (fromState/toState
    // payload) — distinguish the canonical SupervisorEvent by its
    // `objective` field, unique to the real dispatch event.
    const events = fx.eventRepo
      .listByTask(res.taskId)
      .filter((e) => e.kind === 'AgentStarted' && 'objective' in e.payload);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['executionBrief']).toEqual(executionBrief);
  });

  it('spawns fine with no Execution Brief (optional, unchanged default behavior)', async () => {
    const res = await fx.service.spawnTask({ objective: 'implement the widget' });
    expect(res.status).toBe('spawned');
    if (res.status !== 'spawned') return;
    const events = fx.eventRepo
      .listByTask(res.taskId)
      .filter((e) => e.kind === 'AgentStarted' && 'objective' in e.payload);
    expect(events[0]!.payload['executionBrief']).toBeUndefined();
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

describe('manager launch config (issue #63)', () => {
  const MCP_URL = 'http://127.0.0.1:9090/mcp';

  it('florinaMcpSpec carries the project-scoping header', () => {
    expect(florinaMcpSpec(MCP_URL, 'proj-1')).toEqual({
      name: 'florina',
      url: MCP_URL,
      headers: { 'x-florina-project': 'proj-1' },
    });
  });

  it('spawnManagerTask registers the Florina MCP server in the launch config', async () => {
    const fx = createFixture([{ provider: 'codex' }], MCP_URL);
    const execute = vi.spyOn(fx.api, 'execute');
    const res = await fx.service.spawnManagerTask({ objective: 'manage project alpha' });
    expect(res.status).toBe('spawned');
    const startCall = execute.mock.calls.map(([cmd]) => cmd).find((c) => c.kind === 'start-task');
    expect(startCall).toBeDefined();
    if (startCall?.kind === 'start-task') {
      expect(startCall.sessionConfig.mcpServers).toEqual([
        {
          name: 'florina',
          url: MCP_URL,
          headers: { 'x-florina-project': fx.projectId },
        },
      ]);
    }
  });

  it('spawnManagerTask routes under the manage work type', async () => {
    const fx = createFixture([{ provider: 'codex', workTypes: ['manage'] }], MCP_URL);
    const res = await fx.service.spawnManagerTask({ objective: 'manage it' });
    expect(res).toMatchObject({ status: 'spawned', provider: 'codex' });
  });

  it('spawnManagerTask errors when the MCP server is not listening', async () => {
    const fx = createFixture([{ provider: 'codex' }]); // no mcpUrl
    const res = await fx.service.spawnManagerTask({ objective: 'manage it' });
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.error).toContain('MCP');
    }
    expect(fx.taskStore.listAll()).toHaveLength(0);
    expect(fx.createWorktree).not.toHaveBeenCalled();
  });

  it('spawnTask workers do NOT get the MCP registration', async () => {
    const fx = createFixture([{ provider: 'codex' }], MCP_URL);
    const execute = vi.spyOn(fx.api, 'execute');
    await fx.service.spawnTask({ objective: 'worker task' });
    const startCall = execute.mock.calls.map(([cmd]) => cmd).find((c) => c.kind === 'start-task');
    if (startCall?.kind === 'start-task') {
      expect(startCall.sessionConfig.mcpServers).toBeUndefined();
    }
  });
});
