/**
 * Scoped approvals (issue #67) — durable capability grants that
 * auto-approve requests inside granted scopes and escalate everything
 * else. Exercises the pure scope matcher, the GrantService against real
 * SQLite + journal, the attention-aggregator gate, and the capability
 * broker grant path.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  buildGrant,
  grantCoversRequest,
  isGrantActive,
  type CapabilityGrant,
} from '../src/core/domain/grants.js';
import { buildCapabilityRequest } from '../src/core/domain/capabilities.js';
import type { ApprovalRequestedEvent } from '../src/core/domain/events.js';
import { GrantService } from '../src/core/application/use-cases/capabilities/grant-service.js';
import {
  CapabilityBroker,
  type ActionContext,
} from '../src/core/application/use-cases/capabilities/capability-broker.js';
import {
  AttentionAggregator,
  type ApprovalGate,
} from '../src/core/application/use-cases/attention/attention-aggregator.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  CapabilityGrantRepository,
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import { buildProject, buildTask } from '../src/core/domain/index.js';
import type { SupervisorEvent } from '../src/core/domain/events.js';
import type { CredentialVaultPort } from '../src/core/application/ports/outbound/credential-vault.js';

/* ------------------------------------------------------------------ *
 * Pure scope matching (no DB)
 * ------------------------------------------------------------------ */

describe('grantCoversRequest (structured matching)', () => {
  const baseGrant = buildGrant({
    projectId: 'p1',
    capability: 'filesystem',
    scopes: [{ type: 'filesystem', targets: ['src/'] }],
    duration: 'project',
    grantedBy: 'voice',
  });

  const request = (over: Partial<Parameters<typeof buildCapabilityRequest>[0]> = {}) =>
    buildCapabilityRequest({
      task: 't',
      agent: 'codex',
      capability: 'filesystem',
      destination: 'src/foo.ts',
      command: '',
      workingDir: '/repo',
      ...over,
    });

  it('covers a path inside a granted prefix', () => {
    expect(grantCoversRequest(baseGrant, request(), 'task-1')).toBe(true);
    expect(
      grantCoversRequest(baseGrant, request({ destination: 'src/deep/nested/x.ts' }), 'task-1'),
    ).toBe(true);
  });

  it('rejects a path outside the granted prefix', () => {
    expect(
      grantCoversRequest(baseGrant, request({ destination: 'docs/readme.md' }), 'task-1'),
    ).toBe(false);
    // 'srcx' must not match the 'src/' prefix.
    expect(grantCoversRequest(baseGrant, request({ destination: 'srcx/evil.ts' }), 'task-1')).toBe(
      false,
    );
  });

  it('covers network domains by suffix', () => {
    const grant = buildGrant({
      projectId: 'p1',
      capability: 'network',
      scopes: [{ type: 'network', targets: ['npmjs.org'] }],
      duration: 'project',
      grantedBy: 'cli',
    });
    expect(
      grantCoversRequest(
        grant,
        request({ capability: 'network', destination: 'registry.npmjs.org' }),
        'task-1',
      ),
    ).toBe(true);
    expect(
      grantCoversRequest(
        grant,
        request({ capability: 'network', destination: 'evilnpmjs.org' }),
        'task-1',
      ),
    ).toBe(false);
    expect(
      grantCoversRequest(
        grant,
        request({ capability: 'network', destination: 'other.com' }),
        'task-1',
      ),
    ).toBe(false);
  });

  it('covers shell commands by command prefix', () => {
    const grant = buildGrant({
      projectId: 'p1',
      capability: 'shell',
      scopes: [{ type: 'shell', targets: ['npm test'] }],
      duration: 'project',
      grantedBy: 'cli',
    });
    expect(
      grantCoversRequest(
        grant,
        request({ capability: 'shell', destination: 'npm test -- --watch' }),
        't1',
      ),
    ).toBe(true);
    expect(
      grantCoversRequest(grant, request({ capability: 'shell', destination: 'npm publish' }), 't1'),
    ).toBe(false);
  });

  it('a task-scoped grant covers only that task', () => {
    const grant = buildGrant({
      projectId: 'p1',
      taskId: 'task-a',
      capability: 'filesystem',
      scopes: [{ type: 'filesystem', targets: ['src/'] }],
      duration: 'task',
      grantedBy: 'voice',
    });
    expect(grantCoversRequest(grant, request(), 'task-a')).toBe(true);
    expect(grantCoversRequest(grant, request(), 'task-b')).toBe(false);
  });

  it('an expired or revoked grant covers nothing', () => {
    const expired = buildGrant({
      projectId: 'p1',
      capability: 'filesystem',
      scopes: [{ type: 'filesystem', targets: ['src/'] }],
      duration: 'project',
      grantedBy: 'voice',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    expect(isGrantActive(expired)).toBe(false);
    expect(grantCoversRequest(expired, request(), 'task-1')).toBe(false);

    const revoked: CapabilityGrant = { ...baseGrant, revokedAt: new Date().toISOString() };
    expect(isGrantActive(revoked)).toBe(false);
    expect(grantCoversRequest(revoked, request(), 'task-1')).toBe(false);
  });

  it('a capability mismatch never covers', () => {
    const grant = buildGrant({
      projectId: 'p1',
      capability: 'network',
      scopes: [{ type: 'network', targets: ['npmjs.org'] }],
      duration: 'project',
      grantedBy: 'voice',
    });
    // Same-looking target, wrong capability class.
    expect(grantCoversRequest(grant, request({ destination: 'npmjs.org' }), 't1')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * GrantService against real SQLite + journal
 * ------------------------------------------------------------------ */

interface Fixture {
  service: GrantService;
  grantRepo: CapabilityGrantRepository;
  eventRepo: EventRepository;
  bus: EventBus;
  published: SupervisorEvent[];
  projectId: string;
  taskId: string;
  taskId2: string;
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
  const task2 = buildTask({ projectId: project.id, objective: 'another task' });
  taskRepo.insert(task);
  taskRepo.insert(task2);

  // Real session rows for the journal FK (one per task).
  const sessionId = 'sess-1';
  for (const [sid, tid] of [
    [sessionId, task.id],
    ['sess-2', task2.id],
  ] as const) {
    raw
      .prepare(
        'INSERT INTO sessions (id, task_id, agent_id, status, started_at, capsule_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(sid, tid, 'codex', 'running', new Date().toISOString(), 'capsule-1');
  }

  const eventRepo = new EventRepository(raw);
  const grantRepo = new CapabilityGrantRepository(raw);
  const bus = new EventBus();
  const service = new GrantService({ grantStore: grantRepo, journal: eventRepo, eventBus: bus });

  const published: SupervisorEvent[] = [];
  bus.onEvent((event) => published.push(event));

  return {
    service,
    grantRepo,
    eventRepo,
    bus,
    published,
    projectId: project.id,
    taskId: task.id,
    taskId2: task2.id,
    sessionId,
  };
}

const fsRequest = (destination = 'src/foo.ts') =>
  buildCapabilityRequest({
    task: 'build',
    agent: 'codex',
    capability: 'filesystem',
    destination,
    command: '',
    workingDir: '/repo',
  });

describe('GrantService', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  const journalCtx = () => ({ taskId: fx.taskId, sessionId: fx.sessionId });
  const evalCtx = (over: Partial<Parameters<GrantService['evaluate']>[1]> = {}) => ({
    projectId: fx.projectId,
    taskId: fx.taskId,
    sessionId: fx.sessionId,
    adapterFidelityTier: 'B' as const,
    policyDecision: 'escalate' as const,
    ...over,
  });

  it('records a grant and journals + publishes ApprovalGranted', () => {
    const grant = fx.service.grant(
      {
        projectId: fx.projectId,
        capability: 'filesystem',
        scopes: [{ type: 'filesystem', targets: ['src/'] }],
        duration: 'task',
        taskId: fx.taskId,
        grantedBy: 'voice',
      },
      journalCtx(),
    );

    expect(fx.grantRepo.getById(grant.id)).not.toBeNull();
    const journaled = fx.eventRepo
      .listByTask(fx.taskId)
      .filter((e) => e.kind === 'ApprovalGranted');
    expect(journaled).toHaveLength(1);
    expect(journaled[0]!.payload['grantId']).toBe(grant.id);
    expect(journaled[0]!.payload['grantedBy']).toBe('voice');
    expect(fx.published.filter((e) => e.type === 'ApprovalGranted')).toHaveLength(1);
  });

  it('auto-approves a covered escalate and journals the application', () => {
    const grant = fx.service.grant(
      {
        projectId: fx.projectId,
        capability: 'filesystem',
        scopes: [{ type: 'filesystem', targets: ['src/'] }],
        duration: 'task',
        taskId: fx.taskId,
        grantedBy: 'cli',
      },
      journalCtx(),
    );

    const res = fx.service.evaluate(fsRequest(), evalCtx());
    expect(res.decision).toBe('allow');
    expect(res.autoApproved).toBe(true);
    expect(res.coveringGrant?.id).toBe(grant.id);

    // Creation event + application event = 2 journaled ApprovalGranted.
    // The application traces grantedBy to the human's grant; agentId
    // 'scope-grant' marks it as an auto-approve application.
    const journaled = fx.eventRepo
      .listByTask(fx.taskId)
      .filter((e) => e.kind === 'ApprovalGranted');
    expect(journaled).toHaveLength(2);
    expect(journaled[1]!.payload['agentId']).toBe('scope-grant');
    expect(journaled[1]!.payload['grantedBy']).toBe('cli');
    expect(journaled[1]!.payload['grantId']).toBe(grant.id);
  });

  it('escalates when no grant covers the request', () => {
    const res = fx.service.evaluate(fsRequest('etc/passwd'), evalCtx());
    expect(res.decision).toBe('escalate');
    expect(res.autoApproved).toBe(false);
  });

  it('a task-scoped grant does not auto-approve a different task', () => {
    fx.service.grant(
      {
        projectId: fx.projectId,
        capability: 'filesystem',
        scopes: [{ type: 'filesystem', targets: ['src/'] }],
        duration: 'task',
        taskId: fx.taskId,
        grantedBy: 'voice',
      },
      journalCtx(),
    );

    const res = fx.service.evaluate(
      fsRequest(),
      evalCtx({ taskId: fx.taskId2, sessionId: 'sess-2' }),
    );
    expect(res.decision).toBe('escalate');
    expect(res.autoApproved).toBe(false);
  });

  it('a project-scoped grant covers any task in the project', () => {
    fx.service.grant(
      {
        projectId: fx.projectId,
        capability: 'filesystem',
        scopes: [{ type: 'filesystem', targets: ['src/'] }],
        duration: 'project',
        grantedBy: 'voice',
      },
      journalCtx(),
    );

    const res = fx.service.evaluate(
      fsRequest(),
      evalCtx({ taskId: fx.taskId2, sessionId: 'sess-2' }),
    );
    expect(res.decision).toBe('allow');
    expect(res.autoApproved).toBe(true);
  });

  it('revocation takes effect on the next request and is journaled', () => {
    const grant = fx.service.grant(
      {
        projectId: fx.projectId,
        capability: 'filesystem',
        scopes: [{ type: 'filesystem', targets: ['src/'] }],
        duration: 'project',
        grantedBy: 'voice',
      },
      journalCtx(),
    );
    expect(fx.service.evaluate(fsRequest(), evalCtx()).autoApproved).toBe(true);

    const revoked = fx.service.revoke(grant.id, { ...journalCtx(), reason: 'no longer needed' });
    expect(revoked).toBe(true);
    expect(fx.service.evaluate(fsRequest(), evalCtx()).autoApproved).toBe(false);

    const revokedEvents = fx.eventRepo
      .listByTask(fx.taskId)
      .filter((e) => e.kind === 'ApprovalRevoked');
    expect(revokedEvents).toHaveLength(1);
    expect(revokedEvents[0]!.payload['grantId']).toBe(grant.id);
    expect(revokedEvents[0]!.payload['reason']).toBe('no longer needed');

    // Double-revoke is a no-op.
    expect(fx.service.revoke(grant.id, journalCtx())).toBe(false);
  });

  it('policy deny is absolute — a covering grant cannot override it', () => {
    fx.service.grant(
      {
        projectId: fx.projectId,
        capability: 'filesystem',
        scopes: [{ type: 'filesystem', targets: ['src/'] }],
        duration: 'project',
        grantedBy: 'voice',
      },
      journalCtx(),
    );

    const res = fx.service.evaluate(fsRequest(), evalCtx({ policyDecision: 'deny' }));
    expect(res.decision).toBe('deny');
    expect(res.autoApproved).toBe(false);
  });

  it('tier D/E adapters never auto-approve', () => {
    fx.service.grant(
      {
        projectId: fx.projectId,
        capability: 'filesystem',
        scopes: [{ type: 'filesystem', targets: ['src/'] }],
        duration: 'project',
        grantedBy: 'voice',
      },
      journalCtx(),
    );

    for (const tier of ['D', 'E'] as const) {
      const res = fx.service.evaluate(fsRequest(), evalCtx({ adapterFidelityTier: tier }));
      expect(res.decision).toBe('escalate');
      expect(res.autoApproved).toBe(false);
    }
    // Tier A and C do auto-approve.
    for (const tier of ['A', 'C'] as const) {
      expect(
        fx.service.evaluate(fsRequest(), evalCtx({ adapterFidelityTier: tier })).autoApproved,
      ).toBe(true);
    }
  });

  it('listGrants filters by project, task, and active state', () => {
    const g1 = fx.service.grant(
      {
        projectId: fx.projectId,
        taskId: fx.taskId,
        capability: 'filesystem',
        scopes: [{ type: 'filesystem', targets: ['src/'] }],
        duration: 'task',
        grantedBy: 'voice',
      },
      journalCtx(),
    );
    fx.service.grant(
      {
        projectId: fx.projectId,
        capability: 'network',
        scopes: [{ type: 'network', targets: ['npmjs.org'] }],
        duration: 'project',
        grantedBy: 'cli',
      },
      journalCtx(),
    );
    fx.service.revoke(g1.id, journalCtx());

    expect(fx.service.listGrants({ projectId: fx.projectId })).toHaveLength(2);
    expect(fx.service.listGrants({ projectId: fx.projectId, activeOnly: true })).toHaveLength(1);
    expect(fx.service.listGrants({ taskId: fx.taskId, activeOnly: true })).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * AttentionAggregator — auto-approved requests never reach the inbox
 * ------------------------------------------------------------------ */

describe('AttentionAggregator approval gate', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  const approvalEvent = (destination: string): ApprovalRequestedEvent => ({
    type: 'ApprovalRequested',
    timestamp: new Date().toISOString(),
    taskId: fx.taskId,
    sessionId: fx.sessionId,
    agentId: 'codex',
    adapterFidelityTier: 'B',
    task: 'build',
    agent: 'codex',
    capability: 'filesystem',
    destination,
    command: '',
    workingDir: '/repo',
    scope: [{ type: 'filesystem', targets: [destination] }],
    riskLevel: 'medium',
  });

  function wiredAggregator(): { aggregator: AttentionAggregator; inbox: AttentionInbox } {
    const inbox = new AttentionInbox();
    const gate: ApprovalGate = {
      evaluateApprovalRequest: (event) =>
        fx.service.evaluate(event, {
          projectId: fx.projectId,
          taskId: event.taskId,
          sessionId: event.sessionId,
          adapterFidelityTier: event.adapterFidelityTier,
          policyDecision: 'escalate',
        }).autoApproved
          ? 'auto-approved'
          : 'escalate',
    };
    return {
      aggregator: new AttentionAggregator(inbox, new EventBus(), { approvalGate: gate }),
      inbox,
    };
  }

  it('a grant-covered request is auto-approved — no inbox item', () => {
    fx.service.grant(
      {
        projectId: fx.projectId,
        capability: 'filesystem',
        scopes: [{ type: 'filesystem', targets: ['src/'] }],
        duration: 'task',
        taskId: fx.taskId,
        grantedBy: 'voice',
      },
      { taskId: fx.taskId, sessionId: fx.sessionId },
    );
    const { aggregator, inbox } = wiredAggregator();

    aggregator.handleEvent(approvalEvent('src/app.ts'));
    expect(inbox.list()).toHaveLength(0);
  });

  it('an uncovered request still creates an ApprovalRequest card', () => {
    const { aggregator, inbox } = wiredAggregator();
    aggregator.handleEvent(approvalEvent('etc/shadow'));
    const items = inbox.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('ApprovalRequest');
  });
});

/* ------------------------------------------------------------------ *
 * CapabilityBroker — grants satisfy escalation, never a deny
 * ------------------------------------------------------------------ */

describe('CapabilityBroker grant evaluation', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });

  const context: ActionContext = {
    projectId: '',
    taskId: '',
    sessionId: '',
    task: 'build',
    agent: 'codex',
    destination: 'https://github.com/x/y',
    workingDir: '/repo',
    adapterFidelityTier: 'B',
  };

  function broker(opts: { granted: boolean }) {
    const vault: CredentialVaultPort = {
      retrieveCredential: () => 'secret-token',
    };
    const b = new CapabilityBroker({
      credentials: vault,
      events: fx.eventRepo,
      // Empty policy: no rules → every request escalates by default.
      policyResolver: (projectId, taskId) => ({
        projectId,
        ...(taskId !== undefined ? { taskId } : {}),
        allowAutoApproval: true,
        projectRules: [],
        taskRules: [],
      }),
      grantEvaluator: (request, ctx) => fx.service.evaluate(request, ctx),
    });
    b.registerAction({
      action: 'create_pr',
      capability: 'createPR',
      riskLevel: 'high',
      executor: () => ({ success: true, message: 'created' }),
    });
    if (opts.granted) {
      fx.service.grant(
        {
          projectId: fx.projectId,
          capability: 'createPR',
          scopes: [{ type: 'createPR', targets: ['https://github.com/x/y'] }],
          duration: 'project',
          grantedBy: 'voice',
        },
        { taskId: fx.taskId, sessionId: fx.sessionId },
      );
    }
    return b;
  }

  it('a covering grant turns a policy escalate into allow — credential used', async () => {
    const outcome = await broker({ granted: true }).executeAction('create_pr', {}, 'github-token', {
      ...context,
      projectId: fx.projectId,
      taskId: fx.taskId,
      sessionId: fx.sessionId,
    });
    expect(outcome.decision).toBe('allow');
    expect(outcome.credentialUsed).toBe(true);
    expect(outcome.result?.success).toBe(true);
  });

  it('no covering grant → escalation stands, credential untouched', async () => {
    const outcome = await broker({ granted: false }).executeAction(
      'create_pr',
      {},
      'github-token',
      { ...context, projectId: fx.projectId, taskId: fx.taskId, sessionId: fx.sessionId },
    );
    expect(outcome.decision).toBe('escalate');
    expect(outcome.credentialUsed).toBe(false);
  });
});
