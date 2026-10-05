/**
 * Provider readiness (issue #294): auth-state derivation, runtime
 * failure classification, attention-card dedup, the additive
 * `query-providers` fields, the `signin-provider` remediation command,
 * and a real-daemon WS round-trip proving a forced auth failure lands
 * as state + inbox card.
 *
 * Boundaries: the core service/classifier are exercised pure (no fs);
 * the credential probe is verified separately through its injected
 * seam. The daemon tests run a real FlorinaDaemon over WebSocket —
 * no mocks on the wire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { WebSocket } from 'ws';

import {
  ProviderReadiness,
  classifyFailureText,
  providerFixIds,
  providerInstaller,
  providerInstallerIds,
} from '../src/core/application/use-cases/readiness/provider-readiness.js';
import {
  AGY_ADAPTER_ID,
  CLAUDE_HOOKS_ADAPTER_ID,
  CODEX_ADAPTER_ID,
} from '../src/adapters/outbound/agents/index.js';
import { providerManifestIds } from '../src/core/application/use-cases/readiness/provider-manifests.js';
import { makeCredentialProbe } from '../src/bootstrap/agent-providers.js';
import { AttentionInbox } from '../src/attention/attention-inbox.js';
import { AttentionAggregator } from '../src/attention/attention-aggregator.js';
import { EventBus } from '../src/daemon/event-stream.js';
import { CommandApi } from '../src/daemon/command-api.js';
import type {
  CommandApiDeps,
  InboxResponse,
  ProvidersResponse,
  SigninProviderResponse,
  InstallProviderResponse,
  TaskStore,
  SessionStore,
  Response,
  Command,
} from '../src/daemon/command-api.js';
import { MetricsCollector } from '../src/daemon/metrics.js';
import { TaskStateMachine } from '../src/daemon/task-lifecycle.js';
import { SessionManager } from '../src/core/application/use-cases/tasks/session-manager.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  SessionRepository,
  ProjectRepository,
} from '../src/storage/index.js';
import { buildProject, buildTask } from '../src/domain/index.js';
import type { Task } from '../src/domain/types.js';
import { FlorinaDaemon } from '../src/daemon/index.js';
import type { AgentRuntimePort } from '../src/core/application/ports/outbound/agent-runtime.js';
import { runCli } from '../src/adapters/inbound/cli/cli.js';
import type { CliDependencies } from '../src/adapters/inbound/cli/deps.js';
import { renderSetupView } from '../src/adapters/inbound/desktop/views/setup-view.js';
import type { SetupViewInput } from '../src/adapters/inbound/desktop/views/setup-view.js';
import { renderInboxItem } from '../src/adapters/inbound/desktop/views/inbox-templates.js';
import {
  KIND_METADATA,
  PRIORITY_METADATA,
} from '../src/adapters/inbound/desktop/views/inbox-view.js';
import type { RenderTree } from '../src/adapters/inbound/desktop/views/view-types.js';
import type { AttentionItemView } from '../src/adapters/inbound/desktop/views/view-types.js';

/* ================================================================== *
 * classifyFailureText — the classification matrix
 * ================================================================== */

describe('classifyFailureText (#294)', () => {
  it.each([
    ['LiteLLM responded 401 Unauthorized', 'auth'],
    ['HTTP 403 Forbidden from model endpoint', 'auth'],
    ['Error: OAuth access token is invalid — please run /login', 'auth'],
    ['Incorrect API key provided: sk-…redacted', 'auth'],
    ['authentication failed for provider', 'auth'],
    ['please sign in to continue', 'auth'],
    ['your session token expired', 'auth'],
  ])('auth class: %s', (text, expected) => {
    expect(classifyFailureText(text)).toBe(expected);
  });

  it.each([
    ['Error: required environment variable GOOGLE_CLOUD_PROJECT is not set', 'config'],
    ['no project id configured for code assist', 'config'],
  ])('config class: %s', (text, expected) => {
    expect(classifyFailureText(text)).toBe(expected);
  });

  it.each([
    ['connect ECONNREFUSED 127.0.0.1:443', 'network'],
    ['fetch failed: ENOTFOUND api.example.com', 'network'],
    ['request timed out after 30s', 'network'],
  ])('network class: %s', (text, expected) => {
    expect(classifyFailureText(text)).toBe(expected);
  });

  it.each([
    ['429 Too Many Requests', 'quota'],
    ['rate limit exceeded — retry after 60s', 'quota'],
    // OpenAI's real 429 wording — the commonest quota failure on the
    // chat-model path must not fall through to 'unknown'.
    ['You exceeded your current quota, please check your plan and billing details', 'quota'],
    ['LiteLLM error: insufficient_quota for this key', 'quota'],
  ])('quota class: %s', (text, expected) => {
    expect(classifyFailureText(text)).toBe(expected);
  });

  it.each([
    ['spawn claude ENOENT', 'missing'],
    ['claude: command not found', 'missing'],
  ])('missing class: %s', (text, expected) => {
    expect(classifyFailureText(text)).toBe(expected);
  });

  it('ambiguous errors classify honestly as unknown — never guessed as auth', () => {
    expect(classifyFailureText('segmentation fault')).toBe('unknown');
    expect(classifyFailureText('the task blew up')).toBe('unknown');
  });
});

/* ================================================================== *
 * ProviderReadiness — state derivation
 * ================================================================== */

describe('ProviderReadiness (#294)', () => {
  it('derives signed-in when credential evidence exists and nothing contradicts it', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'present' });
    expect(r.authStateOf('claude-code')).toBe('signed-in');
  });

  it('derives found-not-signed-in when the provider has a known cred path and it is empty', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'absent' });
    expect(r.authStateOf('codex')).toBe('found-not-signed-in');
  });

  it('derives unknown when there is no evidence source at all', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'unknown' });
    expect(r.authStateOf('antigravity')).toBe('unknown');
  });

  it('derives unknown (not absent) when no probe is wired at all', () => {
    const r = new ProviderReadiness();
    expect(r.authStateOf('claude-code')).toBe('unknown');
  });

  it('an auth-class failure marks the provider auth-failing and fires onAuthIssue once', () => {
    const issues: string[] = [];
    const r = new ProviderReadiness({
      credsProbe: () => 'present',
      onAuthIssue: (i) => issues.push(i.providerId),
    });
    const cls = r.recordFailure('codex', 'HTTP 401: token expired');
    expect(cls).toBe('auth');
    expect(r.authStateOf('codex')).toBe('auth-failing');
    expect(r.lastFailure('codex')?.failureClass).toBe('auth');
    expect(issues).toEqual(['codex']);
    // The fix recipe travels with the issue so the card can act on it.
  });

  it('a config-class failure surfaces auth-failing with a set-env fix naming the var', () => {
    const issues: { providerId: string; failureClass: string; fix?: unknown }[] = [];
    const r = new ProviderReadiness({
      onAuthIssue: (i) =>
        issues.push({ providerId: i.providerId, failureClass: i.failureClass, fix: i.fix }),
    });
    const cls = r.recordFailure(
      'gemini',
      'Error: required environment variable GOOGLE_CLOUD_PROJECT is not set',
    );
    expect(cls).toBe('config');
    expect(r.authStateOf('gemini')).toBe('auth-failing');
    expect(issues).toHaveLength(1);
    // Config remediation is "set the env var", not "run the sign-in
    // command" — bare `gemini` can't fix a missing project id.
    expect(issues[0].fix).toMatchObject({
      kind: 'set-env',
      command: 'GOOGLE_CLOUD_PROJECT',
    });
  });

  it('env-var extraction anchors on missing-var context — never grabs ERROR/HTTP', () => {
    const r = new ProviderReadiness({});
    // Severity/protocol words are all-caps too — the extractor must
    // pick the variable that is actually described as missing.
    expect(r.fixFor('gemini', 'config', 'ERROR: GOOGLE_CLOUD_PROJECT is not set')).toMatchObject({
      kind: 'set-env',
      command: 'GOOGLE_CLOUD_PROJECT',
    });
    expect(
      r.fixFor('gemini', 'config', 'HTTP 400: environment variable FOO_SERVICE_TOKEN missing'),
    ).toMatchObject({ kind: 'set-env', command: 'FOO_SERVICE_TOKEN' });
    // No extractable var → still a set-env recipe (generic), NEVER the
    // sign-in command — a missing env var isn't fixed by logging in.
    const generic = r.fixFor('gemini', 'config', 'project id is wrong somewhere');
    expect(generic?.kind).toBe('set-env');
    expect(generic?.label).not.toContain('Sign in');
  });

  it('network/quota/missing failures do NOT mark auth-failing and do not raise issues', () => {
    const onIssue = vi.fn();
    const r = new ProviderReadiness({ credsProbe: () => 'present', onAuthIssue: onIssue });
    r.recordFailure('codex', 'connect ECONNREFUSED 10.0.0.1:443');
    expect(r.authStateOf('codex')).toBe('unknown'); // failure trumps creds, but isn't auth
    r.recordFailure('codex', '429 rate limit exceeded');
    r.recordFailure('codex', 'spawn codex ENOENT');
    expect(onIssue).not.toHaveBeenCalled();
  });

  it('a recorded success clears auth-failing and re-derives from the probe', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'present' });
    r.recordFailure('claude-code', 'oauth token invalid');
    expect(r.authStateOf('claude-code')).toBe('auth-failing');
    r.recordSuccess('claude-code');
    expect(r.authStateOf('claude-code')).toBe('signed-in');
    expect(r.hasSucceeded('claude-code')).toBe(true);
  });

  it('a failure recorded after a success masks the stale success', () => {
    let t = 1000;
    const r = new ProviderReadiness({ credsProbe: () => 'present', now: () => t });
    r.recordSuccess('codex');
    t += 100;
    r.recordFailure('codex', '401 unauthorized');
    expect(r.hasSucceeded('codex')).toBe(false);
    expect(r.authStateOf('codex')).toBe('auth-failing');
  });

  it('re-probes lazily on every read — a fresh sign-in is seen without restart', () => {
    let signal: 'absent' | 'present' = 'absent';
    const probe = vi.fn(() => signal);
    const r = new ProviderReadiness({ credsProbe: probe });
    expect(r.authStateOf('codex')).toBe('found-not-signed-in');
    signal = 'present';
    expect(r.authStateOf('codex')).toBe('signed-in');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('observes AgentFailed events on the bus and clears on AgentStarted', () => {
    const bus = new EventBus();
    const r = new ProviderReadiness({ credsProbe: () => 'present', bus });
    r.start();
    const base = { timestamp: 't', taskId: 't1', sessionId: 's1', agentId: 'codex' };
    bus.publish({
      ...base,
      type: 'AgentFailed',
      error: 'OAuth token is invalid',
      recoverable: true,
    });
    expect(r.authStateOf('codex')).toBe('auth-failing');
    bus.publish({ ...base, type: 'AgentStarted', adapterFidelityTier: 'A' });
    expect(r.authStateOf('codex')).toBe('signed-in');
    r.stop();
  });

  it('never exposes secret-looking detail — key fragments are redacted', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'present' });
    r.recordFailure('chat-model', 'LiteLLM 401: rejected key sk-abcdefghij1234567890');
    expect(r.lastFailure('chat-model')?.detail).not.toContain('sk-abcdefghij1234567890');
    expect(r.lastFailure('chat-model')?.detail).toContain('sk-…');
  });

  it('a throwing onAuthIssue sink cannot break the failure path', () => {
    const r = new ProviderReadiness({
      onAuthIssue: () => {
        throw new Error('inbox exploded');
      },
    });
    expect(() => r.recordFailure('codex', '401')).not.toThrow();
    expect(r.authStateOf('codex')).toBe('auth-failing');
  });

  it('ignores observed-provenance events — provider-native activity is not evidence', () => {
    const bus = new EventBus();
    const r = new ProviderReadiness({ credsProbe: () => 'present', bus });
    r.start();
    bus.publish({
      type: 'AgentFailed',
      timestamp: 't',
      taskId: 't1',
      sessionId: 's1',
      agentId: 'codex',
      error: 'oauth token invalid',
      recoverable: true,
      provenance: 'observed',
    });
    // Same boundary the aggregator keeps: observed events never feed state.
    expect(r.authStateOf('codex')).toBe('signed-in');
    r.stop();
  });

  it('every FIXES key is a real provider/adapter id — no dead remediation', () => {
    // Cross-check the FIXES table against the actual adapter-id
    // constants — a recipe keyed to a wrong id silently dead-ends every
    // surface (the 'agy'→'antigravity' bug). Importing the constants
    // means this test fails the moment an id is renamed, instead of
    // drifting alongside a hardcoded list.
    const r = new ProviderReadiness();
    const realIds = [
      CLAUDE_HOOKS_ADAPTER_ID,
      CODEX_ADAPTER_ID,
      AGY_ADAPTER_ID,
      'devin', // acp-adapter id
      'gemini', // acp-adapter id
      'copilot', // acp-adapter id
    ];
    // Every FIXES key must be a real registered id or the synthetic
    // 'chat-model' row — no orphan recipes.
    for (const id of providerFixIds()) {
      expect([...realIds, 'chat-model']).toContain(id);
    }
    // And every user-facing provider id must have a recipe.
    for (const id of [...realIds, 'chat-model']) {
      expect(r.fixFor(id), `missing fix recipe for ${id}`).toBeDefined();
    }
    expect(r.fixFor('agy')).toBeUndefined(); // binary name ≠ adapter id
  });

  it('every INSTALLERS key is a real adapter id, and installer commands are verified-official only', () => {
    const realIds = [
      CLAUDE_HOOKS_ADAPTER_ID,
      CODEX_ADAPTER_ID,
      AGY_ADAPTER_ID,
      'devin',
      'gemini',
      'copilot',
    ];
    for (const id of providerInstallerIds()) {
      expect(realIds, `installer recipe for unknown provider ${id}`).toContain(id);
    }
    // No installer for 'chat-model' — the model needs a key, not a CLI.
    expect(providerInstaller('chat-model', 'win32')).toBeNull();
    // npm installs resolve on all three platforms; the script installers
    // are docs-verified per platform (#302) — `curl | bash` on unix,
    // powershell on Windows.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(providerInstaller('codex', platform)?.command).toBe('npm i -g @openai/codex');
    }
    expect(providerInstaller('devin', 'linux')?.command).toBe(
      'curl -fsSL https://cli.devin.ai/install.sh | bash',
    );
    expect(providerInstaller('devin', 'darwin')?.command).toBe(
      'curl -fsSL https://cli.devin.ai/install.sh | bash',
    );
    expect(providerInstaller('devin', 'win32')?.command).toContain('static.devin.ai');
    expect(providerInstaller('antigravity', 'win32')?.command).toContain('antigravity.google');
    expect(providerInstaller('antigravity', 'darwin')?.command).toBe(
      'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    );
    expect(providerInstaller('antigravity', 'linux')?.command).toBe(
      'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    );
    // An id nobody knows gets nothing — no orphan recipes, no guesses.
    expect(providerInstaller('not-a-provider', 'win32')).toBeNull();
  });

  it('the full provider×platform installer matrix is pinned — no cell drops silently (#302)', () => {
    // Snapshot every cell: a future edit that changes or drops a
    // platform coverage fails loudly here. `null` = deliberate manual-
    // instructions cell; a string = a docs-verified command.
    const matrix = Object.fromEntries(
      providerManifestIds().map((id) => [
        id,
        (['win32', 'darwin', 'linux'] as const).map(
          (p) => providerInstaller(id, p)?.command ?? null,
        ),
      ]),
    );
    expect(matrix).toEqual({
      'claude-code': [
        'npm i -g @anthropic-ai/claude-code',
        'npm i -g @anthropic-ai/claude-code',
        'npm i -g @anthropic-ai/claude-code',
      ],
      codex: ['npm i -g @openai/codex', 'npm i -g @openai/codex', 'npm i -g @openai/codex'],
      gemini: [
        'npm i -g @google/gemini-cli',
        'npm i -g @google/gemini-cli',
        'npm i -g @google/gemini-cli',
      ],
      devin: [
        'powershell -NoProfile -Command "irm https://static.devin.ai/cli/setup.ps1 | iex"',
        'curl -fsSL https://cli.devin.ai/install.sh | bash',
        'curl -fsSL https://cli.devin.ai/install.sh | bash',
      ],
      antigravity: [
        'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"',
        'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      ],
      copilot: ['npm i -g @github/copilot', 'npm i -g @github/copilot', 'npm i -g @github/copilot'],
    });
  });

  it('sanitize redacts non-sk- credential shapes and control chars', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'present' });
    r.recordFailure(
      'chat-model',
      '401 — key AIzaSyD4exampleKey1234567890abcde rejected; url: https://x?key=AIzaSyD4exampleKey1234567890abcde',
    );
    const detail = r.lastFailure('chat-model')?.detail ?? '';
    expect(detail).not.toContain('AIzaSyD4exampleKey1234567890abcde');
    r.recordFailure('chat-model', 'token ghp_abcdefghijklmnop1234 expired');
    expect(r.lastFailure('chat-model')?.detail).not.toContain('ghp_abcdefghijklmnop1234');
    r.recordFailure('chat-model', 'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef rejected');
    expect(r.lastFailure('chat-model')?.detail).not.toContain('eyJzdWIiOiIxIn0');
    // ANSI/control injection into terminal output is stripped.
    r.recordFailure('chat-model', 'bad \u001b[31mAUTH\u001b[0m failed');
    const d2 = r.lastFailure('chat-model')?.detail ?? '';
    expect(d2).not.toContain('\u001b');
    expect(d2).toContain('AUTH');
  });

  it('sanitize covers name=value secrets, auth schemes, PEM bodies, underscore tokens', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'present' });
    const cases: [string, string][] = [
      // [input fragment that must NOT survive, probe assertion text]
      ['refresh_token=rt_abc123def4567890', 'rt_abc123def4567890'],
      ['client_secret: cs-9988776655', 'cs-9988776655'],
      ['password=hunter2x', 'hunter2x'],
      ['session=sess_aabbccdd1122', 'sess_aabbccdd1122'],
      ['aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
      ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
      ['sk_live_51JxyzQwErTyUiOp1234', '51JxyzQwErTyUiOp1234'],
      ['xapi_key_conf=deadbeefcafe', 'deadbeefcafe'],
    ];
    for (const [input, mustNotLeak] of cases) {
      r.recordFailure('chat-model', `oops ${input} bye`);
      const detail = r.lastFailure('chat-model')?.detail ?? '';
      expect(detail, `leaked in ${JSON.stringify(input)}`).not.toContain(mustNotLeak);
    }
    // PEM bodies collapse — nothing between the BEGIN/END markers stays.
    r.recordFailure(
      'chat-model',
      'bad cert -----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQE\n-----END PRIVATE KEY----- end',
    );
    const pem = r.lastFailure('chat-model')?.detail ?? '';
    expect(pem).not.toContain('MIIEvgIBADANBgkqhkiG9w0BAQE');
    // A secret split by a control byte is still caught — controls are
    // stripped BEFORE the token patterns run.
    r.recordFailure('chat-model', 'token sk-live\u0000_abcdef1234567890');
    expect(r.lastFailure('chat-model')?.detail ?? '').not.toContain('abcdef1234567890');
  });

  it('sanitize: `:`-separated values never leak past a `=` inside the value', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'present' });
    // The separator search must find the ':' before the value's own '='.
    r.recordFailure('chat-model', 'oops client_secret: abc123== bye');
    expect(r.lastFailure('chat-model')?.detail ?? '').not.toContain('abc123');
  });

  it('sanitize: quoted and JSON-shaped secrets cannot evade name=value', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'present' });
    for (const shape of [
      'api_key="secretvalue123"',
      'token: "secretvalue123"',
      '{"api_key":"secretvalue123"}',
      "{'password': 'secretvalue123'}",
      'aws4-hmac-sha256 credential=AKIAIOSFODNN7EXAMPLE',
      // looser vocab: pass/pwd/auth/passphrase/mysql/redis shapes.
      'db_pass=hunter2secret',
      'requirepass=redissecret99',
      'auth=bearersecretvalue',
      "password = 'correct horse battery staple'",
      // URL userinfo credentials (git clone auth echoes this shape).
      "fatal: Authentication failed for 'https://oauth2:glpat-AbCdEf123@gitlab.com/x'",
      'https://user:hunter2pw@host/repo',
    ]) {
      r.recordFailure('chat-model', `err ${shape} end`);
      const detail = r.lastFailure('chat-model')?.detail ?? '';
      expect(detail, `leaked via ${shape}`).not.toContain('secretvalue123');
      expect(detail).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(detail).not.toContain('hunter2secret');
      expect(detail).not.toContain('redissecret99');
      expect(detail).not.toContain('bearersecretvalue');
      expect(detail).not.toContain('correct horse battery staple');
      expect(detail).not.toContain('glpat-AbCdEf123');
      expect(detail).not.toContain('hunter2pw');
    }
  });

  it('sanitize: whitespace-class controls become spaces so secrets cannot fuse onto names', () => {
    const r = new ProviderReadiness({ credsProbe: () => 'present' });
    // `token:\tBearer abc` — a deleted tab would fuse 'Bearer' onto the
    // name and let the real secret survive as the second word. With
    // space normalization the Bearer pattern redacts the value first.
    r.recordFailure('chat-model', 'hdr token:\tBearer supersecretvalue99');
    expect(r.lastFailure('chat-model')?.detail ?? '').not.toContain('supersecretvalue99');
    r.recordFailure('chat-model', 'hdr Authorization: Token tok_abc123xyz');
    expect(r.lastFailure('chat-model')?.detail ?? '').not.toContain('tok_abc123xyz');
  });

  it('canonical OAuth error codes classify as auth (invalid_grant, access_denied, …)', () => {
    for (const code of [
      'invalid_grant',
      'invalid_token',
      'invalid_client',
      'invalid_api_key',
      'access_denied',
      'unauthorized_client',
    ]) {
      expect(classifyFailureText(`error=${code}`), code).toBe('auth');
    }
  });

  it('a connection error carrying :401 classifies network, not auth', () => {
    expect(classifyFailureText('connect ECONNREFUSED 127.0.0.1:401')).toBe('network');
    expect(classifyFailureText('Request failed with status code 401')).toBe('auth');
  });

  it('the sanitizer must not destroy the classifier evidence — classify on raw text', () => {
    // `API_KEY: not set` — the name=value sanitizer would eat `not` as
    // a "secret value" (`API_KEY:… set`), leaving no anchor. Extraction
    // and classification run on RAW text; only the stored detail is
    // sanitized.
    const issues: { fix?: { kind: string; command?: string }; detail: string }[] = [];
    const r = new ProviderReadiness({
      onAuthIssue: (i) => issues.push({ fix: i.fix, detail: i.detail }),
    });
    const cls = r.recordFailure('gemini', 'Error: API_KEY: not set');
    expect(cls).toBe('config');
    expect(r.authStateOf('gemini')).toBe('auth-failing');
    expect(issues[0].fix).toMatchObject({ kind: 'set-env', command: 'API_KEY' });
    // And the STORED detail is sanitized — `API_KEY:` shows no value.
    expect(issues[0].detail).not.toContain('not set');
  });

  it('env-var extraction is case-anchored: lowercase words never become "Set value"', () => {
    const r = new ProviderReadiness({});
    // 'the value is not set' — /i must not let 'value' win as the name.
    const generic = r.fixFor('gemini', 'config', 'the value is not set for the project');
    expect(generic?.kind).toBe('set-env');
    expect(generic?.command).toBeUndefined(); // generic recipe — no bogus var name
    // `FOO variable is not set` and `FOO=1 is not set` both name FOO —
    // the anchor may sit behind one separator/value token.
    expect(r.fixFor('gemini', 'config', 'the FOO variable is not set')).toMatchObject({
      command: 'FOO',
    });
    expect(r.fixFor('gemini', 'config', 'FOO=1 is not set')).toMatchObject({ command: 'FOO' });
    expect(r.fixFor('gemini', 'config', 'FOO is not set')).toMatchObject({ command: 'FOO' });
    // And the deferral case: 'FOO: GOOGLE_PROJECT is not set' — the
    // middle token is the real name.
    expect(r.fixFor('gemini', 'config', 'FOO: GOOGLE_PROJECT is not set')).toMatchObject({
      command: 'GOOGLE_PROJECT',
    });
  });
});

/* ================================================================== *
 * Credential probe (composition-side, real fs checks)
 * ================================================================== */

describe('makeCredentialProbe (#294)', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'florina-credprobe-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports present when the provider credential file exists', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
    const probe = makeCredentialProbe({ env: {}, homeDir: home });
    expect(probe('claude-code')).toBe('present');
  });

  it('reports absent when the known cred path is checked and missing', () => {
    const probe = makeCredentialProbe({ env: {}, homeDir: home });
    expect(probe('codex')).toBe('absent');
    expect(probe('gemini')).toBe('absent');
  });

  it('reports present when a provider-blessed env var is set', () => {
    const probe = makeCredentialProbe({ env: { ANTHROPIC_API_KEY: 'x' }, homeDir: home });
    expect(probe('claude-code')).toBe('present');
  });

  it('reports unknown for providers whose primary store is unprobeable on this platform', () => {
    // agy's OAuth token lives in Linux Secret Service over D-Bus — no
    // generic existence probe. A file/env miss must be honest 'unknown',
    // never a false "not signed in". (On win32/darwin the keyring IS
    // consulted.)
    const probe = makeCredentialProbe({ env: {}, homeDir: home, platform: 'linux' });
    expect(probe('antigravity')).toBe('unknown');
  });

  it('agy on linux: the SSH/headless token file is positive evidence even with the keyring unprobeable', () => {
    // ~/.gemini/antigravity-cli/antigravity-oauth-token is agy's
    // documented file fallback (SSH sessions, GEMINI_FORCE_FILE_STORAGE).
    const probe = makeCredentialProbe({ env: {}, homeDir: home, platform: 'linux' });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      '{}',
    );
    expect(probe('antigravity')).toBe('present');
  });

  it('devin resolves credentials.toml under $XDG_DATA_HOME (default ~/.local/share)', () => {
    // docs.devin.ai/cli/enterprise/devin-auth — the same XDG path on
    // macOS and Linux; default home-relative probe must NOT claim a
    // custom-XDG user is unsigned.
    const xdg = path.join(home, 'custom-xdg');
    fs.mkdirSync(path.join(xdg, 'devin'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'devin', 'credentials.toml'), '');
    const probe = makeCredentialProbe({
      env: { XDG_DATA_HOME: xdg },
      homeDir: home,
      platform: 'linux',
    });
    expect(probe('devin')).toBe('present');
    // And the conventional default is probed when XDG_DATA_HOME is unset.
    fs.mkdirSync(path.join(home, '.local', 'share', 'devin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'share', 'devin', 'credentials.toml'), '');
    expect(makeCredentialProbe({ env: {}, homeDir: home, platform: 'darwin' })('devin')).toBe(
      'present',
    );
  });

  it('darwin keychain probe passes -a <account> when the spec names one (agy)', () => {
    // agy's item is svce=gemini acct=antigravity — probing `-s gemini`
    // alone would over-report any other gemini-keyed item.
    const calls: string[][] = [];
    const probe = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'darwin',
      spawnFn: ((_cmd: string, args: string[]) => {
        calls.push(args);
        return { status: 44 };
      }) as never,
    });
    expect(probe('antigravity')).toBe('absent');
    expect(calls[0]).toEqual(['find-generic-password', '-s', 'gemini', '-a', 'antigravity']);
  });

  it('darwin keychain probe omits -a for specs without an account (claude)', () => {
    // A regression adding `-a` unconditionally would query account ''
    // and silently break every service-only spec.
    const calls: string[][] = [];
    const probe = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'darwin',
      spawnFn: ((_cmd: string, args: string[]) => {
        calls.push(args);
        return { status: 44 };
      }) as never,
    });
    expect(probe('claude-code')).toBe('absent');
    expect(calls[0]).toEqual(['find-generic-password', '-s', 'Claude Code-credentials']);
  });

  it('devin: credentials.toml counts as evidence (real path per `devin auth status`)', () => {
    // `devin auth status` prints "Credentials path:
    // %APPDATA%\devin\credentials.toml" — verified live on Windows.
    const probe = makeCredentialProbe({ env: {}, homeDir: home });
    expect(probe('devin')).toBe('absent'); // known location, no file
    fs.mkdirSync(path.join(home, 'AppData', 'Roaming', 'devin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'AppData', 'Roaming', 'devin', 'credentials.toml'), '');
    expect(probe('devin')).toBe('present');
    expect(makeCredentialProbe({ env: { DEVIN_API_KEY: 'x' }, homeDir: home })('devin')).toBe(
      'present',
    );
  });

  it('win32 cmdkey probe: `* NONE *` (exit 0) is absent, Target line is present, garbage is unknown', () => {
    // Live-verified semantics: `cmdkey /list:<target>` exits 0 for both
    // hits and misses — the verdict lives in the stdout body.
    const found = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'win32',
      spawnFn: (() => ({
        status: 0,
        stdout: 'Target: gemini:antigravity\n  Type: Generic\n  User: antigravity\n',
      })) as never,
    });
    expect(found('antigravity')).toBe('present');

    const missing = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'win32',
      spawnFn: (() => ({
        status: 0,
        stdout: 'Currently stored credentials:\n\n* NONE *\n',
      })) as never,
    });
    expect(missing('antigravity')).toBe('absent');

    const errored = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'win32',
      spawnFn: (() => ({ status: 1, stdout: '', stderr: 'bad parameters' })) as never,
    });
    expect(errored('antigravity')).toBe('unknown');
  });

  it('copilot: the gh-fallback credman target counts as evidence (#303)', () => {
    // Copilot's auth order ends with `gh auth token` — a user who only
    // ran `gh auth login` is signed in for real, so gh's Credential
    // Manager entry (`gh:github.com:` — verified live on Windows) must
    // count as evidence. `/list:<target>` exact-matches, so the gh key
    // with its trailing colon is the stable probe.
    const calls: string[][] = [];
    const probe = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'win32',
      spawnFn: ((_cmd: string, args: string[]) => {
        calls.push(args);
        return args[0] === '/list:gh:github.com:'
          ? { status: 0, stdout: 'Target: gh:github.com:\n  Type: Generic\n' }
          : { status: 0, stdout: 'Currently stored credentials:\n\n* NONE *\n' };
      }) as never,
    });
    expect(probe('copilot')).toBe('present');
    expect(calls[0]).toEqual(['/list:gh:github.com:']);
  });

  it('copilot: a per-account credman entry is found by the /list pattern scan (#303)', () => {
    // Copilot's own store renders `https://github.com:<user>.copilot-cli`
    // (verified live after `copilot login`) — a static exact target can
    // never name it, so the manifest carries a `copilot-cli` pattern
    // scanned over the full `cmdkey /list` dump.
    const calls: string[][] = [];
    const probe = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'win32',
      spawnFn: ((_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === '/list') {
          return {
            status: 0,
            stdout:
              'Currently stored credentials:\n' +
              '    Target: LegacyGeneric:target=gh:github.com:\n' +
              '    Target: LegacyGeneric:target=https://github.com:DurdeuVlad.copilot-cli\n',
          };
        }
        // The gh exact target misses — only the pattern can hit.
        return { status: 0, stdout: 'Currently stored credentials:\n\n* NONE *\n' };
      }) as never,
    });
    expect(probe('copilot')).toBe('present');
    expect(calls).toContainEqual(['/list']);
  });

  it('copilot: an unknown pattern-scan verdict blocks a false absent (#303)', () => {
    // A failed `/list` run (null status = spawn error/timeout) must
    // degrade to 'unknown' — never decay to 'absent' and falsely offer
    // sign-in to a user whose credentials may exist.
    const probe = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'win32',
      spawnFn: ((_cmd: string, args: string[]) =>
        args[0] === '/list'
          ? { status: null, stderr: 'spawn timed out' }
          : { status: 0, stdout: '* NONE *\n' }) as never,
    });
    expect(probe('copilot')).toBe('unknown');
  });

  it('copilot: darwin probes every keychain item — the gh fallback item counts too (#303)', () => {
    // First item (`copilot-cli`) misses with 44, second (`gh:github.com`)
    // hits — presence on any consulted store is evidence.
    const calls: string[][] = [];
    const probe = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'darwin',
      spawnFn: ((_cmd: string, args: string[]) => {
        calls.push(args);
        return args.includes('copilot-cli') ? { status: 44 } : { status: 0 };
      }) as never,
    });
    expect(probe('copilot')).toBe('present');
    expect(calls[0]).toEqual(['find-generic-password', '-s', 'copilot-cli']);
    expect(calls[1]).toEqual(['find-generic-password', '-s', 'gh:github.com']);
  });

  it('cmdkey probe never reads a credential value — existence only', () => {
    const calls: string[][] = [];
    const probe = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'win32',
      spawnFn: ((_cmd: string, args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: 'Target: x\n' };
      }) as never,
    });
    expect(probe('antigravity')).toBe('present');
    for (const args of calls) {
      // Only `/list:<target>` — never an operation that returns the secret.
      for (const a of args) expect(a).toMatch(/^\/list:/);
    }
  });

  it('on darwin, a keychain item counts as evidence — file absence alone is not a miss', () => {
    // Claude Code on macOS prefers the Keychain and may delete
    // .credentials.json — absent file must NOT claim "not signed in".
    const found = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'darwin',
      spawnFn: (() => ({ status: 0 })) as never,
    });
    expect(found('claude-code')).toBe('present');

    // `security` exit 44 = item definitively absent.
    const missing = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'darwin',
      spawnFn: (() => ({ status: 44 })) as never,
    });
    expect(missing('claude-code')).toBe('absent');

    // Any other keychain failure can't prove absence — honest unknown.
    const errored = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'darwin',
      spawnFn: (() => ({ status: 1 })) as never,
    });
    expect(errored('claude-code')).toBe('unknown');
  });

  it('darwin keychain probe never passes -w — the secret stays in the keychain', () => {
    const calls: string[][] = [];
    const probe = makeCredentialProbe({
      env: {},
      homeDir: home,
      platform: 'darwin',
      spawnFn: ((_cmd: string, args: string[]) => {
        calls.push(args);
        return { status: 0 };
      }) as never,
    });
    expect(probe('claude-code')).toBe('present');
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).not.toContain('-w');
  });

  it('gemini: gcloud ADC credentials count as sign-in evidence', () => {
    fs.mkdirSync(path.join(home, '.config', 'gcloud'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config', 'gcloud', 'application_default_credentials.json'),
      '{}',
    );
    const probe = makeCredentialProbe({ env: {}, homeDir: home });
    expect(probe('gemini')).toBe('present');
    expect(
      makeCredentialProbe({
        env: { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json' },
        homeDir: '',
      })('gemini'),
    ).toBe('present');
  });
});

/* ================================================================== *
 * AttentionAggregator — ProviderAuth dedup
 * ================================================================== */

describe('AttentionAggregator.reportProviderAuthIssue (#294)', () => {
  let inbox: AttentionInbox;
  let aggregator: AttentionAggregator;
  beforeEach(() => {
    inbox = new AttentionInbox();
    aggregator = new AttentionAggregator(inbox, new EventBus());
  });

  const issue = (providerId: string, detail = 'oauth token invalid') => ({
    providerId,
    failureClass: 'auth',
    detail,
    fix: {
      kind: 'run-command' as const,
      label: `Sign in to ${providerId}`,
      command: providerId,
      detail: `opens a terminal running \`${providerId}\``,
    },
  });

  it('creates exactly one card per provider, folding repeats while it stands', () => {
    aggregator.reportProviderAuthIssue(issue('claude-code'));
    aggregator.reportProviderAuthIssue(issue('claude-code', 'still 401'));
    const items = inbox.list({ kind: 'ProviderAuth' });
    expect(items).toHaveLength(1);
    expect(items[0].payload['providerId']).toBe('claude-code');
    expect(items[0].payload['failures']).toBe(2);
    expect(items[0].payload['reason']).toBe('still 401');
    // taskId is '' — provider issues are not task-scoped.
    expect(items[0].taskId).toBe('');
  });

  it('keeps separate providers on separate cards', () => {
    aggregator.reportProviderAuthIssue(issue('claude-code'));
    aggregator.reportProviderAuthIssue(issue('gemini', 'missing GOOGLE_CLOUD_PROJECT'));
    const items = inbox.list({ kind: 'ProviderAuth' });
    expect(items).toHaveLength(2);
  });

  it('a fresh failure after the card was resolved raises a new card', () => {
    aggregator.reportProviderAuthIssue(issue('codex'));
    const first = inbox.list({ kind: 'ProviderAuth' })[0];
    inbox.resolve(first.id);
    aggregator.reportProviderAuthIssue(issue('codex', '401 again'));
    const items = inbox.list({ kind: 'ProviderAuth' });
    expect(items).toHaveLength(2);
    expect(items.filter((i) => i.status !== 'Resolved')).toHaveLength(1);
  });
});

/* ================================================================== *
 * CommandApi surfaces — query-providers + signin-provider
 * ================================================================== */

describe('CommandApi readiness surfaces (#294)', () => {
  let db: StorageDatabase;
  let fixtureDeps: CommandApiDeps;
  let insertTask: (t: Task) => void;
  let projectId: string;

  beforeEach(() => {
    db = new StorageDatabase({ path: ':memory:' });
    db.open();
    const projects = new ProjectRepository(db.connection);
    const tasks = new TaskRepository(db.connection);
    const events = new EventRepository(db.connection);
    const sessions = new SessionRepository(db.connection);

    const project = buildProject({ name: 'demo', repo: { path: '/repo/demo' } });
    projects.insert(project);
    projectId = project.id;
    insertTask = (t) => tasks.insert(t);

    const eventBus = new EventBus();
    fixtureDeps = {
      eventBus,
      taskStateMachine: new TaskStateMachine(tasks, events),
      attentionInbox: new AttentionInbox(),
      metricsCollector: new MetricsCollector(),
      worktreeManager: {
        createWorktree: vi.fn(),
        pruneWorktree: vi.fn(),
        detectDirty: vi.fn(),
        worktreeStatus: vi.fn(),
      } as unknown as CommandApiDeps['worktreeManager'],
      eventRepository: events,
      taskStore: {
        getById: (id: string) => tasks.getById(id),
        listAll: () => [],
        update: (t: Task) => tasks.update(t),
      } as TaskStore,
      approvalStore: {
        getById: () => null,
        listByTask: () => [],
        insert: () => {},
        update: () => {},
      } as unknown as CommandApiDeps['approvalStore'],
      sessionStore: sessions as SessionStore,
    };
  });

  afterEach(() => {
    db.close();
  });

  it('query-providers stays back-compatible without the readiness dep', async () => {
    const api = new CommandApi({
      ...fixtureDeps,
      providerAttachment: () => ({
        attached: [{ id: 'codex', detail: 'app-server ws://x' }],
        skipped: [{ id: 'claude-code', reason: 'not found' }],
      }),
    });
    const res = (await api.execute({ kind: 'query-providers' })) as ProvidersResponse;
    expect(res.ok).toBe(true);
    expect(res.providers).toHaveLength(2);
    expect(res.providers[0].auth).toBeUndefined();
    expect(res.providers[0].fix).toBeUndefined();
    expect(res.chatModel).toBeUndefined();
  });

  it('query-providers attaches auth state + fix additively', async () => {
    const readiness = new ProviderReadiness({
      credsProbe: (id) => (id === 'codex' ? 'present' : 'absent'),
    });
    readiness.recordFailure('gemini', '401 unauthorized');
    const api = new CommandApi({
      ...fixtureDeps,
      providerAttachment: () => ({
        attached: [{ id: 'codex' }, { id: 'gemini' }, { id: 'claude-code' }],
        skipped: [],
      }),
      providerReadiness: readiness,
      chatModelStatus: () => ({
        configured: true,
        keySource: 'vault',
        state: 'ok',
      }),
    });
    const res = (await api.execute({ kind: 'query-providers' })) as ProvidersResponse;
    const byId = Object.fromEntries(res.providers.map((p) => [p.id, p]));
    expect(byId['codex']?.auth).toBe('signed-in');
    expect(byId['gemini']?.auth).toBe('auth-failing');
    expect(byId['gemini']?.authDetail).toContain('401');
    expect(byId['gemini']?.fix?.command).toBe('gemini');
    expect(byId['claude-code']?.auth).toBe('found-not-signed-in');
    expect(byId['claude-code']?.fix?.kind).toBe('run-command');
    expect(res.chatModel?.state).toBe('ok');
    expect(res.chatModel?.keySource).toBe('vault');
  });

  it('a dispatch failure classifies the provider and raises one attention card', async () => {
    const inbox = fixtureDeps.attentionInbox;
    const aggregator = new AttentionAggregator(inbox, fixtureDeps.eventBus);
    const readiness = new ProviderReadiness({
      credsProbe: () => 'present',
      onAuthIssue: (i) => aggregator.reportProviderAuthIssue(i),
    });
    const failing: AgentRuntimePort = {
      id: 'codex',
      fidelityTier: 'A',
      connectionState: 'connected',
      connect: () => Promise.resolve(),
      startRun: () =>
        Promise.reject(new Error('codex responded 401 — OAuth access token is invalid')),
      streamEvents: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      }),
      cancel: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
    };
    const api = new CommandApi({
      ...fixtureDeps,
      sessionManager: new SessionManager(fixtureDeps.eventBus),
      adapterRegistry: { create: () => failing } as unknown as CommandApiDeps['adapterRegistry'],
      providerReadiness: readiness,
    });
    const task = buildTask({ projectId, objective: 'Do a thing' });
    insertTask(task);
    const res = await api.execute({
      kind: 'start-task',
      taskId: task.id,
      agentId: 'codex',
      sessionConfig: { workingDir: '/repo/wt' },
    });
    expect(res.ok).toBe(false);
    expect(readiness.authStateOf('codex')).toBe('auth-failing');
    const cards = inbox.list({ kind: 'ProviderAuth' });
    expect(cards).toHaveLength(1);
    expect(cards[0].payload['providerId']).toBe('codex');
    // Second failure folds into the same card.
    const task2 = buildTask({ projectId, objective: 'Again' });
    insertTask(task2);
    await api.execute({
      kind: 'start-task',
      taskId: task2.id,
      agentId: 'codex',
      sessionConfig: { workingDir: '/repo/wt' },
    });
    expect(inbox.list({ kind: 'ProviderAuth' })).toHaveLength(1);
    expect(inbox.list({ kind: 'ProviderAuth' })[0].payload['failures']).toBe(2);
  });

  it('signin-provider: unknown id fails plainly; store-key instructs; run-command launches', async () => {
    const launches: string[] = [];
    const api = new CommandApi({
      ...fixtureDeps,
      providerReadiness: new ProviderReadiness(),
      terminalLauncher: (command) => {
        launches.push(command);
        return { ok: true, detail: `opened ${command}` };
      },
    });
    const unknown = (await api.execute({
      kind: 'signin-provider',
      providerId: 'nope',
    })) as SigninProviderResponse;
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('no sign-in recipe');

    const chat = (await api.execute({
      kind: 'signin-provider',
      providerId: 'chat-model',
    })) as SigninProviderResponse;
    expect(chat.ok).toBe(true);
    expect(chat.launched).toBe(false);
    expect(chat.detail).toContain('florina keys set');

    const claude = (await api.execute({
      kind: 'signin-provider',
      providerId: 'claude-code',
    })) as SigninProviderResponse;
    expect(claude.ok).toBe(true);
    expect(claude.launched).toBe(true);
    expect(launches).toEqual(['claude']);
  });

  it('signin-provider degrades honestly when no terminal launcher is wired', async () => {
    const api = new CommandApi({ ...fixtureDeps, providerReadiness: new ProviderReadiness() });
    const res = (await api.execute({
      kind: 'signin-provider',
      providerId: 'codex',
    })) as SigninProviderResponse;
    expect(res.ok).toBe(true);
    expect(res.launched).toBe(false);
    expect(res.detail).toContain('codex login');
  });

  it('a throwing chatModelStatus never takes provider facts down with it', async () => {
    const api = new CommandApi({
      ...fixtureDeps,
      providerAttachment: () => ({ attached: [{ id: 'codex' }], skipped: [] }),
      chatModelStatus: () => Promise.reject(new Error('vault exploded')),
    });
    const res = (await api.execute({ kind: 'query-providers' })) as ProvidersResponse;
    expect(res.ok).toBe(true);
    expect(res.providers).toHaveLength(1);
    expect(res.chatModel).toBeUndefined();
  });

  it('signin-provider chat-model on an unconfigured daemon names the env setup first', async () => {
    const api = new CommandApi({
      ...fixtureDeps,
      providerReadiness: new ProviderReadiness(),
      chatModelStatus: () =>
        Promise.resolve({ configured: false, keySource: 'none', state: 'unconfigured' }),
    });
    const res = (await api.execute({
      kind: 'signin-provider',
      providerId: 'chat-model',
    })) as SigninProviderResponse;
    expect(res.ok).toBe(true);
    // A stored key alone remediates nothing without a configured
    // connector — the instructions must say so.
    expect(res.detail).toContain('FLORINA_LITELLM_URL');
    expect(res.detail).toContain('florina keys set openai-api-key');
  });

  it('install-provider: verified installer launches; unverified platform gives manual instructions', async () => {
    const launches: string[] = [];
    const api = new CommandApi({
      ...fixtureDeps,
      platform: 'win32',
      providerAttachment: () => ({
        attached: [],
        skipped: [{ id: 'codex', reason: 'not found' }],
      }),
      terminalLauncher: (command) => {
        launches.push(command);
        return Promise.resolve({ ok: true, detail: `opened ${command}` });
      },
    });
    const res = (await api.execute({
      kind: 'install-provider',
      providerId: 'codex',
    })) as InstallProviderResponse;
    expect(res.ok).toBe(true);
    expect(res.launched).toBe(true);
    expect(launches).toEqual(['npm i -g @openai/codex']);
    expect(res.detail).toContain('official');
    // The next query-providers re-resolves live (#301), so status picks
    // the install up — but a PATH entry the daemon's stale env can't see
    // still needs the documented restart fallback.
    expect(res.detail).toContain('florina status');
    expect(res.detail).toContain('restart florina');
    expect(res.detail).toContain('florina auth codex');

    // devin's script installer has explicit win32/darwin/linux cells and
    // NO `default` — on freebsd there is nothing verified, so the user
    // gets manual instructions, never a guessed command.
    const manual = await new CommandApi({
      ...fixtureDeps,
      platform: 'freebsd',
      providerAttachment: () => ({
        attached: [],
        skipped: [{ id: 'devin', reason: 'not found' }],
      }),
      terminalLauncher: () => Promise.resolve({ ok: true, detail: 'should not run' }),
    }).execute({ kind: 'install-provider', providerId: 'devin' });
    expect((manual as InstallProviderResponse).ok).toBe(false);
    expect((manual as InstallProviderResponse).error).toContain('no verified installer');
    expect((manual as InstallProviderResponse).error).toContain('provider’s own docs');
  });

  it('install-provider: chat-model is a key not an install; attached providers short-circuit to sign-in', async () => {
    const api = new CommandApi({
      ...fixtureDeps,
      platform: 'win32',
      providerAttachment: () => ({
        attached: [{ id: 'codex' }],
        skipped: [],
      }),
      terminalLauncher: () => Promise.resolve({ ok: true, detail: 'x' }),
    });
    const chat = (await api.execute({
      kind: 'install-provider',
      providerId: 'chat-model',
    })) as InstallProviderResponse;
    expect(chat.ok).toBe(false);
    expect(chat.error).toContain('florina keys set openai-api-key');

    const already = (await api.execute({
      kind: 'install-provider',
      providerId: 'codex',
    })) as InstallProviderResponse;
    expect(already.ok).toBe(false);
    expect(already.error).toContain('already installed');
    expect(already.error).toContain('florina auth codex');
  });

  it('signin-provider on a missing provider names the install verb when one exists', async () => {
    const api = new CommandApi({
      ...fixtureDeps,
      platform: 'win32',
      providerAttachment: () => ({
        attached: [],
        skipped: [{ id: 'codex', reason: 'not found' }],
      }),
      providerReadiness: new ProviderReadiness(),
    });
    const res = (await api.execute({
      kind: 'signin-provider',
      providerId: 'codex',
    })) as SigninProviderResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('florina install codex');
  });

  it('query-providers marks skipped rows installable only when a verified installer exists', async () => {
    const api = new CommandApi({
      ...fixtureDeps,
      platform: 'win32',
      providerAttachment: () => ({
        attached: [{ id: 'claude-code' }],
        skipped: [
          { id: 'codex', reason: 'not found' },
          { id: 'antigravity', reason: 'not found' },
        ],
      }),
    });
    const res = (await api.execute({ kind: 'query-providers' })) as ProvidersResponse;
    const byId = Object.fromEntries(res.providers.map((p) => [p.id, p]));
    expect(byId['codex']?.installable).toBe(true);
    expect(byId['antigravity']?.installable).toBe(true); // verified win32 installer
    expect(byId['claude-code']?.installable).toBeUndefined(); // attached rows never carry it

    // Same skipped row on a platform with no verified devin installer —
    // the script cells are explicit per-OS, so freebsd has nothing:
    const linux = new CommandApi({
      ...fixtureDeps,
      platform: 'freebsd',
      providerAttachment: () => ({
        attached: [],
        skipped: [{ id: 'devin', reason: 'not found' }],
      }),
    });
    const res2 = (await linux.execute({ kind: 'query-providers' })) as ProvidersResponse;
    expect(res2.providers[0].installable).toBeUndefined();
  });
});

/* ================================================================== *
 * `florina auth` CLI — faked client/runner, real dispatch path
 * ================================================================== */

describe('florina auth CLI (#294)', () => {
  let written: string;
  let errWritten: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const cliWith = (handlers: Record<string, Response>): CliDependencies => {
    const sent: Command[] = [];
    return {
      client: {
        send: (command: Command) => {
          sent.push(command);
          const res = handlers[command.kind];
          return Promise.resolve(res ?? { ok: false, error: 'unhandled in test' });
        },
      } as unknown as CliDependencies['client'],
      runner: {
        start: () => Promise.resolve(1),
        stop: () => Promise.resolve(true),
        status: () => Promise.resolve({ running: true, port: 17419 }),
      },
      createVoiceSession: () => Promise.reject(new Error('no voice in tests')),
    };
  };

  beforeEach(() => {
    written = '';
    errWritten = '';
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written += chunk.toString();
        return true;
      });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      errWritten += chunk.toString();
      return true;
    });
  });
  afterEach(() => {
    writeSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('`auth` lists sign-in state from a fresh query-providers', async () => {
    const deps = cliWith({
      'query-providers': {
        ok: true,
        probed: true,
        providers: [
          { id: 'claude-code', found: true, detail: 'claude', auth: 'signed-in' },
          { id: 'codex', found: true, detail: 'codex', auth: 'found-not-signed-in' },
          { id: 'gemini', found: false, detail: 'not found', auth: 'unknown' },
        ],
        chatModel: { configured: true, keySource: 'vault', state: 'ok' },
      },
    });
    const code = await runCli(['auth'], deps);
    expect(code).toBe(0);
    expect(written).toContain('signed in');
    expect(written).toContain('codex');
    expect(written).toContain('not signed in');
    // The chat model row reads plainly — "chat model" wording the
    // onboarding user actually understands.
    expect(written).toContain('chat model');
  });

  it('`auth codex` sends signin-provider and prints the daemon’s instructions', async () => {
    const sent: Command[] = [];
    const deps = cliWith({
      'query-providers': {
        ok: true,
        probed: true,
        providers: [{ id: 'codex', found: true, auth: 'found-not-signed-in' }],
      },
      'signin-provider': {
        ok: true,
        providerId: 'codex',
        launched: false,
        detail: 'run `codex login` in a terminal — this daemon can’t open one for you',
      },
    });
    // Intercept the client to record what was sent.
    const originalSend = deps.client.send.bind(deps.client);
    deps.client.send = ((command: Command) => {
      sent.push(command);
      return originalSend(command);
    }) as typeof deps.client.send;
    const code = await runCli(['auth', 'codex'], deps);
    expect(code).toBe(0);
    expect(sent.map((c) => c.kind)).toEqual(['query-providers', 'signin-provider']);
    expect(sent[1]).toMatchObject({ providerId: 'codex' });
    expect(written).toContain('codex login');
  });

  it('`auth chat` resolves the friendly alias to chat-model', async () => {
    const sent: Command[] = [];
    const deps = cliWith({
      'query-providers': {
        ok: true,
        probed: true,
        providers: [],
        chatModel: { configured: true, keySource: 'none', state: 'unknown' },
      },
      'signin-provider': {
        ok: true,
        providerId: 'chat-model',
        launched: false,
        detail:
          'store the key in Florina’s key vault — run `florina keys set openai OPENAI_API_KEY`',
      },
    });
    const originalSend = deps.client.send.bind(deps.client);
    deps.client.send = ((command: Command) => {
      sent.push(command);
      return originalSend(command);
    }) as typeof deps.client.send;
    const code = await runCli(['auth', 'chat'], deps);
    expect(code).toBe(0);
    expect(sent[1]).toMatchObject({ kind: 'signin-provider', providerId: 'chat-model' });
    expect(written).toContain('florina keys set');
  });

  it('`auth bogus` exits 1 naming the known providers', async () => {
    const deps = cliWith({
      'query-providers': {
        ok: true,
        probed: true,
        providers: [{ id: 'codex', found: true }],
      },
    });
    const code = await runCli(['auth', 'bogus'], deps);
    expect(code).toBe(1);
    expect(errWritten).toContain('codex');
    expect(errWritten).toContain('chat-model');
  });

  it('`install codex` sends install-provider and prints the daemon detail', async () => {
    const sent: Command[] = [];
    const deps = cliWith({
      'install-provider': {
        ok: true,
        providerId: 'codex',
        launched: true,
        detail: 'opens a terminal running the official Codex install (npm)',
      },
    });
    const originalSend = deps.client.send.bind(deps.client);
    deps.client.send = ((command: Command) => {
      sent.push(command);
      return originalSend(command);
    }) as typeof deps.client.send;
    const code = await runCli(['install', 'codex'], deps);
    expect(code).toBe(0);
    expect(sent.map((c) => c.kind)).toEqual(['install-provider']);
    expect(sent[0]).toMatchObject({ providerId: 'codex' });
    expect(written).toContain('official Codex install');
  });

  it('`install` without an id exits 1 with usage; daemon errors propagate honestly', async () => {
    const code1 = await runCli(['install'], cliWith({}));
    expect(code1).toBe(1);
    expect(errWritten).toContain('Usage: florina install');

    const deps = cliWith({
      'install-provider': {
        ok: false,
        providerId: 'devin',
        error: 'no verified installer for "devin" on this platform',
      },
    });
    const code2 = await runCli(['install', 'devin'], deps);
    expect(code2).toBe(1);
    expect(errWritten).toContain('no verified installer');
  });

  it('`status`/`auth` shows the install fix on skipped rows that are installable', async () => {
    const deps = cliWith({
      'query-providers': {
        ok: true,
        probed: true,
        providers: [
          { id: 'codex', found: false, detail: 'not found', installable: true },
          { id: 'devin', found: false, detail: 'not found' },
        ],
      },
    });
    const code = await runCli(['status'], deps);
    expect(code).toBe(0);
    expect(written).toContain('florina install codex');
    // No install hint on rows the daemon didn't mark installable.
    expect(written).not.toContain('florina install devin');
  });
});

/* ================================================================== *
 * Desktop surfaces — setup rows + inbox card actions (pure RenderTree)
 * ================================================================== */

/** Collect the text of every node anywhere in a RenderTree. */
function allText(tree: RenderTree): string {
  const parts: string[] = [];
  const walk = (node: RenderTree | string): void => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  return parts.join(' ');
}

/** Collect every `command` prop anywhere in a RenderTree. */
function allCommands(tree: RenderTree): string[] {
  const out: string[] = [];
  const walk = (node: RenderTree | string): void => {
    if (typeof node === 'string') return;
    const cmd = node.props?.['command'];
    if (typeof cmd === 'string') out.push(cmd);
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

const setupInput = (over: Partial<SetupViewInput> = {}): SetupViewInput => ({
  step: 'apps',
  installMode: 'packaged',
  providers: [],
  roots: [],
  repos: [],
  providersChecked: true,
  reposChecked: true,
  daemonOnline: true,
  ...over,
});

describe('desktop setup view — provider sign-in rows (#294)', () => {
  it('a not-signed-in provider renders a sign-in button bound to its id', () => {
    const tree = renderSetupView(
      setupInput({
        providers: [
          {
            id: 'codex',
            found: true,
            auth: 'found-not-signed-in',
            fix: {
              kind: 'run-command',
              label: 'Sign in to Codex',
              detail: 'opens a terminal running `codex login`',
            },
          },
        ],
      }),
    );
    expect(allText(tree)).toContain('not signed in');
    expect(allCommands(tree)).toContain('setup:signin:codex');
    expect(allText(tree)).toContain('Sign in to Codex');
  });

  it('a misconfigured chat model names the missing setting — no key button', () => {
    // A config-class turn failure (missing env var) must not show
    // "its key is being rejected" or an 'Add a model key' CTA.
    const tree = renderSetupView(
      setupInput({
        providers: [],
        chatModel: {
          configured: true,
          keySource: 'env',
          state: 'misconfigured',
          detail: 'required environment variable FLORINA_MODEL is not set',
        },
      }),
    );
    expect(allText(tree)).toContain('a setting it needs is missing');
    expect(allText(tree)).toContain('FLORINA_MODEL');
    expect(allCommands(tree)).not.toContain('navto:prefs');
  });

  it('a not-found provider never renders a sign-in button — the binary cannot run', () => {
    // Defense in depth: even if the wire ever carries a fix on a
    // found:false row, the view must not offer "Sign in to X" — clicking
    // it would spawn a command that doesn't exist.
    const tree = renderSetupView(
      setupInput({
        providers: [
          {
            id: 'codex',
            found: false,
            detail: 'not found',
            auth: 'found-not-signed-in',
            fix: { kind: 'run-command', label: 'Sign in to Codex', detail: 'x' },
          },
        ],
      }),
    );
    expect(allCommands(tree)).not.toContain('setup:signin:codex');
    expect(allText(tree)).not.toContain('Sign in to Codex');
  });

  it('a not-found row offers Install only when the daemon marked it installable', () => {
    const installable = renderSetupView(
      setupInput({
        providers: [{ id: 'codex', found: false, detail: 'not found', installable: true }],
      }),
    );
    expect(allCommands(installable)).toContain('setup:install:codex');
    expect(allText(installable)).toContain('Install Codex');

    // No verified installer → no button — a dead button is worse than none.
    const notInstallable = renderSetupView(
      setupInput({
        providers: [{ id: 'devin', found: false, detail: 'not found' }],
      }),
    );
    expect(allCommands(notInstallable).filter((c) => c.startsWith('setup:install:'))).toHaveLength(
      0,
    );
  });

  it('a set-env fix renders instructions, not a sign-in button', () => {
    const tree = renderSetupView(
      setupInput({
        providers: [
          {
            id: 'gemini',
            found: true,
            auth: 'auth-failing',
            authDetail: 'required environment variable GOOGLE_CLOUD_PROJECT is not set',
            fix: {
              kind: 'set-env',
              label: 'Set GOOGLE_CLOUD_PROJECT',
              detail: 'set the GOOGLE_CLOUD_PROJECT environment variable',
            },
          },
        ],
      }),
    );
    // Instruction text — a "Sign in" button here would promise an
    // action that cannot fix a missing env var.
    expect(allCommands(tree)).not.toContain('setup:signin:gemini');
    expect(allText(tree)).toContain('Set GOOGLE_CLOUD_PROJECT');
    expect(allText(tree)).toContain('environment variable');
  });

  it('an auth-failing provider shows the reason plainly plus the fix button', () => {
    const tree = renderSetupView(
      setupInput({
        providers: [
          {
            id: 'claude-code',
            found: true,
            auth: 'auth-failing',
            authDetail: 'OAuth token expired',
            fix: {
              kind: 'run-command',
              label: 'Sign in to Claude Code',
              detail: 'opens a terminal running Claude’s own sign-in',
            },
          },
        ],
      }),
    );
    expect(allText(tree)).toContain('sign-in is failing');
    expect(allText(tree)).toContain('OAuth token expired');
    expect(allCommands(tree)).toContain('setup:signin:claude-code');
  });

  it('signed-in is honestly hedged — never a guarantee', () => {
    const tree = renderSetupView(
      setupInput({
        providers: [{ id: 'claude-code', found: true, auth: 'signed-in' }],
      }),
    );
    const text = allText(tree);
    expect(text).toContain('looks signed in');
    expect(text).not.toContain('setup:signin:');
    expect(allCommands(tree).filter((c) => c.startsWith('setup:signin:'))).toHaveLength(0);
  });

  it('a provider with no auth evidence reads "sign-in happens inside the app"', () => {
    const tree = renderSetupView(setupInput({ providers: [{ id: 'antigravity', found: true }] }));
    expect(allText(tree)).toContain('sign-in happens inside the app itself');
  });

  it('the chat-model row renders key status and an "Add a model key" deep-link', () => {
    const tree = renderSetupView(
      setupInput({
        providers: [{ id: 'codex', found: true, auth: 'signed-in' }],
        chatModel: { configured: true, keySource: 'none', state: 'unknown' },
      }),
    );
    expect(allText(tree)).toContain('chat brain');
    expect(allText(tree)).toContain('needs a model API key');
    expect(allCommands(tree)).toContain('navto:prefs');
  });

  it('a working chat model reads "working" and offers no remediation', () => {
    const tree = renderSetupView(
      setupInput({
        providers: [{ id: 'codex', found: true, auth: 'signed-in' }],
        chatModel: { configured: true, keySource: 'vault', state: 'ok' },
      }),
    );
    expect(allText(tree)).toContain('working');
    expect(allCommands(tree)).not.toContain('navto:prefs');
  });

  it('no chatModel field on an old daemon renders no fabricated row', () => {
    const tree = renderSetupView(
      setupInput({ providers: [{ id: 'codex', found: true, auth: 'signed-in' }] }),
    );
    expect(allText(tree)).not.toContain('chat brain');
  });
});

describe('desktop inbox — ProviderAuth card (#294)', () => {
  const item = (payload: Record<string, unknown>): AttentionItemView => ({
    id: 'att_1',
    taskId: '',
    kind: 'ProviderAuth',
    kindMeta: KIND_METADATA['ProviderAuth'],
    priority: 'High',
    priorityMeta: PRIORITY_METADATA['High'],
    status: 'Pending',
    createdAt: '2026-01-01T00:00:00Z',
    title: 'Sign-in needed',
    summary: 'Sign in to Codex: OAuth token invalid',
    payload,
  });

  it('a run-command fix renders a Sign in button bound to the provider', () => {
    const tree = renderInboxItem(
      item({
        providerId: 'codex',
        failureClass: 'auth',
        failures: 1,
        fix: {
          kind: 'run-command',
          label: 'Sign in to Codex',
          command: 'codex login',
          detail: 'x',
        },
      }),
    );
    expect(allCommands(tree)).toContain('setup:signin:codex');
    expect(allCommands(tree)).toContain('resolve:att_1');
  });

  it('a store-key fix deep-links the keys card and keeps Dismiss', () => {
    const tree = renderInboxItem(
      item({
        providerId: 'chat-model',
        failureClass: 'auth',
        failures: 1,
        fix: { kind: 'store-key', label: 'Add the model API key', detail: 'x' },
      }),
    );
    expect(allCommands(tree)).toContain('navto:prefs');
    expect(allCommands(tree)).toContain('resolve:att_1');
  });

  it('kind metadata labels the card "Sign-in needed" with the key icon', () => {
    expect(KIND_METADATA['ProviderAuth'].label).toBe('Sign-in needed');
    expect(KIND_METADATA['ProviderAuth'].icon).toBe('key');
  });
});

/* ================================================================== *
 * launchVisibleTerminal — never claim launched before the process exists
 * ================================================================== */

describe('launchVisibleTerminal (#294)', () => {
  it('reports ok only after the spawn event wins the race', async () => {
    const { launchVisibleTerminal } =
      await import('../src/adapters/outbound/platform/terminal-launcher.js');
    // Fake child that "spawns" successfully on the next tick.
    const goodSpawn = (() => {
      const listeners: Record<string, (() => void)[]> = {};
      return {
        once: (e: string, cb: () => void) => {
          (listeners[e] ??= []).push(cb);
          if (e === 'spawn') setImmediate(cb);
          return undefined;
        },
        off: () => undefined,
        unref: () => undefined,
      };
    }) as never;
    const res = await launchVisibleTerminal('codex login', {
      platform: 'linux',
      spawnFn: goodSpawn,
      resolveFn: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('codex login');

    // Fake child that errors (ENOENT) — must NOT report launched.
    const badSpawn = (() => {
      return {
        once: (e: string, cb: (err: Error) => void) => {
          if (e === 'error') setImmediate(() => cb(new Error('ENOENT')));
          return undefined;
        },
        off: () => undefined,
        unref: () => undefined,
      };
    }) as never;
    const bad = await launchVisibleTerminal('codex login', {
      platform: 'linux',
      spawnFn: badSpawn,
      resolveFn: () => true,
    });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('run `codex login` yourself');
  });

  it('on darwin, spawning osascript is NOT success — the exit verdict decides', async () => {
    const { launchVisibleTerminal } =
      await import('../src/adapters/outbound/platform/terminal-launcher.js');
    const mkChild = (behavior: 'spawn-only' | 'exit0' | 'exit1' | 'hang') =>
      (() => {
        return {
          once: (e: string, cb: (code?: number) => void) => {
            if (behavior === 'exit0' && e === 'exit') setImmediate(() => cb(0));
            if (behavior === 'exit1' && e === 'exit') setImmediate(() => cb(1));
            if (behavior === 'spawn-only' && e === 'spawn') setImmediate(() => cb());
            // 'hang': never fires — hits the timeout.
            return undefined;
          },
          off: () => undefined,
          unref: () => undefined,
        };
      }) as never;

    // A spawn event alone says the interpreter started — a TCC denial
    // exits nonzero afterwards and must NOT report success.
    const denied = await launchVisibleTerminal('codex login', {
      platform: 'darwin',
      spawnFn: mkChild('exit1'),
      resolveFn: () => true,
      timeoutMs: 200,
    });
    expect(denied.ok).toBe(false);
    expect(denied.detail).toContain('Automation');

    const ok = await launchVisibleTerminal('codex login', {
      platform: 'darwin',
      spawnFn: mkChild('exit0'),
      resolveFn: () => true,
      timeoutMs: 200,
    });
    expect(ok.ok).toBe(true);

    // Timeout: a pending permission prompt can still deliver the window —
    // honest "asked" detail, not failure.
    const timedOut = await launchVisibleTerminal('codex login', {
      platform: 'darwin',
      spawnFn: mkChild('hang'),
      resolveFn: () => true,
      timeoutMs: 50,
    });
    expect(timedOut.ok).toBe(true);
    expect(timedOut.detail).toContain('asked macOS');
  });

  it('every losing child is muzzled — a late error event can never crash the daemon', async () => {
    const { launchVisibleTerminal } =
      await import('../src/adapters/outbound/platform/terminal-launcher.js');
    const calls: string[] = [];
    const hangs = (() => ({
      once: () => undefined, // never resolves — every candidate times out
      off: () => undefined,
      on: (e: string) => {
        calls.push(`on:${e}`);
        return undefined;
      },
      unref: () => calls.push('unref'),
      kill: (sig: string) => calls.push(`kill:${sig}`),
    })) as never;
    const res = await launchVisibleTerminal('codex login', {
      platform: 'linux',
      spawnFn: hangs,
      resolveFn: () => true,
      timeoutMs: 30,
    });
    expect(res.ok).toBe(false);
    // All four linux candidates lost their race — each must carry a
    // permanent 'error' no-op (late crash guard), be unref'd, and killed.
    expect(calls.filter((c) => c === 'on:error')).toHaveLength(4);
    expect(calls.filter((c) => c === 'unref')).toHaveLength(4);
    expect(calls.filter((c) => c === 'kill:SIGKILL')).toHaveLength(4);
  });

  it('refuses before spawning when the payload executable is not on PATH', async () => {
    const { launchVisibleTerminal } =
      await import('../src/adapters/outbound/platform/terminal-launcher.js');
    // Live-proof gap (#294): `florina auth codex` on a machine without the
    // codex CLI opened a window whose only content was "'codex' is not
    // recognized". The launcher must preflight the executable and refuse
    // with honest install instructions instead of authoring a dead window.
    const spawnCalls: string[] = [];
    const spawnSpy = ((cmd: string) => {
      spawnCalls.push(cmd);
      return { once: () => undefined, off: () => undefined, unref: () => undefined };
    }) as never;
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const res = await launchVisibleTerminal('codex login', {
        platform,
        spawnFn: spawnSpy,
        resolveFn: () => false,
      });
      expect(res.ok).toBe(false);
      expect(res.detail).toContain('`codex`');
      expect(res.detail).toContain("isn't installed or isn't on PATH");
      expect(res.detail).toContain('codex login');
    }
    // No terminal process was ever attempted on any platform.
    expect(spawnCalls).toHaveLength(0);
  });

  it('a quoted leading executable is resolved without its quotes', async () => {
    const { launchVisibleTerminal } =
      await import('../src/adapters/outbound/platform/terminal-launcher.js');
    const seen: string[] = [];
    const res = await launchVisibleTerminal('"C:\\tools dir\\codex.exe" login', {
      platform: 'linux',
      spawnFn: (() => ({
        once: () => undefined,
        off: () => undefined,
        on: () => undefined,
        unref: () => undefined,
      })) as never,
      resolveFn: (exe) => {
        seen.push(exe);
        return false;
      },
      timeoutMs: 30,
    });
    expect(res.ok).toBe(false);
    expect(seen).toEqual(['C:\\tools dir\\codex.exe']);
  });
});

describe('provider readiness e2e — real daemon (#294)', () => {
  let daemon: FlorinaDaemon;
  let client: WebSocket;
  let lockfile: string;

  const openClient = (port: number): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });

  const send = (socket: WebSocket, command: Command, timeoutMs = 4000): Promise<Response> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${command.kind} timed out`)), timeoutMs);
      const onMessage = (data: unknown): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof data === 'string' ? data : (data as Buffer).toString('utf8'));
        } catch {
          return;
        }
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof (parsed as { ok?: unknown }).ok === 'boolean'
        ) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve(parsed as Response);
        }
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify(command));
    });

  async function startDaemon(chatModel?: { baseUrl: string; model: string; apiKey?: string }) {
    lockfile = path.join(
      os.tmpdir(),
      `florina-rdy-${process.pid}-${Math.random().toString(36).slice(2)}.lock`,
    );
    daemon = new FlorinaDaemon({
      port: 0,
      mcpPort: 0,
      lockfile,
      dbPath: ':memory:',
      installSignalHandlers: false,
      ...(chatModel !== undefined ? { chatModel } : {}),
    });
    await daemon.start();
    client = await openClient(daemon.port);
  }

  afterEach(async () => {
    if (client !== undefined && client.readyState === client.OPEN) client.close();
    await daemon.stop();
    try {
      fs.unlinkSync(lockfile);
    } catch {
      /* ignore */
    }
  });

  it('a forced 401 dispatch failure yields classified state + exactly one inbox card', async () => {
    await startDaemon();
    // Register an adapter that fails startRun with a real auth error.
    daemon.adapterRegistry$?.register('failauth', () => ({
      id: 'failauth',
      fidelityTier: 'A' as const,
      connectionState: 'connected' as const,
      connect: () => Promise.resolve(),
      startRun: () =>
        Promise.reject(new Error('provider responded 401 Unauthorized: token expired')),
      streamEvents: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
      }),
      cancel: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
    }));

    // Seed a task via the storage layer (same recipe as daemon-command-integration).
    const db = (daemon as unknown as { db: { connection: import('better-sqlite3').Database } }).db
      .connection;
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const project = buildProject({ name: 'e2e', repo: { path: '/repo/e2e' } });
    projects.insert(project);
    const task = buildTask({ projectId: project.id, objective: 'Fail on auth' });
    tasks.insert(task);

    const start = await send(client, {
      kind: 'start-task',
      taskId: task.id,
      agentId: 'failauth',
      sessionConfig: { workingDir: '/repo/wt' },
    });
    expect(start.ok).toBe(false);

    const inboxRes = (await send(client, { kind: 'query-inbox' })) as InboxResponse;
    const cards = inboxRes.items.filter((i) => i.kind === 'ProviderAuth');
    expect(cards).toHaveLength(1);
    expect(cards[0].payload['providerId']).toBe('failauth');
    expect(cards[0].payload['failureClass']).toBe('auth');

    // And again — still one card (dedup by open provider card).
    const task2 = buildTask({ projectId: project.id, objective: 'Fail again' });
    tasks.insert(task2);
    await send(client, {
      kind: 'start-task',
      taskId: task2.id,
      agentId: 'failauth',
      sessionConfig: { workingDir: '/repo/wt' },
    });
    const inboxRes2 = (await send(client, { kind: 'query-inbox' })) as InboxResponse;
    expect(inboxRes2.items.filter((i) => i.kind === 'ProviderAuth')).toHaveLength(1);
  });

  it('a deliberately invalid chat key classifies chat-model auth-failing end-to-end', async () => {
    // A real HTTP stub that answers 401 — the chat connector calls
    // /v1/chat/completions and gets a genuine auth rejection.
    const stub = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const stubPort = (stub.address() as { port: number }).port;
    try {
      await startDaemon({ baseUrl: `http://127.0.0.1:${stubPort}`, model: 'test-model' });
      const sendRes = await send(client, { kind: 'chat-send', text: 'hello' });
      expect(sendRes.ok).toBe(true);

      // The turn is async — poll the readiness surface until the
      // classified failure lands (bounded).
      const deadline = Date.now() + 8000;
      let chatState: string | undefined;
      let cards: { kind: string; payload: Record<string, unknown> }[] = [];
      while (Date.now() < deadline) {
        const provRes = (await send(client, { kind: 'query-providers' })) as ProvidersResponse;
        chatState = provRes.chatModel?.state;
        const inboxRes = (await send(client, { kind: 'query-inbox' })) as InboxResponse;
        cards = inboxRes.items
          .filter((i) => i.kind === 'ProviderAuth')
          .map((i) => ({ kind: i.kind, payload: i.payload }));
        if (chatState === 'auth-failing' && cards.length === 1) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(chatState).toBe('auth-failing');
      expect(cards).toHaveLength(1);
      expect(cards[0].payload['providerId']).toBe('chat-model');
      // The card points at the vault/key-capture remediation, not a guess.
      expect((cards[0].payload['fix'] as { kind?: string } | undefined)?.kind).toBe('store-key');
      // And keySource never leaks a value — it names the source family.
      const provRes = (await send(client, { kind: 'query-providers' })) as ProvidersResponse;
      expect(provRes.chatModel?.configured).toBe(true);
      expect(provRes.chatModel?.keySource).toBe('none');
    } finally {
      stub.close();
    }
  });

  it('signin-provider over WS: chat-model returns key instructions without a launch', async () => {
    await startDaemon();
    const res = (await send(client, {
      kind: 'signin-provider',
      providerId: 'chat-model',
    })) as SigninProviderResponse;
    expect(res.ok).toBe(true);
    expect(res.launched).toBe(false);
    expect(res.detail).toContain('florina keys set');
  });
});
