/**
 * Session pool (issue #342): sessions that end with `AgentCompleted`
 * are released live into a per-provider+project reuse cache; the next
 * same-key task attaches with between-task context maintenance instead
 * of spawning fresh. The pool is a cache, not a leak — stops, failures,
 * broken streams, expiry, and shutdown all end sessions honestly.
 */
import { describe, it, expect } from 'vitest';

import { SessionManager } from '../src/core/application/use-cases/tasks/session-manager.js';
import type { SessionConfig } from '../src/core/application/ports/outbound/agent-runtime.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import { StubAdapter } from '../src/adapters/outbound/agents/stub-adapter.js';
import type { SupervisorEvent, AgentFailedEvent } from '../src/core/domain/events.js';

const AGENT = 'stub';
const PROJECT = 'proj-1';

function config(taskId: string, sessionId: string, projectId = PROJECT): SessionConfig {
  return {
    taskId,
    sessionId,
    agentId: AGENT,
    workingDir: '/wt',
    objective: `objective for ${taskId}`,
    projectId,
  };
}

/**
 * A realistic stub work sequence ending with the terminal event — the
 * canned 28-kind schema sequence is coverage plumbing, not a session
 * simulation (terminal events sit mid-stream). The stub restamps these
 * onto each run's envelope, so follow-up turns keep task/run identity.
 */
/**
 * Realistic stub work sequences — the canned 28-kind schema sequence is
 * coverage plumbing, not a session simulation (terminal events sit
 * mid-stream). Envelope ids are placeholders: the stub restamps them
 * onto each run's config, so follow-up turns keep task/run identity.
 */
function workScript(): SupervisorEvent[] {
  const base = {
    timestamp: new Date().toISOString(),
    taskId: 't',
    sessionId: 's',
    agentId: AGENT,
    adapterFidelityTier: 'E' as const,
  };
  return [
    { ...base, type: 'AgentStarted', objective: 'work', workingDir: '/wt' },
    { ...base, type: 'AgentProgress', message: 'working' },
    {
      ...base,
      type: 'AgentCompleted',
      summary: 'done',
      deliverables: [],
      exitCode: 0,
      durationMs: 1,
    },
  ];
}

function failScript(): SupervisorEvent[] {
  return [
    {
      timestamp: new Date().toISOString(),
      taskId: 't',
      sessionId: 's',
      agentId: AGENT,
      adapterFidelityTier: 'E',
      type: 'AgentStarted',
      objective: 'work',
      workingDir: '/wt',
    },
    {
      timestamp: new Date().toISOString(),
      taskId: 't',
      sessionId: 's',
      agentId: AGENT,
      adapterFidelityTier: 'E',
      type: 'AgentFailed',
      error: 'boom',
      exitCode: 1,
      recoverable: false,
    } satisfies AgentFailedEvent,
  ];
}

/** A stub adapter scripted with a realistic completing work sequence. */
function completingStub(extra: ConstructorParameters<typeof StubAdapter>[1] = {}) {
  return new StubAdapter(null, { events: workScript(), ...extra });
}

/** Wait until a condition holds — sessions settle asynchronously. */
async function settle(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('settle: condition not met');
}

interface Fixture {
  sm: SessionManager;
  events: SupervisorEvent[];
  ended: { taskId: string; sessionId: string }[];
  carryovers: string[];
  now: { t: number };
}

function fixture(opts: { pool?: boolean; carryovers?: Record<string, string> } = {}): Fixture {
  const bus = new EventBus();
  const events: SupervisorEvent[] = [];
  bus.onEvent((e) => events.push(e));
  const f: Fixture = {
    sm: undefined as unknown as SessionManager,
    events,
    ended: [],
    carryovers: [],
    now: { t: 1_000_000 },
  };
  f.sm = new SessionManager(bus, {
    onSessionEnd: (taskId, sessionId) => {
      f.ended.push({ taskId, sessionId });
    },
    ...(opts.pool !== false
      ? {
          sessionPool: {
            now: () => f.now.t,
            carryoverResolver: async (taskId) => {
              f.carryovers.push(taskId);
              return opts.carryovers?.[taskId] ?? `digest for ${taskId}`;
            },
          },
        }
      : {}),
  });
  return f;
}

const eventsOf = (f: Fixture, type: SupervisorEvent['type']) =>
  f.events.filter((e) => e.type === type);

describe('session pool — release', () => {
  it('a session ending with AgentCompleted is pooled live, not disconnected', async () => {
    const f = fixture();
    const adapter = completingStub();
    await f.sm.startSession('task-1', AGENT, adapter, config('task-1', 'sess-1'));

    await settle(() => f.sm.pooledCount === 1);

    expect(adapter.connectionState).toBe('connected');
    expect(f.sm.activeCount).toBe(0);
    const pooled = eventsOf(f, 'SessionPooled');
    expect(pooled).toHaveLength(1);
    expect((pooled[0] as { poolKey: string }).poolKey).toBe('stub::proj-1');
    expect(f.ended).toEqual([{ taskId: 'task-1', sessionId: 'sess-1' }]);
  });

  it('a session ending in AgentFailed is torn down, never pooled', async () => {
    const f = fixture();
    const adapter = new StubAdapter(null, { events: failScript() });
    await f.sm.startSession('task-1', AGENT, adapter, config('task-1', 'sess-1'));

    await settle(() => f.sm.activeCount === 0 && f.ended.length === 1);

    expect(f.sm.pooledCount).toBe(0);
    expect(adapter.connectionState).toBe('disconnected');
    expect(eventsOf(f, 'SessionPooled')).toHaveLength(0);
  });

  it('an explicit stopSession never pools the session', async () => {
    const f = fixture();
    const adapter = completingStub({ delayMs: 20 });
    await f.sm.startSession('task-1', AGENT, adapter, config('task-1', 'sess-1'));
    await f.sm.stopSession('task-1');

    expect(f.sm.pooledCount).toBe(0);
    expect(adapter.connectionState).toBe('disconnected');
  });

  it('without sessionPool options every completed session is torn down (pre-#342 behavior)', async () => {
    const f = fixture({ pool: false });
    const adapter = completingStub();
    await f.sm.startSession('task-1', AGENT, adapter, config('task-1', 'sess-1'));

    await settle(() => f.sm.activeCount === 0 && f.ended.length === 1);

    expect(adapter.connectionState).toBe('disconnected');
    expect(eventsOf(f, 'SessionPooled')).toHaveLength(0);
  });
});

describe('session pool — attach', () => {
  it('compacted reuse: second same-key task binds the kept session and gets the new run id', async () => {
    const f = fixture();
    const first = completingStub();
    await f.sm.startSession('task-1', AGENT, first, config('task-1', 'sess-1'));
    await settle(() => f.sm.pooledCount === 1);

    // The caller constructs a fresh adapter per dispatch — reuse must
    // bind the POOLED adapter and leave this one unused.
    const second = completingStub();
    const res = await f.sm.startSession('task-2', AGENT, second, config('task-2', 'sess-2'));

    expect(res).toEqual({ ok: true, sessionId: 'sess-2' });
    expect(second.connectionState).toBe('disconnected');
    expect(first.sentMessages).toEqual([{ sessionId: 'sess-2', message: 'objective for task-2' }]);
    expect(first.maintainCalls).toEqual([{ sessionId: 'sess-1', carryover: 'digest for task-1' }]);

    await settle(() => f.ended.some((e) => e.taskId === 'task-2'));

    const maintained = eventsOf(f, 'ContextMaintained');
    expect(maintained).toHaveLength(1);
    expect((maintained[0] as { mode: string }).mode).toBe('compacted');
    const reused = eventsOf(f, 'SessionReused');
    expect(reused).toHaveLength(1);
    expect(reused[0]).toMatchObject({
      taskId: 'task-2',
      sessionId: 'sess-2',
      previousTaskId: 'task-1',
      previousSessionId: 'sess-1',
      mode: 'compacted',
    });
    // The reused session ran a full follow-up turn for task-2.
    const started = f.events.filter(
      (e) => e.type === 'AgentStarted' && e.taskId === 'task-2' && e.sessionId === 'sess-2',
    );
    expect(started).toHaveLength(1);
    // onSessionEnd/capsule boundary still fired per task.
    expect(f.ended.map((e) => e.taskId)).toEqual(['task-1', 'task-2']);
    // The kept session re-pooled after the second clean completion.
    expect(f.sm.pooledCount).toBe(1);
  });

  it('restarted-with-carryover reuse: a resume-only adapter binds a fresh run id, no sendMessage', async () => {
    const f = fixture();
    const first = new StubAdapter(null, {
      events: workScript(),
      capabilities: { sendMessage: false, resume: true, compact: false },
    });
    await f.sm.startSession('task-1', AGENT, first, config('task-1', 'sess-1'));
    await settle(() => f.sm.pooledCount === 1);

    const res = await f.sm.startSession(
      'task-2',
      AGENT,
      completingStub(),
      config('task-2', 'sess-2'),
    );

    expect(res).toEqual({ ok: true, sessionId: 'sess-2' });
    // Resume means the provider restarted the run — no follow-up message.
    expect(first.sentMessages).toEqual([]);
    const reused = eventsOf(f, 'SessionReused');
    expect((reused[0] as { mode: string }).mode).toBe('restarted-with-carryover');
    await settle(() => f.ended.some((e) => e.taskId === 'task-2'));
    const started = f.events.filter(
      (e) => e.type === 'AgentStarted' && e.taskId === 'task-2' && e.sessionId === 'sess-2',
    );
    expect(started).toHaveLength(1);
  });

  it('key isolation: a different project never reuses the session', async () => {
    const f = fixture();
    const first = completingStub();
    await f.sm.startSession('task-1', AGENT, first, config('task-1', 'sess-1', 'proj-A'));
    await settle(() => f.sm.pooledCount === 1);

    const second = completingStub();
    const res = await f.sm.startSession(
      'task-2',
      AGENT,
      second,
      config('task-2', 'sess-2', 'proj-B'),
    );

    expect(res.ok).toBe(true);
    expect(first.sentMessages).toEqual([]); // untouched
    expect(second.connectionState).toBe('connected');
    await settle(() => f.ended.some((e) => e.taskId === 'task-2'));
    expect(eventsOf(f, 'SessionReused')).toHaveLength(0);
    // proj-A's session stays pooled; proj-B's completion pooled its own.
    expect(f.sm.pooledCount).toBe(2);
  });

  it('1:1 while attached: the claimed entry is gone — a third same-key task spawns fresh', async () => {
    const f = fixture();
    const first = completingStub();
    await f.sm.startSession('task-1', AGENT, first, config('task-1', 'sess-1'));
    await settle(() => f.sm.pooledCount === 1);

    await f.sm.startSession('task-2', AGENT, completingStub(), config('task-2', 'sess-2'));
    expect(f.sm.pooledCount).toBe(0); // claimed

    // A concurrent task-3 sees an empty pool → fresh run on its adapter.
    const third = completingStub();
    const res = await f.sm.startSession('task-3', AGENT, third, config('task-3', 'sess-3'));
    expect(res.ok).toBe(true);
    expect(third.connectionState).toBe('connected');
    expect(eventsOf(f, 'SessionReused')).toHaveLength(1);
    await f.sm.stopAll();
  });

  it('expired entries are evicted and the task spawns fresh', async () => {
    const f = fixture();
    const first = completingStub();
    await f.sm.startSession('task-1', AGENT, first, config('task-1', 'sess-1'));
    await settle(() => f.sm.pooledCount === 1);

    f.now.t += 11 * 60 * 1000; // past the 10-minute default TTL

    const second = completingStub();
    const res = await f.sm.startSession('task-2', AGENT, second, config('task-2', 'sess-2'));

    expect(res.ok).toBe(true);
    expect(first.connectionState).toBe('disconnected'); // evicted, not reused
    expect(second.connectionState).toBe('connected');
    expect(first.sentMessages).toEqual([]);
    await settle(() => f.ended.some((e) => e.taskId === 'task-2'));
    expect(eventsOf(f, 'SessionReused')).toHaveLength(0);
  });

  it('an adapter that cannot maintain context is evicted, task spawns fresh, outcome is journaled', async () => {
    const f = fixture();
    // Declares support (gets pooled) but every ladder rung fails.
    class NoMaintainStub extends StubAdapter {
      protected override async performCompact(): Promise<boolean> {
        return false;
      }
      protected override async performResumeWithCarryover(): Promise<null> {
        return null;
      }
    }
    const first = new NoMaintainStub(null, { events: workScript() });
    await f.sm.startSession('task-1', AGENT, first, config('task-1', 'sess-1'));
    await settle(() => f.sm.pooledCount === 1);

    const second = completingStub();
    const res = await f.sm.startSession('task-2', AGENT, second, config('task-2', 'sess-2'));

    expect(res.ok).toBe(true);
    expect(second.connectionState).toBe('connected');
    const maintained = eventsOf(f, 'ContextMaintained');
    expect(maintained).toHaveLength(1);
    expect((maintained[0] as { mode: string }).mode).toBe('unsupported');
    expect(eventsOf(f, 'SessionReused')).toHaveLength(0);
    await settle(() => f.ended.some((e) => e.taskId === 'task-2'));
  });
});

describe('session pool — lifecycle', () => {
  it('stopAll drains pooled sessions', async () => {
    const f = fixture();
    const adapter = completingStub();
    await f.sm.startSession('task-1', AGENT, adapter, config('task-1', 'sess-1'));
    await settle(() => f.sm.pooledCount === 1);

    await f.sm.stopAll();

    expect(f.sm.pooledCount).toBe(0);
    expect(adapter.connectionState).toBe('disconnected');
  });
});
