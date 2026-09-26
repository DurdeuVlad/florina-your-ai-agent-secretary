/**
 * Local agent-provider attachment (composition root).
 *
 * Probes the machine for installed provider CLIs and registers a factory
 * per found provider in the daemon's {@link AdapterRegistry}, so tasks can
 * route to real agents instead of only the stub:
 *
 *   claude-code — `claude` on PATH → {@link ClaudeHooksAdapter} (Tier B)
 *   codex       — `codex` on PATH or `~/.codex/.sandbox-bin/codex.exe`;
 *                 a `codex app-server --listen ws://127.0.0.1:<port>`
 *                 child is spawned for the daemon's lifetime and the
 *                 {@link CodexAdapter} dials it per run (Tier A)
 *   devin       — `devin` on PATH or the Devin desktop app's bundled CLI
 *                 → {@link AcpAdapter} in `devin acp` mode (Tier C)
 *   gemini      — `gemini` on PATH → {@link AcpAdapter} `--acp` (Tier C)
 *   antigravity — `agy` on PATH → {@link AgyAdapter} headless (Tier D)
 *
 * Per-provider command overrides: `FLORINA_CLAUDE_CMD`, `FLORINA_CODEX_CMD`,
 * `FLORINA_DEVIN_CMD`, `FLORINA_GEMINI_CMD`, `FLORINA_AGY_CMD`.
 * `FLORINA_PROVIDERS=none` disables attachment entirely;
 * `FLORINA_DISABLED_PROVIDERS=a,b` skips individual providers.
 */
import { type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { connect as netConnect, createServer } from 'node:net';

import type { AdapterRegistry } from '../adapters/outbound/agents/registry.js';
import {
  ClaudeHooksAdapter,
  CLAUDE_HOOKS_ADAPTER_ID,
} from '../adapters/outbound/agents/claude-hooks-adapter.js';
import { CodexAdapter, CODEX_ADAPTER_ID } from '../adapters/outbound/agents/codex-adapter.js';
import { AcpAdapter } from '../adapters/outbound/agents/acp-adapter.js';
import { AgyAdapter, AGY_ADAPTER_ID } from '../adapters/outbound/agents/agy-adapter.js';
import { spawnCli } from '../adapters/outbound/agents/spawn-cli.js';

/** A provider whose CLI was found and registered. */
export interface AttachedProvider {
  /** Adapter id registered in the registry. */
  readonly id: string;
  /** Resolved executable path/command. */
  readonly command: string;
  /** Extra detail (e.g. the codex app-server endpoint). */
  readonly detail?: string;
}

/** A provider that was not attached, with the reason. */
export interface SkippedProvider {
  readonly id: string;
  readonly reason: string;
}

/** Result of {@link attachLocalAgentProviders}. */
export interface LocalProviderAttachment {
  readonly attached: readonly AttachedProvider[];
  readonly skipped: readonly SkippedProvider[];
  /** Kill spawned helper processes (e.g. the codex app-server). */
  dispose(): void;
}

/** Injectable seams for tests. */
export interface AttachProvidersDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly localAppData?: string;
  readonly platform?: NodeJS.Platform;
  /** How long to wait for the codex app-server to listen (ms). */
  readonly codexReadyTimeoutMs?: number;
  /** Injectable child-process spawner for the codex app-server (tests). */
  readonly codexSpawner?: (command: string, args: readonly string[]) => ChildProcess;
}

const WIN_EXTS = ['.cmd', '.exe', '.bat', ''];

function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const exts = platform === 'win32' ? WIN_EXTS : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve a provider's executable: env override → PATH → known install dirs. */
function resolveCommand(
  envVar: string,
  pathName: string,
  extraCandidates: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const override = env[envVar];
  if (override !== undefined && override !== '') {
    // A path must exist; a bare command name is trusted to spawn (PATH
    // resolution happens at exec time).
    const looksLikePath =
      override.includes('/') || override.includes('\\') || override.endsWith('.exe');
    return looksLikePath && !existsSync(override) ? null : override;
  }
  const onPath = findOnPath(pathName, env, platform);
  if (onPath !== null) return onPath;
  for (const candidate of extraCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findCodexWindowsCandidates(localAppData: string, home: string): string[] {
  const candidates: string[] = [join(home, '.codex', '.sandbox-bin', 'codex.exe')];
  const base = join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (existsSync(base)) {
    try {
      for (const entry of readdirSync(base)) {
        const candidate = join(base, entry, 'codex.exe');
        if (existsSync(candidate)) candidates.push(candidate);
      }
    } catch {
      // ignore read errors
    }
  }
  return candidates;
}

/** A free localhost TCP port for the codex app-server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('no ephemeral port'));
      });
    });
  });
}

/** Poll until `port` accepts a TCP connection or `timeoutMs` elapses. */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const sock = netConnect({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) reject(new Error(`port ${port} never listened`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/**
 * Probe installed provider CLIs and register their adapters. Returns what
 * attached and what was skipped so the caller can surface it (the fleet
 * view lists registered adapter ids).
 */
export async function attachLocalAgentProviders(
  registry: AdapterRegistry,
  deps: AttachProvidersDeps = {},
): Promise<LocalProviderAttachment> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.homeDir ?? homedir();
  const localAppData = deps.localAppData ?? env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
  const attached: AttachedProvider[] = [];
  const skipped: SkippedProvider[] = [];
  const children: ChildProcess[] = [];

  if (env['FLORINA_PROVIDERS'] === 'none') {
    return {
      attached,
      skipped: [
        { id: 'all', reason: 'FLORINA_PROVIDERS=none — local provider attachment disabled' },
      ],
      dispose: () => {},
    };
  }
  const disabled = new Set(
    (env['FLORINA_DISABLED_PROVIDERS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
  const skip = (id: string, reason: string): void => {
    skipped.push({ id, reason });
  };
  const disabledReason = (id: string): string | null =>
    disabled.has(id) ? 'disabled via FLORINA_DISABLED_PROVIDERS' : null;

  // --- claude-code — hooks adapter (Tier B) ---
  {
    const id = CLAUDE_HOOKS_ADAPTER_ID;
    const d = disabledReason(id);
    const command =
      d === null ? resolveCommand('FLORINA_CLAUDE_CMD', 'claude', [], env, platform) : null;
    if (d !== null) skip(id, d);
    else if (command === null) skip(id, '`claude` CLI not found on PATH');
    else {
      registry.register(id, () => new ClaudeHooksAdapter(null, { command }));
      attached.push({ id, command });
    }
  }

  // --- codex — app-server over WebSocket (Tier A) ---
  {
    const id = CODEX_ADAPTER_ID;
    const d = disabledReason(id);
    const command =
      d === null
        ? resolveCommand(
            'FLORINA_CODEX_CMD',
            'codex',
            platform === 'win32'
              ? findCodexWindowsCandidates(localAppData, home)
              : [join(home, '.codex', '.sandbox-bin', 'codex')],
            env,
            platform,
          )
        : null;
    if (d !== null) {
      skip(id, d);
    } else if (command === null) {
      skip(id, '`codex` CLI not found (PATH, ~/.codex/.sandbox-bin, or LocalAppData/OpenAI/Codex)');
    } else {
      try {
        const port = await freePort();
        const endpoint = `ws://127.0.0.1:${port}`;
        const spawner =
          deps.codexSpawner ?? ((cmd, args) => spawnCli(cmd, args, { stdio: 'ignore' }));
        const child = spawner(command, ['app-server', '--listen', endpoint]);
        children.push(child);
        await waitForPort(port, deps.codexReadyTimeoutMs ?? 8_000);
        registry.register(id, () => new CodexAdapter(null, { endpoint }));
        attached.push({ id, command, detail: `app-server ${endpoint}` });
      } catch (err) {
        skip(id, `app-server failed to start: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- devin — Devin CLI in ACP mode (Tier C) ---
  {
    const id = 'devin';
    const d = disabledReason(id);
    const bundled =
      platform === 'win32'
        ? [
            join(
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
            ),
          ]
        : platform === 'darwin'
          ? ['/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin']
          : [];
    const command =
      d === null ? resolveCommand('FLORINA_DEVIN_CMD', 'devin', bundled, env, platform) : null;
    if (d !== null) skip(id, d);
    else if (command === null) skip(id, '`devin` CLI not found (PATH or Devin app bundle)');
    else {
      registry.register(id, () => new AcpAdapter(null, { id, command, args: ['acp'] }));
      attached.push({ id, command });
    }
  }

  // --- gemini — Gemini CLI in ACP mode (Tier C) ---
  {
    const id = 'gemini';
    const d = disabledReason(id);
    const command =
      d === null ? resolveCommand('FLORINA_GEMINI_CMD', 'gemini', [], env, platform) : null;
    if (d !== null) skip(id, d);
    else if (command === null) skip(id, '`gemini` CLI not found on PATH');
    else {
      registry.register(
        id,
        () => new AcpAdapter(null, { id, command, args: ['--experimental-acp'] }),
      );
      attached.push({ id, command });
    }
  }

  // --- antigravity — `agy` headless stream-json (Tier D) ---
  {
    const id = AGY_ADAPTER_ID;
    const d = disabledReason(id);
    const command = d === null ? resolveCommand('FLORINA_AGY_CMD', 'agy', [], env, platform) : null;
    if (d !== null) skip(id, d);
    else if (command === null) {
      skip(
        id,
        '`agy` headless CLI not found on PATH. It is a standalone CLI install, not bundled ' +
          'inside the Antigravity IDE app folder. Once installed, either put it on PATH or ' +
          'set FLORINA_AGY_CMD to its path.',
      );
    } else {
      registry.register(id, () => new AgyAdapter(null, { command }));
      attached.push({ id, command });
    }
  }

  return {
    attached,
    skipped,
    dispose: () => {
      for (const child of children) {
        try {
          child.kill();
        } catch {
          // Already dead.
        }
      }
    },
  };
}
