import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WebSocket } from 'ws';

import {
  SecretaryDaemon,
  DEFAULT_DAEMON_PORT,
  type ApiRequest,
  type ApiResponse,
  type EventStreamMessage,
} from '../src/daemon/index.js';
import { buildProject } from '../src/domain/index.js';
import type { SupervisorEvent } from '../src/domain/index.js';

/**
 * Helper: create a unique lockfile path per test so single-instance checks
 * do not collide across tests or parallel runs.
 */
function uniqueLockfile(): string {
  return path.join(
    os.tmpdir(),
    `agent-secretary-test-${process.pid}-${Math.random().toString(36).slice(2)}.lock`,
  );
}

/**
 * Helper: open a WebSocket client to a running daemon and wait for the open
 * event. Returns the socket.
 */
function openClient(port: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * Helper: send an API request over a socket and resolve with the next
 * response envelope whose id matches. Rejects on timeout.
 */
function requestApi(
  socket: WebSocket,
  request: ApiRequest,
  timeoutMs = 2000,
): Promise<ApiResponse<unknown>> {
  return new Promise<ApiResponse<unknown>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`API request ${request.method} timed out`)),
      timeoutMs,
    );
    const onMessage = (data: unknown): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : (data as Buffer).toString('utf8'));
      } catch {
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { id?: unknown }).id === request.id
      ) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed as ApiResponse<unknown>);
      }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify(request));
  });
}

/** Helper: wait for the next event-stream message on a socket. */
function nextEvent(socket: WebSocket, timeoutMs = 2000): Promise<EventStreamMessage> {
  return new Promise<EventStreamMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Event stream timed out')), timeoutMs);
    const onMessage = (data: unknown): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : (data as Buffer).toString('utf8'));
      } catch {
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { type?: unknown }).type === 'event'
      ) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed as EventStreamMessage);
      }
    };
    socket.on('message', onMessage);
  });
}

/** Helper: a minimal valid SupervisorEvent for streaming tests. */
function sampleEvent(): SupervisorEvent {
  return {
    type: 'AgentStarted',
    timestamp: new Date().toISOString(),
    taskId: 'task-1',
    sessionId: 'sess-1',
    agentId: 'codex',
    adapterFidelityTier: 'A',
    objective: 'Test objective',
    workingDir: '/repo',
  } as SupervisorEvent;
}

describe('daemon: lifecycle', () => {
  let lockfile: string;

  beforeEach(() => {
    lockfile = uniqueLockfile();
  });

  afterEach(async () => {
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('starts, listens on localhost, and stops cleanly', async () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    expect(daemon.isRunning).toBe(false);
    await daemon.start();
    expect(daemon.isRunning).toBe(true);
    expect(daemon.port).not.toBe(0);
    // A client can connect to the bound port.
    const client = await openClient(daemon.port);
    client.close();
    await daemon.stop();
    expect(daemon.isRunning).toBe(false);
    expect(daemon.currentState).toBe('stopped');
  });

  it('default port is 17419', () => {
    expect(DEFAULT_DAEMON_PORT).toBe(17419);
  });

  it('stop is a no-op when already stopped', async () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.stop(); // should not throw
    expect(daemon.isRunning).toBe(false);
  });
});

describe('daemon: single-instance enforcement', () => {
  let lockfile: string;

  beforeEach(() => {
    lockfile = uniqueLockfile();
  });

  afterEach(async () => {
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('second start fails when another instance holds the lockfile', async () => {
    const first = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await first.start();

    const second = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await expect(second.start()).rejects.toThrow(/already running/);

    await first.stop();
  });

  it('stale lockfile from a dead process is reclaimed', async () => {
    // Write a lockfile pointing at a pid that is definitely not alive.
    const stalePid = 999_999;
    fs.writeFileSync(lockfile, String(stalePid));
    const daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.start();
    expect(daemon.isRunning).toBe(true);
    await daemon.stop();
  });
});

describe('daemon: control-plane API', () => {
  let lockfile: string;
  let daemon: SecretaryDaemon;
  let client: WebSocket;

  beforeEach(async () => {
    lockfile = uniqueLockfile();
    daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.start();
    client = await openClient(daemon.port);
  });

  afterEach(async () => {
    if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) {
      client.close();
    }
    await daemon.stop();
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('responds to get_status with typed result', async () => {
    const res = await requestApi(client, { id: '1', method: 'get_status', params: {} });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const result = res.result as {
        activeProjects: unknown[];
        activeTaskCount: number;
        openAttentionCount: number;
        currentProjectId: string | null;
      };
      expect(result.activeProjects).toEqual([]);
      expect(result.activeTaskCount).toBe(0);
      expect(result.openAttentionCount).toBe(0);
      expect(result.currentProjectId).toBeNull();
    }
  });

  it('creates a project via storage, then start_task and show_task round-trip', async () => {
    // Seed a project directly through the control plane's repository.
    const api = daemon.controlPlane!;
    const project = buildProject({ name: 'demo', repo: { path: '/repo/demo' } });
    // Access repos via the api's internal repos is not public; use the
    // storage layer exposed through the daemon's db connection instead.
    const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } }).db
      .connection;
    const { ProjectRepository, TaskRepository } = await import('../src/storage/index.js');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    projects.insert(project);

    const startRes = await requestApi(client, {
      id: '2',
      method: 'start_task',
      params: { projectId: project.id, objective: 'Add tests' },
    });
    expect('result' in startRes).toBe(true);
    if ('result' in startRes) {
      const result = startRes.result as { task: { id: string; objective: string; state: string } };
      expect(result.task.objective).toBe('Add tests');
      expect(result.task.state).toBe('created');
      // Verify it persisted.
      const persisted = tasks.getById(result.task.id);
      expect(persisted).not.toBeNull();
      expect(persisted!.objective).toBe('Add tests');

      const showRes = await requestApi(client, {
        id: '3',
        method: 'show_task',
        params: { taskId: result.task.id },
      });
      expect('result' in showRes).toBe(true);
      if ('result' in showRes) {
        const shown = showRes.result as { task: { id: string }; deliverables: unknown[] };
        expect(shown.task.id).toBe(result.task.id);
        expect(shown.deliverables).toEqual([]);
      }
    }
    void api;
  });

  it('switch_project sets the active project and is reflected in get_status', async () => {
    const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } }).db
      .connection;
    const { ProjectRepository } = await import('../src/storage/index.js');
    const projects = new ProjectRepository(db);
    const project = buildProject({ name: 'p2', repo: { path: '/repo/p2' } });
    projects.insert(project);

    const switchRes = await requestApi(client, {
      id: '4',
      method: 'switch_project',
      params: { projectId: project.id },
    });
    expect('result' in switchRes).toBe(true);
    if ('result' in switchRes) {
      expect((switchRes.result as { switched: boolean }).switched).toBe(true);
    }

    const statusRes = await requestApi(client, { id: '5', method: 'get_status', params: {} });
    if ('result' in statusRes) {
      const result = statusRes.result as {
        currentProjectId: string | null;
        activeProjects: unknown[];
      };
      expect(result.currentProjectId).toBe(project.id);
      expect(result.activeProjects).toHaveLength(1);
    }
  });

  it('returns a typed error for an unknown task', async () => {
    const res = await requestApi(client, {
      id: '6',
      method: 'show_task',
      params: { taskId: 'nope' },
    });
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error.code).toBe('not_found');
      expect(res.error.message).toContain('nope');
    }
  });

  it('get_inbox returns an empty list initially', async () => {
    const res = await requestApi(client, { id: '7', method: 'get_inbox', params: {} });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      expect((res.result as { items: unknown[] }).items).toEqual([]);
    }
  });

  it('get_digest returns typed digest fields', async () => {
    const res = await requestApi(client, { id: '8', method: 'get_digest', params: {} });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const result = res.result as {
        recentEvents: unknown[];
        openAttentionCount: number;
        activeTaskCount: number;
      };
      expect(result.recentEvents).toEqual([]);
      expect(result.openAttentionCount).toBe(0);
      expect(result.activeTaskCount).toBe(0);
    }
  });
});

describe('daemon: live event stream', () => {
  let lockfile: string;
  let daemon: SecretaryDaemon;
  let client: WebSocket;

  beforeEach(async () => {
    lockfile = uniqueLockfile();
    daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.start();
    client = await openClient(daemon.port);
  });

  afterEach(async () => {
    if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) {
      client.close();
    }
    await daemon.stop();
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('pushes events to subscribed clients', async () => {
    // Subscribe.
    client.send(JSON.stringify({ type: 'subscribe' }));
    // Give the server a tick to process the control message.
    await new Promise((r) => setTimeout(r, 50));

    const event = sampleEvent();
    daemon.publishEvent(event);

    const msg = await nextEvent(client);
    expect(msg.type).toBe('event');
    expect(msg.event.type).toBe('AgentStarted');
    expect(msg.event.taskId).toBe('task-1');
    expect(msg.seq).toBe(1);
  });

  it('does not push events to unsubscribed clients', async () => {
    const event = sampleEvent();
    daemon.publishEvent(event);
    // Wait briefly; no event should arrive.
    await expect(nextEvent(client, 300)).rejects.toThrow('timed out');
  });

  it('stops pushing after unsubscribe', async () => {
    client.send(JSON.stringify({ type: 'subscribe' }));
    await new Promise((r) => setTimeout(r, 50));
    daemon.publishEvent(sampleEvent());
    await nextEvent(client);

    client.send(JSON.stringify({ type: 'unsubscribe' }));
    await new Promise((r) => setTimeout(r, 50));
    daemon.publishEvent(sampleEvent());
    await expect(nextEvent(client, 300)).rejects.toThrow('timed out');
  });
});

describe('daemon: health check', () => {
  let lockfile: string;

  beforeEach(() => {
    lockfile = uniqueLockfile();
  });

  afterEach(async () => {
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('returns daemon + storage status', async () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.start();
    const health = daemon.health();
    expect(health.status).toBe('ok');
    expect(health.dbConnected).toBe(true);
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(health.activeConnections).toBe(0);
    expect(health.eventSubscribers).toBe(0);
    expect(health.eventSeq).toBe(0);
    expect(typeof health.timestamp).toBe('string');
    await daemon.stop();
  });

  it('throws when daemon is not running', () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    expect(() => daemon.health()).toThrow('not running');
  });
});

describe('daemon: integration (start, API, events, stop)', () => {
  let lockfile: string;

  beforeEach(() => {
    lockfile = uniqueLockfile();
  });

  afterEach(async () => {
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('full flow: start daemon, call API, receive events, stop', async () => {
    const daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.start();

    // Seed a project so switch_project works.
    const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } }).db
      .connection;
    const { ProjectRepository } = await import('../src/storage/index.js');
    const projects = new ProjectRepository(db);
    const project = buildProject({ name: 'integration', repo: { path: '/repo/i' } });
    projects.insert(project);

    const client = await openClient(daemon.port);

    // 1. Call the API.
    const statusRes = await requestApi(client, { id: 'i1', method: 'get_status', params: {} });
    expect('result' in statusRes).toBe(true);

    const switchRes = await requestApi(client, {
      id: 'i2',
      method: 'switch_project',
      params: { projectId: project.id },
    });
    expect('result' in switchRes).toBe(true);

    // 2. Subscribe and receive a live event.
    client.send(JSON.stringify({ type: 'subscribe' }));
    await new Promise((r) => setTimeout(r, 50));
    daemon.publishEvent(sampleEvent());
    const msg = await nextEvent(client);
    expect(msg.event.type).toBe('AgentStarted');

    // 3. Health check reflects the published event.
    const health = daemon.health();
    expect(health.eventSeq).toBe(1);
    expect(health.eventSubscribers).toBe(1);

    // 4. Stop cleanly.
    client.close();
    await daemon.stop();
    expect(daemon.isRunning).toBe(false);
  });
});
