import { describe, it, expect } from 'vitest';

import {
  AttentionTuner,
  DEFAULT_TUNING_CONFIG,
  MIN_TUNING_BOUNDS,
  MAX_TUNING_BOUNDS,
  type AttentionTuningConfig,
} from '../src/attention/attention-tuning.js';
import { AdaptivePolicy } from '../src/attention/adaptive-policy.js';
import type { AttentionItem } from '../src/attention/attention-item.js';
import type { MetricsSnapshot } from '../src/daemon/metrics.js';
import type {
  AgentStartedEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  ApprovalRequestedEvent,
  AgentProgressEvent,
} from '../src/domain/events.js';

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

const base = {
  timestamp: '2026-08-19T12:00:00.000Z',
  taskId: 'task-42',
  sessionId: 'sess-7',
  agentId: 'codex',
  adapterFidelityTier: 'A' as const,
};

function ts(offsetMs: number): string {
  return new Date(Date.parse(base.timestamp) + offsetMs).toISOString();
}

function agentStarted(overrides: Partial<AgentStartedEvent> = {}): AgentStartedEvent {
  return {
    ...base,
    type: 'AgentStarted',
    objective: 'Test task',
    workingDir: '/repo',
    ...overrides,
  };
}

function agentCompleted(overrides: Partial<AgentCompletedEvent> = {}): AgentCompletedEvent {
  return {
    ...base,
    type: 'AgentCompleted',
    summary: 'Done',
    deliverables: [],
    ...overrides,
  };
}

function agentFailed(overrides: Partial<AgentFailedEvent> = {}): AgentFailedEvent {
  return {
    ...base,
    type: 'AgentFailed',
    error: 'Crashed',
    recoverable: true,
    ...overrides,
  };
}

function approvalRequested(
  overrides: Partial<ApprovalRequestedEvent> = {},
): ApprovalRequestedEvent {
  return {
    ...base,
    type: 'ApprovalRequested',
    task: 'Test task',
    agent: 'codex',
    capability: 'network',
    destination: 'example.com',
    command: 'npm install',
    workingDir: '/repo',
    scope: [{ type: 'network', targets: ['example.com'] }],
    riskLevel: 'low',
    ...overrides,
  };
}

function progressEvent(overrides: Partial<AgentProgressEvent> = {}): AgentProgressEvent {
  return {
    ...base,
    type: 'AgentProgress',
    message: 'Working...',
    ...overrides,
  };
}

function makeItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'attn-1',
    taskId: 'task-42',
    kind: 'ApprovalRequest',
    priority: 'High',
    createdAt: ts(0),
    payload: {},
    status: 'Pending',
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    timestamp: ts(0),
    counters: {
      eventsEmitted: {},
      tasksStarted: 10,
      tasksCompleted: 4,
      tasksFailed: 6,
      approvalsRequested: 5,
      approvalsGranted: 5,
      approvalsDenied: 0,
      toolsInvoked: {},
    },
    gauges: {
      activeSessions: 0,
      pendingApprovals: 0,
      inboxSize: 100,
      attentionItemsPending: 100,
    },
    histograms: {
      taskDuration: { count: 10, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
      approvalResponseTime: { count: 5, min: 0, max: 0, mean: 90_000, sum: 450_000, buckets: {} },
      toolDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * AttentionTuner
 * ------------------------------------------------------------------ */

describe('AttentionTuner', () => {
  describe('default config', () => {
    it('exposes the documented default values', () => {
      const tuner = new AttentionTuner();
      const cfg = tuner.getConfig();
      expect(cfg).toEqual(DEFAULT_TUNING_CONFIG);
      expect(cfg.livenessTimeoutMs).toBe(120_000);
      expect(cfg.failureThreshold).toBe(3);
      expect(cfg.escalationDelayMs).toBe(300_000);
      expect(cfg.staleTaskThresholdMs).toBe(1_800_000);
      expect(cfg.maxInboxSize).toBe(100);
      expect(cfg.priorityBoostOnRepeat).toBe(true);
      expect(cfg.autoResolveCompletedAfterMs).toBe(600_000);
    });

    it('returns a defensive copy', () => {
      const tuner = new AttentionTuner();
      const cfg = tuner.getConfig();
      (cfg as Partial<AttentionTuningConfig>).failureThreshold = 99;
      expect(tuner.getConfig().failureThreshold).toBe(3);
    });
  });

  describe('updateConfig / resetToDefaults', () => {
    it('merges a partial config', () => {
      const tuner = new AttentionTuner();
      tuner.updateConfig({ failureThreshold: 5, maxInboxSize: 50 });
      const cfg = tuner.getConfig();
      expect(cfg.failureThreshold).toBe(5);
      expect(cfg.maxInboxSize).toBe(50);
      // Untouched fields remain at defaults.
      expect(cfg.livenessTimeoutMs).toBe(DEFAULT_TUNING_CONFIG.livenessTimeoutMs);
    });

    it('clamps numeric fields to minimum bounds', () => {
      const tuner = new AttentionTuner();
      tuner.updateConfig({
        failureThreshold: 0,
        livenessTimeoutMs: -100,
        maxInboxSize: 0,
      });
      const cfg = tuner.getConfig();
      expect(cfg.failureThreshold).toBe(MIN_TUNING_BOUNDS.failureThreshold);
      expect(cfg.livenessTimeoutMs).toBe(MIN_TUNING_BOUNDS.livenessTimeoutMs);
      expect(cfg.maxInboxSize).toBe(MIN_TUNING_BOUNDS.maxInboxSize);
    });

    it('clamps numeric fields to maximum bounds', () => {
      const tuner = new AttentionTuner();
      tuner.updateConfig({
        failureThreshold: 999,
        escalationDelayMs: Number.MAX_SAFE_INTEGER,
      });
      const cfg = tuner.getConfig();
      expect(cfg.failureThreshold).toBe(MAX_TUNING_BOUNDS.failureThreshold);
      expect(cfg.escalationDelayMs).toBe(MAX_TUNING_BOUNDS.escalationDelayMs);
    });

    it('resets to defaults', () => {
      const tuner = new AttentionTuner();
      tuner.updateConfig({ failureThreshold: 9, maxInboxSize: 9 });
      tuner.resetToDefaults();
      expect(tuner.getConfig()).toEqual(DEFAULT_TUNING_CONFIG);
    });
  });

  describe('shouldEscalate', () => {
    it('escalates an active item older than escalationDelayMs', () => {
      const tuner = new AttentionTuner();
      const now = Date.parse(base.timestamp);
      const item = makeItem({ createdAt: ts(0) });
      // Exactly at the threshold.
      expect(tuner.shouldEscalate(item, now + 300_000)).toBe(true);
      // Just before the threshold.
      expect(tuner.shouldEscalate(item, now + 299_999)).toBe(false);
    });

    it('respects a custom escalationDelayMs', () => {
      const tuner = new AttentionTuner({
        ...DEFAULT_TUNING_CONFIG,
        escalationDelayMs: 60_000,
      });
      const now = Date.parse(base.timestamp);
      const item = makeItem({ createdAt: ts(0) });
      expect(tuner.shouldEscalate(item, now + 60_000)).toBe(true);
      expect(tuner.shouldEscalate(item, now + 59_999)).toBe(false);
    });

    it('does not escalate already-escalated or resolved items', () => {
      const tuner = new AttentionTuner();
      const now = Date.parse(base.timestamp);
      const escalated = makeItem({ status: 'Escalated', createdAt: ts(0) });
      const resolved = makeItem({ status: 'Resolved', createdAt: ts(0) });
      expect(tuner.shouldEscalate(escalated, now + 1_000_000)).toBe(false);
      expect(tuner.shouldEscalate(resolved, now + 1_000_000)).toBe(false);
    });

    it('escalates acknowledged items that are overdue', () => {
      const tuner = new AttentionTuner();
      const now = Date.parse(base.timestamp);
      const ack = makeItem({ status: 'Acknowledged', createdAt: ts(0) });
      expect(tuner.shouldEscalate(ack, now + 300_000)).toBe(true);
    });
  });

  describe('shouldAutoResolve', () => {
    it('auto-resolves an acknowledged item older than autoResolveCompletedAfterMs', () => {
      const tuner = new AttentionTuner();
      const now = Date.parse(base.timestamp);
      const item = makeItem({ status: 'Acknowledged', createdAt: ts(0) });
      expect(tuner.shouldAutoResolve(item, now + 600_000)).toBe(true);
      expect(tuner.shouldAutoResolve(item, now + 599_999)).toBe(false);
    });

    it('does not auto-resolve pending items', () => {
      const tuner = new AttentionTuner();
      const now = Date.parse(base.timestamp);
      const pending = makeItem({ status: 'Pending', createdAt: ts(0) });
      expect(tuner.shouldAutoResolve(pending, now + 10_000_000)).toBe(false);
    });

    it('respects a custom autoResolveCompletedAfterMs', () => {
      const tuner = new AttentionTuner({
        ...DEFAULT_TUNING_CONFIG,
        autoResolveCompletedAfterMs: 120_000,
      });
      const now = Date.parse(base.timestamp);
      const item = makeItem({ status: 'Acknowledged', createdAt: ts(0) });
      expect(tuner.shouldAutoResolve(item, now + 120_000)).toBe(true);
    });
  });

  describe('isStale', () => {
    it('marks a task stale after staleTaskThresholdMs', () => {
      const tuner = new AttentionTuner();
      const lastActivity = 0;
      expect(tuner.isStale(lastActivity, 1_800_000)).toBe(true);
      expect(tuner.isStale(lastActivity, 1_799_999)).toBe(false);
    });

    it('respects a custom staleTaskThresholdMs', () => {
      const tuner = new AttentionTuner({
        ...DEFAULT_TUNING_CONFIG,
        staleTaskThresholdMs: 60_000,
      });
      expect(tuner.isStale(0, 60_000)).toBe(true);
      expect(tuner.isStale(0, 59_999)).toBe(false);
    });
  });

  describe('tuneFromMetrics', () => {
    it('suggests lowering failureThreshold on high failure rate', () => {
      const tuner = new AttentionTuner();
      const suggestion = tuner.tuneFromMetrics(makeMetrics());
      expect(suggestion.failureThreshold).toBe(2);
    });

    it('does not suggest a failureThreshold change when rate is low', () => {
      const tuner = new AttentionTuner();
      const metrics = makeMetrics({
        counters: {
          eventsEmitted: {},
          tasksStarted: 10,
          tasksCompleted: 9,
          tasksFailed: 1,
          approvalsRequested: 0,
          approvalsGranted: 0,
          approvalsDenied: 0,
          toolsInvoked: {},
        },
      });
      const suggestion = tuner.tuneFromMetrics(metrics);
      expect(suggestion.failureThreshold).toBeUndefined();
    });

    it('suggests increasing escalationDelayMs on slow approvals', () => {
      const tuner = new AttentionTuner();
      const suggestion = tuner.tuneFromMetrics(makeMetrics());
      expect(suggestion.escalationDelayMs).toBe(360_000);
    });

    it('suggests lowering maxInboxSize and auto-resolve window on inbox pressure', () => {
      const tuner = new AttentionTuner();
      const suggestion = tuner.tuneFromMetrics(makeMetrics());
      expect(suggestion.maxInboxSize).toBe(90);
      expect(suggestion.autoResolveCompletedAfterMs).toBe(540_000);
    });

    it('clamps suggestions to minimum bounds', () => {
      const tuner = new AttentionTuner({
        ...DEFAULT_TUNING_CONFIG,
        failureThreshold: 1,
        maxInboxSize: 5,
        autoResolveCompletedAfterMs: 30_000,
      });
      const suggestion = tuner.tuneFromMetrics(makeMetrics());
      // failureThreshold already at min -> no change suggested.
      expect(suggestion.failureThreshold).toBeUndefined();
      // maxInboxSize would go below min -> clamped to min (1), which differs
      // from current 5, so it is suggested but bounded.
      expect(suggestion.maxInboxSize).toBe(MIN_TUNING_BOUNDS.maxInboxSize);
      // auto-resolve window would go below min -> clamped.
      expect(suggestion.autoResolveCompletedAfterMs).toBe(
        MIN_TUNING_BOUNDS.autoResolveCompletedAfterMs,
      );
    });

    it('returns an empty suggestion when nothing needs tuning', () => {
      const tuner = new AttentionTuner();
      const metrics = makeMetrics({
        counters: {
          eventsEmitted: {},
          tasksStarted: 10,
          tasksCompleted: 10,
          tasksFailed: 0,
          approvalsRequested: 0,
          approvalsGranted: 0,
          approvalsDenied: 0,
          toolsInvoked: {},
        },
        gauges: {
          activeSessions: 0,
          pendingApprovals: 0,
          inboxSize: 10,
          attentionItemsPending: 10,
        },
        histograms: {
          taskDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
          approvalResponseTime: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
          toolDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
        },
      });
      const suggestion = tuner.tuneFromMetrics(metrics);
      expect(Object.keys(suggestion).length).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------ *
 * AdaptivePolicy
 * ------------------------------------------------------------------ */

describe('AdaptivePolicy', () => {
  describe('getAdjustedConfig', () => {
    it('returns the initial config by default', () => {
      const policy = new AdaptivePolicy();
      expect(policy.getAdjustedConfig()).toEqual(DEFAULT_TUNING_CONFIG);
    });

    it('accepts a custom initial config', () => {
      const custom: AttentionTuningConfig = {
        ...DEFAULT_TUNING_CONFIG,
        failureThreshold: 5,
      };
      const policy = new AdaptivePolicy({ config: custom });
      expect(policy.getAdjustedConfig().failureThreshold).toBe(5);
    });
  });

  describe('trackEvent', () => {
    it('forwards events to the wrapped engine without error', () => {
      const policy = new AdaptivePolicy();
      expect(() => policy.trackEvent(agentStarted())).not.toThrow();
      expect(() => policy.trackEvent(agentCompleted())).not.toThrow();
    });

    it('lowers failureThreshold when failure rate exceeds 50%', () => {
      const policy = new AdaptivePolicy({ windowSize: 10 });
      // 6 failures, 2 completions -> 75% failure rate.
      for (let i = 0; i < 6; i++) policy.trackEvent(agentFailed());
      for (let i = 0; i < 2; i++) policy.trackEvent(agentCompleted());
      expect(policy.getAdjustedConfig().failureThreshold).toBe(2);
    });

    it('does not lower failureThreshold when rate is below threshold', () => {
      const policy = new AdaptivePolicy({ windowSize: 20 });
      for (let i = 0; i < 2; i++) policy.trackEvent(agentFailed());
      for (let i = 0; i < 8; i++) policy.trackEvent(agentCompleted());
      expect(policy.getAdjustedConfig().failureThreshold).toBe(3);
    });

    it('increases escalationDelayMs when average approval time exceeds 60s', () => {
      const policy = new AdaptivePolicy();
      // Approval requested, then a follow-up event 90s later -> 90s response.
      policy.trackEvent(approvalRequested({ timestamp: ts(0) }));
      policy.trackEvent(progressEvent({ timestamp: ts(90_000) }));
      policy.trackEvent(approvalRequested({ timestamp: ts(0), taskId: 'task-2' }));
      policy.trackEvent(progressEvent({ timestamp: ts(90_000), taskId: 'task-2' }));
      policy.trackEvent(approvalRequested({ timestamp: ts(0), taskId: 'task-3' }));
      policy.trackEvent(progressEvent({ timestamp: ts(90_000), taskId: 'task-3' }));
      expect(policy.getAdjustedConfig().escalationDelayMs).toBe(360_000);
    });

    it('does not increase escalationDelayMs for fast approvals', () => {
      const policy = new AdaptivePolicy();
      policy.trackEvent(approvalRequested({ timestamp: ts(0) }));
      policy.trackEvent(progressEvent({ timestamp: ts(5_000) }));
      policy.trackEvent(approvalRequested({ timestamp: ts(0), taskId: 'task-2' }));
      policy.trackEvent(progressEvent({ timestamp: ts(5_000), taskId: 'task-2' }));
      policy.trackEvent(approvalRequested({ timestamp: ts(0), taskId: 'task-3' }));
      policy.trackEvent(progressEvent({ timestamp: ts(5_000), taskId: 'task-3' }));
      expect(policy.getAdjustedConfig().escalationDelayMs).toBe(300_000);
    });
  });

  describe('observeInboxSize', () => {
    it('decreases maxInboxSize when inbox is frequently at max', () => {
      const policy = new AdaptivePolicy({ inboxSampleSize: 4, inboxPressureFraction: 0.5 });
      // 3 of 4 samples at/over max (100).
      policy.observeInboxSize(100);
      policy.observeInboxSize(100);
      policy.observeInboxSize(100);
      policy.observeInboxSize(50);
      expect(policy.getAdjustedConfig().maxInboxSize).toBe(90);
    });

    it('also shortens autoResolveCompletedAfterMs on inbox pressure', () => {
      const policy = new AdaptivePolicy({ inboxSampleSize: 4, inboxPressureFraction: 0.5 });
      policy.observeInboxSize(100);
      policy.observeInboxSize(100);
      policy.observeInboxSize(100);
      policy.observeInboxSize(100);
      expect(policy.getAdjustedConfig().autoResolveCompletedAfterMs).toBe(540_000);
    });

    it('does not adjust when inbox is not frequently at max', () => {
      const policy = new AdaptivePolicy({ inboxSampleSize: 4, inboxPressureFraction: 0.5 });
      policy.observeInboxSize(10);
      policy.observeInboxSize(20);
      policy.observeInboxSize(30);
      policy.observeInboxSize(40);
      expect(policy.getAdjustedConfig().maxInboxSize).toBe(100);
    });
  });

  describe('bounded adjustments', () => {
    it('never lowers failureThreshold below the minimum', () => {
      const policy = new AdaptivePolicy({
        config: { ...DEFAULT_TUNING_CONFIG, failureThreshold: 1 },
        windowSize: 10,
      });
      for (let i = 0; i < 10; i++) policy.trackEvent(agentFailed());
      expect(policy.getAdjustedConfig().failureThreshold).toBe(MIN_TUNING_BOUNDS.failureThreshold);
    });

    it('never raises escalationDelayMs above the maximum', () => {
      const policy = new AdaptivePolicy({
        config: {
          ...DEFAULT_TUNING_CONFIG,
          escalationDelayMs: MAX_TUNING_BOUNDS.escalationDelayMs,
        },
      });
      // Many slow approvals to keep triggering the rule.
      for (let i = 0; i < 10; i++) {
        policy.trackEvent(approvalRequested({ timestamp: ts(0), taskId: `t-${i}` }));
        policy.trackEvent(progressEvent({ timestamp: ts(120_000), taskId: `t-${i}` }));
      }
      expect(policy.getAdjustedConfig().escalationDelayMs).toBe(
        MAX_TUNING_BOUNDS.escalationDelayMs,
      );
    });

    it('never lowers maxInboxSize below the minimum', () => {
      const policy = new AdaptivePolicy({
        config: { ...DEFAULT_TUNING_CONFIG, maxInboxSize: MIN_TUNING_BOUNDS.maxInboxSize },
        inboxSampleSize: 2,
        inboxPressureFraction: 0.5,
      });
      policy.observeInboxSize(1);
      policy.observeInboxSize(1);
      expect(policy.getAdjustedConfig().maxInboxSize).toBe(MIN_TUNING_BOUNDS.maxInboxSize);
    });
  });

  describe('onConfigChange', () => {
    it('fires the callback when an adjustment is applied', () => {
      const policy = new AdaptivePolicy({ windowSize: 10 });
      const seen: AttentionTuningConfig[] = [];
      policy.onConfigChange((cfg) => seen.push(cfg));

      for (let i = 0; i < 6; i++) policy.trackEvent(agentFailed());
      for (let i = 0; i < 2; i++) policy.trackEvent(agentCompleted());

      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[seen.length - 1].failureThreshold).toBe(2);
    });

    it('does not fire when no adjustment is applied', () => {
      const policy = new AdaptivePolicy();
      const seen: AttentionTuningConfig[] = [];
      policy.onConfigChange((cfg) => seen.push(cfg));

      // Routine events that do not trigger any rule.
      policy.trackEvent(agentStarted());
      policy.trackEvent(progressEvent());

      expect(seen.length).toBe(0);
    });

    it('returns an unsubscribe function', () => {
      const policy = new AdaptivePolicy({ windowSize: 10 });
      const seen: AttentionTuningConfig[] = [];
      const unsub = policy.onConfigChange((cfg) => seen.push(cfg));

      // Trigger one adjustment.
      for (let i = 0; i < 6; i++) policy.trackEvent(agentFailed());
      for (let i = 0; i < 2; i++) policy.trackEvent(agentCompleted());
      const countAfterFirst = seen.length;
      expect(countAfterFirst).toBeGreaterThanOrEqual(1);

      unsub();

      // Reset and trigger again; no further notifications.
      policy.tunerInstance.resetToDefaults();
      for (let i = 0; i < 6; i++) policy.trackEvent(agentFailed());
      for (let i = 0; i < 2; i++) policy.trackEvent(agentCompleted());
      expect(seen.length).toBe(countAfterFirst);
    });
  });
});
