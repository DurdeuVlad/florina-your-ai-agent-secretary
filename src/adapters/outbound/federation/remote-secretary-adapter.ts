/**
 * Remote Secretary adapter (DEC-036, issue #78) — parent side.
 *
 * A child daemon on another machine presents as a provider-shaped
 * capacity pool: this adapter implements {@link AgentRuntimePort} over
 * the child's own typed command API + event stream, so the parent's
 * router, quota ledger, park/resume, and failover logic treat remote
 * capacity exactly like a local provider (`provider@host`).
 *
 * Delegation: `startRun` sends `delegate-task` — the child resolves the
 * project (the repo must exist on that machine), creates the worktree,
 * routes through its own QuotaLedger, and runs its own managers/workers
 * locally. Structured events stream back end-to-end and are remapped to
 * the parent's task/session ids.
 */
import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { AdapterFidelityTier } from '../../../core/domain/enums.js';
import type { EventPublisherPort } from '../../../core/application/ports/outbound/event-stream.js';
import type {
  AdapterConnectionState,
  AgentRuntimePort,
  SessionConfig,
  StartRunResult,
} from '../../../core/application/ports/outbound/agent-runtime.js';
import type {
  Command,
  DelegateTaskResponse,
  Response,
} from '../../../core/application/use-cases/tasks/command-api.js';
import {
  RemoteSecretaryClient,
  RemoteSecretaryError,
  type RemoteSecretaryClientOptions,
} from './remote-secretary-client.js';

/** Narrowed client surface — the real client satisfies it, tests fake it. */
export interface RemoteClientPort {
  connect(): Promise<void>;
  subscribe(): void;
  send(command: Command): Promise<Response>;
  events(): AsyncIterable<SupervisorEvent>;
  close(): void;
}

/** Options for {@link RemoteSecretaryAdapter}. */
export interface RemoteSecretaryAdapterOptions {
  /**
   * Pool id — `provider@host` (e.g. `codex@server-x`). Registered in the
   * adapter registry under this id so the router sees it as capacity.
   */
  readonly id: string;
  /** Child daemon control-plane endpoint. */
  readonly remote: RemoteSecretaryClientOptions;
  /** Child-side project delegations attach to (the repo lives there). */
  readonly projectId: string;
  /** Provider the child should prefer, when eligible on that machine. */
  readonly preferProvider?: string;
  /** Declared fidelity — remote events are normalized end-to-end (C). */
  readonly fidelityTier?: AdapterFidelityTier;
  /** Injectable client (tests substitute a fake). */
  readonly client?: RemoteClientPort;
}

/**
 * AgentRuntimePort backed by a remote child daemon. One adapter = one
 * delegated run: session-manager lifecycle matches every other adapter.
 *
 * Implements the port directly (the shared `BaseAdapter` lives in the
 * `agents` family — the architecture gate forbids cross-family imports).
 * State transitions mirror it: disconnected → connecting → connected →
 * disconnected.
 */
export class RemoteSecretaryAdapter implements AgentRuntimePort {
  readonly id: string;
  readonly fidelityTier: AdapterFidelityTier;

  private state: AdapterConnectionState = 'disconnected';
  private readonly bus: EventPublisherPort | null;
  private readonly options: RemoteSecretaryAdapterOptions;
  private readonly client: RemoteClientPort;
  /** child taskId → parent {taskId, sessionId} correlation. */
  private readonly delegated = new Map<string, { taskId: string; sessionId: string }>();
  private readonly eventQueue: SupervisorEvent[] = [];
  private eventResolvers: Array<() => void> = [];
  private pumpStarted = false;
  private streamDone = false;

  constructor(bus: EventPublisherPort | null | undefined, options: RemoteSecretaryAdapterOptions) {
    this.id = options.id;
    this.fidelityTier = options.fidelityTier ?? 'C';
    this.bus = bus ?? null;
    this.options = options;
    this.client =
      options.client ?? new RemoteSecretaryClient(options.remote);
  }

  get connectionState(): AdapterConnectionState {
    return this.state;
  }

  private setConnectionState(next: AdapterConnectionState): void {
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

  private requireConnected(): void {
    if (this.state !== 'connected') {
      throw new Error(`Adapter "${this.id}" is not connected (state: ${this.state})`);
    }
  }

  async connect(): Promise<void> {
    this.setConnectionState('connecting');
    try {
      await this.client.connect();
      this.client.subscribe();
    } catch (err) {
      this.setConnectionState('disconnected');
      throw err;
    }
    this.setConnectionState('connected');
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.requireConnected();
    const res = (await this.client.send({
      kind: 'delegate-task',
      projectId: this.options.projectId,
      objective: sessionConfig.objective,
      ...(this.options.preferProvider !== undefined
        ? { preferProvider: this.options.preferProvider }
        : {}),
    })) as DelegateTaskResponse;
    if (res.ok !== true || res.status !== 'spawned' || res.taskId === undefined) {
      // A parked or refused child is a non-start at the adapter level —
      // the parent's park/resume machinery handles it via the failure path.
      return { sessionId: sessionConfig.sessionId, started: false };
    }
    const childTaskId = res.taskId;
    this.delegated.set(childTaskId, {
      taskId,
      sessionId: sessionConfig.sessionId,
    });
    this.enqueue({
      type: 'AgentStarted',
      timestamp: new Date().toISOString(),
      taskId,
      sessionId: sessionConfig.sessionId,
      agentId: this.id,
      adapterFidelityTier: this.fidelityTier,
      objective: sessionConfig.objective,
      workingDir: sessionConfig.workingDir,
      ...(sessionConfig.model !== undefined ? { model: sessionConfig.model } : {}),
    });
    return { sessionId: sessionConfig.sessionId, started: true };
  }

  async *streamEvents(): AsyncIterable<SupervisorEvent> {
    if (!this.pumpStarted) {
      this.pumpStarted = true;
      void this.pumpEvents();
    }
    while (true) {
      const next = this.eventQueue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.streamDone) return;
      await new Promise<void>((resolve) => this.eventResolvers.push(resolve));
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const entry = [...this.delegated.entries()].find(
      ([, v]) => v.sessionId === sessionId,
    );
    if (entry === undefined) return;
    await this.client.send({
      kind: 'stop-task',
      taskId: entry[0],
      reason: 'cancelled by parent secretary',
    });
    this.enqueue({
      type: 'AgentStopped',
      timestamp: new Date().toISOString(),
      taskId: entry[1].taskId,
      sessionId: entry[1].sessionId,
      agentId: this.id,
    } as SupervisorEvent);
  }

  async disconnect(): Promise<void> {
    this.client.close();
    this.streamDone = true;
    for (const r of this.eventResolvers.splice(0)) r();
    this.setConnectionState('disconnected');
  }

  /* ---------------------------------------------------------------- *
   * Internal
   * ---------------------------------------------------------------- */

  /** Drain the child event stream, remap ids, buffer for streamEvents. */
  private async pumpEvents(): Promise<void> {
    try {
      for await (const childEvent of this.client.events()) {
        const mapped = this.remap(childEvent);
        if (mapped !== null) {
          this.enqueue(mapped);
        }
      }
    } catch {
      // The socket dropping ends the stream; pending consumers unblock below.
    } finally {
      this.streamDone = true;
      for (const r of this.eventResolvers.splice(0)) r();
    }
  }

  /**
   * Remap a child event to the parent's identifiers: events for tasks
   * this adapter delegated get the parent's task/session ids and this
   * pool's agentId; anything else is dropped (the child's own work is
   * not the parent's business — DEC-003 isolation applies both ways).
   */
  private remap(childEvent: SupervisorEvent): SupervisorEvent | null {
    const childTaskId = (childEvent as { taskId?: string }).taskId;
    if (typeof childTaskId !== 'string') return null;
    const parent = this.delegated.get(childTaskId);
    if (parent === undefined) return null;
    return {
      ...childEvent,
      taskId: parent.taskId,
      sessionId: parent.sessionId,
      agentId: this.id,
    };
  }

  private enqueue(event: SupervisorEvent): void {
    this.eventQueue.push(event);
    this.bus?.publish(event);
    for (const r of this.eventResolvers.splice(0)) r();
  }
}

export { RemoteSecretaryError };
