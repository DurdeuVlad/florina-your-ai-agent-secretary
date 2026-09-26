/**
 * Context health monitor — per-agent window fill tracking and attention
 * elevation (DEC-035, issue #77).
 *
 * A continuous agent on a degraded context makes degraded decisions. The
 * monitor subscribes to the event bus, maintains a deterministic health
 * estimate per agent (keyed by `agentId`), and emits a
 * `ContextHealthChanged` observation when an agent's status class
 * transitions — the journal writer then persists it (DEC-012) and the
 * attention engine elevates it.
 *
 * Fill estimate (deterministic, no LLM):
 * - Token signal: `UsageReported.totalTokens` is cumulative per session,
 *   so the fill contribution is `tokens since the last condensation`
 *   divided by the configured token budget.
 * - Event signal: journaled events since the last condensation divided
 *   by the event budget.
 * - `windowFillPct = max(tokenFill, eventFill)` — whichever signal is
 *   hotter.
 * - A `ContextCondensed` event resets the baseline: kept events carry
 *   forward, token accounting restarts from the current cumulative
 *   total.
 * - Adapter-reported `ContextHealthChanged` events pass through as
 *   authoritative observations (tier-A adapters know their real window).
 *
 * Status rule (per the issue): fill ≥ `criticalFill` → `critical`;
 * ≥ `degradedFill` → `degraded`; otherwise `ok`. Condensation resets
 * the fill, so "fill above threshold without recent successful
 * condensation" falls out of the rule rather than needing a separate
 * timer.
 */
import type {
  ContextCondensedEvent,
  ContextHealthChangedEvent,
  SupervisorEvent,
  UsageReportedEvent,
} from '../../../domain/events.js';
import type { ContextHealthStatus } from '../../../domain/events.js';
import type { EventPublisherPort, EventSubscriberPort } from '../../ports/outbound/event-stream.js';

/** Per-agent health snapshot (deterministic — no timestamps invented). */
export interface ContextHealthSnapshot {
  readonly agentId: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  /** Estimated window fill, 0..1 (max of token and event signals). */
  readonly windowFillPct: number;
  /** Events observed since the last condensation. */
  readonly eventsSinceCondensation: number;
  /** Total condensations observed for this agent. */
  readonly condensationCount: number;
  /** Timestamp of the last `ContextCondensed`, if any. */
  readonly lastCondensationAt?: string;
  readonly status: ContextHealthStatus;
}

export interface ContextHealthMonitorConfig {
  /** Estimated-token budget per agent window (default 200k). */
  readonly tokenBudget?: number;
  /** Event-count budget per agent window (default 500). */
  readonly eventBudget?: number;
  /** Fill at or above → `degraded` (default 0.75). */
  readonly degradedFill?: number;
  /** Fill at or above → `critical` (default 0.9). */
  readonly criticalFill?: number;
}

export interface ContextHealthMonitorDeps {
  readonly bus: EventSubscriberPort & EventPublisherPort;
  readonly config?: ContextHealthMonitorConfig;
}

/** Tracked per-agent state (internal). */
interface AgentHealth {
  status: ContextHealthStatus;
  taskId?: string;
  sessionId?: string;
  /** Cumulative tokens at the last condensation baseline. */
  tokenBaseline: number;
  /** Latest cumulative token total reported by the adapter. */
  latestTokens: number;
  /** Events seen since the last condensation. */
  eventsSinceCondensation: number;
  condensationCount: number;
  lastCondensationAt?: string;
}

export class ContextHealthMonitor {
  private readonly bus: EventSubscriberPort & EventPublisherPort;
  private readonly tokenBudget: number;
  private readonly eventBudget: number;
  private readonly degradedFill: number;
  private readonly criticalFill: number;
  private readonly agents = new Map<string, AgentHealth>();
  private unsubscribe?: () => void;

  constructor(deps: ContextHealthMonitorDeps) {
    this.bus = deps.bus;
    const config = deps.config ?? {};
    this.tokenBudget = config.tokenBudget ?? 200_000;
    this.eventBudget = config.eventBudget ?? 500;
    this.degradedFill = config.degradedFill ?? 0.75;
    this.criticalFill = config.criticalFill ?? 0.9;
  }

  /** Begin observing the bus. Idempotent. Pair with {@link stop}. */
  start(): void {
    if (this.unsubscribe !== undefined) return;
    this.unsubscribe = this.bus.onEvent((event) => this.handleEvent(event));
  }

  /** Stop observing. Safe when not started. */
  stop(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /**
   * Process one event: update the agent's tracked state and emit a
   * `ContextHealthChanged` observation when the status class changes.
   */
  handleEvent(event: SupervisorEvent): void {
    const agentId = event.agentId;
    if (agentId === '') return;

    // Adapter-reported health passes through untouched — it is already
    // the authoritative observation (tier-A providers know their window).
    if (event.type === 'ContextHealthChanged') {
      const state = this.stateFor(agentId, event.taskId, event.sessionId);
      state.status = event.status;
      return;
    }

    const state = this.stateFor(agentId, event.taskId, event.sessionId);

    if (event.type === 'ContextCondensed') {
      const condensed = event as ContextCondensedEvent;
      state.condensationCount += 1;
      state.lastCondensationAt = condensed.timestamp;
      state.eventsSinceCondensation = condensed.keptEventCount;
      state.tokenBaseline = state.latestTokens;
    } else {
      state.eventsSinceCondensation += 1;
      if (event.type === 'UsageReported') {
        const usage = event as UsageReportedEvent;
        if (usage.totalTokens !== undefined && usage.totalTokens > state.latestTokens) {
          state.latestTokens = usage.totalTokens;
        }
      }
    }

    const next = this.classify(state);
    if (next !== state.status) {
      state.status = next;
      this.emitChanged(event, state);
    }
  }

  /** Current snapshot for one agent, or `undefined` if never observed. */
  snapshot(agentId: string): ContextHealthSnapshot | undefined {
    const state = this.agents.get(agentId);
    if (state === undefined) return undefined;
    return this.toSnapshot(agentId, state);
  }

  /** Snapshots for every tracked agent. */
  listSnapshots(): ContextHealthSnapshot[] {
    return [...this.agents.entries()].map(([id, s]) => this.toSnapshot(id, s));
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  private stateFor(agentId: string, taskId: string, sessionId: string): AgentHealth {
    let state = this.agents.get(agentId);
    if (state === undefined) {
      state = {
        status: 'ok',
        tokenBaseline: 0,
        latestTokens: 0,
        eventsSinceCondensation: 0,
        condensationCount: 0,
      };
      this.agents.set(agentId, state);
    }
    state.taskId = taskId;
    state.sessionId = sessionId;
    return state;
  }

  /** windowFill = max(tokenFill, eventFill), clamped to 0..1. */
  private windowFill(state: AgentHealth): number {
    const tokenFill = Math.max(0, state.latestTokens - state.tokenBaseline) / this.tokenBudget;
    const eventFill = state.eventsSinceCondensation / this.eventBudget;
    return Math.min(1, Math.max(tokenFill, eventFill));
  }

  private classify(state: AgentHealth): ContextHealthStatus {
    const fill = this.windowFill(state);
    if (fill >= this.criticalFill) return 'critical';
    if (fill >= this.degradedFill) return 'degraded';
    return 'ok';
  }

  private toSnapshot(agentId: string, state: AgentHealth): ContextHealthSnapshot {
    return {
      agentId,
      ...(state.taskId !== undefined ? { taskId: state.taskId } : {}),
      ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
      windowFillPct: this.windowFill(state),
      eventsSinceCondensation: state.eventsSinceCondensation,
      condensationCount: state.condensationCount,
      ...(state.lastCondensationAt !== undefined
        ? { lastCondensationAt: state.lastCondensationAt }
        : {}),
      status: state.status,
    };
  }

  /** Publish a `ContextHealthChanged` transition observation. */
  private emitChanged(source: SupervisorEvent, state: AgentHealth): void {
    const event: ContextHealthChangedEvent = {
      type: 'ContextHealthChanged',
      timestamp: new Date().toISOString(),
      taskId: state.taskId ?? source.taskId,
      sessionId: state.sessionId ?? source.sessionId,
      agentId: source.agentId,
      adapterFidelityTier: source.adapterFidelityTier,
      status: state.status,
      windowFillPct: this.windowFill(state),
      ...(state.lastCondensationAt !== undefined
        ? { lastCondensationAt: state.lastCondensationAt }
        : {}),
      details: `eventsSinceCondensation=${state.eventsSinceCondensation}, condensations=${state.condensationCount}`,
    };
    this.bus.publish(event);
  }
}
