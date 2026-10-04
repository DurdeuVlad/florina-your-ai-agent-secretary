/**
 * Provider readiness (issue #294): cheap, honest, local auth-state
 * tracking for the installed agent providers and the Secretary chat
 * model.
 *
 * What this service knows, and how it knows it:
 *
 *  - **Credential-file signal** — an injected `credsProbe` (owned by the
 *    composition root, where `node:fs` is allowed) reports whether the
 *    provider's well-known local credential file exists
 *    (`~/.claude/.credentials.json`, `~/.codex/auth.json`, …). Presence
 *    means "credentials exist on disk" — never "they work": stale or
 *    revoked tokens still satisfy it until a real failure contradicts
 *    them.
 *  - **Observed runtime failures** — {@link recordFailure} is called at
 *    every error seam (task dispatch, mid-run `AgentFailed` events via
 *    the bus, chat-model turns). {@link classifyFailureText} sorts the
 *    error into a plain class; `auth`-class failures flip the provider
 *    to `auth-failing` and raise an attention item once per provider.
 *  - **Observed successes** — {@link recordSuccess} clears the recorded
 *    failure so the state re-derives from the credential probe.
 *
 * The four states, derived honestly:
 *
 *  - `auth-failing`        — a classified auth/config failure was
 *                            observed and no success has superseded it.
 *  - `signed-in`           — credential evidence exists on disk and no
 *                            auth failure supersedes it (best effort —
 *                            the credential may still be dead).
 *  - `found-not-signed-in` — the provider CLI is installed but none of
 *                            its known credential files exist.
 *  - `unknown`             — no credential path is known for this
 *                            provider and no failure was observed.
 *
 * Nothing here calls a provider API, repairs a credential, or reads a
 * secret value — all of that is deliberately out of scope (#294).
 */
import type { SupervisorEvent } from '../../../domain/events.js';
import type { EventSubscriberPort } from '../../ports/outbound/event-stream.js';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** Coarse auth-readiness state for one provider or the chat model. */
export type ProviderAuthState = 'signed-in' | 'found-not-signed-in' | 'auth-failing' | 'unknown';

/** What {@link classifyFailureText} decided an error means. */
export type FailureClass = 'auth' | 'config' | 'network' | 'quota' | 'missing' | 'unknown';

/** Result of the composition-root credential probe. */
export type CredsSignal = 'present' | 'absent' | 'unknown';

/** How the user fixes a provider — never executed silently. */
export interface ProviderFix {
  /** `run-command` launches a visible terminal; `store-key` and `set-env` are instructions. */
  readonly kind: 'run-command' | 'store-key' | 'set-env';
  /** Short button/verb label, e.g. "Sign in to Claude Code". */
  readonly label: string;
  /** The command to run or env var to set, when one exists. */
  readonly command?: string;
  /** One plain-language sentence explaining the fix. */
  readonly detail: string;
}

/**
 * Raised (via the `onAuthIssue` callback) once per provider while an
 * auth-class failure stands — the composition root forwards it to the
 * attention aggregator, which dedupes against the open card.
 */
export interface ProviderAuthIssue {
  readonly providerId: string;
  readonly failureClass: FailureClass;
  /** Sanitized error detail — never a credential value. */
  readonly detail: string;
  readonly fix?: ProviderFix;
}

/** The recorded state of one provider's last observed failure. */
export interface ProviderFailure {
  readonly failureClass: FailureClass;
  readonly detail: string;
  readonly at: number;
  /**
   * The env var the raw error named as missing, when extractable —
   * captured BEFORE sanitization because the sanitizer intentionally
   * destroys `NAME: not set` anchors (the name=value pattern redacts
   * the anchor word as a secret value). Safe to carry: it's always a
   * SCREAMING_SNAKE identifier, never a value.
   */
  readonly envVar?: string;
}

export interface ProviderReadinessOptions {
  /**
   * Reports whether known credential evidence exists for the provider.
   * Called lazily on every {@link authStateOf} so "check again" re-reads
   * the filesystem without a restart. Unknown providers return
   * `'unknown'`; an absent dep yields `unknown` for everything.
   */
  readonly credsProbe?: (providerId: string) => CredsSignal;
  /** Invoked for each newly-recorded auth/config-class failure. */
  readonly onAuthIssue?: (issue: ProviderAuthIssue) => void;
  /** Optional bus subscription — observes `AgentFailed`/`AgentStarted`/`AgentCompleted`. */
  readonly bus?: EventSubscriberPort;
  readonly now?: () => number;
}

/* ------------------------------------------------------------------ *
 * Failure classification
 * ------------------------------------------------------------------ */

/** Auth-rejected signatures — HTTP 401/403, invalid/expired OAuth, login hints. */
const AUTH_PATTERNS: readonly RegExp[] = [
  /\b401\b|\b403\b/,
  /unauthorized|forbidden|authentication failed|not authenticated/i,
  /(invalid|incorrect|expired|revoked)[ _-]?(or expired )?(api[ _]?key|grant|token|client|credential|oauth)|oauth.{0,30}(invalid|expired|revoked)|access_denied|unauthorized_client/i,
  /please (run|use) \/?login|please log ?in|please sign ?in|not logged in|sign in to continue/i,
  /token (has )?expired|expired (api ?key|token|credential|oauth|session)/i,
];

/** Missing local configuration (distinct from a rejected credential). */
const CONFIG_PATTERNS: readonly RegExp[] = [
  /GOOGLE_CLOUD_PROJECT|required (env|environment) variable/i,
  /no project (id )?(configured|found|set)/i,
];

/** Hard connection-failure tokens — checked before auth so a port like
 * `ECONNREFUSED 127.0.0.1:401` can never classify as a 401. */
const CONN_PATTERNS: readonly RegExp[] = [
  // The whole errno family — a port like `EHOSTUNREACH 10.0.0.1:403`
  // must never read its `:403` as an HTTP 403.
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNABORTED|EAI_AGAIN|EAI_NONAME|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL|EPIPE|EPROTO/,
  // `timed out`/`timeout` is a network verdict — checking it here (before
  // auth) keeps `Connection to 10.0.0.1:403 timed out` from reading the
  // port as an HTTP 403.
  /socket hang up|connection refused|connection reset|timed? ?out|timeout|dns/i,
];

/** The provider is unreachable — never an auth verdict. */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN/,
  /network (error|unreachable)|fetch failed|timed? ?out|connection refused|unreachable/i,
];

/** Rate limits and quota exhaustion — a capacity problem, not auth. */
const QUOTA_PATTERNS: readonly RegExp[] = [
  /\b429\b|insufficient_quota/i,
  /rate.?limit|quota (is )?(exceeded|exhausted)|exceeded your (current )?quota|usage limit|billing/i,
];

/** The executable itself wasn't there — install problem, not auth. */
const MISSING_PATTERNS: readonly RegExp[] = [
  /ENOENT|command not found|not found on (the )?PATH|is not installed|Unknown or unavailable adapter/i,
];

/**
 * Classify a provider/model error string into a coarse failure class.
 * Pure and conservative: ambiguous errors classify as `'unknown'`
 * rather than guessing — only `auth` and `config` ever flip a provider
 * into `auth-failing`, because those are the classes sign-in fixes.
 */
export function classifyFailureText(detail: string): FailureClass {
  // Hard connection failures first — a port number must never read as
  // an HTTP status (`ECONNREFUSED 10.0.0.1:401` is network, not auth).
  if (CONN_PATTERNS.some((p) => p.test(detail))) return 'network';
  if (AUTH_PATTERNS.some((p) => p.test(detail))) return 'auth';
  if (CONFIG_PATTERNS.some((p) => p.test(detail))) return 'config';
  if (missingEnvVarName(detail) !== undefined) return 'config';
  if (NETWORK_PATTERNS.some((p) => p.test(detail))) return 'network';
  if (QUOTA_PATTERNS.some((p) => p.test(detail))) return 'quota';
  if (MISSING_PATTERNS.some((p) => p.test(detail))) return 'missing';
  return 'unknown';
}

/**
 * The name of a missing environment variable, when the error names one.
 * The variable name is matched CASE-SENSITIVELY (SCREAMING_SNAKE,
 * digits allowed) and the missing-var anchor case-insensitively — a
 * bare case-insensitive regex lets 'the value is not set' yield a bogus
 * 'Set value' recipe. Candidates are boundary-guarded (no mid-word
 * splits like `Foo_BAR` → `BAR`) and severity/protocol words are
 * denylisted so `ERROR: X is not set` can't extract `ERROR`.
 */
export function missingEnvVarName(detail: string): string | undefined {
  const SKIP = new Set([
    'ERROR',
    'ERR',
    'WARN',
    'WARNING',
    'INFO',
    'DEBUG',
    'TRACE',
    'FATAL',
    'HTTP',
    'HTTPS',
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
    'JSON',
    'XML',
    'HTML',
    'SSL',
    'TLS',
    'TCP',
    'UDP',
    'DNS',
    'EOF',
    'URL',
    'URI',
    'API',
    // Generic nouns — 'SERVER is not set for your account' should not
    // yield a 'Set SERVER' recipe even though it names a real gap.
    'SERVER',
    'HOST',
    'PORT',
    'CONFIG',
    'REGION',
    'USER',
    'NAME',
    'VALUE',
    'FILE',
    'KEY',
    'TOKEN',
    'SECRET',
    'PASSWORD',
  ]);
  // `(?<![A-Za-z0-9_])` — the name must start a token: no mid-word
  // splits ('Foo_BAR' → no 'BAR', 'foo1BAR' → no 'BAR'). An optional
  // leading '_' keeps `_JAVA_OPTIONS`-style names extractable.
  for (const m of detail.matchAll(/(?<![A-Za-z0-9_])_?([A-Z][A-Z0-9_]{2,})/g)) {
    const name = m[1];
    if (SKIP.has(name)) continue;
    const tail = detail.slice(m.index + m[0].length, m.index + m[0].length + 80);
    // The anchor may sit behind one separator token: `FOO not set`,
    // `FOO: not set`, `FOO=1 is not set`, `FOO: required`. When that
    // token is itself a SCREAMING name, defer — it wins on its own
    // iteration ('FOO: GOOGLE_PROJECT is not set' → GOOGLE_PROJECT).
    const tm =
      /^[\s:=]+(\S+?)?\s*(?:is\s+|are\s+)?(?:not set|missing|required|not configured|unset)\b/i.exec(
        tail,
      );
    if (tm !== null) {
      const mid = tm[1];
      if (mid !== undefined && /^[A-Z][A-Z0-9_]{2,}$/.test(mid) && !SKIP.has(mid)) continue;
      return name;
    }
  }
  for (const m of detail.matchAll(
    /(?:environment variable|env(?:ironment)? var|variable)[\s:]+([A-Z][A-Z0-9_]{2,})/gi,
  )) {
    const name = m[1];
    if (name === name.toUpperCase() && !SKIP.has(name)) return name;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Remediation table
 * ------------------------------------------------------------------ */

/**
 * Provider-native fix recipes. `run-command` entries are launched in a
 * visible terminal by the `florina auth <provider>` CLI verb and the
 * desktop `setup:signin:<provider>` verb; `store-key` points at the
 * secrets vault surface (issue #292) rather than inventing a new store.
 */
const FIXES: Readonly<Record<string, ProviderFix>> = {
  'claude-code': {
    kind: 'run-command',
    label: 'Sign in to Claude Code',
    command: 'claude',
    detail: 'opens a terminal running Claude’s own sign-in — follow the prompts there',
  },
  codex: {
    kind: 'run-command',
    label: 'Sign in to Codex',
    command: 'codex login',
    detail: 'opens a terminal running `codex login` — follow the prompts there',
  },
  gemini: {
    kind: 'run-command',
    label: 'Sign in to Gemini',
    command: 'gemini',
    detail:
      'opens a terminal running `gemini` — sign in there; Gemini also needs GOOGLE_CLOUD_PROJECT set for some accounts',
  },
  devin: {
    kind: 'run-command',
    label: 'Sign in to Devin',
    command: 'devin auth login',
    detail: 'opens a terminal running `devin auth login` — follow the prompts there',
  },
  antigravity: {
    kind: 'run-command',
    label: 'Sign in to Antigravity',
    command: 'agy',
    detail: 'opens a terminal running `agy` — sign in there',
  },
  'chat-model': {
    kind: 'store-key',
    label: 'Add the model API key',
    // `keys set openai-api-key` derives OPENAI_API_KEY — the name the
    // chat-model credential resolver actually matches (issue #294
    // review: the earlier text stored a key nothing resolved).
    detail:
      'store the key in Florina’s key vault — run `florina keys set openai-api-key`, ' +
      'or use Settings → API keys in the app',
  },
};

/* ------------------------------------------------------------------ *
 * Installer table — verified official install commands only
 * ------------------------------------------------------------------ */

/**
 * An installer recipe we can offer when the provider CLI isn't found.
 * `command` runs in a *visible* terminal (the user watches their own
 * machine run the official installer — consent is the explicit verb,
 * never silent background package mutation). `null` on a platform we
 * haven't verified an official command for → the caller prints manual
 * instructions instead of guessing.
 *
 * Every entry was verified against the provider's official install docs
 * or exercised live during the #294 proof session.
 */
export interface ProviderInstaller {
  readonly label: string;
  readonly command: string;
  readonly detail: string;
}

const INSTALLERS: Readonly<
  Record<string, Readonly<Partial<Record<string, ProviderInstaller | null>>>>
> = {
  'claude-code': {
    win32: {
      label: 'Install Claude Code',
      command: 'npm i -g @anthropic-ai/claude-code',
      detail: 'opens a terminal running the official Claude Code install (npm)',
    },
    darwin: {
      label: 'Install Claude Code',
      command: 'npm i -g @anthropic-ai/claude-code',
      detail: 'opens a terminal running the official Claude Code install (npm)',
    },
    linux: {
      label: 'Install Claude Code',
      command: 'npm i -g @anthropic-ai/claude-code',
      detail: 'opens a terminal running the official Claude Code install (npm)',
    },
  },
  codex: {
    win32: {
      label: 'Install Codex',
      command: 'npm i -g @openai/codex',
      detail: 'opens a terminal running the official Codex install (npm)',
    },
    darwin: {
      label: 'Install Codex',
      command: 'npm i -g @openai/codex',
      detail: 'opens a terminal running the official Codex install (npm)',
    },
    linux: {
      label: 'Install Codex',
      command: 'npm i -g @openai/codex',
      detail: 'opens a terminal running the official Codex install (npm)',
    },
  },
  gemini: {
    win32: {
      label: 'Install Gemini CLI',
      command: 'npm i -g @google/gemini-cli',
      detail: 'opens a terminal running the official Gemini CLI install (npm)',
    },
    darwin: {
      label: 'Install Gemini CLI',
      command: 'npm i -g @google/gemini-cli',
      detail: 'opens a terminal running the official Gemini CLI install (npm)',
    },
    linux: {
      label: 'Install Gemini CLI',
      command: 'npm i -g @google/gemini-cli',
      detail: 'opens a terminal running the official Gemini CLI install (npm)',
    },
  },
  devin: {
    // Official Windows installer (docs.devin.ai/cli — verified live):
    // a PowerShell script that downloads the CLI AND auto-launches its
    // login prompt at the end — install and sign-in are one journey.
    win32: {
      label: 'Install the Devin CLI',
      command: 'powershell -NoProfile -Command "irm https://static.devin.ai/cli/setup.ps1 | iex"',
      detail:
        'opens a terminal running Devin’s official installer — it will also walk you through sign-in when it finishes',
    },
    // macOS/Linux: docs show a curl installer but we haven't verified
    // the exact URL on this codebase's supported set — manual guidance.
    darwin: null,
    linux: null,
  },
  antigravity: {
    // Official Windows installer (antigravity.google/docs/cli — verified
    // live): registers %LOCALAPPDATA%\agy\bin on the user PATH.
    win32: {
      label: 'Install the Antigravity CLI',
      command:
        'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"',
      detail: 'opens a terminal running Antigravity’s official installer',
    },
    darwin: null,
    linux: null,
  },
};

/** The verified installer for a provider on this platform, or null. */
export function providerInstaller(providerId: string, platform: string): ProviderInstaller | null {
  return INSTALLERS[providerId]?.[platform] ?? null;
}

/** Provider ids that carry a verified installer recipe (INSTALLERS key set). */
export function providerInstallerIds(): readonly string[] {
  return Object.keys(INSTALLERS);
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

/**
 * Tracks per-provider auth state from the two honest local evidence
 * sources (credential-file probe + observed runtime failures) and raises
 * one attention issue per auth-class failure via `onAuthIssue`.
 */
export class ProviderReadiness {
  private readonly credsProbe?: (providerId: string) => CredsSignal;
  private readonly onAuthIssue?: (issue: ProviderAuthIssue) => void;
  private readonly bus?: EventSubscriberPort;
  private readonly now: () => number;
  private readonly failures = new Map<string, ProviderFailure>();
  /** Providers that completed a real turn/run since the last failure. */
  private readonly succeeded = new Map<string, number>();
  private unsubscribe?: () => void;

  constructor(options: ProviderReadinessOptions = {}) {
    this.credsProbe = options.credsProbe;
    this.onAuthIssue = options.onAuthIssue;
    this.bus = options.bus;
    this.now = options.now ?? (() => Date.now());
  }

  /** Subscribe to the bus. Safe to call once; pair with {@link stop}. */
  start(): void {
    if (this.unsubscribe !== undefined || this.bus === undefined) return;
    this.unsubscribe = this.bus.onEvent((event) => this.handleEvent(event));
  }

  stop(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /**
   * Record a runtime failure attributed to `providerId`. Classifies the
   * error; `auth`/`config` classes mark the provider `auth-failing` and
   * fire `onAuthIssue` (the aggregator dedupes repeated firing).
   * Any listener exception is contained — this runs inside dispatch and
   * event paths that must never break.
   */
  recordFailure(providerId: string, error: unknown): FailureClass {
    // Classify and extract on the RAW text — the sanitizer deliberately
    // destroys `NAME: not set` anchors (name=value eats the anchor word
    // as a "secret"), so running either on sanitized text silently
    // downgrades real config failures to 'unknown'. Sanitization only
    // guards what we STORE and SHOW.
    let raw: string;
    try {
      raw = error instanceof Error ? error.message : String(error);
    } catch {
      raw = '[unprintable error]';
    }
    if (typeof raw !== 'string') raw = '[unprintable error]';
    const failureClass = classifyFailureText(raw);
    const envVar = failureClass === 'config' ? missingEnvVarName(raw) : undefined;
    const detail = sanitizeFailureText(raw);
    // Client-supplied agentIds could grow these maps unboundedly —
    // evict the oldest entries past the cap.
    if (this.failures.size >= 500) {
      this.failures.delete(this.failures.keys().next().value as string);
    }
    this.failures.set(providerId, {
      failureClass,
      detail,
      at: this.now(),
      ...(envVar !== undefined ? { envVar } : {}),
    });
    if (failureClass === 'auth' || failureClass === 'config') {
      try {
        this.onAuthIssue?.({
          providerId,
          failureClass,
          detail,
          fix: providerFixFor(providerId, failureClass, detail, envVar),
        });
      } catch {
        /* the issue sink must never break the failure path */
      }
    }
    return failureClass;
  }

  /** Record an observed success — clears any standing failure record. */
  recordSuccess(providerId: string): void {
    this.failures.delete(providerId);
    if (this.succeeded.size >= 500) {
      this.succeeded.delete(this.succeeded.keys().next().value as string);
    }
    this.succeeded.set(providerId, this.now());
  }

  /**
   * Whether a real success was observed since the last failure for the
   * provider this run — a failure recorded *after* a success means the
   * success is stale evidence, not current health.
   */
  hasSucceeded(providerId: string): boolean {
    const at = this.succeeded.get(providerId);
    if (at === undefined) return false;
    const failure = this.failures.get(providerId);
    return failure === undefined || at > failure.at;
  }

  /** The last classified failure for a provider, if one stands. */
  lastFailure(providerId: string): ProviderFailure | undefined {
    return this.failures.get(providerId);
  }

  /**
   * Derive the current auth state from failure records first (observed
   * evidence trumps file presence), then the credential probe.
   */
  authStateOf(providerId: string): ProviderAuthState {
    const failure = this.failures.get(providerId);
    if (failure !== undefined) {
      return failure.failureClass === 'auth' || failure.failureClass === 'config'
        ? 'auth-failing'
        : 'unknown';
    }
    let creds: CredsSignal = 'unknown';
    try {
      creds = this.credsProbe?.(providerId) ?? 'unknown';
    } catch {
      // A throwing probe is no evidence — never let it claim absence.
      creds = 'unknown';
    }
    if (creds === 'present') return 'signed-in';
    if (creds === 'absent') return 'found-not-signed-in';
    return 'unknown';
  }

  /**
   * The provider's remediation recipe, when one is known. For `config`
   * failures the sign-in recipe is wrong — the missing piece is an env
   * var, so the fix names it directly (`set-env`), extracted from the
   * error text when identifiable.
   */
  fixFor(
    providerId: string,
    failureClass?: FailureClass,
    detail?: string,
  ): ProviderFix | undefined {
    // Standing-failure context defaults from state — callers that don't
    // know the class still get the right recipe. The pre-sanitization
    // envVar survives even when the stored detail lost its anchor.
    const standing = this.lastFailure(providerId);
    const cls = failureClass ?? standing?.failureClass;
    const text = detail ?? standing?.detail;
    return providerFixFor(providerId, cls, text, standing?.envVar);
  }

  /** Bus events: a failure classifies; a started/completed run clears it. */
  private handleEvent(event: SupervisorEvent): void {
    // `provenance: 'observed'` events are provider-native activity Florina
    // did not dispatch — never feed readiness claims from them (same
    // boundary the attention aggregator keeps).
    if (event.provenance === 'observed') return;
    if (event.type === 'AgentFailed') {
      this.recordFailure(event.agentId, event.error);
    } else if (event.type === 'AgentStarted' || event.type === 'AgentCompleted') {
      this.recordSuccess(event.agentId);
    }
  }
}

/** Provider ids that carry a remediation recipe (the FIXES key set). */
export function providerFixIds(): readonly string[] {
  return Object.keys(FIXES);
}

/**
 * Resolve the remediation recipe for a provider, honoring failure
 * context. A `config`-class failure NEVER returns the sign-in recipe —
 * a missing env var is not fixed by running the provider's login: when
 * the error names the variable the fix names it (`set-env` with the var
 * as `command`); otherwise the fix instructs the user to read the error
 * detail for the variable name.
 */
export function providerFixFor(
  providerId: string,
  failureClass?: FailureClass,
  detail?: string,
  envVar?: string,
): ProviderFix | undefined {
  if (failureClass === 'config') {
    const name = envVar ?? (detail !== undefined ? missingEnvVarName(detail) : undefined);
    if (name !== undefined) {
      return {
        kind: 'set-env',
        label: `Set ${name}`,
        command: name,
        detail: `set the ${name} environment variable, then restart Florina’s helper (tray → Stop daemon → Start)`,
      };
    }
    return {
      kind: 'set-env',
      label: 'Set the missing environment variable',
      detail:
        'the provider reported a missing environment variable — the error detail above ' +
        'names it; set it, then restart Florina’s helper (tray → Stop daemon → Start)',
    };
  }
  return FIXES[providerId];
}

/**
 * Render an unknown error as a bounded, secret-free detail string.
 * Providers can echo request URLs, auth headers, and key material into
 * errors — strip every common credential shape and all control
 * characters before the text reaches state, journals, cards, or
 * terminal output. Whitespace-class controls become a space (so a tab
 * can't fuse a secret onto its key name); all other control bytes are
 * deleted so a credential split by a control byte still matches. The
 * input is bounded BEFORE regexing — the generic name pattern on an
 * unbounded echoed body is a quadratic-backtracking stall.
 */
export function sanitizeFailureText(error: unknown): string {
  let raw: string;
  try {
    raw = error instanceof Error ? error.message : String(error);
  } catch {
    // An exotic error object (null-prototype, throwing toString) must
    // never break the failure path that called us.
    return '[unprintable error]';
  }
  if (typeof raw !== 'string') return '[unprintable error]';
  return (
    raw
      .slice(0, 2000)
      // eslint-disable-next-line no-control-regex -- deliberate
      .replace(/[\u0009-\u000d]/g, ' ')
      // eslint-disable-next-line no-control-regex -- deliberate
      .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, '')
      .replace(/-----BEGIN [A-Z ]*-----[\s\S]*?-----END [A-Z ]*-----/g, 'PEM…')
      // URL userinfo credentials: `https://user:pass@host`.
      .replace(/:\/\/[^\s/:]+:[^\s@]+@/g, '://…:…@')
      // Any auth scheme — Basic, Bearer, Digest, Token, ApiKey,
      // AWS4-HMAC-SHA256, … — including a single-token header and a
      // space before the colon.
      .replace(/Authorization\s*:\s*\S+(?:\s+\S+)?/gi, 'Authorization: …')
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
      .replace(
        /\b(sk_live|sk_test|sk_prod|rk_live|whsec|xapp|glpat|glrt|shpat|npm|pypi|dop_v1|xai|lin_api)[_-][A-Za-z0-9_-]{5,}/g,
        '$1…',
      )
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'eyJ…')
      .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 …')
      .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)[_-][A-Za-z0-9_]{8,}/g, '$1…')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, 'xox-…')
      .replace(/\bya29\.[A-Za-z0-9_-]{10,}/g, 'ya29…')
      .replace(/\bAKIA[0-9A-Z]{12,}/g, 'AKIA…')
      .replace(/\b0x[0-9a-fA-F]{40,}\b/g, '0x…')
      // Generic name=value / name: value — identifier containing a
      // sensitive word (digits allowed; over-redaction like `compass=`
      // is the safe direction). Name runs bounded at 64 chars (no
      // quadratic probing), quotes allowed around name/value, and a
      // fully-quoted value is consumed whole so multi-word secrets
      // can't leak their tail.
      .replace(
        /[\w"']{0,64}(?:key|token|secret|password|passwd|pass|pwd|auth|bearer|credential|signature|sig|session|cookie|private)[\w"']{0,64}\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s&;,}"']+)/gi,
        (m) => {
          // The name class contains no '=' or ':' — the first occurrence
          // is always the separator, never a byte inside the value.
          const sep = m.search(/[=:]/);
          return m.slice(0, sep + 1) + '…';
        },
      )
      .slice(0, 500)
  );
}
