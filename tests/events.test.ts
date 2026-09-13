import { describe, it, expect } from 'vitest';
import {
  serializeEvent,
  deserializeEvent,
  validateEvent,
  EventValidationError,
  SUPERVISOR_EVENT_TYPES,
  type SupervisorEvent,
  type AgentStartedEvent,
  type AgentProgressEvent,
  type ToolStartedEvent,
  type ToolFinishedEvent,
  type FileChangedEvent,
  type TestStartedEvent,
  type TestFinishedEvent,
  type ApprovalRequestedEvent,
  type HumanInputRequestedEvent,
  type AgentBlockedEvent,
  type AgentCompletedEvent,
  type AgentFailedEvent,
  type AgentStoppedEvent,
  type UsageReportedEvent,
  type QuotaObservedEvent,
  type TaskFailedOverEvent,
  type TaskParkedEvent,
  type TaskResumedEvent,
  type ContextCondensedEvent,
  type ContextHealthChangedEvent,
  type VerificationObservedEvent,
} from '../src/domain/events.js';

/** Common envelope shared by every test event. */
const base = {
  timestamp: '2026-08-19T12:00:00.000Z',
  taskId: 'task-42',
  sessionId: 'sess-7',
  agentId: 'codex',
  adapterFidelityTier: 'A' as const,
};

/** A valid example of each of the 13 variants. */
const validExamples: SupervisorEvent[] = [
  {
    ...base,
    type: 'AgentStarted',
    objective: 'Add cursor pagination to invoices',
    workingDir: '/repo/invoices',
    model: 'gpt-5',
  } satisfies AgentStartedEvent,
  {
    ...base,
    type: 'AgentProgress',
    message: 'Analyzing repository structure',
    step: 2,
    totalSteps: 5,
  } satisfies AgentProgressEvent,
  {
    ...base,
    type: 'ToolStarted',
    toolName: 'shell',
    args: { cmd: 'npm test' },
  } satisfies ToolStartedEvent,
  {
    ...base,
    type: 'ToolFinished',
    toolName: 'shell',
    args: { cmd: 'npm test' },
    result: { exitCode: 0 },
    success: true,
    durationMs: 1200,
  } satisfies ToolFinishedEvent,
  {
    ...base,
    type: 'FileChanged',
    path: 'src/auth.ts',
    changeType: 'modified',
    additions: 12,
    deletions: 3,
  } satisfies FileChangedEvent,
  {
    ...base,
    type: 'TestStarted',
    framework: 'vitest',
    target: 'src/auth.test.ts',
    command: 'npm test',
  } satisfies TestStartedEvent,
  {
    ...base,
    type: 'TestFinished',
    framework: 'vitest',
    target: 'src/auth.test.ts',
    passed: 23,
    failed: 1,
    skipped: 0,
    durationMs: 4500,
    failures: [{ name: 'auth flow', message: 'expected 200 got 401' }],
  } satisfies TestFinishedEvent,
  {
    ...base,
    type: 'ApprovalRequested',
    task: 'Add cursor pagination to invoices',
    agent: 'codex',
    capability: 'network',
    destination: 'registry.npmjs.org',
    command: 'npm install',
    workingDir: '/repo/invoices',
    scope: [{ type: 'network', targets: ['registry.npmjs.org'] }],
    riskLevel: 'low',
  } satisfies ApprovalRequestedEvent,
  {
    ...base,
    type: 'HumanInputRequested',
    task: 'Add cursor pagination to invoices',
    agent: 'codex',
    capability: 'shell',
    destination: '/bin/bash',
    command: 'rm -rf node_modules',
    workingDir: '/repo/invoices',
    scope: [{ type: 'filesystem', targets: ['node_modules'] }],
    riskLevel: 'high',
    prompt: 'Should I delete node_modules?',
    inputType: 'confirm',
    choices: ['yes', 'no'],
  } satisfies HumanInputRequestedEvent,
  {
    ...base,
    type: 'AgentBlocked',
    reason: 'Waiting on PR review',
    blockerType: 'dependency',
    retryable: true,
    details: 'PR #123 needs merge',
  } satisfies AgentBlockedEvent,
  {
    ...base,
    type: 'AgentCompleted',
    summary: 'Added cursor pagination',
    deliverables: [{ type: 'commit', ref: 'abc123', summary: 'Implement pagination' }],
    exitCode: 0,
    durationMs: 60000,
  } satisfies AgentCompletedEvent,
  {
    ...base,
    type: 'AgentFailed',
    error: 'Non-zero exit code',
    exitCode: 1,
    stack: 'Error: ...',
    recoverable: true,
  } satisfies AgentFailedEvent,
  {
    ...base,
    type: 'AgentStopped',
    reason: 'user',
    details: 'User cancelled via CLI',
  } satisfies AgentStoppedEvent,
  {
    ...base,
    type: 'UsageReported',
    provider: 'codex',
    model: 'gpt-5',
    promptTokens: 1200,
    completionTokens: 300,
    totalTokens: 1500,
    costUsd: 0.02,
  } satisfies UsageReportedEvent,
  {
    ...base,
    type: 'QuotaObserved',
    provider: 'codex',
    window: 'five_hour',
    usedPct: 0.92,
    resetsAt: '2026-08-19T17:00:00.000Z',
    status: 'warning',
    source: 'polled',
  } satisfies QuotaObservedEvent,
  {
    ...base,
    type: 'TaskFailedOver',
    fromProvider: 'codex',
    toProvider: 'gemini',
    reason: 'quota_exhausted',
  } satisfies TaskFailedOverEvent,
  {
    ...base,
    type: 'TaskParked',
    reason: 'all candidate providers exhausted',
    resumeAt: '2026-08-19T17:00:00.000Z',
  } satisfies TaskParkedEvent,
  {
    ...base,
    type: 'TaskResumed',
    provider: 'claude-code',
    model: 'sonnet',
  } satisfies TaskResumedEvent,
  {
    ...base,
    type: 'ContextCondensed',
    summary: 'Explored auth flow; decided on JWT refresh',
    forgottenEventIds: ['evt-1', 'evt-2', 'evt-3'],
    keptEventCount: 6,
  } satisfies ContextCondensedEvent,
  {
    ...base,
    type: 'ContextHealthChanged',
    status: 'degraded',
    windowFillPct: 0.87,
    lastCondensationAt: '2026-08-19T11:30:00.000Z',
  } satisfies ContextHealthChangedEvent,
  {
    ...base,
    type: 'VerificationObserved',
    kind: 'test',
    success: true,
    command: 'npm test',
    summary: '1623 passed, 0 failed',
    evidence: { exitCode: 0 },
  } satisfies VerificationObservedEvent,
];

describe('SupervisorEvent schema', () => {
  describe('SUPERVISOR_EVENT_TYPES', () => {
    it('lists exactly the 21 canonical variants', () => {
      expect(SUPERVISOR_EVENT_TYPES).toHaveLength(21);
      expect(SUPERVISOR_EVENT_TYPES).toEqual([
        'AgentStarted',
        'AgentProgress',
        'ToolStarted',
        'ToolFinished',
        'FileChanged',
        'TestStarted',
        'TestFinished',
        'ApprovalRequested',
        'HumanInputRequested',
        'AgentBlocked',
        'AgentCompleted',
        'AgentFailed',
        'AgentStopped',
        'UsageReported',
        'QuotaObserved',
        'TaskFailedOver',
        'TaskParked',
        'TaskResumed',
        'ContextCondensed',
        'ContextHealthChanged',
        'VerificationObserved',
      ]);
    });
  });

  describe('valid example coverage', () => {
    it('provides one valid example per variant', () => {
      const covered = new Set(validExamples.map((e) => e.type));
      for (const t of SUPERVISOR_EVENT_TYPES) {
        expect(covered.has(t), `missing example for ${t}`).toBe(true);
      }
    });
  });

  describe('construct + validate every variant', () => {
    for (const example of validExamples) {
      it(`constructs and validates ${example.type}`, () => {
        const result = validateEvent(example);
        expect(result).toEqual(example);
      });
    }
  });

  describe('round-trip serialize/deserialize for every variant', () => {
    for (const example of validExamples) {
      it(`round-trips ${example.type} losslessly`, () => {
        const json = serializeEvent(example);
        const restored = deserializeEvent(json);
        expect(restored).toEqual(example);
        // JSON wire form must be a string with the discriminant.
        expect(typeof json).toBe('string');
        expect(JSON.parse(json).type).toBe(example.type);
      });
    }

    it('serialize rejects invalid in-memory events', () => {
      const broken = { ...base, type: 'AgentStarted' } as unknown as SupervisorEvent;
      expect(() => serializeEvent(broken)).toThrow(EventValidationError);
    });
  });

  describe('invalid events fail validation with clear errors', () => {
    it('rejects non-object input', () => {
      expect(() => validateEvent('not-an-object')).toThrow(EventValidationError);
      expect(() => validateEvent(42)).toThrow(EventValidationError);
      expect(() => validateEvent(null)).toThrow(EventValidationError);
      expect(() => validateEvent([])).toThrow(EventValidationError);
    });

    it('rejects an unknown event type', () => {
      const bad = { ...base, type: 'UnknownThing' };
      expect(() => validateEvent(bad)).toThrow(/UnknownThing/);
    });

    it('rejects a missing event type', () => {
      const { type: _omit, ...bad } = base;
      void _omit;
      expect(() => validateEvent(bad)).toThrow(/"type"/);
    });

    it('rejects a malformed timestamp', () => {
      const bad = {
        ...base,
        type: 'AgentStarted',
        objective: 'x',
        workingDir: '/r',
        timestamp: 'yesterday',
      };
      expect(() => validateEvent(bad)).toThrow(/timestamp/);
    });

    it('rejects an invalid adapter fidelity tier', () => {
      const bad = {
        ...base,
        type: 'AgentStarted',
        objective: 'x',
        workingDir: '/r',
        adapterFidelityTier: 'Z',
      };
      expect(() => validateEvent(bad)).toThrow(/adapterFidelityTier/);
    });

    it('rejects empty taskId / sessionId / agentId', () => {
      const bad = {
        ...base,
        type: 'AgentStarted',
        objective: 'x',
        workingDir: '/r',
        taskId: '',
      };
      expect(() => validateEvent(bad)).toThrow(/taskId/);
    });

    it('collects multiple problems at once', () => {
      const bad = {
        type: 'Nope',
        timestamp: 'bad',
        taskId: '',
        sessionId: '',
        agentId: '',
        adapterFidelityTier: 'Z',
      };
      try {
        validateEvent(bad);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EventValidationError);
        const e = err as EventValidationError;
        expect(e.problems.length).toBeGreaterThanOrEqual(5);
        // Message lists every problem.
        expect(e.message).toContain('type');
        expect(e.message).toContain('timestamp');
        expect(e.message).toContain('taskId');
        expect(e.message).toContain('adapterFidelityTier');
      }
    });

    it('AgentStarted requires objective + workingDir', () => {
      const bad = { ...base, type: 'AgentStarted' };
      expect(() => validateEvent(bad)).toThrow(/objective/);
      expect(() => validateEvent(bad)).toThrow(/workingDir/);
    });

    it('AgentProgress requires message', () => {
      const bad = { ...base, type: 'AgentProgress', step: 'two' };
      expect(() => validateEvent(bad)).toThrow(/message/);
      expect(() => validateEvent(bad)).toThrow(/step/);
    });

    it('ToolStarted requires toolName', () => {
      const bad = { ...base, type: 'ToolStarted', args: 'not-an-object' };
      expect(() => validateEvent(bad)).toThrow(/toolName/);
      expect(() => validateEvent(bad)).toThrow(/args/);
    });

    it('ToolFinished requires success boolean and toolName', () => {
      const bad = { ...base, type: 'ToolFinished', success: 'yes' };
      expect(() => validateEvent(bad)).toThrow(/toolName/);
      expect(() => validateEvent(bad)).toThrow(/success/);
    });

    it('FileChanged requires path + valid changeType', () => {
      const bad = { ...base, type: 'FileChanged', changeType: 'moved' };
      expect(() => validateEvent(bad)).toThrow(/path/);
      expect(() => validateEvent(bad)).toThrow(/changeType/);
    });

    it('TestFinished requires passed/failed/skipped numbers', () => {
      const bad = { ...base, type: 'TestFinished', passed: '23', failed: 1, skipped: 0 };
      expect(() => validateEvent(bad)).toThrow(/passed/);
    });

    it('TestFinished validates failures entries', () => {
      const bad = {
        ...base,
        type: 'TestFinished',
        passed: 1,
        failed: 1,
        skipped: 0,
        failures: [{ name: 'x' }],
      };
      expect(() => validateEvent(bad)).toThrow(/failures\[0\].message/);
    });

    it('ApprovalRequested requires all DEC-010 capability fields', () => {
      const bad = { ...base, type: 'ApprovalRequested', task: 't', agent: 'a' };
      try {
        validateEvent(bad);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EventValidationError);
        const e = err as EventValidationError;
        expect(e.problems.some((p) => p.includes('capability'))).toBe(true);
        expect(e.problems.some((p) => p.includes('destination'))).toBe(true);
        expect(e.problems.some((p) => p.includes('command'))).toBe(true);
        expect(e.problems.some((p) => p.includes('workingDir'))).toBe(true);
        expect(e.problems.some((p) => p.includes('riskLevel'))).toBe(true);
        expect(e.problems.some((p) => p.includes('scope'))).toBe(true);
      }
    });

    it('ApprovalRequested rejects invalid capability + riskLevel + scope', () => {
      const bad = {
        ...base,
        type: 'ApprovalRequested',
        task: 't',
        agent: 'a',
        capability: 'flying',
        destination: 'd',
        command: 'c',
        workingDir: '/r',
        riskLevel: 'extreme',
        scope: [{ type: 'flying', targets: 'not-an-array' }],
      };
      expect(() => validateEvent(bad)).toThrow(/capability/);
      expect(() => validateEvent(bad)).toThrow(/riskLevel/);
      expect(() => validateEvent(bad)).toThrow(/scope\[0\].type/);
      expect(() => validateEvent(bad)).toThrow(/scope\[0\].targets/);
    });

    it('HumanInputRequested requires prompt and capability fields', () => {
      const bad = {
        ...base,
        type: 'HumanInputRequested',
        task: 't',
        agent: 'a',
        capability: 'shell',
        destination: 'd',
        command: 'c',
        workingDir: '/r',
        riskLevel: 'low',
        scope: [],
        inputType: 'voice',
      };
      expect(() => validateEvent(bad)).toThrow(/prompt/);
      expect(() => validateEvent(bad)).toThrow(/inputType/);
    });

    it('AgentBlocked requires reason, valid blockerType, retryable', () => {
      const bad = { ...base, type: 'AgentBlocked', blockerType: 'mood', retryable: 'yes' };
      expect(() => validateEvent(bad)).toThrow(/reason/);
      expect(() => validateEvent(bad)).toThrow(/blockerType/);
      expect(() => validateEvent(bad)).toThrow(/retryable/);
    });

    it('AgentCompleted requires summary + deliverables array', () => {
      const bad = { ...base, type: 'AgentCompleted', deliverables: 'none' };
      expect(() => validateEvent(bad)).toThrow(/summary/);
      expect(() => validateEvent(bad)).toThrow(/deliverables/);
    });

    it('AgentCompleted validates deliverable entries', () => {
      const bad = {
        ...base,
        type: 'AgentCompleted',
        summary: 'done',
        deliverables: [{ ref: 123 }],
      };
      expect(() => validateEvent(bad)).toThrow(/deliverables\[0\].type/);
      expect(() => validateEvent(bad)).toThrow(/deliverables\[0\].ref/);
    });

    it('AgentFailed requires error + recoverable', () => {
      const bad = { ...base, type: 'AgentFailed', recoverable: 'maybe' };
      expect(() => validateEvent(bad)).toThrow(/error/);
      expect(() => validateEvent(bad)).toThrow(/recoverable/);
    });

    it('AgentStopped requires valid reason', () => {
      const bad = { ...base, type: 'AgentStopped', reason: 'bored' };
      expect(() => validateEvent(bad)).toThrow(/reason/);
    });
  });

  describe('deserialize error handling', () => {
    it('throws SyntaxError on invalid JSON', () => {
      expect(() => deserializeEvent('{not json')).toThrow(SyntaxError);
    });

    it('throws EventValidationError on valid JSON that is not an event', () => {
      expect(() => deserializeEvent('"a string"')).toThrow(EventValidationError);
      expect(() => deserializeEvent('{"type":"Nope"}')).toThrow(EventValidationError);
    });
  });
});
