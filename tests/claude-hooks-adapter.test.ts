import { describe, it, expect } from 'vitest';

import { AdapterFidelityTier } from '../src/domain/enums.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import { validateEvent } from '../src/domain/events.js';
import { CapabilityType, CapabilityRiskLevel } from '../src/domain/capabilities.js';

import {
  ClaudeHooksAdapter,
  CLAUDE_HOOKS_ADAPTER_ID,
  InMemoryHookEventSink,
  type ClaudeCliProcess,
  type ClaudeCliSpawner,
  type ClaudeCliSpawnOptions,
  type SessionConfig,
} from '../src/adapters/index.js';
import {
  mapHookEvent,
  isHookEvent,
  mapSessionStart,
  mapPreToolUse,
  mapPostToolUse,
  mapPostToolUseFailure,
  mapPermissionRequest,
  mapNotification,
  mapStop,
  mapStopFailure,
  inferCapabilityFromTool,
  inferDestinationFromTool,
  inferRiskLevel,
  buildHooksConfig,
  CLAUDE_HOOK_EVENT_NAMES,
  type ClaudeHookEvent,
  type ClaudeHooksMapperContext,
  type SessionStartHookEvent,
  type PreToolUseHookEvent,
  type PostToolUseHookEvent,
  type PostToolUseFailureHookEvent,
  type PermissionRequestHookEvent,
  type NotificationHookEvent,
  type StopHookEvent,
  type StopFailureHookEvent,
} from '../src/adapters/claude-hooks-mapper.js';

/* ------------------------------------------------------------------ *
 * Mock CLI process
 * ------------------------------------------------------------------ */

/**
 * An in-memory mock CLI process that simulates the Claude CLI without
 * spawning a real subprocess. Tests drive it via `emitExit`.
 */
class MockCliProcess implements ClaudeCliProcess {
  readonly pid: number;
  private exitHandler: ((exitCode: number | null, signal?: NodeJS.Signals | null) => void) | null =
    null;
  private killed = false;
  readonly killSignals: string[] = [];

  constructor(pid = 99999) {
    this.pid = pid;
  }

  kill(signal?: string): void {
    this.killed = true;
    if (signal) {
      this.killSignals.push(signal);
    }
  }

  onExit(handler: (exitCode: number | null, signal?: NodeJS.Signals | null) => void): void {
    this.exitHandler = handler;
  }

  /** Whether `kill` was called. */
  get wasKilled(): boolean {
    return this.killed;
  }

  /** Simulate the CLI process exiting. */
  emitExit(exitCode: number | null, signal?: NodeJS.Signals | null): void {
    if (this.exitHandler) {
      this.exitHandler(exitCode, signal);
    }
  }
}

/**
 * A mock CLI spawner that returns a controllable {@link MockCliProcess}.
 */
class MockCliSpawner implements ClaudeCliSpawner {
  lastProcess: MockCliProcess | null = null;
  readonly spawnCalls: ClaudeCliSpawnOptions[] = [];

  spawn(options: ClaudeCliSpawnOptions): ClaudeCliProcess {
    this.spawnCalls.push(options);
    const proc = new MockCliProcess();
    this.lastProcess = proc;
    return proc;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A minimal valid SessionConfig for Claude hooks runs. */
function sampleSessionConfig(): SessionConfig {
  return {
    taskId: 'task-claude-hooks-1',
    sessionId: 'sess-claude-hooks-1',
    agentId: 'claude-code',
    workingDir: '/repo/claude-hooks',
    objective: 'Refactor the auth module',
    model: 'claude-sonnet-4',
  };
}

/** Build a ClaudeHooksMapperContext matching the sample session config. */
function sampleMapperCtx(): ClaudeHooksMapperContext {
  return {
    taskId: 'task-claude-hooks-1',
    sessionId: 'sess-claude-hooks-1',
    agentId: 'claude-code',
    adapterFidelityTier: AdapterFidelityTier.B,
    objective: 'Refactor the auth module',
    workingDir: '/repo/claude-hooks',
  };
}

/** Collect all events from an async iterable into an array. */
async function collectEvents(iter: AsyncIterable<SupervisorEvent>): Promise<SupervisorEvent[]> {
  const events: SupervisorEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

/** Common base fields for hook events. */
function hookBase(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-claude-hooks-1',
    cwd: '/repo/claude-hooks',
    permission_mode: 'default',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 1. Mapper unit tests
 * ------------------------------------------------------------------ */
describe('Claude Code hooks mapper', () => {
  const ctx = sampleMapperCtx();

  describe('inferCapabilityFromTool', () => {
    it('maps Bash to Shell', () => {
      expect(inferCapabilityFromTool('Bash')).toBe(CapabilityType.Shell);
    });

    it('maps PowerShell to Shell', () => {
      expect(inferCapabilityFromTool('PowerShell')).toBe(CapabilityType.Shell);
    });

    it('maps Write to Filesystem', () => {
      expect(inferCapabilityFromTool('Write')).toBe(CapabilityType.Filesystem);
    });

    it('maps Edit to Filesystem', () => {
      expect(inferCapabilityFromTool('Edit')).toBe(CapabilityType.Filesystem);
    });

    it('maps Read to Filesystem', () => {
      expect(inferCapabilityFromTool('Read')).toBe(CapabilityType.Filesystem);
    });

    it('maps WebFetch to Network', () => {
      expect(inferCapabilityFromTool('WebFetch')).toBe(CapabilityType.Network);
    });

    it('maps WebSearch to Network', () => {
      expect(inferCapabilityFromTool('WebSearch')).toBe(CapabilityType.Network);
    });

    it('maps unknown tools to Other (DEC-011)', () => {
      expect(inferCapabilityFromTool('UnknownTool')).toBe(CapabilityType.Other);
    });

    it('maps MCP tools to Other', () => {
      expect(inferCapabilityFromTool('mcp__memory__create')).toBe(CapabilityType.Other);
    });
  });

  describe('inferDestinationFromTool', () => {
    it('extracts file_path from file tools', () => {
      expect(inferDestinationFromTool('Write', { file_path: '/src/index.ts' })).toBe(
        '/src/index.ts',
      );
    });

    it('extracts command from Bash', () => {
      expect(inferDestinationFromTool('Bash', { command: 'npm test' })).toBe('npm test');
    });

    it('extracts url from WebFetch', () => {
      expect(inferDestinationFromTool('WebFetch', { url: 'https://api.github.com' })).toBe(
        'https://api.github.com',
      );
    });

    it('extracts query from WebSearch', () => {
      expect(inferDestinationFromTool('WebSearch', { query: 'react hooks' })).toBe('react hooks');
    });

    it('defaults to unknown when no recognizable field', () => {
      expect(inferDestinationFromTool('Bash', {})).toBe('unknown');
    });

    it('defaults to unknown when toolInput is absent', () => {
      expect(inferDestinationFromTool('Bash')).toBe('unknown');
    });
  });

  describe('inferRiskLevel', () => {
    it('rates Read as low', () => {
      expect(inferRiskLevel(CapabilityType.Filesystem, 'Read')).toBe(CapabilityRiskLevel.Low);
    });

    it('rates Write as medium', () => {
      expect(inferRiskLevel(CapabilityType.Filesystem, 'Write')).toBe(CapabilityRiskLevel.Medium);
    });

    it('rates Edit as medium', () => {
      expect(inferRiskLevel(CapabilityType.Filesystem, 'Edit')).toBe(CapabilityRiskLevel.Medium);
    });

    it('rates Network as high', () => {
      expect(inferRiskLevel(CapabilityType.Network, 'WebFetch')).toBe(CapabilityRiskLevel.High);
    });

    it('rates Shell as high by default', () => {
      expect(inferRiskLevel(CapabilityType.Shell, 'Bash', { command: 'npm test' })).toBe(
        CapabilityRiskLevel.High,
      );
    });

    it('rates destructive shell commands as critical', () => {
      expect(inferRiskLevel(CapabilityType.Shell, 'Bash', { command: 'rm -rf /tmp' })).toBe(
        CapabilityRiskLevel.Critical,
      );
    });

    it('rates git push as critical', () => {
      expect(
        inferRiskLevel(CapabilityType.Shell, 'Bash', { command: 'git push origin main' }),
      ).toBe(CapabilityRiskLevel.Critical);
    });

    it('rates Other as critical (DEC-011)', () => {
      expect(inferRiskLevel(CapabilityType.Other, 'UnknownTool')).toBe(
        CapabilityRiskLevel.Critical,
      );
    });
  });

  describe('mapSessionStart', () => {
    it('maps to AgentStarted', () => {
      const event: SessionStartHookEvent = {
        ...hookBase({ source: 'startup', model: 'claude-sonnet-4' }),
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'claude-sonnet-4',
      } as SessionStartHookEvent;
      const mapped = mapSessionStart(event, ctx);
      expect(mapped.type).toBe('AgentStarted');
      if (mapped.type === 'AgentStarted') {
        expect(mapped.objective).toBe('Refactor the auth module');
        expect(mapped.workingDir).toBe('/repo/claude-hooks');
        expect(mapped.model).toBe('claude-sonnet-4');
        expect(mapped.adapterFidelityTier).toBe('B');
      }
    });
  });

  describe('mapPreToolUse', () => {
    it('maps a Bash tool call to ToolStarted', () => {
      const event: PreToolUseHookEvent = {
        ...hookBase({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: 'toolu_01',
      } as PreToolUseHookEvent;
      const events = mapPreToolUse(event, ctx);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ToolStarted');
      if (events[0].type === 'ToolStarted') {
        expect(events[0].toolName).toBe('Bash');
        expect(events[0].args).toEqual({ command: 'npm test' });
      }
    });

    it('maps a Write tool call to ToolStarted + FileChanged', () => {
      const event: PreToolUseHookEvent = {
        ...hookBase({
          tool_name: 'Write',
          tool_input: { file_path: '/src/new.ts', content: '...' },
        }),
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/src/new.ts', content: '...' },
      } as PreToolUseHookEvent;
      const events = mapPreToolUse(event, ctx);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('ToolStarted');
      expect(events[1].type).toBe('FileChanged');
      if (events[1].type === 'FileChanged') {
        expect(events[1].path).toBe('/src/new.ts');
        expect(events[1].changeType).toBe('created');
      }
    });

    it('maps an Edit tool call to ToolStarted + FileChanged (modified)', () => {
      const event: PreToolUseHookEvent = {
        ...hookBase({ tool_name: 'Edit', tool_input: { file_path: '/src/auth.ts' } }),
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/src/auth.ts' },
      } as PreToolUseHookEvent;
      const events = mapPreToolUse(event, ctx);
      expect(events).toHaveLength(2);
      if (events[1].type === 'FileChanged') {
        expect(events[1].changeType).toBe('modified');
      }
    });
  });

  describe('mapPostToolUse', () => {
    it('maps to ToolFinished with success', () => {
      const event: PostToolUseHookEvent = {
        ...hookBase({
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: { stdout: 'all passing' },
          duration_ms: 1200,
        }),
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: 'all passing' },
        duration_ms: 1200,
      } as PostToolUseHookEvent;
      const mapped = mapPostToolUse(event, ctx);
      expect(mapped.type).toBe('ToolFinished');
      if (mapped.type === 'ToolFinished') {
        expect(mapped.toolName).toBe('Bash');
        expect(mapped.success).toBe(true);
        expect(mapped.durationMs).toBe(1200);
      }
    });
  });

  describe('mapPostToolUseFailure', () => {
    it('maps to ToolFinished with success false', () => {
      const event: PostToolUseFailureHookEvent = {
        ...hookBase({
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: { error: 'test failure' },
        }),
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { error: 'test failure' },
      } as PostToolUseFailureHookEvent;
      const mapped = mapPostToolUseFailure(event, ctx);
      expect(mapped.type).toBe('ToolFinished');
      if (mapped.type === 'ToolFinished') {
        expect(mapped.success).toBe(false);
        expect(mapped.error).toBe('test failure');
      }
    });

    it('extracts stderr as error message when error field absent', () => {
      const event: PostToolUseFailureHookEvent = {
        ...hookBase({
          tool_name: 'Bash',
          tool_response: { stderr: 'command not found' },
        }),
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: {},
        tool_response: { stderr: 'command not found' },
      } as PostToolUseFailureHookEvent;
      const mapped = mapPostToolUseFailure(event, ctx);
      if (mapped.type === 'ToolFinished') {
        expect(mapped.error).toBe('command not found');
      }
    });
  });

  describe('mapPermissionRequest (DEC-010 / DEC-011)', () => {
    it('maps a Bash permission request with structured fields', () => {
      const event: PermissionRequestHookEvent = {
        ...hookBase({ tool_name: 'Bash', tool_input: { command: 'npm install' } }),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'npm install' },
      } as PermissionRequestHookEvent;
      const mapped = mapPermissionRequest(event, ctx);
      expect(mapped.type).toBe('ApprovalRequested');
      if (mapped.type === 'ApprovalRequested') {
        expect(mapped.capability).toBe(CapabilityType.Shell);
        expect(mapped.destination).toBe('npm install');
        expect(mapped.command).toBe('npm install');
        expect(mapped.task).toBe('Refactor the auth module');
        expect(mapped.agent).toBe('claude-code');
        expect(mapped.workingDir).toBe('/repo/claude-hooks');
        expect(mapped.riskLevel).toBe(CapabilityRiskLevel.High);
        expect(mapped.scope).toHaveLength(1);
        expect(mapped.scope[0].type).toBe(CapabilityType.Shell);
      }
    });

    it('maps a Write permission request to Filesystem / medium', () => {
      const event: PermissionRequestHookEvent = {
        ...hookBase({ tool_name: 'Write', tool_input: { file_path: '/src/new.ts' } }),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Write',
        tool_input: { file_path: '/src/new.ts' },
      } as PermissionRequestHookEvent;
      const mapped = mapPermissionRequest(event, ctx);
      if (mapped.type === 'ApprovalRequested') {
        expect(mapped.capability).toBe(CapabilityType.Filesystem);
        expect(mapped.destination).toBe('/src/new.ts');
        expect(mapped.riskLevel).toBe(CapabilityRiskLevel.Medium);
      }
    });

    it('maps a Read permission request to Filesystem / low', () => {
      const event: PermissionRequestHookEvent = {
        ...hookBase({ tool_name: 'Read', tool_input: { file_path: '/src/config.json' } }),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Read',
        tool_input: { file_path: '/src/config.json' },
      } as PermissionRequestHookEvent;
      const mapped = mapPermissionRequest(event, ctx);
      if (mapped.type === 'ApprovalRequested') {
        expect(mapped.capability).toBe(CapabilityType.Filesystem);
        expect(mapped.riskLevel).toBe(CapabilityRiskLevel.Low);
      }
    });

    it('maps a destructive Bash command to critical', () => {
      const event: PermissionRequestHookEvent = {
        ...hookBase({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/build' } }),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/build' },
      } as PermissionRequestHookEvent;
      const mapped = mapPermissionRequest(event, ctx);
      if (mapped.type === 'ApprovalRequested') {
        expect(mapped.riskLevel).toBe(CapabilityRiskLevel.Critical);
      }
    });

    it('maps an unknown tool to Other / critical (DEC-011)', () => {
      const event: PermissionRequestHookEvent = {
        ...hookBase({ tool_name: 'mcp__custom__tool', tool_input: {} }),
        hook_event_name: 'PermissionRequest',
        tool_name: 'mcp__custom__tool',
        tool_input: {},
      } as PermissionRequestHookEvent;
      const mapped = mapPermissionRequest(event, ctx);
      if (mapped.type === 'ApprovalRequested') {
        expect(mapped.capability).toBe(CapabilityType.Other);
        expect(mapped.riskLevel).toBe(CapabilityRiskLevel.Critical);
        expect(mapped.destination).toBe('unknown');
      }
    });
  });

  describe('mapNotification', () => {
    it('maps permission_prompt to ApprovalRequested with conservative defaults', () => {
      const event: NotificationHookEvent = {
        ...hookBase({
          message: 'Claude needs your permission',
          notification_type: 'permission_prompt',
        }),
        hook_event_name: 'Notification',
        message: 'Claude needs your permission',
        notification_type: 'permission_prompt',
      } as NotificationHookEvent;
      const mapped = mapNotification(event, ctx);
      expect(mapped.type).toBe('ApprovalRequested');
      if (mapped.type === 'ApprovalRequested') {
        expect(mapped.capability).toBe(CapabilityType.Other);
        expect(mapped.riskLevel).toBe(CapabilityRiskLevel.Critical);
      }
    });

    it('maps idle_prompt to AgentProgress', () => {
      const event: NotificationHookEvent = {
        ...hookBase({ message: 'Claude is waiting for input', notification_type: 'idle_prompt' }),
        hook_event_name: 'Notification',
        message: 'Claude is waiting for input',
        notification_type: 'idle_prompt',
      } as NotificationHookEvent;
      const mapped = mapNotification(event, ctx);
      expect(mapped.type).toBe('AgentProgress');
      if (mapped.type === 'AgentProgress') {
        expect(mapped.message).toBe('Claude is waiting for input');
      }
    });
  });

  describe('mapStop', () => {
    it('maps to AgentCompleted with last_assistant_message as summary', () => {
      const event: StopHookEvent = {
        ...hookBase({ last_assistant_message: 'Done! Refactored auth module.' }),
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: 'Done! Refactored auth module.',
      } as StopHookEvent;
      const mapped = mapStop(event, ctx, 0);
      expect(mapped.type).toBe('AgentCompleted');
      if (mapped.type === 'AgentCompleted') {
        expect(mapped.summary).toBe('Done! Refactored auth module.');
        expect(mapped.exitCode).toBe(0);
        expect(mapped.deliverables).toEqual([]);
      }
    });

    it('uses a default summary when last_assistant_message is absent', () => {
      const event: StopHookEvent = {
        ...hookBase(),
        hook_event_name: 'Stop',
      } as StopHookEvent;
      const mapped = mapStop(event, ctx);
      if (mapped.type === 'AgentCompleted') {
        expect(mapped.summary).toBe('Claude Code session stopped');
      }
    });
  });

  describe('mapStopFailure', () => {
    it('maps to AgentFailed', () => {
      const event: StopFailureHookEvent = {
        ...hookBase({ error: 'rate_limit', error_details: 'Rate limit reached' }),
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        error_details: 'Rate limit reached',
      } as StopFailureHookEvent;
      const mapped = mapStopFailure(event, ctx);
      expect(mapped.type).toBe('AgentFailed');
      if (mapped.type === 'AgentFailed') {
        expect(mapped.error).toBe('Rate limit reached');
        expect(mapped.recoverable).toBe(true);
      }
    });

    it('marks server_error as non-recoverable', () => {
      const event: StopFailureHookEvent = {
        ...hookBase({ error: 'server_error' }),
        hook_event_name: 'StopFailure',
        error: 'server_error',
      } as StopFailureHookEvent;
      const mapped = mapStopFailure(event, ctx);
      if (mapped.type === 'AgentFailed') {
        expect(mapped.recoverable).toBe(false);
      }
    });
  });

  describe('mapHookEvent dispatch', () => {
    it('dispatches SessionStart', () => {
      const event = {
        ...hookBase({ source: 'startup' }),
        hook_event_name: 'SessionStart',
        source: 'startup',
      } as ClaudeHookEvent;
      const events = mapHookEvent(event, ctx);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('AgentStarted');
    });

    it('dispatches PreToolUse for a file tool (2 events)', () => {
      const event = {
        ...hookBase({ tool_name: 'Write', tool_input: { file_path: '/x.ts' } }),
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/x.ts' },
      } as ClaudeHookEvent;
      const events = mapHookEvent(event, ctx);
      expect(events).toHaveLength(2);
    });

    it('dispatches SessionEnd to no events', () => {
      const event = {
        ...hookBase(),
        hook_event_name: 'SessionEnd',
      } as ClaudeHookEvent;
      expect(mapHookEvent(event, ctx)).toHaveLength(0);
    });

    it('produces events that pass validateEvent', () => {
      const events: ClaudeHookEvent[] = [
        {
          ...hookBase({ source: 'startup', model: 'm1' }),
          hook_event_name: 'SessionStart',
          source: 'startup',
          model: 'm1',
        } as ClaudeHookEvent,
        {
          ...hookBase({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        } as ClaudeHookEvent,
        {
          ...hookBase({
            tool_name: 'Bash',
            tool_input: { command: 'ls' },
            tool_response: {},
            duration_ms: 10,
          }),
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_response: {},
          duration_ms: 10,
        } as ClaudeHookEvent,
        {
          ...hookBase({ tool_name: 'Bash', tool_input: { command: 'npm i' } }),
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'npm i' },
        } as ClaudeHookEvent,
        {
          ...hookBase({ last_assistant_message: 'done' }),
          hook_event_name: 'Stop',
          last_assistant_message: 'done',
        } as ClaudeHookEvent,
      ];
      for (const event of events) {
        for (const mapped of mapHookEvent(event, ctx)) {
          expect(() => validateEvent(mapped)).not.toThrow();
        }
      }
    });
  });

  describe('isHookEvent', () => {
    it('accepts a valid hook event', () => {
      const event = { hook_event_name: 'Stop', session_id: 's', cwd: '/r' };
      expect(isHookEvent(event)).toBe(true);
    });

    it('rejects non-objects', () => {
      expect(isHookEvent(null)).toBe(false);
      expect(isHookEvent('string')).toBe(false);
      expect(isHookEvent(42)).toBe(false);
    });

    it('rejects unknown event names', () => {
      expect(isHookEvent({ hook_event_name: 'Unknown', session_id: 's' })).toBe(false);
    });

    it('rejects missing hook_event_name', () => {
      expect(isHookEvent({ session_id: 's' })).toBe(false);
    });
  });

  describe('CLAUDE_HOOK_EVENT_NAMES', () => {
    it('includes all recognized event names', () => {
      expect(CLAUDE_HOOK_EVENT_NAMES).toContain('SessionStart');
      expect(CLAUDE_HOOK_EVENT_NAMES).toContain('PreToolUse');
      expect(CLAUDE_HOOK_EVENT_NAMES).toContain('PostToolUse');
      expect(CLAUDE_HOOK_EVENT_NAMES).toContain('PermissionRequest');
      expect(CLAUDE_HOOK_EVENT_NAMES).toContain('Stop');
      expect(CLAUDE_HOOK_EVENT_NAMES).toContain('SessionEnd');
    });
  });

  describe('buildHooksConfig', () => {
    it('builds a config with all mapped events', () => {
      const config = buildHooksConfig('my-forwarder.sh');
      expect(config['SessionStart']).toBeDefined();
      expect(config['PreToolUse']).toBeDefined();
      expect(config['PostToolUse']).toBeDefined();
      expect(config['PostToolUseFailure']).toBeDefined();
      expect(config['PermissionRequest']).toBeDefined();
      expect(config['Notification']).toBeDefined();
      expect(config['Stop']).toBeDefined();
      expect(config['StopFailure']).toBeDefined();
      expect(config['SessionEnd']).toBeDefined();
    });

    it('uses the provided command in all handlers', () => {
      const config = buildHooksConfig('forward.sh');
      for (const groups of Object.values(config)) {
        for (const group of groups) {
          for (const handler of group.hooks) {
            expect(handler.command).toBe('forward.sh');
            expect(handler.type).toBe('command');
          }
        }
      }
    });
  });
});

/* ------------------------------------------------------------------ *
 * 2. ClaudeHooksAdapter unit tests (mock CLI + in-memory sink)
 * ------------------------------------------------------------------ */
describe('ClaudeHooksAdapter (mock CLI, Tier B)', () => {
  function makeAdapter(spawner: MockCliSpawner, sink: InMemoryHookEventSink): ClaudeHooksAdapter {
    return new ClaudeHooksAdapter(null, { spawner, eventSink: sink });
  }

  it('declares fidelity tier B', () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    expect(adapter.fidelityTier).toBe(AdapterFidelityTier.B);
    expect(adapter.fidelityTier).toBe('B');
    expect(adapter.id).toBe(CLAUDE_HOOKS_ADAPTER_ID);
  });

  it('connects without spawning a process', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    expect(adapter.connectionState).toBe('connected');
    expect(spawner.spawnCalls).toHaveLength(0);
    await adapter.disconnect();
  });

  it('starts a run, emits AgentStarted, and spawns the CLI in headless mode', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();

    const sessionConfig = sampleSessionConfig();
    const result = await adapter.startRun('task-claude-hooks-1', sessionConfig);
    expect(result.started).toBe(true);
    expect(result.sessionId).toBe('sess-claude-hooks-1');

    // The CLI should have been spawned with -p and the objective.
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.spawnCalls[0].args).toContain('-p');
    expect(spawner.spawnCalls[0].args).toContain('Refactor the auth module');

    // AgentStarted should be queued immediately. Complete via clean exit.
    const streaming = collectEvents(adapter.streamEvents());
    spawner.lastProcess!.emitExit(0);
    const events = await streaming;
    expect(events[0].type).toBe('AgentStarted');
    if (events[0].type === 'AgentStarted') {
      expect(events[0].objective).toBe('Refactor the auth module');
      expect(events[0].adapterFidelityTier).toBe('B');
    }
    await adapter.disconnect();
  });

  it('maps hook events to SupervisorEvent variants', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    await adapter.startRun('task-claude-hooks-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    // Inject structured hook events.
    sink.pushEvent({
      ...hookBase({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    } as ClaudeHookEvent);
    sink.pushEvent({
      ...hookBase({ tool_name: 'Write', tool_input: { file_path: '/src/new.ts' } }),
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/src/new.ts' },
    } as ClaudeHookEvent);
    sink.pushEvent({
      ...hookBase({ tool_name: 'Bash', tool_input: { command: 'npm install' } }),
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
    } as ClaudeHookEvent);
    sink.pushEvent({
      ...hookBase({ last_assistant_message: 'Done!' }),
      hook_event_name: 'Stop',
      last_assistant_message: 'Done!',
    } as ClaudeHookEvent);

    const events = await streaming;
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('AgentStarted');
    expect(types).toContain('ToolStarted');
    expect(types).toContain('FileChanged');
    expect(types).toContain('ApprovalRequested');
    expect(types).toContain('AgentCompleted');

    // All events pass schema validation.
    for (const event of events) {
      expect(() => validateEvent(event)).not.toThrow();
    }
    // All events carry the correct envelope.
    for (const event of events) {
      expect(event.taskId).toBe('task-claude-hooks-1');
      expect(event.sessionId).toBe('sess-claude-hooks-1');
      expect(event.agentId).toBe('claude-code');
      expect(event.adapterFidelityTier).toBe('B');
    }
    await adapter.disconnect();
  });

  it('cancel sends SIGTERM and emits AgentStopped', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    await adapter.startRun('task-claude-hooks-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    await adapter.cancel('sess-claude-hooks-1');

    expect(spawner.lastProcess!.wasKilled).toBe(true);
    expect(spawner.lastProcess!.killSignals).toContain('SIGTERM');

    const events = await streaming;
    const stopped = events.filter((e) => e.type === 'AgentStopped');
    expect(stopped).toHaveLength(1);
    if (stopped[0].type === 'AgentStopped') {
      expect(stopped[0].reason).toBe('user');
    }
    await adapter.disconnect();
  });

  it('cancel is a no-op for an unknown session id', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    await adapter.startRun('task-claude-hooks-1', sampleSessionConfig());

    await adapter.cancel('some-other-session');
    expect(spawner.lastProcess!.wasKilled).toBe(false);

    await adapter.disconnect();
  });

  it('emits AgentFailed when the CLI exits with a non-zero code', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    await adapter.startRun('task-claude-hooks-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    spawner.lastProcess!.emitExit(1);

    const events = await streaming;
    const failed = events.filter((e) => e.type === 'AgentFailed');
    expect(failed).toHaveLength(1);
    if (failed[0].type === 'AgentFailed') {
      expect(failed[0].exitCode).toBe(1);
      expect(failed[0].recoverable).toBe(true);
      expect(failed[0].error).toContain('code 1');
    }
    await adapter.disconnect();
  });

  it('emits AgentCompleted when the CLI exits with code 0 and no Stop hook', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    await adapter.startRun('task-claude-hooks-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    spawner.lastProcess!.emitExit(0);

    const events = await streaming;
    const completed = events.filter((e) => e.type === 'AgentCompleted');
    expect(completed).toHaveLength(1);
    if (completed[0].type === 'AgentCompleted') {
      expect(completed[0].exitCode).toBe(0);
    }
    await adapter.disconnect();
  });

  it('does not emit a duplicate terminal event when Stop hook precedes exit', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    await adapter.startRun('task-claude-hooks-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    sink.pushEvent({
      ...hookBase({ last_assistant_message: 'Finished' }),
      hook_event_name: 'Stop',
      last_assistant_message: 'Finished',
    } as ClaudeHookEvent);
    spawner.lastProcess!.emitExit(0);

    const events = await streaming;
    const completed = events.filter((e) => e.type === 'AgentCompleted');
    expect(completed).toHaveLength(1);
    await adapter.disconnect();
  });

  it('throws when startRun is called before connect', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await expect(adapter.startRun('task-1', sampleSessionConfig())).rejects.toThrow();
  });

  it('throws when startRun is called with an active session', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    await adapter.startRun('task-claude-hooks-1', sampleSessionConfig());
    await expect(adapter.startRun('task-claude-hooks-1', sampleSessionConfig())).rejects.toThrow();
    await adapter.disconnect();
  });

  it('disconnect kills the CLI and transitions to disconnected', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    await adapter.startRun('task-claude-hooks-1', sampleSessionConfig());

    await adapter.disconnect();
    expect(spawner.lastProcess!.wasKilled).toBe(true);
    expect(adapter.connectionState).toBe('disconnected');
  });

  it('self-reports fidelity tier B after connect', async () => {
    const spawner = new MockCliSpawner();
    const sink = new InMemoryHookEventSink();
    const adapter = makeAdapter(spawner, sink);
    await adapter.connect();
    expect(adapter.fidelityTier).toBe(AdapterFidelityTier.B);
    await adapter.disconnect();
  });
});
