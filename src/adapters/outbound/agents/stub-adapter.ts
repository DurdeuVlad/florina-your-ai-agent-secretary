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
import {
  BaseAdapter,
  type AgentSessionCapabilities,
  type MaintainContextRequest,
  type MaintainContextResult,
  type SessionConfig,
  type StartRunResult,
} from './base.js';

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
  /**
   * Session-reuse capability matrix (issue #341). The stub defaults to
   * full support so tests can exercise every `maintainContext` mode —
   * override flags to simulate an adapter that lacks a capability.
   */
  readonly capabilities?: AgentSessionCapabilities;
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
    { ...base, type: 'AgentProgress', message: 'Stub progress', step: 1, totalSteps: 25 },
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
      type: 'TaskVerifyFailed',
      attempt: 1,
      summary: 'stub verify failure',
      failedChecks: ['npm test'],
    },
    {
      ...base,
      type: 'TaskNudged',
      attempt: 2,
      budget: 2,
      prompt: 'stub corrective dispatch',
    },
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
    {
      ...base,
      type: 'SessionPooled',
      poolKey: 'stub::proj-1',
    },
    {
      ...base,
      type: 'SessionReused',
      previousTaskId: 'task-0',
      previousSessionId: 'sess-0',
      poolKey: 'stub::proj-1',
      mode: 'compacted',
    },
    {
      ...base,
      type: 'ContextMaintained',
      mode: 'compacted',
      poolKey: 'stub::proj-1',
      previousTaskId: 'task-0',
    },
  ];
}

/**
 * A Tier E stub adapter for pipeline testing.
 *
 * Emits synthetic events across all 28 {@link SupervisorEvent} variants. The
 * event sequence is configurable via {@link StubAdapterOptions.events}; by
 * default the stub emits one of each variant in canonical order.
 */
export class StubAdapter extends BaseAdapter {
  private readonly options: StubAdapterOptions;
  private activeSession: SessionConfig | null = null;
  private cancelled = false;
  /** Queue of events to emit, populated on `startRun`. */
  private eventQueue: SupervisorEvent[] = [];
  /** Follow-up messages delivered via sendMessage — inspectable in tests. */
  readonly sentMessages: { sessionId: string; message: string }[] = [];
  /** maintainContext modes applied — inspectable in tests. */
  readonly maintainCalls: { sessionId: string; carryover: string }[] = [];

  constructor(bus?: EventPublisherPort | null, options: StubAdapterOptions = {}) {
    super(
      STUB_ADAPTER_ID,
      AdapterFidelityTier.E,
      bus,
      options.capabilities ?? {
        sendMessage: true,
        resume: true,
        compact: true,
      },
    );
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

  /**
   * Deliver a follow-up message — recorded for test inspection. When the
   * event queue is drained (the session is idle between turns) this
   * seeds a fresh scripted work sequence stamped with the *current*
   * session envelope — after a compacted maintenance that envelope is
   * the new task's, so a pooled reuse produces a full follow-up turn
   * (issue #342).
   */
  async sendMessage(sessionId: string, message: string): Promise<boolean> {
    this.requireConnected();
    if (this.activeSession?.sessionId !== sessionId) {
      return false;
    }
    this.sentMessages.push({ sessionId, message });
    if (this.eventQueue.length === 0) {
      this.eventQueue = this.buildEventQueue(this.activeSession);
    }
    return true;
  }

  /** Record the call so tests can assert which mode ladder rung ran. */
  override async maintainContext(
    sessionId: string,
    request: MaintainContextRequest,
  ): Promise<MaintainContextResult> {
    this.maintainCalls.push({ sessionId, carryover: request.carryover });
    return super.maintainContext(sessionId, request);
  }

  /**
   * Synthetic provider compaction (issue #342): the provider session is
   * "kept", so only the run envelope rebinds to the new task/run ids —
   * follow-up work streams when the next delegation arrives via
   * `sendMessage`. Honored when `compact` is declared.
   */
  protected override async performCompact(
    _sessionId: string,
    request: MaintainContextRequest,
  ): Promise<boolean> {
    this.activeSession = request.restartConfig;
    return true;
  }

  /**
   * Synthetic provider-resume: swaps in the restart config, restages the
   * scripted event queue for the new run, and reports the new session
   * id — honored when `resume` is declared.
   */
  protected override async performResumeWithCarryover(
    _sessionId: string,
    request: MaintainContextRequest,
  ): Promise<string | null> {
    this.activeSession = request.restartConfig;
    this.eventQueue = this.buildEventQueue(request.restartConfig);
    return request.restartConfig.sessionId;
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
   * provided, otherwise the default 28-variant sequence. A scripted sequence
   * is restamped onto the run's envelope — after a session-pool rebind the
   * follow-up turn must carry the NEW task/run ids, not the stale scripted
   * ones (issue #342).
   */
  private buildEventQueue(sessionConfig: SessionConfig): SupervisorEvent[] {
    if (this.options.events) {
      const timestamp = new Date().toISOString();
      return this.options.events.map(
        (event) =>
          ({
            ...event,
            timestamp,
            taskId: sessionConfig.taskId,
            sessionId: sessionConfig.sessionId,
            agentId: sessionConfig.agentId,
          }) as SupervisorEvent,
      );
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
