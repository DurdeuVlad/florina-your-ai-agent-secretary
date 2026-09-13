/**
 * Verification-gated completion (DEC-032, issue #68) — a task may not
 * surface as done without journaled proof. Covers the event journal
 * writer (bus → durable evidence), the VerificationGate assessment, the
 * manager-accountability claim record, and the inbox distinction between
 * verified digests and unverified completions.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  EventJournalWriter,
  supervisorEventToJournalRow,
} from '../src/core/application/use-cases/journal/event-journal-writer.js';
import { VerificationGate } from '../src/core/application/use-cases/verification/verification-gate.js';
import { AttentionAggregator } from '../src/core/application/use-cases/attention/attention-aggregator.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import { buildProject, buildTask } from '../src/core/domain/index.js';
import type {
  AgentCompletedEvent,
  SupervisorEvent,
  TestFinishedEvent,
  VerificationObservedEvent,
} from '../src/core/domain/events.js';

/* ------------------------------------------------------------------ *
 * Fixture — real SQLite journal + real bus→writer pipeline
 * ------------------------------------------------------------------ */

interface Fixture {
  db: StorageDatabase;
  eventRepo: EventRepository;
  bus: EventBus;
  writer: EventJournalWriter;
  gate: VerificationGate;
  inbox: AttentionInbox;
  aggregator: AttentionAggregator;
  projectId: string;
  taskId: string;
  sessionId: string;
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
  raw
    .prepare(
      'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('codex', 'codex', 'codex', 'B', '{}', new Date().toISOString());

  const taskRepo = new TaskRepository(raw);
  const task = buildTask({ projectId: project.id, objective: 'build the thing' });
  taskRepo.insert(task);
  raw
    .prepare(
      'INSERT INTO sessions (id, task_id, agent_id, status, started_at, capsule_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('sess-1', task.id, 'codex', 'running', new Date().toISOString(), 'capsule-1');

  const eventRepo = new EventRepository(raw);
  const bus = new EventBus();
  const writer = new EventJournalWriter({ journal: eventRepo, bus });
  writer.start();
  const gate = new VerificationGate({ journal: eventRepo });
  const inbox = new AttentionInbox();
  const aggregator = new AttentionAggregator(inbox, bus, { verificationGate: gate });

  return {
    db,
    eventRepo,
    bus,
    writer,
    gate,
    inbox,
    aggregator,
    projectId: project.id,
    taskId: task.id,
    sessionId: 'sess-1',
  };
}

let seq = 0;
function ts(): string {
  seq += 1;
  return `2026-09-20T00:00:${String(seq).padStart(2, '0')}.000Z`;
}

function verifyEvent(
  fx: Fixture,
  over: Partial<VerificationObservedEvent> = {},
): VerificationObservedEvent {
  return {
    type: 'VerificationObserved',
    timestamp: ts(),
    taskId: fx.taskId,
    sessionId: fx.sessionId,
    agentId: 'codex',
    adapterFidelityTier: 'B',
    kind: 'test',
    success: true,
    command: 'npm test',
    summary: 'all green',
    ...over,
  };
}

function testFinished(fx: Fixture, passed: number, failed: number): TestFinishedEvent {
  return {
    type: 'TestFinished',
    timestamp: ts(),
    taskId: fx.taskId,
    sessionId: fx.sessionId,
    agentId: 'codex',
    adapterFidelityTier: 'B',
    framework: 'vitest',
    target: 'tests',
    command: 'npm test',
    passed,
    failed,
    skipped: 0,
    durationMs: 1000,
  };
}

function completed(fx: Fixture): AgentCompletedEvent {
  return {
    type: 'AgentCompleted',
    timestamp: ts(),
    taskId: fx.taskId,
    sessionId: fx.sessionId,
    agentId: 'codex',
    adapterFidelityTier: 'B',
    summary: 'implemented the widget',
    deliverables: [{ type: 'commit', ref: 'abc123', summary: 'widget' }],
    exitCode: 0,
    durationMs: 60_000,
  };
}

/* ------------------------------------------------------------------ *
 * EventJournalWriter — bus events become durable evidence
 * ------------------------------------------------------------------ */

describe('EventJournalWriter', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  it('persists bus-published adapter events into the journal', () => {
    fx.bus.publish(verifyEvent(fx));
    const rows = fx.eventRepo.listBySession(fx.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('VerificationObserved');
    expect(rows[0]!.payload['success']).toBe(true);
    expect(rows[0]!.payload['command']).toBe('npm test');
  });

  it('skips daemon-authored self-journaled kinds', () => {
    const parked: SupervisorEvent = {
      type: 'TaskParked',
      timestamp: ts(),
      taskId: fx.taskId,
      sessionId: fx.sessionId,
      agentId: 'secretary',
      adapterFidelityTier: 'B',
      reason: 'quota',
      resumeAt: null,
    };
    fx.bus.publish(parked);
    expect(fx.eventRepo.listBySession(fx.sessionId)).toHaveLength(0);
  });

  it('supervisorEventToJournalRow preserves the observed timestamp', () => {
    const event = verifyEvent(fx);
    const row = supervisorEventToJournalRow(event);
    expect(row.timestamp).toBe(event.timestamp);
    expect(row.kind).toBe('VerificationObserved');
    expect(row.sessionId).toBe(fx.sessionId);
  });
});

/* ------------------------------------------------------------------ *
 * VerificationGate — assessment + claim recording
 * ------------------------------------------------------------------ */

describe('VerificationGate', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  it('no evidence → unverified, all categories missing', () => {
    const a = fx.gate.assess(fx.taskId, fx.sessionId);
    expect(a.verdict).toBe('unverified');
    expect(a.facts).toHaveLength(0);
    expect(a.missing).toEqual(['test', 'build', 'lint', 'typecheck', 'behavioral']);
  });

  it('a positive VerificationObserved → verified', () => {
    fx.bus.publish(verifyEvent(fx, { kind: 'typecheck' }));
    const a = fx.gate.assess(fx.taskId, fx.sessionId);
    expect(a.verdict).toBe('verified');
    expect(a.positiveCount).toBe(1);
    expect(a.missing).not.toContain('typecheck');
  });

  it('a green TestFinished → verified', () => {
    fx.bus.publish(testFinished(fx, 42, 0));
    expect(fx.gate.assess(fx.taskId, fx.sessionId).verdict).toBe('verified');
  });

  it('a failed TestFinished alone → unverified', () => {
    fx.bus.publish(testFinished(fx, 40, 2));
    const a = fx.gate.assess(fx.taskId, fx.sessionId);
    expect(a.verdict).toBe('unverified');
    expect(a.negativeCount).toBe(1);
  });

  it('latest signal wins: fail then pass → verified; pass then fail → unverified', () => {
    fx.bus.publish(testFinished(fx, 40, 2));
    fx.bus.publish(testFinished(fx, 42, 0));
    expect(fx.gate.assess(fx.taskId, fx.sessionId).verdict).toBe('verified');

    const fx2 = createFixture();
    fx2.bus.publish(testFinished(fx2, 42, 0));
    fx2.bus.publish(verifyEvent(fx2, { kind: 'build', success: false, summary: 'build broke' }));
    expect(fx2.gate.assess(fx2.taskId, fx2.sessionId).verdict).toBe('unverified');
  });

  it('gateCompletion journals an unverified claim record — once', () => {
    const a1 = fx.gate.gateCompletion(fx.taskId, fx.sessionId, 'codex');
    expect(a1.verdict).toBe('unverified');

    const claims = fx.eventRepo
      .listBySession(fx.sessionId)
      .filter((e) => e.kind === 'VerificationObserved' && e.payload['kind'] === 'other');
    expect(claims).toHaveLength(1);
    expect(claims[0]!.payload['success']).toBe(false);

    // Second gating of the same claim does not duplicate the record.
    fx.gate.gateCompletion(fx.taskId, fx.sessionId, 'codex');
    const claims2 = fx.eventRepo
      .listBySession(fx.sessionId)
      .filter((e) => e.kind === 'VerificationObserved' && e.payload['kind'] === 'other');
    expect(claims2).toHaveLength(1);
  });

  it('verificationObjective names the missing evidence', () => {
    const a = fx.gate.assess(fx.taskId, fx.sessionId);
    const objective = fx.gate.verificationObjective(a);
    expect(objective).toContain('test');
    expect(objective).toContain('build');
  });
});

/* ------------------------------------------------------------------ *
 * Attention surface — verified digest vs unverified completion
 * ------------------------------------------------------------------ */

describe('verification-gated inbox surface', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  it('evidence-backed completion surfaces as a verified Digest', () => {
    // Adapter evidence flows through the real bus → writer → journal path.
    fx.bus.publish(testFinished(fx, 1623, 0));
    fx.bus.publish(verifyEvent(fx, { kind: 'typecheck', command: 'npm run typecheck' }));

    fx.aggregator.handleEvent(completed(fx));

    const items = fx.inbox.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('Digest');
    expect(items[0]!.priority).toBe('Low');
    expect(items[0]!.payload['verified']).toBe(true);
    expect(items[0]!.payload['evidenceCount']).toBe(2);
  });

  it('a completion claim without evidence surfaces as UnverifiedCompletion', () => {
    fx.aggregator.handleEvent(completed(fx));

    const items = fx.inbox.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('UnverifiedCompletion');
    expect(items[0]!.priority).toBe('High');
    expect(items[0]!.payload['verified']).toBe(false);
    expect(items[0]!.payload['verificationObjective']).toContain('test suite');

    // The unproven claim is journaled — manager accountability (DEC-032).
    const claims = fx.eventRepo
      .listByTask(fx.taskId)
      .filter((e) => e.kind === 'VerificationObserved' && e.payload['kind'] === 'other');
    expect(claims).toHaveLength(1);
  });

  it('evidence produced after an unverified claim flips the next assessment', () => {
    fx.aggregator.handleEvent(completed(fx));
    expect(fx.inbox.list()[0]!.kind).toBe('UnverifiedCompletion');

    // The worker goes back, runs the suite, produces proof.
    fx.bus.publish(testFinished(fx, 100, 0));
    const a = fx.gate.assess(fx.taskId, fx.sessionId);
    expect(a.verdict).toBe('verified');
  });
});
