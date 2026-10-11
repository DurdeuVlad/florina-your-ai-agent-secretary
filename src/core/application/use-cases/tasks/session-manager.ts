/**
 * Session manager — owns the lifecycle of active agent sessions (issue #35,
 * DEC-005).
 *
 * The {@link SessionManager} bridges the typed command API and the adapter
 * layer. When a `start-task` command is handled, the daemon asks the
 * session manager to connect an {@link AgentRuntimePort}, begin a run, and pipe
 * the adapter's normalized {@link SupervisorEvent} stream onto the daemon's
 * {@link EventPublisherPort}. When a `stop-task` command is handled, the session
 * manager cancels and disconnects the adapter.
 *
 * Design rules:
 * - One active session per task (MVP 1:1 task→run mapping, DEC-020).
 * - The session manager is the **sole** publisher of adapter events onto
 *   the bus. Adapters are instantiated without a direct bus reference so
 *   events are not double-published (the adapter's own `emitEvent` is a
 *   no-op when no bus is attached; the session manager publishes every
 *   event yielded by `adapter.streamEvents()`).
 * - Background event piping is fire-and-forget: the async iteration runs
 *   independently of the command that started it, completing when the
 *   adapter's stream ends or the session is stopped.
 * - All adapter errors during connect/start/cancel/disconnect are caught
 *   and surfaced as error results rather than thrown, so a failing adapter
 *   never crashes the daemon.
 */
import type { AgentRuntimePort, SessionConfig } from '../../ports/outbound/agent-runtime.js';
import type { EventPublisherPort } from '../../ports/outbound/event-stream.js';
import type { SupervisorEvent, ContextMaintenanceMode } from '../../../domain/events.js';

/**
 * Information tracked for each active agent session.
 */
export interface SessionInfo {
  /** The task this session belongs to. */
  readonly taskId: string;
  /** The agent (adapter id) executing the session. */
  readonly agentId: string;
  /** The session (run) id assigned by the command API. */
  readonly sessionId: string;
  /** The adapter instance backing this session. */
  readonly adapter: AgentRuntimePort;
  /** Epoch-milliseconds timestamp when the session was started. */
  readonly startedAt: number;
  /** Project context for pool keying (issue #342). */
  readonly projectId?: string;
  /** The task a pooled session previously served, when reused (#342). */
  readonly reusedFromTaskId?: string;
}

/**
 * A naturally-ended session kept live for reuse (issue #342). The pool
 * is a reuse cache, not a leak: only sessions that ended with
 * `AgentCompleted` are admitted, they are keyed by provider + project
 * context, they idle-expire, and {@link SessionManager.stopAll} drains
 * them. A pooled session serves exactly one task at a time — claiming
 * it removes it from the pool.
 */
export interface PooledSession {
  /** Provider+project context the session is reusable under. */
  readonly poolKey: string;
  /** The task that released this session. */
  readonly taskId: string;
  /** The run id the session carried while pooled. */
  readonly sessionId: string;
  /** The agent (adapter id) that owns the session. */
  readonly agentId: string;
  /** Project context the session is bound to. */
  readonly projectId?: string;
  /** The live adapter holding the session open. */
  readonly adapter: AgentRuntimePort;
  /** Epoch-milliseconds timestamp when the session was released. */
  readonly releasedAt: number;
}

/**
 * Session-pool behavior knobs (issue #342). Absent `sessionPool`
 * entirely keeps the pre-#342 behavior: every session ends at task end.
 */
export interface SessionPoolOptions {
  /**
   * Composes the carry-over digest seeded into a reused session — the
   * Task Capsule summaries for the pooled task in production. Called at
   * attach time so the freshest rollup wins. Absent → a minimal honest
   * digest naming the prior task.
   */
  readonly carryoverResolver?: (taskId: string) => Promise<string>;
  /**
   * How long an idle pooled session stays claimable (default 10 min).
   * An expired entry is evicted — cancelled and disconnected — and the
   * task spawns fresh. Degradation is graceful, not fatal.
   */
  readonly idleTtlMs?: number;
  /** Clock for TTL checks — injectable for deterministic tests. */
  readonly now?: () => number;
}

/** Result of a {@link SessionManager.startSession} call. */
export interface StartSessionResult {
  readonly ok: boolean;
  readonly sessionId?: string;
  readonly error?: string;
}

/** Result of a {@link SessionManager.stopSession} call. */
export interface StopSessionResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Context handed to {@link SessionManagerOptions.secretEnvResolver} when a
 * session's scoped secrets are resolved at spawn time (issue #293).
 */
export interface SecretInjectionContext {
  /** Task being run. */
  readonly taskId: string;
  /** Run/session id assigned for this dispatch. */
  readonly sessionId: string;
  /** Provider/agent id executing the run (adapter id). */
  readonly provider: string;
  /** Project the task belongs to, when known. */
  readonly projectId?: string;
}

/** Options for {@link SessionManager}. */
export interface SessionManagerOptions {
  /**
   * Called once when a session ends — via `stopSession` (freeze/stop) or
   * when the adapter's event stream finishes/errors (natural end). The
   * daemon uses this to roll the session's journal events into the Task
   * Capsule (issue #76) before any failover briefing reads it (#64).
   * Awaited on the `stopSession` path so callers see a settled capsule;
   * fire-and-forget on the stream-end path.
   */
  readonly onSessionEnd?: (taskId: string, sessionId: string) => void | Promise<void>;
  /**
   * Resolves scoped secret env-vars for a session at spawn time (issue
   * #293). The composition root wires this to the secrets vault's
   * injection resolution; resolved vars are merged over
   * `sessionConfig.env` — a stored credential is the user's most recent
   * explicit credential input and wins on conflicts. Values flow only
   * into the spawned process environment; they are never journaled or
   * returned to callers. A resolver failure degrades to no injection
   * rather than blocking dispatch — the provider surfaces its own auth
   * failure, which the attention path can remediate.
   */
  readonly secretEnvResolver?: (
    context: SecretInjectionContext,
  ) => Promise<Record<string, string> | undefined>;
  /**
   * Called for each adapter event immediately BEFORE it is published to
   * the bus (issue #339). The daemon uses this to run task verification
   * on a completion claim so Florina-observed `VerificationObserved`
   * facts are journaled before the verification gate assesses the claim
   * (gate wiring reacts to the published event — ordering matters).
   * Awaited; a hook failure is swallowed so it cannot swallow the event.
   */
  readonly beforePublish?: (event: SupervisorEvent) => void | Promise<void>;
  /**
   * Session-pool behavior (issue #342): sessions that end with
   * `AgentCompleted` are released into a per-key reuse cache with
   * `maintainContext` run at the next attach. Omit to disable pooling —
   * every session is torn down at task end (pre-#342 behavior).
   */
  readonly sessionPool?: SessionPoolOptions;
}

/**
 * Manages active agent sessions: connects adapters, starts runs, pipes
 * adapter events to the {@link EventPublisherPort}, and tears sessions down on stop.
 */
export class SessionManager {
  private readonly bus: EventPublisherPort;
  private readonly onSessionEnd?: (taskId: string, sessionId: string) => void | Promise<void>;
  private readonly secretEnvResolver?: SessionManagerOptions['secretEnvResolver'];
  private readonly beforePublish?: SessionManagerOptions['beforePublish'];
  private readonly sessionPool?: SessionPoolOptions;
  /** Map of taskId → active session info (one session per task in MVP). */
  private readonly sessions = new Map<string, SessionInfo>();
  /** Map of poolKey → idle pooled session (issue #342). */
  private readonly pool = new Map<string, PooledSession>();

  constructor(bus: EventPublisherPort, options: SessionManagerOptions = {}) {
    this.bus = bus;
    this.onSessionEnd = options.onSessionEnd;
    this.secretEnvResolver = options.secretEnvResolver;
    this.beforePublish = options.beforePublish;
    this.sessionPool = options.sessionPool;
  }

  /**
   * Start a new agent session for a task.
   *
   * Connects the adapter, begins a run with the supplied
   * {@link SessionConfig}, pipes the adapter's event stream onto the
   * {@link EventPublisherPort}, and tracks the session for later cancellation.
   *
   * @returns `{ ok: true, sessionId }` on success, or
   *   `{ ok: false, error }` if the adapter could not connect/start or a
   *   session is already active for the task.
   */
  async startSession(
    taskId: string,
    agentId: string,
    adapter: AgentRuntimePort,
    sessionConfig: SessionConfig,
  ): Promise<StartSessionResult> {
    if (this.sessions.has(taskId)) {
      return { ok: false, error: `Task "${taskId}" already has an active session` };
    }

    const config = await this.withSecretEnv(taskId, sessionConfig);

    // Session pool attach (issue #342): a same-provider+project session
    // that completed its prior task is reused with between-task context
    // maintenance instead of spawning a fresh run. Reuse failures degrade
    // to the normal spawn path — never fake continuity.
    const reused = await this.tryAttachPooled(taskId, agentId, config);
    if (reused !== null) {
      return reused;
    }

    try {
      await adapter.connect();
    } catch (err) {
      return { ok: false, error: `Adapter connect failed: ${errorMessage(err)}` };
    }

    let sessionId: string;
    try {
      const result = await adapter.startRun(taskId, config);
      if (!result.started) {
        await safeDisconnect(adapter);
        return { ok: false, error: 'Adapter reported the run did not start' };
      }
      sessionId = result.sessionId;
    } catch (err) {
      await safeDisconnect(adapter);
      return { ok: false, error: `Adapter startRun failed: ${errorMessage(err)}` };
    }

    const info: SessionInfo = {
      taskId,
      agentId,
      sessionId,
      adapter,
      startedAt: Date.now(),
      ...(config.projectId !== undefined ? { projectId: config.projectId } : {}),
    };
    this.sessions.set(taskId, info);

    // Pipe adapter events onto the daemon's EventPublisherPort in the background.
    // The iteration completes when the adapter's stream ends (run finished)
    // or the adapter is cancelled/disconnected.
    this.pipeEvents(info);

    return { ok: true, sessionId };
  }

  /**
   * Stop the active session for a task. Cancels the adapter run and
   * disconnects the adapter, then removes the session from tracking.
   *
   * @returns `{ ok: true }` on success, or `{ ok: false, error }` if no
   *   active session exists for the task.
   */
  async stopSession(taskId: string): Promise<StopSessionResult> {
    const info = this.sessions.get(taskId);
    if (!info) {
      return { ok: false, error: `No active session for task "${taskId}"` };
    }
    this.sessions.delete(taskId);
    try {
      await info.adapter.cancel(info.sessionId);
    } catch {
      /* best-effort cancel; proceed to disconnect regardless */
    }
    await safeDisconnect(info.adapter);
    if (this.onSessionEnd !== undefined) {
      try {
        await this.onSessionEnd(taskId, info.sessionId);
      } catch {
        /* rollup failures must not fail the stop — the journal is intact */
      }
    }
    return { ok: true };
  }

  /**
   * Return a snapshot of all active sessions keyed by task id. The returned
   * map is a copy; mutating it does not affect the manager's internal state.
   */
  getActiveSessions(): Map<string, SessionInfo> {
    return new Map(this.sessions);
  }

  /** Whether a session is currently active for the given task. */
  hasSession(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  /** The number of currently active sessions. */
  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Stop every active session. Used during daemon shutdown to ensure all
   * adapters are cleanly disconnected.
   */
  async stopAll(): Promise<void> {
    const taskIds = [...this.sessions.keys()];
    for (const taskId of taskIds) {
      await this.stopSession(taskId);
    }
    // Drain the pool (issue #342): pooled sessions hold live provider
    // resources — shutdown must end them, not orphan them.
    const entries = [...this.pool.values()];
    this.pool.clear();
    for (const entry of entries) {
      await evictPoolEntry(entry);
    }
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  /**
   * Merge resolved scoped secrets into the session env (issue #293).
   * The vault's resolved injections win over caller-supplied `env` on
   * conflicts — a stored credential is the user's most recent explicit
   * credential input. Resolver absence or failure yields the caller's
   * config unchanged so dispatch is never blocked by a vault hiccup.
   */
  private async withSecretEnv(
    taskId: string,
    sessionConfig: SessionConfig,
  ): Promise<SessionConfig> {
    if (this.secretEnvResolver === undefined) {
      return sessionConfig;
    }
    let injected: Record<string, string> | undefined;
    try {
      injected = await this.secretEnvResolver({
        taskId,
        sessionId: sessionConfig.sessionId,
        provider: sessionConfig.agentId,
        projectId: sessionConfig.projectId,
      });
    } catch {
      return sessionConfig;
    }
    if (injected === undefined || Object.keys(injected).length === 0) {
      return sessionConfig;
    }
    return { ...sessionConfig, env: { ...sessionConfig.env, ...injected } };
  }

  /**
   * Consume the adapter's `streamEvents` async iterable in the background,
   * publishing each yielded {@link SupervisorEvent} onto the {@link EventPublisherPort}.
   *
   * This is fire-and-forget: the caller does not await it. The iteration
   * ends naturally when the adapter's stream completes (run finished) or
   * when the adapter is cancelled/disconnected (the generator returns).
   *
   * When the stream ends (either naturally or via error) and the session
   * is still tracked, the session is auto-removed from the map and the
   * adapter is disconnected. This prevents resource leaks: a completed
   * run cleans up after itself without requiring an explicit `stop-task`.
   * If `stopSession` was called concurrently, it has already removed the
   * session from the map, so this cleanup is skipped.
   */
  private pipeEvents(info: SessionInfo): void {
    void (async () => {
      let lastEventType: string | null = null;
      let streamErrored = false;
      try {
        for await (const event of info.adapter.streamEvents()) {
          // Only publish if this session is still tracked. If the session
          // was stopped concurrently, the adapter stream will end shortly
          // and we avoid publishing stale events after teardown.
          if (!this.sessions.has(info.taskId)) {
            break;
          }
          if (this.beforePublish !== undefined) {
            try {
              await this.beforePublish(event);
            } catch {
              /* a pre-publish hook must never drop the event itself */
            }
          }
          this.bus.publish(event);
          lastEventType = event.type;
        }
      } catch {
        // The adapter stream errored or was interrupted. Fall through to
        // the auto-cleanup below so the session is not leaked — and is
        // never pooled on a broken stream (issue #342).
        streamErrored = true;
      }
      // Auto-cleanup: if the session is still tracked (i.e. the stream
      // ended naturally rather than via stopSession), remove it and
      // disconnect the adapter. This is safe even if stopSession races
      // with us — both paths are idempotent (delete is a no-op if already
      // removed, and safeDisconnect swallows errors).
      if (this.sessions.has(info.taskId)) {
        this.sessions.delete(info.taskId);
        // Session pool (issue #342): a clean `AgentCompleted` end releases
        // the session live into the pool instead of disconnecting — a
        // reuse cache, not a leak. Stops, failures, and broken streams
        // still disconnect: dead sessions are never pooled.
        const pooled =
          !streamErrored && lastEventType === 'AgentCompleted' && this.releaseToPool(info);
        if (!pooled) {
          await safeDisconnect(info.adapter);
        }
        if (this.onSessionEnd !== undefined) {
          try {
            await this.onSessionEnd(info.taskId, info.sessionId);
          } catch {
            /* best-effort rollup — the journal remains the source of truth */
          }
        }
      }
    })();
  }

  /* ---------------------------------------------------------------- *
   * Session pool (issue #342)
   * ---------------------------------------------------------------- */

  /**
   * Release a cleanly-ended session into the pool — journaled as
   * `SessionPooled`. Returns `false` (caller disconnects) when pooling
   * is disabled, the adapter cannot maintain context at all, or the key
   * is already held by a live entry (the pool caches one session per
   * provider+project context — a second release is torn down instead).
   */
  private releaseToPool(info: SessionInfo): boolean {
    if (this.sessionPool === undefined) {
      return false;
    }
    const { capabilities, maintainContext } = info.adapter;
    if (typeof maintainContext !== 'function' || (!capabilities.compact && !capabilities.resume)) {
      return false;
    }
    const key = poolKeyOf(info.agentId, info.projectId);
    const existing = this.pool.get(key);
    if (existing !== undefined && !this.isPoolEntryExpired(existing)) {
      return false;
    }
    if (existing !== undefined) {
      this.pool.delete(key);
      void evictPoolEntry(existing);
    }
    this.pool.set(key, {
      poolKey: key,
      taskId: info.taskId,
      sessionId: info.sessionId,
      agentId: info.agentId,
      ...(info.projectId !== undefined ? { projectId: info.projectId } : {}),
      adapter: info.adapter,
      releasedAt: this.poolNow(),
    });
    this.publishPoolEvent({
      type: 'SessionPooled',
      taskId: info.taskId,
      sessionId: info.sessionId,
      agentId: info.agentId,
      adapterFidelityTier: info.adapter.fidelityTier,
      poolKey: key,
    });
    return true;
  }

  /**
   * Attach the task to a pooled session for the same provider+project
   * key, running between-task context maintenance first (issue #342).
   * Returns the start result on a successful bind, or `null` when no
   * usable entry exists / maintenance could not preserve the session —
   * in which case the entry is evicted and the caller spawns fresh.
   * Maintenance outcomes are journaled: `ContextMaintained` always, plus
   * `SessionReused` when the session actually binds.
   */
  private async tryAttachPooled(
    taskId: string,
    agentId: string,
    config: SessionConfig,
  ): Promise<StartSessionResult | null> {
    if (this.sessionPool === undefined) {
      return null;
    }
    const key = poolKeyOf(agentId, config.projectId);
    const entry = this.pool.get(key);
    if (entry === undefined) {
      return null;
    }
    // Claim it: a pooled session serves one task at a time (issue #342).
    this.pool.delete(key);
    if (this.isPoolEntryExpired(entry) || entry.adapter.maintainContext === undefined) {
      await evictPoolEntry(entry);
      return null;
    }

    const envelope = {
      taskId,
      sessionId: config.sessionId,
      agentId,
      adapterFidelityTier: entry.adapter.fidelityTier,
    };
    const maintainBase = {
      poolKey: key,
      previousTaskId: entry.taskId,
    };
    let mode: ContextMaintenanceMode = 'unsupported';
    let boundSessionId: string | undefined;
    let detail: string | undefined;
    try {
      const carryover = await this.resolveCarryover(entry.taskId);
      const result = await entry.adapter.maintainContext(entry.sessionId, {
        carryover,
        restartConfig: config,
      });
      mode = result.mode;
      boundSessionId = result.sessionId;
      detail = result.detail;
    } catch (err) {
      detail = `maintainContext threw: ${errorMessage(err)}`;
    }

    this.publishPoolEvent({
      type: 'ContextMaintained',
      ...envelope,
      ...maintainBase,
      mode,
      ...(detail !== undefined ? { detail } : {}),
    });

    const needsMessage = mode === 'compacted';
    const reusable =
      (mode === 'compacted' || mode === 'restarted-with-carryover') &&
      boundSessionId !== undefined &&
      (!needsMessage || entry.adapter.capabilities.sendMessage);
    if (!reusable || boundSessionId === undefined) {
      // The old provider session is still live — kill it honestly rather
      // than leak it, then spawn fresh on the caller's adapter.
      await evictPoolEntry(entry);
      return null;
    }
    const bound = boundSessionId;

    const info: SessionInfo = {
      taskId,
      agentId,
      sessionId: bound,
      adapter: entry.adapter,
      startedAt: Date.now(),
      ...(config.projectId !== undefined ? { projectId: config.projectId } : {}),
      reusedFromTaskId: entry.taskId,
    };
    this.sessions.set(taskId, info);

    // A compacted session keeps its provider thread but has no work queued —
    // the new task's delegation is delivered as a follow-up message. A
    // restarted run already carries it inside restartConfig.
    if (needsMessage) {
      const sent = await entry.adapter.sendMessage!(bound, config.objective);
      if (!sent) {
        this.sessions.delete(taskId);
        await evictPoolEntry(entry);
        return null;
      }
    }

    this.publishPoolEvent({
      type: 'SessionReused',
      ...envelope,
      sessionId: bound,
      ...maintainBase,
      previousSessionId: entry.sessionId,
      mode,
    });
    this.pipeEvents(info);
    return { ok: true, sessionId: bound };
  }

  /** Idle TTL check — injectable clock for deterministic tests. */
  private isPoolEntryExpired(entry: PooledSession): boolean {
    const ttl = this.sessionPool?.idleTtlMs ?? DEFAULT_POOL_IDLE_TTL_MS;
    return this.poolNow() - entry.releasedAt > ttl;
  }

  private poolNow(): number {
    return this.sessionPool?.now?.() ?? Date.now();
  }

  /**
   * The carry-over digest for a reused session — the Task Capsule
   * summaries in production, composed by the composition root. A missing
   * resolver still yields an honest minimal digest naming the prior task.
   */
  private async resolveCarryover(previousTaskId: string): Promise<string> {
    const resolver = this.sessionPool?.carryoverResolver;
    if (resolver === undefined) {
      return `Continuing from prior task "${previousTaskId}" on this provider session.`;
    }
    try {
      const digest = await resolver(previousTaskId);
      if (digest.length > 0) {
        return digest;
      }
    } catch {
      /* a resolver hiccup must not block reuse — fall back to the minimal digest */
    }
    return `Continuing from prior task "${previousTaskId}" on this provider session.`;
  }

  /**
   * Publish a pool lifecycle event onto the bus — the journal writer
   * records it like every supervisor event (DEC-012). Publication is
   * best-effort: a bus error must not break session scheduling.
   */
  private publishPoolEvent(event: WithoutTimestamp<SupervisorEvent>): void {
    try {
      this.bus.publish({ ...event, timestamp: new Date().toISOString() } as SupervisorEvent);
    } catch {
      /* the journal is the record; a bus hiccup must not break pooling */
    }
  }

  /** Idle pooled sessions — surfaced for tests and pool visibility. */
  get pooledCount(): number {
    return this.pool.size;
  }
}

/**
 * Disconnect an adapter, swallowing errors. Used during cleanup paths where
 * a thrown error should not propagate.
 */
async function safeDisconnect(adapter: AgentRuntimePort): Promise<void> {
  try {
    await adapter.disconnect();
  } catch {
    /* ignore — best-effort teardown */
  }
}

/** Idle pooled-session claim window (issue #342). */
const DEFAULT_POOL_IDLE_TTL_MS = 10 * 60 * 1000;

/** Distributive `Omit` — strips `timestamp` from each union variant. */
type WithoutTimestamp<T> = T extends object ? Omit<T, 'timestamp'> : never;

/**
 * The provider+project context a session is reusable under (issue #342):
 * a session never bleeds across providers or projects.
 */
function poolKeyOf(agentId: string, projectId?: string): string {
  return `${agentId}::${projectId ?? ''}`;
}

/**
 * End a pooled session honestly: cancel the live run (it may still be
 * registered provider-side) then disconnect the adapter — best-effort,
 * since a dead transport must not break eviction (issue #342).
 */
async function evictPoolEntry(entry: PooledSession): Promise<void> {
  try {
    await entry.adapter.cancel(entry.sessionId);
  } catch {
    /* best-effort — the session may already be gone */
  }
  await safeDisconnect(entry.adapter);
}

/** Extract a human-readable message from an unknown error. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
