/**
 * Secrets take effect (issue #293): scoped vault secrets reach the two
 * real consumption surfaces — the agent process environment at dispatch
 * and the Secretary chat model's per-request credential — without a
 * daemon restart.
 *
 * Contract under test:
 * - SessionManager merges resolved injections into `sessionConfig.env`;
 *   vault values win on conflicts (they are the user's most recent
 *   explicit credential input).
 * - `start-task` threads `task.projectId` so project-scoped secrets only
 *   inject into their own project's runs.
 * - The chat connector resolves its API key per request — a stored key
 *   lands on the next call, no restart.
 * - Values reach the spawned process environment and nothing else —
 *   never journals, events, or responses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';

import { CommandApi } from '../src/daemon/command-api.js';
import type {
  Command,
  CommandApiDeps,
  SecretsSetResponse,
  StartTaskResponse,
  Response,
} from '../src/daemon/command-api.js';
import { SecretsVaultService } from '../src/core/application/use-cases/security/secrets-vault-service.js';
import type { VaultAuditEntry } from '../src/core/application/use-cases/security/secrets-vault-service.js';
import { EncryptedFileSecretsVault } from '../src/adapters/outbound/credentials/encrypted-file-secrets-vault.js';
import { SessionManager } from '../src/core/application/use-cases/tasks/session-manager.js';
import { LiteLLMConnector } from '../src/adapters/outbound/model/litellm-connector.js';
import { AgyAdapter } from '../src/adapters/outbound/agents/agy-adapter.js';
import { spawnCli } from '../src/adapters/outbound/agents/spawn-cli.js';
import type {
  AgentRuntimePort,
  SessionConfig,
  StartRunResult,
} from '../src/core/application/ports/outbound/agent-runtime.js';
import { EventBus } from '../src/daemon/event-stream.js';
import { AttentionInbox } from '../src/attention/attention-inbox.js';
import { MetricsCollector } from '../src/daemon/metrics.js';
import { TaskStateMachine } from '../src/daemon/task-lifecycle.js';
import {
  TaskRepository,
  EventRepository,
  SessionRepository,
  AgentRepository,
  StorageDatabase,
} from '../src/storage/index.js';
import { buildProject, buildTask } from '../src/domain/index.js';
import type { Event } from '../src/domain/types.js';
import { FlorinaDaemon } from '../src/daemon/index.js';

/* ================================================================== *
 * Fixtures
 * ================================================================== */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'florina-injection-'));
}

/** Adapter stub that records the SessionConfig handed to startRun. */
class CapturingAdapter implements AgentRuntimePort {
  readonly id = 'capture';
  readonly fidelityTier = 'B' as const;
  readonly runs: SessionConfig[] = [];

  async connect(): Promise<void> {}
  async startRun(_taskId: string, config: SessionConfig): Promise<StartRunResult> {
    this.runs.push(config);
    return { sessionId: config.sessionId, started: true };
  }
  streamEvents(): AsyncIterable<Event> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Event>>(() => {}),
      }),
    };
  }
  async cancel(): Promise<void> {}
  async disconnect(): Promise<void> {}
}

const BASE_CONFIG: SessionConfig = {
  taskId: 'task-1',
  sessionId: 'sess-1',
  agentId: 'claude-code',
  workingDir: '/repo/wt',
  objective: 'do the thing',
};

/* ================================================================== *
 * SessionManager resolver seam
 * ================================================================== */

describe('SessionManager secret env resolution (issue #293)', () => {
  it('merges resolved injections into the config the adapter spawns with', async () => {
    const adapter = new CapturingAdapter();
    const manager = new SessionManager(new EventBus(), {
      secretEnvResolver: async () => ({ OPENAI_API_KEY: 'sk-vault' }),
    });
    const res = await manager.startSession('task-1', 'claude-code', adapter, BASE_CONFIG);
    expect(res.ok).toBe(true);
    expect(adapter.runs[0]!.env).toEqual({ OPENAI_API_KEY: 'sk-vault' });
  });

  it('resolved injections win over caller-supplied env on conflicts', async () => {
    const adapter = new CapturingAdapter();
    const manager = new SessionManager(new EventBus(), {
      secretEnvResolver: async () => ({ SHARED_KEY: 'vault-value' }),
    });
    await manager.startSession('task-1', 'claude-code', adapter, {
      ...BASE_CONFIG,
      env: { SHARED_KEY: 'caller-value', OTHER: 'kept' },
    });
    expect(adapter.runs[0]!.env).toEqual({ SHARED_KEY: 'vault-value', OTHER: 'kept' });
  });

  it('scopes the resolver call by task/session/provider/project', async () => {
    const adapter = new CapturingAdapter();
    const seen: unknown[] = [];
    const manager = new SessionManager(new EventBus(), {
      secretEnvResolver: async (ctx) => {
        seen.push(ctx);
        return {};
      },
    });
    await manager.startSession('task-1', 'claude-code', adapter, {
      ...BASE_CONFIG,
      projectId: 'proj-9',
    });
    expect(seen).toEqual([
      { taskId: 'task-1', sessionId: 'sess-1', provider: 'claude-code', projectId: 'proj-9' },
    ]);
  });

  it('a resolver failure never blocks dispatch — session starts with caller env', async () => {
    const adapter = new CapturingAdapter();
    const manager = new SessionManager(new EventBus(), {
      secretEnvResolver: async () => {
        throw new Error('vault locked');
      },
    });
    const res = await manager.startSession('task-1', 'claude-code', adapter, {
      ...BASE_CONFIG,
      env: { CALLER: 'still-here' },
    });
    expect(res.ok).toBe(true);
    expect(adapter.runs[0]!.env).toEqual({ CALLER: 'still-here' });
  });

  it('no resolver wired → caller config passes through untouched', async () => {
    const adapter = new CapturingAdapter();
    const manager = new SessionManager(new EventBus());
    const res = await manager.startSession('task-1', 'claude-code', adapter, {
      ...BASE_CONFIG,
      env: { CALLER: 'only' },
    });
    expect(res.ok).toBe(true);
    expect(adapter.runs[0]!.env).toEqual({ CALLER: 'only' });
  });
});

/* ================================================================== *
 * Full dispatch path: CommandApi + real SessionManager + real vault
 * ================================================================== */

describe('start-task secret injection (issue #293)', () => {
  function makeDispatch(opts: { dir: string }) {
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
    const eventRepo = new EventRepository(raw);
    const sessionRepo = new SessionRepository(raw);
    const agentRepo = new AgentRepository(raw);
    const eventBus = new EventBus();
    const vault = new EncryptedFileSecretsVault({
      filePath: path.join(opts.dir, 'secrets.enc'),
      masterKey: 'test-master-key',
    });
    const auditEntries: VaultAuditEntry[] = [];
    const service = new SecretsVaultService({
      vault,
      eventJournal: eventRepo,
      eventBus,
      auditSink: (e) => auditEntries.push(e),
    });
    const sessionManager = new SessionManager(eventBus, {
      secretEnvResolver: (ctx) =>
        service.resolveInjections({
          taskId: ctx.taskId,
          sessionId: ctx.sessionId,
          provider: ctx.provider,
          projectId: ctx.projectId,
        }),
    });
    const adapter = new CapturingAdapter();
    const api = new CommandApi({
      eventBus,
      taskStateMachine: new TaskStateMachine(taskRepo, eventRepo),
      attentionInbox: new AttentionInbox(),
      metricsCollector: new MetricsCollector(),
      worktreeManager: {
        createWorktree: () => ({ path: '/tmp/wt', branch: 'b', baseCommit: 'c' }),
        pruneWorktree: () => {},
        detectDirty: () => false,
        worktreeStatus: () => ({ clean: true, dirty: false, branch: 'b', baseCommit: 'c' }),
      } as unknown as CommandApiDeps['worktreeManager'],
      eventRepository: eventRepo,
      taskStore: {
        getById: (id: string) => taskRepo.getById(id),
        update: (t: Parameters<TaskRepository['update']>[0]) => taskRepo.update(t),
        listAll: () => [],
      } as unknown as CommandApiDeps['taskStore'],
      approvalStore: {} as unknown as CommandApiDeps['approvalStore'],
      sessionStore: sessionRepo as unknown as CommandApiDeps['sessionStore'],
      agentStore: agentRepo as unknown as CommandApiDeps['agentStore'],
      secrets: service,
      sessionManager,
      adapterRegistry: { create: () => adapter },
    });
    return { api, adapter, service, auditEntries, eventRepo, taskRepo, projectId: project.id };
  }

  function insertTask(fx: ReturnType<typeof makeDispatch>) {
    const task = buildTask({ projectId: fx.projectId, objective: 'Test objective' });
    fx.taskRepo.insert(task);
    return task;
  }

  it('a global secret lands in the dispatched session env — never in events', async () => {
    const fx = makeDispatch({ dir: tmpDir() });
    const task = insertTask(fx);

    const set = (await fx.api.execute({
      kind: 'secrets-set',
      name: 'openai-key',
      value: 'sk-injected-xyz',
      scope: { envVarName: 'OPENAI_API_KEY' },
    })) as SecretsSetResponse;
    expect(set.ok).toBe(true);

    const res = (await fx.api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId: 'claude-code',
      sessionConfig: { workingDir: '/repo/wt' },
    })) as StartTaskResponse;
    expect(res.ok).toBe(true);

    expect(fx.adapter.runs[0]!.env!['OPENAI_API_KEY']).toBe('sk-injected-xyz');
    expect(fx.adapter.runs[0]!.projectId).toBe(fx.projectId);

    // Injection provenance lands in the vault-local audit ledger with its
    // dispatch context (the session row does not exist yet at injection
    // time, so the event journal's session FK cannot hold it). Metadata
    // only — the value never appears.
    const injected = fx.auditEntries.filter((e) => e.action === 'secret_resolved');
    expect(injected.map((e) => e.name)).toEqual(['openai-key']);
    expect(injected[0]!.context).toMatchObject({
      taskId: task.id,
      provider: 'claude-code',
      projectId: fx.projectId,
    });
    expect(JSON.stringify(fx.auditEntries)).not.toContain('sk-injected-xyz');
    expect(JSON.stringify(fx.eventRepo.listByTask(task.id))).not.toContain('sk-injected-xyz');
  });

  it('project scope gates injection to the matching project only', async () => {
    const fx = makeDispatch({ dir: tmpDir() });
    const task = insertTask(fx);
    await fx.api.execute({
      kind: 'secrets-set',
      name: 'other-project-key',
      value: 'sk-other',
      scope: { envVarName: 'OTHER_KEY', projectId: 'proj-not-this-one' },
    });
    const res = (await fx.api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId: 'claude-code',
      sessionConfig: { workingDir: '/repo/wt' },
    })) as StartTaskResponse;
    expect(res.ok).toBe(true);
    expect(fx.adapter.runs[0]!.env).toBeUndefined();
  });

  it('provider scope gates injection to the matching adapter only', async () => {
    const fx = makeDispatch({ dir: tmpDir() });
    const task = insertTask(fx);
    await fx.api.execute({
      kind: 'secrets-set',
      name: 'gemini-key',
      value: 'gm-wrong-provider',
      scope: { envVarName: 'GEMINI_API_KEY', provider: 'gemini' },
    });
    const res = (await fx.api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId: 'claude-code',
      sessionConfig: { workingDir: '/repo/wt' },
    })) as StartTaskResponse;
    expect(res.ok).toBe(true);
    expect(fx.adapter.runs[0]!.env).toBeUndefined();
  });

  it('expired secrets are never injected', async () => {
    const fx = makeDispatch({ dir: tmpDir() });
    const task = insertTask(fx);
    await fx.api.execute({
      kind: 'secrets-set',
      name: 'dead-key',
      value: 'sk-expired',
      scope: { envVarName: 'DEAD_KEY' },
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    const res = (await fx.api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId: 'claude-code',
      sessionConfig: { workingDir: '/repo/wt' },
    })) as StartTaskResponse;
    expect(res.ok).toBe(true);
    expect(fx.adapter.runs[0]!.env?.['DEAD_KEY']).toBeUndefined();
  });

  it('a denied injection (denylisted derived name) is audited, not silent', async () => {
    const fx = makeDispatch({ dir: tmpDir() });
    const task = insertTask(fx);
    // 'path' derives PATH — passes name validation, denied at injection.
    await fx.api.execute({ kind: 'secrets-set', name: 'path', value: '/evil/bin' });
    const res = (await fx.api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId: 'claude-code',
      sessionConfig: { workingDir: '/repo/wt' },
    })) as StartTaskResponse;
    expect(res.ok).toBe(true);
    expect(fx.adapter.runs[0]!.env?.['PATH']).toBeUndefined();
    const denied = fx.auditEntries.filter((e) => e.action === 'secret_denied');
    expect(denied.map((e) => e.name)).toEqual(['path']);
    expect(denied[0]!.targetEnvVar).toBe('PATH');
    expect(denied[0]!.context).toMatchObject({ taskId: task.id, provider: 'claude-code' });
    expect(JSON.stringify(fx.auditEntries)).not.toContain('/evil/bin');
  });
});

/* ================================================================== *
 * resolveProviderCredential — chat-model fallback
 * ================================================================== */

describe('resolveProviderCredential (issue #293)', () => {
  function makeService(dir: string) {
    const auditEntries: VaultAuditEntry[] = [];
    const service = new SecretsVaultService({
      vault: new EncryptedFileSecretsVault({
        filePath: path.join(dir, 'secrets.enc'),
        masterKey: 'test-master-key',
      }),
      auditSink: (e) => auditEntries.push(e),
    });
    return { service, auditEntries };
  }

  it('resolves a secret by envVarName and audits the read', async () => {
    const { service, auditEntries } = makeService(tmpDir());
    await service.captureSecret({
      name: 'openai-key',
      value: 'sk-live-value',
      scope: { envVarName: 'OPENAI_API_KEY' },
    });
    const v = await service.resolveProviderCredential({ envVarNames: ['OPENAI_API_KEY'] });
    expect(v).toBe('sk-live-value');
    const resolved = auditEntries.find((e) => e.action === 'secret_resolved');
    expect(resolved?.name).toBe('openai-key');
    expect(JSON.stringify(auditEntries)).not.toContain('sk-live-value');
  });

  it('resolves by provider scope and returns null on no match', async () => {
    const { service } = makeService(tmpDir());
    await service.captureSecret({
      name: 'litellm-cred',
      value: 'lk-1',
      scope: { provider: 'litellm' },
    });
    expect(await service.resolveProviderCredential({ providers: ['litellm'] })).toBe('lk-1');
    expect(await service.resolveProviderCredential({ providers: ['anthropic'] })).toBeNull();
    expect(await service.resolveProviderCredential({})).toBeNull();
  });

  it('a provider-scoped secret never resolves for a consumer it was not granted to', async () => {
    // Regression: envVarName matching must not bypass a provider grant —
    // `{provider: 'claude-code', envVarName: 'OPENAI_API_KEY'}` is scoped
    // to claude-code runs only, so the chat-model consumer cannot take it.
    const { service } = makeService(tmpDir());
    await service.captureSecret({
      name: 'cc-openai',
      value: 'sk-cc-only',
      scope: { provider: 'claude-code', envVarName: 'OPENAI_API_KEY' },
    });
    const chatResolver = {
      envVarNames: ['FLORINA_LITELLM_KEY', 'OPENAI_API_KEY'],
      providers: ['litellm', 'openai'],
    };
    expect(await service.resolveProviderCredential(chatResolver)).toBeNull();
    // …but a consumer it was granted to resolves it fine.
    expect(
      await service.resolveProviderCredential({
        envVarNames: ['OPENAI_API_KEY'],
        providers: ['claude-code'],
      }),
    ).toBe('sk-cc-only');
  });

  it('matches the derived env var name, consistent with injection', async () => {
    const { service } = makeService(tmpDir());
    await service.captureSecret({
      name: 'openai-api-key',
      value: 'sk-derived',
      scope: {},
    });
    expect(await service.resolveProviderCredential({ envVarNames: ['OPENAI_API_KEY'] })).toBe(
      'sk-derived',
    );
  });

  it('project-scoped secrets never feed a global consumer', async () => {
    const { service } = makeService(tmpDir());
    await service.captureSecret({
      name: 'proj-key',
      value: 'sk-proj',
      scope: { envVarName: 'OPENAI_API_KEY', projectId: 'proj-1' },
    });
    expect(await service.resolveProviderCredential({ envVarNames: ['OPENAI_API_KEY'] })).toBeNull();
  });

  it('the most recently updated matching secret wins', async () => {
    const { service } = makeService(tmpDir());
    await service.captureSecret({
      name: 'old-key',
      value: 'sk-old',
      scope: { envVarName: 'OPENAI_API_KEY' },
    });
    await new Promise((r) => setTimeout(r, 5));
    await service.captureSecret({
      name: 'new-key',
      value: 'sk-new',
      scope: { envVarName: 'OPENAI_API_KEY' },
    });
    expect(await service.resolveProviderCredential({ envVarNames: ['OPENAI_API_KEY'] })).toBe(
      'sk-new',
    );
  });

  it('an expired match falls through to the next candidate', async () => {
    const dir = tmpDir();
    const { service } = makeService(dir);
    const vault = new EncryptedFileSecretsVault({
      filePath: path.join(dir, 'secrets.enc'),
      masterKey: 'test-master-key',
    });
    // Store an expired secret directly on the vault (capture validates),
    // then a live one through the service.
    await vault.storeSecret(
      'expired-key',
      'sk-dead',
      { envVarName: 'OPENAI_API_KEY' },
      {
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    );
    await service.captureSecret({
      name: 'live-key',
      value: 'sk-live',
      scope: { envVarName: 'OPENAI_API_KEY' },
    });
    expect(await service.resolveProviderCredential({ envVarNames: ['OPENAI_API_KEY'] })).toBe(
      'sk-live',
    );
  });
});

/* ================================================================== *
 * LiteLLMConnector per-request credential resolution
 * ================================================================== */

describe('LiteLLMConnector apiKeyResolver (issue #293)', () => {
  function okFetch(authLog: (h: string | undefined) => void): typeof fetch {
    return (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      authLog(init?.headers?.['authorization']);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi', tool_calls: [] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  }
  const req = { messages: [{ role: 'user' as const, content: 'x' }] };

  it('a resolved vault key lands on Authorization and wins over the static key', async () => {
    const seen: (string | undefined)[] = [];
    const connector = new LiteLLMConnector({
      baseUrl: 'http://x',
      model: 'm',
      apiKey: 'env-dead-key',
      apiKeyResolver: async () => 'sk-vault-fresh',
      fetch: okFetch((h) => seen.push(h)),
    });
    await connector.complete(req);
    expect(seen).toEqual(['Bearer sk-vault-fresh']);
  });

  it('falls back to the static key when the resolver yields nothing or throws', async () => {
    const seen: (string | undefined)[] = [];
    for (const apiKeyResolver of [
      async () => null,
      async () => undefined,
      async () => {
        throw new Error('vault locked');
      },
    ]) {
      const connector = new LiteLLMConnector({
        baseUrl: 'http://x',
        model: 'm',
        apiKey: 'env-key',
        apiKeyResolver,
        fetch: okFetch((h) => seen.push(h)),
      });
      await connector.complete(req);
    }
    expect(seen).toEqual(['Bearer env-key', 'Bearer env-key', 'Bearer env-key']);
  });

  it('re-resolves per request — a stored key takes effect without a restart', async () => {
    const dir = tmpDir();
    const service = new SecretsVaultService({
      vault: new EncryptedFileSecretsVault({
        filePath: path.join(dir, 'secrets.enc'),
        masterKey: 'test-master-key',
      }),
    });
    const seen: (string | undefined)[] = [];
    const connector = new LiteLLMConnector({
      baseUrl: 'http://x',
      model: 'm',
      apiKey: 'env-original',
      apiKeyResolver: () => service.resolveProviderCredential({ envVarNames: ['OPENAI_API_KEY'] }),
      fetch: okFetch((h) => seen.push(h)),
    });
    // First call: no vault key → env key.
    await connector.complete(req);
    // User stores a replacement key mid-flight — next call picks it up.
    await service.captureSecret({
      name: 'openai-key',
      value: 'sk-vault-midflight',
      scope: { envVarName: 'OPENAI_API_KEY' },
    });
    await connector.complete(req);
    expect(seen).toEqual(['Bearer env-original', 'Bearer sk-vault-midflight']);
  });
});

/* ================================================================== *
 * Adapter env plumbing + a real spawned process
 * ================================================================== */

describe('adapter env plumbing (issue #293)', () => {
  it('agy adapter hands sessionConfig.env to its spawner', async () => {
    let captured: Readonly<Record<string, string>> | undefined;
    const adapter = new AgyAdapter(null, {
      spawner: (_command, _args, _cwd, env) => {
        captured = env;
        return {
          onLine: () => {},
          onStderrLine: () => {},
          onExit: () => {},
          kill: () => {},
        };
      },
    });
    await adapter.connect();
    await adapter.startRun('task-1', {
      ...BASE_CONFIG,
      env: { MY_KEY: 'injected' },
    });
    expect(captured).toEqual({ MY_KEY: 'injected' });
    await adapter.disconnect();
  });

  it('spawnCli really lands env vars in a live child process', async () => {
    // Terminal-hop proof: the merged env reaches an actual OS process.
    // A script file avoids cmd.exe quoting of inline `-e` source.
    const dir = tmpDir();
    const script = path.join(dir, 'print-env.js');
    fs.writeFileSync(
      script,
      'process.stdout.write(process.env.FLORINA_TEST_KEY ?? "MISSING");\n',
      'utf8',
    );
    const child = spawnCli(process.execPath, [script], {
      env: { ...process.env, FLORINA_TEST_KEY: 'injected-123' },
    });
    const out = await new Promise<string>((resolve, reject) => {
      let buf = '';
      child.stdout?.on('data', (d) => (buf += String(d)));
      child.on('exit', () => resolve(buf));
      child.on('error', reject);
      setTimeout(() => reject(new Error('child timeout')), 10_000);
    });
    expect(out).toBe('injected-123');
  });
});

/* ================================================================== *
 * Real daemon end-to-end: vault → dispatch env over the wire
 * ================================================================== */

describe('secret injection through a real daemon (issue #293)', () => {
  let daemon: FlorinaDaemon | null = null;

  afterEach(async () => {
    if (daemon !== null) {
      await daemon.stop();
      daemon = null;
    }
  });

  it('secrets-set over WS → start-task injects the value into the run config', async () => {
    const dir = tmpDir();
    const port = 17600 + Math.floor(Math.random() * 300);
    const dbFile = path.join(dir, 'florina.db');

    // Pre-seed project + task rows on the db file before the daemon opens it.
    const seed = new StorageDatabase({ path: dbFile });
    seed.open();
    const project = buildProject({ name: 'e2e', repo: { path: dir } });
    seed.connection
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
    const task = buildTask({ projectId: project.id, objective: 'prove injection' });
    new TaskRepository(seed.connection).insert(task);
    seed.close();

    daemon = new FlorinaDaemon({
      port,
      dbPath: dbFile,
      lockfile: path.join(dir, 'florina.lock'),
      mcpPort: null,
      installSignalHandlers: false,
      secretsCredentialBackend: 'file',
    });
    await daemon.start();

    // Register a capturing adapter so start-task can dispatch to it.
    const adapter = new CapturingAdapter();
    daemon.adapterRegistry$!.register('capture', () => adapter);

    const send = (command: Command): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        const timer = setTimeout(() => reject(new Error('timeout')), 3000);
        socket.once('open', () => {
          socket.once('message', (data) => {
            clearTimeout(timer);
            socket.close();
            resolve(JSON.parse(data.toString('utf8')) as Response);
          });
          socket.send(JSON.stringify(command));
        });
        socket.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });

    const set = (await send({
      kind: 'secrets-set',
      name: 'e2e-openai',
      value: 'sk-wire-injection',
      scope: { envVarName: 'OPENAI_API_KEY' },
    })) as SecretsSetResponse;
    expect(set.ok).toBe(true);

    const start = (await send({
      kind: 'start-task',
      taskId: task.id,
      agentId: 'capture',
      sessionConfig: { workingDir: dir },
    })) as StartTaskResponse;
    expect(start.ok).toBe(true);

    // The vault value reached the adapter's run config — and only there.
    expect(adapter.runs[0]!.env!['OPENAI_API_KEY']).toBe('sk-wire-injection');
    expect(adapter.runs[0]!.projectId).toBe(project.id);
    expect(JSON.stringify(start)).not.toContain('sk-wire-injection');
  });
});
