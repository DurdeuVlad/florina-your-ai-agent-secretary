/**
 * Stub adapter (Tier E) — synthetic event emitter for end-to-end pipeline
 * testing (DEC-013, issue #9).
 *
 * The stub adapter emits synthetic {@link SupervisorEvent}s across all 13
 * variants so the daemon → event journal → live stream pipeline can be
 * exercised before real adapters (Codex, Claude Code) land. It declares
 * fidelity tier **E** (PTY heuristic / last-resort), which means the
 * attention engine will never auto-approve any permission-like event it
 * produces.
 *
 * The stub is configurable: a caller can supply a specific event sequence to
 * emit, or use the default sequence that covers every variant exactly once.
 */
import { AdapterFidelityTier } from '../../../core/domain/enums.js';
import type { SupervisorEvent } from '../../../core/domain/events.js';
import type { EventPublisherPort } from '../../../core/application/ports/outbound/event-stream.js';
import { BaseAdapter, type SessionConfig, type StartRunResult } from './base.js';

/** Stable id for the stub adapter. */
export const STUB_ADAPTER_ID = 'stub';

/**
 * Configuration for the stub adapter.
 */
export interface StubAdapterOptions {
  /**
   * Explicit event sequence to emit. When omitted, the stub emits one event
   * of each of the 13 variants in canonical order (see
   * {@link SUPERVISOR_EVENT_TYPES}).
   */
  readonly events?: readonly SupervisorEvent[];
  /**
   * Delay (ms) between emitted events. Defaults to 0 so tests run fast; set
   * to a positive value to simulate a real streaming agent.
   */
  readonly delayMs?: number;
}

/**
 * Build the default synthetic event sequence: one event per variant, in the
 * canonical order defined by {@link SUPERVISOR_EVENT_TYPES}. Every event is
 * valid against the DEC-019 schema.
 *
 * @param ctx - Common envelope fields (taskId, sessionId, agentId).
 */
export function buildDefaultStubEvents(ctx: {
  taskId: string;
  sessionId: string;
  agentId: string;
}): SupervisorEvent[] {
  const { taskId, sessionId, agentId } = ctx;
  const tier: AdapterFidelityTier = AdapterFidelityTier.E;
  const ts = (): string => new Date().toISOString();
  const base = {
    timestamp: ts(),
    taskId,
    sessionId,
    agentId,
    adapterFidelityTier: tier,
  };
  return [
    { ...base, type: 'AgentStarted', objective: 'Stub objective', workingDir: '/repo/stub' },
    { ...base, type: 'AgentProgress', message: 'Stub progress', step: 1, totalSteps: 23 },
    { ...base, type: 'ToolStarted', toolName: 'shell', args: { cmd: 'echo stub' } },
    {
      ...base,
      type: 'ToolFinished',
      toolName: 'shell',
      success: true,
      durationMs: 10,
      result: { stdout: 'stub' },
    },
    {
      ...base,
      type: 'FileChanged',
      path: 'src/stub.ts',
      changeType: 'modified',
      additions: 1,
      deletions: 0,
    },
    {
      ...base,
      type: 'TestStarted',
      framework: 'vitest',
      target: 'tests/stub.test.ts',
      command: 'npm test',
    },
    {
      ...base,
      type: 'TestFinished',
      framework: 'vitest',
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 5,
    },
    {
      ...base,
      type: 'ApprovalRequested',
      task: 'Stub objective',
      agent: agentId,
      capability: 'network',
      destination: 'registry.npmjs.org',
      command: 'npm install',
      workingDir: '/repo/stub',
      scope: [{ type: 'network', targets: ['registry.npmjs.org'] }],
      riskLevel: 'low',
    },
    {
      ...base,
      type: 'HumanInputRequested',
      task: 'Stub objective',
      agent: agentId,
      capability: 'other',
      destination: 'n/a',
      command: 'n/a',
      workingDir: '/repo/stub',
      scope: [{ type: 'other', targets: ['n/a'] }],
      riskLevel: 'low',
      prompt: 'Stub: which branch?',
      inputType: 'choice',
      choices: ['main', 'develop'],
    },
    {
      ...base,
      type: 'ApprovalGranted',
      grantId: 'stub-grant-1',
      capability: 'network',
      duration: 'task',
      scopes: [{ type: 'network', targets: ['registry.npmjs.org'] }],
      grantedBy: 'stub-human',
      authorityLevel: 'authenticatedUI',
    },
    {
      ...base,
      type: 'ApprovalRevoked',
      grantId: 'stub-grant-1',
      reason: 'stub revocation',
    },
    {
      ...base,
      type: 'AgentBlocked',
      reason: 'Stub dependency wait',
      blockerType: 'dependency',
      retryable: true,
    },
    {
      ...base,
      type: 'AgentCompleted',
      summary: 'Stub completed',
      deliverables: [{ type: 'commit', ref: 'stub-sha', summary: 'stub work' }],
      exitCode: 0,
      durationMs: 100,
    },
    { ...base, type: 'AgentFailed', error: 'Stub failure', exitCode: 1, recoverable: true },
    { ...base, type: 'AgentStopped', reason: 'user', details: 'Stub cancelled' },
    {
      ...base,
      type: 'UsageReported',
      provider: 'stub',
      model: 'stub-model',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
    {
      ...base,
      type: 'QuotaObserved',
      provider: 'stub',
      window: 'five_hour',
      usedPct: 0.5,
      resetsAt: null,
      status: 'allowed',
      source: 'polled',
    },
    {
      ...base,
      type: 'TaskFailedOver',
      fromProvider: 'stub',
      toProvider: 'stub-2',
      reason: 'quota_exhausted',
    },
    { ...base, type: 'TaskParked', reason: 'stub park', resumeAt: null },
    { ...base, type: 'TaskResumed', provider: 'stub-2' },
    {
      ...base,
      type: 'ContextCondensed',
      summary: 'stub condensation',
      forgottenEventIds: ['evt-1'],
      keptEventCount: 2,
    },
    { ...base, type: 'ContextHealthChanged', status: 'ok', windowFillPct: 0.1 },
    {
      ...base,
      type: 'VerificationObserved',
      kind: 'test',
      success: true,
      command: 'npm test',
      summary: 'stub verified',
    },
  ];
}

/**
 * A Tier E stub adapter for pipeline testing.
 *
 * Emits synthetic events across all 23 {@link SupervisorEvent} variants. The
 * event sequence is configurable via {@link StubAdapterOptions.events}; by
 * default the stub emits one of each variant in canonical order.
 */
export class StubAdapter extends BaseAdapter {
  private readonly options: StubAdapterOptions;
  private activeSession: SessionConfig | null = null;
  private cancelled = false;
  /** Queue of events to emit, populated on `startRun`. */
  private eventQueue: SupervisorEvent[] = [];

  constructor(bus?: EventPublisherPort | null, options: StubAdapterOptions = {}) {
    super(STUB_ADAPTER_ID, AdapterFidelityTier.E, bus);
    this.options = options;
  }

  async connect(): Promise<void> {
    this.setConnectionState('connecting');
    // Simulate an immediate successful connection.
    this.setConnectionState('connected');
  }

  async startRun(taskId: string, sessionConfig: SessionConfig): Promise<StartRunResult> {
    this.requireConnected();
    if (this.activeSession !== null) {
      throw new Error(
        `Stub adapter already has an active session: ${this.activeSession.sessionId}`,
      );
    }
    this.activeSession = sessionConfig;
    this.cancelled = false;
    this.eventQueue = this.buildEventQueue(sessionConfig);
    void taskId; // taskId is carried in sessionConfig; kept for interface parity.
    return { sessionId: sessionConfig.sessionId, started: true };
  }

  async *streamEvents(): AsyncIterable<SupervisorEvent> {
    this.requireConnected();
    if (this.activeSession === null) {
      return;
    }
    const delay = this.options.delayMs ?? 0;
    while (this.eventQueue.length > 0 && !this.cancelled) {
      const event = this.eventQueue.shift()!;
      // Emit to the live bus (if any) so subscribers receive the event.
      this.emitEvent(event);
      yield event;
      if (delay > 0 && this.eventQueue.length > 0) {
        await sleep(delay);
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.activeSession?.sessionId !== sessionId) {
      return;
    }
    this.cancelled = true;
    this.activeSession = null;
  }

  async disconnect(): Promise<void> {
    this.activeSession = null;
    this.eventQueue = [];
    if (this.connectionState !== 'disconnected') {
      this.setConnectionState('disconnected');
    }
  }

  /**
   * Build the event queue for a run. Uses the configured event sequence when
   * provided, otherwise the default 13-variant sequence.
   */
  private buildEventQueue(sessionConfig: SessionConfig): SupervisorEvent[] {
    if (this.options.events) {
      return [...this.options.events];
    }
    return buildDefaultStubEvents({
      taskId: sessionConfig.taskId,
      sessionId: sessionConfig.sessionId,
      agentId: sessionConfig.agentId,
    });
  }
}

/** Promise-based delay helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
