/**
 * End-to-end integration test: daemon + CLI client + stub adapter +
 * attention engine + metrics (issue #39).
 *
 * This is a true full-stack E2E test: it starts a real SecretaryDaemon
 * bound to a localhost WebSocket port with an in-memory SQLite database,
 * connects real {@link DaemonClient} instances over the actual WebSocket
 * transport (no mocks), and exercises the complete command lifecycle
 * through the typed Command API.
 *
 * Three test groups:
 * 1. **Full lifecycle** — start-task → query-metrics → query-inbox →
 *    approve → stop-task → shutdown, verifying that every daemon
 *    subsystem (CommandApi, SessionManager, AdapterRegistry, MetricsCollector,
 *    AttentionAggregator, EventBus) cooperates end-to-end.
 * 2. **Error scenarios** — connection refused, invalid command kind,
 *    unknown agentId, stop-task on a non-existent task.
 * 3. **Multi-surface** — two simultaneous DaemonClients (simulating CLI +
 *    desktop) both query independently and observe shared state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import { SecretaryDaemon, type Command } from '../src/daemon/index.js';
import { DaemonClient, DaemonConnectionError } from '../src/cli/client.js';
import {
  ProjectRepository,
  TaskRepository,
  AgentRepository,
  ApprovalRepository,
} from '../src/storage/index.js';
import { buildProject, buildTask, buildAgent, buildApproval } from '../src/domain/index.js';
import { AdapterFidelityTier } from '../src/domain/enums.js';

/* ================================================================== *
 * Helpers
 * ================================================================== */

/**
 * Create a unique lockfile path per test so single-instance checks do
 * not collide across tests or parallel runs.
 */
function uniqueLockfile(): string {
  return path.join(
    os.tmpdir(),
    `agent-secretary-e2e-${process.pid}-${Math.random().toString(36).slice(2)}.lock`,
  );
}

/**
 * Type-safe accessor for the daemon's internal database connection.
 * The daemon keeps `db` private; tests reach it via this cast (the same
 * pattern used by the existing integration tests).
 */
function getDb(daemon: SecretaryDaemon): Database.Database {
  return (daemon as unknown as { db: { connection: Database.Database } }).db.connection;
}

/**
 * Seed a project, a stub agent, and a task into the daemon's storage
 * layer. Returns the created project and task so tests can reference
 * their ids.
 */
function seedProjectAndTask(daemon: SecretaryDaemon): {
  projectId: string;
  taskId: string;
} {
  const db = getDb(daemon);
  const projects = new ProjectRepository(db);
  const tasks = new TaskRepository(db);
  const agents = new AgentRepository(db);

  const project = buildProject({ name: 'e2e-demo', repo: { path: '/repo/e2e' } });
  projects.insert(project);

  const agent = buildAgent({
    id: 'stub',
    name: 'Stub',
    provider: 'stub',
    fidelityTier: AdapterFidelityTier.E,
    runtime: { kind: 'cli' },
  });
  agents.insert(agent);

  const task = buildTask({ projectId: project.id, objective: 'E2E test objective' });
  tasks.insert(task);

  return { projectId: project.id, taskId: task.id };
}

/**
 * Seed a pending approval row for a task so the `approve` command can
 * resolve it. Returns the approval id.
 */
function seedApproval(daemon: SecretaryDaemon, taskId: string): string {
  const db = getDb(daemon);
  const approvals = new ApprovalRepository(db);
  const approval = buildApproval({
    taskId,
    capability: 'network',
    destination: 'registry.npmjs.org',
  });
  approvals.insert(approval);
  return approval.id;
}

/**
 * Wait for a condition to become true, polling at a short interval.
 * Rejects with a timeout error if the condition is not met within
 * `timeoutMs`. Uses real timers (not fake) so async adapter event
 * piping progresses naturally.
 */
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

/**
 * Sum the total event count from a metrics snapshot's eventsEmitted
 * counter map.
 */
function totalEvents(snapshot: { counters: { eventsEmitted: Record<string, number> } }): number {
  return Object.values(snapshot.counters.eventsEmitted).reduce((a, b) => a + b, 0);
}

/* ================================================================== *
 * 1. Full lifecycle
 * ================================================================== */

describe('e2e: full daemon lifecycle (#39)', () => {
  let lockfile: string;
  let daemon: SecretaryDaemon;
  let client: DaemonClient;
  let taskId: string;

  beforeEach(async () => {
    lockfile = uniqueLockfile();
    daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.start();
    const seeded = seedProjectAndTask(daemon);
    taskId = seeded.taskId;
    client = new DaemonClient({ port: daemon.port, timeoutMs: 5000 });
  });

  afterEach(async () => {
    await daemon.stop();
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('start-task → query-metrics → query-inbox → approve → stop-task → shutdown', async () => {
    // --- start-task -------------------------------------------------
    const startRes = await client.send({
      kind: 'start-task',
      taskId,
      agentId: 'stub',
      sessionConfig: { workingDir: '/repo/e2e' },
    });
    expect(startRes.ok).toBe(true);
    expect('sessionId' in startRes).toBe(true);
    if ('sessionId' in startRes) {
      expect(typeof startRes.sessionId).toBe('string');
      expect(startRes.sessionId).not.toBe('');
    }

    // --- wait for stub adapter events to flow through the bus -------
    // The stub emits 13 events; plus the AgentStarted from CommandApi.
    // Wait until the metrics collector has recorded a healthy number.
    await waitFor(() => {
      const snap = daemon.commandPlane;
      return snap !== null;
    });
    await waitFor(() => {
      // Access the metrics collector via the command plane's snapshot.
      // We query through the client to exercise the full WebSocket path.
      return true;
    });

    // --- query-metrics (via WebSocket) ------------------------------
    // Wait until events have been counted by the MetricsCollector.
    await waitFor(() => {
      const mc = (daemon as unknown as {
        metricsCollector: { snapshot: () => { counters: { eventsEmitted: Record<string, number> } } };
      }).metricsCollector;
      return totalEvents(mc.snapshot()) >= 5;
    });

    const metricsRes = await client.send({ kind: 'query-metrics' });
    expect(metricsRes.ok).toBe(true);
    expect('snapshot' in metricsRes).toBe(true);
    if ('snapshot' in metricsRes && metricsRes.snapshot) {
      const snap = metricsRes.snapshot;
      expect(snap.counters.tasksStarted).toBeGreaterThanOrEqual(1);
      // The stub emits ToolStarted/ToolFinished, ApprovalRequested, etc.
      expect(totalEvents(snap)).toBeGreaterThanOrEqual(5);
      expect(snap.counters.eventsEmitted['AgentStarted']).toBeGreaterThanOrEqual(1);
    }

    // --- query-inbox (via WebSocket) --------------------------------
    // Wait until the AttentionAggregator has created items from the
    // stub's ApprovalRequested / AgentCompleted / AgentFailed events.
    await waitFor(() => {
      const inbox = (daemon as unknown as {
        attentionInbox: { size: number };
      }).attentionInbox;
      return inbox.size >= 1;
    });

    const inboxRes = await client.send({ kind: 'query-inbox' });
    expect(inboxRes.ok).toBe(true);
    expect('items' in inboxRes).toBe(true);
    if ('items' in inboxRes) {
      expect(inboxRes.items.length).toBeGreaterThanOrEqual(1);
      // The stub emits an ApprovalRequested event, which the aggregator
      // turns into an ApprovalRequest attention item.
      const kinds = inboxRes.items.map((i) => i.kind);
      expect(kinds).toContain('ApprovalRequest');
    }

    // --- approve ----------------------------------------------------
    // Seed an approval row (the approve command operates on the
    // approvals table, not the attention inbox) and grant it.
    const approvalId = seedApproval(daemon, taskId);
    const approveRes = await client.send({
      kind: 'approve',
      taskId,
      approvalId,
      decision: 'grant',
    });
    expect(approveRes.ok).toBe(true);
    expect('approvalId' in approveRes).toBe(true);
    if ('approvalId' in approveRes) {
      expect(approveRes.approvalId).toBe(approvalId);
    }

    // --- stop-task --------------------------------------------------
    const stopRes = await client.send({ kind: 'stop-task', taskId });
    expect(stopRes.ok).toBe(true);
    expect('taskId' in stopRes).toBe(true);
    if ('taskId' in stopRes) {
      expect(stopRes.taskId).toBe(taskId);
    }

    // The session should be removed from the session manager.
    await waitFor(() => !daemon.sessionManager$!.hasSession(taskId));
    expect(daemon.sessionManager$!.hasSession(taskId)).toBe(false);

    // --- shutdown ---------------------------------------------------
    const shutdownRes = await client.send({ kind: 'shutdown' });
    expect(shutdownRes.ok).toBe(true);

    // The daemon's onShutdown callback calls stop(); wait for it.
    await waitFor(() => daemon.currentState === 'stopped');
    expect(daemon.currentState).toBe('stopped');
    expect(daemon.isRunning).toBe(false);
  });
});

/* ================================================================== *
 * 2. Error scenarios
 * ================================================================== */

describe('e2e: error scenarios (#39)', () => {
  let lockfile: string;
  let daemon: SecretaryDaemon;
  let client: DaemonClient;
  let taskId: string;

  beforeEach(async () => {
    lockfile = uniqueLockfile();
    daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.start();
    const seeded = seedProjectAndTask(daemon);
    taskId = seeded.taskId;
    client = new DaemonClient({ port: daemon.port, timeoutMs: 5000 });
  });

  afterEach(async () => {
    await daemon.stop();
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('connection refused: connecting to an unused port rejects with DaemonConnectionError', async () => {
    // Pick a high random port that is almost certainly unused.
    const unusedPort = 18000 + Math.floor(Math.random() * 1000);
    const badClient = new DaemonClient({ port: unusedPort, timeoutMs: 1000 });
    await expect(badClient.send({ kind: 'query-metrics' })).rejects.toThrow(
      DaemonConnectionError,
    );
  });

  it('invalid command kind: returns an UnknownCommandResponse', async () => {
    const res = await client.send({ kind: 'bogus-command' } as unknown as Command);
    expect(res.ok).toBe(false);
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error).toContain('Unknown command kind');
    }
  });

  it('start-task with an unknown agentId returns an error and leaves task state clean for retry', async () => {
    // Seed an agent row so the sessions FK constraint (agent_id →
    // agents.id) is satisfied; the failure we want to verify is at the
    // adapter-registry lookup. The agent id is NOT registered in the
    // AdapterRegistry, so the registry's create() throws "Unknown or
    // unavailable adapter".
    //
    // The adapter lookup now happens BEFORE any DB mutations (Bug 1 fix),
    // so a failed start-task must leave the task in its original state
    // with no phantom session row, allowing the caller to retry.
    const db = getDb(daemon);
    const agents = new AgentRepository(db);
    agents.insert(
      buildAgent({
        id: 'unregistered-agent',
        name: 'Unregistered',
        provider: 'unknown',
        fidelityTier: AdapterFidelityTier.E,
        runtime: { kind: 'cli' },
      }),
    );

    // Capture the original task state before the failed start.
    const taskRepo = new TaskRepository(db);
    const taskBefore = taskRepo.getById(taskId);
    expect(taskBefore).not.toBeNull();
    const originalSessionIds = taskBefore!.sessionIds.length;
    const originalAgentIds = taskBefore!.agentIds.length;

    const res = await client.send({
      kind: 'start-task',
      taskId,
      agentId: 'unregistered-agent',
      sessionConfig: { workingDir: '/repo/e2e' },
    });
    expect(res.ok).toBe(false);
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error).toContain('Unknown or unavailable adapter');
    }
    // No session should be tracked.
    expect(daemon.sessionManager$!.activeCount).toBe(0);

    // The task must be in its original state — no phantom session or agent.
    const taskAfter = taskRepo.getById(taskId);
    expect(taskAfter).not.toBeNull();
    expect(taskAfter!.state).toBe(taskBefore!.state);
    expect(taskAfter!.sessionIds).toHaveLength(originalSessionIds);
    expect(taskAfter!.agentIds).toHaveLength(originalAgentIds);

    // The caller can retry with the registered stub agent and succeed.
    const retryRes = await client.send({
      kind: 'start-task',
      taskId,
      agentId: 'stub',
      sessionConfig: { workingDir: '/repo/e2e' },
    });
    expect(retryRes.ok).toBe(true);
  });

  it('stop-task with a non-existent task returns an error response', async () => {
    const res = await client.send({
      kind: 'stop-task',
      taskId: 'task_does_not_exist',
    });
    expect(res.ok).toBe(false);
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error).toContain('Task not found');
    }
  });
});

/* ================================================================== *
 * 3. Multi-surface
 * ================================================================== */

describe('e2e: multi-surface (CLI + desktop) (#39)', () => {
  let lockfile: string;
  let daemon: SecretaryDaemon;
  let cli: DaemonClient;
  let desktop: DaemonClient;
  let taskId: string;

  beforeEach(async () => {
    lockfile = uniqueLockfile();
    daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.start();
    const seeded = seedProjectAndTask(daemon);
    taskId = seeded.taskId;
    cli = new DaemonClient({ port: daemon.port, timeoutMs: 5000 });
    desktop = new DaemonClient({ port: daemon.port, timeoutMs: 5000 });
  });

  afterEach(async () => {
    await daemon.stop();
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('two clients can query independently and observe shared state', async () => {
    // Both clients can independently query the (empty) inbox.
    const cliInbox = await cli.send({ kind: 'query-inbox' });
    const desktopInbox = await desktop.send({ kind: 'query-inbox' });
    expect(cliInbox.ok).toBe(true);
    expect(desktopInbox.ok).toBe(true);
    if ('items' in cliInbox && 'items' in desktopInbox) {
      expect(cliInbox.items).toEqual([]);
      expect(desktopInbox.items).toEqual([]);
    }

    // Both clients can independently query metrics.
    const cliMetrics = await cli.send({ kind: 'query-metrics' });
    const desktopMetrics = await desktop.send({ kind: 'query-metrics' });
    expect(cliMetrics.ok).toBe(true);
    expect(desktopMetrics.ok).toBe(true);

    // The CLI client starts a task; the stub adapter emits events.
    const startRes = await cli.send({
      kind: 'start-task',
      taskId,
      agentId: 'stub',
      sessionConfig: { workingDir: '/repo/e2e' },
    });
    expect(startRes.ok).toBe(true);

    // Wait for the stub's events to flow through the EventBus and be
    // counted by the MetricsCollector (shared daemon state).
    await waitFor(() => {
      const mc = (daemon as unknown as {
        metricsCollector: { snapshot: () => { counters: { eventsEmitted: Record<string, number> } } };
      }).metricsCollector;
      return totalEvents(mc.snapshot()) >= 5;
    });

    // The desktop client — which did NOT start the task — can still
    // observe the events via a metrics query, because both clients
    // talk to the same daemon / EventBus / MetricsCollector.
    const desktopMetricsAfter = await desktop.send({ kind: 'query-metrics' });
    expect(desktopMetricsAfter.ok).toBe(true);
    if ('snapshot' in desktopMetricsAfter && desktopMetricsAfter.snapshot) {
      expect(totalEvents(desktopMetricsAfter.snapshot)).toBeGreaterThanOrEqual(5);
      expect(desktopMetricsAfter.snapshot.counters.tasksStarted).toBeGreaterThanOrEqual(1);
    }

    // The CLI client also sees the same metrics.
    const cliMetricsAfter = await cli.send({ kind: 'query-metrics' });
    expect(cliMetricsAfter.ok).toBe(true);
    if ('snapshot' in cliMetricsAfter && cliMetricsAfter.snapshot) {
      expect(totalEvents(cliMetricsAfter.snapshot)).toBeGreaterThanOrEqual(5);
    }

    // Wait for attention items to appear, then verify both clients see them.
    await waitFor(() => {
      const inbox = (daemon as unknown as { attentionInbox: { size: number } }).attentionInbox;
      return inbox.size >= 1;
    });

    const cliInboxAfter = await cli.send({ kind: 'query-inbox' });
    const desktopInboxAfter = await desktop.send({ kind: 'query-inbox' });
    expect(cliInboxAfter.ok).toBe(true);
    expect(desktopInboxAfter.ok).toBe(true);
    if ('items' in cliInboxAfter && 'items' in desktopInboxAfter) {
      expect(cliInboxAfter.items.length).toBeGreaterThanOrEqual(1);
      expect(desktopInboxAfter.items.length).toBeGreaterThanOrEqual(1);
      // Both clients see the same number of items (shared inbox).
      expect(desktopInboxAfter.items.length).toBe(cliInboxAfter.items.length);
    }
  });
});
