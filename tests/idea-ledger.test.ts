/**
 * Idea ledger + Brief pipeline (DEC-033, issue #69).
 *
 * Ledger bookkeeping (filesystem artifact + frontmatter index), compile
 * → Brief draft, the single-shot confirmation gate, and dispatch through
 * the normal spawn path — plus the typed-command surface end to end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FsIdeaLedger } from '../src/adapters/outbound/ideas/fs-idea-ledger.js';
import { IdeaService } from '../src/core/application/use-cases/ideas/idea-service.js';
import type { BriefDispatcherPort } from '../src/core/application/use-cases/ideas/idea-service.js';
import type { SpawnTaskInput } from '../src/core/application/use-cases/managers/manager-tools.js';
import {
  CommandApi,
  type CommandApiDeps,
} from '../src/core/application/use-cases/tasks/command-api.js';
import type {
  IdeaResponse,
  IdeaListResponse,
  BriefResponse,
  BriefConfirmResponse,
} from '../src/core/application/use-cases/tasks/command-api.js';
import { TaskStateMachine } from '../src/core/application/use-cases/tasks/task-lifecycle.js';
import { MetricsCollector } from '../src/core/application/use-cases/metrics.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  ApprovalRepository,
  SessionRepository,
  BriefRepository,
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import { buildProject, buildAgent } from '../src/core/domain/index.js';
import type { DelegationPlan } from '../src/core/domain/ideas.js';
import type { Task } from '../src/core/domain/types.js';
import type { WorktreePort } from '../src/core/application/ports/outbound/worktree.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideas-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = '2026-09-21T12:00:00.000Z';

function newService(extra?: Partial<Parameters<typeof IdeaService.prototype.constructor>[0]>): {
  service: IdeaService;
  ledger: FsIdeaLedger;
  briefs: BriefRepository;
} {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const ledger = new FsIdeaLedger(tmpDir);
  const briefs = new BriefRepository(db.connection);
  const service = new IdeaService({
    ledger,
    briefs,
    now: () => new Date(NOW),
    generateId: (p) => `${p}-fixed`,
    ...extra,
  });
  return { service, ledger, briefs };
}

/* ================================================================== *
 * FsIdeaLedger — the file is the artifact
 * ================================================================== */

describe('FsIdeaLedger', () => {
  it('creates a markdown ledger with YAML frontmatter', () => {
    const ledger = new FsIdeaLedger(tmpDir);
    const idea = ledger.create({ id: 'idea-1', title: 'Agent fleet', now: NOW, body: 'seed' });

    expect(idea.status).toBe('open');
    expect(fs.existsSync(idea.path)).toBe(true);
    const text = fs.readFileSync(idea.path, 'utf8');
    expect(text).toContain('id: idea-1');
    expect(text).toContain('status: open');
    expect(text).toContain('seed');
  });

  it('appends titled sections and bumps updated', () => {
    const ledger = new FsIdeaLedger(tmpDir);
    ledger.create({ id: 'idea-1', title: 'x', now: NOW });
    const updated = ledger.append(
      'idea-1',
      'Open questions',
      '- how do managers pick models?',
      '2026-09-21T13:00:00.000Z',
    );

    expect(updated.updatedAt).toBe('2026-09-21T13:00:00.000Z');
    expect(ledger.readBody('idea-1')).toContain('## Open questions');
    expect(ledger.readBody('idea-1')).toContain('how do managers pick models?');
  });

  it('promotes a ledger into a project directory', () => {
    const ledger = new FsIdeaLedger(tmpDir);
    ledger.create({ id: 'idea-1', title: 'x', now: NOW });
    const target = path.join(tmpDir, 'project-ideas');
    const promoted = ledger.promote('idea-1', 'proj-9', target, NOW);

    expect(promoted.status).toBe('promoted');
    expect(promoted.projectId).toBe('proj-9');
    expect(promoted.path).toBe(path.join(target, 'idea-1.md'));
    expect(fs.existsSync(promoted.path)).toBe(true);
    // Still discoverable (the target lives under the store root).
    expect(ledger.get('idea-1')!.status).toBe('promoted');
  });

  it('lists ledgers oldest first', () => {
    const ledger = new FsIdeaLedger(tmpDir);
    ledger.create({ id: 'idea-1', title: 'first', now: '2026-09-21T01:00:00.000Z' });
    ledger.create({ id: 'idea-2', title: 'second', now: '2026-09-21T02:00:00.000Z' });
    expect(ledger.list().map((l) => l.id)).toEqual(['idea-1', 'idea-2']);
  });
});

/* ================================================================== *
 * IdeaService — compile → gate → dispatch
 * ================================================================== */

const PLAN: DelegationPlan = {
  projectId: 'proj-1',
  tasks: [
    { objective: 'build the scheduler', workType: 'build', preferProvider: 'codex' },
    { objective: 'prove it works — tests + verification gate' },
  ],
};

function recordingDispatcher(results: Record<string, 'spawned' | 'parked' | 'error'> = {}): {
  dispatcher: BriefDispatcherPort;
  calls: SpawnTaskInput[];
} {
  const calls: SpawnTaskInput[] = [];
  return {
    calls,
    dispatcher: {
      spawnTask: (_projectId: string, input: SpawnTaskInput) => {
        calls.push(input);
        const outcome = results[input.objective] ?? 'spawned';
        if (outcome === 'spawned') {
          return Promise.resolve({
            status: 'spawned' as const,
            taskId: `task-${calls.length}`,
            sessionId: 'sess-1',
            provider: input.preferProvider ?? 'codex',
            reason: 'routed',
          });
        }
        if (outcome === 'parked') {
          return Promise.resolve({
            status: 'parked' as const,
            resumeAt: null,
            reason: 'quota exhausted',
          });
        }
        return Promise.resolve({ status: 'error' as const, error: 'spawn failed' });
      },
    },
  };
}

describe('IdeaService', () => {
  it('compiles a ledger into a persisted draft Brief', () => {
    const { service, briefs, ledger } = newService();
    const idea = service.createIdea('fleet failover', 'raw monologue notes');
    service.appendToIdea(idea.id, 'Research', 'codex quota resets hourly');

    const brief = service.compileBrief(idea.id, PLAN);

    expect(brief.status).toBe('draft');
    expect(brief.spec).toContain('raw monologue notes');
    expect(brief.spec).toContain('codex quota resets hourly');
    expect(brief.plan).toEqual(PLAN);
    expect(briefs.getById(brief.id)).not.toBeNull();
    expect(ledger.get(idea.id)!.status).toBe('compiled');
  });

  it('confirmation journals the gate decision, then dispatches every task', async () => {
    const { dispatcher, calls } = recordingDispatcher();
    const { service, briefs } = newService({ dispatcher });
    const idea = service.createIdea('x');
    const brief = service.compileBrief(idea.id, PLAN);

    const { brief: confirmed, results } = await service.confirmBrief(brief.id, 'vlad');

    expect(confirmed.status).toBe('dispatched');
    expect(confirmed.confirmedBy).toBe('vlad');
    expect(confirmed.confirmedAt).toBe(NOW);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.preferProvider).toBe('codex');
    expect(results.map((r) => r.status)).toEqual(['spawned', 'spawned']);
    // The durable row carries the journaled decision (DEC-012).
    const row = briefs.getById(brief.id)!;
    expect(row.status).toBe('dispatched');
    expect(row.confirmedBy).toBe('vlad');
  });

  it('the gate is single-shot — a confirmed brief cannot re-dispatch', async () => {
    const { dispatcher, calls } = recordingDispatcher();
    const { service } = newService({ dispatcher });
    const idea = service.createIdea('x');
    const brief = service.compileBrief(idea.id, PLAN);
    await service.confirmBrief(brief.id, 'vlad');

    await expect(service.confirmBrief(brief.id, 'vlad')).rejects.toThrow('single-shot');
    expect(calls).toHaveLength(2); // no second dispatch
  });

  it('refuses to confirm without a dispatcher — never silently delegates', async () => {
    const { service, briefs } = newService(); // no dispatcher wired
    const idea = service.createIdea('x');
    const brief = service.compileBrief(idea.id, PLAN);

    await expect(service.confirmBrief(brief.id, 'vlad')).rejects.toThrow('no dispatcher');
    expect(briefs.getById(brief.id)!.status).toBe('draft');
  });

  it('records parked and failed spawns as dispatch results', async () => {
    const { dispatcher } = recordingDispatcher({
      'build the scheduler': 'parked',
      'prove it works — tests + verification gate': 'error',
    });
    const { service } = newService({ dispatcher });
    const idea = service.createIdea('x');
    const brief = service.compileBrief(idea.id, PLAN);

    const { results } = await service.confirmBrief(brief.id, 'vlad');
    expect(results[0]!.status).toBe('parked');
    expect(results[0]!.reason).toBe('quota exhausted');
    expect(results[1]!.status).toBe('error');
    expect(results[1]!.reason).toBe('spawn failed');
  });
});

/* ================================================================== *
 * Command surface end to end
 * ================================================================== */

function commandFixture(dispatcher?: BriefDispatcherPort): { api: CommandApi; ideasDir: string } {
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
  const agent = buildAgent({ name: 'a', provider: 'codex', fidelityTier: 'B' });
  raw
    .prepare(
      'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(agent.id, agent.name, agent.provider, agent.fidelityTier, '{}', agent.createdAt);

  const taskRepo = new TaskRepository(raw);
  const eventRepo = new EventRepository(raw);
  const approvalRepo = new ApprovalRepository(raw);
  const sessionRepo = new SessionRepository(raw);
  const briefs = new BriefRepository(raw);
  const worktreePort: WorktreePort = {
    createWorktree: () => '/wt',
    detectDirty: () => false,
    worktreeStatus: () => ({ clean: true, dirty: false }),
    pruneWorktree: () => undefined,
    listWorktrees: () => [],
    worktreePathFor: () => '/wt',
  };
  const ideas = new IdeaService({
    ledger: new FsIdeaLedger(tmpDir),
    briefs,
    now: () => new Date(NOW),
    generateId: (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`,
    ...(dispatcher !== undefined ? { dispatcher } : {}),
  });
  const deps: CommandApiDeps = {
    eventBus: new EventBus(),
    taskStateMachine: new TaskStateMachine(taskRepo, eventRepo),
    attentionInbox: new AttentionInbox(),
    metricsCollector: new MetricsCollector(),
    worktreeManager: worktreePort,
    eventRepository: eventRepo,
    taskStore: {
      getById: (id: string): Task | null => taskRepo.getById(id),
      listAll: (): Task[] => [],
      update: (): void => undefined,
    },
    approvalStore: approvalRepo,
    sessionStore: sessionRepo,
    ideas,
  };
  return { api: new CommandApi(deps), ideasDir: tmpDir };
}

describe('idea/brief commands', () => {
  it('idea-create → idea-list round-trips through the command API', async () => {
    const { api } = commandFixture();
    const created = (await api.execute({
      kind: 'idea-create',
      title: 'one continuous workforce',
      body: 'notes',
    })) as IdeaResponse;
    expect(created.ok).toBe(true);
    expect(created.idea!.status).toBe('open');

    const listed = (await api.execute({ kind: 'idea-list' })) as IdeaListResponse;
    expect(listed.ideas).toHaveLength(1);
    expect(listed.ideas[0]!.title).toBe('one continuous workforce');
  });

  it('idea-append and idea-promote mutate the ledger file', async () => {
    const { api, ideasDir } = commandFixture();
    const created = (await api.execute({
      kind: 'idea-create',
      title: 'x',
    })) as IdeaResponse;
    const id = created.idea!.id;

    const appended = (await api.execute({
      kind: 'idea-append',
      ideaId: id,
      heading: 'Questions',
      body: '- which provider first?',
    })) as IdeaResponse;
    expect(appended.ok).toBe(true);

    const promoted = (await api.execute({
      kind: 'idea-promote',
      ideaId: id,
      projectId: 'proj-1',
      targetDir: path.join(ideasDir, 'proj-1'),
    })) as IdeaResponse;
    expect(promoted.ok).toBe(true);
    expect(promoted.idea!.status).toBe('promoted');
    expect(promoted.idea!.projectId).toBe('proj-1');
  });

  it('brief-compile → brief-confirm dispatches through the gate', async () => {
    const { dispatcher, calls } = recordingDispatcher();
    const { api } = commandFixture(dispatcher);
    const created = (await api.execute({
      kind: 'idea-create',
      title: 'x',
      body: 'the spec',
    })) as IdeaResponse;

    const compiled = (await api.execute({
      kind: 'brief-compile',
      ideaId: created.idea!.id,
      plan: PLAN,
    })) as BriefResponse;
    expect(compiled.ok).toBe(true);
    expect(compiled.brief!.status).toBe('draft');

    const confirmed = (await api.execute({
      kind: 'brief-confirm',
      briefId: compiled.brief!.id,
      confirmedBy: 'vlad',
    })) as BriefConfirmResponse;
    expect(confirmed.ok).toBe(true);
    expect(confirmed.brief!.status).toBe('dispatched');
    expect(confirmed.results).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('idea commands fail cleanly when the service is not wired', async () => {
    const db = new StorageDatabase({ path: ':memory:' });
    db.open();
    const api = new CommandApi({
      eventBus: new EventBus(),
      taskStateMachine: new TaskStateMachine(
        new TaskRepository(db.connection),
        new EventRepository(db.connection),
      ),
      attentionInbox: new AttentionInbox(),
      metricsCollector: new MetricsCollector(),
      worktreeManager: {
        createWorktree: () => '/wt',
        detectDirty: () => false,
        worktreeStatus: () => ({ clean: true, dirty: false }),
        pruneWorktree: () => undefined,
        listWorktrees: () => [],
        worktreePathFor: () => '/wt',
      },
      eventRepository: new EventRepository(db.connection),
      taskStore: { getById: () => null, listAll: () => [], update: () => undefined },
      approvalStore: new ApprovalRepository(db.connection),
      sessionStore: new SessionRepository(db.connection),
    });
    const res = (await api.execute({ kind: 'idea-list' })) as IdeaListResponse;
    expect(res.ok).toBe(false);
    const create = (await api.execute({ kind: 'idea-create', title: 'x' })) as IdeaResponse;
    expect(create.ok).toBe(false);
    expect(create.error).toContain('not wired');
  });
});
