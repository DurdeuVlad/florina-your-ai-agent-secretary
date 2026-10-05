/**
 * Local agent-provider attachment — probing, registration, lifecycle.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  attachLocalAgentProviders,
  refreshSkippedProviders,
} from '../src/bootstrap/agent-providers.js';
import type { ChildProcess } from 'node:child_process';
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

  it('copilot resolves on PATH and registers its ACP adapter (#303)', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv({ PATH: fakePathDir('copilot') }),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
    });
    expect(registry.has('copilot')).toBe(true);
    expect(result.attached.find((p) => p.id === 'copilot')?.command).toContain('copilot');
    result.dispose();
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

  it('a spawn-level app-server failure (ENOENT) skips honestly instead of crashing', async () => {
    // Spawning a nonexistent binary emits 'error' on the child — without
    // a listener that becomes an uncaughtException killing the daemon.
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv({ PATH: fakePathDir('codex') }),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 8_000,
      codexSpawner: () => spawn('florina-definitely-nonexistent-binary', []),
    });
    expect(registry.has('codex')).toBe(false);
    expect(result.skipped.find((p) => p.id === 'codex')?.reason).toContain(
      'app-server failed to start',
    );
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
    for (const id of ['claude-code', 'codex', 'devin', 'gemini', 'antigravity', 'copilot']) {
      expect(
        result.skipped.find((p) => p.id === id),
        `missing skip for ${id}`,
      ).toBeTruthy();
    }
  });

  it('the agy skip reason is actionable: mentions FLORINA_AGY_CMD and that it is not IDE-bundled (issue #251)', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: baseEnv(),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 200,
      codexSpawner: () => spawn(process.execPath, ['-e', '']),
    });
    const reason = result.skipped.find((p) => p.id === 'antigravity')?.reason;
    expect(reason).toContain('FLORINA_AGY_CMD');
    expect(reason).toContain('not bundled');
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

describe('refreshSkippedProviders — re-resolve not-found skips without restart (#301)', () => {
  /** A spawner that answers the ws port from the substituted args. */
  const listeningSpawner =
    (spawned: { child?: ChildProcess }) =>
    (_command: string, args: readonly string[]): ChildProcess => {
      const port = Number(args.at(-1)!.split(':').at(-1));
      const child = spawn(
        process.execPath,
        ['-e', `require('net').createServer().listen(${port})`],
        { stdio: 'ignore' },
      );
      spawned.child = child;
      return child;
    };

  it('recovers a not-found provider the moment its binary appears', async () => {
    const dir = tmp(); // PATH dir that starts empty — "not installed yet"
    const env = baseEnv({ PATH: dir });
    const registry = new AdapterRegistry();
    const deps = { env, platform: 'win32' as const, homeDir: tmp(), localAppData: tmp() };
    const first = await attachLocalAgentProviders(registry, deps);
    expect(first.skipped.find((p) => p.id === 'gemini')?.kind).toBe('not-found');

    // `florina install gemini` completes in its own terminal — the
    // binary materializes inside a PATH dir the daemon already has.
    for (const ext of ['.cmd', '.exe', '']) writeFileSync(join(dir, 'gemini' + ext), 'x');
    const next = await refreshSkippedProviders(registry, first, deps);

    expect(registry.has('gemini')).toBe(true);
    expect(next.attached.map((p) => p.id)).toContain('gemini');
    expect(next.skipped.find((p) => p.id === 'gemini')).toBeUndefined();
    next.dispose();
  });

  it('never respawns an already-attached app-server — refresh is idempotent', async () => {
    const dir = fakePathDir('codex');
    const spawned: { child?: ChildProcess } = {};
    let spawns = 0;
    const registry = new AdapterRegistry();
    const deps = {
      env: baseEnv({ PATH: dir }),
      platform: 'win32' as const,
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 8_000,
      codexSpawner: (c: string, a: readonly string[]) => {
        spawns++;
        return listeningSpawner(spawned)(c, a);
      },
    };
    const first = await attachLocalAgentProviders(registry, deps);
    expect(registry.has('codex')).toBe(true);

    const next = await refreshSkippedProviders(registry, first, deps);
    expect(spawns).toBe(1); // the original child — refresh touched nothing
    expect(next.attached.filter((p) => p.id === 'codex')).toHaveLength(1);
    next.dispose();
  });

  it('recovers an app-server provider on refresh — spawned once, tracked for dispose', async () => {
    const dir = tmp(); // no codex binary yet
    const env = baseEnv({ PATH: dir });
    const spawned: { child?: ChildProcess } = {};
    const deps = {
      env,
      platform: 'win32' as const,
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 8_000,
      codexSpawner: listeningSpawner(spawned),
    };
    const registry = new AdapterRegistry();
    const first = await attachLocalAgentProviders(registry, deps);
    expect(first.skipped.find((p) => p.id === 'codex')?.kind).toBe('not-found');

    for (const ext of ['.cmd', '.exe', '']) writeFileSync(join(dir, 'codex' + ext), 'x');
    const next = await refreshSkippedProviders(registry, first, deps);

    expect(registry.has('codex')).toBe(true);
    expect(next.attached.find((p) => p.id === 'codex')?.detail).toMatch(/app-server ws:\/\//);
    expect(spawned.child).toBeDefined();
    next.dispose();
    // The refreshed child must be killed by the COMPOSED dispose — an
    // orphan app-server outliving the daemon is the footgun this closed.
    expect(spawned.child!.killed).toBe(true);
  });

  it('a failed refresh reports the real reason — and is not retried into a stall loop', async () => {
    const dir = tmp();
    const env = baseEnv({ PATH: dir });
    const deps = {
      env,
      platform: 'win32' as const,
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 200,
      codexSpawner: () => spawn(process.execPath, ['-e', '']),
    };
    const registry = new AdapterRegistry();
    const first = await attachLocalAgentProviders(registry, deps);
    expect(first.skipped.find((p) => p.id === 'codex')?.kind).toBe('not-found');

    for (const ext of ['.cmd', '.exe', '']) writeFileSync(join(dir, 'codex' + ext), 'x');
    const next = await refreshSkippedProviders(registry, first, deps);

    const row = next.skipped.find((p) => p.id === 'codex');
    expect(row?.kind).toBe('error');
    expect(row?.reason).toContain('app-server failed to start');
    expect(registry.has('codex')).toBe(false);

    // A subsequent refresh inside the cooldown must not re-spawn-and-stall
    // every query — 'error' skips hold their reason until retryAfter elapses.
    const third = await refreshSkippedProviders(registry, next, deps);
    expect(third.skipped.find((p) => p.id === 'codex')?.kind).toBe('error');
    expect(row?.retryAfter).toBeGreaterThan(0); // cooldown was stamped
    next.dispose();
    third.dispose();
  });

  it('an error skip heals after its cooldown — the install-window wedge (#301)', async () => {
    // The exact footgun: `florina status` lands while npm is mid-write —
    // the shim exists but the package can't serve → spawn fails → 'error'.
    // Without a retry path that wedged until daemon restart.
    const dir = tmp();
    const env = baseEnv({ PATH: dir });
    let clock = 1_000;
    const spawned: { child?: ChildProcess } = {};
    let spawns = 0;
    const deps = {
      env,
      platform: 'win32' as const,
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 8_000,
      nowMs: () => clock,
      errorRetryCooldownMs: 5_000,
      codexSpawner: (_c: string, a: readonly string[]) => {
        spawns++;
        return listeningSpawner(spawned)(_c, a);
      },
    };
    const registry = new AdapterRegistry();
    // Start attached as 'error' directly: shim present, spawn times out
    // instantly (spawner that never listens is exercised elsewhere — a
    // failing spawn here then a healing one is the wedge scenario).
    for (const ext of ['.cmd', '.exe', '']) writeFileSync(join(dir, 'codex' + ext), 'x');
    const failDeps = { ...deps, codexSpawner: () => spawn('no-such-binary-xyz', []) };
    const first = await attachLocalAgentProviders(registry, failDeps);
    expect(first.skipped.find((p) => p.id === 'codex')?.kind).toBe('error');
    expect(first.skipped.find((p) => p.id === 'codex')?.retryAfter).toBe(6_000);

    // Same instant — still cooling down, no retry.
    const cooled = await refreshSkippedProviders(registry, first, deps);
    expect(cooled).toBe(first);
    expect(spawns).toBe(0);

    // Cooldown elapsed — the install finished; retry attaches.
    clock += 5_001;
    const healed = await refreshSkippedProviders(registry, first, deps);
    expect(registry.has('codex')).toBe(true);
    expect(healed.attached.map((p) => p.id)).toContain('codex');
    expect(spawns).toBe(1);
    healed.dispose();
    expect(spawned.child!.killed).toBe(true);
  });

  it('a refresh that changes nothing returns the same object — no chain growth', async () => {
    const dir = tmp(); // gemini binary never appears
    const env = baseEnv({ PATH: dir });
    const deps = { env, platform: 'win32' as const, homeDir: tmp(), localAppData: tmp() };
    const registry = new AdapterRegistry();
    const first = await attachLocalAgentProviders(registry, deps);
    const next = await refreshSkippedProviders(registry, first, deps);
    expect(next).toBe(first); // not-found → not-found is a no-op
  });

  it('dispose after a refresh kills every child — the flat list, not a wrapper chain', async () => {
    const dir = tmp();
    const env = baseEnv({ PATH: dir });
    const first_spawned: { child?: ChildProcess } = {};
    const second_spawned: { child?: ChildProcess } = {};
    // codex attaches at startup; devin's binary appears before refresh —
    // but devin is an acp adapter (no child), so use codex twice via two
    // refreshes is impossible (registered). Instead: codex attaches on
    // refresh and a SECOND refresh no-ops — children compose flat.
    const registry = new AdapterRegistry();
    const deps = {
      env,
      platform: 'win32' as const,
      homeDir: tmp(),
      localAppData: tmp(),
      codexReadyTimeoutMs: 8_000,
      codexSpawner: listeningSpawner(first_spawned),
    };
    const first = await attachLocalAgentProviders(registry, deps);
    for (const ext of ['.cmd', '.exe', '']) writeFileSync(join(dir, 'codex' + ext), 'x');
    const next = await refreshSkippedProviders(registry, first, deps);
    expect(next.children).toHaveLength(1);
    expect(next.children[0]).toBe(first_spawned.child);
    next.dispose();
    expect(first_spawned.child!.killed).toBe(true);
    expect(second_spawned.child).toBeUndefined();
  });

  it('disabled providers are never retried — policy does not self-heal', async () => {
    const dir = fakePathDir('gemini');
    const env = baseEnv({ PATH: dir, FLORINA_DISABLED_PROVIDERS: 'gemini' });
    const deps = { env, platform: 'win32' as const, homeDir: tmp(), localAppData: tmp() };
    const registry = new AdapterRegistry();
    const first = await attachLocalAgentProviders(registry, deps);
    expect(first.skipped.find((p) => p.id === 'gemini')?.kind).toBe('disabled');

    const next = await refreshSkippedProviders(registry, first, deps);
    expect(registry.has('gemini')).toBe(false);
    expect(next.skipped.find((p) => p.id === 'gemini')?.kind).toBe('disabled');
    next.dispose();
  });

  it('a disabled-all attachment refreshes to itself unchanged', async () => {
    const registry = new AdapterRegistry();
    const first = await attachLocalAgentProviders(registry, {
      env: baseEnv({ FLORINA_PROVIDERS: 'none' }),
      platform: 'win32',
      homeDir: tmp(),
      localAppData: tmp(),
    });
    const next = await refreshSkippedProviders(registry, first, {
      env: baseEnv({ FLORINA_PROVIDERS: 'none' }),
      platform: 'win32',
    });
    expect(next).toBe(first); // nothing retryable — same object, zero work
  });
});
