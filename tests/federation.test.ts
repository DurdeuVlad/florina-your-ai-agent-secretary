/**
 * Federated sub-secretaries (DEC-036, issue #78): a child daemon is a
 * provider-shaped capacity pool on the parent — pairing/auth, scoped
 * commands, delegate-task, and event remapping end-to-end over a real
 * WebSocket control plane.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { WebSocket } from 'ws';

import { SecretaryDaemon } from '../src/bootstrap/daemon.js';
import {
  RemoteSecretaryAdapter,
  type RemoteClientPort,
} from '../src/adapters/outbound/federation/remote-secretary-adapter.js';
import { buildProject } from '../src/core/domain/index.js';
import type { SupervisorEvent } from '../src/core/domain/events.js';
import type { Command, Response } from '../src/core/application/use-cases/tasks/command-api.js';

let tmpDir: string;
let lockSeq = 0;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'sec-fed-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const lockfile = (): string => join(tmpDir, `lock-${++lockSeq}.lock`);

/** Seed a project + a 'stub' agent row into the daemon's DB. */
async function seedChild(daemon: SecretaryDaemon): Promise<string> {
  const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } }).db
    .connection;
  const { ProjectRepository } = await import('../src/storage/index.js');
  // The delegated worktree branches from a real repo — init one.
  const repoPath = join(tmpDir, `repo-${++lockSeq}`);
  await mkdir(repoPath, { recursive: true });
  execSync('git init -q && git commit -q --allow-empty -m init', { cwd: repoPath });
  const project = buildProject({ name: 'child', repo: { path: repoPath } });
  new ProjectRepository(db).insert(project);
  db.prepare(
    'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('stub', 'stub', 'stub', 'E', '{}', new Date().toISOString());
  return project.id;
}

/** A preference profile that routes everything to the stub adapter. */
async function stubProfile(): Promise<string> {
  const path = join(tmpDir, `prefs-${++lockSeq}.json`);
  await writeFile(path, JSON.stringify({ rules: [{ provider: 'stub' }], denied: [] }));
  return path;
}

function wsSend(socket: WebSocket, msg: unknown): void {
  socket.send(JSON.stringify(msg));
}

function nextMessage(socket: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
  });
}

function openWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

/* ================================================================== *
 * Pairing + auth (DEC-011: narrow, never widen)
 * ================================================================== */

describe('control-plane auth + capability scoping', () => {
  it('rejects commands before authentication', async () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      mcpPort: 0,
      lockfile: lockfile(),
      dbPath: ':memory:',
      installSignalHandlers: false,
      authToken: 'secret-tok',
    });
    await daemon.start();
    const socket = await openWs(daemon.port);
    wsSend(socket, { kind: 'list-tasks' });
    const res = await nextMessage(socket);
    expect(res['ok']).toBe(false);
    expect(String(res['error'])).toContain('authentication');
    socket.close();
    await daemon.stop();
  });

  it('rejects a bad token and accepts a good one', async () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      mcpPort: 0,
      lockfile: lockfile(),
      dbPath: ':memory:',
      installSignalHandlers: false,
      authToken: 'secret-tok',
    });
    await daemon.start();

    const bad = await openWs(daemon.port);
    wsSend(bad, { type: 'auth', token: 'wrong' });
    const badRes = await nextMessage(bad);
    expect(badRes['ok']).toBe(false);

    const good = await openWs(daemon.port);
    wsSend(good, { type: 'auth', token: 'secret-tok' });
    const goodRes = await nextMessage(good);
    expect(goodRes['ok']).toBe(true);
    wsSend(good, { kind: 'list-tasks' });
    const tasks = await nextMessage(good);
    expect(tasks['ok']).toBe(true);
    good.close();
    await daemon.stop();
  });

  it('scopes remote commands to the permitted kinds', async () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      mcpPort: 0,
      lockfile: lockfile(),
      dbPath: ':memory:',
      installSignalHandlers: false,
      allowedCommands: ['delegate-task', 'query-task', 'list-tasks'],
    });
    await daemon.start();
    const socket = await openWs(daemon.port);
    wsSend(socket, { kind: 'shutdown' });
    const res = await nextMessage(socket);
    expect(res['ok']).toBe(false);
    expect(String(res['error'])).toContain('not permitted');
    socket.close();
    await daemon.stop();
  });
});

/* ================================================================== *
 * delegate-task on the child
 * ================================================================== */

describe('delegate-task', () => {
  it('spawns a task on the child through the normal machinery', async () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      mcpPort: 0,
      lockfile: lockfile(),
      dbPath: ':memory:',
      installSignalHandlers: false,
      preferenceProfilePath: await stubProfile(),
    });
    await daemon.start();
    const projectId = await seedChild(daemon);

    const socket = await openWs(daemon.port);
    wsSend(socket, { kind: 'delegate-task', projectId, objective: 'remote work' });
    const res = await nextMessage(socket);
    expect(res['ok']).toBe(true);
    expect(res['status']).toBe('spawned');
    expect(res['provider']).toBe('stub');
    expect(typeof res['taskId']).toBe('string');
    socket.close();
    await daemon.stop();
  });

  it('rejects delegation into an unknown project', async () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      mcpPort: 0,
      lockfile: lockfile(),
      dbPath: ':memory:',
      installSignalHandlers: false,
      preferenceProfilePath: await stubProfile(),
    });
    await daemon.start();
    const socket = await openWs(daemon.port);
    wsSend(socket, { kind: 'delegate-task', projectId: 'ghost', objective: 'x' });
    const res = await nextMessage(socket);
    expect(res['ok']).toBe(false);
    expect(String(res['error'])).toContain('unknown project');
    socket.close();
    await daemon.stop();
  });
});

/* ================================================================== *
 * RemoteSecretaryAdapter — event remapping (unit seam)
 * ================================================================== */

class FakeRemoteClient implements RemoteClientPort {
  readonly sent: Command[] = [];
  readonly queue: SupervisorEvent[] = [];
  private resolvers: Array<(e: SupervisorEvent | null) => void> = [];
  delegateResult: Response = {
    ok: true,
    status: 'spawned',
    taskId: 'child-task-1',
    sessionId: 'child-sess-1',
    provider: 'codex',
    reason: 'rule',
  } as Response;

  connect(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(): void {}
  send(command: Command): Promise<Response> {
    this.sent.push(command);
    return Promise.resolve(
      command.kind === 'delegate-task' ? this.delegateResult : ({ ok: true } as Response),
    );
  }
  async *events(): AsyncIterable<SupervisorEvent> {
    while (true) {
      const e = this.queue.shift();
      if (e !== undefined) {
        yield e;
        continue;
      }
      const next = await new Promise<SupervisorEvent | null>((r) => this.resolvers.push(r));
      if (next === null) return;
      yield next;
    }
  }
  pushEvent(e: SupervisorEvent): void {
    const r = this.resolvers.shift();
    if (r !== undefined) r(e);
    else this.queue.push(e);
  }
  close(): void {
    for (const r of this.resolvers.splice(0)) r(null);
  }
}

const childEvent = (over: Record<string, unknown>): SupervisorEvent =>
  ({
    type: 'AgentProgress',
    timestamp: '2026-01-01T00:00:00Z',
    taskId: 'child-task-1',
    sessionId: 'child-sess-1',
    agentId: 'codex',
    message: 'working',
    ...over,
  }) as SupervisorEvent;

describe('RemoteSecretaryAdapter', () => {
  const sessionConfig = {
    taskId: 'parent-task',
    sessionId: 'parent-sess',
    agentId: 'codex@server-x',
    workingDir: '/remote/wt',
    objective: 'do remote work',
  };

  it('delegates via delegate-task and remaps child events to parent ids', async () => {
    const client = new FakeRemoteClient();
    const adapter = new RemoteSecretaryAdapter(null, {
      id: 'codex@server-x',
      remote: { host: 'x', port: 1 },
      projectId: 'proj-child',
      client,
    });
    await adapter.connect();
    const res = await adapter.startRun('parent-task', sessionConfig);
    expect(res.started).toBe(true);
    expect(client.sent[0]).toMatchObject({
      kind: 'delegate-task',
      projectId: 'proj-child',
      objective: 'do remote work',
    });

    client.pushEvent(childEvent({ type: 'AgentCompleted' }));
    const events: SupervisorEvent[] = [];
    for await (const e of adapter.streamEvents()) {
      events.push(e);
      if (e.type === 'AgentCompleted') break;
    }
    // First: the local AgentStarted; then the remapped child event.
    const completed = events.find((e) => e.type === 'AgentCompleted');
    expect(completed?.taskId).toBe('parent-task');
    expect(completed?.sessionId).toBe('parent-sess');
    expect(completed?.agentId).toBe('codex@server-x');
  });

  it('drops child events for tasks this adapter did not delegate', async () => {
    const client = new FakeRemoteClient();
    const adapter = new RemoteSecretaryAdapter(null, {
      id: 'codex@server-x',
      remote: { host: 'x', port: 1 },
      projectId: 'p',
      client,
    });
    await adapter.connect();
    await adapter.startRun('parent-task', sessionConfig);
    client.pushEvent(childEvent({ taskId: 'someone-elses-task' }));
    client.pushEvent(childEvent({ type: 'AgentCompleted' }));
    const events: SupervisorEvent[] = [];
    for await (const e of adapter.streamEvents()) {
      events.push(e);
      if (e.type === 'AgentCompleted') break;
    }
    expect(events.every((e) => e.taskId === 'parent-task')).toBe(true);
  });

  it('a parked child reports started:false', async () => {
    const client = new FakeRemoteClient();
    client.delegateResult = {
      ok: true,
      status: 'parked',
      resumeAt: null,
      reason: 'all quota exhausted',
    } as Response;
    const adapter = new RemoteSecretaryAdapter(null, {
      id: 'codex@server-x',
      remote: { host: 'x', port: 1 },
      projectId: 'p',
      client,
    });
    await adapter.connect();
    const res = await adapter.startRun('parent-task', sessionConfig);
    expect(res.started).toBe(false);
  });

  it('cancel sends stop-task for the delegated child task', async () => {
    const client = new FakeRemoteClient();
    const adapter = new RemoteSecretaryAdapter(null, {
      id: 'codex@server-x',
      remote: { host: 'x', port: 1 },
      projectId: 'p',
      client,
    });
    await adapter.connect();
    await adapter.startRun('parent-task', sessionConfig);
    await adapter.cancel('parent-sess');
    const stop = client.sent.find((c) => c.kind === 'stop-task');
    expect(stop).toMatchObject({ kind: 'stop-task', taskId: 'child-task-1' });
  });
});

/* ================================================================== *
 * End-to-end: real child daemon + real remote client + real adapter
 * ================================================================== */

describe('federation end-to-end', () => {
  it('parent delegates to a live child daemon over WS and receives events', async () => {
    const child = new SecretaryDaemon({
      port: 0,
      mcpPort: 0,
      lockfile: lockfile(),
      dbPath: ':memory:',
      installSignalHandlers: false,
      authToken: 'pairing-tok',
      allowedCommands: ['delegate-task', 'stop-task', 'query-task', 'list-tasks'],
      preferenceProfilePath: await stubProfile(),
    });
    await child.start();
    const projectId = await seedChild(child);

    const adapter = new RemoteSecretaryAdapter(null, {
      id: 'stub@child',
      remote: { host: '127.0.0.1', port: child.port, authToken: 'pairing-tok' },
      projectId,
      preferProvider: 'stub',
    });
    await adapter.connect();

    const started = await adapter.startRun('parent-task-1', {
      taskId: 'parent-task-1',
      sessionId: 'parent-sess-1',
      agentId: 'stub@child',
      workingDir: '/n/a',
      objective: 'remote work over the wire',
    });
    expect(started.started).toBe(true);

    // Collect until the child's AgentCompleted is remapped (the stub
    // emits its full sequence quickly).
    const seen: string[] = [];
    const deadline = Date.now() + 5000;
    for await (const e of adapter.streamEvents()) {
      seen.push(e.type);
      expect(e.taskId).toBe('parent-task-1');
      expect(e.sessionId).toBe('parent-sess-1');
      expect(e.agentId).toBe('stub@child');
      if (e.type === 'AgentCompleted' || Date.now() > deadline) break;
    }
    expect(seen).toContain('AgentStarted');
    expect(seen).toContain('AgentCompleted');

    await adapter.disconnect();
    await child.stop();
  });

  it('a remote pool registers in the adapter registry as provider@host capacity', async () => {
    // The child isn't real here — registration is what we prove.
    const daemon = new SecretaryDaemon({
      port: 0,
      mcpPort: 0,
      lockfile: lockfile(),
      dbPath: ':memory:',
      installSignalHandlers: false,
      remoteProviders: [
        { id: 'codex@server-x', host: '127.0.0.1', port: 1, projectId: 'p' },
      ],
    });
    await daemon.start();
    const registry = (
      daemon as unknown as { adapterRegistry: { create(id: string): { id: string } } }
    ).adapterRegistry;
    expect(registry.create('codex@server-x').id).toBe('codex@server-x');
    await daemon.stop();
  });
});
