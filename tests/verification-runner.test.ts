/**
 * Verification runner (issue #339): Florina-run checks produce journaled
 * `VerificationObserved` facts — worktree probe first, one fact per
 * declared check, and exactly one terminal aggregate the verification
 * gate reads as the honest verdict.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  AdapterFidelityTier,
  buildAgent,
  buildProject,
  buildSession,
  buildTask,
} from '../src/domain/index.js';
import { EventRepository, StorageDatabase, TaskRepository } from '../src/storage/index.js';
import {
  VerificationRunner,
  type VerificationRunnerDeps,
} from '../src/core/application/use-cases/verification/verification-runner.js';
import type { CommandResult } from '../src/core/application/ports/outbound/command-runner.js';
import type { WorktreeStatus } from '../src/core/application/ports/outbound/worktree.js';
import type { Event, Task } from '../src/domain/types.js';

/* ================================================================== *
 * Fakes + fixture
 * ================================================================== */

class FakeRunner {
  readonly results = new Map<string, CommandResult>();
  readonly ran: string[] = [];

  run(command: string, _cwd: string, _timeoutMs: number): Promise<CommandResult> {
    this.ran.push(command);
    const result = this.results.get(command);
    if (result === undefined) {
      throw new Error(`FakeRunner: no result for "${command}"`);
    }
    return Promise.resolve(result);
  }
}

class FakeWorktree {
  status: WorktreeStatus = { clean: true, dirty: false, branch: 'florina/t', baseCommit: 'abc' };
  throws = false;

  worktreeStatus(_path: string): WorktreeStatus {
    if (this.throws) {
      throw new Error('not a git repository');
    }
    return this.status;
  }
}

const ok = (exitCode = 0): CommandResult => ({
  exitCode,
  signal: null,
  stdout: 'all good\n',
  stderr: '',
  timedOut: false,
  spawnFailed: false,
});

/** Journal port wrapper that can be switched to failing inserts. */
class FlakyJournal {
  failInsert = false;
  constructor(private readonly inner: EventRepository) {}

  insert(event: Event): void {
    if (this.failInsert) {
      throw new Error('SQLITE_BUSY: database is locked');
    }
    this.inner.insert(event);
  }

  listByTask(taskId: string): Event[] {
    return this.inner.listByTask(taskId);
  }

  listBySession(sessionId: string): Event[] {
    return this.inner.listBySession(sessionId);
  }
}

interface Fixture {
  db: StorageDatabase;
  tasks: TaskRepository;
  events: EventRepository;
  journal: FlakyJournal;
  runner: FakeRunner;
  worktree: FakeWorktree;
  journalFailures: { err: unknown; row: Event }[];
  task: Task;
  sessionId: string;
  agentId: string;
  makeRunner: () => VerificationRunner;
}

function createFixture(input?: { worktreePath?: string }): Fixture {
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
    ...(input?.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
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

  const runner = new FakeRunner();
  const worktree = new FakeWorktree();
  const journal = new FlakyJournal(events);
  const journalFailures: { err: unknown; row: Event }[] = [];

  const deps: VerificationRunnerDeps = {
    journal: journal as unknown as VerificationRunnerDeps['journal'],
    tasks,
    worktree: worktree as unknown as VerificationRunnerDeps['worktree'],
    runner,
    now: () => new Date('2026-01-01T00:00:00Z'),
    onJournalFailure: (err, row) => {
      journalFailures.push({ err, row });
    },
  };

  return {
    db,
    tasks,
    events,
    journal,
    runner,
    worktree,
    journalFailures,
    task,
    sessionId: session.id,
    agentId: agent.id,
    makeRunner: () => new VerificationRunner(deps),
  };
}

/** Journal a dispatch event carrying the declared verification contract. */
let lastDispatchMs = 0;
function seedDispatch(f: Fixture, verifyCommands: readonly string[] | null): void {
  // Strictly increasing real-time stamps among seeds — the journal
  // orders by `timestamp` and the runner reads the latest dispatch's
  // contract; a seed pair must keep its order even within the same ms.
  const ms = Math.max(Date.now(), lastDispatchMs + 1);
  lastDispatchMs = ms;
  f.events.insert({
    id: `event_dispatch_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    sessionId: f.sessionId,
    taskId: f.task.id,
    timestamp: new Date(ms).toISOString(),
    kind: 'AgentStarted',
    payload: { fromState: 'created', toState: 'delegated', agentId: f.agentId, verifyCommands },
  });
}

/** Facts the runner journaled for the task, in insertion order. */
function verificationFacts(f: Fixture): readonly Event[] {
  return f.events.listByTask(f.task.id).filter((e) => e.kind === 'VerificationObserved');
}

/* ================================================================== *
 * Tests
 * ================================================================== */

describe('VerificationRunner', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture({ worktreePath: '/wt/task' });
  });

  afterEach(() => {
    f.db.close();
  });

  it('all declared checks pass + clean worktree → verified, aggregate journaled last', async () => {
    seedDispatch(f, ['npm test', 'npm run build']);
    f.runner.results.set('npm test', ok());
    f.runner.results.set('npm run build', ok());

    const outcome = await f.makeRunner().run(f.task.id, f.sessionId, f.agentId);
    expect(outcome.verified).toBe(true);
    expect(f.runner.ran).toEqual(['npm test', 'npm run build']);

    const facts = verificationFacts(f);
    // worktree probe + 2 checks + aggregate = 4 facts, aggregate last.
    expect(facts.length).toBe(4);
    const aggregate = facts[facts.length - 1];
    expect(aggregate.payload['command']).toBe('florina:task-verification');
    expect(aggregate.payload['success']).toBe(true);
    expect(aggregate.payload['summary']).toContain('verified');
  });

  it('a failing check produces an unverified aggregate with exit-code evidence', async () => {
    seedDispatch(f, ['npm test']);
    f.runner.results.set('npm test', {
      exitCode: 1,
      signal: null,
      stdout: '1 passed\n1 failed\n',
      stderr: 'FAIL suite',
      timedOut: false,
      spawnFailed: false,
    });

    const outcome = await f.makeRunner().run(f.task.id, f.sessionId, f.agentId);
    expect(outcome.verified).toBe(false);

    const facts = verificationFacts(f);
    const check = facts.find((e) => e.payload['command'] === 'npm test');
    expect(check?.payload['success']).toBe(false);
    const evidence = check?.payload['evidence'] as Record<string, unknown>;
    expect(evidence['exitCode']).toBe(1);
    expect(evidence['florinaRun']).toBe(true);
    expect(String(evidence['outputTail'])).toContain('FAIL suite');

    const aggregate = facts[facts.length - 1];
    expect(aggregate.payload['success']).toBe(false);
    expect(aggregate.payload['summary']).toContain('unverified');
  });

  it('a timed-out check is a failed check, journaled as timed out', async () => {
    seedDispatch(f, ['npm test']);
    f.runner.results.set('npm test', {
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: true,
      spawnFailed: false,
    });

    const outcome = await f.makeRunner().run(f.task.id, f.sessionId, f.agentId);
    expect(outcome.verified).toBe(false);
    const check = verificationFacts(f).find((e) => e.payload['command'] === 'npm test');
    expect(check?.payload['summary']).toContain('timed out');
    expect((check?.payload['evidence'] as Record<string, unknown>)['timedOut']).toBe(true);
  });

  it('no declared checks → unverified even when the worktree is clean', async () => {
    seedDispatch(f, null);
    const outcome = await f.makeRunner().run(f.task.id, f.sessionId, f.agentId);
    expect(outcome.verified).toBe(false);
    expect(f.runner.ran).toEqual([]);

    const aggregate = verificationFacts(f).at(-1);
    expect(aggregate?.payload['success']).toBe(false);
    expect(aggregate?.payload['summary']).toContain('no declared checks');
  });

  it('passing checks + dirty worktree → unverified (the worktree gate is independent)', async () => {
    seedDispatch(f, ['npm test']);
    f.runner.results.set('npm test', ok());
    f.worktree.status = { clean: false, dirty: true, branch: 'florina/t', baseCommit: 'abc' };

    const outcome = await f.makeRunner().run(f.task.id, f.sessionId, f.agentId);
    expect(outcome.verified).toBe(false);
    const probe = verificationFacts(f).find(
      (e) => e.payload['command'] === 'florina:worktree-status',
    );
    expect(probe?.payload['success']).toBe(false);
    expect(verificationFacts(f).at(-1)?.payload['summary']).toContain('worktree');
  });

  it('the latest dispatch wins — a re-declared contract replaces the old one', async () => {
    seedDispatch(f, ['npm test']);
    seedDispatch(f, ['npm run lint']);
    f.runner.results.set('npm run lint', ok());

    await f.makeRunner().run(f.task.id, f.sessionId, f.agentId);
    expect(f.runner.ran).toEqual(['npm run lint']);
  });

  it('a re-dispatch declaring nothing does NOT inherit the old contract', async () => {
    seedDispatch(f, ['npm test']);
    seedDispatch(f, null); // latest dispatch declared no checks

    const outcome = await f.makeRunner().run(f.task.id, f.sessionId, f.agentId);
    expect(f.runner.ran).toEqual([]);
    expect(outcome.verified).toBe(false);
    expect(verificationFacts(f).at(-1)?.payload['summary']).toContain('no declared checks');
  });

  it('a missing task row journals nothing and returns unverified', async () => {
    const outcome = await f.makeRunner().run('task_nonexistent', f.sessionId, f.agentId);
    expect(outcome.verified).toBe(false);
    expect(verificationFacts(f).length).toBe(0);
    expect(f.journalFailures.length).toBe(0);
  });

  it('a journal-insert failure routes to the provenance sink without throwing', async () => {
    seedDispatch(f, ['npm test']);
    f.runner.results.set('npm test', ok());
    f.journal.failInsert = true;

    const outcome = await f.makeRunner().run(f.task.id, f.sessionId, f.agentId);
    expect(outcome.verified).toBe(true); // the checks DID pass — the loss is provenance
    expect(f.journalFailures.length).toBeGreaterThan(0);
  });

  it('a spawn failure is a failed check, not a crash', async () => {
    seedDispatch(f, ['npm test']);
    f.runner.results.set('npm test', {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: 'ENOENT: bad cwd',
      timedOut: false,
      spawnFailed: true,
    });

    const outcome = await f.makeRunner().run(f.task.id, f.sessionId, f.agentId);
    expect(outcome.verified).toBe(false);
    const check = verificationFacts(f).find((e) => e.payload['command'] === 'npm test');
    expect(check?.payload['summary']).toContain('spawn failed');
  });
});
