import { describe, it, expect } from 'vitest';

import { AdapterFidelityTier } from '../src/domain/enums.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import { validateEvent } from '../src/domain/events.js';
import { CapabilityType } from '../src/domain/capabilities.js';

import {
  ClaudeAdapter,
  CLAUDE_ADAPTER_ID,
  type ClaudeAdapterOptions,
  type PtyProcess,
  type PtySpawner,
  type PtySpawnOptions,
  type SessionConfig,
} from '../src/adapters/index.js';
import {
  parsePtyLine,
  stripAnsi,
  mapPtyChunk,
  mapToolStarted,
  mapFileChanged,
  mapProgress,
  mapCompletion,
  mapPermissionPrompt,
  parseAndMapPtyLine,
  type ClaudeMapperContext,
} from '../src/adapters/claude-mapper.js';

/* ------------------------------------------------------------------ *
 * Mock PTY
 * ------------------------------------------------------------------ */

/**
 * An in-memory mock PTY process that simulates Claude CLI output without
 * spawning a real subprocess. Tests drive it via `emitData` / `emitExit`.
 */
class MockPtyProcess implements PtyProcess {
  readonly pid: number;
  private dataHandler: ((data: string) => void) | null = null;
  private exitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  /** All writes sent to the PTY (keystrokes, prompts, Ctrl-C). */
  readonly writes: string[] = [];
  private killed = false;

  constructor(pid = 12345) {
    this.pid = pid;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  onData(handler: (data: string) => void): void {
    this.dataHandler = handler;
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.exitHandler = handler;
  }

  kill(signal?: string): void {
    this.killed = true;
    void signal;
  }

  /** Whether `kill` was called. */
  get wasKilled(): boolean {
    return this.killed;
  }

  /** Simulate the CLI emitting output to the PTY. */
  emitData(data: string): void {
    if (this.dataHandler) {
      this.dataHandler(data);
    }
  }

  /** Simulate the CLI process exiting. */
  emitExit(exitCode: number, signal?: number): void {
    if (this.exitHandler) {
      this.exitHandler(exitCode, signal);
    }
  }
}

/**
 * A mock PTY spawner that returns a controllable {@link MockPtyProcess}.
 */
class MockPtySpawner implements PtySpawner {
  lastProcess: MockPtyProcess | null = null;
  readonly spawnCalls: PtySpawnOptions[] = [];

  spawn(options: PtySpawnOptions): PtyProcess {
    this.spawnCalls.push(options);
    const proc = new MockPtyProcess();
    this.lastProcess = proc;
    return proc;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A minimal valid SessionConfig for Claude runs. */
function sampleSessionConfig(): SessionConfig {
  return {
    taskId: 'task-claude-1',
    sessionId: 'sess-claude-1',
    agentId: 'claude-code',
    workingDir: '/repo/claude',
    objective: 'Refactor the auth module',
    model: 'claude-sonnet-4',
  };
}

/** Build a ClaudeMapperContext matching the sample session config. */
function sampleMapperCtx(): ClaudeMapperContext {
  return {
    taskId: 'task-claude-1',
    sessionId: 'sess-claude-1',
    agentId: 'claude-code',
    adapterFidelityTier: AdapterFidelityTier.B,
    objective: 'Refactor the auth module',
    workingDir: '/repo/claude',
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

/** ANSI red color sequence used to verify stripping. */
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

/* ------------------------------------------------------------------ *
 * 1. Mapper unit tests
 * ------------------------------------------------------------------ */
describe('Claude PTY mapper', () => {
  const ctx = sampleMapperCtx();

  describe('stripAnsi', () => {
    it('removes ANSI escape codes', () => {
      const input = `${ANSI_RED}Error${ANSI_RESET} message`;
      expect(stripAnsi(input)).toBe('Error message');
    });

    it('leaves plain text untouched', () => {
      expect(stripAnsi('plain text')).toBe('plain text');
    });
  });

  describe('parsePtyLine', () => {
    it('parses a tool-use marker (● prefix)', () => {
      const chunk = parsePtyLine('● Read(src/auth.ts)');
      expect(chunk.kind).toBe('tool-start');
      expect(chunk.toolName).toBe('Read');
      expect(chunk.toolArgs).toBe('src/auth.ts');
    });

    it('parses a tool-use marker (⏺ prefix)', () => {
      const chunk = parsePtyLine('⏺ Bash(npm test)');
      expect(chunk.kind).toBe('tool-start');
      expect(chunk.toolName).toBe('Bash');
      expect(chunk.toolArgs).toBe('npm test');
    });

    it('parses a file-edit tool as a file-change', () => {
      const chunk = parsePtyLine('● Edit(src/auth.ts)');
      expect(chunk.kind).toBe('file-change');
      expect(chunk.toolName).toBe('Edit');
      expect(chunk.filePath).toBe('src/auth.ts');
      expect(chunk.changeType).toBe('modified');
    });

    it('parses a Write tool as a created file change', () => {
      const chunk = parsePtyLine('● Write(src/new-file.ts)');
      expect(chunk.kind).toBe('file-change');
      expect(chunk.changeType).toBe('created');
      expect(chunk.filePath).toBe('src/new-file.ts');
    });

    it('parses a completion marker', () => {
      const chunk = parsePtyLine('✓ Task completed');
      expect(chunk.kind).toBe('completion');
    });

    it('parses a permission prompt', () => {
      const chunk = parsePtyLine('Claude needs your permission to run Bash(npm install)');
      expect(chunk.kind).toBe('permission-prompt');
      expect(chunk.capability).toBe(CapabilityType.Shell);
    });

    it('classifies empty lines as noise', () => {
      expect(parsePtyLine('').kind).toBe('noise');
    });

    it('classifies unrecognized lines as progress', () => {
      const chunk = parsePtyLine('I will now analyze the repository structure');
      expect(chunk.kind).toBe('progress');
    });

    it('strips ANSI escapes before parsing', () => {
      const chunk = parsePtyLine(`${ANSI_RED}●${ANSI_RESET} Read(src/auth.ts)`);
      expect(chunk.kind).toBe('tool-start');
      expect(chunk.toolName).toBe('Read');
    });
  });

  describe('mapToolStarted', () => {
    it('maps a tool-start chunk to ToolStarted', () => {
      const chunk = parsePtyLine('● Bash(npm test)');
      const event = mapToolStarted(chunk, ctx);
      expect(event.type).toBe('ToolStarted');
      if (event.type === 'ToolStarted') {
        expect(event.toolName).toBe('Bash');
        expect(event.args).toEqual({ raw: 'npm test' });
        expect(event.adapterFidelityTier).toBe('B');
      }
    });
  });

  describe('mapFileChanged', () => {
    it('maps a file-change chunk to FileChanged', () => {
      const chunk = parsePtyLine('● Edit(src/auth.ts)');
      const event = mapFileChanged(chunk, ctx);
      expect(event.type).toBe('FileChanged');
      if (event.type === 'FileChanged') {
        expect(event.path).toBe('src/auth.ts');
        expect(event.changeType).toBe('modified');
      }
    });
  });

  describe('mapProgress', () => {
    it('maps a progress chunk to AgentProgress', () => {
      const chunk = parsePtyLine('Analyzing the repository structure');
      const event = mapProgress(chunk, ctx);
      expect(event.type).toBe('AgentProgress');
      if (event.type === 'AgentProgress') {
        expect(event.message).toBe('Analyzing the repository structure');
      }
    });
  });

  describe('mapCompletion', () => {
    it('maps a completion chunk to AgentCompleted', () => {
      const chunk = parsePtyLine('✓ Task completed');
      const event = mapCompletion(chunk, ctx, 0);
      expect(event.type).toBe('AgentCompleted');
      if (event.type === 'AgentCompleted') {
        expect(event.exitCode).toBe(0);
        expect(event.deliverables).toEqual([]);
      }
    });
  });

  describe('mapPermissionPrompt (DEC-010 / DEC-011)', () => {
    it('maps a shell permission prompt with inferred capability', () => {
      const chunk = parsePtyLine('Claude needs your permission to run Bash(npm install)');
      const event = mapPermissionPrompt(chunk, ctx);
      expect(event.type).toBe('ApprovalRequested');
      if (event.type === 'ApprovalRequested') {
        expect(event.capability).toBe(CapabilityType.Shell);
        expect(event.task).toBe('Refactor the auth module');
        expect(event.agent).toBe('claude-code');
        expect(event.workingDir).toBe('/repo/claude');
        // Shell capability is not downgraded below critical by default.
        expect(event.riskLevel).toBe('critical');
        expect(event.scope).toHaveLength(1);
        expect(event.scope[0].type).toBe(CapabilityType.Shell);
      }
    });

    it('maps a filesystem read prompt to medium risk', () => {
      const chunk = parsePtyLine('Do you want to allow Read(src/config.json)?');
      const event = mapPermissionPrompt(chunk, ctx);
      expect(event.type).toBe('ApprovalRequested');
      if (event.type === 'ApprovalRequested') {
        expect(event.capability).toBe(CapabilityType.Filesystem);
        expect(event.riskLevel).toBe('medium');
      }
    });

    it('maps a network prompt to high risk', () => {
      const chunk = parsePtyLine('Claude needs your permission to fetch https://api.github.com');
      const event = mapPermissionPrompt(chunk, ctx);
      expect(event.type).toBe('ApprovalRequested');
      if (event.type === 'ApprovalRequested') {
        expect(event.capability).toBe(CapabilityType.Network);
        expect(event.riskLevel).toBe('high');
      }
    });

    it('defaults unparseable capability to other and risk to critical (DEC-011)', () => {
      const chunk = parsePtyLine('Approve?');
      const event = mapPermissionPrompt(chunk, ctx);
      expect(event.type).toBe('ApprovalRequested');
      if (event.type === 'ApprovalRequested') {
        expect(event.capability).toBe(CapabilityType.Other);
        expect(event.riskLevel).toBe('critical');
        expect(event.destination).toBe('unknown');
      }
    });
  });

  describe('mapPtyChunk dispatch', () => {
    it('produces ToolStarted for a tool-start chunk', () => {
      const events = mapPtyChunk(parsePtyLine('● Bash(ls)'), ctx);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ToolStarted');
    });

    it('produces ToolStarted + FileChanged for a file-edit chunk', () => {
      const events = mapPtyChunk(parsePtyLine('● Edit(src/foo.ts)'), ctx);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('ToolStarted');
      expect(events[1].type).toBe('FileChanged');
    });

    it('produces AgentProgress for a progress chunk', () => {
      const events = mapPtyChunk(parsePtyLine('Working on it'), ctx);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('AgentProgress');
    });

    it('produces ApprovalRequested for a permission-prompt chunk', () => {
      const events = mapPtyChunk(parsePtyLine('Allow? Bash(rm -rf /)'), ctx);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ApprovalRequested');
    });

    it('produces no events for noise', () => {
      expect(mapPtyChunk(parsePtyLine(''), ctx)).toHaveLength(0);
    });
  });

  describe('parseAndMapPtyLine', () => {
    it('parses and maps in one step', () => {
      const events = parseAndMapPtyLine('● Edit(src/auth.ts)', ctx);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('ToolStarted');
      expect(events[1].type).toBe('FileChanged');
    });
  });

  it('produces events that pass validateEvent', () => {
    const lines = [
      '● Bash(npm test)',
      '● Edit(src/auth.ts)',
      '● Write(src/new.ts)',
      'Analyzing the repo',
      '✓ Task completed',
      'Claude needs your permission to run Bash(npm install)',
      'Do you want to allow Read(src/config.json)?',
    ];
    for (const line of lines) {
      for (const event of parseAndMapPtyLine(line, ctx)) {
        expect(() => validateEvent(event)).not.toThrow();
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. ClaudeAdapter unit tests (mock PTY)
 * ------------------------------------------------------------------ */
describe('ClaudeAdapter (mock PTY)', () => {
  function makeAdapter(spawner: MockPtySpawner): ClaudeAdapter {
    const options: ClaudeAdapterOptions = { spawner };
    return new ClaudeAdapter(null, options);
  }

  it('declares fidelity tier B', () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    expect(adapter.fidelityTier).toBe(AdapterFidelityTier.B);
    expect(adapter.fidelityTier).toBe('B');
    expect(adapter.id).toBe(CLAUDE_ADAPTER_ID);
  });

  it('connects by spawning a PTY via the injected spawner', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    expect(adapter.connectionState).toBe('connected');
    expect(spawner.spawnCalls).toHaveLength(1);
    expect(spawner.lastProcess).not.toBeNull();
    await adapter.disconnect();
  });

  it('starts a run, emits AgentStarted, and sends the objective to the PTY', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    const pty = spawner.lastProcess!;

    const sessionConfig = sampleSessionConfig();
    const result = await adapter.startRun('task-claude-1', sessionConfig);
    expect(result.started).toBe(true);
    expect(result.sessionId).toBe('sess-claude-1');

    // The objective should have been written to the PTY followed by Enter.
    expect(pty.writes).toContain(`Refactor the auth module\r`);

    // AgentStarted should be queued immediately. Complete the stream via a
    // clean exit so collectEvents resolves.
    const streaming = collectEvents(adapter.streamEvents());
    pty.emitExit(0);
    const events = await streaming;
    expect(events[0].type).toBe('AgentStarted');
    if (events[0].type === 'AgentStarted') {
      expect(events[0].objective).toBe('Refactor the auth module');
      expect(events[0].adapterFidelityTier).toBe('B');
    }
    await adapter.disconnect();
  });

  it('parses PTY output and maps to SupervisorEvent variants', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    const pty = spawner.lastProcess!;

    await adapter.startRun('task-claude-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    // Simulate Claude CLI output.
    pty.emitData('● Read(src/auth.ts)\n');
    pty.emitData('● Edit(src/auth.ts)\n');
    pty.emitData('I will now run the tests\n');
    pty.emitData('● Bash(npm test)\n');
    pty.emitData('Claude needs your permission to run Bash(npm install)\n');
    pty.emitData('✓ Task completed\n');
    // Exit with code 0 to complete the stream.
    pty.emitExit(0);

    const events = await streaming;
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('AgentStarted');
    expect(types).toContain('ToolStarted');
    expect(types).toContain('FileChanged');
    expect(types).toContain('AgentProgress');
    expect(types).toContain('ApprovalRequested');
    expect(types).toContain('AgentCompleted');

    // All events pass schema validation.
    for (const event of events) {
      expect(() => validateEvent(event)).not.toThrow();
    }
    // All events carry the correct envelope.
    for (const event of events) {
      expect(event.taskId).toBe('task-claude-1');
      expect(event.sessionId).toBe('sess-claude-1');
      expect(event.agentId).toBe('claude-code');
      expect(event.adapterFidelityTier).toBe('B');
    }
    await adapter.disconnect();
  });

  it('handles partial lines split across data chunks', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    const pty = spawner.lastProcess!;

    await adapter.startRun('task-claude-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    // Emit a tool-use line split across two data chunks.
    pty.emitData('● Bas');
    pty.emitData('h(npm test)\n');
    pty.emitExit(0);

    const events = await streaming;
    const toolStarted = events.filter((e) => e.type === 'ToolStarted');
    expect(toolStarted).toHaveLength(1);
    if (toolStarted[0].type === 'ToolStarted') {
      expect(toolStarted[0].toolName).toBe('Bash');
    }
    await adapter.disconnect();
  });

  it('cancel sends Ctrl-C and emits AgentStopped', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    const pty = spawner.lastProcess!;

    await adapter.startRun('task-claude-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    // Emit some progress so the stream is active.
    pty.emitData('Working on it\n');

    // Cancel the run.
    await adapter.cancel('sess-claude-1');

    // Verify Ctrl-C (0x03) was written to the PTY.
    expect(pty.writes).toContain('\x03');

    const events = await streaming;
    const stopped = events.filter((e) => e.type === 'AgentStopped');
    expect(stopped).toHaveLength(1);
    if (stopped[0].type === 'AgentStopped') {
      expect(stopped[0].reason).toBe('user');
    }
    await adapter.disconnect();
  });

  it('cancel is a no-op for an unknown session id', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    const pty = spawner.lastProcess!;

    await adapter.startRun('task-claude-1', sampleSessionConfig());
    const writesBefore = pty.writes.length;

    await adapter.cancel('some-other-session');
    // No Ctrl-C should have been written.
    expect(pty.writes.length).toBe(writesBefore);
    expect(pty.writes).not.toContain('\x03');

    await adapter.disconnect();
  });

  it('emits AgentFailed when the PTY exits with a non-zero code', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    const pty = spawner.lastProcess!;

    await adapter.startRun('task-claude-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    // Simulate the CLI crashing.
    pty.emitExit(1);

    const events = await streaming;
    const failed = events.filter((e) => e.type === 'AgentFailed');
    expect(failed).toHaveLength(1);
    if (failed[0].type === 'AgentFailed') {
      expect(failed[0].exitCode).toBe(1);
      expect(failed[0].recoverable).toBe(true);
      expect(failed[0].error).toContain('code 1');
    }
    // Validate the failure event.
    expect(() => validateEvent(failed[0])).not.toThrow();
    await adapter.disconnect();
  });

  it('emits AgentCompleted when the PTY exits with code 0 and no completion marker', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    const pty = spawner.lastProcess!;

    await adapter.startRun('task-claude-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    pty.emitData('Working on it\n');
    pty.emitExit(0);

    const events = await streaming;
    const completed = events.filter((e) => e.type === 'AgentCompleted');
    expect(completed).toHaveLength(1);
    if (completed[0].type === 'AgentCompleted') {
      expect(completed[0].exitCode).toBe(0);
    }
    await adapter.disconnect();
  });

  it('does not emit a duplicate terminal event when completion marker precedes exit', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    const pty = spawner.lastProcess!;

    await adapter.startRun('task-claude-1', sampleSessionConfig());
    const streaming = collectEvents(adapter.streamEvents());

    pty.emitData('✓ Task completed\n');
    pty.emitExit(0);

    const events = await streaming;
    const completed = events.filter((e) => e.type === 'AgentCompleted');
    // Only one AgentCompleted (from the marker); the exit handler is a no-op
    // because the stream is already complete.
    expect(completed).toHaveLength(1);
    await adapter.disconnect();
  });

  it('throws when startRun is called before connect', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await expect(adapter.startRun('task-1', sampleSessionConfig())).rejects.toThrow();
  });

  it('throws when startRun is called with an active session', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    await adapter.startRun('task-claude-1', sampleSessionConfig());
    await expect(adapter.startRun('task-claude-1', sampleSessionConfig())).rejects.toThrow();
    await adapter.disconnect();
  });

  it('disconnect kills the PTY and transitions to disconnected', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    const pty = spawner.lastProcess!;
    await adapter.startRun('task-claude-1', sampleSessionConfig());

    await adapter.disconnect();
    expect(pty.wasKilled).toBe(true);
    expect(adapter.connectionState).toBe('disconnected');
  });

  it('self-reports fidelity tier B after connect', async () => {
    const spawner = new MockPtySpawner();
    const adapter = makeAdapter(spawner);
    await adapter.connect();
    expect(adapter.fidelityTier).toBe(AdapterFidelityTier.B);
    await adapter.disconnect();
  });
});
