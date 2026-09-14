/**
 * Local agent-provider attachment — probing, registration, lifecycle.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { attachLocalAgentProviders } from '../src/bootstrap/agent-providers.js';
import { AdapterRegistry } from '../src/adapters/outbound/agents/registry.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'florina-providers-'));

/** A directory containing fake `name` executables, used as the whole PATH. */
function fakePathDir(...names: string[]): string {
  const dir = tmp();
  for (const name of names) {
    for (const ext of ['.cmd', '.exe', '']) writeFileSync(join(dir, name + ext), 'x');
  }
  return dir;
}

const baseEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: '',
  ...over,
});

describe('attachLocalAgentProviders', () => {
  it('attaches claude-code when `claude` is on PATH', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv({ PATH: fakePathDir('claude') }),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
    });
    expect(registry.has('claude-code')).toBe(true);
    expect(result.attached.map((p) => p.id)).toContain('claude-code');
  });

  it('finds the bundled Devin CLI under LOCALAPPDATA on win32', async () => {
    const localAppData = tmp();
    const devinExe = join(
      localAppData,
      'Programs',
      'Devin',
      'resources',
      'app',
      'extensions',
      'windsurf',
      'devin',
      'bin',
      'devin.exe',
    );
    mkdirSync(join(devinExe, '..'), { recursive: true });
    writeFileSync(devinExe, 'x');
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv(),
      platform: 'win32',
      homeDir: tmp(),
      localAppData,
    });
    expect(registry.has('devin')).toBe(true);
    expect(result.attached.find((p) => p.id === 'devin')?.command).toBe(devinExe);
  });

  it('spawns a codex app-server and registers codex against its endpoint', async () => {
    const dir = fakePathDir('codex');
    const registry = new AdapterRegistry();
    let spawnedArgs: readonly string[] = [];
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv({ PATH: dir }),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 8_000,
      codexSpawner: (command, args) => {
        spawnedArgs = args;
        // Fake app-server: parse the ws port and listen on it.
        const port = Number(args.at(-1)!.split(':').at(-1));
        return spawn(process.execPath, ['-e', `require('net').createServer().listen(${port})`], {
          stdio: 'ignore',
        });
      },
    });
    expect(spawnedArgs[0]).toBe('app-server');
    expect(registry.has('codex')).toBe(true);
    const detail = result.attached.find((p) => p.id === 'codex')?.detail ?? '';
    expect(detail).toMatch(/app-server ws:\/\/127\.0\.0\.1:\d+/);
    result.dispose();
  });

  it('skips codex when the app-server never listens', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv({ PATH: fakePathDir('codex') }),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 800,
      codexSpawner: () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},2000)']),
    });
    expect(registry.has('codex')).toBe(false);
    expect(result.skipped.find((p) => p.id === 'codex')?.reason).toContain('app-server');
    result.dispose();
  });

  it('FLORINA_PROVIDERS=none attaches nothing', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv({ PATH: fakePathDir('claude', 'gemini'), FLORINA_PROVIDERS: 'none' }),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
    });
    expect(registry.list()).toEqual([]);
    expect(result.attached).toEqual([]);
  });

  it('FLORINA_DISABLED_PROVIDERS skips individual providers', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv({
        PATH: fakePathDir('claude', 'gemini'),
        FLORINA_DISABLED_PROVIDERS: 'gemini',
      }),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
    });
    expect(registry.has('claude-code')).toBe(true);
    expect(registry.has('gemini')).toBe(false);
    expect(result.skipped.find((p) => p.id === 'gemini')?.reason).toContain('disabled');
  });

  it('reports a skipped reason for every missing CLI', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv(),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 200,
      codexSpawner: () => spawn(process.execPath, ['-e', '']),
    });
    expect(registry.list()).toEqual([]);
    for (const id of ['claude-code', 'codex', 'devin', 'gemini', 'antigravity']) {
      expect(
        result.skipped.find((p) => p.id === id),
        `missing skip for ${id}`,
      ).toBeTruthy();
    }
  });

  it('a path-valued env override must exist; a bare name is trusted', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv({
        PATH: fakePathDir('claude'),
        FLORINA_CLAUDE_CMD: join(tmp(), 'nonexistent-claude.exe'),
      }),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
    });
    expect(registry.has('claude-code')).toBe(false);
    expect(result.skipped.find((p) => p.id === 'claude-code')?.reason).toContain('not found');
  });
});
