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
import { IllegalTransitionError, TaskStateMachine } from '../src/daemon/task-lifecycle.js';
import type { TaskState as TaskStateType } from '../src/domain/index.js';
import type { TransitionContext } from '../src/daemon/task-lifecycle.js';

/**
 * Test fixture: an in-memory database with a project, task, agent, and
 * session wired up so the state machine can emit journal events (the events
 * table has a FK on session_id).
 */
interface Fixture {
  db: StorageDatabase;
  tasks: TaskRepository;
  events: EventRepository;
  sm: TaskStateMachine;
  taskId: string;
  sessionId: string;
  agentId: string;
  ctx: TransitionContext;
}

function createFixture(): Fixture {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const raw = db.connection;
  const tasks = new TaskRepository(raw);
  const events = new EventRepository(raw);

  const project = buildProject({ name: 'p', repo: { path: '/r' } });
  // No project repository import needed; insert directly via raw SQL to
  // satisfy the tasks FK.
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

  const task = buildTask({ projectId: project.id, objective: 'Implement feature X' });
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

  const sm = new TaskStateMachine(tasks, events);

  return {
    db,
    tasks,
    events,
    sm,
    taskId: task.id,
    sessionId: session.id,
    agentId: agent.id,
    ctx: { sessionId: session.id, agentId: agent.id },
  };
}

/** All valid (from, to) transitions per the transition table. */
const VALID_TRANSITIONS: ReadonlyArray<[TaskStateType, TaskStateType]> = [
  // created
  [TaskState.Created, TaskState.Delegated],
  [TaskState.Created, TaskState.Cancelled],
  [TaskState.Created, TaskState.Failed],
  // delegated
  [TaskState.Delegated, TaskState.Running],
  // A delegated task may block before first progress (failover freeze, #64).
  [TaskState.Delegated, TaskState.Blocked],
  [TaskState.Delegated, TaskState.Cancelled],
  [TaskState.Delegated, TaskState.Failed],
  // running
  [TaskState.Running, TaskState.AttentionNeeded],
  [TaskState.Running, TaskState.Blocked],
  [TaskState.Running, TaskState.Completed],
  [TaskState.Running, TaskState.Failed],
  [TaskState.Running, TaskState.Cancelled],
  // attention-needed
  [TaskState.AttentionNeeded, TaskState.Running],
  [TaskState.AttentionNeeded, TaskState.Blocked],
  [TaskState.AttentionNeeded, TaskState.Failed],
  [TaskState.AttentionNeeded, TaskState.Cancelled],
  // blocked
  [TaskState.Blocked, TaskState.Running],
  [TaskState.Blocked, TaskState.Failed],
  [TaskState.Blocked, TaskState.Cancelled],
  // completed
  [TaskState.Completed, TaskState.Reviewed],
  [TaskState.Completed, TaskState.Accepted],
  [TaskState.Completed, TaskState.Failed],
  [TaskState.Completed, TaskState.Cancelled],
  // reviewed
  [TaskState.Reviewed, TaskState.Accepted],
  [TaskState.Reviewed, TaskState.Failed],
  [TaskState.Reviewed, TaskState.Cancelled],
];

/**
 * Every (from, to) pair that is NOT in the valid table — used to assert
 * illegal transitions are rejected. Terminal states have no outgoing
 * transitions at all.
 */
const ALL_STATES: readonly TaskStateType[] = [
  TaskState.Created,
  TaskState.Delegated,
  TaskState.Running,
  TaskState.AttentionNeeded,
  TaskState.Blocked,
  TaskState.Completed,
  TaskState.Reviewed,
  TaskState.Accepted,
  TaskState.Failed,
  TaskState.Cancelled,
];

const TERMINAL_STATES: readonly TaskStateType[] = [
  TaskState.Accepted,
  TaskState.Failed,
  TaskState.Cancelled,
];

/**
 * Expected event kind for each valid transition. Cancellation -> AgentStopped,
 * failure -> AgentFailed, plus the specific mappings for the lifecycle path.
 */
const EXPECTED_EVENT_KIND: Readonly<Record<string, string>> = {
  'created->delegated': 'AgentStarted',
  'created->cancelled': 'AgentStopped',
  'created->failed': 'AgentFailed',
  'delegated->running': 'AgentProgress',
  'delegated->blocked': 'AgentBlocked',
  'delegated->cancelled': 'AgentStopped',
  'delegated->failed': 'AgentFailed',
  'running->attention-needed': 'ApprovalRequested',
  'running->blocked': 'AgentBlocked',
  'running->completed': 'AgentCompleted',
  'running->failed': 'AgentFailed',
  'running->cancelled': 'AgentStopped',
  'attention-needed->running': 'AgentProgress',
  'attention-needed->blocked': 'AgentBlocked',
  'attention-needed->failed': 'AgentFailed',
  'attention-needed->cancelled': 'AgentStopped',
  'blocked->running': 'AgentProgress',
  'blocked->failed': 'AgentFailed',
  'blocked->cancelled': 'AgentStopped',
  'completed->reviewed': 'AgentProgress',
  'completed->accepted': 'AgentCompleted',
  'completed->failed': 'AgentFailed',
  'completed->cancelled': 'AgentStopped',
  'reviewed->accepted': 'AgentCompleted',
  'reviewed->failed': 'AgentFailed',
  'reviewed->cancelled': 'AgentStopped',
};

describe('TaskStateMachine: transition table', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it('allowedTransitions returns the configured set for each state', () => {
    expect(f.sm.allowedTransitions(TaskState.Created)).toContain(TaskState.Delegated);
    expect(f.sm.allowedTransitions(TaskState.Running)).toContain(TaskState.Completed);
    expect(f.sm.allowedTransitions(TaskState.Completed)).toContain(TaskState.Reviewed);
    expect(f.sm.allowedTransitions(TaskState.Completed)).toContain(TaskState.Accepted);
  });

  it('allowedTransitions is empty for terminal states', () => {
    for (const s of TERMINAL_STATES) {
      expect(f.sm.allowedTransitions(s)).toEqual([]);
    }
  });

  it('isAllowed returns true for valid and false for invalid transitions', () => {
    expect(f.sm.isAllowed(TaskState.Created, TaskState.Delegated)).toBe(true);
    expect(f.sm.isAllowed(TaskState.Created, TaskState.Completed)).toBe(false);
    expect(f.sm.isAllowed(TaskState.Accepted, TaskState.Cancelled)).toBe(false);
  });
});

describe('TaskStateMachine: every valid transition succeeds and emits the correct event', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  // Drive the task into the `from` state via the canonical happy path, then
  // assert the target transition works and emits the expected event.
  for (const [from, to] of VALID_TRANSITIONS) {
    it(`${from} -> ${to} is allowed and emits ${EXPECTED_EVENT_KIND[`${from}->${to}`]}`, () => {
      // Seed the task into the `from` state.
      seedState(f, from);

      const beforeCount = f.events.listByTask(f.taskId).length;
      const result = f.sm.transition(f.taskId, from, to, f.ctx);

      // State was persisted.
      expect(f.sm.getCurrentState(f.taskId)).toBe(to);
      expect(result.task.state).toBe(to);

      // An event was appended.
      const afterEvents = f.events.listByTask(f.taskId);
      expect(afterEvents.length).toBe(beforeCount + 1);
      const appended = afterEvents[afterEvents.length - 1];
      expect(appended.kind).toBe(EXPECTED_EVENT_KIND[`${from}->${to}`]);
      expect(appended.taskId).toBe(f.taskId);
      expect(appended.sessionId).toBe(f.sessionId);
      expect(appended.payload['fromState']).toBe(from);
      expect(appended.payload['toState']).toBe(to);
    });
  }
});

describe('TaskStateMachine: every illegal transition is rejected', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  // For every (from, to) pair not in the valid table, assert rejection.
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const key = `${from}->${to}`;
      const isValid = VALID_TRANSITIONS.some(([vFrom, vTo]) => vFrom === from && vTo === to);
      if (isValid) {
        continue;
      }
      it(`${key} is rejected with IllegalTransitionError`, () => {
        seedState(f, from);
        expect(() => f.sm.transition(f.taskId, from, to, f.ctx)).toThrow(IllegalTransitionError);
        // State must remain unchanged.
        if (!TERMINAL_STATES.includes(from)) {
          expect(f.sm.getCurrentState(f.taskId)).toBe(from);
        }
      });
    }
  }

  it('created -> completed is explicitly illegal (completion requires review)', () => {
    seedState(f, TaskState.Created);
    expect(() => f.sm.transition(f.taskId, TaskState.Created, TaskState.Completed, f.ctx)).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('TaskStateMachine: completion requires explicit review/acceptance', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it('completed is not the same as accepted — cannot jump completed -> cancelled-only path closes it', () => {
    seedState(f, TaskState.Completed);
    // completed cannot go back to running or be re-delegated.
    expect(() => f.sm.transition(f.taskId, TaskState.Completed, TaskState.Running, f.ctx)).toThrow(
      IllegalTransitionError,
    );
    expect(() =>
      f.sm.transition(f.taskId, TaskState.Completed, TaskState.Delegated, f.ctx),
    ).toThrow(IllegalTransitionError);
  });

  it('completed -> reviewed -> accepted closes the task', () => {
    seedState(f, TaskState.Completed);
    f.sm.transition(f.taskId, TaskState.Completed, TaskState.Reviewed, f.ctx);
    expect(f.sm.getCurrentState(f.taskId)).toBe(TaskState.Reviewed);
    f.sm.transition(f.taskId, TaskState.Reviewed, TaskState.Accepted, f.ctx);
    expect(f.sm.getCurrentState(f.taskId)).toBe(TaskState.Accepted);
  });

  it('completed -> accepted skips review and closes the task', () => {
    seedState(f, TaskState.Completed);
    f.sm.transition(f.taskId, TaskState.Completed, TaskState.Accepted, f.ctx);
    expect(f.sm.getCurrentState(f.taskId)).toBe(TaskState.Accepted);
  });

  it('accepted is terminal — no further transitions', () => {
    seedState(f, TaskState.Accepted);
    for (const to of ALL_STATES) {
      expect(() => f.sm.transition(f.taskId, TaskState.Accepted, to, f.ctx)).toThrow(
        IllegalTransitionError,
      );
    }
  });
});

describe('TaskStateMachine: cancellation from any non-terminal state', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  const NON_TERMINAL: readonly TaskStateType[] = ALL_STATES.filter(
    (s) => !TERMINAL_STATES.includes(s),
  );

  for (const from of NON_TERMINAL) {
    it(`${from} -> cancelled emits AgentStopped`, () => {
      seedState(f, from);
      const result = f.sm.transition(f.taskId, from, TaskState.Cancelled, f.ctx);
      expect(result.task.state).toBe(TaskState.Cancelled);
      expect(result.event.kind).toBe('AgentStopped');
      expect(f.sm.getCurrentState(f.taskId)).toBe(TaskState.Cancelled);
    });
  }

  it('cancelled is terminal — no further transitions', () => {
    seedState(f, TaskState.Cancelled);
    for (const to of ALL_STATES) {
      expect(() => f.sm.transition(f.taskId, TaskState.Cancelled, to, f.ctx)).toThrow(
        IllegalTransitionError,
      );
    }
  });
});

describe('TaskStateMachine: failure from running and any non-terminal state', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it('running -> failed emits AgentFailed', () => {
    seedState(f, TaskState.Running);
    const result = f.sm.transition(f.taskId, TaskState.Running, TaskState.Failed, f.ctx);
    expect(result.task.state).toBe(TaskState.Failed);
    expect(result.event.kind).toBe('AgentFailed');
  });

  const NON_TERMINAL: readonly TaskStateType[] = ALL_STATES.filter(
    (s) => !TERMINAL_STATES.includes(s),
  );
  for (const from of NON_TERMINAL) {
    it(`${from} -> failed emits AgentFailed`, () => {
      seedState(f, from);
      const result = f.sm.transition(f.taskId, from, TaskState.Failed, f.ctx);
      expect(result.task.state).toBe(TaskState.Failed);
      expect(result.event.kind).toBe('AgentFailed');
    });
  }

  it('failed is terminal — no further transitions', () => {
    seedState(f, TaskState.Failed);
    for (const to of ALL_STATES) {
      expect(() => f.sm.transition(f.taskId, TaskState.Failed, to, f.ctx)).toThrow(
        IllegalTransitionError,
      );
    }
  });
});

describe('TaskStateMachine: every transition appends an event to the journal', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it('a full happy path appends one event per transition', () => {
    // created -> delegated -> running -> completed -> reviewed -> accepted
    const path: ReadonlyArray<[TaskStateType, TaskStateType]> = [
      [TaskState.Created, TaskState.Delegated],
      [TaskState.Delegated, TaskState.Running],
      [TaskState.Running, TaskState.Completed],
      [TaskState.Completed, TaskState.Reviewed],
      [TaskState.Reviewed, TaskState.Accepted],
    ];

    expect(f.events.listByTask(f.taskId).length).toBe(0);

    for (const [from, to] of path) {
      const before = f.events.listByTask(f.taskId).length;
      f.sm.transition(f.taskId, from, to, f.ctx);
      const after = f.events.listByTask(f.taskId).length;
      expect(after).toBe(before + 1);
    }

    expect(f.events.listByTask(f.taskId).length).toBe(path.length);
  });

  it('getTransitionHistory returns the chronological event stream for the task', () => {
    f.sm.transition(f.taskId, TaskState.Created, TaskState.Delegated, f.ctx);
    f.sm.transition(f.taskId, TaskState.Delegated, TaskState.Running, f.ctx);
    f.sm.transition(f.taskId, TaskState.Running, TaskState.Completed, f.ctx);

    const history = f.sm.getTransitionHistory(f.taskId);
    expect(history.length).toBe(3);
    expect(history[0].kind).toBe('AgentStarted');
    expect(history[1].kind).toBe('AgentProgress');
    expect(history[2].kind).toBe('AgentCompleted');
    // Chronological: timestamps non-decreasing.
    expect(history[2].timestamp >= history[0].timestamp).toBe(true);
  });

  it('illegal transitions do NOT append an event', () => {
    const before = f.events.listByTask(f.taskId).length;
    expect(() => f.sm.transition(f.taskId, TaskState.Created, TaskState.Completed, f.ctx)).toThrow(
      IllegalTransitionError,
    );
    expect(f.events.listByTask(f.taskId).length).toBe(before);
  });
});

describe('TaskStateMachine: fromState mismatch and missing task', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.db.close();
  });

  it('throws IllegalTransitionError when fromState does not match current state', () => {
    // Task is in 'created' but caller claims 'running'.
    expect(() => f.sm.transition(f.taskId, TaskState.Running, TaskState.Completed, f.ctx)).toThrow(
      IllegalTransitionError,
    );
  });

  it('throws when the task does not exist', () => {
    expect(() =>
      f.sm.transition('no-such-task', TaskState.Created, TaskState.Delegated, f.ctx),
    ).toThrow(/not found/);
  });

  it('getCurrentState throws for a missing task', () => {
    expect(() => f.sm.getCurrentState('no-such-task')).toThrow(/not found/);
  });

  it('getTransitionHistory returns empty for a task with no events', () => {
    expect(f.sm.getTransitionHistory(f.taskId)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Drive the fixture's task into `target` by overwriting its persisted state
 * directly. This isolates each transition test so it does not depend on the
 * correctness of the path that reaches `target`.
 */
function seedState(f: Fixture, target: TaskStateType): void {
  const task = f.tasks.getById(f.taskId);
  if (task === null) {
    throw new Error('seedState: task missing');
  }
  f.tasks.update({ ...task, state: target, updatedAt: new Date().toISOString() });
}
