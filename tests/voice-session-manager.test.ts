import { describe, it, expect } from 'vitest';

import { mapToolCallToCommand, buildDefaultVoiceTools } from '../src/daemon/voice-session-manager.js';
import { StdinAudioTransport } from '../src/voice/stdin-audio-transport.js';

describe('VoiceSessionManager: tool call mapping', () => {
  it('maps get_inbox to query-inbox command', () => {
    const cmd = mapToolCallToCommand('get_inbox', {});
    expect(cmd).not.toBeNull();
    expect(cmd?.kind).toBe('query-inbox');
  });

  it('maps get_inbox with priority filter', () => {
    const cmd = mapToolCallToCommand('get_inbox', { priority: 'Critical' });
    expect(cmd).not.toBeNull();
    expect(cmd?.kind).toBe('query-inbox');
    if (cmd?.kind === 'query-inbox') {
      expect(cmd.filter?.priority).toBe('Critical');
    }
  });

  it('maps list_tasks to list-tasks command', () => {
    const cmd = mapToolCallToCommand('list_tasks', {});
    expect(cmd).not.toBeNull();
    expect(cmd?.kind).toBe('list-tasks');
  });

  it('maps query_task to query-task command', () => {
    const cmd = mapToolCallToCommand('query_task', { taskId: 'task-1' });
    expect(cmd).not.toBeNull();
    expect(cmd?.kind).toBe('query-task');
    if (cmd?.kind === 'query-task') {
      expect(cmd.taskId).toBe('task-1');
    }
  });

  it('returns null for query_task without taskId', () => {
    const cmd = mapToolCallToCommand('query_task', {});
    expect(cmd).toBeNull();
  });

  it('maps get_metrics to query-metrics command', () => {
    const cmd = mapToolCallToCommand('get_metrics', { since: 3600000 });
    expect(cmd).not.toBeNull();
    expect(cmd?.kind).toBe('query-metrics');
    if (cmd?.kind === 'query-metrics') {
      expect(cmd.since).toBe(3600000);
    }
  });

  it('maps approve_permission to approve command with grant', () => {
    const cmd = mapToolCallToCommand('approve_permission', {
      taskId: 'task-1',
      approvalId: 'appr-1',
    });
    expect(cmd).not.toBeNull();
    expect(cmd?.kind).toBe('approve');
    if (cmd?.kind === 'approve') {
      expect(cmd.decision).toBe('grant');
      expect(cmd.taskId).toBe('task-1');
      expect(cmd.approvalId).toBe('appr-1');
    }
  });

  it('maps deny_permission to approve command with deny', () => {
    const cmd = mapToolCallToCommand('deny_permission', {
      taskId: 'task-1',
      approvalId: 'appr-1',
      note: 'too risky',
    });
    expect(cmd).not.toBeNull();
    expect(cmd?.kind).toBe('approve');
    if (cmd?.kind === 'approve') {
      expect(cmd.decision).toBe('deny');
      expect(cmd.note).toBe('too risky');
    }
  });

  it('returns null for approve_permission without required fields', () => {
    expect(mapToolCallToCommand('approve_permission', { taskId: 'task-1' })).toBeNull();
    expect(mapToolCallToCommand('approve_permission', { approvalId: 'appr-1' })).toBeNull();
  });

  it('maps get_digest to get-digest command', () => {
    const cmd = mapToolCallToCommand('get_digest', { taskId: 'task-1' });
    expect(cmd).not.toBeNull();
    expect(cmd?.kind).toBe('get-digest');
    if (cmd?.kind === 'get-digest') {
      expect(cmd.taskId).toBe('task-1');
    }
  });

  it('returns null for unknown tool names', () => {
    expect(mapToolCallToCommand('run_shell', { command: 'rm -rf /' })).toBeNull();
    expect(mapToolCallToCommand('delete_everything', {})).toBeNull();
    expect(mapToolCallToCommand('', {})).toBeNull();
  });
});

describe('VoiceSessionManager: default voice tools', () => {
  const tools = buildDefaultVoiceTools();

  it('includes the core Florina tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_inbox');
    expect(names).toContain('list_tasks');
    expect(names).toContain('query_task');
    expect(names).toContain('get_metrics');
    expect(names).toContain('approve_permission');
    expect(names).toContain('deny_permission');
    expect(names).toContain('get_digest');
  });

  it('does not include arbitrary shell execution tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('run_shell');
    expect(names).not.toContain('execute_command');
    expect(names).not.toContain('bash');
  });

  it('all tools are function type', () => {
    for (const tool of tools) {
      expect(tool.type).toBe('function');
    }
  });
});

describe('StdinAudioTransport', () => {
  it('implements the AudioTransport interface', () => {
    const transport = new StdinAudioTransport();
    expect(typeof transport.startCapture).toBe('function');
    expect(typeof transport.stopCapture).toBe('function');
    expect(typeof transport.play).toBe('function');
    expect(typeof transport.stopPlayback).toBe('function');
    expect(typeof transport.close).toBe('function');
    transport.close();
  });

  it('stopCapture is a no-op when not capturing', () => {
    const transport = new StdinAudioTransport();
    expect(() => transport.stopCapture()).not.toThrow();
    transport.close();
  });

  it('play writes to stdout without throwing', () => {
    const transport = new StdinAudioTransport();
    expect(() =>
      transport.play({ pcm: 'dGVzdA==', sampleRate: 24000, channels: 1 }),
    ).not.toThrow();
    transport.close();
  });
});
