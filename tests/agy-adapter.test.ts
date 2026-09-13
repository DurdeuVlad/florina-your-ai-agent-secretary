import { describe, it, expect } from 'vitest';
import {
  AgyAdapter,
  AGY_ADAPTER_ID,
  type AgyProcess,
  type AgySpawner,
} from '../src/adapters/agy-adapter.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import type { SessionConfig } from '../src/adapters/base.js';

/** A scripted agy process: the test feeds stdout lines and drives exit. */
class FakeAgyProcess implements AgyProcess {
  killed = false;
  private readonly lineHandlers: Array<(l: string) => void> = [];
  private readonly errHandlers: Array<(l: string) => void> = [];
  private readonly exitHandlers: Array<(c: number | null, s: string | null) => void> = [];

  onLine(h: (l: string) => void): void {
    this.lineHandlers.push(h);
  }
  onStderrLine(h: (l: string) => void): void {
    this.errHandlers.push(h);
  }
  onExit(h: (c: number | null, s: string | null) => void): void {
    this.exitHandlers.push(h);
  }
  kill(): void {
    this.killed = true;
  }
  feed(line: string): void {
    for (const h of this.lineHandlers) h(line);
  }
  exit(code: number): void {
    for (const h of this.exitHandlers) h(code, null);
  }
}

const config: SessionConfig = {
  taskId: 'task-1',
  sessionId: 'sess-1',
  agentId: 'agy-1',
  workingDir: '/repo/wt',
  objective: 'fix the bug',
};

function makeAdapter() {
  const proc = new FakeAgyProcess();
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const spawner: AgySpawner = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    return proc;
  };
  const adapter = new AgyAdapter(null, { spawner });
  return { adapter, proc, calls };
}

async function collect(adapter: AgyAdapter): Promise<SupervisorEvent[]> {
  const out: SupervisorEvent[] = [];
  for await (const e of adapter.streamEvents()) {
    out.push(e);
  }
  return out;
}

describe('AgyAdapter', () => {
  it('is Tier D with the antigravity id', () => {
    const { adapter } = makeAdapter();
    expect(adapter.id).toBe(AGY_ADAPTER_ID);
    expect(adapter.id).toBe('antigravity');
    expect(adapter.fidelityTier).toBe('D');
  });

  it('spawns agy -p <objective> --output-format stream-json in the worktree', async () => {
    const { adapter, proc, calls } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    expect(calls[0].command).toBe('agy');
    expect(calls[0].args).toEqual([
      '-p',
      'fix the bug',
      '--output-format',
      'stream-json',
    ]);
    expect(calls[0].cwd).toBe('/repo/wt');
    proc.exit(0);
    await events;
  });

  it('passes --model when the session pins one', async () => {
    const { adapter, proc, calls } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', { ...config, model: 'gemini-3-pro' });
    expect(calls[0].args).toContain('--model');
    expect(calls[0].args).toContain('gemini-3-pro');
    proc.exit(0);
    await events;
  });

  it('maps stream-json lines to SupervisorEvents', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);

    proc.feed(JSON.stringify({ type: 'system', subtype: 'init' }));
    proc.feed(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'reading files' }] },
      }),
    );
    proc.feed(
      JSON.stringify({ type: 'tool_use', name: 'shell', input: { cmd: 'npm test' } }),
    );
    proc.feed(JSON.stringify({ type: 'tool_result', name: 'shell', is_error: false }));
    proc.feed(
      JSON.stringify({ type: 'result', result: 'fixed it', duration_ms: 5000 }),
    );

    const collected = await events;
    const types = collected.map((e) => e.type);
    expect(types).toEqual([
      'AgentStarted',
      'AgentProgress',
      'ToolStarted',
      'ToolFinished',
      'AgentCompleted',
    ]);
    const completed = collected[4];
    if (completed.type === 'AgentCompleted') {
      expect(completed.summary).toBe('fixed it');
      expect(completed.durationMs).toBe(5000);
    }
  });

  it('maps error events and non-zero exits to AgentFailed', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.feed(JSON.stringify({ type: 'error', error: '429 rate limit' }));
    const collected = await events;
    const last = collected[collected.length - 1];
    expect(last.type).toBe('AgentFailed');
    if (last.type === 'AgentFailed') {
      expect(last.error).toContain('429');
      expect(last.recoverable).toBe(true);
    }
  });

  it('emits a fallback AgentFailed on non-zero exit without a result', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.exit(1);
    const collected = await events;
    const last = collected[collected.length - 1];
    expect(last.type).toBe('AgentFailed');
    if (last.type === 'AgentFailed') {
      expect(last.exitCode).toBe(1);
    }
  });

  it('emits a fallback AgentCompleted on exit 0 without a result line', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.exit(0);
    const collected = await events;
    expect(collected[collected.length - 1].type).toBe('AgentCompleted');
  });

  it('cancel kills the process and emits AgentStopped', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    await adapter.cancel('sess-1');
    expect(proc.killed).toBe(true);
    proc.exit(0);
    const collected = await events;
    expect(collected[collected.length - 1].type).toBe('AgentStopped');
  });

  it('ignores malformed and unknown lines without failing', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.feed('not json at all');
    proc.feed(JSON.stringify({ type: 'mystery', data: 1 }));
    proc.feed(JSON.stringify('a bare string'));
    proc.exit(0);
    const collected = await events;
    expect(collected.map((e) => e.type)).toEqual(['AgentStarted', 'AgentCompleted']);
  });

  it('disconnect kills the process and disconnects', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    await adapter.disconnect();
    expect(proc.killed).toBe(true);
    expect(adapter.connectionState).toBe('disconnected');
    await events;
  });
});
