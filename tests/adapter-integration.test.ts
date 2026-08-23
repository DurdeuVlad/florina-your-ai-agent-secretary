/**
 * Integration tests for adapter registry & session manager wiring (issue #35).
 *
 * These tests verify that:
 * - The daemon constructs an AdapterRegistry and registers the stub adapter
 *   on start.
 * - A `start-task` command connects the stub adapter and pipes its
 *   normalized SupervisorEvents onto the daemon's EventBus.
 * - A `stop-task` command cancels and disconnects the adapter.
 * - The SessionManager directly manages sessions: start/stop, event piping,
 *   and concurrent-session isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WebSocket } from 'ws';

import {
  SecretaryDaemon,
  EventBus,
  SessionManager,
  type Command,
  type Response,
} from '../src/daemon/index.js';
import { StubAdapter, buildDefaultStubEvents } from '../src/adapters/stub-adapter.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import { buildProject, buildTask, buildAgent } from '../src/domain/index.js';

/* ================================================================== *
 * Helpers
 * ================================================================== */

/** Unique lockfile path per test to avoid single-instance collisions. */
function uniqueLockfile(): string {
  return path.join(
    os.tmpdir(),
    `agent-secretary-test-${process.pid}-${Math.random().toString(36).slice(2)}.lock`,
  );
}

/** Open a WebSocket client to a running daemon and wait for the open event. */
function openClient(port: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Send a Command over a socket and resolve with the next Response. */
function sendCommand(socket: WebSocket, command: Command, timeoutMs = 3000): Promise<Response> {
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
 * Collect SupervisorEvents from an EventBus until `count` events have been
 * received or `timeoutMs` elapses. Resolves with the collected events.
 */
function collectEvents(bus: EventBus, count: number, timeoutMs = 3000): Promise<SupervisorEvent[]> {
  return new Promise<SupervisorEvent[]>((resolve) => {
    const collected: SupervisorEvent[] = [];
    const timer = setTimeout(() => {
      off();
      resolve(collected);
    }, timeoutMs);
    const off = bus.onEvent((event) => {
      collected.push(event);
      if (collected.length >= count) {
        clearTimeout(timer);
        off();
        resolve(collected);
      }
    });
  });
}

/** Wait for a condition to become true, polling at an interval. */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/* ================================================================== *
 * Tests: daemon WebSocket integration
 * ================================================================== */

describe('daemon: adapter integration via WebSocket (#35)', () => {
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

  it('constructs an AdapterRegistry and registers the stub adapter on start', () => {
    const registry = daemon.adapterRegistry$;
    expect(registry).not.toBeNull();
    expect(registry!.has('stub')).toBe(true);
    expect(registry!.list()).toContain('stub');
  });

  it('constructs a SessionManager on start', () => {
    expect(daemon.sessionManager$).not.toBeNull();
    expect(daemon.sessionManager$!.activeCount).toBe(0);
  });

  it('start-task connects the stub adapter and pipes events to the EventBus', async () => {
    // Seed a project, an agent (id "stub" to match the adapter), and a task.
    const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } })
      .db.connection;
    const { ProjectRepository, TaskRepository } = await import('../src/storage/index.js');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const project = buildProject({ name: 'demo', repo: { path: '/repo/demo' } });
    projects.insert(project);
    const agent = buildAgent({
      id: 'stub',
      name: 'Stub',
      provider: 'stub',
      fidelityTier: 'E',
      runtime: { kind: 'cli' },
    });
    db.prepare(
      'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(agent.id, agent.name, agent.provider, agent.fidelityTier, JSON.stringify(agent.runtime), agent.createdAt);
    const task = buildTask({ projectId: project.id, objective: 'Write tests' });
    tasks.insert(task);

    // Subscribe to the EventBus to collect events piped from the adapter.
    const bus = daemon.eventBus!;
    const eventsPromise = collectEvents(bus, 14); // 1 from CommandApi + 13 from stub

    // Send start-task with agentId "stub".
    const res = await sendCommand(client, {
      kind: 'start-task',
      taskId: task.id,
      agentId: 'stub',
      sessionConfig: { workingDir: '/repo/demo' },
    });
    expect(res.ok).toBe(true);
    if ('sessionId' in res) {
      expect(typeof res.sessionId).toBe('string');
      expect(res.sessionId).not.toBe('');
    }

    // Wait for the stub adapter's events to flow through the EventBus.
    const events = await eventsPromise;
    expect(events.length).toBeGreaterThanOrEqual(13);
    // The first event is the AgentStarted from the CommandApi; the stub's
    // events follow. Verify we received stub-originated events.
    const types = events.map((e) => e.type);
    expect(types).toContain('AgentProgress');
    expect(types).toContain('ToolStarted');
    expect(types).toContain('ApprovalRequested');
    expect(types).toContain('AgentCompleted');

    // The session manager tracked the session while the stream was active.
    // With auto-cleanup (Bug 2 fix), the session is removed after the stream
    // ends, so we verify the session was active by checking that events
    // were received — which proves the SessionManager was piping events.
    // The auto-cleanup should have removed the session by now.
    await waitFor(() => !daemon.sessionManager$!.hasSession(task.id), 3000);
    expect(daemon.sessionManager$!.hasSession(task.id)).toBe(false);

    // The attention aggregator should have created items from the stub's
    // ApprovalRequested / AgentCompleted / AgentFailed events. Verify via
    // query-inbox.
    await waitFor(() => daemon.commandPlane !== null);
    const inboxRes = await sendCommand(client, { kind: 'query-inbox' });
    expect(inboxRes.ok).toBe(true);
    if ('items' in inboxRes) {
      expect(inboxRes.items.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('stop-task cancels and disconnects the adapter session', async () => {
    const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } })
      .db.connection;
    const { ProjectRepository, TaskRepository } = await import('../src/storage/index.js');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const project = buildProject({ name: 'demo', repo: { path: '/repo/demo' } });
    projects.insert(project);
    // Register a slow stub adapter so the session is still active when we
    // call stop-task. The default stub (no delay) completes its stream
    // immediately, which triggers auto-cleanup (Bug 2 fix) before we can
    // test the stop path.
    daemon.adapterRegistry$!.register('stub-slow', () => new StubAdapter(null, { delayMs: 5000 }));
    db.prepare(
      'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('stub-slow', 'Stub Slow', 'stub', 'E', JSON.stringify({ kind: 'cli' }), new Date().toISOString());
    const task = buildTask({ projectId: project.id, objective: 'Write tests' });
    tasks.insert(task);

    // Start the task first.
    const startRes = await sendCommand(client, {
      kind: 'start-task',
      taskId: task.id,
      agentId: 'stub-slow',
      sessionConfig: { workingDir: '/repo/demo' },
    });
    expect(startRes.ok).toBe(true);
    expect(daemon.sessionManager$!.hasSession(task.id)).toBe(true);

    // Now stop it.
    const stopRes = await sendCommand(client, { kind: 'stop-task', taskId: task.id });
    expect(stopRes.ok).toBe(true);

    // The session should be removed from the session manager.
    await waitFor(() => !daemon.sessionManager$!.hasSession(task.id));
    expect(daemon.sessionManager$!.hasSession(task.id)).toBe(false);
    expect(daemon.sessionManager$!.activeCount).toBe(0);
  });

  it('start-task with an unknown adapter id returns an error', async () => {
    const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } })
      .db.connection;
    const { ProjectRepository, TaskRepository } = await import('../src/storage/index.js');
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const project = buildProject({ name: 'demo', repo: { path: '/repo/demo' } });
    projects.insert(project);
    db.prepare(
      'INSERT INTO agents (id, name, provider, fidelity_tier, runtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('unknown-agent', 'Unknown', 'unknown', 'E', JSON.stringify({ kind: 'cli' }), new Date().toISOString());
    const task = buildTask({ projectId: project.id, objective: 'Write tests' });
    tasks.insert(task);

    const res = await sendCommand(client, {
      kind: 'start-task',
      taskId: task.id,
      agentId: 'unknown-agent',
      sessionConfig: { workingDir: '/repo/demo' },
    });
    expect(res.ok).toBe(false);
    if ('error' in res) {
      expect(res.error).toContain('Unknown or unavailable adapter');
    }
    // No session should be tracked.
    expect(daemon.sessionManager$!.activeCount).toBe(0);
  });
});

/* ================================================================== *
 * Tests: SessionManager direct unit tests
 * ================================================================== */

describe('SessionManager (direct)', () => {
  let bus: EventBus;
  let manager: SessionManager;

  beforeEach(() => {
    bus = new EventBus();
    manager = new SessionManager(bus);
  });

  afterEach(async () => {
    await manager.stopAll();
  });

  it('starts a session, pipes adapter events to the EventBus, and tracks it', async () => {
    const events = buildDefaultStubEvents({
      taskId: 'task-1',
      sessionId: 'session-1',
      agentId: 'stub',
    });
    // Use a custom adapter with the known event sequence.
    const adapterWithEvents = new StubAdapter(null, { events });

    const collected = collectEvents(bus, events.length);

    const result = await manager.startSession('task-1', 'stub', adapterWithEvents, {
      taskId: 'task-1',
      sessionId: 'session-1',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'Test objective',
    });

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('session-1');
    expect(manager.hasSession('task-1')).toBe(true);
    expect(manager.activeCount).toBe(1);

    const info = manager.getActiveSessions().get('task-1');
    expect(info).toBeDefined();
    expect(info!.agentId).toBe('stub');
    expect(info!.sessionId).toBe('session-1');
    expect(info!.adapter).toBe(adapterWithEvents);

    // All events should be piped to the bus.
    const received = await collected;
    expect(received).toHaveLength(events.length);
    expect(received.map((e) => e.type)).toEqual(events.map((e) => e.type));
  });

  it('stops a session: cancels and disconnects the adapter', async () => {
    // Use a stub with a delay so the stream is still active when we stop.
    const adapter = new StubAdapter(null, { delayMs: 500 });
    const result = await manager.startSession('task-1', 'stub', adapter, {
      taskId: 'task-1',
      sessionId: 'session-1',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'Test objective',
    });
    expect(result.ok).toBe(true);
    expect(manager.hasSession('task-1')).toBe(true);

    const stopResult = await manager.stopSession('task-1');
    expect(stopResult.ok).toBe(true);
    expect(manager.hasSession('task-1')).toBe(false);
    expect(manager.activeCount).toBe(0);
    // The adapter should be disconnected.
    expect(adapter.connectionState).toBe('disconnected');
  });

  it('returns an error when starting a session for a task that already has one', async () => {
    const adapter = new StubAdapter(null, { delayMs: 5000 });
    const result = await manager.startSession('task-1', 'stub', adapter, {
      taskId: 'task-1',
      sessionId: 'session-1',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'Test objective',
    });
    expect(result.ok).toBe(true);

    const second = await manager.startSession('task-1', 'stub', new StubAdapter(null), {
      taskId: 'task-1',
      sessionId: 'session-2',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'Test objective',
    });
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already has an active session');
  });

  it('returns an error when stopping a session that does not exist', async () => {
    const result = await manager.stopSession('nonexistent');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No active session');
  });

  it('stopAll stops every active session', async () => {
    const adapter1 = new StubAdapter(null, { delayMs: 5000 });
    const adapter2 = new StubAdapter(null, { delayMs: 5000 });
    await manager.startSession('task-1', 'stub', adapter1, {
      taskId: 'task-1',
      sessionId: 's1',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'A',
    });
    await manager.startSession('task-2', 'stub', adapter2, {
      taskId: 'task-2',
      sessionId: 's2',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'B',
    });
    expect(manager.activeCount).toBe(2);

    await manager.stopAll();
    expect(manager.activeCount).toBe(0);
    expect(adapter1.connectionState).toBe('disconnected');
    expect(adapter2.connectionState).toBe('disconnected');
  });

  it('getActiveSessions returns a copy that does not affect internal state', async () => {
    const adapter = new StubAdapter(null, { delayMs: 5000 });
    await manager.startSession('task-1', 'stub', adapter, {
      taskId: 'task-1',
      sessionId: 's1',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'A',
    });
    const snapshot = manager.getActiveSessions();
    expect(snapshot.size).toBe(1);
    snapshot.delete('task-1');
    // Internal state is unaffected.
    expect(manager.activeCount).toBe(1);
    expect(manager.hasSession('task-1')).toBe(true);
  });

  it('auto-removes the session and disconnects the adapter when the stream ends naturally', async () => {
    // Use a stub with no delay so the stream completes immediately.
    const adapter = new StubAdapter(null, { delayMs: 0 });
    const result = await manager.startSession('task-1', 'stub', adapter, {
      taskId: 'task-1',
      sessionId: 's1',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'A',
    });
    expect(result.ok).toBe(true);
    expect(manager.hasSession('task-1')).toBe(true);

    // Wait for the background event piping to complete and auto-cleanup
    // to run. The stub emits 13 events with no delay, so the stream ends
    // almost immediately. We poll until the session is removed.
    await waitFor(() => !manager.hasSession('task-1'), 3000);
    expect(manager.activeCount).toBe(0);
    expect(manager.hasSession('task-1')).toBe(false);
    // The adapter should be disconnected by the auto-cleanup.
    expect(adapter.connectionState).toBe('disconnected');
  });

  it('auto-cleanup allows starting a new session for the same task after completion', async () => {
    // First session: stub with no delay, stream completes immediately.
    const adapter1 = new StubAdapter(null, { delayMs: 0 });
    const result1 = await manager.startSession('task-1', 'stub', adapter1, {
      taskId: 'task-1',
      sessionId: 's1',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'A',
    });
    expect(result1.ok).toBe(true);

    // Wait for auto-cleanup.
    await waitFor(() => !manager.hasSession('task-1'), 3000);

    // Second session for the same task should succeed because the first
    // was auto-removed.
    const adapter2 = new StubAdapter(null, { delayMs: 5000 });
    const result2 = await manager.startSession('task-1', 'stub', adapter2, {
      taskId: 'task-1',
      sessionId: 's2',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'A',
    });
    expect(result2.ok).toBe(true);
    expect(manager.hasSession('task-1')).toBe(true);
  });
});
