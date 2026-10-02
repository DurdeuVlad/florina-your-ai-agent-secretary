/**
 * secrets-* command surface (issue #292): the #172 vault engine wired to
 * the typed command API, plus a real-daemon WebSocket round-trip proving
 * the vault auto-isolates beside a temp dbPath.
 *
 * Contract under test:
 * - `secrets-set` stores; `secrets-list` returns metadata only (never
 *   values); `secrets-delete` removes.
 * - Absent `secrets` dep → honest `ok: false`, not a fabricated store.
 * - The secret value never appears in any response.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';

import { CommandApi } from '../src/daemon/command-api.js';
import type {
  CommandApiDeps,
  SecretsListResponse,
  SecretsSetResponse,
  SecretsDeleteResponse,
  Response,
} from '../src/daemon/command-api.js';
import { SecretsVaultService } from '../src/core/application/use-cases/security/secrets-vault-service.js';
import { EncryptedFileSecretsVault } from '../src/adapters/outbound/credentials/encrypted-file-secrets-vault.js';
import { EventBus } from '../src/daemon/event-stream.js';
import { AttentionInbox } from '../src/attention/attention-inbox.js';
import { MetricsCollector } from '../src/daemon/metrics.js';
import { TaskStateMachine } from '../src/daemon/task-lifecycle.js';
import { TaskRepository, EventRepository, StorageDatabase } from '../src/storage/index.js';
import { FlorinaDaemon } from '../src/daemon/index.js';
import type { Command } from '../src/daemon/index.js';

/* ================================================================== *
 * Minimal CommandApi fixture (secrets-only scope)
 * ================================================================== */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'florina-secrets-cmd-'));
}

function makeApi(opts: { withSecrets: boolean; dir?: string }): {
  api: CommandApi;
  service?: SecretsVaultService;
} {
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const taskRepo = new TaskRepository(db.connection);
  const service = opts.withSecrets
    ? new SecretsVaultService({
        vault: new EncryptedFileSecretsVault({
          filePath: path.join(opts.dir ?? tmpDir(), 'secrets.enc'),
          masterKey: 'test-master-key',
        }),
      })
    : undefined;
  const deps: CommandApiDeps = {
    eventBus: new EventBus(),
    taskStateMachine: new TaskStateMachine(taskRepo, new EventRepository(db.connection)),
    attentionInbox: new AttentionInbox(),
    metricsCollector: new MetricsCollector(),
    worktreeManager: {
      createWorktree: () => ({ path: '/tmp/wt', branch: 'b', baseCommit: 'c' }),
      pruneWorktree: () => {},
      detectDirty: () => false,
      worktreeStatus: () => ({ clean: true, dirty: false, branch: 'b', baseCommit: 'c' }),
    } as unknown as CommandApiDeps['worktreeManager'],
    eventRepository: new EventRepository(db.connection),
    taskStore: { getById: () => null, listAll: () => [] } as unknown as CommandApiDeps['taskStore'],
    approvalStore: {} as unknown as CommandApiDeps['approvalStore'],
    sessionStore: {} as unknown as CommandApiDeps['sessionStore'],
    ...(service !== undefined ? { secrets: service } : {}),
  };
  return { api: new CommandApi(deps), service };
}

/* ================================================================== *
 * Command-level tests
 * ================================================================== */

describe('secrets-* commands', () => {
  it('set → list → delete round-trip returns metadata only, never the value', async () => {
    const { api } = makeApi({ withSecrets: true });
    const set = (await api.execute({
      kind: 'secrets-set',
      name: 'openai-key',
      value: 'sk-test-value-123',
      scope: { provider: 'codex', envVarName: 'OPENAI_API_KEY' },
      description: 'test key',
    })) as SecretsSetResponse;
    expect(set).toEqual({ ok: true, name: 'openai-key' });
    expect(JSON.stringify(set)).not.toContain('sk-test-value-123');

    const list = (await api.execute({ kind: 'secrets-list' })) as SecretsListResponse;
    expect(list.ok).toBe(true);
    expect(list.secrets).toHaveLength(1);
    const meta = list.secrets![0]!;
    expect(meta.name).toBe('openai-key');
    expect(meta.scope.provider).toBe('codex');
    expect(meta.scope.envVarName).toBe('OPENAI_API_KEY');
    expect(meta.description).toBe('test key');
    expect(JSON.stringify(list)).not.toContain('sk-test-value-123');
    expect(meta).not.toHaveProperty('value');

    const del = (await api.execute({
      kind: 'secrets-delete',
      name: 'openai-key',
    })) as SecretsDeleteResponse;
    expect(del).toEqual({ ok: true, name: 'openai-key', deleted: true });

    const list2 = (await api.execute({ kind: 'secrets-list' })) as SecretsListResponse;
    expect(list2.secrets).toHaveLength(0);
  });

  it('secrets-set validates name and value', async () => {
    const { api } = makeApi({ withSecrets: true });
    const noName = (await api.execute({
      kind: 'secrets-set',
      name: '',
      value: 'v',
    })) as SecretsSetResponse;
    expect(noName.ok).toBe(false);
    expect(noName.error).toContain('name');
    const noValue = (await api.execute({
      kind: 'secrets-set',
      name: 'x',
      value: '',
    })) as SecretsSetResponse;
    expect(noValue.ok).toBe(false);
    expect(noValue.error).toContain('value');
  });

  it('secrets-delete validates name and reports absent names honestly', async () => {
    const { api } = makeApi({ withSecrets: true });
    const noName = (await api.execute({
      kind: 'secrets-delete',
      name: ' ',
    })) as SecretsDeleteResponse;
    expect(noName.ok).toBe(false);
    const missing = (await api.execute({
      kind: 'secrets-delete',
      name: 'never-stored',
    })) as SecretsDeleteResponse;
    expect(missing).toEqual({ ok: true, name: 'never-stored', deleted: false });
  });

  it('fails cleanly when the vault dep is absent — never fabricates', async () => {
    const { api } = makeApi({ withSecrets: false });
    const list = (await api.execute({ kind: 'secrets-list' })) as SecretsListResponse;
    expect(list.ok).toBe(false);
    expect(list.error).toContain('not wired');
    const set = (await api.execute({
      kind: 'secrets-set',
      name: 'x',
      value: 'v',
    })) as SecretsSetResponse;
    expect(set.ok).toBe(false);
    const del = (await api.execute({
      kind: 'secrets-delete',
      name: 'x',
    })) as SecretsDeleteResponse;
    expect(del.ok).toBe(false);
  });

  it('stores to an encrypted file — value not readable as plaintext on disk', async () => {
    const dir = tmpDir();
    const { api } = makeApi({ withSecrets: true, dir });
    await api.execute({ kind: 'secrets-set', name: 'k', value: 'sk-plaintext-marker' });
    const raw = fs.readFileSync(path.join(dir, 'secrets.enc'), 'utf8');
    expect(raw).not.toContain('sk-plaintext-marker');
  });

  it('rejects malformed wire fields with structured errors — never throws', async () => {
    const { api } = makeApi({ withSecrets: true });
    const malformed: unknown[] = [
      { kind: 'secrets-set', name: 5, value: 'v' },
      { kind: 'secrets-set', name: null, value: 'v' },
      { kind: 'secrets-set', name: 'x', value: 42 },
      { kind: 'secrets-set', name: 'x', value: 'v', description: 7 },
      { kind: 'secrets-set', name: 'x', value: 'v', expiresAt: 'not-a-date' },
      { kind: 'secrets-set', name: 'x', value: 'v', expiresAt: 12345 },
      { kind: 'secrets-set', name: 'x', value: 'v', scope: 'global' },
      { kind: 'secrets-set', name: 'x', value: 'v', scope: [] },
      { kind: 'secrets-set', name: 'x', value: 'v', scope: { provider: 7 } },
      { kind: 'secrets-set', name: 'x', value: 'v', scope: { bogus: 'y' } },
      { kind: 'secrets-delete', name: 9 },
      { kind: 'secrets-delete', name: {} },
    ];
    for (const cmd of malformed) {
      const res = (await api.execute(cmd as Command)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe('string');
      expect(res.error!.length).toBeGreaterThan(0);
    }
  });

  it('refuses dangerous env-var injection targets and invalid names', async () => {
    const { api } = makeApi({ withSecrets: true });
    for (const envVarName of [
      'PATH',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'PYTHONPATH',
      'HAS-DASH',
      '1DIGIT',
      'HAS SPACE',
    ]) {
      const res = (await api.execute({
        kind: 'secrets-set',
        name: 'k',
        value: 'v',
        scope: { envVarName },
      })) as SecretsSetResponse;
      expect(res.ok).toBe(false);
      expect(res.error).toContain('envVarName');
    }
    // A legitimate name still stores fine.
    const good = (await api.execute({
      kind: 'secrets-set',
      name: 'k',
      value: 'v',
      scope: { envVarName: 'OPENAI_API_KEY' },
    })) as SecretsSetResponse;
    expect(good.ok).toBe(true);
  });

  it('normalizes non-ISO expiresAt to canonical ISO before storing', async () => {
    const { api } = makeApi({ withSecrets: true });
    const res = (await api.execute({
      kind: 'secrets-set',
      name: 'exp-key',
      value: 'v',
      expiresAt: '12/31/2099',
    })) as SecretsSetResponse;
    expect(res.ok).toBe(true);
    const list = (await api.execute({ kind: 'secrets-list' })) as SecretsListResponse;
    // '12/31/2099' would lexically compare as already-expired; the
    // normalized ISO form does not (exact instant is TZ-dependent).
    expect(list.secrets![0]!.expiresAt).toMatch(/^2099-12-3[01]T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('accepts prototype-adjacent names end-to-end through the wire shape', async () => {
    const { api } = makeApi({ withSecrets: true });
    for (const name of ['__proto__', 'constructor', 'toString']) {
      const res = (await api.execute({
        kind: 'secrets-set',
        name,
        value: `v-${name}`,
      })) as SecretsSetResponse;
      expect(res.ok).toBe(true);
    }
    const list = (await api.execute({ kind: 'secrets-list' })) as SecretsListResponse;
    expect(list.secrets!.map((s) => s.name).sort()).toEqual([
      '__proto__',
      'constructor',
      'toString',
    ]);
    // delete on an absent builtin name is an honest miss, not a false hit
    const miss = (await api.execute({
      kind: 'secrets-delete',
      name: 'hasOwnProperty',
    })) as SecretsDeleteResponse;
    expect(miss).toEqual({ ok: true, name: 'hasOwnProperty', deleted: false });
  });
});

/* ================================================================== *
 * Real-daemon round-trip over WebSocket
 * ================================================================== */

describe('secrets-* over a real daemon socket', () => {
  let daemon: FlorinaDaemon | null = null;

  afterEach(async () => {
    if (daemon !== null) {
      await daemon.stop();
      daemon = null;
    }
  });

  it('set/list/delete round-trip on ws with vault isolated beside temp dbPath', async () => {
    const dir = tmpDir();
    const port = 17300 + Math.floor(Math.random() * 400);
    daemon = new FlorinaDaemon({
      port,
      dbPath: path.join(dir, 'florina.db'),
      lockfile: path.join(dir, 'florina.lock'),
      mcpPort: null,
      installSignalHandlers: false,
      // Hermetic: file-backed credential store inside the temp dir — the
      // test daemon must never write a real cmdkey/keychain entry.
      secretsCredentialBackend: 'file',
    });
    await daemon.start();

    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const send = (command: Command): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 3000);
        socket.once('message', (data) => {
          clearTimeout(timer);
          resolve(JSON.parse(data.toString('utf8')) as Response);
        });
        socket.send(JSON.stringify(command));
      });

    const set = (await send({
      kind: 'secrets-set',
      name: 'e2e-key',
      value: 'sk-e2e-secret-value',
      scope: { envVarName: 'OPENAI_API_KEY' },
    })) as SecretsSetResponse;
    expect(set.ok).toBe(true);

    const list = (await send({ kind: 'secrets-list' })) as SecretsListResponse;
    expect(list.ok).toBe(true);
    expect(list.secrets!.map((s) => s.name)).toContain('e2e-key');
    expect(JSON.stringify(list)).not.toContain('sk-e2e-secret-value');

    const del = (await send({ kind: 'secrets-delete', name: 'e2e-key' })) as SecretsDeleteResponse;
    expect(del.ok).toBe(true);
    expect(del.deleted).toBe(true);

    // The vault file landed beside the temp dbPath — isolated, encrypted.
    const vaultPath = path.join(dir, 'secrets.enc');
    expect(fs.existsSync(vaultPath)).toBe(true);
    expect(fs.readFileSync(vaultPath, 'utf8')).not.toContain('sk-e2e-secret-value');

    // Provenance: the vault-local audit ledger recorded capture + revoke
    // with metadata only — never the value.
    const auditPath = path.join(dir, 'secrets.audit.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const auditLines = fs
      .readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { action: string; name: string });
    expect(auditLines.map((e) => e.action)).toEqual(['secret_captured', 'secret_revoked']);
    expect(auditLines.every((e) => e.name === 'e2e-key')).toBe(true);
    expect(fs.readFileSync(auditPath, 'utf8')).not.toContain('sk-e2e-secret-value');

    socket.close();
  });

  it('two :memory: daemons get independent vaults — never the real ~/.florina', async () => {
    // Regression for the review finding: a memory-mode daemon must not
    // read or write the real user vault. Two ephemeral daemons prove it:
    // if either fell back to the shared default path, they'd see each
    // other's secrets (and on this dev machine, the real user's).
    const dirA = tmpDir();
    const dirB = tmpDir();
    const portA = 17300 + Math.floor(Math.random() * 200);
    const portB = portA + 201;
    const daemons: FlorinaDaemon[] = [];
    try {
      const a = new FlorinaDaemon({
        port: portA,
        dbPath: ':memory:',
        lockfile: path.join(dirA, 'florina.lock'),
        mcpPort: null,
        installSignalHandlers: false,
      });
      const b = new FlorinaDaemon({
        port: portB,
        dbPath: ':memory:',
        lockfile: path.join(dirB, 'florina.lock'),
        mcpPort: null,
        installSignalHandlers: false,
      });
      daemons.push(a, b);
      await Promise.all([a.start(), b.start()]);

      const send =
        (port: number) =>
        (command: Command): Promise<Response> =>
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

      const set = (await send(portA)({
        kind: 'secrets-set',
        name: 'daemon-a-key',
        value: 'sk-a-only',
      })) as SecretsSetResponse;
      expect(set.ok).toBe(true);

      const listA = (await send(portA)({ kind: 'secrets-list' })) as SecretsListResponse;
      const listB = (await send(portB)({ kind: 'secrets-list' })) as SecretsListResponse;
      expect(listA.secrets!.map((s) => s.name)).toEqual(['daemon-a-key']);
      expect(listB.secrets).toEqual([]);
    } finally {
      for (const d of daemons) {
        await d.stop();
      }
    }
  });
});
