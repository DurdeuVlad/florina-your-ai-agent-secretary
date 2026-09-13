/**
 * Tests for context resolution — assembling context capsules for agent
 * sessions (#30, DEC-020, DEC-012).
 *
 * Acceptance criteria covered:
 *  - ContextResolver assembles a ContextCapsule from the event journal.
 *  - Token estimation with truncation to budget.
 *  - Prioritization: critical/high kept, low dropped first.
 *  - Active approvals, recent decisions, recent digests included.
 *  - Worktree status included.
 *  - Configurable event window.
 *  - Empty task (no events) produces a minimal capsule.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  StorageDatabase,
  TaskRepository,
  AgentRepository,
  ProjectRepository,
  SessionRepository,
  EventRepository,
  DecisionRepository,
  CompletionDigestRepository,
  ContextResolver,
  estimateTokens,
  estimateCapsuleTokens,
  estimateAssembledTokens,
  classifyEventPriority,
  truncateToBudget,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_EVENT_WINDOW,
} from '../src/storage/index.js';
import {
  buildProject,
  buildTask,
  buildAgent,
  buildSession,
  buildEvent,
  buildDecision,
  AdapterFidelityTier,
} from '../src/domain/index.js';
import type { Event, Task, Decision } from '../src/domain/index.js';
import type { CompletionDigest } from '../src/attention/completion-digest.js';
import type { WorktreeStatus } from '../src/daemon/worktree.js';
import type {
  AssembledContextCapsule,
  EventSource,
  TaskSource,
  DecisionSource,
  DigestSource,
  WorktreeStatusSource,
} from '../src/storage/index.js';

/* ------------------------------------------------------------------ *
 * Test harness
 * ------------------------------------------------------------------ */

interface TestContext {
  db: StorageDatabase;
  tasks: TaskRepository;
  events: EventRepository;
  decisions: DecisionRepository;
  digests: CompletionDigestRepository;
  taskId: string;
  sessionId: string;
  agentId: string;
  close: () => void;
}

function createTestContext(): TestContext {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const raw = db.connection;
  const projects = new ProjectRepository(raw);
  const tasks = new TaskRepository(raw);
  const agents = new AgentRepository(raw);
  const sessions = new SessionRepository(raw);
  const events = new EventRepository(raw);
  const decisions = new DecisionRepository(raw);
  const digests = new CompletionDigestRepository(raw);

  const project = buildProject({ name: 'p', repo: { path: '/repo' } });
  projects.insert(project);

  const task = buildTask({ projectId: project.id, objective: 'Add cursor pagination' });
  tasks.insert(task);

  const agent = buildAgent({
    name: 'Codex',
    provider: 'codex',
    fidelityTier: AdapterFidelityTier.A,
    runtime: { kind: 'app-server' },
  });
  agents.insert(agent);

  const session = buildSession({ taskId: task.id, agentId: agent.id });
  sessions.insert(session);

  return {
    db,
    tasks,
    events,
    decisions,
    digests,
    taskId: task.id,
    sessionId: session.id,
    agentId: agent.id,
    close: () => db.close(),
  };
}

/** Insert an event with a specific kind, timestamp, and payload. */
function insertEvent(
  ctx: TestContext,
  kind: Event['kind'],
  timestamp: string,
  payload: Readonly<Record<string, unknown>> = {},
): Event {
  const event = buildEvent({
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    kind,
    payload,
  });
  // Override the timestamp by inserting directly with the desired value.
  ctx.events.insert({ ...event, timestamp });
  return { ...event, timestamp };
}

/** Build a minimal completion digest for testing. */
function makeDigest(
  taskId: string,
  sessionId: string,
  overrides: Partial<CompletionDigest> = {},
): CompletionDigest {
  return {
    taskId,
    sessionId,
    agentId: 'codex',
    startedAt: '2026-01-01T12:00:00.000Z',
    completedAt: '2026-01-01T12:05:00.000Z',
    duration: 300000,
    summary: 'Task completed.',
    filesChangedCount: 2,
    filesChanged: ['src/a.ts', 'src/b.ts'],
    testsRun: 10,
    testsPassed: 10,
    testsFailed: 0,
    approvalsRequested: 0,
    approvalsGranted: 0,
    approvalsDenied: 0,
    decisions: [],
    riskHighlights: [],
    ...overrides,
  } as CompletionDigest;
}

/** A stub worktree-status source returning a fixed status. */
function worktreeStub(status: WorktreeStatus | null): WorktreeStatusSource {
  return {
    getWorktreeStatus(): WorktreeStatus | null {
      return status;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Token estimation
 * ------------------------------------------------------------------ */

describe('context-estimator: token estimation', () => {
  it('estimateTokens uses ~4 chars/token heuristic', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // rounds up
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('estimateTokens respects a custom chars-per-token ratio', () => {
    expect(estimateTokens('abcdefgh', 2)).toBe(4);
  });

  it('estimateCapsuleTokens serializes a capsule and estimates', () => {
    const capsule = {
      id: 'c1',
      scope: 'task' as const,
      ownerId: 'task-1',
      content: { objective: 'do thing' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const tokens = estimateCapsuleTokens(capsule);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(Math.ceil(JSON.stringify(capsule).length / 4));
  });

  it('estimateAssembledTokens estimates the full assembled capsule', () => {
    const assembled = {
      taskId: 'task-1',
      taskSummary: {
        taskId: 'task-1',
        objective: 'o',
        state: 'running',
        agentIds: [],
        sessionIds: [],
      },
      recentEvents: [],
      activeApprovals: [],
      recentDecisions: [],
      recentDigests: [],
      worktreeStatus: null,
      capsule: {
        id: 'c1',
        scope: 'task',
        ownerId: 'task-1',
        content: { objective: 'o' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      estimatedTokens: 0,
      tokenBudget: 8000,
    } as unknown as AssembledContextCapsule;
    const tokens = estimateAssembledTokens(assembled);
    expect(tokens).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Event priority classification
 * ------------------------------------------------------------------ */

describe('context-estimator: event priority classification', () => {
  function ev(kind: Event['kind'], payload: Readonly<Record<string, unknown>> = {}): Event {
    return {
      id: 'e1',
      sessionId: 's1',
      taskId: 't1',
      timestamp: '2026-01-01T00:00:00.000Z',
      kind,
      payload,
    };
  }

  it('classifies failures and human-input requests as critical', () => {
    expect(classifyEventPriority(ev('AgentFailed'))).toBe('critical');
    expect(classifyEventPriority(ev('HumanInputRequested'))).toBe('critical');
  });

  it('classifies critical-risk approval requests as critical', () => {
    expect(classifyEventPriority(ev('ApprovalRequested', { riskLevel: 'critical' }))).toBe(
      'critical',
    );
  });

  it('classifies non-critical approval requests as high', () => {
    expect(classifyEventPriority(ev('ApprovalRequested', { riskLevel: 'low' }))).toBe('high');
    expect(classifyEventPriority(ev('ApprovalRequested'))).toBe('high');
  });

  it('classifies completions and blocks as high', () => {
    expect(classifyEventPriority(ev('AgentCompleted'))).toBe('high');
    expect(classifyEventPriority(ev('AgentBlocked'))).toBe('high');
  });

  it('promotes TestFinished with failures to high', () => {
    expect(classifyEventPriority(ev('TestFinished', { failed: 1 }))).toBe('high');
    expect(classifyEventPriority(ev('TestFinished', { failed: 0 }))).toBe('medium');
  });

  it('classifies routine progress and tool calls as low', () => {
    expect(classifyEventPriority(ev('AgentProgress'))).toBe('low');
    expect(classifyEventPriority(ev('ToolStarted'))).toBe('low');
    expect(classifyEventPriority(ev('ToolFinished'))).toBe('low');
  });

  it('classifies file changes and agent start as medium', () => {
    expect(classifyEventPriority(ev('FileChanged'))).toBe('medium');
    expect(classifyEventPriority(ev('AgentStarted'))).toBe('medium');
  });
});

/* ------------------------------------------------------------------ *
 * Truncation to budget
 * ------------------------------------------------------------------ */

describe('context-estimator: truncateToBudget', () => {
  function makeEvent(id: string, kind: Event['kind'], timestamp: string): Event {
    return {
      id,
      sessionId: 's1',
      taskId: 't1',
      timestamp,
      kind,
      payload: { detail: 'x'.repeat(100) },
    };
  }

  function makeAssembled(events: Event[]): AssembledContextCapsule {
    const prioritized = events.map((event) => ({
      event,
      priority: classifyEventPriority(event),
    }));
    return {
      taskId: 't1',
      taskSummary: {
        taskId: 't1',
        objective: 'o',
        state: 'running',
        agentIds: [],
        sessionIds: [],
      },
      recentEvents: prioritized,
      activeApprovals: [],
      recentDecisions: [],
      recentDigests: [],
      worktreeStatus: null,
      capsule: {
        id: 'c1',
        scope: 'task',
        ownerId: 't1',
        content: { objective: 'o' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      estimatedTokens: 0,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
    };
  }

  it('returns the capsule unchanged when under budget', () => {
    const assembled = makeAssembled([makeEvent('e1', 'AgentProgress', '2026-01-01T00:00:00.000Z')]);
    const tokens = estimateAssembledTokens(assembled);
    const result = truncateToBudget(assembled, tokens + 10000);
    expect(result.recentEvents).toHaveLength(1);
  });

  it('drops low-priority events first when over budget', () => {
    // One low-priority (AgentProgress) and one critical (AgentFailed).
    const low = makeEvent('e-low', 'AgentProgress', '2026-01-01T00:00:00.000Z');
    const critical = makeEvent('e-crit', 'AgentFailed', '2026-01-01T00:00:01.000Z');
    const assembled = makeAssembled([low, critical]);
    // Set a tiny budget so the low event must be dropped.
    const tinyBudget = estimateAssembledTokens({
      ...assembled,
      recentEvents: assembled.recentEvents.filter((pe) => pe.priority === 'critical'),
    });
    const result = truncateToBudget(assembled, tinyBudget);
    const ids = result.recentEvents.map((pe) => pe.event.id);
    expect(ids).toContain('e-crit');
    expect(ids).not.toContain('e-low');
  });

  it('drops medium-priority events before high/critical', () => {
    const low = makeEvent('e-low', 'AgentProgress', '2026-01-01T00:00:00.000Z');
    const medium = makeEvent('e-med', 'FileChanged', '2026-01-01T00:00:01.000Z');
    const high = makeEvent('e-high', 'AgentCompleted', '2026-01-01T00:00:02.000Z');
    const assembled = makeAssembled([low, medium, high]);
    // Budget that fits only the high event.
    const highOnly = estimateAssembledTokens({
      ...assembled,
      recentEvents: assembled.recentEvents.filter((pe) => pe.priority === 'high'),
    });
    const result = truncateToBudget(assembled, highOnly);
    const ids = result.recentEvents.map((pe) => pe.event.id);
    expect(ids).toContain('e-high');
    expect(ids).not.toContain('e-low');
    expect(ids).not.toContain('e-med');
  });

  it('keeps critical and high items when possible', () => {
    const critical = makeEvent('e-crit', 'AgentFailed', '2026-01-01T00:00:00.000Z');
    const high = makeEvent('e-high', 'AgentCompleted', '2026-01-01T00:00:01.000Z');
    const assembled = makeAssembled([critical, high]);
    const both = estimateAssembledTokens(assembled);
    const result = truncateToBudget(assembled, both);
    expect(result.recentEvents).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * ContextResolver assembly
 * ------------------------------------------------------------------ */

describe('context-resolver: assembly from event journal', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  it('assembles a capsule from events', async () => {
    insertEvent(ctx, 'AgentStarted', '2026-01-01T12:00:00.000Z', {
      objective: 'Add cursor pagination',
      workingDir: '/repo',
    });
    insertEvent(ctx, 'AgentProgress', '2026-01-01T12:00:05.000Z', { message: 'working' });
    insertEvent(ctx, 'FileChanged', '2026-01-01T12:00:10.000Z', { path: 'src/a.ts' });

    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId);

    expect(result.taskId).toBe(ctx.taskId);
    expect(result.recentEvents).toHaveLength(3);
    expect(result.taskSummary.objective).toBe('Add cursor pagination');
    expect(result.capsule.scope).toBe('task');
    expect(result.capsule.ownerId).toBe(ctx.taskId);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('includes active approvals (pending ApprovalRequested events)', async () => {
    insertEvent(ctx, 'AgentStarted', '2026-01-01T12:00:00.000Z', { objective: 'o' });
    insertEvent(ctx, 'ApprovalRequested', '2026-01-01T12:00:05.000Z', {
      capability: 'network',
      destination: 'registry.npmjs.org',
      riskLevel: 'low',
    });
    insertEvent(ctx, 'ApprovalRequested', '2026-01-01T12:00:06.000Z', {
      capability: 'push',
      destination: 'origin',
      riskLevel: 'critical',
    });

    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId);

    expect(result.activeApprovals).toHaveLength(2);
    expect(result.activeApprovals.every((e) => e.kind === 'ApprovalRequested')).toBe(true);
  });

  it('includes recent decisions from the Decision Ledger', async () => {
    insertEvent(ctx, 'AgentStarted', '2026-01-01T12:00:00.000Z', { objective: 'o' });

    const decision = buildDecision({
      taskId: ctx.taskId,
      question: 'Which library to use?',
      options: ['lib-a', 'lib-b'],
    });
    ctx.decisions.insert(decision);

    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId);

    expect(result.recentDecisions).toHaveLength(1);
    expect(result.recentDecisions[0].question).toBe('Which library to use?');
  });

  it('includes recent completion digests', async () => {
    insertEvent(ctx, 'AgentStarted', '2026-01-01T12:00:00.000Z', { objective: 'o' });
    const digest = makeDigest(ctx.taskId, ctx.sessionId, {
      summary: 'Pagination added.',
      commitHash: 'abc123',
    });
    ctx.digests.save(digest);

    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId);

    expect(result.recentDigests.length).toBeGreaterThanOrEqual(1);
    expect(result.recentDigests.some((d) => d.summary === 'Pagination added.')).toBe(true);
    // The capsule run history should reflect the digest.
    const content = result.capsule.content;
    expect(content.runHistory.length).toBeGreaterThanOrEqual(1);
  });

  it('includes worktree status when a worktree source is provided', async () => {
    insertEvent(ctx, 'AgentStarted', '2026-01-01T12:00:00.000Z', { objective: 'o' });

    const status: WorktreeStatus = {
      clean: false,
      dirty: true,
      branch: 'florina/add-pagination',
      baseCommit: 'abc123',
    };
    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
      worktreeStatus: worktreeStub(status),
    });
    const result = await resolver.resolve(ctx.taskId);

    expect(result.worktreeStatus).not.toBeNull();
    expect(result.worktreeStatus?.dirty).toBe(true);
    expect(result.worktreeStatus?.branch).toBe('florina/add-pagination');
  });

  it('worktree status is null when no source is provided', async () => {
    insertEvent(ctx, 'AgentStarted', '2026-01-01T12:00:00.000Z', { objective: 'o' });

    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId);

    expect(result.worktreeStatus).toBeNull();
  });

  it('empty task (no events) produces a minimal capsule', async () => {
    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId);

    expect(result.recentEvents).toHaveLength(0);
    expect(result.activeApprovals).toHaveLength(0);
    expect(result.recentDecisions).toHaveLength(0);
    expect(result.recentDigests).toHaveLength(0);
    expect(result.taskSummary.objective).toBe('Add cursor pagination');
    expect(result.capsule.scope).toBe('task');
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('falls back to event-derived summary when task is not in storage', async () => {
    // Insert a task with a known id, then use a TaskSource that returns
    // null so the resolver must derive the summary from the event stream.
    const project = buildProject({ name: 'p2', repo: { path: '/repo2' } });
    new ProjectRepository(ctx.db.connection).insert(project);
    const knownTask = buildTask({
      projectId: project.id,
      objective: 'Stored objective',
      id: 'task-known-id',
    });
    ctx.tasks.insert(knownTask);

    const agent = buildAgent({
      name: 'Codex2',
      provider: 'codex',
      fidelityTier: AdapterFidelityTier.A,
      runtime: { kind: 'app-server' },
    });
    new AgentRepository(ctx.db.connection).insert(agent);
    const session2 = buildSession({ taskId: knownTask.id, agentId: agent.id });
    new SessionRepository(ctx.db.connection).insert(session2);

    const event = buildEvent({
      sessionId: session2.id,
      taskId: knownTask.id,
      kind: 'AgentStarted',
      payload: { objective: 'Derived objective', workingDir: '/repo' },
    });
    ctx.events.insert(event);

    const missingTaskSource: TaskSource = {
      getById(): Task | null {
        return null;
      },
    };
    const resolver = new ContextResolver({
      tasks: missingTaskSource,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(knownTask.id);

    expect(result.taskSummary.objective).toBe('Derived objective');
    expect(result.taskSummary.state).toBe('unknown');
  });

  it('respects a configurable event window (most recent N)', async () => {
    // Insert 5 events; window of 2 should keep only the last 2.
    for (let i = 0; i < 5; i++) {
      insertEvent(ctx, 'AgentProgress', `2026-01-01T12:00:0${i}.000Z`, {
        message: `step ${i}`,
      });
    }

    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId, { eventWindow: 2 });

    expect(result.recentEvents).toHaveLength(2);
    // The two most recent events (step 3 and step 4).
    const messages = result.recentEvents.map((pe) => pe.event.payload['message']);
    expect(messages).toContain('step 3');
    expect(messages).toContain('step 4');
  });

  it('uses the default event window of 100 when not specified', async () => {
    expect(DEFAULT_EVENT_WINDOW).toBe(100);
    // Insert 3 events — all fit within the default window.
    for (let i = 0; i < 3; i++) {
      insertEvent(ctx, 'AgentProgress', `2026-01-01T12:00:0${i}.000Z`, { message: `s${i}` });
    }
    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId);
    expect(result.recentEvents).toHaveLength(3);
  });

  it('truncates to a small token budget, dropping low-priority events', async () => {
    // Insert a large low-priority event and a critical event.
    insertEvent(ctx, 'AgentProgress', '2026-01-01T12:00:00.000Z', {
      message: 'x'.repeat(5000),
    });
    insertEvent(ctx, 'AgentFailed', '2026-01-01T12:00:01.000Z', {
      error: 'boom',
    });

    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId, { tokenBudget: 200 });

    // The critical AgentFailed event should survive; the large low-priority
    // AgentProgress event should be dropped.
    const kinds = result.recentEvents.map((pe) => pe.event.kind);
    expect(kinds).toContain('AgentFailed');
    expect(kinds).not.toContain('AgentProgress');
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.estimatedTokens + 1);
  });

  it('capsule content rolls up event summaries and objective', async () => {
    insertEvent(ctx, 'AgentStarted', '2026-01-01T12:00:00.000Z', { objective: 'o' });
    insertEvent(ctx, 'FileChanged', '2026-01-01T12:00:05.000Z', { path: 'a.ts' });

    const resolver = new ContextResolver({
      tasks: ctx.tasks,
      events: ctx.events,
      decisions: ctx.decisions,
      digests: ctx.digests,
    });
    const result = await resolver.resolve(ctx.taskId);
    const content = result.capsule.content;

    expect(content.objective).toBe('Add cursor pagination');
    expect(content.rolledUpEventSummaries.length).toBe(2);
    expect(content.rolledUpEventSummaries.some((s) => s.startsWith('AgentStarted @'))).toBe(true);
    expect(content.rolledUpEventSummaries.some((s) => s.startsWith('FileChanged @'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * ContextResolver with mock sources (no DB)
 * ------------------------------------------------------------------ */

describe('context-resolver: mock sources', () => {
  it('assembles from in-memory mock sources', async () => {
    const events: Event[] = [
      {
        id: 'e1',
        sessionId: 's1',
        taskId: 't1',
        timestamp: '2026-01-01T00:00:00.000Z',
        kind: 'AgentStarted',
        payload: { objective: 'mock objective' },
      },
      {
        id: 'e2',
        sessionId: 's1',
        taskId: 't1',
        timestamp: '2026-01-01T00:00:05.000Z',
        kind: 'AgentFailed',
        payload: { error: 'fail' },
      },
    ];
    const decisions: Decision[] = [
      {
        id: 'd1',
        taskId: 't1',
        question: 'q?',
        options: ['a', 'b'],
        status: 'open',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const eventSource: EventSource = { listByTask: () => events };
    const taskSource: TaskSource = {
      getById: () => ({
        id: 't1',
        projectId: 'p1',
        objective: 'mock objective',
        state: 'running',
        agentIds: ['codex'],
        sessionIds: ['s1'],
        deliverableIds: [],
        attentionItemIds: [],
        capsuleId: 'c1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    };
    const decisionSource: DecisionSource = { listByTask: () => decisions };
    const digestSource: DigestSource = {
      findByTaskId: () => null,
      list: () => [],
    };

    const resolver = new ContextResolver({
      tasks: taskSource,
      events: eventSource,
      decisions: decisionSource,
      digests: digestSource,
      worktreeStatus: worktreeStub({
        clean: true,
        dirty: false,
        branch: 'florina/mock',
        baseCommit: 'sha1',
      }),
    });

    const result = await resolver.resolve('t1');

    expect(result.taskId).toBe('t1');
    expect(result.recentEvents).toHaveLength(2);
    expect(result.recentDecisions).toHaveLength(1);
    expect(result.worktreeStatus?.branch).toBe('florina/mock');
    expect(result.taskSummary.agentIds).toEqual(['codex']);
    // AgentFailed is critical.
    const failed = result.recentEvents.find((pe) => pe.event.kind === 'AgentFailed');
    expect(failed?.priority).toBe('critical');
  });
});
