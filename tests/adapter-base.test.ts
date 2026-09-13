import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

import { SecretaryDaemon, EventBus } from '../src/daemon/index.js';
import {
  StorageDatabase,
  EventRepository,
  ProjectRepository,
  TaskRepository,
  AgentRepository,
  SessionRepository,
} from '../src/storage/index.js';
import {
  buildEvent,
  buildProject,
  buildTask,
  buildAgent,
  buildSession,
} from '../src/domain/index.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import { SUPERVISOR_EVENT_TYPES, validateEvent } from '../src/domain/events.js';
import { AdapterFidelityTier } from '../src/domain/enums.js';

import {
  BaseAdapter,
  AdapterRegistry,
  StubAdapter,
  STUB_ADAPTER_ID,
  buildDefaultStubEvents,
  UnknownAdapterError,
  DuplicateAdapterError,
  type AgentAdapter,
  type SessionConfig,
  type StartRunResult,
} from '../src/adapters/index.js';

/**
 * Helper: create a unique lockfile path per test so single-instance checks
 * do not collide across tests or parallel runs.
 */
function uniqueLockfile(): string {
  return path.join(
    os.tmpdir(),
    `agent-secretary-adapter-test-${process.pid}-${Math.random().toString(36).slice(2)}.lock`,
  );
}

/** Helper: a minimal valid SessionConfig for stub runs. */
function sampleSessionConfig(): SessionConfig {
  return {
    taskId: 'task-stub-1',
    sessionId: 'sess-stub-1',
    agentId: 'stub',
    workingDir: '/repo/stub',
    objective: 'Stub objective',
  };
}

/* ------------------------------------------------------------------ *
 * 1. AgentAdapter interface defined with all required methods
 * ------------------------------------------------------------------ */
describe('AgentAdapter interface', () => {
  it('defines all required methods on the interface type', () => {
    // Compile-time check: a class implementing AgentAdapter must provide
    // every method. We use a minimal concrete implementation to verify the
    // interface shape is satisfiable.
    const minimal: AgentAdapter = {
      id: 'minimal',
      fidelityTier: AdapterFidelityTier.E,
      connectionState: 'disconnected',
      connect: async () => {},
      startRun: async (): Promise<StartRunResult> => ({ sessionId: 's', started: true }),
      streamEvents: async function* (): AsyncIterable<SupervisorEvent> {},
      cancel: async () => {},
      disconnect: async () => {},
    };
    expect(minimal.id).toBe('minimal');
    expect(minimal.fidelityTier).toBe(AdapterFidelityTier.E);
    expect(typeof minimal.connect).toBe('function');
    expect(typeof minimal.startRun).toBe('function');
    expect(typeof minimal.streamEvents).toBe('function');
    expect(typeof minimal.cancel).toBe('function');
    expect(typeof minimal.disconnect).toBe('function');
  });

  it('BaseAdapter is abstract and implements common functionality', () => {
    // BaseAdapter cannot be instantiated directly (abstract), but a concrete
    // subclass inherits connection state tracking and event emission.
    class TestAdapter extends BaseAdapter {
      async connect(): Promise<void> {
        this.setConnectionState('connecting');
        this.setConnectionState('connected');
      }
      async startRun(_taskId: string, _cfg: SessionConfig): Promise<StartRunResult> {
        this.requireConnected();
        return { sessionId: _cfg.sessionId, started: true };
      }
      async *streamEvents(): AsyncIterable<SupervisorEvent> {}
      async cancel(_sessionId: string): Promise<void> {}
      async disconnect(): Promise<void> {
        this.setConnectionState('disconnected');
      }
    }

    const adapter = new TestAdapter('test', AdapterFidelityTier.B);
    expect(adapter.id).toBe('test');
    expect(adapter.fidelityTier).toBe(AdapterFidelityTier.B);
    expect(adapter.connectionState).toBe('disconnected');
  });
});

/* ------------------------------------------------------------------ *
 * 2. Fidelity tier is declared by each adapter and queryable
 * ------------------------------------------------------------------ */
describe('fidelity tier declaration', () => {
  it.each([
    [AdapterFidelityTier.A, 'A'],
    [AdapterFidelityTier.B, 'B'],
    [AdapterFidelityTier.C, 'C'],
    [AdapterFidelityTier.D, 'D'],
    [AdapterFidelityTier.E, 'E'],
  ])('declares tier %s and is queryable via fidelityTier', (tier, expected) => {
    class TierAdapter extends BaseAdapter {
      async connect(): Promise<void> {
        this.setConnectionState('connecting');
        this.setConnectionState('connected');
      }
      async startRun(_t: string, c: SessionConfig): Promise<StartRunResult> {
        return { sessionId: c.sessionId, started: true };
      }
      async *streamEvents(): AsyncIterable<SupervisorEvent> {}
      async cancel(_s: string): Promise<void> {}
      async disconnect(): Promise<void> {}
    }
    const adapter = new TierAdapter(`tier-${expected}`, tier);
    expect(adapter.fidelityTier).toBe(expected);
  });

  it('StubAdapter declares tier E', () => {
    const stub = new StubAdapter(null);
    expect(stub.fidelityTier).toBe(AdapterFidelityTier.E);
    expect(stub.id).toBe(STUB_ADAPTER_ID);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Stub adapter emits synthetic events across all 21 variants
 * ------------------------------------------------------------------ */
describe('StubAdapter event emission', () => {
  it('buildDefaultStubEvents produces all 21 variants', () => {
    const events = buildDefaultStubEvents({
      taskId: 'task-1',
      sessionId: 'sess-1',
      agentId: 'stub',
    });
    expect(events).toHaveLength(21);
    const types = events.map((e) => e.type);
    // Every canonical variant is present exactly once.
    for (const kind of SUPERVISOR_EVENT_TYPES) {
      expect(types).toContain(kind);
    }
    expect(new Set(types).size).toBe(21);
  });

  it('every default stub event validates against the schema', () => {
    const events = buildDefaultStubEvents({
      taskId: 'task-1',
      sessionId: 'sess-1',
      agentId: 'stub',
    });
    for (const event of events) {
      expect(() => validateEvent(event)).not.toThrow();
    }
  });

  it('connects, starts a run, and streams all 21 events', async () => {
    const stub = new StubAdapter(null);
    expect(stub.connectionState).toBe('disconnected');

    await stub.connect();
    expect(stub.connectionState).toBe('connected');

    const result = await stub.startRun('task-stub-1', sampleSessionConfig());
    expect(result.started).toBe(true);
    expect(result.sessionId).toBe('sess-stub-1');

    const collected: SupervisorEvent[] = [];
    for await (const event of stub.streamEvents()) {
      collected.push(event);
    }
    expect(collected).toHaveLength(21);
    expect(collected.map((e) => e.type)).toEqual([...SUPERVISOR_EVENT_TYPES]);

    await stub.disconnect();
    expect(stub.connectionState).toBe('disconnected');
  });

  it('emits a configurable custom event sequence', async () => {
    const custom: SupervisorEvent[] = [
      {
        type: 'AgentStarted',
        timestamp: new Date().toISOString(),
        taskId: 'task-custom',
        sessionId: 'sess-custom',
        agentId: 'stub',
        adapterFidelityTier: AdapterFidelityTier.E,
        objective: 'Custom objective',
        workingDir: '/repo',
      },
      {
        type: 'AgentCompleted',
        timestamp: new Date().toISOString(),
        taskId: 'task-custom',
        sessionId: 'sess-custom',
        agentId: 'stub',
        adapterFidelityTier: AdapterFidelityTier.E,
        summary: 'Custom done',
        deliverables: [],
        exitCode: 0,
      },
    ];
    const stub = new StubAdapter(null, { events: custom });
    await stub.connect();
    await stub.startRun('task-custom', {
      taskId: 'task-custom',
      sessionId: 'sess-custom',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'Custom objective',
    });
    const collected: SupervisorEvent[] = [];
    for await (const event of stub.streamEvents()) {
      collected.push(event);
    }
    expect(collected).toHaveLength(2);
    expect(collected[0].type).toBe('AgentStarted');
    expect(collected[1].type).toBe('AgentCompleted');
    await stub.disconnect();
  });

  it('cancel stops event emission', async () => {
    // Provide 5 events; cancel after the first so only 1 is emitted.
    const events = buildDefaultStubEvents({
      taskId: 'task-cancel',
      sessionId: 'sess-cancel',
      agentId: 'stub',
    }).slice(0, 5);
    const stub = new StubAdapter(null, { events });
    await stub.connect();
    await stub.startRun('task-cancel', {
      taskId: 'task-cancel',
      sessionId: 'sess-cancel',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'Cancel test',
    });

    const collected: SupervisorEvent[] = [];
    const iter = stub.streamEvents();
    for await (const event of iter) {
      collected.push(event);
      await stub.cancel('sess-cancel');
    }
    expect(collected.length).toBe(1);
    await stub.disconnect();
  });

  it('startRun throws when not connected', async () => {
    const stub = new StubAdapter(null);
    await expect(stub.startRun('t', sampleSessionConfig())).rejects.toThrow(/not connected/);
  });

  it('startRun throws when a session is already active', async () => {
    const stub = new StubAdapter(null);
    await stub.connect();
    await stub.startRun('t', sampleSessionConfig());
    await expect(stub.startRun('t', sampleSessionConfig())).rejects.toThrow(/already has an active/);
    await stub.disconnect();
  });
});

/* ------------------------------------------------------------------ *
 * 4. Adapter registry can select and instantiate an adapter by id
 * ------------------------------------------------------------------ */
describe('AdapterRegistry', () => {
  it('registers, checks, lists, and creates adapters', () => {
    const registry = new AdapterRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.has('stub')).toBe(false);

    registry.register('stub', (bus) => new StubAdapter(bus));
    expect(registry.has('stub')).toBe(true);
    expect(registry.list()).toEqual(['stub']);

    // Create with a real EventBus.
    const bus = new EventBus();
    const adapter = registry.create('stub', bus);
    expect(adapter).toBeInstanceOf(StubAdapter);
    expect(adapter.id).toBe('stub');
    expect(adapter.fidelityTier).toBe(AdapterFidelityTier.E);
  });

  it('get throws UnknownAdapterError for unregistered ids', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.get('nope')).toThrow(UnknownAdapterError);
    expect(() => registry.create('nope', new EventBus())).toThrow(UnknownAdapterError);
  });

  it('register throws DuplicateAdapterError on double registration', () => {
    const registry = new AdapterRegistry();
    registry.register('stub', (bus) => new StubAdapter(bus));
    expect(() => registry.register('stub', (bus) => new StubAdapter(bus))).toThrow(
      DuplicateAdapterError,
    );
  });

  it('can register multiple adapters and list them', () => {
    const registry = new AdapterRegistry();
    registry.register('stub', (bus) => new StubAdapter(bus));
    registry.register('stub-2', (bus) => new StubAdapter(bus, { delayMs: 1 }));
    expect(registry.list().sort()).toEqual(['stub', 'stub-2']);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Integration test: daemon + stub adapter + journal records events
 * ------------------------------------------------------------------ */
/**
 * Seed the journal database with the parent rows (project, task, agent,
 * session) required by the events table's foreign-key constraints. Returns
 * the ids used so the test can reference them.
 */
function seedJournal(db: StorageDatabase, cfg: SessionConfig): {
  projectId: string;
  taskId: string;
  agentId: string;
  sessionId: string;
} {
  const projects = new ProjectRepository(db.connection);
  const tasks = new TaskRepository(db.connection);
  const agents = new AgentRepository(db.connection);
  const sessions = new SessionRepository(db.connection);

  const projectId = 'proj-stub';
  const project = buildProject({
    id: projectId,
    name: 'Stub Project',
    repo: { path: '/repo/stub' },
  });
  projects.insert(project);

  const task = buildTask({
    id: cfg.taskId,
    projectId,
    objective: cfg.objective,
    worktreePath: cfg.workingDir,
  });
  tasks.insert(task);

  const agent = buildAgent({
    id: cfg.agentId,
    name: 'Stub Agent',
    provider: 'stub',
    fidelityTier: AdapterFidelityTier.E,
    runtime: { kind: 'cli' },
  });
  agents.insert(agent);

  const session = buildSession({
    id: cfg.sessionId,
    taskId: cfg.taskId,
    agentId: cfg.agentId,
  });
  sessions.insert(session);

  return { projectId, taskId: cfg.taskId, agentId: cfg.agentId, sessionId: cfg.sessionId };
}

describe('integration: daemon + stub adapter + event journal', () => {
  let lockfile: string;
  let daemon: SecretaryDaemon;
  let journalDb: StorageDatabase;
  let events: EventRepository;

  beforeEach(async () => {
    lockfile = uniqueLockfile();
    // The journal uses its own ephemeral in-memory database. In the full
    // system the daemon will wire adapter events to its internal journal; for
    // this integration test we subscribe to the daemon's EventBus and append
    // each event to a dedicated EventRepository, exercising the full
    // adapter -> bus -> journal pipeline.
    journalDb = new StorageDatabase({ path: ':memory:' });
    journalDb.open();
    events = new EventRepository(journalDb.connection);

    daemon = new SecretaryDaemon({
      port: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
    });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    journalDb.close();
    try {
      // lockfile cleanup
      const fs = await import('node:fs');
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('stub adapter events flow through the daemon EventBus into the journal', async () => {
    const bus = daemon.eventBus!;
    expect(bus).toBeDefined();

    const sessionConfig = sampleSessionConfig();
    seedJournal(journalDb, sessionConfig);

    // Wire EventBus events into the journal: each published SupervisorEvent
    // is appended to the EventRepository as an immutable journal row.
    const unsubscribe = bus.onEvent((event: SupervisorEvent) => {
      const journalEvent = buildEvent({
        sessionId: event.sessionId,
        taskId: event.taskId,
        kind: event.type,
        payload: event as unknown as Readonly<Record<string, unknown>>,
      });
      events.insert(journalEvent);
    });

    try {
      // Create a stub adapter wired to the daemon's EventBus.
      const stub = new StubAdapter(bus);
      await stub.connect();

      await stub.startRun(sessionConfig.taskId, sessionConfig);

      // Consume the full event stream.
      for await (const _event of stub.streamEvents()) {
        // Events are journaled by the EventBus listener above.
      }

      await stub.disconnect();

      // Verify all 21 events landed in the journal for this session.
      const journaled = events.listBySession(sessionConfig.sessionId);
      expect(journaled).toHaveLength(21);

      const journaledKinds = journaled.map((e) => e.kind);
      for (const kind of SUPERVISOR_EVENT_TYPES) {
        expect(journaledKinds).toContain(kind);
      }

      // Every journaled event carries the correct task and session ids.
      for (const row of journaled) {
        expect(row.taskId).toBe(sessionConfig.taskId);
        expect(row.sessionId).toBe(sessionConfig.sessionId);
      }
    } finally {
      unsubscribe();
    }
  });

  it('stub adapter events are also broadcast to live EventBus subscribers', async () => {
    const bus = daemon.eventBus!;
    const received: SupervisorEvent[] = [];
    const unsubscribe = bus.onEvent((event: SupervisorEvent) => {
      received.push(event);
    });

    try {
      const stub = new StubAdapter(bus);
      await stub.connect();
      const cfg = sampleSessionConfig();
      await stub.startRun(cfg.taskId, cfg);
      for await (const _event of stub.streamEvents()) {
        // drain
      }
      await stub.disconnect();

      expect(received).toHaveLength(21);
    } finally {
      unsubscribe();
    }
  });

  it('registry-created stub adapter wired to the daemon bus journals events', async () => {
    const bus = daemon.eventBus!;
    const registry = new AdapterRegistry();
    registry.register(STUB_ADAPTER_ID, (b) => new StubAdapter(b));

    const cfg: SessionConfig = {
      taskId: 'task-registry',
      sessionId: 'sess-registry',
      agentId: 'stub',
      workingDir: '/repo',
      objective: 'Registry integration',
    };
    seedJournal(journalDb, cfg);

    const unsubscribe = bus.onEvent((event: SupervisorEvent) => {
      events.insert(
        buildEvent({
          sessionId: event.sessionId,
          taskId: event.taskId,
          kind: event.type,
          payload: event as unknown as Readonly<Record<string, unknown>>,
        }),
      );
    });

    try {
      const adapter = registry.create(STUB_ADAPTER_ID, bus);
      await adapter.connect();
      await adapter.startRun(cfg.taskId, cfg);
      for await (const _event of adapter.streamEvents()) {
        // drain
      }
      await adapter.disconnect();

      const journaled = events.listBySession('sess-registry');
      expect(journaled).toHaveLength(21);
    } finally {
      unsubscribe();
    }
  });
});
