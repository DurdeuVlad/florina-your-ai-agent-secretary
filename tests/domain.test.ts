import { describe, it, expect } from 'vitest';
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
import type {
  Agent,
  Approval,
  AttentionItem,
  ContextCapsule,
  Decision,
  Deliverable,
  Event,
  Project,
  ProjectCapsule,
  Session,
  SessionCapsule,
  Task,
  TaskCapsule,
} from '../src/domain/index.js';

describe('domain enums', () => {
  it('TaskState covers all lifecycle states', () => {
    const states = Object.values(TaskState);
    expect(states).toEqual(
      expect.arrayContaining([
        'created',
        'delegated',
        'running',
        'attention-needed',
        'blocked',
        'completed',
        'reviewed',
        'accepted',
        'failed',
        'cancelled',
      ]),
    );
    expect(states).toHaveLength(10);
  });

  it('AttentionCategory covers all categories', () => {
    const categories = Object.values(AttentionCategory);
    expect(categories).toEqual(
      expect.arrayContaining([
        'FYI',
        'Completed',
        'Blocked',
        'ApprovalRequired',
        'DecisionRequired',
        'RiskDetected',
        'Failure',
        'Conflict',
        'ScopeChanged',
      ]),
    );
    expect(categories).toHaveLength(9);
  });

  it('AttentionPriority has HIGH, MED, LOW', () => {
    expect(Object.values(AttentionPriority).sort()).toEqual(['HIGH', 'LOW', 'MED']);
  });

  it('AdapterFidelityTier has tiers A through E', () => {
    expect(Object.values(AdapterFidelityTier).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('ApprovalAuthorityLevel covers the voice security hierarchy', () => {
    expect(Object.values(ApprovalAuthorityLevel).sort()).toEqual([
      'authenticatedUI',
      'strongDevice',
      'voiceOnly',
      'voiceScopedPhrase',
    ]);
  });

  it('ContextCapsuleScope has the DEC-020 scopes plus the amended user scope', () => {
    expect(Object.values(ContextCapsuleScope).sort()).toEqual([
      'project',
      'session',
      'task',
      'user',
    ]);
  });
});

describe('domain object construction', () => {
  it('constructs a Project with required fields', () => {
    const project: Project = buildProject({
      name: 'florina',
      repo: {
        path: '/repo/florina',
        remoteUrl: 'git@github.com:DurdeuVlad/florina.git',
      },
    });
    expect(project.id).toBeTruthy();
    expect(project.name).toBe('florina');
    expect(project.taskIds).toEqual([]);
    expect(project.policies.allowAutoApproval).toBe(false);
    expect(project.capsuleId).toBeTruthy();
  });

  it('constructs a Task with required fields', () => {
    const task: Task = buildTask({
      projectId: 'project_1',
      objective: 'Add cursor pagination to invoices',
    });
    expect(task.id).toBeTruthy();
    expect(task.projectId).toBe('project_1');
    expect(task.state).toBe(TaskState.Created);
    expect(task.agentIds).toEqual([]);
    expect(task.sessionIds).toEqual([]);
  });

  it('constructs an Agent with required fields', () => {
    const agent: Agent = buildAgent({
      name: 'Codex',
      provider: 'codex',
      fidelityTier: AdapterFidelityTier.A,
      runtime: { kind: 'app-server', endpoint: 'http://localhost:2425' },
    });
    expect(agent.id).toBeTruthy();
    expect(agent.fidelityTier).toBe(AdapterFidelityTier.A);
    expect(agent.runtime.kind).toBe('app-server');
  });

  it('constructs a Session belonging to exactly one Task', () => {
    const session: Session = buildSession({
      taskId: 'task_1',
      agentId: 'agent_1',
    });
    expect(session.taskId).toBe('task_1');
    expect(session.agentId).toBe('agent_1');
    expect(session.eventIds).toEqual([]);
    expect(session.status).toBe('pending');
  });

  it('constructs a Deliverable with required fields', () => {
    const deliverable: Deliverable = buildDeliverable({
      taskId: 'task_1',
      type: 'code-change',
      title: 'Cursor pagination',
      description: 'Added cursor-based pagination to invoice query.',
    });
    expect(deliverable.taskId).toBe('task_1');
    expect(deliverable.type).toBe('code-change');
    expect(deliverable.artifacts).toEqual({});
  });

  it('constructs an immutable Event with required fields', () => {
    const event: Event = buildEvent({
      sessionId: 'session_1',
      taskId: 'task_1',
      kind: 'FileChanged',
      payload: { path: 'src/invoices.ts' },
    });
    expect(event.kind).toBe('FileChanged');
    expect(event.payload).toEqual({ path: 'src/invoices.ts' });
    expect(event.timestamp).toBeTruthy();
  });

  it('constructs an AttentionItem with required fields', () => {
    const item: AttentionItem = buildAttentionItem({
      taskId: 'task_1',
      category: AttentionCategory.ApprovalRequired,
      priority: AttentionPriority.High,
      reason: 'Agent requests network access to npmjs.org',
      decisionRequested: 'Allow network access to registry.npmjs.org?',
      affectedCapability: 'network',
      suggestedSafeOptions: ['allow once', 'deny'],
      blockingImpact: true,
    });
    expect(item.category).toBe(AttentionCategory.ApprovalRequired);
    expect(item.priority).toBe(AttentionPriority.High);
    expect(item.blockingImpact).toBe(true);
    expect(item.resolved).toBe(false);
  });

  it('constructs a Decision with required fields', () => {
    const decision: Decision = buildDecision({
      taskId: 'task_1',
      question: 'Which cache invalidation strategy should we use?',
      options: ['ttl', 'write-through', 'write-behind'],
    });
    expect(decision.status).toBe('open');
    expect(decision.options).toHaveLength(3);
  });

  it('constructs an Approval with required fields', () => {
    const approval: Approval = buildApproval({
      taskId: 'task_1',
      capability: 'network',
      destination: 'registry.npmjs.org',
      authorityLevel: ApprovalAuthorityLevel.AuthenticatedUI,
    });
    expect(approval.capability).toBe('network');
    expect(approval.granted).toBe(false);
    expect(approval.authorityLevel).toBe(ApprovalAuthorityLevel.AuthenticatedUI);
  });
});

describe('context capsule scopes are distinct types', () => {
  it('builds a Project capsule with scope "project"', () => {
    const capsule = buildProjectCapsule({
      ownerId: 'project_1',
      content: {
        repoMetadata: { path: '/repo' },
        policies: { allowAutoApproval: false, livenessTimeoutMs: 1000, alwaysApprove: [] },
        taskListSummary: [],
      },
    });
    expect(capsule.scope).toBe(ContextCapsuleScope.Project);
    // Discriminated union narrows to ProjectCapsule.
    const projectCapsule: ProjectCapsule = capsule;
    expect(projectCapsule.content.repoMetadata.path).toBe('/repo');
  });

  it('builds a Task capsule with scope "task"', () => {
    const capsule = buildTaskCapsule({
      ownerId: 'task_1',
      content: {
        objective: 'Add pagination',
        agentIds: [],
        runHistory: [],
        deliverableIds: [],
        rolledUpEventSummaries: [],
      },
    });
    expect(capsule.scope).toBe(ContextCapsuleScope.Task);
    const taskCapsule: TaskCapsule = capsule;
    expect(taskCapsule.content.objective).toBe('Add pagination');
  });

  it('builds a Session capsule with scope "session"', () => {
    const capsule = buildSessionCapsule({
      ownerId: 'session_1',
      content: { conversation: [], toolCalls: [], eventIds: [] },
    });
    expect(capsule.scope).toBe(ContextCapsuleScope.Session);
    const sessionCapsule: SessionCapsule = capsule;
    expect(sessionCapsule.content.eventIds).toEqual([]);
  });

  it('each capsule scope produces a distinct ContextCapsule variant', () => {
    const projectCapsule = buildProjectCapsule({
      ownerId: 'p',
      content: {
        repoMetadata: { path: '/r' },
        policies: { allowAutoApproval: false, livenessTimeoutMs: 1, alwaysApprove: [] },
        taskListSummary: [],
      },
    });
    const taskCapsule = buildTaskCapsule({
      ownerId: 't',
      content: {
        objective: 'o',
        agentIds: [],
        runHistory: [],
        deliverableIds: [],
        rolledUpEventSummaries: [],
      },
    });
    const sessionCapsule = buildSessionCapsule({
      ownerId: 's',
      content: { conversation: [], toolCalls: [], eventIds: [] },
    });

    const scopes = new Set([
      (projectCapsule as ContextCapsule).scope,
      (taskCapsule as ContextCapsule).scope,
      (sessionCapsule as ContextCapsule).scope,
    ]);
    expect(scopes.size).toBe(3);
  });
});

describe('domain relationships', () => {
  it('a Session belongs to exactly one Task and one Agent', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    const task = buildTask({ projectId: project.id, objective: 'do work' });
    const agent = buildAgent({
      name: 'Claude Code',
      provider: 'claude-code',
      fidelityTier: AdapterFidelityTier.B,
      runtime: { kind: 'cli', command: 'claude' },
    });
    const session = buildSession({ taskId: task.id, agentId: agent.id });

    expect(session.taskId).toBe(task.id);
    expect(session.agentId).toBe(agent.id);
    // A session references exactly one task.
    expect(typeof session.taskId).toBe('string');
  });

  it('a Project contains multiple Tasks', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    const t1 = buildTask({ projectId: project.id, objective: 'a' });
    const t2 = buildTask({ projectId: project.id, objective: 'b' });
    expect(t1.projectId).toBe(project.id);
    expect(t2.projectId).toBe(project.id);
    expect([t1.id, t2.id]).not.toContain(project.id);
  });

  it('Sessions produce Events and Deliverables', () => {
    const task = buildTask({ projectId: 'p', objective: 'o' });
    const agent = buildAgent({
      name: 'Codex',
      provider: 'codex',
      fidelityTier: AdapterFidelityTier.A,
      runtime: { kind: 'app-server' },
    });
    const session = buildSession({ taskId: task.id, agentId: agent.id });
    const event = buildEvent({
      sessionId: session.id,
      taskId: task.id,
      kind: 'FileChanged',
    });
    const deliverable = buildDeliverable({
      taskId: task.id,
      sessionId: session.id,
      type: 'diff',
      title: 'changes',
      description: 'desc',
    });
    expect(event.sessionId).toBe(session.id);
    expect(deliverable.sessionId).toBe(session.id);
  });

  it('Events feed AttentionItems which prompt Decisions/Approvals', () => {
    const task = buildTask({ projectId: 'p', objective: 'o' });
    const event = buildEvent({
      sessionId: 's',
      taskId: task.id,
      kind: 'ApprovalRequested',
    });
    const attention = buildAttentionItem({
      taskId: task.id,
      category: AttentionCategory.ApprovalRequired,
      priority: AttentionPriority.High,
      reason: 'network requested',
      decisionRequested: 'Allow network?',
      relatedEventIds: [event.id],
      blockingImpact: true,
    });
    const decision = buildDecision({
      taskId: task.id,
      question: 'Allow network access?',
      attentionItemId: attention.id,
    });
    const approval = buildApproval({
      taskId: task.id,
      capability: 'network',
      attentionItemId: attention.id,
    });
    expect(attention.relatedEventIds).toContain(event.id);
    expect(decision.attentionItemId).toBe(attention.id);
    expect(approval.attentionItemId).toBe(attention.id);
  });

  it('each Project/Task/Session owns a ContextCapsule', () => {
    const project = buildProject({ name: 'p', repo: { path: '/r' } });
    const task = buildTask({ projectId: project.id, objective: 'o' });
    const session = buildSession({ taskId: task.id, agentId: 'a' });

    const projectCapsule = buildProjectCapsule({
      ownerId: project.id,
      content: {
        repoMetadata: project.repo,
        policies: project.policies,
        taskListSummary: [],
      },
    });
    const taskCapsule = buildTaskCapsule({
      ownerId: task.id,
      content: {
        objective: task.objective,
        agentIds: [],
        runHistory: [],
        deliverableIds: [],
        rolledUpEventSummaries: [],
      },
    });
    const sessionCapsule = buildSessionCapsule({
      ownerId: session.id,
      content: { conversation: [], toolCalls: [], eventIds: [] },
    });

    expect(projectCapsule.ownerId).toBe(project.id);
    expect(taskCapsule.ownerId).toBe(task.id);
    expect(sessionCapsule.ownerId).toBe(session.id);
  });
});
