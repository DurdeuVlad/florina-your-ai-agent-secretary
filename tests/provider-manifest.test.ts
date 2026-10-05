/**
 * Provider-manifest invariants (issue #300): the manifest is the single
 * source of truth for attachment + readiness + remediation. These tests
 * pin the safety contract — adding a provider must mean one entry, and
 * the drift vectors that produced real bugs (wrong sign-in command,
 * unprobed credentials, missing installers) must fail loudly here.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROVIDER_MANIFESTS,
  perPlatform,
  providerManifest,
  providerManifestIds,
  providerTables,
  type ProviderManifest,
} from '../src/core/application/use-cases/readiness/provider-manifests.js';
import {
  providerFixIds,
  providerInstallerIds,
  type ProviderInstaller,
} from '../src/core/application/use-cases/readiness/provider-readiness.js';
import type { PerPlatform } from '../src/core/application/use-cases/readiness/provider-manifests.js';
import { attachLocalAgentProviders } from '../src/bootstrap/agent-providers.js';
import { AdapterRegistry } from '../src/adapters/outbound/agents/registry.js';
import { CLAUDE_HOOKS_ADAPTER_ID } from '../src/adapters/outbound/agents/claude-hooks-adapter.js';
import { CODEX_ADAPTER_ID } from '../src/adapters/outbound/agents/codex-adapter.js';
import { AGY_ADAPTER_ID } from '../src/adapters/outbound/agents/agy-adapter.js';

const KNOWN_ENV = { PATH: process.env['PATH'] ?? '' };

const fake: ProviderManifest = {
  id: 'testprovider',
  docsUrl: 'https://example.com/install',
  envOverride: 'FLORINA_TESTPROVIDER_CMD',
  // `node` is guaranteed on PATH in the test environment — resolution
  // exercises the real PATH lookup, not a stub.
  executable: process.platform === 'win32' ? 'node.exe' : 'node',
  transport: { kind: 'acp', args: ['acp'] },
  notFoundDetail: '`node` CLI not found on PATH',
  credentialEvidence: {
    files: ['.definitely-not-real-florina-test/creds.json'],
    envVars: ['DEFINITELY_NOT_REAL_FLORINA_TEST_KEY'],
  },
  signIn: {
    kind: 'run-command',
    label: 'Sign in to Test Provider',
    command: 'testprovider login',
    detail: 'opens a terminal running testprovider login',
  },
  installers: { win32: null, darwin: null, linux: null },
};

describe('provider manifest — id integrity', () => {
  it('manifest ids are unique — a duplicate would double-register or silently shadow', () => {
    const ids = providerManifestIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('manifest ids equal the adapter ids that can actually register', () => {
    // The adapter constants live in their adapter modules; the manifest
    // id MUST equal the adapter id or dispatch silently can't route to it.
    const adapterIds = [
      CLAUDE_HOOKS_ADAPTER_ID,
      CODEX_ADAPTER_ID,
      'gemini',
      'devin',
      AGY_ADAPTER_ID,
    ].sort();
    expect([...providerManifestIds()].sort()).toEqual(adapterIds);
  });

  it('fix-recipe ids equal manifest ids plus the synthetic chat-model row', () => {
    expect([...providerFixIds()].sort()).toEqual([...providerManifestIds(), 'chat-model'].sort());
  });

  it('derived tables key exactly on manifest ids', () => {
    const tables = providerTables(PROVIDER_MANIFESTS);
    for (const table of [tables.fixes, tables.installers, tables.credentialEvidence]) {
      expect(Object.keys(table).sort()).toEqual([...providerManifestIds()].sort());
    }
  });

  it('providerInstallerIds names only providers with at least one real installer', () => {
    for (const id of providerInstallerIds()) {
      const m = providerManifest(id);
      expect(m).toBeDefined();
      expect(Object.values(m!.installers).some((i) => i !== null && i !== undefined)).toBe(true);
    }
  });

  it('providerTables ignores duplicate ids — first wins, matching the attach loop', () => {
    // Every table output must be DISTINCT in the rival — a shallow
    // spread would copy the same refs and make toBe tautological.
    const rival: ProviderManifest = {
      ...fake,
      signIn: { kind: 'run-command', label: 'RIVAL', command: 'rival login', detail: 'd' },
      installers: { default: { label: 'r', command: 'npm i -g rival', detail: 'd' } },
      credentialEvidence: { files: ['rival/creds.json'], envVars: [] },
    };
    const tables = providerTables([fake, rival]);
    // The attached provider uses manifest #1's transport; the tables
    // must hand out #1's rows too, never a silently-overwritten mix.
    expect(tables.fixes['testprovider']).toBe(fake.signIn);
    expect(tables.installers['testprovider']).toBe(fake.installers);
    expect(tables.credentialEvidence['testprovider']).toBe(fake.credentialEvidence);
  });
});

describe('provider manifest — safety invariants', () => {
  it('every manifest carries a docsUrl audit trail (no URL, no manifest)', () => {
    for (const m of PROVIDER_MANIFESTS) {
      expect(m.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('null installer cells mean "manual instructions" — no fabricated commands', () => {
    for (const m of PROVIDER_MANIFESTS) {
      for (const installer of Object.values(m.installers)) {
        if (installer !== null && installer !== undefined) {
          // A real entry always has a runnable command and honest wording.
          expect(installer.command.length).toBeGreaterThan(0);
          expect(installer.label.length).toBeGreaterThan(0);
          expect(installer.detail.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('an explicit null cell beats default — "unverified on this OS" never falls back to a guess', () => {
    // The trap `??` would spring: win32:null is a deliberate marker,
    // not a missing key. Presence decides, not truthiness.
    const map: PerPlatform<ProviderInstaller | null> = {
      default: { label: 'L', command: 'npm i -g pkg', detail: 'd' },
      win32: null,
    };
    expect(perPlatform(map, 'win32')).toBeNull();
    expect(perPlatform(map, 'darwin')).toEqual(map.default);
    expect(perPlatform(map, 'freebsd')).toEqual(map.default);
  });

  it('manifests are deeply frozen — runtime mutation cannot desync derived tables', () => {
    expect(Object.isFrozen(PROVIDER_MANIFESTS)).toBe(true);
    for (const m of PROVIDER_MANIFESTS) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.transport)).toBe(true);
      expect(Object.isFrozen(m.credentialEvidence)).toBe(true);
      expect(Object.isFrozen(m.installers)).toBe(true);
      expect(Object.isFrozen(m.signIn)).toBe(true);
      if (m.extraCandidates) expect(Object.isFrozen(m.extraCandidates)).toBe(true);
    }
  });

  it('credential evidence is existence-metadata only — files, env names, keyring targets', () => {
    const ALLOWED_KEYS = new Set(['files', 'envVars', 'darwinKeychain', 'winCredTarget']);
    for (const m of PROVIDER_MANIFESTS) {
      const ev = m.credentialEvidence;
      for (const key of Object.keys(ev)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
      for (const f of ev.files) expect(typeof f).toBe('string');
      for (const v of ev.envVars) expect(v).toMatch(/^[A-Z][A-Z0-9_]+$/);
      // A keyring target is a name, never a secret value — bounded length.
      for (const target of [ev.darwinKeychain, ev.winCredTarget]) {
        if (target !== undefined) expect(target.length).toBeLessThan(128);
      }
    }
  });

  it('candidate specs are well-formed spawn inputs — no CWD-relative or traversal tricks', () => {
    for (const m of PROVIDER_MANIFESTS) {
      for (const [platform, specs] of Object.entries(m.extraCandidates ?? {})) {
        for (const spec of specs) {
          if (spec.kind === 'path') {
            // A 'path' spec must be anchored — a placeholder or an
            // absolute path. A bare relative path probes the daemon's
            // CWD, which is meaningless and attacker-mutable.
            expect(
              spec.path.includes('{home}') ||
                spec.path.includes('{localAppData}') ||
                spec.path.startsWith('/'),
            ).toBe(true);
            expect(spec.path).not.toContain('..');
          } else {
            // 'scan' specs: dir is a plain relative subdir (no traversal,
            // no leading separator); file names the provider's own binary.
            expect(spec.dir).not.toContain('..');
            expect(spec.dir.startsWith('/') && spec.dir.startsWith('\\')).toBe(false);
            expect(spec.file.replace(/\.(exe|cmd|bat)$/, '')).toBe(m.executable);
            // 'localAppData' is a Windows concept — a scan spec under a
            // non-Windows platform silently probes ~/AppData/Local.
            if (spec.base === 'localAppData') expect(platform).toBe('win32');
          }
        }
      }
    }
  });

  it('app-server manifests carry the {endpoint} placeholder the spawner substitutes', () => {
    for (const m of PROVIDER_MANIFESTS) {
      if (m.transport.kind === 'app-server') {
        expect(m.transport.args).toContain('{endpoint}');
        expect(m.transport.readyTimeoutMs).toBeGreaterThan(0);
      }
    }
  });

  it('transport kinds in use are exactly the set the attachment switch handles', () => {
    const KNOWN_KINDS = new Set(['hooks', 'acp', 'app-server', 'stream-json']);
    for (const m of PROVIDER_MANIFESTS) {
      expect(KNOWN_KINDS.has(m.transport.kind)).toBe(true);
    }
  });

  it('every manifest declares how its executable resolves beyond PATH or honestly does not', () => {
    for (const m of PROVIDER_MANIFESTS) {
      expect(m.executable.length).toBeGreaterThan(0);
      expect(m.envOverride).toMatch(/^FLORINA_[A-Z0-9]+_CMD$/);
      // notFoundDetail tells the user where we looked — never empty.
      expect(m.notFoundDetail.length).toBeGreaterThan(10);
      expect(m.notFoundDetail).toContain(m.executable);
    }
  });
});

describe('provider manifest — one entry is sufficient (the #300 contract)', () => {
  it('providerTables derives fixes, installers, and evidence from one entry', () => {
    const tables = providerTables([fake]);
    expect(tables.fixes['testprovider']).toBe(fake.signIn);
    expect(tables.installers['testprovider']).toBe(fake.installers);
    expect(tables.credentialEvidence['testprovider']).toBe(fake.credentialEvidence);
  });

  it('attachment resolves, registers, and reports a fake provider from its manifest alone', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: KNOWN_ENV,
      manifests: [fake],
    });
    expect(result.attached.map((p) => p.id)).toEqual(['testprovider']);
    expect(result.skipped).toEqual([]);
    expect(registry.has('testprovider')).toBe(true);
    result.dispose();
  });

  it('a manifest whose executable is absent skips with its own notFoundDetail', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: KNOWN_ENV,
      manifests: [{ ...fake, executable: 'definitely-no-such-binary-florina' }],
    });
    expect(result.attached).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'testprovider', reason: '`node` CLI not found on PATH' },
    ]);
    result.dispose();
  });

  it('a manifest with an unknown transport kind skips honestly, never silently', async () => {
    const registry = new AdapterRegistry();
    const alien = {
      ...fake,
      transport: { kind: 'telepathy' } as unknown as ProviderManifest['transport'],
    };
    const result = await attachLocalAgentProviders(registry, {
      env: KNOWN_ENV,
      manifests: [alien],
    });
    expect(result.attached).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('unsupported transport');
    result.dispose();
  });

  it('a stream-json manifest attaches through the same manifest-only path', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: KNOWN_ENV,
      manifests: [{ ...fake, transport: { kind: 'stream-json' } }],
    });
    expect(result.attached.map((p) => p.id)).toEqual(['testprovider']);
    expect(registry.has('testprovider')).toBe(true);
    result.dispose();
  });

  it('a `default` candidate applies on platforms with no specific entry (the old else)', async () => {
    // codex's pre-manifest behavior: every non-win32 platform got the
    // ~/.codex/.sandbox-bin candidate — 'freebsd' must still resolve it.
    // The file must actually exist for attach to succeed, so create it:
    // then `attached` proves `default` was consulted (a broken fallback
    // skips with notFoundDetail instead).
    const home = mkdtempSync(join(tmpdir(), 'florina-m300-'));
    const bin = join(home, '.codex', '.sandbox-bin');
    mkdirSync(bin, { recursive: true });
    const candidate = join(bin, 'codex');
    writeFileSync(candidate, '');
    const registry = new AdapterRegistry();
    const local = {
      ...fake,
      executable: 'definitely-no-such-binary-florina',
      extraCandidates: {
        default: [{ kind: 'path' as const, path: '{home}/.codex/.sandbox-bin/codex' }],
      },
    };
    const result = await attachLocalAgentProviders(registry, {
      env: KNOWN_ENV,
      platform: 'freebsd',
      homeDir: home,
      localAppData: join(home, 'ad'),
      manifests: [local],
    });
    expect(result.attached).toEqual([{ id: 'testprovider', command: candidate }]);
    expect(result.skipped).toEqual([]);
    expect(registry.has('testprovider')).toBe(true);
    result.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  it('duplicate manifest ids skip honestly instead of crashing the whole attach', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: KNOWN_ENV,
      manifests: [fake, { ...fake }],
    });
    expect(result.attached.map((p) => p.id)).toEqual(['testprovider']);
    expect(result.skipped[0]?.reason).toContain('duplicate manifest id');
    result.dispose();
  });

  it('a malformed candidate spec skips the provider, never the loop', async () => {
    const registry = new AdapterRegistry();
    const broken = {
      ...fake,
      extraCandidates: {
        win32: [{ kind: 'path', path: 42 } as unknown as never],
      },
    } as ProviderManifest;
    const result = await attachLocalAgentProviders(registry, {
      env: KNOWN_ENV,
      platform: 'win32',
      manifests: [broken],
    });
    expect(result.skipped[0]?.reason).toContain('candidates failed to resolve');
    result.dispose();
  });

  it('env override and disabled-list still apply to injected manifests', async () => {
    const registry = new AdapterRegistry();
    const result = await attachLocalAgentProviders(registry, {
      env: {
        ...KNOWN_ENV,
        FLORINA_DISABLED_PROVIDERS: 'testprovider',
      },
      manifests: [fake],
    });
    expect(result.attached).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('disabled');
    result.dispose();
  });
});

describe('provider manifest — the real registry is load-bearing', () => {
  it('every manifest executable either resolves on this machine or explains itself', () => {
    // Not an install check — a data-integrity check that the manifest's
    // own story (executable name, not-found wording, installer presence)
    // is internally consistent.
    for (const m of PROVIDER_MANIFESTS) {
      const hasInstallerSomewhere = Object.values(m.installers).some(
        (i) => i !== null && i !== undefined,
      );
      const onThisOs = m.installers[process.platform as 'win32' | 'darwin' | 'linux'];
      // If no installer exists ANYWHERE, the row must still be honest —
      // the not-found text carries the manual path.
      if (!hasInstallerSomewhere || onThisOs == null) {
        expect(m.notFoundDetail.length).toBeGreaterThan(10);
      }
    }
  });

  it('real devin executable-candidates shape matches the desktop-bundle reality', () => {
    const devin = providerManifest('devin');
    expect(devin).toBeDefined();
    const win = devin!.extraCandidates?.win32 ?? [];
    expect(
      win.some(
        (c) => c.kind === 'path' && c.path.includes('{localAppData}') && c.path.endsWith('.exe'),
      ),
    ).toBe(true);
  });

  it('codex sandbox-bin resolves on every platform incl. exotic ones (the pre-manifest else)', () => {
    const codex = providerManifest('codex');
    expect(codex).toBeDefined();
    for (const platform of ['win32', 'darwin', 'linux', 'freebsd', 'android']) {
      const candidates = perPlatform(codex!.extraCandidates, platform) ?? [];
      expect(candidates.some((c) => c.kind === 'path' && c.path.includes('.sandbox-bin'))).toBe(
        true,
      );
    }
  });

  it('manifest files list sanity — referenced evidence paths look like real paths', () => {
    for (const m of PROVIDER_MANIFESTS) {
      for (const rel of m.credentialEvidence.files) {
        // Home-relative evidence paths never start with '/' or a drive
        // letter — they're joined under the user home by the probe.
        expect(rel.startsWith('/')).toBe(false);
        expect(/^[A-Za-z]:/.test(rel)).toBe(false);
      }
    }
  });
});
