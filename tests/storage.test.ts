import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  StorageDatabase,
  runMigrations,
  ProjectRepository,
  TaskRepository,
  AgentRepository,
  SessionRepository,
  DeliverableRepository,
  EventRepository,
  AttentionItemRepository,
  DecisionRepository,
  ApprovalRepository,
  ContextCapsuleRepository,
} from '../src/storage/index.js';
import {
  AdapterFidelityTier,
  ApprovalAuthorityLevel,
  AttentionCategory,
  AttentionPriority,
  ContextCapsuleScope,
  TaskState,
  buildAgent,
  buildApproval,
  buildAttentionItem,
  buildDecision,
  buildDeliverable,
  buildEvent,
  buildProject,
  buildProjectCapsule,
  buildSession,
  buildSessionCapsule,
  buildTask,
  buildTaskCapsule,
} from '../src/domain/index.js';
import type { ContextCapsule } from '../src/domain/index.js';

/**
 * Helper: create a fresh in-memory database with all repositories wired up.
 * Returns the db handle and every repository. The caller is responsible for
 * calling `db.close()` (or use the `beforeEach`/`afterEach` hooks below).
 */
function createTestDb(): {
  db: StorageDatabase;
  raw: Database.Database;
  projects: ProjectRepository;
  tasks: TaskRepository;
  agents: AgentRepository;
  sessions: SessionRepository;
  deliverables: DeliverableRepository;
  events: EventRepository;
  attention: AttentionItemRepository;
  decisions: DecisionRepository;
  approvals: ApprovalRepository;
  capsules: ContextCapsuleRepository;
} {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const raw = db.connection;
  return {
    db,
    raw,
    projects: new ProjectRepository(raw),
    tasks: new TaskRepository(raw),
    agents: new AgentRepository(raw),
    sessions: new SessionRepository(raw),
    deliverables: new DeliverableRepository(raw),
    events: new EventRepository(raw),
    attention: new AttentionItemRepository(raw),
    decisions: new DecisionRepository(raw),
    approvals: new ApprovalRepository(raw),
    capsules: new ContextCapsuleRepository(raw),
  };
}

describe('storage: database initialization & migrations', () => {
  it('initializes an in-memory database and runs migrations', () => {
    const db = new StorageDatabase({ path: ':memory:' });
    const result = db.open();
    expect(result.appliedVersion).toBe(3);
    expect(db.isOpen).toBe(true);
    db.close();
    expect(db.isOpen).toBe(false);
  });

  it('migrations are idempotent — running twice does not error or duplicate', () => {
    const db = new StorageDatabase({ path: ':memory:' });
    db.open();
    // Running runMigrations again on the same connection should be a no-op.
    const version = runMigrations(db.connection);
    expect(version).toBe(3);
    db.close();
  });

  it('healthCheck returns true when open, false when closed', () => {
    const db = new StorageDatabase({ path: ':memory:' });
    expect(db.healthCheck()).toBe(false);
    db.open();
    expect(db.healthCheck()).toBe(true);
    db.close();
    expect(db.healthCheck()).toBe(false);
  });

  it('open throws if already open', () => {
    const db = new StorageDatabase({ path: ':memory:' });
    db.open();
    expect(() => db.open()).toThrow('already open');
    db.close();
  });

  it('connection getter throws if not open', () => {
    const db = new StorageDatabase({ path: ':memory:' });
    expect(() => db.connection).toThrow('not open');
  });

  it('creates all expected tables', () => {
    const { db, raw } = createTestDb();
    const tables = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('projects');
    expect(names).toContain('tasks');
    expect(names).toContain('agents');
    expect(names).toContain('sessions');
    expect(names).toContain('deliverables');
    expect(names).toContain('events');
    expect(names).toContain('attention_items');
    expect(names).toContain('decisions');
    expect(names).toContain('approvals');
    expect(names).toContain('capability_grants');
    expect(names).toContain('briefs');
    expect(names).toContain('context_capsules');
    expect(names).toContain('_migrations');
    db.close();
  });

  it('creates append-only triggers on the events table', () => {
    const { db, raw } = createTestDb();
    const triggers = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='events' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = triggers.map((t) => t.name);
    expect(names).toContain('events_no_update');
    expect(names).toContain('events_no_delete');
    db.close();
  });
});

describe('storage: event journal is append-only (DEC-012)', () => {
  let ctx: ReturnType<typeof createTestDb>;
  let eventId: string;
  let taskId: string;
  let sessionId: string;

  beforeEach(() => {
    ctx = createTestDb();
    // Insert prerequisite rows so foreign keys are satisfied.
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);
    taskId = task.id;
    const agent = buildAgent({
      name: 'Codex',
      provider: 'codex',
      fidelityTier: AdapterFidelityTier.A,
      runtime: { kind: 'app-server' },
    });
    ctx.agents.insert(agent);
    const session = buildSession({ taskId: task.id, agentId: agent.id });
    ctx.sessions.insert(session);
    sessionId = session.id;

    const event = buildEvent({
      sessionId: session.id,
      taskId: task.id,
      kind: 'FileChanged',
      payload: { path: 'src/a.ts' },
    });
    ctx.events.insert(event);
    eventId = event.id;
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('rejects UPDATE on event rows via trigger', () => {
    expect(() =>
      ctx.raw.prepare('UPDATE events SET kind = ? WHERE id = ?').run('AgentStarted', eventId),
    ).toThrow(/append-only/);
  });

  it('rejects DELETE on event rows via trigger', () => {
    expect(() => ctx.raw.prepare('DELETE FROM events WHERE id = ?').run(eventId)).toThrow(
      /append-only/,
    );
  });

  it('EventRepository has no update or delete method', () => {
    const repo = ctx.events;
    expect(typeof (repo as unknown as Record<string, unknown>).update).toBe('undefined');
    expect(typeof (repo as unknown as Record<string, unknown>).delete).toBe('undefined');
  });

  it('allows inserting new events (append works)', () => {
    const event2 = buildEvent({
      sessionId: sessionId,
      taskId: taskId,
      kind: 'ToolStarted',
      payload: { toolName: 'shell' },
    });
    ctx.events.insert(event2);
    const retrieved = ctx.events.getById(event2.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.kind).toBe('ToolStarted');
  });
});

describe('storage: round-trip persistence for every domain object', () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('Project round-trips through the database', () => {
    const project = buildProject({
      name: 'agent-secretary',
      repo: { path: '/repo', remoteUrl: 'git@github.com:foo/bar.git', defaultBranch: 'main' },
      policies: { allowAutoApproval: true, livenessTimeoutMs: 30000, alwaysApprove: ['push'] },
    });
    ctx.projects.insert(project);
    const retrieved = ctx.projects.getById(project.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('agent-secretary');
    expect(retrieved!.repo.path).toBe('/repo');
    expect(retrieved!.repo.remoteUrl).toBe('git@github.com:foo/bar.git');
    expect(retrieved!.policies.allowAutoApproval).toBe(true);
    expect(retrieved!.policies.livenessTimeoutMs).toBe(30000);
    expect(retrieved!.policies.alwaysApprove).toEqual(['push']);
    expect(retrieved!.capsuleId).toBe(project.capsuleId);
  });

  it('Project update changes name and policies', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const updated = {
      ...project,
      name: 'renamed',
      policies: { ...project.policies, allowAutoApproval: true },
      updatedAt: new Date().toISOString(),
    };
    ctx.projects.update(updated);
    const retrieved = ctx.projects.getById(project.id);
    expect(retrieved!.name).toBe('renamed');
    expect(retrieved!.policies.allowAutoApproval).toBe(true);
  });

  it('Task round-trips with all fields including JSON arrays', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({
      projectId: project.id,
      objective: 'Add cursor pagination',
      worktreePath: '/repo/worktrees/task-1',
    });
    ctx.tasks.insert(task);
    const retrieved = ctx.tasks.getById(task.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.projectId).toBe(project.id);
    expect(retrieved!.objective).toBe('Add cursor pagination');
    expect(retrieved!.state).toBe(TaskState.Created);
    expect(retrieved!.agentIds).toEqual([]);
    expect(retrieved!.sessionIds).toEqual([]);
    expect(retrieved!.deliverableIds).toEqual([]);
    expect(retrieved!.attentionItemIds).toEqual([]);
    expect(retrieved!.worktreePath).toBe('/repo/worktrees/task-1');
  });

  it('Task listByProject returns only tasks for that project', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task1 = buildTask({ projectId: project.id, objective: 'a' });
    const task2 = buildTask({ projectId: project.id, objective: 'b' });
    ctx.tasks.insert(task1);
    ctx.tasks.insert(task2);
    const other = buildProject({ name: 'p2', repo: { path: '/r2' } });
    ctx.projects.insert(other);
    const task3 = buildTask({ projectId: other.id, objective: 'c' });
    ctx.tasks.insert(task3);

    const result = ctx.tasks.listByProject(project.id);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.objective)).toEqual(['a', 'b']);
  });

  it('Task update changes state and arrays', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);
    const updated = {
      ...task,
      state: TaskState.Running,
      agentIds: ['agent_1', 'agent_2'],
      updatedAt: new Date().toISOString(),
    };
    ctx.tasks.update(updated);
    const retrieved = ctx.tasks.getById(task.id);
    expect(retrieved!.state).toBe(TaskState.Running);
    expect(retrieved!.agentIds).toEqual(['agent_1', 'agent_2']);
  });

  it('Agent round-trips with runtime JSON', () => {
    const agent = buildAgent({
      name: 'Claude Code',
      provider: 'claude-code',
      fidelityTier: AdapterFidelityTier.B,
      runtime: { kind: 'cli', command: 'claude' },
    });
    ctx.agents.insert(agent);
    const retrieved = ctx.agents.getById(agent.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('Claude Code');
    expect(retrieved!.provider).toBe('claude-code');
    expect(retrieved!.fidelityTier).toBe(AdapterFidelityTier.B);
    expect(retrieved!.runtime.kind).toBe('cli');
    expect(retrieved!.runtime.command).toBe('claude');
  });

  it('Session round-trips and listByTask works', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);
    const agent = buildAgent({
      name: 'Codex',
      provider: 'codex',
      fidelityTier: AdapterFidelityTier.A,
      runtime: { kind: 'app-server' },
    });
    ctx.agents.insert(agent);
    const session = buildSession({ taskId: task.id, agentId: agent.id, status: 'running' });
    ctx.sessions.insert(session);

    const retrieved = ctx.sessions.getById(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.taskId).toBe(task.id);
    expect(retrieved!.agentId).toBe(agent.id);
    expect(retrieved!.status).toBe('running');

    const list = ctx.sessions.listByTask(task.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(session.id);
  });

  it('Session update changes status and endedAt', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);
    const agent = buildAgent({
      name: 'Codex',
      provider: 'codex',
      fidelityTier: AdapterFidelityTier.A,
      runtime: { kind: 'app-server' },
    });
    ctx.agents.insert(agent);
    const session = buildSession({ taskId: task.id, agentId: agent.id });
    ctx.sessions.insert(session);

    const endedAt = new Date().toISOString();
    ctx.sessions.update({
      ...session,
      status: 'completed',
      endedAt,
      eventIds: ['event_1'],
    });
    const retrieved = ctx.sessions.getById(session.id);
    expect(retrieved!.status).toBe('completed');
    expect(retrieved!.endedAt).toBe(endedAt);
    expect(retrieved!.eventIds).toEqual(['event_1']);
  });

  it('Deliverable round-trips with artifacts JSON', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);
    const deliverable = buildDeliverable({
      taskId: task.id,
      type: 'commit',
      title: 'Implement pagination',
      description: 'Added cursor pagination',
    });
    ctx.deliverables.insert(deliverable);
    const retrieved = ctx.deliverables.getById(deliverable.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.type).toBe('commit');
    expect(retrieved!.title).toBe('Implement pagination');
    expect(retrieved!.artifacts).toEqual({});
  });

  it('Deliverable listByTask and listBySession work', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);
    const agent = buildAgent({
      name: 'Codex',
      provider: 'codex',
      fidelityTier: AdapterFidelityTier.A,
      runtime: { kind: 'app-server' },
    });
    ctx.agents.insert(agent);
    const session = buildSession({ taskId: task.id, agentId: agent.id });
    ctx.sessions.insert(session);

    const d1 = buildDeliverable({
      taskId: task.id,
      sessionId: session.id,
      type: 'diff',
      title: 'd1',
      description: 'desc',
    });
    ctx.deliverables.insert(d1);
    const d2 = buildDeliverable({
      taskId: task.id,
      type: 'analysis',
      title: 'd2',
      description: 'desc',
    });
    ctx.deliverables.insert(d2);

    expect(ctx.deliverables.listByTask(task.id)).toHaveLength(2);
    expect(ctx.deliverables.listBySession(session.id)).toHaveLength(1);
    expect(ctx.deliverables.listBySession(session.id)[0].id).toBe(d1.id);
  });

  it('Event round-trips with payload JSON', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);
    const agent = buildAgent({
      name: 'Codex',
      provider: 'codex',
      fidelityTier: AdapterFidelityTier.A,
      runtime: { kind: 'app-server' },
    });
    ctx.agents.insert(agent);
    const session = buildSession({ taskId: task.id, agentId: agent.id });
    ctx.sessions.insert(session);

    const event = buildEvent({
      sessionId: session.id,
      taskId: task.id,
      kind: 'FileChanged',
      payload: { path: 'src/a.ts', additions: 10 },
    });
    ctx.events.insert(event);
    const retrieved = ctx.events.getById(event.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.kind).toBe('FileChanged');
    expect(retrieved!.payload).toEqual({ path: 'src/a.ts', additions: 10 });
  });

  it('Event listByTask and listBySession return chronological streams', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);
    const agent = buildAgent({
      name: 'Codex',
      provider: 'codex',
      fidelityTier: AdapterFidelityTier.A,
      runtime: { kind: 'app-server' },
    });
    ctx.agents.insert(agent);
    const session = buildSession({ taskId: task.id, agentId: agent.id });
    ctx.sessions.insert(session);

    const e1 = buildEvent({ sessionId: session.id, taskId: task.id, kind: 'AgentStarted' });
    const e2 = buildEvent({ sessionId: session.id, taskId: task.id, kind: 'FileChanged' });
    // Ensure e1 has an earlier timestamp than e2.
    const earlyEvent = { ...e1, timestamp: new Date(Date.now() - 1000).toISOString() };
    // Insert in reverse order to verify ORDER BY timestamp.
    ctx.events.insert(e2);
    ctx.events.insert(earlyEvent);

    const byTask = ctx.events.listByTask(task.id);
    expect(byTask).toHaveLength(2);
    // Chronological: earlyEvent first, then e2.
    expect(byTask[0].id).toBe(earlyEvent.id);
    expect(byTask[1].id).toBe(e2.id);

    const bySession = ctx.events.listBySession(session.id);
    expect(bySession).toHaveLength(2);
    expect(bySession[0].id).toBe(earlyEvent.id);
  });

  it('AttentionItem round-trips with boolean and array fields', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);

    const item = buildAttentionItem({
      taskId: task.id,
      category: AttentionCategory.ApprovalRequired,
      priority: AttentionPriority.High,
      reason: 'Network requested',
      decisionRequested: 'Allow network?',
      affectedCapability: 'network',
      suggestedSafeOptions: ['allow once', 'deny'],
      blockingImpact: true,
      relatedEventIds: ['event_1', 'event_2'],
    });
    ctx.attention.insert(item);
    const retrieved = ctx.attention.getById(item.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.category).toBe(AttentionCategory.ApprovalRequired);
    expect(retrieved!.priority).toBe(AttentionPriority.High);
    expect(retrieved!.blockingImpact).toBe(true);
    expect(retrieved!.resolved).toBe(false);
    expect(retrieved!.suggestedSafeOptions).toEqual(['allow once', 'deny']);
    expect(retrieved!.relatedEventIds).toEqual(['event_1', 'event_2']);
    expect(retrieved!.affectedCapability).toBe('network');
  });

  it('AttentionItem listByResolved filters correctly', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);

    const open = buildAttentionItem({
      taskId: task.id,
      category: AttentionCategory.Blocked,
      priority: AttentionPriority.High,
      reason: 'r',
      decisionRequested: 'd',
    });
    ctx.attention.insert(open);

    const resolved = buildAttentionItem({
      taskId: task.id,
      category: AttentionCategory.Completed,
      priority: AttentionPriority.Low,
      reason: 'r',
      decisionRequested: 'd',
    });
    ctx.attention.insert(resolved);
    ctx.attention.update({ ...resolved, resolved: true });

    const openItems = ctx.attention.listByResolved(false);
    const resolvedItems = ctx.attention.listByResolved(true);
    expect(openItems).toHaveLength(1);
    expect(openItems[0].id).toBe(open.id);
    expect(resolvedItems).toHaveLength(1);
    expect(resolvedItems[0].id).toBe(resolved.id);
    expect(resolvedItems[0].resolved).toBe(true);
  });

  it('Decision round-trips and update changes status and answer', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);

    const decision = buildDecision({
      taskId: task.id,
      question: 'Which strategy?',
      options: ['ttl', 'write-through'],
    });
    ctx.decisions.insert(decision);
    const retrieved = ctx.decisions.getById(decision.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.status).toBe('open');
    expect(retrieved!.options).toEqual(['ttl', 'write-through']);

    const decidedAt = new Date().toISOString();
    ctx.decisions.update({
      ...decision,
      answer: 'ttl',
      status: 'decided',
      decidedAt,
    });
    const updated = ctx.decisions.getById(decision.id);
    expect(updated!.answer).toBe('ttl');
    expect(updated!.status).toBe('decided');
    expect(updated!.decidedAt).toBe(decidedAt);
  });

  it('Decision listByStatus filters correctly', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);

    const d1 = buildDecision({ taskId: task.id, question: 'q1' });
    const d2 = buildDecision({ taskId: task.id, question: 'q2' });
    ctx.decisions.insert(d1);
    ctx.decisions.insert(d2);
    ctx.decisions.update({ ...d2, status: 'decided', answer: 'yes' });

    expect(ctx.decisions.listByStatus('open')).toHaveLength(1);
    expect(ctx.decisions.listByStatus('decided')).toHaveLength(1);
  });

  it('Approval round-trips with all fields', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);

    const approval = buildApproval({
      taskId: task.id,
      capability: 'network',
      destination: 'registry.npmjs.org',
      authorityLevel: ApprovalAuthorityLevel.AuthenticatedUI,
      scope: 'one-time',
    });
    ctx.approvals.insert(approval);
    const retrieved = ctx.approvals.getById(approval.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.capability).toBe('network');
    expect(retrieved!.destination).toBe('registry.npmjs.org');
    expect(retrieved!.scope).toBe('one-time');
    expect(retrieved!.authorityLevel).toBe(ApprovalAuthorityLevel.AuthenticatedUI);
    expect(retrieved!.granted).toBe(false);
  });

  it('Approval update grants the approval', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'o' });
    ctx.tasks.insert(task);

    const approval = buildApproval({ taskId: task.id, capability: 'push' });
    ctx.approvals.insert(approval);
    const grantedAt = new Date().toISOString();
    ctx.approvals.update({ ...approval, granted: true, grantedAt });
    const retrieved = ctx.approvals.getById(approval.id);
    expect(retrieved!.granted).toBe(true);
    expect(retrieved!.grantedAt).toBe(grantedAt);
  });
});

describe('storage: context capsule scope isolation (DEC-020)', () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('Project capsule round-trips and loads by scope', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    ctx.projects.insert(project);
    const capsule = buildProjectCapsule({
      ownerId: project.id,
      content: {
        repoMetadata: { path: '/repo', remoteUrl: 'git@github.com:foo/bar.git' },
        policies: { allowAutoApproval: false, livenessTimeoutMs: 5000, alwaysApprove: [] },
        taskListSummary: [{ taskId: 'task_1', objective: 'do thing', state: TaskState.Created }],
      },
    });
    ctx.capsules.insert(capsule);

    const loaded = ctx.capsules.loadByScope(ContextCapsuleScope.Project, project.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.scope).toBe('project');
    expect(loaded!.ownerId).toBe(project.id);
    if (loaded.scope === 'project') {
      expect(loaded.content.repoMetadata.path).toBe('/repo');
      expect(loaded.content.taskListSummary).toHaveLength(1);
      expect(loaded.content.taskListSummary[0].taskId).toBe('task_1');
    }
  });

  it('Task capsule round-trips and loads by scope', () => {
    const taskCapsule = buildTaskCapsule({
      ownerId: 'task_42',
      content: {
        objective: 'Add pagination',
        agentIds: ['agent_1'],
        runHistory: [
          { sessionId: 's1', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z' },
        ],
        deliverableIds: ['del_1'],
        rolledUpEventSummaries: ['summary 1'],
      },
    });
    ctx.capsules.insert(taskCapsule);

    const loaded = ctx.capsules.loadByScope(ContextCapsuleScope.Task, 'task_42');
    expect(loaded).not.toBeNull();
    expect(loaded!.scope).toBe('task');
    if (loaded.scope === 'task') {
      expect(loaded.content.objective).toBe('Add pagination');
      expect(loaded.content.agentIds).toEqual(['agent_1']);
      expect(loaded.content.runHistory).toHaveLength(1);
      expect(loaded.content.deliverableIds).toEqual(['del_1']);
    }
  });

  it('Session capsule round-trips and loads by scope', () => {
    const sessionCapsule = buildSessionCapsule({
      ownerId: 'session_7',
      content: {
        conversation: ['hello', 'world'],
        toolCalls: ['shell'],
        eventIds: ['event_1', 'event_2'],
      },
    });
    ctx.capsules.insert(sessionCapsule);

    const loaded = ctx.capsules.loadByScope(ContextCapsuleScope.Session, 'session_7');
    expect(loaded).not.toBeNull();
    expect(loaded!.scope).toBe('session');
    if (loaded.scope === 'session') {
      expect(loaded.content.conversation).toEqual(['hello', 'world']);
      expect(loaded.content.toolCalls).toEqual(['shell']);
      expect(loaded.content.eventIds).toEqual(['event_1', 'event_2']);
    }
  });

  it('loadByScope returns null for a non-existent scope/owner', () => {
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Project, 'nope')).toBeNull();
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Task, 'nope')).toBeNull();
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Session, 'nope')).toBeNull();
  });

  it('capsule-scoped queries return only rows for the requested scope (isolation)', () => {
    // Insert one capsule per scope with distinct owners.
    const projectCap = buildProjectCapsule({
      ownerId: 'project_A',
      content: {
        repoMetadata: { path: '/a' },
        policies: { allowAutoApproval: false, livenessTimeoutMs: 1, alwaysApprove: [] },
        taskListSummary: [],
      },
    });
    const taskCap = buildTaskCapsule({
      ownerId: 'task_B',
      content: {
        objective: 'o',
        agentIds: [],
        runHistory: [],
        deliverableIds: [],
        rolledUpEventSummaries: [],
      },
    });
    const sessionCap = buildSessionCapsule({
      ownerId: 'session_C',
      content: { conversation: [], toolCalls: [], eventIds: [] },
    });
    ctx.capsules.insert(projectCap);
    ctx.capsules.insert(taskCap);
    ctx.capsules.insert(sessionCap);

    // Loading by project scope must not return task or session capsules.
    const projLoaded = ctx.capsules.loadByScope(ContextCapsuleScope.Project, 'project_A');
    expect(projLoaded!.id).toBe(projectCap.id);
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Project, 'task_B')).toBeNull();
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Project, 'session_C')).toBeNull();

    // Loading by task scope must not return project or session capsules.
    const taskLoaded = ctx.capsules.loadByScope(ContextCapsuleScope.Task, 'task_B');
    expect(taskLoaded!.id).toBe(taskCap.id);
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Task, 'project_A')).toBeNull();

    // Loading by session scope must not return project or task capsules.
    const sessLoaded = ctx.capsules.loadByScope(ContextCapsuleScope.Session, 'session_C');
    expect(sessLoaded!.id).toBe(sessionCap.id);
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Session, 'project_A')).toBeNull();

    // listByScope returns only capsules of that scope.
    expect(ctx.capsules.listByScope(ContextCapsuleScope.Project)).toHaveLength(1);
    expect(ctx.capsules.listByScope(ContextCapsuleScope.Task)).toHaveLength(1);
    expect(ctx.capsules.listByScope(ContextCapsuleScope.Session)).toHaveLength(1);
  });

  it('unloadByScope removes the capsule and returns row count', () => {
    const sessionCap = buildSessionCapsule({
      ownerId: 'session_X',
      content: { conversation: [], toolCalls: [], eventIds: [] },
    });
    ctx.capsules.insert(sessionCap);

    const deleted = ctx.capsules.unloadByScope(ContextCapsuleScope.Session, 'session_X');
    expect(deleted).toBe(1);
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Session, 'session_X')).toBeNull();

    // Unloading again returns 0 (already removed).
    const deletedAgain = ctx.capsules.unloadByScope(ContextCapsuleScope.Session, 'session_X');
    expect(deletedAgain).toBe(0);
  });

  it('unloadByScope only removes the matching scope, not other scopes', () => {
    const projectCap = buildProjectCapsule({
      ownerId: 'shared_owner',
      content: {
        repoMetadata: { path: '/a' },
        policies: { allowAutoApproval: false, livenessTimeoutMs: 1, alwaysApprove: [] },
        taskListSummary: [],
      },
    });
    const taskCap = buildTaskCapsule({
      ownerId: 'shared_owner',
      content: {
        objective: 'o',
        agentIds: [],
        runHistory: [],
        deliverableIds: [],
        rolledUpEventSummaries: [],
      },
    });
    ctx.capsules.insert(projectCap);
    ctx.capsules.insert(taskCap);

    // Unload the task capsule; the project capsule for the same owner must remain.
    const deleted = ctx.capsules.unloadByScope(ContextCapsuleScope.Task, 'shared_owner');
    expect(deleted).toBe(1);
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Task, 'shared_owner')).toBeNull();
    expect(ctx.capsules.loadByScope(ContextCapsuleScope.Project, 'shared_owner')).not.toBeNull();
  });

  it('capsule update changes content and updatedAt', () => {
    const capsule = buildTaskCapsule({
      ownerId: 'task_1',
      content: {
        objective: 'original',
        agentIds: [],
        runHistory: [],
        deliverableIds: [],
        rolledUpEventSummaries: [],
      },
    });
    ctx.capsules.insert(capsule);

    const updated: ContextCapsule = {
      ...capsule,
      content: {
        ...capsule.content,
        objective: 'updated objective',
        agentIds: ['agent_new'],
      },
      updatedAt: new Date().toISOString(),
    };
    ctx.capsules.update(updated);

    const loaded = ctx.capsules.loadByScope(ContextCapsuleScope.Task, 'task_1');
    expect(loaded).not.toBeNull();
    if (loaded && loaded.scope === 'task') {
      expect(loaded.content.objective).toBe('updated objective');
      expect(loaded.content.agentIds).toEqual(['agent_new']);
    }
  });
});

describe('storage: migration framework is forward-only', () => {
  it('records applied migrations in _migrations table', () => {
    const { db, raw } = createTestDb();
    const rows = raw.prepare('SELECT version, description FROM _migrations').all() as {
      version: number;
      description: string;
    }[];
    expect(rows).toHaveLength(3);
    expect(rows[0].version).toBe(1);
    expect(rows[0].description).toContain('Create all tables');
    expect(rows[1].version).toBe(2);
    expect(rows[1].description).toContain('capability_grants');
    expect(rows[2].version).toBe(3);
    expect(rows[2].description).toContain('briefs');
    db.close();
  });

  it('a second open on a persistent db does not re-apply migrations', () => {
    // Use a temp file to simulate a persistent database.
    const tmp = path.join(os.tmpdir(), `asec-test-${Date.now()}.db`);
    const db1 = new StorageDatabase({ path: tmp });
    const r1 = db1.open();
    expect(r1.appliedVersion).toBe(3);
    db1.close();

    const db2 = new StorageDatabase({ path: tmp });
    const r2 = db2.open();
    // Migrations should not be re-applied; version stays at 3.
    expect(r2.appliedVersion).toBe(3);
    db2.close();

    // Clean up.
    fs.unlinkSync(tmp);
  });
});
