/**
 * Provider manifests (issue #300): the single declarative source of
 * truth for everything Florina knows about a local agent provider.
 *
 * Before this file, a provider was scattered across a handwritten
 * attachment block in `agent-providers.ts`, a `FIXES` entry, an
 * `INSTALLERS` entry, and a `CREDENTIAL_EVIDENCE` entry — drift-shaped
 * bugs were the predictable result (a wrong sign-in subcommand, two
 * providers with no credential probe at all). Now: **one manifest entry
 * per provider** drives all of it —
 *
 *   - executable resolution (PATH name, `FLORINA_*_CMD` override,
 *     beyond-PATH candidates as declarative specs the platform layer
 *     interprets — this file is pure data, no Node APIs);
 *   - transport (how the resolved command becomes an adapter — the
 *     composition root maps `transport.kind` to a concrete adapter);
 *   - credential evidence (existence-only probes — never a secret read);
 *   - the sign-in fix recipe;
 *   - verified official installers per platform.
 *
 * **Adding a provider = one entry here** plus, only when it needs a
 * transport kind that doesn't exist yet, one arm in the attachment
 * switch and one adapter class.
 *
 * Safety invariants (enforced by tests):
 *  - Every manifest carries `docsUrl` — the official install/setup
 *    documentation that backs its installer entries. No URL, no entry.
 *  - `installers` holds `null` on platforms we haven't verified —
 *    callers turn that into manual instructions; nothing invents a
 *    command.
 *  - Credential evidence describes *existence probes only*: file paths,
 *    env-var names, keychain service / credential-manager target names.
 *    The probe reads metadata, never values.
 */
import type { ProviderFix, ProviderInstaller } from './provider-readiness.js';

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

/**
 * A value keyed by host platform. Missing key = not supported there —
 * except `default`, which applies to every platform without a specific
 * entry (a genuinely cross-platform npm install command, or a
 * `~/.codex`-style path that exists on any unix-ish host — including
 * the `NodeJS.Platform` members beyond the big three, like `android`
 * and `freebsd`, that the pre-manifest `else` used to cover).
 *
 * An *explicit* `null` entry (installer cells only) is a deliberate
 * "nothing verified here → manual instructions" marker and WINS over
 * `default` — presence, not truthiness, decides.
 */
export interface PerPlatform<T> {
  readonly win32?: T;
  readonly darwin?: T;
  readonly linux?: T;
  readonly default?: T;
}

/**
 * Platform-specific entry first, then the cross-platform default. An
 * explicitly-present entry (even `null`) beats `default` — otherwise a
 * `win32: null` "unverified on Windows" marker would silently fall back
 * to a guessed command.
 */
export function perPlatform<T>(map: PerPlatform<T> | undefined, platform: string): T | undefined {
  if (map === undefined) return undefined;
  const keyed = map as Record<string, T | undefined>;
  return Object.hasOwn(keyed, platform) ? keyed[platform] : map.default;
}

/**
 * Where to look for the executable beyond PATH. Purely declarative —
 * the bootstrap resolver interprets each spec against the real fs.
 * `{home}` and `{localAppData}` placeholders in `path` are substituted
 * by the resolver (specs never see real directories at rest).
 */
export type ExtraCandidate =
  /**
   * A literal path — absolute, or `{home}`/`{localAppData}`-anchored.
   * e.g. `{home}/.codex/.sandbox-bin/codex`.
   */
  | { readonly kind: 'path'; readonly path: string }
  /**
   * Scan `<base>/<dir>` for `<file>` directly and one level deep —
   * codex on Windows lives at
   * `%LOCALAPPDATA%/OpenAI/Codex/bin/<version>/codex.exe`.
   */
  | {
      readonly kind: 'scan';
      readonly base: 'localAppData' | 'home';
      readonly dir: string;
      readonly file: string;
    };

/**
 * How a resolved executable becomes an adapter. **A `kind` maps 1:1 to a
 * concrete adapter class** in the attachment switch (hooks →
 * ClaudeHooksAdapter, acp → AcpAdapter, app-server → CodexAdapter,
 * stream-json → AgyAdapter) — the kind names the wire protocol, and the
 * adapter class that speaks it today. A new provider on an existing
 * kind reuses that adapter: fine when it truly speaks the same protocol
 * (another ACP agent needs nothing but `args`), wrong when the adapter
 * bakes in provider-specific invocation (e.g. `stream-json` today means
 * "agy's exact `-p --output-format stream-json`"). If the second
 * provider on a kind needs different invocation, extend that variant
 * with parameters or add a new kind — don't silently reuse.
 */
export type ProviderTransport =
  /** Claude Code hooks adapter — command runs the CLI per run. */
  | { readonly kind: 'hooks' }
  /**
   * ACP adapter — the command is invoked with `args` per run
   * (`devin acp`, `gemini --experimental-acp`).
   */
  | { readonly kind: 'acp'; readonly args: readonly string[] }
  /**
   * A long-lived app-server child: spawn
   * `<command> <args…>` with `{endpoint}` substituted for the chosen
   * `ws://127.0.0.1:<port>`, wait up to `readyTimeoutMs` for the port,
   * then register the WS adapter against that endpoint. Children are
   * killed on dispose.
   */
  | {
      readonly kind: 'app-server';
      readonly args: readonly string[];
      readonly readyTimeoutMs: number;
    }
  /** Headless stream-json adapter (agy). */
  | { readonly kind: 'stream-json' };

/**
 * Local sign-in evidence — existence probes only, never a read of the
 * credential itself. Interpreted by the composition-root probe against
 * the live OS (files/env always, keychain on darwin, Credential Manager
 * on win32); a provider with no consultable source on this platform
 * degrades to 'unknown', never a false "not signed in".
 */
export interface CredentialEvidenceSpec {
  /** Home-relative paths ('/'-separated — the probe joins them). */
  readonly files: readonly string[];
  /**
   * Paths relative to `$XDG_DATA_HOME` (falling back to
   * `~/.local/share`) — CLIs that follow the XDG base-dir spec, e.g.
   * devin's `credentials.toml` at `$XDG_DATA_HOME/devin/…` on macOS and
   * Linux alike.
   */
  readonly xdgDataFiles?: readonly string[];
  /** Provider-blessed environment variables that carry a credential. */
  readonly envVars: readonly string[];
  /**
   * macOS Keychain items holding credentials (darwin only). A provider
   * may consult several secure stores — Copilot checks its own
   * `copilot-cli` entry and falls back to the GitHub CLI's
   * `gh:github.com` entry, so this is a list, not a single service.
   *
   * `account` is probed via `security find-generic-password -s
   * <service> -a <account>` — a service name alone over-reports (any
   * other item under the same service counts as evidence).
   */
  readonly darwinKeychains?: readonly {
    readonly service: string;
    readonly account?: string;
  }[];
  /**
   * Windows Credential Manager generic targets (win32 only) — plural
   * for the same multi-store reason as {@link darwinKeychains}.
   * Probed by exact name via `cmdkey /list:<target>`.
   */
  readonly winCredTargets?: readonly string[];
  /**
   * Windows Credential Manager target *patterns* (win32 only) —
   * matched against the `Target:` lines of a full `cmdkey /list`
   * dump. Needed when the target embeds a per-account segment that
   * exact-match can't name statically: Copilot's entries render as
   * `https://github.com:<user>.copilot-cli` (verified live), so a
   * `copilot-cli` substring pattern is the honest probe.
   */
  readonly winCredTargetPatterns?: readonly RegExp[];
  /**
   * Platforms whose primary credential store we cannot generically
   * probe (e.g. Linux Secret Service via D-Bus — there is no
   * service-name CLI lookup). On these platforms a miss is honest
   * `unknown`, never a false `absent` — file/env hits still report
   * `present`.
   */
  readonly unprobeablePlatforms?: readonly string[];
  /**
   * Home-relative paths whose existence makes a credential *miss*
   * inconclusive — 'unknown' instead of 'absent'. For stores whose
   * content an existence probe cannot read: OpenCode v2 keeps
   * credentials inside `opencode.db`, but the file exists from first
   * launch whether or not it holds a credential row — so its presence
   * can never prove a sign-in AND can never disprove one either.
   */
  readonly uncertainFiles?: readonly string[];
  /** XDG-data-relative variant of {@link uncertainFiles}. */
  readonly uncertainXdgDataFiles?: readonly string[];
}

/** One provider's complete declarative spec — the ONLY place it's defined. */
export interface ProviderManifest {
  /** Provider id — equals the adapter id registered in the registry. */
  readonly id: string;
  /**
   * Official install/setup documentation URL — the audit trail behind
   * every installer entry and the link a maintainer re-verifies against.
   */
  readonly docsUrl: string;
  /** Env var overriding executable resolution (`FLORINA_GEMINI_CMD`). */
  readonly envOverride: string;
  /** Executable name resolved on PATH. */
  readonly executable: string;
  /** Beyond-PATH candidates per platform (desktop-bundle paths, …). */
  readonly extraCandidates?: PerPlatform<readonly ExtraCandidate[]>;
  /** How the resolved executable becomes a registered adapter. */
  readonly transport: ProviderTransport;
  /**
   * The user-facing "not installed" reason — names where we looked so
   * the user can fix PATH or set the env override.
   */
  readonly notFoundDetail: string;
  /** Local credential evidence spec (existence probes only). */
  readonly credentialEvidence: CredentialEvidenceSpec;
  /** The sign-in fix recipe. */
  readonly signIn: ProviderFix;
  /** Verified official installers; absent/null platform → manual. */
  readonly installers: PerPlatform<ProviderInstaller | null>;
}

/* ------------------------------------------------------------------ *
 * The registry — one entry per provider, nothing else needed
 * ------------------------------------------------------------------ */

// `npm view` verified each package publishes exactly the bin name the
// manifest probes for (`claude`, `codex`, `gemini`, `copilot`,
// `opencode`). `opencode-ai` declares os/cpu restrictions (darwin/
// linux/win32 × arm64/x64) — it must NOT hang off `default`; explicit
// cells live on its entry. The others publish unrestricted packages.
// (issue #302/#304 — claims are metadata-backed, not assumed)
const NPM = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  gemini: 'npm i -g @google/gemini-cli',
  copilot: 'npm i -g @github/copilot',
  opencode: 'npm i -g opencode-ai',
} as const;

/**
 * Deep-freeze manifests: FIXES/INSTALLERS/CREDENTIAL_EVIDENCE snapshot
 * these entries at module-eval, so runtime mutation would desync
 * derived tables from the live array — and nested objects (installers,
 * transport, evidence) are shared by reference into those tables.
 * Authors edit source, not the object.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const PROVIDER_MANIFESTS: readonly ProviderManifest[] = Object.freeze(
  (
    [
      {
        id: 'claude-code',
        docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
        envOverride: 'FLORINA_CLAUDE_CMD',
        executable: 'claude',
        transport: { kind: 'hooks' },
        notFoundDetail: '`claude` CLI not found on PATH',
        credentialEvidence: {
          files: ['.claude/.credentials.json'],
          envVars: ['ANTHROPIC_API_KEY'],
          darwinKeychains: [{ service: 'Claude Code-credentials' }],
        },
        signIn: {
          kind: 'run-command',
          label: 'Sign in to Claude Code',
          command: 'claude',
          detail: 'opens a terminal running Claude’s own sign-in — follow the prompts there',
        },
        installers: {
          // One official npm package on every platform — `default`
          // states that cross-platform claim honestly.
          default: {
            label: 'Install Claude Code',
            command: NPM.claude,
            detail: 'opens a terminal running the official Claude Code install (npm)',
          },
        },
      },
      {
        id: 'codex',
        docsUrl: 'https://developers.openai.com/codex/cli',
        envOverride: 'FLORINA_CODEX_CMD',
        executable: 'codex',
        extraCandidates: {
          // `default` — the sandbox-bin layout exists on every non-win32
          // platform (and exotic ones: android, freebsd, …), matching the
          // pre-manifest `else` fallback exactly.
          default: [{ kind: 'path', path: '{home}/.codex/.sandbox-bin/codex' }],
          win32: [
            { kind: 'path', path: '{home}/.codex/.sandbox-bin/codex.exe' },
            // Codex desktop installer layout — versions live one level deep.
            { kind: 'scan', base: 'localAppData', dir: 'OpenAI/Codex/bin', file: 'codex.exe' },
          ],
        },
        transport: {
          kind: 'app-server',
          args: ['app-server', '--listen', '{endpoint}'],
          readyTimeoutMs: 8_000,
        },
        notFoundDetail:
          '`codex` CLI not found (PATH, ~/.codex/.sandbox-bin, or LocalAppData/OpenAI/Codex)',
        credentialEvidence: {
          files: ['.codex/auth.json'],
          envVars: ['OPENAI_API_KEY'],
        },
        signIn: {
          kind: 'run-command',
          label: 'Sign in to Codex',
          command: 'codex login',
          detail: 'opens a terminal running `codex login` — follow the prompts there',
        },
        installers: {
          // One official npm package on every platform — `default`
          // states that cross-platform claim honestly.
          default: {
            label: 'Install Codex',
            command: NPM.codex,
            detail: 'opens a terminal running the official Codex install (npm)',
          },
        },
      },
      {
        id: 'gemini',
        docsUrl: 'https://github.com/google-gemini/gemini-cli',
        envOverride: 'FLORINA_GEMINI_CMD',
        executable: 'gemini',
        transport: { kind: 'acp', args: ['--experimental-acp'] },
        notFoundDetail: '`gemini` CLI not found on PATH',
        credentialEvidence: {
          files: [
            '.gemini/oauth_creds.json',
            // Application Default Credentials — the gcloud auth path.
            '.config/gcloud/application_default_credentials.json',
          ],
          envVars: ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
        },
        signIn: {
          kind: 'run-command',
          label: 'Sign in to Gemini',
          command: 'gemini',
          detail:
            'opens a terminal running `gemini` — sign in there; Gemini also needs GOOGLE_CLOUD_PROJECT set for some accounts',
        },
        installers: {
          // One official npm package on every platform — `default`
          // states that cross-platform claim honestly.
          default: {
            label: 'Install Gemini CLI',
            command: NPM.gemini,
            detail: 'opens a terminal running the official Gemini CLI install (npm)',
          },
        },
      },
      {
        id: 'devin',
        docsUrl: 'https://docs.devin.ai/cli',
        envOverride: 'FLORINA_DEVIN_CMD',
        executable: 'devin',
        extraCandidates: {
          // The Devin desktop app bundles the CLI — usable headlessly even
          // when the standalone CLI isn't on PATH. The official unix
          // installer lands at ~/.local/bin/devin (docs.devin.ai/cli).
          win32: [
            {
              kind: 'path',
              path: '{localAppData}/Programs/Devin/resources/app/extensions/windsurf/devin/bin/devin.exe',
            },
          ],
          darwin: [
            {
              kind: 'path',
              path: '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin',
            },
            { kind: 'path', path: '{home}/.local/bin/devin' },
            // brew install --cask devin-cli → $HOMEBREW_PREFIX/bin/devin
            { kind: 'path', path: '/opt/homebrew/bin/devin' },
            { kind: 'path', path: '/usr/local/bin/devin' },
          ],
          linux: [{ kind: 'path', path: '{home}/.local/bin/devin' }],
        },
        transport: { kind: 'acp', args: ['acp'] },
        notFoundDetail: '`devin` CLI not found (PATH, ~/.local/bin, or Devin app bundle)',
        credentialEvidence: {
          // docs.devin.ai/cli/enterprise/devin-auth: `devin auth login`
          // writes credentials.toml to %APPDATA%\devin on Windows and to
          // $XDG_DATA_HOME/devin (default ~/.local/share/devin) on macOS
          // AND Linux — the same XDG path on both; ~/Library/Application
          // Support is NOT used. (`devin auth status` prints the path.)
          files: ['AppData/Roaming/devin/credentials.toml'],
          xdgDataFiles: ['devin/credentials.toml'],
          // WINDSURF_API_KEY is the documented ACP credential var
          // (docs.devin.ai/cli/reference/commands); DEVIN_API_KEY is the
          // REST-API var third-party adapters report the CLI honoring.
          envVars: ['DEVIN_API_KEY', 'WINDSURF_API_KEY'],
        },
        signIn: {
          kind: 'run-command',
          label: 'Sign in to Devin',
          // Verified live: `devin login` is parsed as a PATH argument — the
          // real subcommand is `devin auth login`.
          command: 'devin auth login',
          detail:
            'opens a terminal running `devin auth login` — follow the prompts there (SSH/headless: `devin auth login --force-manual-token-flow`)',
        },
        installers: {
          // Official Windows installer (verified live): downloads the CLI
          // AND auto-launches its login prompt — install + sign-in are one
          // journey there.
          win32: {
            label: 'Install the Devin CLI',
            command:
              'powershell -NoProfile -Command "irm https://static.devin.ai/cli/setup.ps1 | iex"',
            detail:
              'opens a terminal running Devin’s official installer — it will also walk you through sign-in when it finishes',
          },
          // docs.devin.ai/cli — official script; installs to ~/.local/bin.
          // Explicit cells, not `default`: the script exits "Unsupported
          // platform" on OSes beyond macOS/Linux (WSL counts as Linux).
          darwin: {
            label: 'Install the Devin CLI',
            command: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
            detail:
              'opens a terminal running Devin’s official installer (macOS alternative: brew install --cask devin-cli)',
          },
          linux: {
            label: 'Install the Devin CLI',
            command: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
            detail: 'opens a terminal running Devin’s official installer (covers WSL too)',
          },
        },
      },
      {
        id: 'antigravity',
        docsUrl: 'https://www.antigravity.google/docs/cli/install/',
        envOverride: 'FLORINA_AGY_CMD',
        // The headless binary is `agy` — the Antigravity *IDE* is a
        // different install and is NOT evidence this CLI exists.
        executable: 'agy',
        extraCandidates: {
          // Official installers register the binary on PATH — a running
          // daemon's env is a startup snapshot and never sees the new
          // entry, so probe the real locations directly (issue #301).
          // win32: %LOCALAPPDATA%\agy\bin (live-verified). unix: the
          // install.sh script lands at ~/.local/bin/agy; the brew cask
          // (`brew install --cask antigravity-cli`) lands at the arm64
          // homebrew prefix.
          win32: [{ kind: 'path', path: '{localAppData}/agy/bin/agy.exe' }],
          darwin: [
            { kind: 'path', path: '{home}/.local/bin/agy' },
            // brew install --cask antigravity-cli → $HOMEBREW_PREFIX/bin/agy
            { kind: 'path', path: '/opt/homebrew/bin/agy' },
            { kind: 'path', path: '/usr/local/bin/agy' },
          ],
          linux: [{ kind: 'path', path: '{home}/.local/bin/agy' }],
        },
        transport: { kind: 'stream-json' },
        notFoundDetail:
          '`agy` headless CLI not found on PATH. It is a standalone CLI install, not bundled ' +
          'inside the Antigravity IDE app folder. Once installed, either put it on PATH or ' +
          'set FLORINA_AGY_CMD to its path.',
        credentialEvidence: {
          // agy keeps its OAuth token in the OS keyring — the vendored
          // go-keyring in the binary uses service `gemini`, account
          // `antigravity` on every platform: rendered `gemini:antigravity`
          // in Windows Credential Manager (verified live), svce=gemini /
          // acct=antigravity in the macOS login keychain (upstream issue
          // evidence — pending a real-Mac check). SSH/headless sessions
          // (and GEMINI_FORCE_FILE_STORAGE) fall back to a file under
          // ~/.gemini — probe-able on every OS. Linux's primary store is
          // Secret Service over D-Bus — no generic existence probe, so a
          // miss there stays 'unknown', never a false "not signed in".
          files: ['.gemini/antigravity-cli/antigravity-oauth-token'],
          // Deliberately no envVars: agy documents GEMINI_API_KEY and the
          // enterprise ADC path (AGY_ADC_AUTH+GOOGLE_APPLICATION_CREDENTIALS)
          // but both only count when settings.json opts in — presence alone
          // is not evidence, and the spec can't express compound conditions.
          envVars: [],
          winCredTargets: ['gemini:antigravity'],
          darwinKeychains: [{ service: 'gemini', account: 'antigravity' }],
          unprobeablePlatforms: ['linux'],
        },
        signIn: {
          kind: 'run-command',
          label: 'Sign in to Antigravity',
          command: 'agy',
          detail: 'opens a terminal running `agy` — sign in there',
        },
        installers: {
          // Official installer (verified live): registers
          // %LOCALAPPDATA%\agy\bin on the user PATH.
          win32: {
            label: 'Install the Antigravity CLI',
            command:
              'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"',
            detail: 'opens a terminal running Antigravity’s official installer',
          },
          // antigravity.google/docs/cli/install — official script, lands
          // at ~/.local/bin/agy. Explicit cells, not `default`: only
          // macOS/Linux are documented (brew cask exists on macOS as an
          // alternative).
          darwin: {
            label: 'Install the Antigravity CLI',
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
            detail:
              'opens a terminal running Antigravity’s official installer (macOS alternative: brew install --cask antigravity-cli)',
          },
          linux: {
            label: 'Install the Antigravity CLI',
            command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
            detail: 'opens a terminal running Antigravity’s official installer',
          },
        },
      },
      {
        // GitHub Copilot CLI — docs.github.com/en/copilot. The `--acp`
        // flag runs a real ACP server over stdio (public preview, same
        // caveat status as gemini's flag).
        id: 'copilot',
        docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/install-copilot-cli',
        envOverride: 'FLORINA_COPILOT_CMD',
        executable: 'copilot',
        extraCandidates: {
          // winget portable install lands in WinGet/Links; npm global
          // bin in %APPDATA%\npm — both invisible to a daemon whose
          // PATH snapshot predates the install.
          win32: [
            { kind: 'path', path: '{localAppData}/Microsoft/WinGet/Links/copilot.exe' },
            { kind: 'path', path: '{home}/AppData/Roaming/npm/copilot.cmd' },
          ],
          // Install-script PREFIX default is ~/.local (non-root) or
          // /usr/local (root); brew cask lands in the brew prefix.
          default: [
            { kind: 'path', path: '{home}/.local/bin/copilot' },
            { kind: 'path', path: '/usr/local/bin/copilot' },
          ],
          darwin: [
            { kind: 'path', path: '{home}/.local/bin/copilot' },
            { kind: 'path', path: '/usr/local/bin/copilot' },
            { kind: 'path', path: '/opt/homebrew/bin/copilot' },
          ],
          linux: [
            { kind: 'path', path: '{home}/.local/bin/copilot' },
            { kind: 'path', path: '/usr/local/bin/copilot' },
            { kind: 'path', path: '/home/linuxbrew/.linuxbrew/bin/copilot' },
          ],
        },
        transport: { kind: 'acp', args: ['--acp'] },
        notFoundDetail:
          '`copilot` CLI not found on PATH (also checked ~/.local/bin, ' +
          'Homebrew prefixes, and WinGet links). Install it, put it on ' +
          'PATH, or set FLORINA_COPILOT_CMD to its path.',
        credentialEvidence: {
          // Copilot accepts five credential sources in order (docs):
          // COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN env vars,
          // the OS keychain under service `copilot-cli`, and finally a
          // `gh auth token` fallback — so gh's own stores count as
          // evidence too (`gh:github.com:` keyring target verified live
          // on Windows; go-keyring uses the same service on macOS).
          // Copilot's own credman target embeds the account name
          // (`https://github.com:<user>.copilot-cli` — live-verified
          // after `copilot login`), so it is a pattern, not an exact
          // target. config.json is included because it is the
          // documented plaintext token fallback when no system keychain
          // exists — it can over-report a first-run-without-auth, which
          // self-corrects honestly (headless dispatch fails auth → the
          // auth-failing card routes the user back to sign-in). Linux's
          // primary store is libsecret (D-Bus — unprobeable), so a miss
          // there degrades to 'unknown', never a false "not signed in".
          files: [
            '.copilot/config.json',
            '.config/gh/hosts.yml',
            'AppData/Roaming/GitHub CLI/hosts.yml',
          ],
          envVars: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
          darwinKeychains: [{ service: 'copilot-cli' }, { service: 'gh:github.com' }],
          winCredTargets: ['gh:github.com:'],
          winCredTargetPatterns: [/copilot-cli/],
          unprobeablePlatforms: ['linux'],
        },
        signIn: {
          kind: 'run-command',
          label: 'Sign in to GitHub Copilot',
          command: 'copilot login',
          detail:
            'opens a terminal running `copilot login` — sign in with GitHub there ' +
            '(a device code or browser step may follow)',
        },
        installers: {
          // docs.github.com: npm is the official all-platforms
          // installer and Florina already requires Node ≥ 22. (winget
          // and brew are documented alternatives but pull heavier
          // dependencies — winget auto-installs PowerShell 7.)
          default: {
            label: 'Install GitHub Copilot CLI',
            command: NPM.copilot,
            detail: 'opens a terminal running npm — the official Copilot CLI installer',
          },
        },
      },
      {
        // OpenCode — opencode.ai/docs. `opencode acp` is a real ACP v1
        // server over stdio (starts a private in-process server, no
        // port), so the generic AcpAdapter carries it.
        id: 'opencode',
        docsUrl: 'https://opencode.ai/docs/',
        envOverride: 'FLORINA_OPENCODE_CMD',
        executable: 'opencode',
        extraCandidates: {
          // The install script prefers $OPENCODE_INSTALL_DIR →
          // $XDG_BIN_DIR → ~/bin → ~/.opencode/bin; brew lands in the
          // brew prefix; npm in the global prefix; scoop/choco shims in
          // their dirs — all documented beyond-PATH homes.
          win32: [
            { kind: 'path', path: '{home}/.opencode/bin/opencode.exe' },
            { kind: 'path', path: '{home}/scoop/shims/opencode.exe' },
            { kind: 'path', path: '{home}/AppData/Roaming/npm/opencode.cmd' },
          ],
          default: [
            { kind: 'path', path: '{home}/.opencode/bin/opencode' },
            { kind: 'path', path: '{home}/bin/opencode' },
          ],
          darwin: [
            { kind: 'path', path: '{home}/.opencode/bin/opencode' },
            { kind: 'path', path: '{home}/bin/opencode' },
            { kind: 'path', path: '/opt/homebrew/bin/opencode' },
            { kind: 'path', path: '/usr/local/bin/opencode' },
          ],
          linux: [
            { kind: 'path', path: '{home}/.opencode/bin/opencode' },
            { kind: 'path', path: '{home}/bin/opencode' },
            { kind: 'path', path: '/home/linuxbrew/.linuxbrew/bin/opencode' },
            { kind: 'path', path: '/usr/local/bin/opencode' },
          ],
        },
        transport: { kind: 'acp', args: ['acp'] },
        notFoundDetail:
          '`opencode` CLI not found on PATH (also checked ~/.opencode/bin, ' +
          '~/bin, and brew/scoop/npm dirs). Install it, put it on PATH, or ' +
          'set FLORINA_OPENCODE_CMD to its path.',
        credentialEvidence: {
          // OpenCode is model-key auth: `opencode auth login` stores
          // provider keys in ~/.local/share/opencode/auth.json (v1) —
          // on Windows the same path under %USERPROFILE%. v2 migrates
          // credentials into opencode.db, which we deliberately do NOT
          // list: it is created on every launch (verified live — a bare
          // `opencode acp` handshake creates it), so existence is not
          // credential evidence. A v2-db-only sign-in under-reports to
          // 'absent', which self-heals via `florina auth opencode`.
          // Provider keys are also honored natively as env vars
          // (models.dev list) — a present key is real capability
          // evidence.
          files: ['.local/share/opencode/auth.json'],
          xdgDataFiles: ['opencode/auth.json'],
          // v2 credentials live in opencode.db — created on every
          // launch (verified live), so its existence is not evidence;
          // but since the db MIGHT hold a credential row we cannot see,
          // its presence makes an otherwise-empty probe 'unknown'
          // instead of a false "not signed in".
          uncertainFiles: ['.local/share/opencode/opencode.db'],
          uncertainXdgDataFiles: ['opencode/opencode.db'],
          envVars: [
            'ANTHROPIC_API_KEY',
            'OPENAI_API_KEY',
            'GOOGLE_GENERATIVE_AI_API_KEY',
            'GEMINI_API_KEY',
            'OPENROUTER_API_KEY',
          ],
        },
        signIn: {
          kind: 'run-command',
          label: 'Sign in to OpenCode',
          command: 'opencode auth login',
          detail:
            'opens a terminal running `opencode auth login` — pick your model ' +
            'provider and paste its API key there (the picker needs a real terminal)',
        },
        installers: {
          // `opencode-ai` publishes only os=[darwin,linux,win32] ×
          // cpu=[arm64,x64] binaries — `default` would falsely claim
          // freebsd/android/ia32 coverage (npm EBADPLATFORMs there), so
          // explicit cells per the file's restricted-coverage
          // convention. curl script / brew tap / scoop are documented
          // alternatives; npm is the single honest pick since Florina
          // already requires Node ≥ 22.
          win32: {
            label: 'Install OpenCode',
            command: NPM.opencode,
            detail: 'opens a terminal running npm — the official OpenCode installer',
          },
          darwin: {
            label: 'Install OpenCode',
            command: NPM.opencode,
            detail: 'opens a terminal running npm — the official OpenCode installer',
          },
          linux: {
            label: 'Install OpenCode',
            command: NPM.opencode,
            detail: 'opens a terminal running npm — the official OpenCode installer',
          },
        },
      },
    ] as ProviderManifest[]
  ).map((m) => deepFreeze(m)),
);

/** The manifest for a provider id, if one exists. */
export function providerManifest(id: string): ProviderManifest | undefined {
  return PROVIDER_MANIFESTS.find((m) => m.id === id);
}

/** All manifest provider ids, in registry order. */
export function providerManifestIds(): readonly string[] {
  return PROVIDER_MANIFESTS.map((m) => m.id);
}

/* ------------------------------------------------------------------ *
 * Derived tables — one manifest derives every consumer's view
 * ------------------------------------------------------------------ */

/**
 * Everything the readiness and attachment layers need, derived from a
 * manifest list. Exported (not just the singleton) so tests can inject
 * a fake manifest and prove one entry is sufficient — that's the
 * acceptance contract of #300.
 */
export function providerTables(manifests: readonly ProviderManifest[]): {
  readonly fixes: Readonly<Record<string, ProviderFix>>;
  readonly installers: Readonly<Record<string, Readonly<PerPlatform<ProviderInstaller | null>>>>;
  readonly credentialEvidence: Readonly<Record<string, CredentialEvidenceSpec>>;
} {
  // Prototype-free records — an id like '__proto__' must be a normal
  // key, never a prototype assignment or an inherited-property hit.
  const fixes: Record<string, ProviderFix> = Object.create(null);
  const installers: Record<string, Readonly<PerPlatform<ProviderInstaller | null>>> = Object.create(
    null,
  );
  const credentialEvidence: Record<string, CredentialEvidenceSpec> = Object.create(null);
  // First wins — same rule as the attach loop's dedupe. A later
  // duplicate must not silently overwrite the row the attached
  // provider was built from (split-brain between the two views).
  const seen = new Set<string>();
  for (const m of manifests) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    fixes[m.id] = m.signIn;
    installers[m.id] = m.installers;
    credentialEvidence[m.id] = m.credentialEvidence;
  }
  return { fixes, installers, credentialEvidence };
}
