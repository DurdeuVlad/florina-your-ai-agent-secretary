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
 * an {@link EventPublisherPort}. Concrete adapters extend it and implement the
 * provider-specific streaming logic.
 */
import type { AdapterFidelityTier } from '../../../core/domain/enums.js';
import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { EventPublisherPort } from '../../../core/application/ports/outbound/event-stream.js';
import type {
  AdapterConnectionState,
  AgentRuntimePort,
  AgentSessionCapabilities,
  MaintainContextRequest,
  MaintainContextResult,
  SessionConfig,
  StartRunResult,
} from '../../../core/application/ports/outbound/agent-runtime.js';
import { NO_SESSION_CAPABILITIES } from '../../../core/application/ports/outbound/agent-runtime.js';

/**
 * Re-export the fidelity tier enum so adapter consumers can import the
 * canonical definition from a single adapter-facing module. The source of
 * truth remains `src/core/domain/enums.ts` (DEC-013).
 */
export type { AdapterFidelityTier } from '../../../core/domain/enums.js';

/**
 * Re-export the core-owned agent runtime contract so adapter consumers can
 * keep importing it from this adapter-facing module. The source of truth is
 * `src/core/application/ports/outbound/agent-runtime.ts` (DEC-037).
 */
export type {
  AdapterConnectionState,
  SessionConfig,
  StartRunResult,
  AgentRuntimePort,
  AgentAdapter,
  AgentSessionCapabilities,
  ContextMaintenanceMode,
  MaintainContextRequest,
  MaintainContextResult,
} from '../../../core/application/ports/outbound/agent-runtime.js';

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
 * - Event emission to an {@link EventPublisherPort} via {@link BaseAdapter.emitEvent}.
 * - A guarded `requireConnected` helper that throws if the adapter is not
 *   connected before a run-dependent operation.
 */
export abstract class BaseAdapter implements AgentRuntimePort {
  /** Stable identifier for this adapter. */
  readonly id: string;

  /** The fidelity tier declared by the concrete adapter (DEC-013). */
  readonly fidelityTier: AdapterFidelityTier;

  private state: AdapterConnectionState = 'disconnected';
  private readonly bus: EventPublisherPort | null;

  /**
   * Static session-reuse capabilities (issue #341): what this adapter's
   * transport genuinely supports. Defaults to none — an adapter opts in
   * only where support is real, so callers never schedule against a
   * fake matrix.
   */
  readonly capabilities: AgentSessionCapabilities;

  /**
   * @param id - Stable adapter identifier.
   * @param fidelityTier - The fidelity tier (A–E) this adapter declares.
   * @param bus - Optional {@link EventPublisherPort} to publish emitted events to. When
   *   provided, {@link BaseAdapter.emitEvent} fans events out to live
   *   subscribers; when omitted, the adapter is usable standalone (events are
   *   only available via `streamEvents`).
   * @param capabilities - Honest session-reuse matrix; defaults to all-false.
   */
  constructor(
    id: string,
    fidelityTier: AdapterFidelityTier,
    bus?: EventPublisherPort | null,
    capabilities: AgentSessionCapabilities = NO_SESSION_CAPABILITIES,
  ) {
    this.id = id;
    this.fidelityTier = fidelityTier;
    this.bus = bus ?? null;
    this.capabilities = capabilities;
  }

  /** Current connection state. */
  get connectionState(): AdapterConnectionState {
    return this.state;
  }

  /** The event bus events are emitted to, if any. */
  protected get eventBus(): EventPublisherPort | null {
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
   * Emit a normalized `SupervisorEvent`. When an {@link EventPublisherPort} was
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

  /**
   * Preserve session context between tasks (issue #341). The default
   * implementation is a capability-driven ladder: provider compaction
   * where `capabilities.compact` is declared and {@link performCompact}
   * succeeds; provider-resume with the caller-composed carry-over digest
   * where `capabilities.resume` is declared and
   * {@link performResumeWithCarryover} succeeds; `unsupported` otherwise
   * so the caller degrades to spawn-fresh. Concrete adapters override
   * the hooks — never the ladder — so a declared-but-failing capability
   * degrades honestly rather than faking a mode.
   */
  async maintainContext(
    sessionId: string,
    request: MaintainContextRequest,
  ): Promise<MaintainContextResult> {
    this.requireConnected();
    if (this.capabilities.compact) {
      try {
        if (await this.performCompact(sessionId, request)) {
          // Provider continuity ≠ run identity (issue #342): the kept
          // provider session serves the new task under the new run id.
          return { mode: 'compacted', sessionId: request.restartConfig.sessionId };
        }
      } catch {
        /* declared-but-failing compact degrades to the next rung */
      }
    }
    if (this.capabilities.resume) {
      try {
        const resumed = await this.performResumeWithCarryover(sessionId, request);
        if (resumed !== null) {
          return { mode: 'restarted-with-carryover', sessionId: resumed };
        }
      } catch {
        /* declared-but-failing resume degrades to unsupported */
      }
    }
    return {
      mode: 'unsupported',
      detail:
        `adapter "${this.id}" cannot maintain session context ` +
        `(sendMessage=${this.capabilities.sendMessage}, ` +
        `resume=${this.capabilities.resume}, compact=${this.capabilities.compact})`,
    };
  }

  /**
   * Provider-side context compaction hook (issue #341). Called only when
   * `capabilities.compact` is declared. `request.restartConfig` carries
   * the new task/run identities — a compacted provider session rebinds
   * its event envelope to them (issue #342: provider continuity ≠ run
   * identity). Returns `true` on success.
   */
  protected async performCompact(
    _sessionId: string,
    _request: MaintainContextRequest,
  ): Promise<boolean> {
    return false;
  }

  /**
   * Provider-resume-with-carryover hook (issue #341). Called only when
   * `capabilities.resume` is declared — the implementation restarts a
   * run that continues the provider session, seeding it with
   * `request.carryover`. Returns the new session id, or `null`.
   */
  protected async performResumeWithCarryover(
    _sessionId: string,
    _request: MaintainContextRequest,
  ): Promise<string | null> {
    return null;
  }

  // The remaining AgentAdapter methods are abstract; concrete adapters
  // provide provider-specific implementations.
  abstract connect(): Promise<void>;
  abstract startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult>;
  abstract streamEvents(): AsyncIterable<SupervisorEvent>;
  abstract cancel(sessionId: string): Promise<void>;
  abstract disconnect(): Promise<void>;
}
