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
}

/**
 * Manages active agent sessions: connects adapters, starts runs, pipes
 * adapter events to the {@link EventPublisherPort}, and tears sessions down on stop.
 */
export class SessionManager {
  private readonly bus: EventPublisherPort;
  private readonly onSessionEnd?: (taskId: string, sessionId: string) => void | Promise<void>;
  /** Map of taskId → active session info (one session per task in MVP). */
  private readonly sessions = new Map<string, SessionInfo>();

  constructor(bus: EventPublisherPort, options: SessionManagerOptions = {}) {
    this.bus = bus;
    this.onSessionEnd = options.onSessionEnd;
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

    try {
      await adapter.connect();
    } catch (err) {
      return { ok: false, error: `Adapter connect failed: ${errorMessage(err)}` };
    }

    let sessionId: string;
    try {
      const result = await adapter.startRun(taskId, sessionConfig);
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
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

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
      try {
        for await (const event of info.adapter.streamEvents()) {
          // Only publish if this session is still tracked. If the session
          // was stopped concurrently, the adapter stream will end shortly
          // and we avoid publishing stale events after teardown.
          if (!this.sessions.has(info.taskId)) {
            break;
          }
          this.bus.publish(event);
        }
      } catch {
        // The adapter stream errored or was interrupted. Fall through to
        // the auto-cleanup below so the session is not leaked.
      }
      // Auto-cleanup: if the session is still tracked (i.e. the stream
      // ended naturally rather than via stopSession), remove it and
      // disconnect the adapter. This is safe even if stopSession races
      // with us — both paths are idempotent (delete is a no-op if already
      // removed, and safeDisconnect swallows errors).
      if (this.sessions.has(info.taskId)) {
        this.sessions.delete(info.taskId);
        await safeDisconnect(info.adapter);
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

/** Extract a human-readable message from an unknown error. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
