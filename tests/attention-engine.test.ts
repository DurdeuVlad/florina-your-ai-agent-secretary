import { describe, it, expect, beforeEach } from 'vitest';
import {
  AttentionEngine,
  type AttentionClassification,
  type TaskContext,
} from '../src/attention/engine.js';
import { FailureTracker, DEFAULT_FAILURE_THRESHOLD } from '../src/attention/failure-tracker.js';
import {
  LivenessMonitor,
  DEFAULT_LIVENESS_TIMEOUT_MS,
  MEANINGFUL_EVENT_TYPES,
} from '../src/attention/liveness-monitor.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import type {
  AgentStartedEvent,
  AgentProgressEvent,
  ToolStartedEvent,
  ToolFinishedEvent,
  FileChangedEvent,
  TestStartedEvent,
  TestFinishedEvent,
  ApprovalRequestedEvent,
  HumanInputRequestedEvent,
  AgentBlockedEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStoppedEvent,
} from '../src/domain/events.js';
import type { AdapterFidelityTier } from '../src/domain/enums.js';
import { AttentionCategory as Cat, AttentionPriority as Pri } from '../src/domain/enums.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

/** Common envelope shared by every test event. */
const base = {
  timestamp: '2026-08-19T12:00:00.000Z',
  taskId: 'task-42',
  sessionId: 'sess-7',
  agentId: 'codex',
  adapterFidelityTier: 'A' as const,
};

/** A default task context with no failures and no liveness timeout. */
const cleanContext: TaskContext = {
  taskId: 'task-42',
  consecutiveFailures: 0,
  livenessTimedOut: false,
};

/** Build an ApprovalRequested event with the given capability and risk. */
function approvalEvent(
  capability: string,
  riskLevel: string,
  overrides: Partial<ApprovalRequestedEvent> = {},
): ApprovalRequestedEvent {
  return {
    ...base,
    type: 'ApprovalRequested',
    task: 'Test task',
    agent: 'codex',
    capability: capability as ApprovalRequestedEvent['capability'],
    destination: 'example.com',
    command: 'npm install',
    workingDir: '/repo',
    scope: [{ type: capability as ApprovalRequestedEvent['scope'][0]['type'], targets: ['example.com'] }],
    riskLevel: riskLevel as ApprovalRequestedEvent['riskLevel'],
    ...overrides,
  };
}

/** Build a FileChanged event for the given path. */
function fileChangedEvent(path: string, overrides: Partial<FileChangedEvent> = {}): FileChangedEvent {
  return {
    ...base,
    type: 'FileChanged',
    path,
    changeType: 'modified',
    ...overrides,
  };
}

/** Build an AgentFailed event. */
function failedEvent(overrides: Partial<AgentFailedEvent> = {}): AgentFailedEvent {
  return {
    ...base,
    type: 'AgentFailed',
    error: 'Non-zero exit code',
    recoverable: true,
    ...overrides,
  };
}

/** Build an AgentCompleted event. */
function completedEvent(overrides: Partial<AgentCompletedEvent> = {}): AgentCompletedEvent {
  return {
    ...base,
    type: 'AgentCompleted',
    summary: 'Task done',
    deliverables: [{ type: 'commit', ref: 'abc123' }],
    exitCode: 0,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * FailureTracker
 * ------------------------------------------------------------------ */

describe('FailureTracker', () => {
  let tracker: FailureTracker;

  beforeEach(() => {
    tracker = new FailureTracker();
  });

  it('defaults to a threshold of 3', () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(3);
    expect(tracker.failureThreshold).toBe(3);
  });

  it('starts with a failure count of 0 for unknown tasks', () => {
    expect(tracker.getFailureCount('task-1')).toBe(0);
    expect(tracker.isThresholdExceeded('task-1')).toBe(false);
  });

  it('increments the count on recordFailure', () => {
    tracker.recordFailure('task-1');
    expect(tracker.getFailureCount('task-1')).toBe(1);
    tracker.recordFailure('task-1');
    expect(tracker.getFailureCount('task-1')).toBe(2);
  });

  it('resets the count on resetOnSuccess', () => {
    tracker.recordFailure('task-1');
    tracker.recordFailure('task-1');
    tracker.resetOnSuccess('task-1');
    expect(tracker.getFailureCount('task-1')).toBe(0);
  });

  it('tracks different tasks independently', () => {
    tracker.recordFailure('task-1');
    tracker.recordFailure('task-1');
    tracker.recordFailure('task-2');
    expect(tracker.getFailureCount('task-1')).toBe(2);
    expect(tracker.getFailureCount('task-2')).toBe(1);
  });

  it('detects when threshold is exceeded', () => {
    tracker.recordFailure('task-1');
    tracker.recordFailure('task-1');
    expect(tracker.isThresholdExceeded('task-1')).toBe(false);
    tracker.recordFailure('task-1');
    expect(tracker.isThresholdExceeded('task-1')).toBe(true);
  });

  it('supports a configurable threshold', () => {
    const custom = new FailureTracker({ threshold: 5 });
    expect(custom.failureThreshold).toBe(5);
    for (let i = 0; i < 4; i++) custom.recordFailure('task-1');
    expect(custom.isThresholdExceeded('task-1')).toBe(false);
    custom.recordFailure('task-1');
    expect(custom.isThresholdExceeded('task-1')).toBe(true);
  });

  it('clear() removes all tracked counts', () => {
    tracker.recordFailure('task-1');
    tracker.clear();
    expect(tracker.getFailureCount('task-1')).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * LivenessMonitor
 * ------------------------------------------------------------------ */

describe('LivenessMonitor', () => {
  it('defaults to a 5-minute timeout', () => {
    expect(DEFAULT_LIVENESS_TIMEOUT_MS).toBe(5 * 60 * 1000);
    const monitor = new LivenessMonitor();
    expect(monitor.livenessTimeoutMs).toBe(5 * 60 * 1000);
  });

  it('supports a configurable timeout', () => {
    const monitor = new LivenessMonitor({ timeoutMs: 10_000 });
    expect(monitor.livenessTimeoutMs).toBe(10_000);
  });

  it('identifies meaningful event types correctly', () => {
    const meaningful: string[] = ['FileChanged', 'ToolStarted', 'ToolFinished', 'TestStarted', 'TestFinished'];
    for (const type of meaningful) {
      expect(MEANINGFUL_EVENT_TYPES.has(type)).toBe(true);
    }
    const notMeaningful: string[] = ['AgentStarted', 'AgentProgress', 'ApprovalRequested', 'AgentCompleted', 'AgentFailed'];
    for (const type of notMeaningful) {
      expect(MEANINGFUL_EVENT_TYPES.has(type)).toBe(false);
    }
  });

  it('returns false for checkLiveness when no events have been recorded', () => {
    let now = 1_000_000;
    const monitor = new LivenessMonitor({ timeoutMs: 5_000, now: () => now });
    expect(monitor.checkLiveness('task-1')).toBe(false);
  });

  it('resets the timer on meaningful events', () => {
    let now = 1_000_000;
    const monitor = new LivenessMonitor({ timeoutMs: 5_000, now: () => now });

    const event: FileChangedEvent = {
      ...base,
      type: 'FileChanged',
      path: 'src/index.ts',
      changeType: 'modified',
    };
    monitor.resetOnEvent(event);

    // Immediately after — not timed out.
    expect(monitor.checkLiveness('task-42')).toBe(false);

    // After 6 seconds — timed out.
    now += 6_000;
    expect(monitor.checkLiveness('task-42')).toBe(true);
  });

  it('does not reset the timer on non-meaningful events', () => {
    let now = 1_000_000;
    const monitor = new LivenessMonitor({ timeoutMs: 5_000, now: () => now });

    // Record a meaningful event first.
    const fileEvent: FileChangedEvent = {
      ...base,
      type: 'FileChanged',
      path: 'src/index.ts',
      changeType: 'modified',
    };
    monitor.resetOnEvent(fileEvent);

    // A non-meaningful event should NOT reset the timer.
    const progressEvent: AgentProgressEvent = {
      ...base,
      type: 'AgentProgress',
      message: 'Thinking...',
    };
    now += 3_000;
    monitor.resetOnEvent(progressEvent);

    // After 3 more seconds (6 total) — timed out because the timer was not reset.
    now += 3_000;
    expect(monitor.checkLiveness('task-42')).toBe(true);
  });

  it('tracks liveness per task independently', () => {
    let now = 1_000_000;
    const monitor = new LivenessMonitor({ timeoutMs: 5_000, now: () => now });

    monitor.seed('task-1', now);
    now += 6_000;
    monitor.seed('task-2', now);

    expect(monitor.checkLiveness('task-1')).toBe(true);
    expect(monitor.checkLiveness('task-2')).toBe(false);
  });

  it('seed() sets the last meaningful event time', () => {
    let now = 1_000_000;
    const monitor = new LivenessMonitor({ timeoutMs: 5_000, now: () => now });
    monitor.seed('task-1', now - 6_000);
    expect(monitor.checkLiveness('task-1')).toBe(true);
  });

  it('clear() removes all tracked state', () => {
    const monitor = new LivenessMonitor({ timeoutMs: 5_000 });
    monitor.seed('task-1', 1_000_000);
    monitor.clear();
    expect(monitor.getLastMeaningfulEventTime('task-1')).toBeUndefined();
  });

  it('getLastMeaningfulEventTime returns the recorded timestamp', () => {
    const fixedNow = 1_000_000;
    const monitor = new LivenessMonitor({ timeoutMs: 5_000, now: () => fixedNow });
    const event: ToolStartedEvent = {
      ...base,
      type: 'ToolStarted',
      toolName: 'shell',
    };
    monitor.resetOnEvent(event);
    const ts = monitor.getLastMeaningfulEventTime('task-42');
    expect(ts).toBe(fixedNow);
  });
});

/* ------------------------------------------------------------------ *
 * AttentionEngine — ALWAYS-SURFACE rules
 * ------------------------------------------------------------------ */

describe('AttentionEngine — ALWAYS-SURFACE rules', () => {
  let engine: AttentionEngine;

  beforeEach(() => {
    engine = new AttentionEngine();
  });

  it('surfaces ApprovalRequested events', () => {
    const event = approvalEvent('shell', 'low');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.ApprovalRequired);
  });

  it('surfaces HumanInputRequested events', () => {
    const event: HumanInputRequestedEvent = {
      ...base,
      type: 'HumanInputRequested',
      task: 'Test task',
      agent: 'codex',
      capability: 'shell',
      destination: '/bin/bash',
      command: 'rm -rf node_modules',
      workingDir: '/repo',
      scope: [{ type: 'filesystem', targets: ['node_modules'] }],
      riskLevel: 'high',
      prompt: 'Should I delete node_modules?',
      inputType: 'confirm',
      choices: ['yes', 'no'],
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.DecisionRequired);
    expect(result.priority).toBe(Pri.Med);
  });

  it('surfaces AgentFailed events', () => {
    const event = failedEvent();
    const result = engine.classify(event, 'A', { ...cleanContext, consecutiveFailures: 1 });
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.Failure);
    expect(result.priority).toBe(Pri.High);
  });

  it('surfaces repeated failures when threshold is reached', () => {
    const event = failedEvent();
    const result = engine.classify(event, 'A', { ...cleanContext, consecutiveFailures: 3 });
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.Failure);
    expect(result.priority).toBe(Pri.High);
    expect(result.reason).toContain('Repeated failure');
    expect(result.reason).toContain('3 consecutive');
  });

  it('does not flag repeated failure when below threshold', () => {
    const event = failedEvent();
    const result = engine.classify(event, 'A', { ...cleanContext, consecutiveFailures: 2 });
    expect(result.action).toBe('always-surface');
    expect(result.reason).not.toContain('Repeated failure');
  });

  it('surfaces AgentCompleted events', () => {
    const event = completedEvent();
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.Completed);
    expect(result.priority).toBe(Pri.Med);
  });

  it('surfaces sandbox violations detected from ToolFinished error', () => {
    const event: ToolFinishedEvent = {
      ...base,
      type: 'ToolFinished',
      toolName: 'shell',
      success: false,
      error: 'Sandbox violation: write access denied',
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.RiskDetected);
    expect(result.priority).toBe(Pri.High);
    expect(result.reason).toContain('Sandbox violation');
  });

  it('surfaces sandbox violations detected from ToolFinished result', () => {
    const event: ToolFinishedEvent = {
      ...base,
      type: 'ToolFinished',
      toolName: 'shell',
      success: true,
      result: { sandboxViolation: true },
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.RiskDetected);
  });

  it('surfaces sandbox violations detected from explicit event flag', () => {
    const event = {
      ...base,
      type: 'AgentProgress',
      message: 'Something happened',
      sandboxViolation: true,
    } as AgentProgressEvent & { sandboxViolation: true };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.RiskDetected);
  });

  it('surfaces liveness timeout', () => {
    const event: AgentProgressEvent = {
      ...base,
      type: 'AgentProgress',
      message: 'Thinking...',
    };
    const result = engine.classify(event, 'A', { ...cleanContext, livenessTimedOut: true });
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.RiskDetected);
    expect(result.priority).toBe(Pri.High);
    expect(result.reason).toContain('Liveness timeout');
  });
});

/* ------------------------------------------------------------------ *
 * AttentionEngine — BATCH rules
 * ------------------------------------------------------------------ */

describe('AttentionEngine — BATCH rules', () => {
  let engine: AttentionEngine;

  beforeEach(() => {
    engine = new AttentionEngine();
  });

  it('batches normal FileChanged events', () => {
    const event = fileChangedEvent('src/components/Button.tsx');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
    expect(result.category).toBe(Cat.Fyi);
    expect(result.priority).toBe(Pri.Low);
  });

  it('batches ToolStarted events', () => {
    const event: ToolStartedEvent = {
      ...base,
      type: 'ToolStarted',
      toolName: 'shell',
      args: { cmd: 'ls' },
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
    expect(result.category).toBe(Cat.Fyi);
  });

  it('batches ToolFinished events', () => {
    const event: ToolFinishedEvent = {
      ...base,
      type: 'ToolFinished',
      toolName: 'shell',
      success: true,
      durationMs: 100,
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
    expect(result.category).toBe(Cat.Fyi);
  });

  it('batches TestStarted events', () => {
    const event: TestStartedEvent = {
      ...base,
      type: 'TestStarted',
      framework: 'vitest',
      target: 'src/auth.test.ts',
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
    expect(result.category).toBe(Cat.Fyi);
  });

  it('batches TestFinished events', () => {
    const event: TestFinishedEvent = {
      ...base,
      type: 'TestFinished',
      passed: 10,
      failed: 0,
      skipped: 0,
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
    expect(result.category).toBe(Cat.Fyi);
  });

  it('batches AgentProgress events', () => {
    const event: AgentProgressEvent = {
      ...base,
      type: 'AgentProgress',
      message: 'Analyzing code...',
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
    expect(result.category).toBe(Cat.Fyi);
  });

  it('batches AgentStarted events', () => {
    const event: AgentStartedEvent = {
      ...base,
      type: 'AgentStarted',
      objective: 'Fix the bug',
      workingDir: '/repo',
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
    expect(result.category).toBe(Cat.Fyi);
  });

  it('batches AgentBlocked events (non-permission)', () => {
    const event: AgentBlockedEvent = {
      ...base,
      type: 'AgentBlocked',
      reason: 'Waiting on dependency',
      blockerType: 'dependency',
      retryable: true,
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
    expect(result.category).toBe(Cat.Blocked);
  });

  it('batches AgentStopped events', () => {
    const event: AgentStoppedEvent = {
      ...base,
      type: 'AgentStopped',
      reason: 'user',
      details: 'User cancelled',
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
    expect(result.category).toBe(Cat.Fyi);
  });
});

/* ------------------------------------------------------------------ *
 * AttentionEngine — ELEVATE rules
 * ------------------------------------------------------------------ */

describe('AttentionEngine — ELEVATE rules', () => {
  let engine: AttentionEngine;

  beforeEach(() => {
    engine = new AttentionEngine();
  });

  it('elevates FileChanged in secrets directory', () => {
    const event = fileChangedEvent('secrets/api-key.txt');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
    expect(result.category).toBe(Cat.RiskDetected);
    expect(result.priority).toBe(Pri.High);
    expect(result.reason).toContain('security-sensitive');
  });

  it('elevates FileChanged in auth directory', () => {
    const event = fileChangedEvent('src/auth/login.ts');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
    expect(result.category).toBe(Cat.RiskDetected);
  });

  it('elevates FileChanged to .env file', () => {
    const event = fileChangedEvent('.env');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates FileChanged in credentials directory', () => {
    const event = fileChangedEvent('config/credentials.yaml');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates FileChanged in .ssh directory', () => {
    const event = fileChangedEvent('.ssh/config');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates FileChanged for database migrations', () => {
    const event = fileChangedEvent('db/migrate/001_create_users.sql');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
    expect(result.category).toBe(Cat.RiskDetected);
    expect(result.reason).toContain('migration');
  });

  it('elevates FileChanged for prisma migrations', () => {
    const event = fileChangedEvent('prisma/migrations/20260101000000_init/migration.sql');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates FileChanged for CI/deploy config (.github/workflows)', () => {
    const event = fileChangedEvent('.github/workflows/ci.yml');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
    expect(result.reason).toContain('CI/deploy');
  });

  it('elevates FileChanged for Dockerfile', () => {
    const event = fileChangedEvent('Dockerfile');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates FileChanged for docker-compose', () => {
    const event = fileChangedEvent('docker-compose.yml');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates FileChanged for Jenkinsfile', () => {
    const event = fileChangedEvent('Jenkinsfile');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates FileChanged for terraform config', () => {
    const event = fileChangedEvent('terraform/main.tf');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates FileChanged for lockfiles', () => {
    const event = fileChangedEvent('package-lock.json');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
    expect(result.category).toBe(Cat.RiskDetected);
    expect(result.priority).toBe(Pri.Med);
    expect(result.reason).toContain('lockfile');
  });

  it('elevates FileChanged for yarn.lock', () => {
    const event = fileChangedEvent('yarn.lock');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates FileChanged for Cargo.lock', () => {
    const event = fileChangedEvent('Cargo.lock');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates ApprovalRequested for network capability', () => {
    const event = approvalEvent('network', 'low', {
      destination: 'registry.npmjs.org',
    });
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
    expect(result.category).toBe(Cat.ApprovalRequired);
    expect(result.priority).toBe(Pri.High);
    expect(result.reason).toContain('network');
  });

  it('elevates ApprovalRequested for push capability', () => {
    const event = approvalEvent('push', 'high', {
      destination: 'origin',
    });
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates ApprovalRequested for merge capability', () => {
    const event = approvalEvent('merge', 'high');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates ApprovalRequested for deploy capability', () => {
    const event = approvalEvent('deploy', 'critical');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates ApprovalRequested for destructive capability', () => {
    const event = approvalEvent('destructive', 'critical');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('elevates filesystem scope expansion requests', () => {
    const event = approvalEvent('filesystem', 'medium', {
      workingDir: '/repo/src',
      destination: '/etc/passwd',
      scope: [{ type: 'filesystem', targets: ['/etc/passwd'] }],
    });
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
    expect(result.category).toBe(Cat.ScopeChanged);
    expect(result.reason).toContain('scope expansion');
  });

  it('does not elevate filesystem requests within working directory', () => {
    const event = approvalEvent('filesystem', 'low', {
      workingDir: '/repo',
      destination: '/repo/src/file.ts',
      scope: [{ type: 'filesystem', targets: ['/repo/src/file.ts'] }],
    });
    const result = engine.classify(event, 'A', cleanContext);
    // Should be always-surface (not elevate) since it's within the working dir.
    expect(result.action).toBe('always-surface');
  });

  it('does not elevate normal (non-sensitive) file changes', () => {
    const event = fileChangedEvent('src/utils/helpers.ts');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
  });

  it('does not elevate low-risk shell approval requests', () => {
    const event = approvalEvent('shell', 'low', {
      command: 'ls -la',
      destination: '/bin/ls',
    });
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
  });
});

/* ------------------------------------------------------------------ *
 * AttentionEngine — Tier D–E elevation (DEC-013)
 * ------------------------------------------------------------------ */

describe('AttentionEngine — Tier D–E elevation (DEC-013)', () => {
  let engine: AttentionEngine;

  beforeEach(() => {
    engine = new AttentionEngine();
  });

  const lowFidelityTiers: AdapterFidelityTier[] = ['D', 'E'];
  const highFidelityTiers: AdapterFidelityTier[] = ['A', 'B', 'C'];

  for (const tier of lowFidelityTiers) {
    it(`elevates ApprovalRequested on Tier ${tier} (no auto-approve)`, () => {
      const event = approvalEvent('shell', 'low', {
        command: 'ls',
        destination: '/bin/ls',
      });
      const result = engine.classify(event, tier, cleanContext);
      expect(result.action).toBe('elevate');
      expect(result.priority).toBe(Pri.High);
      expect(result.reason).toContain(`Tier ${tier}`);
    });

    it(`elevates HumanInputRequested on Tier ${tier}`, () => {
      const event: HumanInputRequestedEvent = {
        ...base,
        type: 'HumanInputRequested',
        task: 'Test',
        agent: 'codex',
        capability: 'shell',
        destination: '/bin/bash',
        command: 'rm',
        workingDir: '/repo',
        scope: [{ type: 'filesystem', targets: ['/repo'] }],
        riskLevel: 'low',
        prompt: 'Continue?',
        inputType: 'confirm',
      };
      const result = engine.classify(event, tier, cleanContext);
      expect(result.action).toBe('elevate');
      expect(result.reason).toContain(`Tier ${tier}`);
    });

    it(`elevates AgentBlocked (permission) on Tier ${tier}`, () => {
      const event: AgentBlockedEvent = {
        ...base,
        type: 'AgentBlocked',
        reason: 'Needs permission',
        blockerType: 'permission',
        retryable: true,
      };
      const result = engine.classify(event, tier, cleanContext);
      expect(result.action).toBe('elevate');
      expect(result.reason).toContain(`Tier ${tier}`);
    });
  }

  for (const tier of highFidelityTiers) {
    it(`does NOT elevate low-risk ApprovalRequested on Tier ${tier}`, () => {
      const event = approvalEvent('shell', 'low', {
        command: 'ls',
        destination: '/bin/ls',
      });
      const result = engine.classify(event, tier, cleanContext);
      expect(result.action).toBe('always-surface');
    });
  }

  it('keeps ELEVATE events elevated regardless of tier', () => {
    const event = fileChangedEvent('secrets/api-key.txt');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
    const resultD = engine.classify(event, 'D', cleanContext);
    expect(resultD.action).toBe('elevate');
  });
});

/* ------------------------------------------------------------------ *
 * AttentionEngine — Determinism
 * ------------------------------------------------------------------ */

describe('AttentionEngine — Determinism', () => {
  it('same input always yields same output (with taskContext)', () => {
    const engine = new AttentionEngine();
    const event = approvalEvent('shell', 'low');
    const ctx: TaskContext = { taskId: 'task-42', consecutiveFailures: 0, livenessTimedOut: false };

    const results: AttentionClassification[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(engine.classify(event, 'A', ctx));
    }
    // All results must be identical.
    const first = JSON.stringify(results[0]);
    expect(results.every((r) => JSON.stringify(r) === first)).toBe(true);
  });

  it('deterministic for FileChanged events', () => {
    const engine = new AttentionEngine();
    const event = fileChangedEvent('src/index.ts');
    const r1 = engine.classify(event, 'A', cleanContext);
    const r2 = engine.classify(event, 'A', cleanContext);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('deterministic for AgentFailed with same failure count', () => {
    const engine = new AttentionEngine();
    const event = failedEvent();
    const ctx: TaskContext = { taskId: 'task-42', consecutiveFailures: 2, livenessTimedOut: false };
    const r1 = engine.classify(event, 'A', ctx);
    const r2 = engine.classify(event, 'A', ctx);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('deterministic for liveness timeout', () => {
    const engine = new AttentionEngine();
    const event: AgentProgressEvent = {
      ...base,
      type: 'AgentProgress',
      message: 'Thinking...',
    };
    const ctx: TaskContext = { taskId: 'task-42', consecutiveFailures: 0, livenessTimedOut: true };
    const r1 = engine.classify(event, 'A', ctx);
    const r2 = engine.classify(event, 'A', ctx);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('deterministic across different engine instances with same config', () => {
    const event = fileChangedEvent('secrets/key.pem');
    const ctx = cleanContext;
    const r1 = new AttentionEngine().classify(event, 'A', ctx);
    const r2 = new AttentionEngine().classify(event, 'A', ctx);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('different inputs can produce different outputs', () => {
    const engine = new AttentionEngine();
    const normalFile = fileChangedEvent('src/index.ts');
    const secretFile = fileChangedEvent('secrets/key.pem');
    const r1 = engine.classify(normalFile, 'A', cleanContext);
    const r2 = engine.classify(secretFile, 'A', cleanContext);
    expect(r1.action).toBe('batch');
    expect(r2.action).toBe('elevate');
  });
});

/* ------------------------------------------------------------------ *
 * AttentionEngine — Integration with trackers
 * ------------------------------------------------------------------ */

describe('AttentionEngine — Tracker integration', () => {
  it('updates the failure tracker on AgentFailed', () => {
    const engine = new AttentionEngine();
    const event = failedEvent({ taskId: 'task-1' });
    engine.classify(event, 'A', cleanContext);
    expect(engine.failureTracker.getFailureCount('task-1')).toBe(1);
  });

  it('resets the failure tracker on AgentCompleted', () => {
    const engine = new AttentionEngine();
    engine.failureTracker.recordFailure('task-1');
    engine.failureTracker.recordFailure('task-1');
    const event = completedEvent({ taskId: 'task-1' });
    engine.classify(event, 'A', cleanContext);
    expect(engine.failureTracker.getFailureCount('task-1')).toBe(0);
  });

  it('uses taskContext.consecutiveFailures when provided (overrides tracker)', () => {
    const engine = new AttentionEngine();
    const event = failedEvent({ taskId: 'task-1' });
    // Even though the tracker would show 1 after this event, taskContext says 3.
    const result = engine.classify(event, 'A', {
      taskId: 'task-1',
      consecutiveFailures: 3,
      livenessTimedOut: false,
    });
    expect(result.reason).toContain('Repeated failure');
    expect(result.reason).toContain('3 consecutive');
  });

  it('resets liveness monitor on meaningful events', () => {
    let now = 1_000_000;
    const engine = new AttentionEngine({ now: () => now, livenessTimeoutMs: 5_000 });
    const event: FileChangedEvent = {
      ...base,
      type: 'FileChanged',
      path: 'src/index.ts',
      changeType: 'modified',
    };
    engine.classify(event, 'A', cleanContext);
    // The liveness monitor should have recorded the event timestamp.
    expect(engine.livenessMonitor.getLastMeaningfulEventTime('task-42')).toBeDefined();
    // Not timed out immediately.
    expect(engine.livenessMonitor.checkLiveness('task-42')).toBe(false);
    // Timed out after 6 seconds.
    now += 6_000;
    expect(engine.livenessMonitor.checkLiveness('task-42')).toBe(true);
  });

  it('detects liveness timeout via internal monitor when no taskContext', () => {
    let now = 1_000_000;
    const engine = new AttentionEngine({ now: () => now, livenessTimeoutMs: 5_000 });

    // Seed a meaningful event in the past.
    engine.livenessMonitor.seed('task-42', now - 6_000);

    // A non-meaningful event should trigger the liveness timeout check.
    const event: AgentProgressEvent = {
      ...base,
      type: 'AgentProgress',
      message: 'Still thinking...',
    };
    const result = engine.classify(event, 'A');
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.RiskDetected);
    expect(result.reason).toContain('Liveness timeout');
  });

  it('repeated-failure detection surfaces attention item via internal tracker', () => {
    const engine = new AttentionEngine({ failureThreshold: 3 });

    // Simulate 3 consecutive failures.
    for (let i = 0; i < 3; i++) {
      const event = failedEvent({ taskId: 'task-1' });
      const result = engine.classify(event, 'A');
      if (i < 2) {
        expect(result.reason).not.toContain('Repeated failure');
      } else {
        expect(result.reason).toContain('Repeated failure');
        expect(result.reason).toContain('3 consecutive');
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * AttentionEngine — Configuration
 * ------------------------------------------------------------------ */

describe('AttentionEngine — Configuration', () => {
  it('uses default failure threshold of 3', () => {
    const engine = new AttentionEngine();
    expect(engine.failureThresholdValue).toBe(3);
  });

  it('uses default liveness timeout of 5 minutes', () => {
    const engine = new AttentionEngine();
    expect(engine.livenessTimeoutMs).toBe(5 * 60 * 1000);
  });

  it('supports custom failure threshold', () => {
    const engine = new AttentionEngine({ failureThreshold: 5 });
    expect(engine.failureThresholdValue).toBe(5);
  });

  it('supports custom liveness timeout', () => {
    const engine = new AttentionEngine({ livenessTimeoutMs: 30_000 });
    expect(engine.livenessTimeoutMs).toBe(30_000);
  });

  it('respects custom failure threshold in classification', () => {
    const engine = new AttentionEngine({ failureThreshold: 5 });
    const event = failedEvent();
    // 4 failures — below threshold of 5.
    const resultBelow = engine.classify(event, 'A', { ...cleanContext, consecutiveFailures: 4 });
    expect(resultBelow.reason).not.toContain('Repeated failure');
    // 5 failures — at threshold.
    const resultAt = engine.classify(event, 'A', { ...cleanContext, consecutiveFailures: 5 });
    expect(resultAt.reason).toContain('Repeated failure');
    expect(resultAt.reason).toContain('5 consecutive');
  });
});

/* ------------------------------------------------------------------ *
 * AttentionEngine — Priority mapping
 * ------------------------------------------------------------------ */

describe('AttentionEngine — Priority mapping', () => {
  let engine: AttentionEngine;

  beforeEach(() => {
    engine = new AttentionEngine();
  });

  it('maps low risk to MED priority for ApprovalRequested', () => {
    const event = approvalEvent('shell', 'low', { command: 'ls', destination: '/bin/ls' });
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.priority).toBe(Pri.Med);
  });

  it('maps medium risk to MED priority for ApprovalRequested', () => {
    const event = approvalEvent('shell', 'medium');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.priority).toBe(Pri.Med);
  });

  it('maps high risk to HIGH priority for ApprovalRequested', () => {
    const event = approvalEvent('shell', 'high');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.priority).toBe(Pri.High);
  });

  it('maps critical risk to HIGH priority for ApprovalRequested', () => {
    const event = approvalEvent('shell', 'critical');
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.priority).toBe(Pri.High);
  });
});

/* ------------------------------------------------------------------ *
 * AttentionEngine — Edge cases
 * ------------------------------------------------------------------ */

describe('AttentionEngine — Edge cases', () => {
  let engine: AttentionEngine;

  beforeEach(() => {
    engine = new AttentionEngine();
  });

  it('elevate rules take precedence over always-surface', () => {
    // A network ApprovalRequested is both always-surface AND elevate.
    // Elevate should win.
    const event = approvalEvent('network', 'low', { destination: 'registry.npmjs.org' });
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('sandbox violation takes precedence over batch', () => {
    const event: ToolFinishedEvent = {
      ...base,
      type: 'ToolFinished',
      toolName: 'shell',
      success: false,
      error: 'Sandbox violation: access denied to /etc',
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.RiskDetected);
  });

  it('sandbox violation takes precedence over liveness timeout', () => {
    const event: ToolFinishedEvent = {
      ...base,
      type: 'ToolFinished',
      toolName: 'shell',
      success: false,
      error: 'Sandbox violation detected',
    };
    const result = engine.classify(
      event,
      'A',
      { ...cleanContext, livenessTimedOut: true },
    );
    expect(result.category).toBe(Cat.RiskDetected);
    expect(result.reason).toContain('Sandbox violation');
  });

  it('liveness timeout surfaces even for non-meaningful events', () => {
    const event: AgentProgressEvent = {
      ...base,
      type: 'AgentProgress',
      message: 'Thinking...',
    };
    const result = engine.classify(event, 'A', { ...cleanContext, livenessTimedOut: true });
    expect(result.action).toBe('always-surface');
  });

  it('handles renamed files in sensitive paths', () => {
    const event = fileChangedEvent('secrets/old-key.pem', {
      changeType: 'renamed',
      oldPath: 'secrets/key.pem',
    });
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('handles deleted files in sensitive paths', () => {
    const event = fileChangedEvent('auth/session.ts', { changeType: 'deleted' });
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('handles created files in migration paths', () => {
    const event = fileChangedEvent('migrations/002_add_index.sql', {
      changeType: 'created',
    });
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('elevate');
  });

  it('ToolFinished with "permission denied" error is a sandbox violation', () => {
    const event: ToolFinishedEvent = {
      ...base,
      type: 'ToolFinished',
      toolName: 'shell',
      success: false,
      error: 'permission denied: cannot write to /root',
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.RiskDetected);
  });

  it('ToolFinished with "operation not permitted" error is a sandbox violation', () => {
    const event: ToolFinishedEvent = {
      ...base,
      type: 'ToolFinished',
      toolName: 'shell',
      success: false,
      error: 'operation not permitted',
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('always-surface');
    expect(result.category).toBe(Cat.RiskDetected);
  });

  it('ToolFinished with unrelated error is batched', () => {
    const event: ToolFinishedEvent = {
      ...base,
      type: 'ToolFinished',
      toolName: 'shell',
      success: false,
      error: 'Command not found',
    };
    const result = engine.classify(event, 'A', cleanContext);
    expect(result.action).toBe('batch');
  });

  it('classifies all 21 event types without throwing', () => {
    const events: SupervisorEvent[] = [
      { ...base, type: 'AgentStarted', objective: 'Test', workingDir: '/repo' },
      { ...base, type: 'AgentProgress', message: 'Working' },
      { ...base, type: 'ToolStarted', toolName: 'shell' },
      { ...base, type: 'ToolFinished', toolName: 'shell', success: true },
      { ...base, type: 'FileChanged', path: 'src/test.ts', changeType: 'modified' },
      { ...base, type: 'TestStarted', framework: 'vitest' },
      { ...base, type: 'TestFinished', passed: 1, failed: 0, skipped: 0 },
      {
        ...base,
        type: 'ApprovalRequested',
        task: 'T',
        agent: 'codex',
        capability: 'shell',
        destination: '/bin/ls',
        command: 'ls',
        workingDir: '/repo',
        scope: [{ type: 'shell', targets: ['/bin/ls'] }],
        riskLevel: 'low',
      },
      {
        ...base,
        type: 'HumanInputRequested',
        task: 'T',
        agent: 'codex',
        capability: 'shell',
        destination: '/bin/bash',
        command: 'rm',
        workingDir: '/repo',
        scope: [{ type: 'filesystem', targets: ['/repo'] }],
        riskLevel: 'low',
        prompt: 'Continue?',
      },
      { ...base, type: 'AgentBlocked', reason: 'Waiting', blockerType: 'dependency', retryable: true },
      { ...base, type: 'AgentCompleted', summary: 'Done', deliverables: [] },
      { ...base, type: 'AgentFailed', error: 'Crash', recoverable: true },
      { ...base, type: 'AgentStopped', reason: 'user' },
      { ...base, type: 'UsageReported', provider: 'codex', totalTokens: 100 },
      {
        ...base,
        type: 'QuotaObserved',
        provider: 'codex',
        window: 'five_hour',
        usedPct: 0.5,
        status: 'allowed',
        source: 'polled',
      },
      {
        ...base,
        type: 'TaskFailedOver',
        fromProvider: 'codex',
        toProvider: 'gemini',
        reason: 'quota_exhausted',
      },
      { ...base, type: 'TaskParked', reason: 'fleet dry' },
      { ...base, type: 'TaskResumed', provider: 'gemini' },
      {
        ...base,
        type: 'ContextCondensed',
        summary: 's',
        forgottenEventIds: ['e1'],
        keptEventCount: 2,
      },
      { ...base, type: 'ContextHealthChanged', status: 'ok' },
      { ...base, type: 'VerificationObserved', kind: 'test', success: true },
    ];

    for (const event of events) {
      expect(() => engine.classify(event, 'A', cleanContext)).not.toThrow();
    }
  });
});
