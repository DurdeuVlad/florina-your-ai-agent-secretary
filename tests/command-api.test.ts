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
  ProvidersResponse,
  PruneResponse,
  ShutdownResponse,
  DigestResponse,
  CatchUpResponse,
  ConfirmCatchUpResponse,
  SearchJournalResponse,
  SecretaryResponse,
  MemoryWriteResponse,
  UnknownCommandResponse,
  ChatSendResponse,
  ChatReadResponse,
  ChatClearResponse,
  ChatAppendResponse,
  ReposResponse,
} from '../src/daemon/command-api.js';
import type {
  RepoRootsConfig,
  RepoRootsPort,
} from '../src/core/application/ports/outbound/repo-roots.js';
import type { RepoScannerPort } from '../src/core/application/use-cases/repos/discover-repos.js';
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
  ChatMessageRepository,
} from '../src/storage/index.js';
import {
  TaskState,
  buildProject,
  buildTask,
  buildApproval,
  buildAgent,
} from '../src/domain/index.js';
import type { Task, Approval, Event } from '../src/domain/types.js';
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
class InMemoryCatchUpWatermarkStore {
  private value: string | null = null;
  get(): string | null {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

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
  catchUpWatermark: InMemoryCatchUpWatermarkStore;
  chatStore: ChatMessageRepository;
  chatMessageSink: ReturnType<typeof vi.fn>;
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

  const chatStore = new ChatMessageRepository(raw);
  const chatMessageSink = vi.fn();

  const taskStore = new SqliteBackedTaskStore(taskRepo, db);
  const approvalStore = new InMemoryApprovalStore();
  const sessionStore: SessionStore = sessionRepo;
  const onShutdown = vi.fn();
  const catchUpWatermark = new InMemoryCatchUpWatermarkStore();

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
    catchUpWatermark,
    chatStore,
    chatMessageSink,
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
    catchUpWatermark,
    chatStore,
    chatMessageSink,
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
   * retry-journal-write (issue #264)
   * ---------------------------------------------------------------- */
  describe('retry-journal-write', () => {
    it('re-inserts the retained row and resolves the item on success', async () => {
      const { task, sessionId } = createTaskWithSession(fixture);
      const row: Event = {
        id: 'ev_retry_1',
        sessionId,
        taskId: task.id,
        timestamp: '2026-09-27T11:00:00.000Z',
        kind: 'AgentProgress',
        payload: { message: 'checking' },
      };
      const item = createAttentionItem({
        taskId: task.id,
        kind: 'JournalFailure',
        priority: 'High',
        payload: {
          source: 'event-journal',
          reason: 'database is locked',
          retryable: true,
          writes: [row],
        },
      });
      fixture.attentionInbox.add(item);

      const res = await fixture.api.execute({ kind: 'retry-journal-write', itemId: item.id });

      expect((res as ItemMutationResponse).ok).toBe(true);
      // The row landed for real — the journal contains it.
      expect(fixture.eventRepository.listByTask(task.id).some((e) => e.id === 'ev_retry_1')).toBe(
        true,
      );
      // And the item resolved — it leaves Needs-you.
      expect(fixture.attentionInbox.list()[0]!.status).toBe('Resolved');
    });

    it('a still-failing write keeps the item open with the new error', async () => {
      // Row references a task/session that never persisted — the FK
      // failure is permanent, and the item stays Pending for the user.
      const row: Event = {
        id: 'ev_retry_2',
        sessionId: 'sess_ghost',
        taskId: 'task_ghost',
        timestamp: '2026-09-27T11:00:00.000Z',
        kind: 'AgentProgress',
        payload: {},
      };
      const item = createAttentionItem({
        taskId: 'task_ghost',
        kind: 'JournalFailure',
        priority: 'High',
        payload: {
          source: 'event-journal',
          reason: 'constraint failed',
          retryable: false,
          writes: [row],
        },
      });
      fixture.attentionInbox.add(item);

      const res = await fixture.api.execute({ kind: 'retry-journal-write', itemId: item.id });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('retry failed');
      expect(fixture.attentionInbox.list()[0]!.status).toBe('Pending');
    });

    it('rejects items that are not journal failures', async () => {
      const item = createAttentionItem({ taskId: 't1', kind: 'Custom', priority: 'Low' });
      fixture.attentionInbox.add(item);
      const res = await fixture.api.execute({ kind: 'retry-journal-write', itemId: item.id });
      expect((res as ItemMutationResponse).ok).toBe(false);
      expect((res as ItemMutationResponse).error).toContain('not a journal failure');
    });

    it('rejects a journal failure that retains no row', async () => {
      const item = createAttentionItem({
        taskId: '',
        kind: 'JournalFailure',
        priority: 'High',
        payload: { source: 'secrets-vault', reason: 'audit row dropped', retryable: false },
      });
      fixture.attentionInbox.add(item);
      const res = await fixture.api.execute({ kind: 'retry-journal-write', itemId: item.id });
      expect((res as ItemMutationResponse).ok).toBe(false);
      expect((res as ItemMutationResponse).error).toContain('no journal row');
    });

    it('a retry whose row already landed resolves without duplicating', async () => {
      // The original insert committed but the failure was still reported
      // (or a previous retry landed): getById detects it, no second row.
      const { task, sessionId } = createTaskWithSession(fixture);
      const row: Event = {
        id: 'ev_retry_landed',
        sessionId,
        taskId: task.id,
        timestamp: '2026-09-27T11:00:00.000Z',
        kind: 'AgentProgress',
        payload: { message: 'already there' },
      };
      fixture.eventRepository.insert(row);
      const item = createAttentionItem({
        taskId: task.id,
        kind: 'JournalFailure',
        priority: 'High',
        payload: {
          source: 'event-journal',
          reason: 'lost ack',
          retryable: true,
          writes: [row],
        },
      });
      fixture.attentionInbox.add(item);

      const res = await fixture.api.execute({ kind: 'retry-journal-write', itemId: item.id });

      expect((res as ItemMutationResponse).ok).toBe(true);
      expect(
        fixture.eventRepository.listByTask(task.id).filter((e) => e.id === 'ev_retry_landed'),
      ).toHaveLength(1);
      expect(fixture.attentionInbox.list()[0]!.status).toBe('Resolved');
    });

    it('rejects a retry on a resolved item — the gap stays acknowledged', async () => {
      const { task, sessionId } = createTaskWithSession(fixture);
      const row: Event = {
        id: 'ev_retry_resolved',
        sessionId,
        taskId: task.id,
        timestamp: '2026-09-27T11:00:00.000Z',
        kind: 'AgentProgress',
        payload: {},
      };
      const item = createAttentionItem({
        taskId: task.id,
        kind: 'JournalFailure',
        priority: 'High',
        payload: { source: 'event-journal', reason: 'busy', retryable: true, writes: [row] },
      });
      fixture.attentionInbox.add(item);
      fixture.attentionInbox.resolve(item.id);

      const res = await fixture.api.execute({ kind: 'retry-journal-write', itemId: item.id });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('already resolved');
      expect(
        fixture.eventRepository.listByTask(task.id).some((e) => e.id === 'ev_retry_resolved'),
      ).toBe(false);
    });

    it('a partial retry keeps only the still-failing rows on the card', async () => {
      const { task, sessionId } = createTaskWithSession(fixture);
      const lands: Event = {
        id: 'ev_retry_ok',
        sessionId,
        taskId: task.id,
        timestamp: '2026-09-27T11:00:00.000Z',
        kind: 'AgentProgress',
        payload: {},
      };
      const fails: Event = {
        id: 'ev_retry_fk',
        sessionId: 'sess_ghost',
        taskId: 'task_ghost',
        timestamp: '2026-09-27T11:00:00.000Z',
        kind: 'AgentProgress',
        payload: {},
      };
      const item = createAttentionItem({
        taskId: task.id,
        kind: 'JournalFailure',
        priority: 'High',
        payload: {
          source: 'event-journal',
          reason: 'busy',
          retryable: true,
          writes: [lands, fails],
        },
      });
      fixture.attentionInbox.add(item);

      const res = await fixture.api.execute({ kind: 'retry-journal-write', itemId: item.id });

      const r = res as ItemMutationResponse;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('1 of 2');
      expect(fixture.eventRepository.listByTask(task.id).some((e) => e.id === 'ev_retry_ok')).toBe(
        true,
      );
      const open = fixture.attentionInbox.list().find((i) => i.id === item.id)!;
      expect(open.status).toBe('Pending');
      expect(open.payload['writes']).toHaveLength(1);
      expect((open.payload['writes'] as Event[])[0]!.id).toBe('ev_retry_fk');
      // The surviving failure is a permanent FK violation — Retry hides.
      expect(open.payload['retryable']).toBe(false);
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
   * query-providers (issue #277 — first-run setup panel)
   * ---------------------------------------------------------------- */
  describe('query-providers', () => {
    it('reports attached providers as found and skipped ones with their reason', async () => {
      const api = new CommandApi({
        ...fixture.deps,
        providerAttachment: () => ({
          attached: [
            { id: 'claude-code', command: '/usr/bin/claude' },
            { id: 'devin', command: 'devin' },
          ],
          skipped: [
            { id: 'codex', reason: 'codex not found on PATH' },
            { id: 'gemini', reason: 'disabled via FLORINA_PROVIDERS' },
          ],
          dispose: () => undefined,
        }),
      });

      const res = (await api.execute({ kind: 'query-providers' })) as ProvidersResponse;

      expect(res.ok).toBe(true);
      expect(res.probed).toBe(true);
      expect(res.providers).toEqual([
        { id: 'claude-code', found: true },
        { id: 'devin', found: true },
        { id: 'codex', found: false, detail: 'codex not found on PATH' },
        { id: 'gemini', found: false, detail: 'disabled via FLORINA_PROVIDERS' },
      ]);
    });

    it('marks itself unprobed when no probe ran (accessor returns null)', async () => {
      const api = new CommandApi({ ...fixture.deps, providerAttachment: () => null });
      const res = (await api.execute({ kind: 'query-providers' })) as ProvidersResponse;
      expect(res.ok).toBe(true);
      // Honest unknown — an empty list here is "not probed", not
      // "none found" (issue #278 follow-up).
      expect(res.providers).toEqual([]);
      expect(res.probed).toBe(false);
    });

    it('marks itself unprobed when the dependency is not wired', async () => {
      const res = (await fixture.api.execute({ kind: 'query-providers' })) as ProvidersResponse;
      expect(res.ok).toBe(true);
      expect(res.providers).toEqual([]);
      expect(res.probed).toBe(false);
    });

    it('reflects the live accessor — a later attach is visible without restart', async () => {
      let attachment: {
        attached: readonly { id: string; command: string }[];
        skipped: readonly { id: string; reason: string }[];
        dispose: () => void;
      } | null = null;
      const api = new CommandApi({ ...fixture.deps, providerAttachment: () => attachment });

      const before = (await api.execute({ kind: 'query-providers' })) as ProvidersResponse;
      expect(before.providers).toEqual([]);
      expect(before.probed).toBe(false);

      attachment = {
        attached: [{ id: 'agy', command: 'agy' }],
        skipped: [],
        dispose: () => undefined,
      };
      const after = (await api.execute({ kind: 'query-providers' })) as ProvidersResponse;
      expect(after.providers).toEqual([{ id: 'agy', found: true }]);
      expect(after.probed).toBe(true);
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

  describe('get-catchup / confirm-catchup (issue #217)', () => {
    it('get-catchup computes a digest without advancing the watermark', async () => {
      const { task, sessionId, agentId } = createTaskWithSession(fixture);
      fixture.taskStateMachine.transition(task.id, TaskState.Created, TaskState.Delegated, {
        sessionId,
        agentId,
      });

      const before = fixture.catchUpWatermark.get();
      const res = (await fixture.api.execute({ kind: 'get-catchup' })) as CatchUpResponse;

      expect(res.ok).toBe(true);
      expect(res.digest).not.toBeNull();
      expect(fixture.catchUpWatermark.get()).toBe(before);
    });

    it('confirm-catchup advances the watermark to the given timestamp', async () => {
      expect(fixture.catchUpWatermark.get()).toBeNull();

      const res = (await fixture.api.execute({
        kind: 'confirm-catchup',
        until: '2026-09-21T00:00:00.000Z',
      })) as ConfirmCatchUpResponse;

      expect(res.ok).toBe(true);
      expect(fixture.catchUpWatermark.get()).toBe('2026-09-21T00:00:00.000Z');
    });

    it('crash-before-delivery: watermark stays put if confirm-catchup is never sent', async () => {
      const first = (await fixture.api.execute({ kind: 'get-catchup' })) as CatchUpResponse;
      expect(first.ok).toBe(true);
      // Simulate the client crashing right after get-catchup, before it could
      // render/deliver the digest and send confirm-catchup.
      expect(fixture.catchUpWatermark.get()).toBeNull();

      // The next get-catchup recomputes from the same (unmoved) starting
      // point rather than silently skipping the missed window.
      const second = (await fixture.api.execute({ kind: 'get-catchup' })) as CatchUpResponse;
      expect(second.ok).toBe(true);
      expect(second.digest?.since).toBe(first.digest?.since);
    });

    it('confirm-catchup never regresses the watermark on a stale call', async () => {
      await fixture.api.execute({ kind: 'confirm-catchup', until: '2026-09-21T12:00:00.000Z' });
      await fixture.api.execute({ kind: 'confirm-catchup', until: '2026-09-21T00:00:00.000Z' });

      expect(fixture.catchUpWatermark.get()).toBe('2026-09-21T12:00:00.000Z');
    });

    it('confirm-catchup returns an error when until is empty', async () => {
      const res = (await fixture.api.execute({
        kind: 'confirm-catchup',
        until: '',
      })) as ConfirmCatchUpResponse;
      expect(res.ok).toBe(false);
      expect(res.error).toContain('until is required');
    });
  });

  describe('search-journal (issue #222)', () => {
    it('finds a journaled event by text, across tasks (not task-scoped)', async () => {
      const { task, sessionId, agentId } = createTaskWithSession(fixture);
      fixture.taskStateMachine.transition(task.id, TaskState.Created, TaskState.Delegated, {
        sessionId,
        agentId,
      });

      const res = (await fixture.api.execute({
        kind: 'search-journal',
        text: 'AgentStarted',
      })) as SearchJournalResponse;

      expect(res.ok).toBe(true);
      expect(res.events.some((e) => e.taskId === task.id)).toBe(true);
    });

    it('returns no events for text that matches nothing', async () => {
      const { task, sessionId, agentId } = createTaskWithSession(fixture);
      fixture.taskStateMachine.transition(task.id, TaskState.Created, TaskState.Delegated, {
        sessionId,
        agentId,
      });

      const res = (await fixture.api.execute({
        kind: 'search-journal',
        text: 'no-such-thing-xyz',
      })) as SearchJournalResponse;

      expect(res.ok).toBe(true);
      expect(res.events).toEqual([]);
    });

    it('with no query at all, returns events without throwing (bounded default range)', async () => {
      const res = (await fixture.api.execute({ kind: 'search-journal' })) as SearchJournalResponse;
      expect(res.ok).toBe(true);
      expect(Array.isArray(res.events)).toBe(true);
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

/* ================================================================== *
 * chat-send / chat-read / chat-clear (issue #157)
 * ================================================================== */

describe('chat commands (issue #157)', () => {
  it('chat-send journals a user message and notifies subscribers', async () => {
    const { api, chatStore, chatMessageSink } = createFixture();

    const res = (await api.execute({
      kind: 'chat-send',
      text: '  check on the image pipeline  ',
    })) as ChatSendResponse;

    expect(res.ok).toBe(true);
    expect(res.message?.role).toBe('user');
    expect(res.message?.content).toBe('check on the image pipeline');
    expect(chatStore.listVisible()).toHaveLength(1);
    expect(chatMessageSink).toHaveBeenCalledOnce();
    expect(chatMessageSink.mock.calls[0]?.[0].id).toBe(res.message?.id);
  });

  it('chat-send rejects empty text', async () => {
    const { api } = createFixture();
    const res = (await api.execute({ kind: 'chat-send', text: '   ' })) as ChatSendResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('text is required');
  });

  it('chat-read returns the visible history in order', async () => {
    const { api } = createFixture();
    await api.execute({ kind: 'chat-send', text: 'first' });
    await api.execute({ kind: 'chat-send', text: 'second' });

    const res = (await api.execute({ kind: 'chat-read' })) as ChatReadResponse;
    expect(res.ok).toBe(true);
    expect(res.messages.map((m) => m.content)).toEqual(['first', 'second']);
    expect(res.clearedAt).toBeUndefined();
  });

  it('chat-clear moves the read window but keeps the rows', async () => {
    const { api, chatStore } = createFixture();
    await api.execute({ kind: 'chat-send', text: 'before' });

    const cleared = (await api.execute({ kind: 'chat-clear' })) as ChatClearResponse;
    expect(cleared.ok).toBe(true);

    await api.execute({ kind: 'chat-send', text: 'after' });

    const res = (await api.execute({ kind: 'chat-read' })) as ChatReadResponse;
    expect(res.messages.map((m) => m.content)).toEqual(['after']);
    expect(res.clearedAt).toBeDefined();
    // History is never destroyed — the full journal still holds both.
    expect(chatStore.listAll().map((m) => m.content)).toEqual(['before', 'after']);
  });

  it('chat commands fail cleanly when the store is not wired', async () => {
    const { deps } = createFixture();
    const bare = new CommandApi({ ...deps, chatStore: undefined });

    const send = (await bare.execute({ kind: 'chat-send', text: 'hi' })) as ChatSendResponse;
    const read = (await bare.execute({ kind: 'chat-read' })) as ChatReadResponse;
    const clear = (await bare.execute({ kind: 'chat-clear' })) as ChatClearResponse;
    expect(send.ok).toBe(false);
    expect(read.ok).toBe(false);
    expect(read.messages).toEqual([]);
    expect(clear.ok).toBe(false);
  });
});

describe('chat turns (issue #158)', () => {
  it('chat-send reports turn unavailable when no service is attached', async () => {
    const { api } = createFixture();
    const res = (await api.execute({ kind: 'chat-send', text: 'hi' })) as ChatSendResponse;
    expect(res.ok).toBe(true);
    expect(res.turn).toBe('unavailable');
  });

  it('chat-send starts a turn when the service is attached', async () => {
    const { api } = createFixture();
    const startTurn = vi.fn();
    api.setChatService({ startTurn, turnInFlight: () => false });

    const res = (await api.execute({ kind: 'chat-send', text: 'hi' })) as ChatSendResponse;
    expect(res.ok).toBe(true);
    expect(res.turn).toBe('started');
    expect(startTurn).toHaveBeenCalledOnce();
  });

  it('chat-read surfaces the Method contract version when the service reports one (#287)', async () => {
    const { api } = createFixture();
    api.setChatService({
      startTurn: vi.fn(),
      turnInFlight: () => false,
      methodVersion: 'florina-method/1.0',
    });

    const res = (await api.execute({ kind: 'chat-read' })) as ChatReadResponse;
    expect(res.ok).toBe(true);
    expect(res.methodVersion).toBe('florina-method/1.0');
  });

  it('chat-read omits methodVersion when the service carries no contract', async () => {
    const { api } = createFixture();
    api.setChatService({ startTurn: vi.fn(), turnInFlight: () => false });

    const res = (await api.execute({ kind: 'chat-read' })) as ChatReadResponse;
    expect(res.ok).toBe(true);
    expect(res.methodVersion).toBeUndefined();
  });

  it('rejects a second send while a turn is in flight — nothing journaled', async () => {
    const { api, chatStore } = createFixture();
    api.setChatService({ startTurn: vi.fn(), turnInFlight: () => true });

    const res = (await api.execute({ kind: 'chat-send', text: 'hi' })) as ChatSendResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('already in flight');
    expect(chatStore.listVisible()).toHaveLength(0);
  });

  it('a retried send with the same clientId dedupes — never journals twice (issue #263)', async () => {
    const { api, chatStore, chatMessageSink } = createFixture();
    const startTurn = vi.fn();
    api.setChatService({ startTurn, turnInFlight: () => false });

    const first = (await api.execute({
      kind: 'chat-send',
      text: 'same draft',
      clientId: 'draft-1',
    })) as ChatSendResponse;
    expect(first.ok).toBe(true);
    expect(first.message?.id).toBe('draft-1');

    // The retry path: the original response was lost (or the row's Retry
    // fired) — same clientId must return the journaled row, not append.
    const retry = (await api.execute({
      kind: 'chat-send',
      text: 'same draft',
      clientId: 'draft-1',
    })) as ChatSendResponse;
    expect(retry.ok).toBe(true);
    expect(retry.message?.id).toBe('draft-1');
    expect(chatStore.listVisible()).toHaveLength(1);
    // No second turn — the retry replays the journaled row only.
    expect(startTurn).toHaveBeenCalledOnce();
    // The sink re-fires so a client that missed the first push heals.
    expect(chatMessageSink).toHaveBeenCalledTimes(2);
  });

  it('a deduped retry reports the in-flight turn it belongs to', async () => {
    const { api } = createFixture();
    let inFlight = false;
    api.setChatService({ startTurn: vi.fn(), turnInFlight: () => inFlight });

    await api.execute({ kind: 'chat-send', text: 'hi', clientId: 'draft-2' });
    // The turn the first send kicked off is still running — the retry
    // dedupes (no rejection) and reports that turn's state.
    inFlight = true;
    const res = (await api.execute({
      kind: 'chat-send',
      text: 'hi',
      clientId: 'draft-2',
    })) as ChatSendResponse;
    expect(res.ok).toBe(true);
    expect(res.turn).toBe('started');
  });

  it('sends without a clientId still journal with a generated id', async () => {
    const { api, chatStore } = createFixture();
    const res = (await api.execute({ kind: 'chat-send', text: 'hi' })) as ChatSendResponse;
    expect(res.ok).toBe(true);
    expect(res.message?.id).toMatch(/^msg_/);
    expect(chatStore.listVisible()).toHaveLength(1);
  });

  it('a clientId colliding with different journaled content is rejected — never silently dropped', async () => {
    const { api, chatStore } = createFixture();
    await api.execute({ kind: 'chat-send', text: 'original', clientId: 'draft-9' });

    const res = (await api.execute({
      kind: 'chat-send',
      text: 'edited draft',
      clientId: 'draft-9',
    })) as ChatSendResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('clientId');
    // Only the original row exists — the collision didn't touch it.
    expect(chatStore.listAll().map((m) => m.content)).toEqual(['original']);
  });

  it('a non-string clientId is rejected instead of throwing', async () => {
    const { api } = createFixture();
    const res = (await api.execute({
      kind: 'chat-send',
      text: 'hi',
      clientId: 42 as unknown as string,
    })) as ChatSendResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('clientId');
  });
});

/* ================================================================== *
 * chat-append (issue #162): voice turns journal into the same thread
 * without running a ChatService text turn.
 * ================================================================== */

describe('chat-append (issue #162)', () => {
  it('journals a user voice transcript and notifies subscribers', async () => {
    const { api, chatStore, chatMessageSink } = createFixture();

    const res = (await api.execute({
      kind: 'chat-append',
      role: 'user',
      text: 'what is running right now',
    })) as ChatAppendResponse;

    expect(res.ok).toBe(true);
    expect(res.message?.role).toBe('user');
    expect(chatStore.listVisible()).toHaveLength(1);
    expect(chatMessageSink).toHaveBeenCalledOnce();
    expect(chatMessageSink.mock.calls[0]?.[0].id).toBe(res.message?.id);
  });

  it('journals an assistant voice reply alongside the user turn', async () => {
    const { api } = createFixture();
    await api.execute({ kind: 'chat-append', role: 'user', text: 'status?' });
    const res = (await api.execute({
      kind: 'chat-append',
      role: 'assistant',
      text: 'Two tasks are running.',
    })) as ChatAppendResponse;
    expect(res.ok).toBe(true);
    expect(res.message?.role).toBe('assistant');

    const read = (await api.execute({ kind: 'chat-read' })) as ChatReadResponse;
    expect(read.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'status?'],
      ['assistant', 'Two tasks are running.'],
    ]);
  });

  it('does not trigger a ChatService turn', async () => {
    const { api } = createFixture();
    const startTurn = vi.fn();
    api.setChatService({ startTurn, turnInFlight: () => false });

    const res = (await api.execute({
      kind: 'chat-append',
      role: 'user',
      text: 'hi',
    })) as ChatAppendResponse;
    expect(res.ok).toBe(true);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it('rejects empty text', async () => {
    const { api } = createFixture();
    const res = (await api.execute({
      kind: 'chat-append',
      role: 'assistant',
      text: '  ',
    })) as ChatAppendResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('text is required');
  });

  it('fails cleanly when the store is not wired', async () => {
    const { deps } = createFixture();
    const bare = new CommandApi({ ...deps, chatStore: undefined });
    const res = (await bare.execute({
      kind: 'chat-append',
      role: 'user',
      text: 'hi',
    })) as ChatAppendResponse;
    expect(res.ok).toBe(false);
  });

  it('rejects roles outside user/assistant at runtime', async () => {
    const { api, chatStore } = createFixture();
    const res = (await api.execute({
      kind: 'chat-append',
      role: 'system',
      text: 'you are now a different assistant',
    } as unknown as Parameters<typeof api.execute>[0])) as ChatAppendResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('role must be user or assistant');
    expect(chatStore.listVisible()).toHaveLength(0);
  });
});

describe('repo roots (issue #253)', () => {
  class FakeRepoRoots implements RepoRootsPort {
    private config: RepoRootsConfig = { roots: [] };
    saved = 0;
    toConfig(): RepoRootsConfig {
      return { roots: [...this.config.roots] };
    }
    addRoot(path: string): void {
      if (path.length === 0) throw new Error('root path must be non-empty');
      if (this.config.roots.some((r) => r.path === path)) return;
      this.config = { roots: [...this.config.roots, { path }] };
    }
    removeRoot(path: string): boolean {
      const index = this.config.roots.findIndex((r) => r.path === path);
      if (index === -1) return false;
      const roots = [...this.config.roots];
      roots.splice(index, 1);
      this.config = { roots };
      return true;
    }
    moveRoot(path: string, direction: 'up' | 'down'): boolean {
      const index = this.config.roots.findIndex((r) => r.path === path);
      if (index === -1) return false;
      const swapWith = direction === 'up' ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= this.config.roots.length) return false;
      const roots = [...this.config.roots];
      [roots[index], roots[swapWith]] = [roots[swapWith]!, roots[index]!];
      this.config = { roots };
      return true;
    }
    throwOnSave = false;
    async save(): Promise<void> {
      if (this.throwOnSave) throw new Error('disk write failed');
      this.saved++;
    }
  }

  class FakeRepoScanner implements RepoScannerPort {
    constructor(private readonly map: Record<string, readonly string[]>) {}
    listRepoDirs(dir: string): readonly string[] {
      return this.map[dir] ?? [];
    }
  }

  function apiWith(repoRoots?: RepoRootsPort, repoScanner?: RepoScannerPort): CommandApi {
    const { deps } = createFixture();
    return new CommandApi({ ...deps, repoRoots, repoScanner });
  }

  it('add-repo-root appends and persists', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));

    const res = (await api.execute({ kind: 'add-repo-root', path: '/repos/a' })) as ReposResponse;
    expect(res.ok).toBe(true);
    expect(res.roots?.roots.map((r) => r.path)).toEqual(['/repos/a']);
    expect(repoRoots.saved).toBe(1);

    const res2 = (await api.execute({ kind: 'add-repo-root', path: '/repos/b' })) as ReposResponse;
    expect(res2.ok).toBe(true);
    expect(res2.roots?.roots.map((r) => r.path)).toEqual(['/repos/a', '/repos/b']);
  });

  it('add-repo-root is idempotent -- adding an already-configured path is a no-op that still acks ok', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));
    await api.execute({ kind: 'add-repo-root', path: '/repos/a' });
    const res = (await api.execute({ kind: 'add-repo-root', path: '/repos/a' })) as ReposResponse;
    expect(res.ok).toBe(true);
    expect(res.roots?.roots.map((r) => r.path)).toEqual(['/repos/a']);
  });

  it('two "concurrent" add-repo-root commands (fired without awaiting the first) both land -- neither is lost (regression: the old set-repo-roots read-then-write race)', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));

    // Fire both without awaiting the first -- the old design (read
    // current roots via query-repos, compute the merged array, then
    // set-repo-roots the whole list) would let the second call compute
    // its "new whole list" from the same stale empty read and silently
    // discard the first add. add-repo-root's atomicity means both must
    // land regardless of interleaving.
    const [res1, res2] = await Promise.all([
      api.execute({ kind: 'add-repo-root', path: '/repos/a' }),
      api.execute({ kind: 'add-repo-root', path: '/repos/b' }),
    ]);
    expect((res1 as ReposResponse).ok).toBe(true);
    expect((res2 as ReposResponse).ok).toBe(true);

    const finalRes = (await api.execute({ kind: 'query-repos' })) as ReposResponse;
    const paths = finalRes.roots?.roots.map((r) => r.path) ?? [];
    expect(paths).toContain('/repos/a');
    expect(paths).toContain('/repos/b');
    expect(paths).toHaveLength(2);
  });

  it('remove-repo-root removes by path; removing an unknown path is a safe no-op, not an error', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));
    await api.execute({ kind: 'add-repo-root', path: '/repos/a' });
    await api.execute({ kind: 'add-repo-root', path: '/repos/b' });

    const res = (await api.execute({
      kind: 'remove-repo-root',
      path: '/repos/a',
    })) as ReposResponse;
    expect(res.ok).toBe(true);
    expect(res.roots?.roots.map((r) => r.path)).toEqual(['/repos/b']);

    // Stale row action referencing an already-removed path -- must not error.
    const staleRes = (await api.execute({
      kind: 'remove-repo-root',
      path: '/repos/a',
    })) as ReposResponse;
    expect(staleRes.ok).toBe(true);
    expect(staleRes.roots?.roots.map((r) => r.path)).toEqual(['/repos/b']);
  });

  it('a stale remove-repo-root cannot clobber a root added after the row was rendered', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));
    await api.execute({ kind: 'add-repo-root', path: '/repos/a' });
    // Simulates a "Remove A" button rendered when roots=[A], clicked
    // after a concurrent action already added B -- must remove only A.
    await api.execute({ kind: 'add-repo-root', path: '/repos/b' });
    const res = (await api.execute({
      kind: 'remove-repo-root',
      path: '/repos/a',
    })) as ReposResponse;
    expect(res.ok).toBe(true);
    expect(res.roots?.roots.map((r) => r.path)).toEqual(['/repos/b']);
  });

  it('move-repo-root swaps with the neighbor in the given direction', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));
    await api.execute({ kind: 'add-repo-root', path: '/repos/a' });
    await api.execute({ kind: 'add-repo-root', path: '/repos/b' });

    const res = (await api.execute({
      kind: 'move-repo-root',
      path: '/repos/a',
      direction: 'down',
    })) as ReposResponse;
    expect(res.ok).toBe(true);
    expect(res.roots?.roots.map((r) => r.path)).toEqual(['/repos/b', '/repos/a']);
  });

  it('move-repo-root on an unknown path is a safe no-op that still acks ok', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));
    await api.execute({ kind: 'add-repo-root', path: '/repos/a' });
    const res = (await api.execute({
      kind: 'move-repo-root',
      path: '/repos/removed-already',
      direction: 'up',
    })) as ReposResponse;
    expect(res.ok).toBe(true);
    expect(res.roots?.roots.map((r) => r.path)).toEqual(['/repos/a']);
  });

  it('query-repos returns the configured roots and the repos discovered under them', async () => {
    const repoRoots = new FakeRepoRoots();
    repoRoots.addRoot('/repos');
    const api = apiWith(
      repoRoots,
      new FakeRepoScanner({ '/repos': ['/repos/agent-secretary', '/repos/website'] }),
    );

    const res = (await api.execute({ kind: 'query-repos' })) as ReposResponse;
    expect(res.ok).toBe(true);
    expect(res.repos?.map((r) => r.name)).toEqual(['agent-secretary', 'website']);
  });

  it('query-repos narrows results by the search query', async () => {
    const repoRoots = new FakeRepoRoots();
    repoRoots.addRoot('/repos');
    const api = apiWith(
      repoRoots,
      new FakeRepoScanner({ '/repos': ['/repos/agent-secretary', '/repos/website'] }),
    );

    const res = (await api.execute({ kind: 'query-repos', query: 'agent' })) as ReposResponse;
    expect(res.ok).toBe(true);
    expect(res.repos?.map((r) => r.name)).toEqual(['agent-secretary']);
  });

  it('add-repo-root fails cleanly when repo roots are not wired', async () => {
    const api = apiWith(undefined, new FakeRepoScanner({}));
    const res = (await api.execute({ kind: 'add-repo-root', path: '/repos/a' })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not wired');
  });

  it('remove-repo-root fails cleanly when repo roots are not wired', async () => {
    const api = apiWith(undefined, new FakeRepoScanner({}));
    const res = (await api.execute({
      kind: 'remove-repo-root',
      path: '/repos/a',
    })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not wired');
  });

  it('move-repo-root fails cleanly when repo roots are not wired', async () => {
    const api = apiWith(undefined, new FakeRepoScanner({}));
    const res = (await api.execute({
      kind: 'move-repo-root',
      path: '/repos/a',
      direction: 'up',
    })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not wired');
  });

  it('query-repos fails cleanly when the scanner is not wired', async () => {
    const api = apiWith(new FakeRepoRoots(), undefined);
    const res = (await api.execute({ kind: 'query-repos' })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not wired');
  });

  it('query-repos fails cleanly when repo roots are not wired', async () => {
    const api = apiWith(undefined, new FakeRepoScanner({}));
    const res = (await api.execute({ kind: 'query-repos' })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not wired');
  });

  it('a malformed add-repo-root (blank path) returns an error, not a throw', async () => {
    const api = apiWith(new FakeRepoRoots(), new FakeRepoScanner({}));
    const res = (await api.execute({ kind: 'add-repo-root', path: '' })) as ReposResponse;
    expect(res.ok).toBe(false);
  });

  it('a non-string path (malformed renderer JSON) is rejected at the runtime boundary, not passed through to the store', async () => {
    const api = apiWith(new FakeRepoRoots(), new FakeRepoScanner({}));
    const res = (await api.execute({
      kind: 'add-repo-root',
      path: 123 as unknown as string,
    })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('path');
  });

  it('add-repo-root returns ok:false (not an unhandled rejection) when persisting fails', async () => {
    const repoRoots = new FakeRepoRoots();
    repoRoots.throwOnSave = true;
    const api = apiWith(repoRoots, new FakeRepoScanner({}));
    const res = (await api.execute({ kind: 'add-repo-root', path: '/repos/a' })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('disk write failed');
  });

  it('a malformed move-repo-root direction (neither "up" nor "down") is rejected at the runtime boundary', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));
    await api.execute({ kind: 'add-repo-root', path: '/repos/a' });
    const res = (await api.execute({
      kind: 'move-repo-root',
      path: '/repos/a',
      direction: 'sideways' as unknown as 'up',
    })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('direction');
  });

  it('remove-repo-root returns ok:false (not an unhandled rejection) when persisting fails', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));
    await api.execute({ kind: 'add-repo-root', path: '/repos/a' });
    repoRoots.throwOnSave = true;
    const res = (await api.execute({
      kind: 'remove-repo-root',
      path: '/repos/a',
    })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('disk write failed');
  });

  it('move-repo-root returns ok:false (not an unhandled rejection) when persisting fails', async () => {
    const repoRoots = new FakeRepoRoots();
    const api = apiWith(repoRoots, new FakeRepoScanner({}));
    await api.execute({ kind: 'add-repo-root', path: '/repos/a' });
    await api.execute({ kind: 'add-repo-root', path: '/repos/b' });
    repoRoots.throwOnSave = true;
    const res = (await api.execute({
      kind: 'move-repo-root',
      path: '/repos/a',
      direction: 'down',
    })) as ReposResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('disk write failed');
  });
});

/* ================================================================== *
 * Florina Method dispatch contract (issue #288)
 * ================================================================== */

import { SessionManager } from '../src/core/application/use-cases/tasks/session-manager.js';
import {
  FLORINA_CONTRACT_VERSION,
  withFlorinaContract,
} from '../src/core/application/use-cases/prompting/florina-method.js';
import type {
  AgentRuntimePort,
  SessionConfig,
  StartRunResult,
} from '../src/core/application/ports/outbound/agent-runtime.js';

/** Adapter stub that records the SessionConfig handed to startRun. */
class CapturingAdapter implements AgentRuntimePort {
  readonly fidelityTier = 'B' as const;
  readonly runs: SessionConfig[] = [];

  async connect(): Promise<void> {}
  async startRun(_taskId: string, config: SessionConfig): Promise<StartRunResult> {
    this.runs.push(config);
    return { sessionId: 'cap-run-1', started: true };
  }
  streamEvents(): AsyncIterable<Event> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Event>>(() => {}),
      }),
    };
  }
  async cancel(): Promise<void> {}
  async disconnect(): Promise<void> {}
}

describe('Florina Method dispatch (issue #288)', () => {
  function apiWithAdapter(fixture: Fixture, methodEnabled?: boolean) {
    const adapter = new CapturingAdapter();
    const api = new CommandApi({
      ...fixture.deps,
      sessionManager: new SessionManager(fixture.eventBus),
      adapterRegistry: { create: () => adapter },
      ...(methodEnabled !== undefined ? { methodEnabled } : {}),
    });
    return { api, adapter };
  }

  it('prepends the contract to the objective fallback path', async () => {
    const fixture = createFixture();
    const { api, adapter } = apiWithAdapter(fixture);
    const { task, agentId } = createTaskWithSession(fixture);

    const res = await api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId,
      sessionConfig: { workingDir: '/repo/wt' },
    });
    expect(res.ok).toBe(true);

    const dispatched = adapter.runs[0]?.objective;
    expect(dispatched).toMatch(/^You are running under the Florina Method/);
    expect(dispatched).toContain(FLORINA_CONTRACT_VERSION);
    expect(dispatched).toContain('Test objective');
    // Contract precedes the task text.
    expect(dispatched!.indexOf('Florina Method')).toBeLessThan(
      dispatched!.indexOf('Test objective'),
    );
  });

  it('prepends the contract to an explicit sessionConfig.prompt override', async () => {
    const fixture = createFixture();
    const { api, adapter } = apiWithAdapter(fixture);
    const { task, agentId } = createTaskWithSession(fixture);

    await api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId,
      sessionConfig: { workingDir: '/repo/wt', prompt: 'Custom capsule prompt' },
    });

    const dispatched = adapter.runs[0]?.objective ?? '';
    expect(dispatched).toMatch(/^You are running under the Florina Method/);
    expect(dispatched).toContain('Custom capsule prompt');
  });

  it('journals the contract version on the AgentStarted event', async () => {
    const fixture = createFixture();
    const { api } = apiWithAdapter(fixture);
    const { task, agentId } = createTaskWithSession(fixture);
    const publishSpy = vi.spyOn(fixture.eventBus, 'publish');

    await api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId,
      sessionConfig: { workingDir: '/repo/wt' },
    });

    const started = publishSpy.mock.calls.map((c) => c[0]).find((e) => e.type === 'AgentStarted');
    expect(started).toBeDefined();
    expect(started && 'methodVersion' in started ? started.methodVersion : undefined).toBe(
      FLORINA_CONTRACT_VERSION,
    );
  });

  it('opt-out dispatches the raw prompt and journals the disabled state', async () => {
    const fixture = createFixture();
    const { api, adapter } = apiWithAdapter(fixture, false);
    const { task, agentId } = createTaskWithSession(fixture);
    const publishSpy = vi.spyOn(fixture.eventBus, 'publish');

    await api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId,
      sessionConfig: { workingDir: '/repo/wt' },
    });

    expect(adapter.runs[0]?.objective).toBe('Test objective');
    const started = publishSpy.mock.calls.map((c) => c[0]).find((e) => e.type === 'AgentStarted');
    expect(started && 'methodVersion' in started ? started.methodVersion : undefined).toBe(
      'disabled',
    );
  });

  it('a disabled seam journals the embedded version when the prompt already carries a contract', async () => {
    const fixture = createFixture();
    const { api, adapter } = apiWithAdapter(fixture, false);
    const { task, agentId } = createTaskWithSession(fixture);
    const publishSpy = vi.spyOn(fixture.eventBus, 'publish');
    // A contract-bound prompt arriving through the override seam (e.g. a
    // failover briefing or a parent daemon's delegation) must journal
    // the version it actually carries — never a false 'disabled' claim.
    const boundPrompt = withFlorinaContract('pre-briefed task');

    await api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId,
      sessionConfig: { workingDir: '/repo/wt', prompt: boundPrompt },
    });

    expect(adapter.runs[0]?.objective).toBe(boundPrompt);
    const started = publishSpy.mock.calls.map((c) => c[0]).find((e) => e.type === 'AgentStarted');
    expect(started && 'methodVersion' in started ? started.methodVersion : undefined).toBe(
      FLORINA_CONTRACT_VERSION,
    );
  });
});
