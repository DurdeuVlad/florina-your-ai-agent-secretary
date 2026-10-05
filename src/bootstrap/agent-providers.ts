/**
 * Local agent-provider attachment (composition root).
 *
 * Probes the machine for installed provider CLIs and registers a factory
 * per found provider in the daemon's {@link AdapterRegistry}, so tasks can
 * route to real agents instead of only the stub. Everything a provider
 * needs — executable name, `FLORINA_*_CMD` override, beyond-PATH
 * candidates, transport strategy, "not installed" wording — comes from
 * its {@link PROVIDER_MANIFESTS} entry (issue #300): attachment is a
 * generic loop over manifests, not per-provider handwritten blocks.
 *
 *   hooks       → {@link ClaudeHooksAdapter} (claude-code, Tier B)
 *   app-server  → spawn `<exe> app-server --listen ws://127.0.0.1:<port>`
 *                 for the daemon's lifetime; {@link CodexAdapter} dials
 *                 it per run (codex, Tier A)
 *   acp         → {@link AcpAdapter} with the manifest's args
 *                 (devin `acp`, gemini `--experimental-acp`, Tier C)
 *   stream-json → {@link AgyAdapter} headless (antigravity, Tier D)
 *
 * Per-provider command overrides: `FLORINA_CLAUDE_CMD`, `FLORINA_CODEX_CMD`,
 * `FLORINA_DEVIN_CMD`, `FLORINA_GEMINI_CMD`, `FLORINA_AGY_CMD` — each
 * declared on its manifest's `envOverride`.
 * `FLORINA_PROVIDERS=none` disables attachment entirely;
 * `FLORINA_DISABLED_PROVIDERS=a,b` skips individual providers.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, normalize } from 'node:path';
import { connect as netConnect, createServer } from 'node:net';

import {
  PROVIDER_MANIFESTS,
  perPlatform,
  providerTables,
  type CredentialEvidenceSpec,
  type ExtraCandidate,
  type ProviderManifest,
} from '../core/application/use-cases/readiness/provider-manifests.js';

import type { AdapterRegistry } from '../adapters/outbound/agents/registry.js';
import { ClaudeHooksAdapter } from '../adapters/outbound/agents/claude-hooks-adapter.js';
import { CodexAdapter } from '../adapters/outbound/agents/codex-adapter.js';
import { AcpAdapter } from '../adapters/outbound/agents/acp-adapter.js';
import { AgyAdapter } from '../adapters/outbound/agents/agy-adapter.js';
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
  /** How long to wait for an app-server child to listen (ms). */
  readonly codexReadyTimeoutMs?: number;
  /** Injectable child-process spawner for app-server children (tests). */
  readonly codexSpawner?: (command: string, args: readonly string[]) => ChildProcess;
  /**
   * The manifests to attach — defaults to {@link PROVIDER_MANIFESTS}.
   * Tests inject a fake manifest to prove one entry is sufficient for
   * attachment, readiness, and remediation (the #300 contract).
   */
  readonly manifests?: readonly ProviderManifest[];
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

/**
 * Interpret a manifest's beyond-PATH candidate specs against the real
 * filesystem — `path` specs expand `{home}`/`{localAppData}` placeholders;
 * `scan` specs check `<base>/<dir>/<file>` then one level deep (versioned
 * install layouts like `%LOCALAPPDATA%/OpenAI/Codex/bin/<ver>/codex.exe`).
 */
function expandCandidates(
  specs: readonly ExtraCandidate[] | undefined,
  home: string,
  localAppData: string,
): string[] {
  if (specs === undefined) return [];
  const out: string[] = [];
  for (const spec of specs) {
    if (spec.kind === 'path') {
      // Manifest paths are '/'-joined literals — normalize so the
      // resolved command carries real platform separators. Single-pass
      // alternation: a home dir literally containing "{localAppData}"
      // must not be substituted twice.
      out.push(
        normalize(
          spec.path.replace(/\{home\}|\{localAppData\}/g, (m) =>
            m === '{home}' ? home : localAppData,
          ),
        ),
      );
      continue;
    }
    const base = spec.base === 'localAppData' ? join(localAppData, spec.dir) : join(home, spec.dir);
    if (!existsSync(base)) continue;
    const direct = join(base, spec.file);
    if (existsSync(direct)) out.push(direct);
    try {
      for (const entry of readdirSync(base)) {
        const candidate = join(base, entry, spec.file);
        if (existsSync(candidate)) out.push(candidate);
      }
    } catch {
      // ignore read errors — candidates are best-effort hints
    }
  }
  return out;
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
  // One manifest drives everything: executable resolution (env override
  // → PATH → beyond-PATH candidates), the honest not-found wording, and
  // the transport that turns a resolved command into an adapter.
  const seen = new Set<string>();
  for (const manifest of deps.manifests ?? PROVIDER_MANIFESTS) {
    const { id } = manifest;
    // A duplicated id must not reach registry.register — it throws
    // mid-loop, rejecting the whole attach and orphaning any app-server
    // child already spawned. Skip honestly instead.
    if (seen.has(id)) {
      skip(id, 'duplicate manifest id — check PROVIDER_MANIFESTS');
      continue;
    }
    seen.add(id);
    if (disabled.has(id)) {
      skip(id, 'disabled via FLORINA_DISABLED_PROVIDERS');
      continue;
    }
    let candidates: string[];
    try {
      candidates = expandCandidates(
        perPlatform(manifest.extraCandidates, platform),
        home,
        localAppData,
      );
    } catch (err) {
      // Malformed manifest data (a non-string path, a bad spec) must
      // not crash the whole attach — this provider skips honestly so
      // the others still register.
      skip(
        id,
        `manifest candidates failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const command = resolveCommand(
      manifest.envOverride,
      manifest.executable,
      candidates,
      env,
      platform,
    );
    if (command === null) {
      skip(id, manifest.notFoundDetail);
      continue;
    }
    const transport = manifest.transport;
    switch (transport.kind) {
      case 'hooks':
        registry.register(id, () => new ClaudeHooksAdapter(null, { command }));
        attached.push({ id, command });
        break;
      case 'acp':
        registry.register(
          id,
          () => new AcpAdapter(null, { id, command, args: [...transport.args] }),
        );
        attached.push({ id, command });
        break;
      case 'stream-json':
        registry.register(id, () => new AgyAdapter(null, { command }));
        attached.push({ id, command });
        break;
      case 'app-server': {
        try {
          const port = await freePort();
          const endpoint = `ws://127.0.0.1:${port}`;
          const spawner =
            deps.codexSpawner ?? ((cmd, args) => spawnCli(cmd, args, { stdio: 'ignore' }));
          const child = spawner(
            command,
            transport.args.map((a) => a.replaceAll('{endpoint}', endpoint)),
          );
          children.push(child);
          // A spawn-level failure (ENOENT on a trusted bare-name
          // override, EACCES on a non-executable candidate) arrives as
          // 'error' — unhandled it becomes an uncaughtException that
          // kills the daemon. Racing it into the wait turns it into an
          // honest fast skip instead.
          const spawnError = new Promise<never>((_, reject) => child.once('error', reject));
          await Promise.race([
            waitForPort(port, deps.codexReadyTimeoutMs ?? transport.readyTimeoutMs),
            spawnError,
          ]);
          registry.register(id, () => new CodexAdapter(null, { endpoint }));
          attached.push({ id, command, detail: `app-server ${endpoint}` });
        } catch (err) {
          skip(
            id,
            `app-server failed to start: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }
      default:
        // A transport kind this build doesn't know: skip honestly
        // rather than silently registering nothing — the provider
        // would otherwise be invisible (not attached, not skipped).
        skip(id, `unsupported transport "${(transport as { kind: string }).kind}"`);
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

/* ------------------------------------------------------------------ *
 * Credential-evidence probe (issue #294)
 * ------------------------------------------------------------------ */

/**
 * Well-known local credential evidence per provider — file paths under
 * the user home, or a provider-blessed environment variable. Presence
 * means "credentials exist on disk", never "they work": expired OAuth
 * tokens and revoked keys still satisfy this until a runtime failure
 * contradicts them (that's what `ProviderReadiness.recordFailure` is
 * for). Providers without a known evidence source return `'unknown'`.
 */
/**
 * The evidence table — derived from the provider manifests (issue
 * #300). Field docs live on `CredentialEvidenceSpec` in
 * `provider-manifests.ts`; entries describe existence probes only —
 * the probe below reads metadata (file exists? env var set? keychain/
 * Credential Manager item present?), never a credential value.
 */
const CREDENTIAL_EVIDENCE: Readonly<Record<string, CredentialEvidenceSpec>> =
  providerTables(PROVIDER_MANIFESTS).credentialEvidence;

/**
 * The readiness service's `credsProbe`: reports whether any known local
 * credential evidence exists for the provider — a credential file under
 * the user home, a provider-blessed env var, or (on macOS) a Keychain
 * item. Called lazily per query so "check again" re-reads the
 * filesystem without a daemon restart. `spawnFn`/`platform` are
 * injectable so the keychain path is testable off-darwin.
 */
export function makeCredentialProbe(
  deps: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
    spawnFn?: typeof spawnSync;
    nowMs?: () => number;
  } = {},
): (providerId: string) => 'present' | 'absent' | 'unknown' {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const platform = deps.platform ?? process.platform;
  const run = deps.spawnFn ?? spawnSync;
  const nowMs = deps.nowMs ?? Date.now;
  // The keychain call is synchronous (`security` has no async mode) and
  // blocks the daemon loop while it runs — a locked keychain can hold it
  // for the full timeout on every `query-providers`. Cache the verdict
  // briefly: a fresh sign-in can lag the user-visible "Check again" by a
  // few seconds, which beats stalling every command on the socket.
  const KEYCHAIN_TTL_MS = 5000;
  const keychainCache = new Map<string, { at: number; signal: 'present' | 'absent' | 'unknown' }>();
  const winCredCache = new Map<string, { at: number; signal: 'present' | 'absent' | 'unknown' }>();
  return (providerId) => {
    const evidence = CREDENTIAL_EVIDENCE[providerId];
    if (evidence === undefined) return 'unknown';
    for (const rel of evidence.files) {
      if (existsSync(join(home, ...rel.split('/')))) return 'present';
    }
    for (const name of evidence.envVars) {
      if (env[name] !== undefined && env[name] !== '') return 'present';
    }
    // macOS Keychain is a primary credential store for some providers —
    // file absence alone must NOT claim "not signed in" there. No `-w`:
    // existence only — the password never enters daemon memory.
    if (platform === 'darwin' && evidence.darwinKeychain !== undefined) {
      const service = evidence.darwinKeychain;
      const cached = keychainCache.get(service);
      if (cached !== undefined && nowMs() - cached.at < KEYCHAIN_TTL_MS) {
        if (cached.signal === 'present') return 'present';
      } else {
        const res = run('security', ['find-generic-password', '-s', service], {
          timeout: 1500,
          encoding: 'utf8',
        });
        if (res.status === 0) {
          keychainCache.set(service, { at: nowMs(), signal: 'present' });
          return 'present';
        }
        // `security` exits 44 for "item not found" — a definitive miss;
        // cache it too so a locked-but-empty keychain doesn't spam the
        // loop. Any other failure can't prove absence → 'unknown',
        // cached the same way.
        keychainCache.set(service, {
          at: nowMs(),
          signal: res.status === 44 ? 'absent' : 'unknown',
        });
        if (res.status === 44) {
          // Fall through to the absent check below — a definitive miss
          // means file absence is still the honest verdict.
        } else {
          return 'unknown';
        }
      }
      // Cached non-present: honor a definitive 'absent', else 'unknown'.
      const signal = keychainCache.get(service)?.signal;
      if (signal === 'unknown') return 'unknown';
    }
    // Windows Credential Manager — `cmdkey /list:<target>` exits 0 only
    // when the entry exists. Existence-only like the keychain probe;
    // brief cache for the same synchronous-block reason.
    if (platform === 'win32' && evidence.winCredTarget !== undefined) {
      const target = evidence.winCredTarget;
      const cached = winCredCache.get(target);
      if (cached !== undefined && nowMs() - cached.at < KEYCHAIN_TTL_MS) {
        if (cached.signal === 'present') return 'present';
      } else {
        const res = run('cmdkey', [`/list:${target}`], {
          timeout: 1500,
          encoding: 'utf8',
        });
        // cmdkey exits 0 for BOTH hits and misses — the stdout body is
        // the verdict: `Target:` line = present, `* NONE *` = absent.
        // Only an unparseable/failed run is 'unknown'.
        const out = String(res.stdout ?? '');
        const signal =
          res.status === 0 && /Target:/.test(out)
            ? 'present'
            : res.status === 0 && /\*\s*NONE\s*\*/.test(out)
              ? 'absent'
              : 'unknown';
        winCredCache.set(target, { at: nowMs(), signal });
        if (signal === 'present') return 'present';
        if (signal === 'unknown') return 'unknown';
      }
      const signal = winCredCache.get(target)?.signal;
      if (signal === 'unknown') return 'unknown';
    }
    // 'absent' is only honest when an evidence source was actually
    // consultable on THIS platform — files/env vars always, keychain on
    // darwin, Credential Manager on win32. A provider with no usable
    // source here (e.g. agy on Linux: keyring is libsecret there, which
    // we don't probe) must degrade to 'unknown', not falsely claim
    // "not signed in".
    const consultable =
      evidence.files.length > 0 ||
      evidence.envVars.length > 0 ||
      (platform === 'darwin' && evidence.darwinKeychain !== undefined) ||
      (platform === 'win32' && evidence.winCredTarget !== undefined);
    return consultable ? 'absent' : 'unknown';
  };
}
