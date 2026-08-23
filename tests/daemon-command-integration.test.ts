/**
 * Integration tests for wiring CommandApi into the daemon WebSocket handler
 * (issue #33).
 *
 * These tests verify that:
 * - The daemon accepts `Command` objects (discriminated by `kind`) over the
 *   same WebSocket that serves the legacy `ControlPlaneApi` envelopes.
 * - The legacy `{ id, method, params }` protocol still works (backward
 *   compatibility).
 * - Invalid / unknown command kinds return a typed error response.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WebSocket } from 'ws';

import {
  SecretaryDaemon,
  type ApiRequest,
  type ApiResponse,
  type Command,
  type Response,
} from '../src/daemon/index.js';
import { buildProject, buildTask } from '../src/domain/index.js';

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
 * Helper: send a Command over a socket and resolve with the next Response.
 * Commands do not carry a correlation id, so we simply await the next
 * message. Rejects on timeout.
 */
function sendCommand(socket: WebSocket, command: Command, timeoutMs = 2000): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Command ${command.kind} timed out`)),
      timeoutMs,
    );
    const onMessage = (data: unknown): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : (data as Buffer).toString('utf8'));
      } catch {
        return;
      }
      // Responses from CommandApi carry an `ok` field; ControlPlaneApi
      // responses carry an `id` field. We only want Command responses here.
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { ok?: unknown }).ok === 'boolean'
      ) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed as Response);
      }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify(command));
  });
}

/**
 * Helper: send a legacy ControlPlaneApi request and resolve with the matching
 * response envelope (identified by `id`).
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

describe('daemon: CommandApi integration (#33)', () => {
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

  it('accepts a list-tasks Command and returns a typed TaskListResponse', async () => {
    const res = await sendCommand(client, { kind: 'list-tasks' });
    expect(res.ok).toBe(true);
    expect('tasks' in res).toBe(true);
    if ('tasks' in res) {
      expect(Array.isArray(res.tasks)).toBe(true);
      expect(res.tasks).toEqual([]);
    }
  });

  it('accepts a query-metrics Command and returns a MetricsResponse', async () => {
    const res = await sendCommand(client, { kind: 'query-metrics' });
    expect(res.ok).toBe(true);
    expect('snapshot' in res).toBe(true);
    if ('snapshot' in res) {
      expect(res.snapshot).not.toBeNull();
      expect(typeof res.snapshot!.timestamp).toBe('string');
    }
  });

  it('accepts a query-inbox Command and returns an InboxResponse', async () => {
    const res = await sendCommand(client, { kind: 'query-inbox' });
    expect(res.ok).toBe(true);
    expect('items' in res).toBe(true);
    if ('items' in res) {
      expect(Array.isArray(res.items)).toBe(true);
      expect(res.items).toEqual([]);
    }
  });

  it('returns an error response for an unknown command kind', async () => {
    // Send a command with an invalid kind. The daemon should route it to
    // CommandApi.execute which returns an UnknownCommandResponse.
    const res = await sendCommand(client, { kind: 'bogus-command' } as unknown as Command);
    expect(res.ok).toBe(false);
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error).toContain('Unknown command kind');
    }
  });

  it('returns an error response for a query-task with missing taskId', async () => {
    const res = await sendCommand(client, { kind: 'query-task', taskId: '' });
    expect(res.ok).toBe(false);
    expect('task' in res).toBe(true);
    if ('task' in res) {
      expect(res.task).toBeNull();
    }
  });

  it('query-task returns the task when it exists', async () => {
    // Seed a project + task directly through the storage layer.
    const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } })
      .db.connection;
    const { ProjectRepository, TaskRepository } = await import('../src/storage/index.js');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const project = buildProject({ name: 'demo', repo: { path: '/repo/demo' } });
    projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'Write tests' });
    tasks.insert(task);

    const res = await sendCommand(client, { kind: 'query-task', taskId: task.id });
    expect(res.ok).toBe(true);
    expect('task' in res).toBe(true);
    if ('task' in res && res.task) {
      expect(res.task.id).toBe(task.id);
      expect(res.task.objective).toBe('Write tests');
      expect(res.task.eventCount).toBe(0);
    }
  });

  it('list-tasks returns seeded tasks', async () => {
    const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } })
      .db.connection;
    const { ProjectRepository, TaskRepository } = await import('../src/storage/index.js');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const project = buildProject({ name: 'demo', repo: { path: '/repo/demo' } });
    projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'Write tests' });
    tasks.insert(task);

    const res = await sendCommand(client, { kind: 'list-tasks' });
    expect(res.ok).toBe(true);
    if ('tasks' in res) {
      expect(res.tasks).toHaveLength(1);
      expect(res.tasks[0].id).toBe(task.id);
    }
  });

  it('backward compatibility: ControlPlaneApi get_status still works', async () => {
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

  it('both protocols can be used on the same connection', async () => {
    // Send a Command first.
    const cmdRes = await sendCommand(client, { kind: 'list-tasks' });
    expect(cmdRes.ok).toBe(true);

    // Then send a legacy API request on the same socket.
    const apiRes = await requestApi(client, { id: '2', method: 'get_status', params: {} });
    expect('result' in apiRes).toBe(true);
  });
});
