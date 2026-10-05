import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PrintRunAdapter,
  type PrintRunProcess,
  type PrintRunSpawner,
} from '../src/adapters/print-run-adapter.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import type { SessionConfig } from '../src/adapters/base.js';
import { providerManifest } from '../src/core/application/use-cases/readiness/provider-manifests.js';

/** A scripted print-run process: the test feeds stdout lines and drives exit. */
class FakePrintRunProcess implements PrintRunProcess {
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
  private readonly errEventHandlers: Array<(e: Error) => void> = [];
  onError(h: (e: Error) => void): void {
    this.errEventHandlers.push(h);
  }
  emitError(error: Error): void {
    for (const h of this.errEventHandlers) h(error);
  }
  kill(): void {
    this.killed = true;
  }
  feed(line: string): void {
    for (const h of this.lineHandlers) h(line);
  }
  feedErr(line: string): void {
    for (const h of this.errHandlers) h(line);
  }
  exit(code: number | null, signal: string | null = null): void {
    for (const h of this.exitHandlers) h(code, signal);
  }
}

/** The manifest's own args — the test exercises what the daemon would spawn. */
const manifestArgs = (providerManifest('aider')!.transport as { args: readonly string[] }).args;

const config: SessionConfig = {
  taskId: 'task-1',
  sessionId: 'sess-1',
  agentId: 'aider-1',
  workingDir: '/repo/wt',
  objective: 'fix the failing test',
};

function makeAdapter(extra?: { tempDir?: string }) {
  const proc = new FakePrintRunProcess();
  const calls: {
    command: string;
    args: readonly string[];
    cwd: string;
    env?: Readonly<Record<string, string>>;
  }[] = [];
  const spawner: PrintRunSpawner = (command, args, cwd, env) => {
    calls.push({ command, args, cwd, env });
    return proc;
  };
  const tempDir = extra?.tempDir ?? mkdtempSync(join(tmpdir(), 'print-run-test-'));
  const transport = providerManifest('aider')!.transport as {
    args: readonly string[];
    failurePatterns?: readonly string[];
  };
  const adapter = new PrintRunAdapter(null, {
    id: 'aider',
    command: '/home/u/.local/bin/aider',
    args: manifestArgs,
    failurePatterns: transport.failurePatterns?.map((p) => new RegExp(p)),
    spawner,
    tempDir,
  });
  return { adapter, proc, calls, tempDir };
}

async function collect(adapter: PrintRunAdapter): Promise<SupervisorEvent[]> {
  const out: SupervisorEvent[] = [];
  for await (const e of adapter.streamEvents()) out.push(e);
  return out;
}

describe('PrintRunAdapter', () => {
  it('is Tier E with the provider id it was constructed for', () => {
    const { adapter } = makeAdapter();
    expect(adapter.id).toBe('aider');
    expect(adapter.fidelityTier).toBe('E');
  });

  it('writes the objective to a message file and substitutes {messageFile}', async () => {
    const { adapter, proc, calls, tempDir } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);

    expect(calls[0].command).toBe('/home/u/.local/bin/aider');
    expect(calls[0].cwd).toBe('/repo/wt');
    const fIdx = calls[0].args.indexOf('--message-file');
    expect(fIdx).toBeGreaterThanOrEqual(0);
    const messageFile = calls[0].args[fIdx + 1];
    expect(messageFile.startsWith(tempDir)).toBe(true);
    expect(readFileSync(messageFile, 'utf8')).toBe('fix the failing test');
    // The non-interactive flags from the manifest arrive verbatim.
    for (const flag of ['--yes-always', '--no-stream', '--no-pretty', '--no-auto-commits']) {
      expect(calls[0].args).toContain(flag);
    }
    proc.exit(0);
    await events;
  });

  it('drops the --model=… arg atomically when the session pins no model', async () => {
    const { adapter, proc, calls } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    // '--model={model}' must vanish whole — a bare '--model' would crash argparse.
    expect(calls[0].args.some((a) => a.includes('{model}'))).toBe(false);
    expect(calls[0].args.some((a) => a.startsWith('--model'))).toBe(false);
    proc.exit(0);
    await events;
  });

  it('substitutes --model=<m> when the session pins one', async () => {
    const { adapter, proc, calls } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', { ...config, model: 'gpt-4o' });
    expect(calls[0].args).toContain('--model=gpt-4o');
    proc.exit(0);
    await events;
  });

  it('passes scoped session env to the spawned process', async () => {
    const { adapter, proc, calls } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', { ...config, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(calls[0].env?.['OPENAI_API_KEY']).toBe('sk-test');
    proc.exit(0);
    await events;
  });

  it('maps stdout lines to AgentProgress and exit 0 to AgentCompleted', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);

    proc.feed('Aider v0.86.0');
    proc.feed('');
    proc.feed('> editing src/foo.ts');
    proc.exit(0);

    const all = await events;
    expect(all[0].type).toBe('AgentStarted');
    const progress = all.filter((e) => e.type === 'AgentProgress');
    expect(progress.map((e) => (e as { message: string }).message)).toEqual([
      'Aider v0.86.0',
      '> editing src/foo.ts',
    ]);
    const done = all.at(-1);
    expect(done.type).toBe('AgentCompleted');
    expect((done as { summary: string }).summary).toBe('> editing src/foo.ts');
    expect((done as { deliverables: unknown[] }).deliverables).toEqual([]);
  });

  it('caps very long stdout lines so the journal stays bounded', async () => {
    const proc = new FakePrintRunProcess();
    const adapter = new PrintRunAdapter(null, {
      id: 'aider',
      command: 'aider',
      args: ['{messageFile}'],
      spawner: () => proc,
      tempDir: mkdtempSync(join(tmpdir(), 'prt-')),
      maxLineChars: 10,
    });
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.feed('x'.repeat(50));
    proc.exit(0);
    const all = await events;
    const line = (all.find((e) => e.type === 'AgentProgress') as { message: string }).message;
    expect(line).toBe('xxxxxxxxxx…');
  });

  it('maps a nonzero exit to AgentFailed with the stderr tail', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);

    proc.feedErr('litellm.AuthenticationError: missing OPENAI_API_KEY');
    proc.exit(1);

    const all = await events;
    const failed = all.at(-1);
    expect(failed.type).toBe('AgentFailed');
    const f = failed as { error: string; exitCode: number; recoverable: boolean };
    expect(f.error).toContain('missing OPENAI_API_KEY');
    expect(f.exitCode).toBe(1);
    expect(f.recoverable).toBe(true);
  });

  it('maps a signal death to AgentFailed even with a quiet stderr', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.exit(null, 'SIGKILL');
    const all = await events;
    const failed = all.at(-1) as { type: string; error: string };
    expect(failed.type).toBe('AgentFailed');
    expect(failed.error).toContain('SIGKILL');
  });

  it('maps cancel to AgentStopped after killing the process', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    await adapter.cancel('sess-1');
    expect(proc.killed).toBe(true);
    proc.exit(null, 'SIGTERM');
    const all = await events;
    const last = all.at(-1);
    expect(last.type).toBe('AgentStopped');
    expect((last as { reason: string }).reason).toBe('user');
  });

  it('removes the message-file dir after the run ends', async () => {
    const { adapter, proc, tempDir } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.exit(0);
    await events;
    expect(readdirSync(tempDir).filter((d) => d.startsWith('florina-aider-'))).toEqual([]);
  });

  it('refuses a second run while a session is active', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    await expect(adapter.startRun('task-2', config)).rejects.toThrow(/already has an active/);
    proc.exit(0);
    await events;
  });

  it('a failure-pattern line in the tail turns a clean exit into AgentFailed (#306 live finding)', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.feed('Aider v0.86.2');
    proc.feed(
      'litellm.AuthenticationError: AuthenticationError: OpenAIException - The api_key client option must be set',
    );
    proc.feed('The API provider is not able to authenticate you. Check your API key.');
    proc.exit(0); // aider exits 0 even when the model call failed
    const all = await events;
    const last = all.at(-1) as { type: string; error?: string; exitCode?: number };
    expect(last.type).toBe('AgentFailed');
    expect(last.error).toContain('litellm.AuthenticationError');
    expect(last.exitCode).toBe(0);
  });

  it('a litellm error the run recovered past scrolls out of the tail — Completed', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.feed('litellm.RateLimitError: transient, retrying');
    // Twenty ordinary lines push the transient error out of the
    // 16-line tail window — the run genuinely succeeded after retry.
    for (let i = 0; i < 20; i++) proc.feed(`doing real work line ${i}`);
    proc.exit(0);
    const all = await events;
    expect(all.at(-1).type).toBe('AgentCompleted');
  });

  it('the model merely mentioning litellm in code is not a failure', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    // A code reply talking about litellm mid-run is not an error line
    // — the tighter pattern only fires on `litellm.<…Error|Timeout>`.
    proc.feed('You can call litellm.completion(model="gpt-4o") to retry.');
    proc.feed('done');
    proc.exit(0);
    const all = await events;
    expect(all.at(-1).type).toBe('AgentCompleted');
  });

  it('an empty-string model drops the --model arg like an unset one', async () => {
    const { adapter, proc, calls } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', { ...config, model: '' });
    expect(calls[0].args.some((a) => a.startsWith('--model'))).toBe(false);
    proc.exit(0);
    await events;
  });

  it('substitutes {messageDir} for relocated provider state files', async () => {
    const { adapter, proc, calls, tempDir } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    const histIdx = calls[0].args.indexOf('--chat-history-file');
    expect(histIdx).toBeGreaterThanOrEqual(0);
    expect(calls[0].args[histIdx + 1].startsWith(tempDir)).toBe(true);
    expect(calls[0].args[histIdx + 1].endsWith('chat-history.md')).toBe(true);
    proc.exit(0);
    await events;
  });

  it('caps journaled AgentProgress and reports the omitted count honestly', async () => {
    const proc = new FakePrintRunProcess();
    const adapter = new PrintRunAdapter(null, {
      id: 'aider',
      command: 'aider',
      args: ['{messageFile}'],
      spawner: () => proc,
      tempDir: mkdtempSync(join(tmpdir(), 'prt-')),
      maxProgressEvents: 5,
    });
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    for (let i = 0; i < 10; i++) proc.feed(`line ${i}`);
    proc.exit(0);
    const all = await events;
    const progress = all.filter((e) => e.type === 'AgentProgress');
    // 5 journaled lines + 1 truncation marker — not 10.
    expect(progress).toHaveLength(6);
    expect((progress.at(-1) as { message: string }).message).toContain('counted, not journaled');
    const done = all.at(-1) as { summary: string };
    expect(done.summary).toContain('5 further output lines');
  });

  it('an ordinary run with no failure-pattern match completes on exit 0', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.feed('Aider v0.86.2');
    proc.feed('ok');
    proc.exit(0);
    const all = await events;
    expect(all.at(-1).type).toBe('AgentCompleted');
  });

  it('a synchronous spawn failure unwinds the session — the adapter can run again', async () => {
    const proc = new FakePrintRunProcess();
    let threw = false;
    const adapter = new PrintRunAdapter(null, {
      id: 'aider',
      command: 'gone-binary',
      args: ['{messageFile}'],
      spawner: () => {
        if (!threw) {
          threw = true;
          throw new Error('spawn gone-binary ENOENT');
        }
        return proc;
      },
      tempDir: mkdtempSync(join(tmpdir(), 'prt-')),
    });
    await adapter.connect();
    await expect(adapter.startRun('task-1', config)).rejects.toThrow('ENOENT');
    // Not wedged: a second run proceeds normally.
    const events = collect(adapter);
    await adapter.startRun('task-2', config);
    proc.exit(0);
    const all = await events;
    expect(all.at(-1).type).toBe('AgentCompleted');
  });

  it('an async spawn error maps to AgentFailed instead of hanging', async () => {
    const proc = new FakePrintRunProcess();
    const adapter = new PrintRunAdapter(null, {
      id: 'aider',
      command: 'aider',
      args: ['{messageFile}'],
      spawner: () => proc,
      tempDir: mkdtempSync(join(tmpdir(), 'prt-')),
    });
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.emitError?.(new Error('spawn aider ENOENT'));
    const all = await events;
    const last = all.at(-1) as { type: string; error: string };
    expect(last.type).toBe('AgentFailed');
    expect(last.error).toContain('ENOENT');
  });

  it('emits at most one terminal event', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.exit(0);
    proc.exit(0); // a second exit must not double-emit
    const all = await events;
    expect(all.filter((e) => e.type === 'AgentCompleted')).toHaveLength(1);
  });
});
