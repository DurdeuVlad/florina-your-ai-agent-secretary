/**
 * Preference surface remainder (issue #65): NL soft layer, project-scoped
 * rules, `query-preferences` command, `florina preferences` CLI, voice
 * `list_preferences`, need-to-know manager prompt injection, and the
 * User-scope capsule (amends DEC-020).
 */
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  isProfileEmpty,
  preferencePromptText,
  type PreferenceProfile,
} from '../src/core/application/ports/outbound/preference-profile.js';
import {
  PreferenceProfileStore,
  PreferenceProfileError,
} from '../src/adapters/outbound/preferences/json-preference-profile.js';
import {
  CommandApi,
  type CommandApiDeps,
} from '../src/core/application/use-cases/tasks/command-api.js';
import { ManagerToolService } from '../src/core/application/use-cases/managers/manager-tools.js';
import { CapacityRouter } from '../src/core/application/use-cases/routing/capacity-router.js';
import { QuotaLedger } from '../src/core/application/use-cases/routing/quota-ledger.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { MetricsCollector } from '../src/core/application/use-cases/metrics.js';
import { TaskStateMachine } from '../src/core/application/use-cases/tasks/task-lifecycle.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  ApprovalRepository,
  SessionRepository,
  ContextCapsuleRepository,
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import { buildProject, buildUserCapsule } from '../src/core/domain/index.js';
import {
  mapToolCallToCommand,
  DEFAULT_VOICE_INSTRUCTIONS,
  SETUP_INTERVIEW_INSTRUCTIONS,
} from '../src/adapters/inbound/voice/voice-tools.js';
import type { Command } from '../src/core/application/use-cases/tasks/command-api.js';

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function tempPath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'prefs-surface-'));
  return join(dir, 'preferences.json');
}

/* ================================================================== *
 * preferencePromptText — need-to-know rendering
 * ================================================================== */

describe('preferencePromptText', () => {
  const profile: PreferenceProfile = {
    rules: [
      { provider: 'codex', note: 'main worker, long-running' },
      { provider: 'claude-code', model: 'sonnet', workTypes: ['reading'] },
      { provider: 'devin', projectId: 'proj-b', note: 'background project only' },
    ],
    denied: [
      { provider: 'claude-code', model: 'opus', note: 'never Opus' },
      { provider: 'gemini', projectId: 'proj-b' },
    ],
  };

  it('renders global rules and denies', () => {
    const text = preferencePromptText(profile);
    expect(text).toContain('Prefer codex — main worker, long-running');
    expect(text).toContain('Prefer claude-code/sonnet for reading');
    expect(text).toContain('Never claude-code/opus — never Opus');
  });

  it('includes only the caller project’s scoped rules (DEC-003 need-to-know)', () => {
    const forB = preferencePromptText(profile, 'proj-b');
    expect(forB).toContain('Prefer devin (project rule) — background project only');
    expect(forB).toContain('Never gemini (project rule)');

    const forA = preferencePromptText(profile, 'proj-a');
    expect(forA).not.toContain('devin');
    expect(forA).not.toContain('gemini');
    expect(forA).toContain('Prefer codex'); // global still visible
  });

  it('returns null when nothing applies', () => {
    expect(preferencePromptText({ rules: [], denied: [] })).toBeNull();
    const scopedOnly: PreferenceProfile = {
      rules: [{ provider: 'x', projectId: 'other' }],
      denied: [],
    };
    expect(preferencePromptText(scopedOnly, 'mine')).toBeNull();
  });
});

/* ================================================================== *
 * Store: note/projectId round-trip + validation
 * ================================================================== */

describe('PreferenceProfileStore — soft layer fields', () => {
  it('round-trips note and projectId', async () => {
    const path = await tempPath();
    const store = await PreferenceProfileStore.load(path);
    store.addRule({ provider: 'codex', note: 'heavy lifting' });
    store.addDeny({ provider: 'claude-code', model: 'opus', projectId: 'p1' });
    await store.save();

    const reloaded = await PreferenceProfileStore.load(path);
    expect(reloaded.toProfile().rules[0]?.note).toBe('heavy lifting');
    expect(reloaded.toProfile().denied[0]?.projectId).toBe('p1');
  });

  it('rejects malformed projectId/note fields', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ rules: [{ provider: 'x', note: 42 }], denied: [] }));
    await expect(PreferenceProfileStore.load(path)).rejects.toBeInstanceOf(PreferenceProfileError);
  });
});

/* ================================================================== *
 * Command API: query-preferences + update-preference soft fields
 * ================================================================== */

function apiFixture(preferences?: PreferenceProfileStore): CommandApi {
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
  const taskRepo = new TaskRepository(raw);
  const deps: CommandApiDeps = {
    eventBus: new EventBus(),
    taskStateMachine: new TaskStateMachine(taskRepo, new EventRepository(raw)),
    attentionInbox: new AttentionInbox(),
    metricsCollector: new MetricsCollector(),
    worktreeManager: { pruneWorktree: vi.fn(), detectDirty: vi.fn(() => false) } as never,
    eventRepository: new EventRepository(raw),
    taskStore: taskRepo,
    approvalStore: new ApprovalRepository(raw),
    sessionStore: new SessionRepository(raw),
    ...(preferences !== undefined ? { preferences } : {}),
  };
  return new CommandApi(deps);
}

describe('preference commands', () => {
  it('update-preference persists note + projectId; query-preferences reads them', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    const api = apiFixture(store);

    const add = await api.execute({
      kind: 'update-preference',
      action: 'add-rule',
      provider: 'claude-code',
      model: 'sonnet',
      note: 'default Sonnet',
      projectId: 'proj-x',
    });
    expect(add.ok).toBe(true);

    const onDisk = JSON.parse(await readFile(store.filePath, 'utf8')) as {
      rules: { projectId?: string; note?: string }[];
    };
    expect(onDisk.rules[0]?.projectId).toBe('proj-x');
    expect(onDisk.rules[0]?.note).toBe('default Sonnet');

    const q = await api.execute({ kind: 'query-preferences', projectId: 'proj-x' });
    expect(q.ok).toBe(true);
    if (q.ok && 'promptText' in q) {
      expect(q.promptText).toContain('claude-code/sonnet');
    }
    if (q.ok && 'summary' in q) {
      expect(q.summary).toContain('project proj-x');
    }

    // A different project must not see proj-x's rule.
    const other = await api.execute({ kind: 'query-preferences', projectId: 'other' });
    if (other.ok && 'summary' in other) {
      expect(other.summary).toBe('no preferences recorded');
    }
  });

  it('query-preferences errors cleanly when no profile is wired', async () => {
    const api = apiFixture();
    const res = await api.execute({ kind: 'query-preferences' });
    expect(res.ok).toBe(false);
  });

  it('query-preferences returns the structured profile, not just a summary', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    store.addRule({ provider: 'codex' });
    store.addRule({ provider: 'devin', projectId: 'p2' });
    store.addDeny({ provider: 'gemini', projectId: 'p1' });
    store.addDeny({ provider: 'agy', projectId: 'p2' });
    const api = apiFixture(store);

    const res = await api.execute({ kind: 'query-preferences', projectId: 'p1' });
    expect(res.ok).toBe(true);
    if (res.ok && 'profile' in res) {
      expect(res.profile).toEqual({
        rules: [{ provider: 'codex' }],
        denied: [{ provider: 'gemini', projectId: 'p1' }],
      });
    } else {
      expect.unreachable('query-preferences must return the profile');
    }

    const all = await api.execute({ kind: 'query-preferences' });
    if (all.ok && 'profile' in all) {
      expect(all.profile).toEqual(store.toProfile());
    } else {
      expect.unreachable('unscoped query-preferences must return the full profile');
    }
    expect(isProfileEmpty(store.toProfile())).toBe(false);
    expect(isProfileEmpty({ rules: [], denied: [] })).toBe(true);
  });

  it('update-preference remove-deny honours projectId scope', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    const api = apiFixture(store);

    await api.execute({
      kind: 'update-preference',
      action: 'deny',
      provider: 'gemini',
      projectId: 'p1',
    });
    // A global deny must coexist with the scoped one (scope-aware dedup).
    const globalAdd = await api.execute({
      kind: 'update-preference',
      action: 'deny',
      provider: 'gemini',
    });
    expect(globalAdd.ok).toBe(true);
    expect(store.toProfile().denied).toHaveLength(2);

    const removed = await api.execute({
      kind: 'update-preference',
      action: 'remove-deny',
      provider: 'gemini',
      projectId: 'p1',
    });
    expect(removed.ok).toBe(true);
    expect(store.toProfile().denied).toEqual([{ provider: 'gemini' }]);
  });
});

/* ================================================================== *
 * Voice: list_preferences + remember_preference note passthrough
 * ================================================================== */

describe('voice preference tools', () => {
  it('list_preferences maps to query-preferences', () => {
    const cmd = mapToolCallToCommand('list_preferences', { projectId: 'p9' });
    expect(cmd).toEqual({ kind: 'query-preferences', projectId: 'p9' });
  });

  it('list_preferences works without args', () => {
    const cmd = mapToolCallToCommand('list_preferences', {});
    expect(cmd).toEqual({ kind: 'query-preferences', projectId: undefined });
  });

  it('voice instructions cover preference memory; setup interview block exists', () => {
    expect(DEFAULT_VOICE_INSTRUCTIONS).toContain('remember_preference');
    expect(DEFAULT_VOICE_INSTRUCTIONS).toContain('list_preferences');
    expect(SETUP_INTERVIEW_INSTRUCTIONS).toContain('setup interview');
    expect(SETUP_INTERVIEW_INSTRUCTIONS).toContain('remember_preference');
  });

  it('remember_preference carries the user’s note verbatim', () => {
    const cmd = mapToolCallToCommand('remember_preference', {
      action: 'deny',
      provider: 'claude-code',
      model: 'opus',
      note: 'never Opus, too slow for me',
    });
    expect(cmd).toMatchObject({
      kind: 'update-preference',
      action: 'deny',
      provider: 'claude-code',
      model: 'opus',
      note: 'never Opus, too slow for me',
    });
  });

  it('remember_preference passes a named project scope through', () => {
    const cmd = mapToolCallToCommand('remember_preference', {
      action: 'add-rule',
      provider: 'devin',
      projectId: 'p7',
    });
    expect(cmd).toMatchObject({
      kind: 'update-preference',
      action: 'add-rule',
      provider: 'devin',
      projectId: 'p7',
    });
  });
});

/* ================================================================== *
 * CapacityRouter — projectId scope enforcement (hard layer)
 * ================================================================== */

describe('CapacityRouter project scoping', () => {
  function scopedRouter(profile: PreferenceProfile): CapacityRouter {
    return new CapacityRouter({ ledger: new QuotaLedger(), profile });
  }

  it('scoped rules are candidates only for their own project', () => {
    const router = scopedRouter({
      rules: [{ provider: 'devin', projectId: 'proj-b' }, { provider: 'codex' }],
      denied: [],
    });
    expect(router.route({ projectId: 'proj-b' })).toMatchObject({
      kind: 'routed',
      provider: 'devin',
    });
    // proj-a must not see proj-b's rule — falls through to the global rule.
    expect(router.route({ projectId: 'proj-a' })).toMatchObject({
      kind: 'routed',
      provider: 'codex',
    });
  });

  it('a request without projectId sees only global rules', () => {
    const router = scopedRouter({
      rules: [{ provider: 'devin', projectId: 'proj-b' }],
      denied: [],
    });
    expect(router.route({}).kind).toBe('parked');
  });

  it('scoped denies apply only to their own project — not globally', () => {
    const router = scopedRouter({
      rules: [{ provider: 'gemini' }],
      denied: [{ provider: 'gemini', projectId: 'proj-b' }],
    });
    expect(router.route({ projectId: 'proj-b' }).kind).toBe('parked');
    expect(router.route({ projectId: 'proj-a' })).toMatchObject({
      kind: 'routed',
      provider: 'gemini',
    });
  });

  it('global denies still apply to every project', () => {
    const router = scopedRouter({
      rules: [{ provider: 'gemini' }],
      denied: [{ provider: 'gemini' }],
    });
    expect(router.route({ projectId: 'proj-a' }).kind).toBe('parked');
    expect(router.route({ projectId: 'proj-b' }).kind).toBe('parked');
  });
});

/* ================================================================== *
 * Store: scope-aware dedup and removal
 * ================================================================== */

describe('PreferenceProfileStore — scope-aware dedup/removal', () => {
  it('a global deny is not deduped away by an existing scoped deny', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    store.addDeny({ provider: 'gemini', projectId: 'proj-b' });
    store.addDeny({ provider: 'gemini' });
    const denied = store.toProfile().denied;
    expect(denied).toHaveLength(2);
    expect(denied.map((d) => d.projectId)).toEqual(['proj-b', undefined]);
  });

  it('removeDeny/removeRule with projectId target the scoped entry', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    store.addRule({ provider: 'codex' });
    store.addRule({ provider: 'codex', projectId: 'p1' });
    store.addDeny({ provider: 'gemini', projectId: 'p1' });
    store.addDeny({ provider: 'gemini' });

    expect(store.removeRule('codex', undefined, 'p1')).toBe(true);
    expect(store.toProfile().rules).toEqual([{ provider: 'codex' }]);

    expect(store.removeDeny('gemini', undefined, 'p1')).toBe(true);
    expect(store.toProfile().denied).toEqual([{ provider: 'gemini' }]);
  });

  it('remove without projectId targets the global entry only', async () => {
    const store = await PreferenceProfileStore.load(await tempPath());
    store.addRule({ provider: 'codex', projectId: 'p1' });
    store.addRule({ provider: 'codex' });
    store.addDeny({ provider: 'gemini', projectId: 'p1' });
    store.addDeny({ provider: 'gemini' });

    expect(store.removeRule('codex')).toBe(true);
    expect(store.toProfile().rules).toEqual([{ provider: 'codex', projectId: 'p1' }]);

    expect(store.removeDeny('gemini')).toBe(true);
    expect(store.toProfile().denied).toEqual([{ provider: 'gemini', projectId: 'p1' }]);
  });
});

/* ================================================================== *
 * Manager soft layer: spawnManagerTask injects need-to-know prefs
 * ================================================================== */

describe('manager prompt injection', () => {
  function managerFixture(profile: PreferenceProfile) {
    const sent: Command[] = [];
    const commandApi = {
      execute: vi.fn(async (cmd: Command) => {
        sent.push(cmd);
        return { ok: true, sessionId: 'sess-1' };
      }),
    };
    const prefs: Pick<PreferenceProfileStore, 'toProfile'> & {
      addRule(): void;
      addDeny(): void;
      removeRule(): boolean;
      removeDeny(): boolean;
      save(): Promise<void>;
    } = {
      toProfile: () => profile,
      addRule: () => {},
      addDeny: () => {},
      removeRule: () => false,
      removeDeny: () => false,
      save: () => Promise.resolve(),
    };
    const service = new ManagerToolService({
      commandApi,
      router: new CapacityRouter({
        ledger: new QuotaLedger(),
        profile: { rules: [{ provider: 'stub' }], denied: [] },
      }),
      taskStore: {
        insert: vi.fn(),
        update: vi.fn(),
        getById: vi.fn(() => null),
        listAll: vi.fn(() => []),
      } as never,
      worktreeManager: { createWorktree: () => '/wt' },
      repoPath: '/repo',
      projectId: 'proj-a',
      mcpUrl: 'http://127.0.0.1:9/mcp',
      preferences: prefs,
    });
    return { service, sent };
  }

  it('injects global + own-project preferences into the manager prompt', async () => {
    const { service, sent } = managerFixture({
      rules: [
        { provider: 'codex', note: 'main worker' },
        { provider: 'devin', projectId: 'proj-a', note: 'for this project' },
        { provider: 'gemini', projectId: 'proj-b', note: 'not visible' },
      ],
      denied: [{ provider: 'claude-code', model: 'opus' }],
    });
    const res = await service.spawnManagerTask({ objective: 'run alpha' });
    expect(res.status).toBe('spawned');
    const start = sent.find((c) => c.kind === 'start-task');
    expect(start).toBeDefined();
    if (start !== undefined && start.kind === 'start-task') {
      const prompt = start.sessionConfig.prompt ?? '';
      expect(prompt).toContain('run alpha');
      expect(prompt).toContain('Prefer codex — main worker');
      expect(prompt).toContain('Prefer devin (project rule)');
      expect(prompt).toContain('Never claude-code/opus');
      expect(prompt).not.toContain('gemini'); // other project's rule
    }
  });

  it('passes the bare objective when the profile is empty', async () => {
    const { service, sent } = managerFixture({ rules: [], denied: [] });
    await service.spawnManagerTask({ objective: 'run alpha' });
    const start = sent.find((c) => c.kind === 'start-task');
    if (start !== undefined && start.kind === 'start-task') {
      expect(start.sessionConfig.prompt).toBe('run alpha');
    }
  });
});

/* ================================================================== *
 * User-scope capsule (DEC-020 amendment) — SQLite round-trip
 * ================================================================== */

describe('User-scope capsule', () => {
  it('round-trips preferenceNotes through SQLite', () => {
    const db = new StorageDatabase({ path: ':memory:' });
    db.open();
    const repo = new ContextCapsuleRepository(db.connection);
    const capsule = buildUserCapsule({
      ownerId: 'user-1',
      content: { preferenceNotes: ['Codex for long-running work', 'never Opus'] },
    });
    repo.insert(capsule);
    const loaded = repo.getById(capsule.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.scope).toBe('user');
    if (loaded?.scope === 'user') {
      expect(loaded.content.preferenceNotes).toEqual(['Codex for long-running work', 'never Opus']);
    }
    db.close();
  });
});
