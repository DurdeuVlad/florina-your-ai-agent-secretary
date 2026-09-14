import { describe, it, expect, beforeEach, vi } from 'vitest';

import { CommandApi } from '../src/daemon/command-api.js';
import type {
  Command,
  CommandApiDeps,
  TaskStore,
  ApprovalStore,
  SessionStore,
  StartTaskResponse,
  StopTaskResponse,
  ApproveResponse,
  InboxResponse,
  ItemMutationResponse,
  MetricsResponse,
  TaskResponse,
  TaskListResponse,
  EventsResponse,
  FleetResponse,
  PruneResponse,
  ShutdownResponse,
  DigestResponse,
  SecretaryResponse,
  MemoryWriteResponse,
  UnknownCommandResponse,
} from '../src/daemon/command-api.js';
import { EventBus } from '../src/daemon/event-stream.js';
import { QuotaLedger } from '../src/core/application/use-cases/routing/quota-ledger.js';
import { AttentionInbox } from '../src/attention/attention-inbox.js';
import { MetricsCollector } from '../src/daemon/metrics.js';
import { TaskStateMachine } from '../src/daemon/task-lifecycle.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  ApprovalRepository,
  SessionRepository,
  CompletionDigestRepository,
} from '../src/storage/index.js';
import {
  TaskState,
  buildProject,
  buildTask,
  buildApproval,
  buildAgent,
} from '../src/domain/index.js';
import type { Task, Approval } from '../src/domain/types.js';
import { DirtyWorktreeError } from '../src/daemon/worktree.js';
import { createAttentionItem } from '../src/attention/attention-item.js';
import type { CompletionDigest } from '../src/attention/completion-digest.js';

/* ================================================================== *
 * Test fixtures
 * ================================================================== */

/**
 * SQLite-backed TaskStore for testing. Reads from the real TaskRepository
 * so state changes made by the TaskStateMachine are reflected. Adds a
 * `listAll` method by querying all task IDs from the DB.
 */
class SqliteBackedTaskStore implements TaskStore {
  constructor(
    private readonly taskRepo: TaskRepository,
    private readonly db: StorageDatabase,
  ) {}

  getById(taskId: string): Task | null {
    return this.taskRepo.getById(taskId);
  }

  listAll(): readonly Task[] {
    const rows = this.db.connection
      .prepare('SELECT id FROM tasks ORDER BY created_at ASC')
      .all() as { id: string }[];
    return rows.map((r) => this.taskRepo.getById(r.id)).filter((t): t is Task => t !== null);
  }

  update(task: Task): void {
    this.taskRepo.update(task);
  }
}

/**
 * In-memory ApprovalStore implementation for testing.
 */
class InMemoryApprovalStore implements ApprovalStore {
  private readonly approvals = new Map<string, Approval>();

  insert(approval: Approval): void {
    this.approvals.set(approval.id, { ...approval });
  }

  getById(approvalId: string): Approval | null {
    const a = this.approvals.get(approvalId);
    return a ? { ...a } : null;
  }

  update(approval: Approval): void {
    this.approvals.set(approval.id, { ...approval });
  }
}

/**
 * Mock WorktreeManager that records calls and can simulate dirty worktrees.
 */
class MockWorktreeManager {
  pruneWorktree = vi.fn<(path: string) => void>();
  detectDirty = vi.fn<(path: string) => boolean>();

  /** Configure the mock to throw DirtyWorktreeError on the next prune. */
  simulateDirty(path: string): void {
    this.detectDirty.mockReturnValueOnce(true);
    this.pruneWorktree.mockImplementationOnce(() => {
      throw new DirtyWorktreeError(path);
    });
  }

  /** Configure the mock to succeed on the next prune. */
  simulateClean(): void {
    this.detectDirty.mockReturnValueOnce(false);
    this.pruneWorktree.mockImplementationOnce(() => {
      /* no-op — mock removal */
    });
  }
}

/**
 * Complete test fixture with all dependencies wired up.
 */
interface Fixture {
  api: CommandApi;
  deps: CommandApiDeps;
  eventBus: EventBus;
  taskStateMachine: TaskStateMachine;
  attentionInbox: AttentionInbox;
  metricsCollector: MetricsCollector;
  worktreeManager: MockWorktreeManager;
  eventRepository: EventRepository;
  taskStore: SqliteBackedTaskStore;
  approvalStore: InMemoryApprovalStore;
  sessionStore: SessionStore;
  onShutdown: ReturnType<typeof vi.fn>;
  db: StorageDatabase;
  completionDigestRepository: CompletionDigestRepository;
  /** The project ID created in the fixture (for task creation). */
  projectId: string;
  /** Helper: insert a task into both the task store and the SQLite repo. */
  insertTask(task: Task): void;
  /** Helper: insert an approval into the approval store and SQLite repo. */
  insertApproval(approval: Approval): void;
}

function createFixture(): Fixture {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const raw = db.connection;

  // Insert a project to satisfy FK constraints.
  const project = buildProject({ name: 'test-project', repo: { path: '/repo' } });
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

  // Insert an agent to satisfy FK constraints.
  const agent = buildAgent({
    name: 'Codex',
    provider: 'codex',
    fidelityTier: 'A',
    runtime: { kind: 'app-server' },
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

  const taskRepo = new TaskRepository(raw);
  const eventRepo = new EventRepository(raw);
  const approvalRepo = new ApprovalRepository(raw);
  const sessionRepo = new SessionRepository(raw);
  const completionDigestRepo = new CompletionDigestRepository(raw);

  const eventBus = new EventBus();
  const taskStateMachine = new TaskStateMachine(taskRepo, eventRepo);
  const attentionInbox = new AttentionInbox();
  const metricsCollector = new MetricsCollector();
  const worktreeManager = new MockWorktreeManager();

  const taskStore = new SqliteBackedTaskStore(taskRepo, db);
  const approvalStore = new InMemoryApprovalStore();
  const sessionStore: SessionStore = sessionRepo;
  const onShutdown = vi.fn();

  const deps: CommandApiDeps = {
    eventBus,
    taskStateMachine,
    attentionInbox,
    metricsCollector,
    worktreeManager,
    eventRepository: eventRepo,
    taskStore,
    approvalStore,
    sessionStore,
    completionDigestRepository: completionDigestRepo,
    onShutdown,
  };

  const api = new CommandApi(deps);

  const insertTask = (task: Task): void => {
    taskRepo.insert(task);
  };

  const insertApproval = (approval: Approval): void => {
    approvalRepo.insert(approval);
    approvalStore.insert(approval);
  };

  return {
    api,
    deps,
    eventBus,
    taskStateMachine,
    attentionInbox,
    metricsCollector,
    worktreeManager,
    eventRepository: eventRepo,
    taskStore,
    approvalStore,
    sessionStore,
    onShutdown,
    db,
    completionDigestRepository: completionDigestRepo,
    projectId: project.id,
    insertTask,
    insertApproval,
  };
}

/**
 * Create a task in the `created` state with a session already in the DB
 * (needed for the events table FK on session_id).
 */
function createTaskWithSession(
  fixture: Fixture,
  overrides: Partial<Task> = {},
): { task: Task; sessionId: string; agentId: string } {
  // Generate IDs first so we can embed them in the task.
  const agentId = `agent_${Math.random().toString(36).slice(2, 10)}`;
  const sessionId = `sess_${Math.random().toString(36).slice(2, 10)}`;

  // Build the task with agentIds and sessionIds populated so that
  // handleStopTask can find the correct session/agent for the transition.
  const baseTask = buildTask({
    projectId: fixture.projectId,
    objective: 'Test objective',
    ...overrides,
  });
  const task: Task = {
    ...baseTask,
    agentIds: [agentId],
    sessionIds: [sessionId],
    ...overrides,
  };

  // Insert the task first (sessions FK references tasks).
  fixture.insertTask(task);

  // Insert an agent row to satisfy the sessions FK.
  const raw = fixture.db.connection;
  raw
    .prepare(
      'INSERT OR IGNORE INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      agentId,
      'TestAgent',
      'test',
      'B',
      JSON.stringify({ kind: 'cli' }),
      new Date().toISOString(),
    );

  // Insert a session row to satisfy the events FK.
  raw
    .prepare(
      'INSERT INTO sessions (id, task_id, agent_id, status, started_at, event_ids, deliverable_ids, capsule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      sessionId,
      task.id,
      agentId,
      'pending',
      new Date().toISOString(),
      JSON.stringify([]),
      JSON.stringify([]),
      `capsule_${Math.random().toString(36).slice(2, 10)}`,
    );

  return { task, sessionId, agentId };
}

/* ================================================================== *
 * Tests
 * ================================================================== */

describe('CommandApi', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  /* ---------------------------------------------------------------- *
   * start-task
   * ---------------------------------------------------------------- */
  describe('start-task', () => {
    it('starts a task in the created state and returns a sessionId', async () => {
      const { task, agentId } = createTaskWithSession(fixture);

      const res = await fixture.api.execute({
        kind: 'start-task',
        taskId: task.id,
        agentId,
        sessionConfig: { workingDir: '/repo/worktree' },
      });

      const r = res as StartTaskResponse;
      expect(r.ok).toBe(true);
      expect(r.taskId).toBe(task.id);
      expect(r.sessionId).toBeTruthy();
      expect(typeof r.sessionId).toBe('string');
    });

    it('transitions the task to delegated state', async () => {
      const { task, agentId } = createTaskWithSession(fixture);

      await fixture.api.execute({
        kind: 'start-task',
        taskId: task.id,
        agentId,
        sessionConfig: { workingDir: '/repo/worktree' },
      });

      const state = fixture.taskStateMachine.getCurrentState(task.id);
      expect(state).toBe(TaskState.Delegated);
    });

    it('publishes an AgentStarted event on the event bus', async () => {
      const { task, agentId } = createTaskWithSession(fixture);
      const publishSpy = vi.spyOn(fixture.eventBus, 'publish');

      await fixture.api.execute({
        kind: 'start-task',
        taskId: task.id,
        agentId,
        sessionConfig: { workingDir: '/repo/worktree', model: 'gpt-5' },
      });

      expect(publishSpy).toHaveBeenCalledOnce();
      const event = publishSpy.mock.calls[0]![0];
      expect(event.type).toBe('AgentStarted');
      expect(event.taskId).toBe(task.id);
      expect(event.objective).toBe('Test objective');
    });

    it('fails when taskId is missing', async () => {
      const res = await fixture.api.execute({
        kind: 'start-task',
        taskId: '',
        agentId: 'agent-1',
        sessionConfig: { workingDir: '/repo' },
      });

      const r = res as StartTaskResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('taskId');
    });

    it('fails when agentId is missing', async () => {
      const { task } = createTaskWithSession(fixture);

      const res = await fixture.api.execute({
        kind: 'start-task',
        taskId: task.id,
        agentId: '',
        sessionConfig: { workingDir: '/repo' },
      });

      const r = res as StartTaskResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('agentId');
    });

    it('fails when sessionConfig.workingDir is missing', async () => {
      const { task, agentId } = createTaskWithSession(fixture);

      const res = await fixture.api.execute({
        kind: 'start-task',
        taskId: task.id,
        agentId,
        sessionConfig: { workingDir: '' },
      });

      const r = res as StartTaskResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('workingDir');
    });

    it('fails when the task does not exist', async () => {
      const res = await fixture.api.execute({
        kind: 'start-task',
        taskId: 'nonexistent',
        agentId: 'agent-1',
        sessionConfig: { workingDir: '/repo' },
      });

      const r = res as StartTaskResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not found');
    });

    it('fails when the task is already running', async () => {
      const { task, sessionId, agentId } = createTaskWithSession(fixture);

      // Manually transition to running.
      fixture.taskStateMachine.transition(task.id, TaskState.Created, TaskState.Delegated, {
        sessionId,
        agentId,
      });
      fixture.taskStateMachine.transition(task.id, TaskState.Delegated, TaskState.Running, {
        sessionId,
        agentId,
      });

      const res = await fixture.api.execute({
        kind: 'start-task',
        taskId: task.id,
        agentId,
        sessionConfig: { workingDir: '/repo' },
      });

      const r = res as StartTaskResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('running');
    });
  });

  /* ---------------------------------------------------------------- *
   * stop-task
   * ---------------------------------------------------------------- */
  describe('stop-task', () => {
    it('stops a running task', async () => {
      const { task, sessionId, agentId } = createTaskWithSession(fixture);
      fixture.taskStateMachine.transition(task.id, TaskState.Created, TaskState.Delegated, {
        sessionId,
        agentId,
      });
      fixture.taskStateMachine.transition(task.id, TaskState.Delegated, TaskState.Running, {
        sessionId,
        agentId,
      });

      const res = await fixture.api.execute({
        kind: 'stop-task',
        taskId: task.id,
        reason: 'user requested',
      });

      const r = res as StopTaskResponse;
      expect(r.ok).toBe(true);
      expect(r.taskId).toBe(task.id);
      expect(fixture.taskStateMachine.getCurrentState(task.id)).toBe(TaskState.Cancelled);
    });

    it('publishes an AgentStopped event', async () => {
      const { task, sessionId, agentId } = createTaskWithSession(fixture);
      fixture.taskStateMachine.transition(task.id, TaskState.Created, TaskState.Delegated, {
        sessionId,
        agentId,
      });
      fixture.taskStateMachine.transition(task.id, TaskState.Delegated, TaskState.Running, {
        sessionId,
        agentId,
      });
      const publishSpy = vi.spyOn(fixture.eventBus, 'publish');

      await fixture.api.execute({
        kind: 'stop-task',
        taskId: task.id,
        reason: 'timeout',
      });

      expect(publishSpy).toHaveBeenCalledOnce();
      const event = publishSpy.mock.calls[0]![0];
      expect(event.type).toBe('AgentStopped');
      expect(event.taskId).toBe(task.id);
    });

    it('fails when taskId is missing', async () => {
      const res = await fixture.api.execute({
        kind: 'stop-task',
        taskId: '',
      });

      const r = res as StopTaskResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('taskId');
    });

    it('fails when the task does not exist', async () => {
      const res = await fixture.api.execute({
        kind: 'stop-task',
        taskId: 'nonexistent',
      });

      const r = res as StopTaskResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not found');
    });

    it('fails when the task is already in a terminal state', async () => {
      const { task, sessionId, agentId } = createTaskWithSession(fixture);
      fixture.taskStateMachine.transition(task.id, TaskState.Created, TaskState.Cancelled, {
        sessionId,
        agentId,
      });

      const res = await fixture.api.execute({
        kind: 'stop-task',
        taskId: task.id,
      });

      const r = res as StopTaskResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('terminal');
    });
  });

  /* ---------------------------------------------------------------- *
   * approve
   * ---------------------------------------------------------------- */
  describe('approve', () => {
    it('grants an approval', async () => {
      const { task } = createTaskWithSession(fixture);
      const approval = buildApproval({ taskId: task.id, capability: 'network' });
      fixture.insertApproval(approval);

      const res = await fixture.api.execute({
        kind: 'approve',
        taskId: task.id,
        approvalId: approval.id,
        decision: 'grant',
      });

      const r = res as ApproveResponse;
      expect(r.ok).toBe(true);
      expect(r.approvalId).toBe(approval.id);

      const updated = fixture.approvalStore.getById(approval.id);
      expect(updated!.granted).toBe(true);
      expect(updated!.grantedAt).toBeTruthy();
    });

    it('denies an approval', async () => {
      const { task } = createTaskWithSession(fixture);
      const approval = buildApproval({ taskId: task.id, capability: 'network' });
      fixture.insertApproval(approval);

      const res = await fixture.api.execute({
        kind: 'approve',
        taskId: task.id,
        approvalId: approval.id,
        decision: 'deny',
      });

      const r = res as ApproveResponse;
      expect(r.ok).toBe(true);
      expect(r.approvalId).toBe(approval.id);

      const updated = fixture.approvalStore.getById(approval.id);
      expect(updated!.granted).toBe(false);
    });

    it('records approval metrics', async () => {
      const { task } = createTaskWithSession(fixture);
      const approval = buildApproval({ taskId: task.id, capability: 'network' });
      fixture.insertApproval(approval);

      await fixture.api.execute({
        kind: 'approve',
        taskId: task.id,
        approvalId: approval.id,
        decision: 'grant',
      });

      const snapshot = fixture.metricsCollector.snapshot();
      expect(snapshot.counters.approvalsGranted).toBe(1);
    });

    it('records denial metrics', async () => {
      const { task } = createTaskWithSession(fixture);
      const approval = buildApproval({ taskId: task.id, capability: 'network' });
      fixture.insertApproval(approval);

      await fixture.api.execute({
        kind: 'approve',
        taskId: task.id,
        approvalId: approval.id,
        decision: 'deny',
      });

      const snapshot = fixture.metricsCollector.snapshot();
      expect(snapshot.counters.approvalsDenied).toBe(1);
    });

    it('fails when approvalId is missing', async () => {
      const res = await fixture.api.execute({
        kind: 'approve',
        taskId: 'task-1',
        approvalId: '',
        decision: 'grant',
      });

      const r = res as ApproveResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('approvalId');
    });

    it('fails when the approval does not exist', async () => {
      const { task } = createTaskWithSession(fixture);

      const res = await fixture.api.execute({
        kind: 'approve',
        taskId: task.id,
        approvalId: 'nonexistent',
        decision: 'grant',
      });

      const r = res as ApproveResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not found');
    });

    it('fails when the approval does not belong to the task', async () => {
      const { task } = createTaskWithSession(fixture);
      const { task: otherTask } = createTaskWithSession(fixture);
      const approval = buildApproval({ taskId: otherTask.id, capability: 'network' });
      fixture.insertApproval(approval);

      const res = await fixture.api.execute({
        kind: 'approve',
        taskId: task.id,
        approvalId: approval.id,
        decision: 'grant',
      });

      const r = res as ApproveResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('does not belong');
    });
  });

  /* ---------------------------------------------------------------- *
   * query-inbox
   * ---------------------------------------------------------------- */
  describe('query-inbox', () => {
    it('returns all items when no filter is provided', async () => {
      const item1 = createAttentionItem({
        taskId: 'task-1',
        kind: 'ApprovalRequest',
        priority: 'High',
      });
      const item2 = createAttentionItem({
        taskId: 'task-2',
        kind: 'FailedRun',
        priority: 'Medium',
      });
      fixture.attentionInbox.add(item1);
      fixture.attentionInbox.add(item2);

      const res = await fixture.api.execute({ kind: 'query-inbox' });

      const r = res as InboxResponse;
      expect(r.ok).toBe(true);
      expect(r.items).toHaveLength(2);
      expect(r.items.map((i) => i.id)).toContain(item1.id);
      expect(r.items.map((i) => i.id)).toContain(item2.id);
    });

    it('returns filtered items', async () => {
      const item1 = createAttentionItem({
        taskId: 'task-1',
        kind: 'ApprovalRequest',
        priority: 'High',
      });
      const item2 = createAttentionItem({
        taskId: 'task-2',
        kind: 'FailedRun',
        priority: 'Medium',
      });
      fixture.attentionInbox.add(item1);
      fixture.attentionInbox.add(item2);

      const res = await fixture.api.execute({
        kind: 'query-inbox',
        filter: { kind: 'ApprovalRequest' },
      });

      const r = res as InboxResponse;
      expect(r.ok).toBe(true);
      expect(r.items).toHaveLength(1);
      expect(r.items[0]!.id).toBe(item1.id);
    });

    it('returns empty array when no items match', async () => {
      const res = await fixture.api.execute({ kind: 'query-inbox' });

      const r = res as InboxResponse;
      expect(r.ok).toBe(true);
      expect(r.items).toEqual([]);
    });

    it('returns serializable snapshots', async () => {
      const item = createAttentionItem({
        taskId: 'task-1',
        kind: 'ApprovalRequest',
        priority: 'High',
        payload: { capability: 'network' },
      });
      fixture.attentionInbox.add(item);

      const res = await fixture.api.execute({ kind: 'query-inbox' });
      const r = res as InboxResponse;
      const snapshot = r.items[0]!;
      expect(snapshot.id).toBe(item.id);
      expect(snapshot.taskId).toBe(item.taskId);
      expect(snapshot.kind).toBe(item.kind);
      expect(snapshot.priority).toBe(item.priority);
      expect(snapshot.status).toBe(item.status);
      expect(snapshot.payload).toEqual({ capability: 'network' });
    });
  });

  /* ---------------------------------------------------------------- *
   * ack-item
   * ---------------------------------------------------------------- */
  describe('ack-item', () => {
    it('acknowledges an existing item', async () => {
      const item = createAttentionItem({
        taskId: 'task-1',
        kind: 'ApprovalRequest',
        priority: 'High',
      });
      fixture.attentionInbox.add(item);

      const res = await fixture.api.execute({
        kind: 'ack-item',
        itemId: item.id,
      });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(true);
      expect(r.itemId).toBe(item.id);
      expect(fixture.attentionInbox.list({ status: 'Acknowledged' })).toHaveLength(1);
    });

    it('fails when itemId is missing', async () => {
      const res = await fixture.api.execute({
        kind: 'ack-item',
        itemId: '',
      });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('itemId');
    });

    it('fails when the item does not exist', async () => {
      const res = await fixture.api.execute({
        kind: 'ack-item',
        itemId: 'nonexistent',
      });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not found');
    });
  });

  /* ---------------------------------------------------------------- *
   * resolve-item
   * ---------------------------------------------------------------- */
  describe('resolve-item', () => {
    it('resolves an existing item', async () => {
      const item = createAttentionItem({
        taskId: 'task-1',
        kind: 'ApprovalRequest',
        priority: 'High',
      });
      fixture.attentionInbox.add(item);

      const res = await fixture.api.execute({
        kind: 'resolve-item',
        itemId: item.id,
      });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(true);
      expect(r.itemId).toBe(item.id);
      expect(fixture.attentionInbox.list({ status: 'Resolved' })).toHaveLength(1);
    });

    it('fails when itemId is missing', async () => {
      const res = await fixture.api.execute({
        kind: 'resolve-item',
        itemId: '',
      });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('itemId');
    });

    it('fails when the item does not exist', async () => {
      const res = await fixture.api.execute({
        kind: 'resolve-item',
        itemId: 'nonexistent',
      });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not found');
    });
  });

  /* ---------------------------------------------------------------- *
   * escalate-item
   * ---------------------------------------------------------------- */
  describe('escalate-item', () => {
    it('escalates an existing item to Critical priority', async () => {
      const item = createAttentionItem({
        taskId: 'task-1',
        kind: 'ApprovalRequest',
        priority: 'Medium',
      });
      fixture.attentionInbox.add(item);

      const res = await fixture.api.execute({
        kind: 'escalate-item',
        itemId: item.id,
      });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(true);
      expect(r.itemId).toBe(item.id);
      const items = fixture.attentionInbox.list();
      expect(items[0]!.priority).toBe('Critical');
      expect(items[0]!.status).toBe('Escalated');
    });

    it('fails when itemId is missing', async () => {
      const res = await fixture.api.execute({
        kind: 'escalate-item',
        itemId: '',
      });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('itemId');
    });

    it('fails when the item does not exist', async () => {
      const res = await fixture.api.execute({
        kind: 'escalate-item',
        itemId: 'nonexistent',
      });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not found');
    });
  });

  /* ---------------------------------------------------------------- *
   * query-metrics
   * ---------------------------------------------------------------- */
  describe('query-metrics', () => {
    it('returns the current metrics snapshot', async () => {
      const res = await fixture.api.execute({ kind: 'query-metrics' });

      const r = res as MetricsResponse;
      expect(r.ok).toBe(true);
      expect(r.snapshot).not.toBeNull();
      expect(r.snapshot!.timestamp).toBeTruthy();
      expect(typeof r.snapshot!.counters.tasksStarted).toBe('number');
    });

    it('accepts a since parameter', async () => {
      const res = await fixture.api.execute({
        kind: 'query-metrics',
        since: Date.now() - 1000,
      });

      const r = res as MetricsResponse;
      expect(r.ok).toBe(true);
      expect(r.snapshot).not.toBeNull();
    });
  });

  /* ---------------------------------------------------------------- *
   * query-task
   * ---------------------------------------------------------------- */
  describe('query-task', () => {
    it('returns a task snapshot when the task exists', async () => {
      const { task } = createTaskWithSession(fixture);

      const res = await fixture.api.execute({
        kind: 'query-task',
        taskId: task.id,
      });

      const r = res as TaskResponse;
      expect(r.ok).toBe(true);
      expect(r.task).not.toBeNull();
      expect(r.task!.id).toBe(task.id);
      expect(r.task!.objective).toBe(task.objective);
      expect(r.task!.state).toBe(task.state);
      expect(r.task!.eventCount).toBe(0);
    });

    it('includes event count from the journal', async () => {
      const { task, sessionId, agentId } = createTaskWithSession(fixture);
      // Transition to generate events.
      fixture.taskStateMachine.transition(task.id, TaskState.Created, TaskState.Delegated, {
        sessionId,
        agentId,
      });

      const res = await fixture.api.execute({
        kind: 'query-task',
        taskId: task.id,
      });

      const r = res as TaskResponse;
      expect(r.task!.eventCount).toBeGreaterThan(0);
    });

    it('returns null task when the task does not exist', async () => {
      const res = await fixture.api.execute({
        kind: 'query-task',
        taskId: 'nonexistent',
      });

      const r = res as TaskResponse;
      expect(r.ok).toBe(false);
      expect(r.task).toBeNull();
    });

    it('fails when taskId is missing', async () => {
      const res = await fixture.api.execute({
        kind: 'query-task',
        taskId: '',
      });

      const r = res as TaskResponse;
      expect(r.ok).toBe(false);
      expect(r.task).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- *
   * query-events (issue #126 — session inspector drill-down)
   * ---------------------------------------------------------------- */
  describe('query-events', () => {
    it('returns the journaled events for a task', async () => {
      const { task, sessionId, agentId } = createTaskWithSession(fixture);
      fixture.taskStateMachine.transition(task.id, TaskState.Created, TaskState.Delegated, {
        sessionId,
        agentId,
      });

      const res = (await fixture.api.execute({
        kind: 'query-events',
        taskId: task.id,
      })) as EventsResponse;

      expect(res.ok).toBe(true);
      expect(res.taskId).toBe(task.id);
      expect(res.events.length).toBeGreaterThan(0);
      const e = res.events[0];
      expect(e.taskId).toBe(task.id);
      expect(typeof e.kind).toBe('string');
      expect(e.payload).toBeTypeOf('object');
      expect(typeof e.timestamp).toBe('string');
    });

    it('returns an empty list for a task with no journaled events', async () => {
      const { task } = createTaskWithSession(fixture);

      const res = (await fixture.api.execute({
        kind: 'query-events',
        taskId: task.id,
      })) as EventsResponse;

      expect(res.ok).toBe(true);
      expect(res.events).toEqual([]);
    });

    it('fails when the task does not exist', async () => {
      const res = (await fixture.api.execute({
        kind: 'query-events',
        taskId: 'nonexistent',
      })) as EventsResponse;

      expect(res.ok).toBe(false);
      expect(res.error).toContain('nonexistent');
    });

    it('fails when taskId is missing', async () => {
      const res = (await fixture.api.execute({
        kind: 'query-events',
        taskId: '',
      })) as EventsResponse;

      expect(res.ok).toBe(false);
      expect(res.events).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- *
   * query-fleet (issue #127 — fleet/quota screen)
   * ---------------------------------------------------------------- */
  describe('query-fleet', () => {
    /** Journal a routing event for a task (TaskParked / TaskFailedOver). */
    function journalRouting(
      taskId: string,
      sessionId: string,
      kind: string,
      payload: Record<string, unknown>,
    ): void {
      fixture.eventRepository.insert({
        id: `evt_${Math.random().toString(36).slice(2, 10)}`,
        sessionId,
        taskId,
        timestamp: new Date().toISOString(),
        kind,
        payload,
      } as never);
    }

    it('returns provider quota state from the ledger', async () => {
      const resetsAt = new Date(Date.now() + 3600_000).toISOString();
      const ledger = new QuotaLedger();
      ledger.recordWindow({
        provider: 'gemini',
        window: 'daily',
        usedPct: 0.97,
        resetsAt,
        status: 'exhausted',
        source: 'polled',
        observedAt: new Date().toISOString(),
      });
      const api = new CommandApi({ ...fixture.deps, quotaLedger: ledger });

      const res = (await api.execute({ kind: 'query-fleet' })) as FleetResponse;

      expect(res.ok).toBe(true);
      const gemini = res.providers.find((p) => p.provider === 'gemini');
      expect(gemini).toBeDefined();
      expect(gemini!.available).toBe(false);
      expect(gemini!.exhaustedUntil).toBe(resetsAt);
      expect(gemini!.usedPct).toBeCloseTo(0.97);
    });

    it('reports unobserved providers as optimistically available', async () => {
      const res = (await fixture.api.execute({ kind: 'query-fleet' })) as FleetResponse;
      expect(res.ok).toBe(true);
      // No ledger wired — an empty provider list is the honest answer.
      expect(res.providers).toEqual([]);
      expect(res.parked).toEqual([]);
    });

    it('surfaces parked tasks with resume times from the journal', async () => {
      const { task, sessionId } = createTaskWithSession(fixture, {
        objective: 'image-pipeline',
      });
      journalRouting(task.id, sessionId, 'TaskParked', {
        reason: 'all candidate providers exhausted',
        resumeAt: new Date(Date.now() + 1800_000).toISOString(),
      });

      const res = (await fixture.api.execute({ kind: 'query-fleet' })) as FleetResponse;

      expect(res.ok).toBe(true);
      expect(res.parked).toHaveLength(1);
      expect(res.parked[0].objective).toBe('image-pipeline');
      expect(res.parked[0].resumeAt).not.toBeNull();
      expect(
        res.routingDecisions.some((d) => d.kind === 'TaskParked' && d.summary.includes('parked')),
      ).toBe(true);
    });

    it('lists failover decisions and ignores parked tasks that resumed', async () => {
      const { task, sessionId } = createTaskWithSession(fixture, {
        objective: 'schema-cleanup',
      });
      journalRouting(task.id, sessionId, 'TaskParked', { reason: 'quota dry' });
      journalRouting(task.id, sessionId, 'TaskResumed', { provider: 'codex' });
      journalRouting(task.id, sessionId, 'TaskFailedOver', {
        fromProvider: 'gemini',
        toProvider: 'codex',
        reason: 'gemini exhausted',
      });

      const res = (await fixture.api.execute({ kind: 'query-fleet' })) as FleetResponse;

      // Latest routing event is TaskFailedOver (after resume) → not parked.
      expect(res.parked).toHaveLength(0);
      const failover = res.routingDecisions.find((d) => d.kind === 'TaskFailedOver');
      expect(failover).toBeDefined();
      expect(failover!.summary).toContain('→ codex');
      expect(failover!.summary).toContain('gemini exhausted');
    });
  });

  /* ---------------------------------------------------------------- *
   * list-tasks
   * ---------------------------------------------------------------- */
  describe('list-tasks', () => {
    it('returns all tasks when no status filter is provided', async () => {
      createTaskWithSession(fixture, { objective: 'Task A' });
      createTaskWithSession(fixture, { objective: 'Task B' });

      const res = await fixture.api.execute({ kind: 'list-tasks' });

      const r = res as TaskListResponse;
      expect(r.ok).toBe(true);
      expect(r.tasks).toHaveLength(2);
    });

    it('filters tasks by status', async () => {
      const {
        task: task1,
        sessionId,
        agentId,
      } = createTaskWithSession(fixture, {
        objective: 'Task A',
      });
      createTaskWithSession(fixture, { objective: 'Task B' });

      // Transition task1 to delegated.
      fixture.taskStateMachine.transition(task1.id, TaskState.Created, TaskState.Delegated, {
        sessionId,
        agentId,
      });

      const res = await fixture.api.execute({
        kind: 'list-tasks',
        status: TaskState.Delegated,
      });

      const r = res as TaskListResponse;
      expect(r.ok).toBe(true);
      expect(r.tasks).toHaveLength(1);
      expect(r.tasks[0]!.id).toBe(task1.id);
      expect(r.tasks[0]!.state).toBe(TaskState.Delegated);
    });

    it('returns empty array when no tasks match the filter', async () => {
      createTaskWithSession(fixture);

      const res = await fixture.api.execute({
        kind: 'list-tasks',
        status: TaskState.Completed,
      });

      const r = res as TaskListResponse;
      expect(r.ok).toBe(true);
      expect(r.tasks).toEqual([]);
    });

    it('returns empty array when there are no tasks', async () => {
      const res = await fixture.api.execute({ kind: 'list-tasks' });

      const r = res as TaskListResponse;
      expect(r.ok).toBe(true);
      expect(r.tasks).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- *
   * prune-worktree
   * ---------------------------------------------------------------- */
  describe('prune-worktree', () => {
    it('prunes a clean worktree', async () => {
      const { task } = createTaskWithSession(fixture, {
        worktreePath: '/repo/.florina-worktrees/test-task',
      });
      fixture.worktreeManager.simulateClean();

      const res = await fixture.api.execute({
        kind: 'prune-worktree',
        taskId: task.id,
      });

      const r = res as PruneResponse;
      expect(r.ok).toBe(true);
      expect(r.taskId).toBe(task.id);
      expect(fixture.worktreeManager.pruneWorktree).toHaveBeenCalledOnce();
    });

    it('fails when the worktree is dirty', async () => {
      const { task } = createTaskWithSession(fixture, {
        worktreePath: '/repo/.florina-worktrees/dirty-task',
      });
      fixture.worktreeManager.simulateDirty('/repo/.florina-worktrees/dirty-task');

      const res = await fixture.api.execute({
        kind: 'prune-worktree',
        taskId: task.id,
      });

      const r = res as PruneResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('dirty');
    });

    it('fails when taskId is missing', async () => {
      const res = await fixture.api.execute({
        kind: 'prune-worktree',
        taskId: '',
      });

      const r = res as PruneResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('taskId');
    });

    it('fails when the task does not exist', async () => {
      const res = await fixture.api.execute({
        kind: 'prune-worktree',
        taskId: 'nonexistent',
      });

      const r = res as PruneResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('not found');
    });

    it('fails when the task has no worktree path', async () => {
      const { task } = createTaskWithSession(fixture);

      const res = await fixture.api.execute({
        kind: 'prune-worktree',
        taskId: task.id,
      });

      const r = res as PruneResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('no worktree');
    });
  });

  /* ---------------------------------------------------------------- *
   * shutdown
   * ---------------------------------------------------------------- */
  describe('shutdown', () => {
    it('signals shutdown and returns ok', async () => {
      const res = await fixture.api.execute({ kind: 'shutdown' });

      const r = res as ShutdownResponse;
      expect(r.ok).toBe(true);
      expect(fixture.api.isShutdownRequested).toBe(true);
    });

    it('invokes the onShutdown callback', async () => {
      await fixture.api.execute({ kind: 'shutdown' });

      expect(fixture.onShutdown).toHaveBeenCalledOnce();
    });
  });

  /* ---------------------------------------------------------------- *
   * get-digest (issue #37)
   * ---------------------------------------------------------------- */
  describe('get-digest', () => {
    function makeDigest(taskId: string): CompletionDigest {
      return {
        taskId,
        sessionId: 'session_1',
        agentId: 'agent_1',
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T01:00:00.000Z',
        duration: 3_600_000,
        summary: 'Implementation complete. 9 files, 23/23 tests passing.',
        filesChangedCount: 9,
        filesChanged: ['src/a.ts', 'src/b.ts'],
        testsRun: 23,
        testsPassed: 23,
        testsFailed: 0,
        approvalsRequested: 1,
        approvalsGranted: 1,
        approvalsDenied: 0,
        decisions: [],
        riskHighlights: [],
      };
    }

    it('returns the latest digest for a task', async () => {
      const { task } = createTaskWithSession(fixture);
      const digest = makeDigest(task.id);
      fixture.completionDigestRepository.save(digest);

      const res = await fixture.api.execute({ kind: 'get-digest', taskId: task.id });

      const r = res as DigestResponse;
      expect(r.ok).toBe(true);
      expect(r.digest).not.toBeNull();
      expect(r.digest?.taskId).toBe(task.id);
      expect(r.digest?.summary).toBe(digest.summary);
    });

    it('returns ok with null digest when no digest exists', async () => {
      const { task } = createTaskWithSession(fixture);

      const res = await fixture.api.execute({ kind: 'get-digest', taskId: task.id });

      const r = res as DigestResponse;
      expect(r.ok).toBe(true);
      expect(r.digest).toBeNull();
    });

    it('returns an error when taskId is empty', async () => {
      const res = await fixture.api.execute({ kind: 'get-digest', taskId: '' });

      const r = res as DigestResponse;
      expect(r.ok).toBe(false);
      expect(r.digest).toBeNull();
      expect(r.error).toContain('taskId is required');
    });
  });

  /* ---------------------------------------------------------------- *
   * Unknown / invalid commands
   * ---------------------------------------------------------------- */
  describe('unknown commands', () => {
    it('returns an error response for an unknown command kind', async () => {
      const res = await fixture.api.execute({
        kind: 'unknown-command' as unknown as Command,
      } as Command);

      const r = res as UnknownCommandResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('Unknown command kind');
    });
  });

  /* ---------------------------------------------------------------- *
   * Type safety
   * ---------------------------------------------------------------- */
  describe('type safety', () => {
    it('each command kind produces the correct response shape', async () => {
      // Verify that the response union is correctly typed by checking
      // structural properties of each response.
      const { task } = createTaskWithSession(fixture);

      const startRes = await fixture.api.execute({
        kind: 'start-task',
        taskId: task.id,
        agentId: 'agent-1',
        sessionConfig: { workingDir: '/repo' },
      });
      expect(startRes).toHaveProperty('taskId');
      expect(startRes).toHaveProperty('sessionId');

      const stopRes = await fixture.api.execute({ kind: 'stop-task', taskId: task.id });
      expect(stopRes).toHaveProperty('taskId');

      const inboxRes = await fixture.api.execute({ kind: 'query-inbox' });
      expect(inboxRes).toHaveProperty('items');

      const metricsRes = await fixture.api.execute({ kind: 'query-metrics' });
      expect(metricsRes).toHaveProperty('snapshot');

      const taskRes = await fixture.api.execute({ kind: 'query-task', taskId: task.id });
      expect(taskRes).toHaveProperty('task');

      const listRes = await fixture.api.execute({ kind: 'list-tasks' });
      expect(listRes).toHaveProperty('tasks');

      const shutdownRes = await fixture.api.execute({ kind: 'shutdown' });
      expect(shutdownRes).toHaveProperty('ok');
    });
  });
});

describe('query-secretary (issue #130)', () => {
  it('returns the working surface from wired ports', async () => {
    const fixture = createFixture();
    const confirmed: string[] = [];
    const api = new CommandApi({
      ...fixture.deps,
      secretaryOps: {
        plan: () => [
          { id: 'todo-1', content: 'watch the run', status: 'in_progress' },
          { id: 'todo-2', content: 'draft brief', status: 'pending' },
        ],
        inFlightResearch: () => [
          { id: 'r1', query: 'capsule interfaces', startedAt: '2026-09-15T14:11:00Z' },
        ],
        pendingMemoryWrites: () => [
          {
            id: 'mw-1',
            summary: 'prefers parked over failover',
            scope: 'user',
            proposedAt: '2026-09-15T14:09:00Z',
          },
        ],
        confirmMemoryWrite: (id) => {
          confirmed.push(id);
          return id === 'mw-1';
        },
        rejectMemoryWrite: () => false,
      },
      contextHealth: {
        snapshot: () => undefined,
        listSnapshots: () => [
          {
            agentId: 'secretary',
            windowFillPct: 0.42,
            eventsSinceCondensation: 173,
            condensationCount: 2,
            status: 'ok' as const,
          },
        ],
      },
    });

    const res = (await api.execute({ kind: 'query-secretary' })) as SecretaryResponse;
    expect(res.ok).toBe(true);
    expect(res.plan).toHaveLength(2);
    expect(res.research[0]!.query).toBe('capsule interfaces');
    expect(res.memoryWrites[0]!.id).toBe('mw-1');
    expect(res.health[0]!.agentId).toBe('secretary');

    const confirm = (await api.execute({
      kind: 'memory-confirm',
      writeId: 'mw-1',
    })) as MemoryWriteResponse;
    expect(confirm.ok).toBe(true);
    expect(confirmed).toEqual(['mw-1']);

    const miss = (await api.execute({
      kind: 'memory-reject',
      writeId: 'mw-9',
    })) as MemoryWriteResponse;
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain('mw-9');
  });

  it('returns honest empty sections and clean errors when unwired', async () => {
    const fixture = createFixture();
    const res = (await fixture.api.execute({ kind: 'query-secretary' })) as SecretaryResponse;
    expect(res.ok).toBe(true);
    expect(res.plan).toEqual([]);
    expect(res.research).toEqual([]);
    expect(res.memoryWrites).toEqual([]);
    expect(res.health).toEqual([]);

    const confirm = (await fixture.api.execute({
      kind: 'memory-confirm',
      writeId: 'mw-1',
    })) as MemoryWriteResponse;
    expect(confirm.ok).toBe(false);
    expect(confirm.error).toContain('not wired');
  });
});

describe('voice-state (issue #131)', () => {
  it('forwards a valid report to the wired sink', async () => {
    const fixture = createFixture();
    const reports: unknown[] = [];
    const api = new CommandApi({
      ...fixture.deps,
      voiceStateSink: (report) => reports.push(report),
    });

    const res = await api.execute({
      kind: 'voice-state',
      state: 'processing',
      transcript: 'ship it',
      responsePreview: 'On it.',
      mode: 'realtime',
    });
    expect(res.ok).toBe(true);
    expect(reports).toEqual([
      {
        state: 'processing',
        transcript: 'ship it',
        responsePreview: 'On it.',
        mode: 'realtime',
      },
    ]);
  });

  it('rejects an unknown state without touching the sink', async () => {
    const fixture = createFixture();
    const reports: unknown[] = [];
    const api = new CommandApi({
      ...fixture.deps,
      voiceStateSink: (report) => reports.push(report),
    });

    const res = await api.execute({
      kind: 'voice-state',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: 'singing' as any,
    });
    expect(res.ok).toBe(false);
    expect((res as { error?: string }).error).toContain('invalid voice state');
    expect(reports).toEqual([]);
  });

  it('accepts a report when no sink is wired', async () => {
    const fixture = createFixture();
    const res = await fixture.api.execute({ kind: 'voice-state', state: 'idle' });
    expect(res.ok).toBe(true);
  });
});
