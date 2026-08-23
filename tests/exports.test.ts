import { describe, it, expect } from 'vitest';

import * as api from '../src/index.js';

/* ================================================================== *
 * Public API exports (issue #36)
 * ================================================================== */

describe('public API exports', () => {
  it('exports VERSION', () => {
    expect(api.VERSION).toBe('0.0.1');
  });

  it('exports the SecretaryDaemon from the daemon module', () => {
    expect(typeof api.SecretaryDaemon).toBe('function');
  });

  it('exports CommandApi from the daemon module', () => {
    expect(typeof api.CommandApi).toBe('function');
  });

  it('exports EventBus from the daemon module', () => {
    expect(typeof api.EventBus).toBe('function');
  });

  it('exports SessionManager from the daemon module', () => {
    expect(typeof api.SessionManager).toBe('function');
  });

  it('exports AdapterRegistry from the adapters module', () => {
    expect(typeof api.AdapterRegistry).toBe('function');
  });

  it('exports CodexAdapter from the adapters module', () => {
    expect(typeof api.CodexAdapter).toBe('function');
  });

  it('exports ClaudeHooksAdapter from the adapters module', () => {
    expect(typeof api.ClaudeHooksAdapter).toBe('function');
  });

  it('exports ClaudePtyAdapter from the adapters module', () => {
    expect(typeof api.ClaudePtyAdapter).toBe('function');
  });

  it('exports StubAdapter from the adapters module', () => {
    expect(typeof api.StubAdapter).toBe('function');
  });

  it('exports AttentionEngine from the attention module', () => {
    expect(typeof api.AttentionEngine).toBe('function');
  });

  it('exports AttentionInbox from the attention module', () => {
    expect(typeof api.AttentionInbox).toBe('function');
  });

  it('exports AttentionTuner from the attention module', () => {
    expect(typeof api.AttentionTuner).toBe('function');
  });

  it('exports AdaptivePolicy from the attention module', () => {
    expect(typeof api.AdaptivePolicy).toBe('function');
  });

  it('exports MetricsQueryService for ACR + supplemental metrics (DEC-015)', () => {
    expect(typeof api.MetricsQueryService).toBe('function');
    expect(typeof api.MetricsRecorder).toBe('function');
    expect(typeof api.computeAttentionMetrics).toBe('function');
  });

  it('exports StorageDatabase from the storage module', () => {
    expect(typeof api.StorageDatabase).toBe('function');
  });

  it('exports CompletionDigestRepository from the storage module', () => {
    expect(typeof api.CompletionDigestRepository).toBe('function');
  });

  it('exports SecurityAuditor from the security module', () => {
    expect(typeof api.SecurityAuditor).toBe('function');
  });

  it('exports domain enums (TaskState)', () => {
    expect(api.TaskState).toBeDefined();
  });

  it('exports domain factory (buildTask)', () => {
    expect(typeof api.buildTask).toBe('function');
  });

  it('does not export voice or desktop modules', () => {
    expect(api).not.toHaveProperty('VoicePipeline');
    expect(api).not.toHaveProperty('DesktopApp');
  });
});
