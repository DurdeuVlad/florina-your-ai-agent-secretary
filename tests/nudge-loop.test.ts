/**
 * Nudge loop (issue #340): a verify failure journals `TaskVerifyFailed`,
 * queues a corrective re-dispatch carrying the failure evidence, and —
 * at the declared budget — parks the task + escalates with the full
 * attempt history. Attempt count lives in the journal, so the budget is
 * enforced deterministically across restarts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  AdapterFidelityTier,
  TaskState,
  buildAgent,
  buildProject,
  buildSession,
  buildTask,
} from '../src/domain/index.js';
import { EventRepository, StorageDatabase, TaskRepository } from '../src/storage/index.js';
import { TaskStateMachine } from '../src/daemon/task-lifecycle.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import {
  NudgeLoop,
  type NudgeLoopDeps,
} from '../src/core/application/use-cases/tasks/nudge-loop.js';
import { SessionManager } from '../src/core/application/use-cases/tasks/session-manager.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import type { Command, Response } from '../src/daemon/command-api.js';
import type { Event } from '../src/domain/types.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import type {
  AgentRuntimePort,
  SessionConfig,
  StartRunResult,
} from '../src/core/application/ports/outbound/agent-runtime.js';
import type { VerificationRunOutcome } from '../src/core/application/use-cases/verification/verification-runner.js';

/* ================================================================== *
 * Fakes + fixture
 * ================================================================== */

class FakeExecutor {
  readonly commands: Command[] = [];
  ok = true;
  error: string | undefined;
  /** Drives the blocked -> running transition a real start-task would. */
  resume: ((taskId: string) => void) | undefined;

  execute(command: Command): Promise<Response> {
    this.commands.push(command);
    if (this.ok) {
      if (command.kind === 'start-task') {
        this.resume?.(command.taskId);
      }
      return Promise.resolve({ ok: true, taskId: 't', sessionId: 's_next' });
    }
    return Promise.resolve({
      ok: false,
      taskId: 't',
      sessionId: '',
      error: this.error ?? 'dispatch failed',
    });
  }
}

interface Fixture {
  db: StorageDatabase;
  tasks: TaskRepository;
  events: EventRepository;
  sm: TaskStateMachine;
  inbox: AttentionInbox;
  executor: FakeExecutor;
  journalFailures: { err: unknown; row: Event }[];
  taskId: string;
  sessionId: string;
  agentId: string;
  makeLoop: (overrides?: Partial<NudgeLoopDeps>) => NudgeLoop;
}

function failedOutcome(input?: Partial<VerificationRunOutcome>): VerificationRunOutcome {
  return {
    verified: false,
    declaredChecks: ['npm test'],
    checks: [
      {
        command: 'npm test',
        kind: 'test',
        success: false,
        exitCode: 1,
        timedOut: false,
        spawnFailed: false,
        summary: 'exit 1',
        outputTail: 'FAIL suite: 1 failing',
      },
    ],
    worktree: { clean: true, dirty: false, branch: 'florina/t' },
    ...input,
  };
}

function createFixture(): Fixture {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const raw = db.connection;
  const tasks = new TaskRepository(raw);
  const events = new EventRepository(raw);

  const project = buildProject({ name: 'p', repo: { path: '/r' } });
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

  const task = buildTask({
    projectId: project.id,
    objective: 'Implement feature X',
    worktreePath: '/wt/task',
  });
  tasks.insert(task);

  const agent = buildAgent({
    name: 'Codex',
    provider: 'codex',
    fidelityTier: AdapterFidelityTier.A,
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

  const session = buildSession({ taskId: task.id, agentId: agent.id });
  raw
    .prepare(
      'INSERT INTO sessions (id, task_id, agent_id, status, started_at, event_ids, deliverable_ids, capsule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      session.id,
      session.taskId,
      session.agentId,
      session.status,
      session.startedAt,
      JSON.stringify(session.eventIds),
      JSON.stringify(session.deliverableIds),
      session.capsuleId,
    );

  // Task is mid-run — the state a completion claim leaves it in.
  tasks.update({ ...task, state: TaskState.Running });

  const sm = new TaskStateMachine(tasks, events);
  const inbox = new AttentionInbox();
  const executor = new FakeExecutor();
  executor.resume = (taskId) => {
    const current = tasks.getById(taskId);
    if (current !== null && current.state === TaskState.Blocked) {
      sm.transition(taskId, TaskState.Blocked, TaskState.Running, { sessionId: session.id });
    }
  };
  const journalFailures: { err: unknown; row: Event }[] = [];

  const makeLoop = (overrides?: Partial<NudgeLoopDeps>): NudgeLoop =>
    new NudgeLoop({
      journal: events,
      tasks,
      stateMachine: sm,
      commandApi: executor,
      inbox,
      now: () => new Date('2026-01-01T00:00:00Z'),
      onJournalFailure: (err, row) => {
        journalFailures.push({ err, row });
      },
      ...overrides,
    });

  return {
    db,
    tasks,
    events,
    sm,
    inbox,
    executor,
    journalFailures,
    taskId: task.id,
    sessionId: session.id,
    agentId: agent.id,
    makeLoop,
  };
}

let dispatchSeq = 0;
/** Journal a dispatch event carrying verifyBudget (latest wins). */
function seedDispatch(f: Fixture, verifyBudget: number | null): void {
  const ms = Math.max(Date.now(), dispatchSeq + 1);
  dispatchSeq = ms;
  f.events.insert({
    id: `event_dispatch_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    sessionId: f.sessionId,
    taskId: f.taskId,
    timestamp: new Date(ms).toISOString(),
    kind: 'AgentStarted',
    payload: { verifyCommands: ['npm test'], verifyBudget },
  });
}

function eventsOf(f: Fixture, kind: string): readonly Event[] {
  return f.events.listByTask(f.taskId).filter((e) => e.kind === kind);
}

/* ================================================================== *
 * Tests
 * ================================================================== */

describe('NudgeLoop', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it('verify failure journals TaskVerifyFailed then re-dispatches with evidence', async () => {
    const loop = f.makeLoop();
    const decision = loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome());
    expect(decision).toBe('nudge-pending');

    const failEvents = eventsOf(f, 'TaskVerifyFailed');
    expect(failEvents.length).toBe(1);
    expect(failEvents[0].payload['attempt']).toBe(1);
    expect(failEvents[0].payload['failedChecks']).toEqual(['npm test']);

    await loop.dispatchPending(f.taskId);

    // running -> blocked (dispatch slot) then start-task resumes it.
    const nudges = eventsOf(f, 'TaskNudged');
    expect(nudges.length).toBe(1);
    expect(nudges[0].payload['attempt']).toBe(2);
    expect(nudges[0].payload['budget']).toBe(2);

    const cmd = f.executor.commands.at(-1);
    expect(cmd?.kind).toBe('start-task');
    if (cmd?.kind === 'start-task') {
      expect(cmd.sessionConfig.prompt).toContain('CORRECTIVE DISPATCH');
      expect(cmd.sessionConfig.prompt).toContain('npm test');
      expect(cmd.sessionConfig.prompt).toContain('FAIL suite');
      expect(cmd.sessionConfig.prompt).toContain('Implement feature X');
      expect(cmd.sessionConfig.verifyCommands).toEqual(['npm test']);
    }
    expect(f.sm.getCurrentState(f.taskId)).toBe(TaskState.Running);
  });

  it('retry budget is enforced — exhaustion parks the task and escalates', async () => {
    const loop = f.makeLoop();

    // Attempt 1 fails → nudge 1 dispatches (attempt 2).
    loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome());
    await loop.dispatchPending(f.taskId);
    // Attempt 2 fails → nudge 2 dispatches (attempt 3) — budget spent.
    loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome());
    await loop.dispatchPending(f.taskId);
    // Attempt 3 fails → parked, no further dispatch.
    const decision = loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome());
    expect(decision).toBe('parked');

    expect(eventsOf(f, 'TaskNudged').length).toBe(2);
    expect(eventsOf(f, 'TaskVerifyFailed').length).toBe(3);
    expect(eventsOf(f, 'TaskParked').length).toBe(1);
    expect(f.executor.commands.length).toBe(2); // no third dispatch
    expect(f.sm.getCurrentState(f.taskId)).toBe(TaskState.Blocked);

    const item = f.inbox.peek();
    expect(item?.priority).toBe('Critical');
    expect(item?.kind).toBe('Custom');
    expect(String(item?.payload['reason'])).toContain('budget exhausted');
    expect(Array.isArray(item?.payload['attempts'])).toBe(true);
    // Full attempt history: 3 verify failures + 2 nudge dispatches.
    expect((item?.payload['attempts'] as unknown[]).length).toBe(5);
  });

  it('a declared verifyBudget overrides the default', async () => {
    seedDispatch(f, 0); // task-configurable: zero nudges
    const loop = f.makeLoop();
    const decision = loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome());
    expect(decision).toBe('parked');
    expect(eventsOf(f, 'TaskNudged').length).toBe(0);
  });

  it('a larger declared budget extends the loop', async () => {
    seedDispatch(f, 4);
    const loop = f.makeLoop();
    expect(loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome())).toBe(
      'nudge-pending',
    );
    await loop.dispatchPending(f.taskId);
    expect(loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome())).toBe(
      'nudge-pending',
    );
    await loop.dispatchPending(f.taskId);
    expect(loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome())).toBe(
      'nudge-pending',
    );
    await loop.dispatchPending(f.taskId);
    expect(eventsOf(f, 'TaskNudged').length).toBe(3);
  });

  it('a failed nudge dispatch escalates instead of silently dropping', async () => {
    f.executor.ok = false;
    f.executor.error = 'provider unavailable';
    const loop = f.makeLoop();
    loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome());
    await loop.dispatchPending(f.taskId);

    expect(eventsOf(f, 'TaskNudged').length).toBe(1); // attempt journaled before dispatch
    const item = f.inbox.peek();
    expect(item?.priority).toBe('Critical');
    expect(String(item?.payload['reason'])).toContain('nudge dispatch failed');
    expect(f.sm.getCurrentState(f.taskId)).toBe(TaskState.Blocked);
  });

  it('a task cancelled before dispatch is skipped honestly', async () => {
    const loop = f.makeLoop();
    loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, failedOutcome());
    f.sm.transition(f.taskId, TaskState.Running, TaskState.Cancelled, {
      sessionId: f.sessionId,
      agentId: f.agentId,
    });
    await loop.dispatchPending(f.taskId);
    expect(eventsOf(f, 'TaskNudged').length).toBe(0);
    expect(f.executor.commands.length).toBe(0);
  });

  it('onVerifyFailed ignores unknown tasks and never throws', () => {
    const loop = f.makeLoop();
    expect(loop.onVerifyFailed('task_missing', 's', 'a', failedOutcome())).toBe('ignored');
  });

  it('a task with no declared contract is ignored — no pointless re-runs', async () => {
    const loop = f.makeLoop();
    const decision = loop.onVerifyFailed(
      f.taskId,
      f.sessionId,
      f.agentId,
      failedOutcome({ declaredChecks: [], checks: [] }),
    );
    expect(decision).toBe('ignored');
    await loop.dispatchPending(f.taskId);
    expect(eventsOf(f, 'TaskVerifyFailed').length).toBe(0);
    expect(eventsOf(f, 'TaskNudged').length).toBe(0);
    expect(f.executor.commands.length).toBe(0);
    expect(f.sm.getCurrentState(f.taskId)).toBe(TaskState.Running);
  });

  it('a dirty-worktree failure under a declared contract nudges honestly', async () => {
    const loop = f.makeLoop();
    const dirty = failedOutcome({
      checks: [
        {
          command: 'npm test',
          kind: 'test',
          success: true,
          exitCode: 0,
          timedOut: false,
          spawnFailed: false,
          summary: 'ok',
          outputTail: '',
        },
      ],
      worktree: { clean: false, dirty: true, branch: 'florina/t' },
    });
    expect(loop.onVerifyFailed(f.taskId, f.sessionId, f.agentId, dirty)).toBe('nudge-pending');
    await loop.dispatchPending(f.taskId);
    const cmd = f.executor.commands.at(-1);
    if (cmd?.kind === 'start-task') {
      expect(cmd.sessionConfig.prompt).toContain('worktree gate failed');
      expect(cmd.sessionConfig.prompt).toContain('Worktree is dirty');
    }
  });
});

/* ================================================================== *
 * Integration: SessionManager hooks driving the loop end to end
 * (same wiring as daemon.ts — verify on beforePublish, dispatch on
 * onSessionEnd after the session slot frees).
 * ================================================================== */

class ScriptedAdapter implements AgentRuntimePort {
  readonly id = 'codex';
  readonly fidelityTier = 'B' as const;
  readonly capabilities = { sendMessage: false, resume: false, compact: false } as const;
  connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  constructor(private readonly events: readonly SupervisorEvent[]) {}
  async connect(): Promise<void> {
    this.connectionState = 'connected';
  }
  async startRun(_taskId: string, cfg: SessionConfig): Promise<StartRunResult> {
    return { sessionId: cfg.sessionId, started: true };
  }
  async *streamEvents(): AsyncIterable<SupervisorEvent> {
    for (const e of this.events) {
      yield e;
    }
  }
  async cancel(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.connectionState = 'disconnected';
  }
}

function completedEvent(taskId: string, sessionId: string, agentId: string): SupervisorEvent {
  return {
    type: 'AgentCompleted',
    taskId,
    sessionId,
    agentId,
    timestamp: new Date().toISOString(),
    adapterFidelityTier: AdapterFidelityTier.B,
    summary: 'claimed done',
    deliverables: [],
  };
}

async function settle(cond: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries && !cond(); i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

function passedOutcome(): VerificationRunOutcome {
  return {
    verified: true,
    declaredChecks: ['npm test'],
    checks: [
      {
        command: 'npm test',
        kind: 'test',
        success: true,
        exitCode: 0,
        timedOut: false,
        spawnFailed: false,
        summary: 'ok',
        outputTail: '',
      },
    ],
    worktree: { clean: true, dirty: false, branch: 'florina/t' },
  };
}

describe('NudgeLoop — SessionManager integration', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  interface Wired {
    sm: SessionManager;
    outcomes: VerificationRunOutcome[];
    runCount: () => number;
    commands: Command[];
    sessionSeq: { n: number };
  }

  function insertSessionRow(id: string): void {
    const raw = f.db.connection;
    raw
      .prepare(
        'INSERT INTO sessions (id, task_id, agent_id, status, started_at, event_ids, deliverable_ids, capsule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, f.taskId, f.agentId, 'running', new Date().toISOString(), '[]', '[]', 'cap_x');
  }

  /** Wire the loop the way daemon.ts does; outcomes are consumed per run. */
  function wire(outcomes: VerificationRunOutcome[]): Wired {
    const bus = new EventBus();
    const commands: Command[] = [];
    const sessionSeq = { n: 1 };
    const wired: Wired = {
      sm: undefined as unknown as SessionManager,
      outcomes,
      runCount: () => outcomes.length,
      commands,
      sessionSeq,
    };

    const loop = f.makeLoop({
      commandApi: {
        execute: (command: Command): Promise<Response> => {
          commands.push(command);
          // Reproduce what start-task does for a blocked task: resume
          // lifecycle then start a real session that claims completion.
          return (async () => {
            const task = f.tasks.getById(f.taskId);
            if (
              task === null ||
              task.state !== TaskState.Blocked ||
              command.kind !== 'start-task'
            ) {
              return { ok: false, taskId: f.taskId, sessionId: '', error: 'not startable' };
            }
            const sid = `sess_n${sessionSeq.n}`;
            sessionSeq.n += 1;
            insertSessionRow(sid);
            f.sm.transition(f.taskId, TaskState.Blocked, TaskState.Running, { sessionId: sid });
            const res = await wired.sm.startSession(
              f.taskId,
              'codex',
              new ScriptedAdapter([completedEvent(f.taskId, sid, f.agentId)]),
              {
                taskId: f.taskId,
                sessionId: sid,
                agentId: f.agentId,
                workingDir: '/wt',
                objective: 'x',
              },
            );
            return res.ok
              ? { ok: true, taskId: f.taskId, sessionId: sid }
              : { ok: false, taskId: f.taskId, sessionId: '', error: res.error };
          })();
        },
      },
    });

    wired.sm = new SessionManager(bus, {
      beforePublish: (event) => {
        if (event.type === 'AgentCompleted') {
          const outcome = outcomes.shift() ?? passedOutcome();
          if (!outcome.verified) {
            loop.onVerifyFailed(event.taskId, event.sessionId, event.agentId, outcome);
          }
        }
        return Promise.resolve();
      },
      onSessionEnd: async (taskId) => {
        await loop.dispatchPending(taskId);
      },
    });
    return wired;
  }

  it('failing-then-passing: a nudge re-dispatches and the retry verifies', async () => {
    const w = wire([failedOutcome(), passedOutcome()]);
    const res = await w.sm.startSession(
      f.taskId,
      'codex',
      new ScriptedAdapter([completedEvent(f.taskId, f.sessionId, f.agentId)]),
      {
        taskId: f.taskId,
        sessionId: f.sessionId,
        agentId: f.agentId,
        workingDir: '/wt',
        objective: 'x',
      },
    );
    expect(res.ok).toBe(true);

    await settle(() => w.sessionSeq.n === 2 && w.sm.activeCount === 0);

    // One corrective dispatch, carrying evidence; second run claimed and
    // passed verification — the loop stands down with no escalation.
    expect(w.commands.length).toBe(1);
    const cmd = w.commands[0];
    if (cmd.kind === 'start-task') {
      expect(cmd.sessionConfig.prompt).toContain('CORRECTIVE DISPATCH');
      expect(cmd.sessionConfig.prompt).toContain('npm test');
    }
    expect(eventsOf(f, 'TaskVerifyFailed').length).toBe(1);
    expect(eventsOf(f, 'TaskNudged').length).toBe(1);
    expect(eventsOf(f, 'TaskParked').length).toBe(0);
    expect(f.inbox.peek()).toBeUndefined();
  });

  it('always-failing: budget exhaustion parks the task and escalates', async () => {
    const w = wire([failedOutcome(), failedOutcome(), failedOutcome()]);
    const res = await w.sm.startSession(
      f.taskId,
      'codex',
      new ScriptedAdapter([completedEvent(f.taskId, f.sessionId, f.agentId)]),
      {
        taskId: f.taskId,
        sessionId: f.sessionId,
        agentId: f.agentId,
        workingDir: '/wt',
        objective: 'x',
      },
    );
    expect(res.ok).toBe(true);

    await settle(() => eventsOf(f, 'TaskParked').length === 1 && w.sm.activeCount === 0);

    // Exactly the default budget of corrective dispatches — no silent burn.
    expect(w.commands.length).toBe(2);
    expect(eventsOf(f, 'TaskVerifyFailed').length).toBe(3);
    expect(eventsOf(f, 'TaskNudged').length).toBe(2);
    expect(f.sm.getCurrentState(f.taskId)).toBe(TaskState.Blocked);
    const item = f.inbox.peek();
    expect(item?.priority).toBe('Critical');
    expect((item?.payload['attempts'] as unknown[]).length).toBe(5);
  });
});
