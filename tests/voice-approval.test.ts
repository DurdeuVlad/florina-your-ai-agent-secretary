import { describe, it, expect, beforeEach } from 'vitest';

import { SpokenPromptBuilder, ApprovalRouter } from '../src/voice/approval-router.js';
import type { ApprovalRoutingResult } from '../src/voice/approval-router.js';
import { VoiceApprover } from '../src/voice/voice-approver.js';
import type { VoiceInteractionBridge } from '../src/voice/voice-approver.js';
import { VoiceInteractionTimeout } from '../src/voice/voice-approver.js';
import {
  parseApprovalResponse,
  AFFIRMATIVE_PHRASES,
  NEGATIVE_PHRASES,
} from '../src/voice/response-parser.js';
import type { ApprovalRequestedEvent } from '../src/domain/events.js';
import { EventBus } from '../src/daemon/event-stream.js';
import { CapabilityRiskLevel } from '../src/domain/capabilities.js';

/* ================================================================== *
 * Helpers / fixtures
 * ================================================================== */

/** Base envelope shared by every event variant. */
const baseEnvelope = {
  timestamp: '2026-08-19T12:00:00.000Z',
  taskId: 'task-42',
  sessionId: 'sess-7',
  agentId: 'codex',
  adapterFidelityTier: 'A' as const,
};

/** Build an ApprovalRequestedEvent with sensible defaults. */
function makeApprovalEvent(
  overrides: Partial<ApprovalRequestedEvent> = {},
): ApprovalRequestedEvent {
  return {
    ...baseEnvelope,
    type: 'ApprovalRequested',
    task: 'Add cursor pagination to invoices',
    agent: 'codex',
    capability: 'network',
    destination: 'registry.npmjs.org',
    command: 'npm install',
    workingDir: '/repo/invoices',
    scope: [{ type: 'network', targets: ['registry.npmjs.org'] }],
    riskLevel: CapabilityRiskLevel.Low,
    ...overrides,
  };
}

/**
 * Mock VoiceInteractionBridge. Each call to `speakAndListen` pops the next
 * queued response. If a response is a `VoiceInteractionTimeout` instance it
 * is thrown. Records the prompts spoken so tests can assert on them.
 */
class MockVoiceBridge implements VoiceInteractionBridge {
  readonly prompts: string[] = [];
  private readonly queue: (string | VoiceInteractionTimeout)[] = [];
  readonly timeouts: number[] = [];

  speakAndListen(prompt: string, timeoutMs: number): Promise<string> {
    this.prompts.push(prompt);
    this.timeouts.push(timeoutMs);
    const next = this.queue.shift();
    if (next instanceof VoiceInteractionTimeout) {
      return Promise.reject(next);
    }
    if (next === undefined) {
      return Promise.reject(new VoiceInteractionTimeout('no queued response'));
    }
    return Promise.resolve(next);
  }

  /** Queue a spoken response to be returned on the next speakAndListen call. */
  enqueue(response: string | VoiceInteractionTimeout): void {
    this.queue.push(response);
  }
}

/* ================================================================== *
 * SpokenPromptBuilder
 * ================================================================== */

describe('SpokenPromptBuilder', () => {
  const builder = new SpokenPromptBuilder();

  it('builds a concise prompt from a network capability request', () => {
    const prompt = builder.build(makeApprovalEvent());
    expect(prompt).toBe(
      'Codex wants to run npm install on registry.npmjs.org scoped to registry.npmjs.org. Allow?',
    );
  });

  it('capitalizes the agent name', () => {
    const prompt = builder.build(makeApprovalEvent({ agent: 'claude-code' }));
    expect(prompt.startsWith('Claude-code wants to')).toBe(true);
  });

  it('falls back to a capability noun phrase when no command is present', () => {
    const prompt = builder.build(
      makeApprovalEvent({
        capability: 'filesystem',
        command: '',
        destination: '/repo/data',
        scope: [{ type: 'filesystem', targets: [] }],
      }),
    );
    expect(prompt).toBe('Codex wants to access the filesystem on /repo/data. Allow?');
  });

  it('describes a git push capability', () => {
    const prompt = builder.build(
      makeApprovalEvent({
        capability: 'push',
        command: '',
        destination: 'origin/main',
        riskLevel: CapabilityRiskLevel.High,
      }),
    );
    expect(prompt).toContain('push to the remote');
    expect(prompt).toContain('origin/main');
  });

  it('lists multiple scope targets with an Oxford-comma spoken list', () => {
    const prompt = builder.build(
      makeApprovalEvent({
        scope: [{ type: 'network', targets: ['registry.npmjs.org', 'github.com'] }],
      }),
    );
    expect(prompt).toContain('registry.npmjs.org and github.com');
  });

  it('handles three scope targets', () => {
    const prompt = builder.build(
      makeApprovalEvent({
        scope: [{ type: 'network', targets: ['a.com', 'b.com', 'c.com'] }],
      }),
    );
    expect(prompt).toContain('a.com, b.com, and c.com');
  });

  it('omits scope clause when scope targets are empty', () => {
    const prompt = builder.build(makeApprovalEvent({ scope: [{ type: 'network', targets: [] }] }));
    expect(prompt).not.toContain('scoped to');
  });

  it('uses "run" prefix for shell commands', () => {
    const prompt = builder.build(
      makeApprovalEvent({ capability: 'shell', command: 'ls -la', destination: '/repo' }),
    );
    expect(prompt).toContain('wants to run ls -la');
  });
});

/* ================================================================== *
 * parseApprovalResponse
 * ================================================================== */

describe('parseApprovalResponse', () => {
  it('returns grant for affirmative phrases', () => {
    for (const phrase of AFFIRMATIVE_PHRASES) {
      const result = parseApprovalResponse(phrase);
      expect(result.intent).toBe('grant');
      expect(result.confidence).toBe(1.0);
      expect(result.matchedPhrase).toBe(phrase);
    }
  });

  it('returns deny for negative phrases', () => {
    for (const phrase of NEGATIVE_PHRASES) {
      const result = parseApprovalResponse(phrase);
      expect(result.intent).toBe('deny');
      expect(result.confidence).toBe(1.0);
      expect(result.matchedPhrase).toBe(phrase);
    }
  });

  it('is case-insensitive and strips trailing punctuation', () => {
    expect(parseApprovalResponse('Yes.').intent).toBe('grant');
    expect(parseApprovalResponse('  YEAH! ').intent).toBe('grant');
    expect(parseApprovalResponse('No,').intent).toBe('deny');
    expect(parseApprovalResponse('OK').intent).toBe('grant');
  });

  it('returns uncertain for unrecognized text', () => {
    const result = parseApprovalResponse('maybe later');
    expect(result.intent).toBe('uncertain');
    expect(result.confidence).toBe(0.5);
    expect(result.matchedPhrase).toBeUndefined();
  });

  it('returns uncertain for empty / whitespace input', () => {
    expect(parseApprovalResponse('').intent).toBe('uncertain');
    expect(parseApprovalResponse('   ').intent).toBe('uncertain');
  });

  it('does not match "no" inside "now" or "know" (word-boundary)', () => {
    expect(parseApprovalResponse('now').intent).toBe('uncertain');
    expect(parseApprovalResponse('know').intent).toBe('uncertain');
  });

  it('matches affirmative phrase embedded in a longer sentence', () => {
    expect(parseApprovalResponse('yeah go ahead').intent).toBe('grant');
    expect(parseApprovalResponse('please do it').intent).toBe('grant');
  });
});

/* ================================================================== *
 * VoiceApprover
 * ================================================================== */

describe('VoiceApprover', () => {
  let bridge: MockVoiceBridge;
  let approver: VoiceApprover;

  beforeEach(() => {
    bridge = new MockVoiceBridge();
    approver = new VoiceApprover(bridge, { timeoutMs: 30_000 });
  });

  it('grants on a single affirmative for medium risk', async () => {
    bridge.enqueue('yes');
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.Medium);
    expect(decision.decision).toBe('grant');
    expect(decision.reason).toBe('granted');
    expect(decision.rawResponse).toBe('yes');
    expect(bridge.prompts).toEqual(['Allow?']);
  });

  it('denies on a single negative for medium risk', async () => {
    bridge.enqueue('no');
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.Medium);
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('denied');
  });

  it('denies on uncertain response (fail-safe)', async () => {
    bridge.enqueue('maybe');
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.Medium);
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('uncertain');
  });

  it('denies on timeout (DEC-011 fail-safe)', async () => {
    bridge.enqueue(new VoiceInteractionTimeout());
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.Medium);
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('timeout');
    expect(decision.rawResponse).toBe('');
  });

  it('requires a confirmation round for high risk', async () => {
    bridge.enqueue('yes');
    bridge.enqueue('sure');
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.High);
    expect(decision.decision).toBe('grant');
    expect(decision.reason).toBe('confirmed');
    expect(bridge.prompts).toEqual(['Allow?', 'Are you sure?']);
  });

  it('denies high risk when confirmation is negative', async () => {
    bridge.enqueue('yes');
    bridge.enqueue('no');
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.High);
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('denied');
    expect(bridge.prompts).toEqual(['Allow?', 'Are you sure?']);
  });

  it('denies high risk when confirmation times out', async () => {
    bridge.enqueue('yes');
    bridge.enqueue(new VoiceInteractionTimeout());
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.High);
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('timeout');
  });

  it('denies high risk when first response is uncertain (no confirmation round)', async () => {
    bridge.enqueue('maybe');
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.High);
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('uncertain');
    // No confirmation round because the first response was not affirmative.
    expect(bridge.prompts).toEqual(['Allow?']);
  });

  it('denies critical risk immediately (not voice-approvable)', async () => {
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.Critical);
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('denied');
    // No voice interaction should occur.
    expect(bridge.prompts).toHaveLength(0);
  });

  it('grants low risk via a single voice round', async () => {
    bridge.enqueue('allow');
    const decision = await approver.requestApproval('Allow?', CapabilityRiskLevel.Low);
    expect(decision.decision).toBe('grant');
    expect(decision.reason).toBe('granted');
  });

  it('passes the configured timeout to the bridge', async () => {
    bridge.enqueue('yes');
    await approver.requestApproval('Allow?', CapabilityRiskLevel.Medium);
    expect(bridge.timeouts[0]).toBe(30_000);
  });
});

/* ================================================================== *
 * ApprovalRouter — risk-based hierarchy
 * ================================================================== */

describe('ApprovalRouter risk hierarchy', () => {
  let bridge: MockVoiceBridge;
  let approver: VoiceApprover;
  let results: ApprovalRoutingResult[];
  let escalations: ApprovalRequestedEvent[];

  beforeEach(() => {
    bridge = new MockVoiceBridge();
    approver = new VoiceApprover(bridge, { timeoutMs: 30_000 });
    results = [];
    escalations = [];
  });

  it('auto-approves low risk when autoApproveLowRisk is enabled', async () => {
    const router = new ApprovalRouter(approver, {
      autoApproveLowRisk: true,
      onDecision: (r) => results.push(r),
    });
    const result = await router.route(makeApprovalEvent({ riskLevel: CapabilityRiskLevel.Low }));
    expect(result.mode).toBe('auto');
    expect(result.decision.decision).toBe('grant');
    expect(bridge.prompts).toHaveLength(0);
    expect(results).toHaveLength(1);
    expect(results[0].decision.decision).toBe('grant');
  });

  it('does NOT auto-approve low risk by default (DEC-011)', async () => {
    const router = new ApprovalRouter(approver, {
      onDecision: (r) => results.push(r),
    });
    bridge.enqueue('yes');
    const result = await router.route(makeApprovalEvent({ riskLevel: CapabilityRiskLevel.Low }));
    // Default: low risk goes through voice, not auto.
    expect(result.mode).toBe('voice');
    expect(result.decision.decision).toBe('grant');
    expect(bridge.prompts).toHaveLength(1);
  });

  it('routes medium risk through a voice yes/no round', async () => {
    const router = new ApprovalRouter(approver);
    bridge.enqueue('yes');
    const result = await router.route(makeApprovalEvent({ riskLevel: CapabilityRiskLevel.Medium }));
    expect(result.mode).toBe('voice');
    expect(result.decision.decision).toBe('grant');
    expect(bridge.prompts).toHaveLength(1);
  });

  it('routes high risk through a voice confirmation round', async () => {
    const router = new ApprovalRouter(approver);
    bridge.enqueue('yes');
    bridge.enqueue('confirm');
    const result = await router.route(makeApprovalEvent({ riskLevel: CapabilityRiskLevel.High }));
    expect(result.mode).toBe('voice');
    expect(result.decision.decision).toBe('grant');
    expect(result.decision.reason).toBe('confirmed');
    expect(bridge.prompts).toEqual([expect.stringContaining('Allow?'), 'Are you sure?']);
  });

  it('rejects critical risk as not voice-approvable and escalates', async () => {
    const router = new ApprovalRouter(approver, {
      onEscalate: (e) => escalations.push(e),
      onDecision: (r) => results.push(r),
    });
    const result = await router.route(
      makeApprovalEvent({ riskLevel: CapabilityRiskLevel.Critical }),
    );
    expect(result.mode).toBe('rejected');
    expect(result.decision.decision).toBe('deny');
    expect(bridge.prompts).toHaveLength(0);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].riskLevel).toBe(CapabilityRiskLevel.Critical);
    expect(results).toHaveLength(1);
  });

  it('denies medium risk when voice denies', async () => {
    const router = new ApprovalRouter(approver);
    bridge.enqueue('no');
    const result = await router.route(makeApprovalEvent({ riskLevel: CapabilityRiskLevel.Medium }));
    expect(result.decision.decision).toBe('deny');
    expect(result.mode).toBe('voice');
  });

  it('denies medium risk on timeout (fail-safe)', async () => {
    const router = new ApprovalRouter(approver);
    bridge.enqueue(new VoiceInteractionTimeout());
    const result = await router.route(makeApprovalEvent({ riskLevel: CapabilityRiskLevel.Medium }));
    expect(result.decision.decision).toBe('deny');
    expect(result.decision.reason).toBe('timeout');
  });

  it('generates a unique approvalId per request', async () => {
    const router = new ApprovalRouter(approver, { autoApproveLowRisk: true });
    const r1 = await router.route(makeApprovalEvent());
    const r2 = await router.route(makeApprovalEvent());
    expect(r1.approvalId).not.toBe(r2.approvalId);
    expect(r1.approvalId).toMatch(/^voiceapproval_/);
  });

  it('builds an ApproveCommand from a routing result', async () => {
    const router = new ApprovalRouter(approver, { autoApproveLowRisk: true });
    const result = await router.route(makeApprovalEvent());
    const cmd = ApprovalRouter.toCommand(result);
    expect(cmd.kind).toBe('approve');
    expect(cmd.taskId).toBe('task-42');
    expect(cmd.approvalId).toBe(result.approvalId);
    expect(cmd.decision).toBe('grant');
  });
});

/* ================================================================== *
 * ApprovalRouter — EventBus integration
 * ================================================================== */

describe('ApprovalRouter EventBus integration', () => {
  it('routes ApprovalRequested events published to the EventBus', async () => {
    const bridge = new MockVoiceBridge();
    const approver = new VoiceApprover(bridge, { timeoutMs: 30_000 });
    const results: ApprovalRoutingResult[] = [];
    const router = new ApprovalRouter(approver, {
      onDecision: (r) => results.push(r),
    });
    const bus = new EventBus();
    router.start(bus);

    bridge.enqueue('yes');
    bus.publish(makeApprovalEvent({ riskLevel: CapabilityRiskLevel.Medium }));

    // Allow the async route() promise to settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(results).toHaveLength(1);
    expect(results[0].decision.decision).toBe('grant');

    router.stop();
  });

  it('ignores non-ApprovalRequested events', async () => {
    const bridge = new MockVoiceBridge();
    const approver = new VoiceApprover(bridge);
    const results: ApprovalRoutingResult[] = [];
    const router = new ApprovalRouter(approver, {
      onDecision: (r) => results.push(r),
    });
    const bus = new EventBus();
    router.start(bus);

    bus.publish({
      ...baseEnvelope,
      type: 'AgentStarted',
      objective: 'do something',
      workingDir: '/repo',
      model: 'gpt-5',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(results).toHaveLength(0);
    router.stop();
  });

  it('start is idempotent and stop unsubscribes', async () => {
    const bridge = new MockVoiceBridge();
    const approver = new VoiceApprover(bridge);
    const results: ApprovalRoutingResult[] = [];
    const router = new ApprovalRouter(approver, {
      onDecision: (r) => results.push(r),
    });
    const bus = new EventBus();
    router.start(bus);
    router.start(bus); // second start is a no-op

    bridge.enqueue('yes');
    bus.publish(makeApprovalEvent({ riskLevel: CapabilityRiskLevel.Medium }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(results).toHaveLength(1);

    router.stop();
    bridge.enqueue('yes');
    bus.publish(makeApprovalEvent({ riskLevel: CapabilityRiskLevel.Medium }));
    await new Promise((resolve) => setImmediate(resolve));
    // No new result after stop.
    expect(results).toHaveLength(1);
  });
});

/* ================================================================== *
 * Mock verification
 * ================================================================== */

describe('MockVoiceBridge', () => {
  it('throws when no response is queued', async () => {
    const bridge = new MockVoiceBridge();
    await expect(bridge.speakAndListen('hi', 1000)).rejects.toThrow();
  });
});
