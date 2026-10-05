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
import { delimiter, isAbsolute, join, normalize } from 'node:path';
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

/**
 * Why a provider didn't attach. 'not-found' heals the moment the binary
 * appears; 'error' is transient-capable (a spawn raced an in-progress
 * install) so it retries after {@link SkippedProvider.retryAfter} cools
 * down — bounded, so it can't spin; the rest are policy or data problems
 * that stay skipped until the input changes.
 */
export type SkipKind = 'not-found' | 'disabled' | 'error' | 'unsupported-transport' | 'duplicate';

/** A provider that was not attached, with the reason. */
export interface SkippedProvider {
  readonly id: string;
  readonly reason: string;
  readonly kind: SkipKind;
  /**
   * For 'error' skips: epoch ms before which a refresh must not retry —
   * an install-window or transient spawn failure heals on a later query,
   * but not on every query.
   */
  readonly retryAfter?: number;
}

/** Result of {@link attachLocalAgentProviders}. */
export interface LocalProviderAttachment {
  readonly attached: readonly AttachedProvider[];
  readonly skipped: readonly SkippedProvider[];
  /**
   * Spawned helper children owned by this attachment (the codex
   * app-server). Composed flat across refreshes so {@link dispose} is
   * a single loop, never a wrapped-closure chain — an unbounded number
   * of refreshes can't deepen disposal (bootstrap-internal plumbing).
   */
  readonly children: readonly ChildProcess[];
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
  /** Clock for error-retry cooldown bookkeeping (tests inject a fake). */
  readonly nowMs?: () => number;
  /** Cooldown before an 'error' skip is retried (default 30s). */
  readonly errorRetryCooldownMs?: number;
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
/** Shared per-manifest attach context — initial pass and refresh. */
interface AttachCtx {
  readonly registry: AdapterRegistry;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly localAppData: string;
  readonly children: ChildProcess[];
  readonly deps: AttachProvidersDeps;
}

type AttachOutcome =
  | { readonly ok: true; readonly command: string; readonly detail?: string }
  | { readonly ok: false; readonly reason: string; readonly kind: SkipKind };

/**
 * Resolve one manifest's executable and, when found, register its
 * transport adapter. Never throws — every failure is an honest skip
 * reason so one bad manifest can't take down the rest.
 */
async function tryAttach(manifest: ProviderManifest, ctx: AttachCtx): Promise<AttachOutcome> {
  const { registry, env, platform, home, localAppData, children, deps } = ctx;
  const { id } = manifest;
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
    return {
      ok: false,
      reason: `manifest candidates failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
      kind: 'error',
    };
  }
  const command = resolveCommand(
    manifest.envOverride,
    manifest.executable,
    candidates,
    env,
    platform,
  );
  if (command === null) {
    return { ok: false, reason: manifest.notFoundDetail, kind: 'not-found' };
  }
  const transport = manifest.transport;
  switch (transport.kind) {
    case 'hooks':
      registry.register(id, () => new ClaudeHooksAdapter(null, { command }));
      return { ok: true, command };
    case 'acp':
      registry.register(id, () => new AcpAdapter(null, { id, command, args: [...transport.args] }));
      return { ok: true, command };
    case 'stream-json':
      registry.register(id, () => new AgyAdapter(null, { command }));
      return { ok: true, command };
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
        return { ok: true, command, detail: `app-server ${endpoint}` };
      } catch (err) {
        return {
          ok: false,
          reason: `app-server failed to start: ${err instanceof Error ? err.message : String(err)}`,
          kind: 'error',
        };
      }
    }
    default:
      // A transport kind this build doesn't know: skip honestly
      // rather than silently registering nothing — the provider
      // would otherwise be invisible (not attached, not skipped).
      return {
        ok: false,
        reason: `unsupported transport "${(transport as { kind: string }).kind}"`,
        kind: 'unsupported-transport',
      };
  }
}

/**
 * Re-resolve providers that can heal — 'not-found' skips retry every
 * call; 'error' skips retry only once {@link SkippedProvider.retryAfter}
 * has elapsed so a transient spawn failure (e.g. a query landing while
 * `florina install` is mid-write) recovers without spinning per query
 * (issue #301). The daemon's PATH is a startup snapshot, so manifest
 * `extraCandidates` (real-fs probes) are what let a fresh install
 * resolve before a restart.
 *
 * Disabled/duplicate/unsupported states never self-heal.
 * Already-registered ids are never re-attached, so a refresh can't
 * double-spawn an app-server child. New children compose flat into the
 * returned attachment's `children`/`dispose` — no closure wrapping.
 */
export async function refreshSkippedProviders(
  registry: AdapterRegistry,
  current: LocalProviderAttachment,
  deps: AttachProvidersDeps = {},
): Promise<LocalProviderAttachment> {
  const now = deps.nowMs ?? Date.now;
  const cooldownMs = deps.errorRetryCooldownMs ?? 30_000;
  const skippedById = new Map(current.skipped.map((s) => [s.id, s]));
  const retryable = new Set(
    current.skipped
      .filter((s) => s.kind === 'not-found' || (s.kind === 'error' && (s.retryAfter ?? 0) <= now()))
      .map((s) => s.id),
  );
  if (retryable.size === 0) return current;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.homeDir ?? homedir();
  const localAppData = deps.localAppData ?? env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
  const children: ChildProcess[] = [];
  const ctx: AttachCtx = { registry, env, platform, home, localAppData, children, deps };
  const recovered = new Map<string, AttachedProvider>();
  const updatedReasons = new Map<string, SkippedProvider>();
  for (const manifest of deps.manifests ?? PROVIDER_MANIFESTS) {
    const { id } = manifest;
    if (!retryable.has(id) || registry.has(id)) continue;
    const outcome = await tryAttach(manifest, ctx);
    if (outcome.ok) {
      recovered.set(id, {
        id,
        command: outcome.command,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
      continue;
    }
    const existing = skippedById.get(id);
    if (outcome.kind === 'error') {
      // Refresh the cooldown so consecutive errors can't spin.
      updatedReasons.set(id, {
        id,
        reason: outcome.reason,
        kind: 'error',
        retryAfter: now() + cooldownMs,
      });
    } else if (existing === undefined || existing.kind !== outcome.kind) {
      // An 'error' that now resolves nothing is honestly 'not-found'
      // again (binary vanished mid-retry); a stale 'not-found' row
      // reporting a real failure likewise updates. Identical
      // not-found → not-found results aren't recorded — no state
      // changed, and recording would defeat the no-change fast path.
      updatedReasons.set(id, { id, reason: outcome.reason, kind: outcome.kind });
    }
  }
  // Nothing healed and nothing learned — return the same object so a
  // steady stream of status queries can't grow an attachment chain.
  if (recovered.size === 0 && updatedReasons.size === 0) return current;
  const skipped = current.skipped
    .filter((s) => !recovered.has(s.id))
    .map((s) => updatedReasons.get(s.id) ?? s);
  const allChildren = [...current.children, ...children];
  return {
    attached: [...current.attached, ...recovered.values()],
    skipped,
    children: allChildren,
    dispose: () => {
      for (const child of allChildren) {
        try {
          child.kill();
        } catch {
          // best-effort — a dead child is already gone
        }
      }
    },
  };
}

export async function attachLocalAgentProviders(
  registry: AdapterRegistry,
  deps: AttachProvidersDeps = {},
): Promise<LocalProviderAttachment> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.homeDir ?? homedir();
  const localAppData = deps.localAppData ?? env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
  const now = deps.nowMs ?? Date.now;
  const cooldownMs = deps.errorRetryCooldownMs ?? 30_000;
  const attached: AttachedProvider[] = [];
  const skipped: SkippedProvider[] = [];
  const children: ChildProcess[] = [];

  if (env['FLORINA_PROVIDERS'] === 'none') {
    return {
      attached,
      skipped: [
        {
          id: 'all',
          reason: 'FLORINA_PROVIDERS=none — local provider attachment disabled',
          kind: 'disabled',
        },
      ],
      children,
      dispose: () => {},
    };
  }
  const disabled = new Set(
    (env['FLORINA_DISABLED_PROVIDERS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
  const ctx: AttachCtx = { registry, env, platform, home, localAppData, children, deps };
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
      skipped.push({
        id,
        reason: 'duplicate manifest id — check PROVIDER_MANIFESTS',
        kind: 'duplicate',
      });
      continue;
    }
    seen.add(id);
    if (disabled.has(id)) {
      skipped.push({ id, reason: 'disabled via FLORINA_DISABLED_PROVIDERS', kind: 'disabled' });
      continue;
    }
    const outcome = await tryAttach(manifest, ctx);
    if (outcome.ok) {
      attached.push({
        id,
        command: outcome.command,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
    } else {
      skipped.push({
        id,
        reason: outcome.reason,
        kind: outcome.kind,
        // Transient-capable failures (a daemon that started while an
        // install was mid-write) may retry — after a cooldown, so a
        // permanently-broken install still can't spin per query.
        ...(outcome.kind === 'error' ? { retryAfter: now() + cooldownMs } : {}),
      });
    }
  }

  return {
    attached,
    skipped,
    children,
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
    // Per the XDG spec, a non-absolute XDG_DATA_HOME must be ignored —
    // an empty or relative value would otherwise resolve CWD-relative.
    const xdgEnv = env['XDG_DATA_HOME'];
    const xdgBase =
      xdgEnv !== undefined && xdgEnv !== '' && isAbsolute(xdgEnv)
        ? xdgEnv
        : join(home, '.local', 'share');
    for (const rel of evidence.xdgDataFiles ?? []) {
      if (existsSync(join(xdgBase, ...rel.split('/')))) return 'present';
    }
    for (const name of evidence.envVars) {
      if (env[name] !== undefined && env[name] !== '') return 'present';
    }
    // macOS Keychain is a primary credential store for some providers —
    // file absence alone must NOT claim "not signed in" there. No `-w`:
    // existence only — the password never enters daemon memory.
    if (platform === 'darwin' && evidence.darwinKeychain !== undefined) {
      const service = evidence.darwinKeychain;
      const account = evidence.darwinKeychainAccount;
      // Cache key must keep the two fields unambiguously separate —
      // 'a b'/undefined vs 'a'/'b' would otherwise collide.
      const cacheKey = JSON.stringify([service, account ?? null]);
      const cached = keychainCache.get(cacheKey);
      if (cached !== undefined && nowMs() - cached.at < KEYCHAIN_TTL_MS) {
        if (cached.signal === 'present') return 'present';
      } else {
        const args = ['find-generic-password', '-s', service];
        if (account !== undefined) args.push('-a', account);
        const res = run('security', args, {
          timeout: 1500,
          encoding: 'utf8',
        });
        if (res.status === 0) {
          keychainCache.set(cacheKey, { at: nowMs(), signal: 'present' });
          return 'present';
        }
        // `security` exits 44 for "item not found" — a definitive miss;
        // cache it too so a locked-but-empty keychain doesn't spam the
        // loop. Any other failure can't prove absence → 'unknown',
        // cached the same way.
        keychainCache.set(cacheKey, {
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
      const signal = keychainCache.get(cacheKey)?.signal;
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
    // 'absent' is only honest when every credential store the provider
    // can use on THIS platform was consulted — files/env vars always,
    // keychain on darwin, Credential Manager on win32. A provider whose
    // primary store is unprobeable here (agy on Linux: Secret Service
    // via D-Bus has no service-name lookup CLI) must degrade to
    // 'unknown', not falsely claim "not signed in" — though a fallback
    // file/env hit above already returned 'present'.
    const unprobeableHere = evidence.unprobeablePlatforms?.includes(platform) === true;
    const consultable =
      !unprobeableHere &&
      (evidence.files.length > 0 ||
        (evidence.xdgDataFiles?.length ?? 0) > 0 ||
        evidence.envVars.length > 0 ||
        (platform === 'darwin' && evidence.darwinKeychain !== undefined) ||
        (platform === 'win32' && evidence.winCredTarget !== undefined));
    return consultable ? 'absent' : 'unknown';
  };
}
