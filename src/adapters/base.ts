/**
 * Adapter base interface & fidelity tier contract (DEC-013, PRODUCT_DESIGN
 * "Agent Adapters").
 *
 * Every agent adapter (Codex app-server, Claude Code hooks, future ACP
 * agents, JSON CLI, PTY heuristic) normalizes its provider-specific
 * observations into the canonical `SupervisorEvent` schema (DEC-019) and
 * exposes them through the single {@link AgentAdapter} interface. Adapters
 * never own agent reasoning loops — they only observe and normalize.
 *
 * Each adapter declares an {@link AdapterFidelityTier} (A–E). The attention
 * engine uses the tier to decide auto-approval eligibility:
 * - **Tier A–B**: auto-approve policies are available.
 * - **Tier C**: auto-approve only with sufficient ACP structured context.
 * - **Tier D–E**: no auto-approval; all permission-like events require human
 *   confirmation.
 *
 * The {@link BaseAdapter} abstract class implements common functionality:
 * fidelity tier declaration, connection state tracking, and event emission to
 * an {@link EventBus}. Concrete adapters extend it and implement the
 * provider-specific streaming logic.
 */
import type { AdapterFidelityTier } from '../domain/enums.js';
import type { SupervisorEvent } from '../domain/events.js';
import type { EventBus } from '../daemon/event-stream.js';

/**
 * Re-export the fidelity tier enum so adapter consumers can import the
 * canonical definition from a single adapter-facing module. The source of
 * truth remains `src/domain/enums.ts` (DEC-013).
 */
export type { AdapterFidelityTier } from '../domain/enums.js';

/** Connection state tracked by every adapter. */
export type AdapterConnectionState = 'disconnected' | 'connecting' | 'connected';

/**
 * Configuration for a single agent run (session).
 *
 * Passed to {@link AgentAdapter.startRun} when a task is delegated to an
 * adapter. Carries the identifiers and runtime context the adapter needs to
 * normalize events with the correct envelope fields.
 */
export interface SessionConfig {
  /** Identifier of the Task this run belongs to (DEC-004). */
  readonly taskId: string;
  /** Identifier of the Session (run) being started. */
  readonly sessionId: string;
  /** Identifier of the agent that will execute the run. */
  readonly agentId: string;
  /** Working directory (worktree) the agent runs in. */
  readonly workingDir: string;
  /** The objective delegated to the agent. */
  readonly objective: string;
  /** Optional model identifier the agent should use. */
  readonly model?: string;
  /** Optional autonomy/approval policy in effect. */
  readonly autonomyLevel?: string;
}

/** Result of starting a run: the session id and whether the run began. */
export interface StartRunResult {
  /** The session id of the started run. */
  readonly sessionId: string;
  /** Whether the run was successfully started. */
  readonly started: boolean;
}

/**
 * The contract every agent adapter implements.
 *
 * Adapters normalize heterogeneous agent observations into the canonical
 * {@link SupervisorEvent} schema and stream them to the daemon. The daemon
 * owns the event journal and the live fan-out; adapters never touch storage
 * or WebSocket connections directly.
 *
 * Lifecycle:
 * 1. `connect()` — establish the provider connection (app-server, CLI
 *    subprocess, PTY, ...).
 * 2. `startRun(taskId, sessionConfig)` — begin a delegated run.
 * 3. `streamEvents()` — async iterable of normalized `SupervisorEvent`s.
 * 4. `cancel(sessionId)` — stop a running session.
 * 5. `disconnect()` — tear down the provider connection.
 */
export interface AgentAdapter {
  /** Stable identifier for this adapter (e.g. `codex`, `claude-code`, `stub`). */
  readonly id: string;

  /**
   * The fidelity tier (A–E) this adapter declares. The attention engine
   * uses this to decide auto-approve eligibility (DEC-013).
   */
  readonly fidelityTier: AdapterFidelityTier;

  /** Current connection state of the adapter. */
  readonly connectionState: AdapterConnectionState;

  /**
   * Establish the provider connection (app-server handshake, CLI spawn, PTY
   * open, ...). Must be called before `startRun`.
   */
  connect(): Promise<void>;

  /**
   * Begin a delegated run for a task. Returns the session id and whether the
   * run was successfully started.
   *
   * @param taskId - Identifier of the Task being delegated.
   * @param sessionConfig - Runtime context for the run.
   */
  startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult>;

  /**
   * Stream normalized `SupervisorEvent`s for active runs. The async iterable
   * completes when all active runs finish (or the adapter disconnects).
   */
  streamEvents(): AsyncIterable<SupervisorEvent>;

  /**
   * Cancel a running session. The adapter should stop the underlying agent
   * process and emit a terminal `AgentStopped` event.
   *
   * @param sessionId - The session to cancel.
   */
  cancel(sessionId: string): Promise<void>;

  /** Tear down the provider connection and release all resources. */
  disconnect(): Promise<void>;
}

/**
 * Abstract base class implementing common adapter functionality.
 *
 * Concrete adapters extend this class and provide:
 * - A `fidelityTier` declared via the constructor.
 * - Provider-specific `connect`, `startRun`, `streamEvents`, `cancel`, and
 *   `disconnect` logic.
 *
 * The base class provides:
 * - Connection state tracking with guarded transitions.
 * - Event emission to an {@link EventBus} via {@link BaseAdapter.emitEvent}.
 * - A guarded `requireConnected` helper that throws if the adapter is not
 *   connected before a run-dependent operation.
 */
export abstract class BaseAdapter implements AgentAdapter {
  /** Stable identifier for this adapter. */
  readonly id: string;

  /** The fidelity tier declared by the concrete adapter (DEC-013). */
  readonly fidelityTier: AdapterFidelityTier;

  private state: AdapterConnectionState = 'disconnected';
  private readonly bus: EventBus | null;

  /**
   * @param id - Stable adapter identifier.
   * @param fidelityTier - The fidelity tier (A–E) this adapter declares.
   * @param bus - Optional {@link EventBus} to publish emitted events to. When
   *   provided, {@link BaseAdapter.emitEvent} fans events out to live
   *   subscribers; when omitted, the adapter is usable standalone (events are
   *   only available via `streamEvents`).
   */
  constructor(id: string, fidelityTier: AdapterFidelityTier, bus?: EventBus | null) {
    this.id = id;
    this.fidelityTier = fidelityTier;
    this.bus = bus ?? null;
  }

  /** Current connection state. */
  get connectionState(): AdapterConnectionState {
    return this.state;
  }

  /** The event bus events are emitted to, if any. */
  protected get eventBus(): EventBus | null {
    return this.bus;
  }

  /**
   * Transition to a new connection state. Throws on illegal transitions
   * (e.g. `connected` -> `connecting`).
   */
  protected setConnectionState(next: AdapterConnectionState): void {
    const from = this.state;
    const legal: Readonly<Record<AdapterConnectionState, readonly AdapterConnectionState[]>> = {
      disconnected: ['connecting'],
      connecting: ['connected', 'disconnected'],
      connected: ['disconnected'],
    };
    if (!legal[from].includes(next)) {
      throw new Error(`Illegal adapter state transition: ${from} -> ${next}`);
    }
    this.state = next;
  }

  /**
   * Throw if the adapter is not in the `connected` state. Called by concrete
   * adapters before run-dependent operations.
   */
  protected requireConnected(): void {
    if (this.state !== 'connected') {
      throw new Error(`Adapter "${this.id}" is not connected (state: ${this.state})`);
    }
  }

  /**
   * Emit a normalized `SupervisorEvent`. When an {@link EventBus} was
   * supplied at construction, the event is published to the live stream so
   * subscribers (CLI, desktop, voice) receive it in real time. Concrete
   * adapters call this from their `streamEvents` implementation.
   *
   * The event is not validated here — adapters are responsible for producing
   * valid events (the serialization boundary validates). This keeps the hot
   * path allocation-free for high-fidelity adapters that already produce
   * validated events.
   *
   * @returns The sequence number assigned by the bus, or `0` when no bus is
   *   attached.
   */
  protected emitEvent(event: SupervisorEvent): number {
    if (this.bus) {
      return this.bus.publish(event);
    }
    return 0;
  }

  // The remaining AgentAdapter methods are abstract; concrete adapters
  // provide provider-specific implementations.
  abstract connect(): Promise<void>;
  abstract startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult>;
  abstract streamEvents(): AsyncIterable<SupervisorEvent>;
  abstract cancel(sessionId: string): Promise<void>;
  abstract disconnect(): Promise<void>;
}
