# Changelog

All notable changes to Florina are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-06

### Agent-operable setup (milestone 14)

- **`florina status --json`** — one machine-readable document carrying the
  same readiness facts the desktop setup card renders: daemon state,
  per-provider install/auth state, chat-model status, watched roots and
  discovered repos. Exit 0 means the daemon answered; non-zero carries a
  machine-readable `error` (`daemon-not-running`, `daemon-unreachable`)
  on stderr. `null` marks "couldn't check" — never a fabricated empty list.
  (#321)
- **`florina repos`** — `list`, `add <path>`, `remove <path> [--yes]`, and
  `move <path> up|down` over the daemon's existing root commands, all with
  `--json`. Removal keeps an explicit consent moment (`--yes` required
  non-interactively), unknown paths fail honestly instead of no-op
  "success", and `add` never guesses a scope — the caller names the folder.
  (#322)
- **`florina start --detach`** — starts the daemon in a detached background
  process (output to `~/.florina/daemon.log`) and returns only once the
  child itself is bound and ready. Early exit, spawn failure, and timeout
  all surface as nonzero exits; `--json` reports `{started, detached, pid,
logFile}`. Unknown flags and stray arguments are usage errors, so a typo
  can never wedge an agent in a blocking foreground daemon. (#323)
- **`docs/AGENT_SETUP.md`** — the verbatim recipe an external coding agent
  (Claude Code, Codex, Cursor, …) follows to install, configure, and verify
  Florina: exact commands, exit-code contracts, designed human hand-offs
  for sign-ins/secrets/folder choice, and a final verification that quotes
  `status --json` facts rather than claiming success. A pin test asserts
  every recipe verb stays in the CLI dispatch table. (#320, #324)

### Providers

- **Four new providers** — GitHub Copilot, OpenCode, Cursor (`cursor-agent`
  via ACP), and Aider (print-run transport with model-key auth) join the
  manifest table; detection, credential evidence, sign-in recipes, and
  installers all come from the single declarative manifest. (#303–#306)
- **macOS/Linux parity** — verified installers and credential probes now
  cover all three platforms, including a beyond-PATH sign-in fix for
  OpenCode. (#302, #304)
- Skipped providers are re-probed on every status query, so a CLI installed
  mid-session is seen without a daemon restart. (#301)

### Fixes

- The attention inbox now persists across daemon restarts. (#272)
- `florina version` reports the package version — the CLI's `VERSION`
  constant had drifted to `0.0.1` and is now pinned to `package.json` by a
  test so it cannot drift again.
- Linux CI: platform-correct path handling. (#284)

## [0.2.0] - 2026-10-05

### Provider onboarding (milestone 13)

- **`florina install <provider>`** — when a provider CLI isn't installed,
  Florina offers its verified-official installer (npm for Claude Code, Codex,
  Gemini; the providers' own installers for Devin and Antigravity on Windows)
  and runs it in a visible terminal only after the explicit command. Platforms
  without a verified installer get manual instructions — never a guessed
  command. (#307)
- **Provider manifests** — one declarative spec per provider now drives
  executable detection, transport, credential evidence, sign-in recipes, and
  installers. Adding a provider is a single manifest entry. (#300)
- **Honest readiness for every provider** — `florina status` reports real
  auth states (`signed in` / `not signed in` / `auth failing` / `unknown`),
  classified failures, and a one-command fix per provider. Credential probes
  are existence-only and never read secrets. Devin's `credentials.toml` and
  Antigravity's OS-keyring entry are now detected on Windows. (#294, #298)
- Sign-in flows open the correct commands (`devin auth login`, not
  `devin login`) and preflight the binary before spawning a terminal.

### Secrets

- **Encrypted credential vault wired end-to-end** — `florina keys` /
  `secrets-*` commands store secrets encrypted at rest; stored values are
  injected into agent process environments at dispatch, and a saved chat
  model key is used as a fallback when no env var is set. (#292, #293)

### The Florina Method

- Every agent dispatch now binds to the Florina Method contract asset, and
  the Secretary composes it into its prompt — a shared, inspectable
  definition of how Florina brokers attention. (#286–#288)

### Design & packaging

- Violet theme palette across renderer tokens and mockups, regenerated app
  icon (source SVG finalists kept in `logo-proposals/`), and an
  electron-builder `extraMetadata` fix so packaged builds boot the desktop
  composition root. (#309)

## [0.1.0] - 2026-10-01

First public release.

### What Florina is

**Florina is an open-source attention broker for coding agents.** It watches
the coding tools you already run — Claude Code, Codex, Gemini CLI, Devin,
Antigravity — and turns their scattered activity into **one local inbox** of
tasks, decisions, and results.

### The problem it solves

Running coding agents in parallel means scattered terminals, missed permission
prompts, and no reliable record of what changed or why. Florina sits between
your attention and your agent sessions:

- **One inbox, not N windows.** A deterministic attention engine ranks agent
  events into a single priority inbox and suppresses routine noise, so you are
  only interrupted when a decision genuinely needs you.
- **Permissions narrow, never widen.** Approvals show the action, its scope,
  and its risk; you grant, deny, or inspect — and a denial's consequence is
  visible, not implied. Florina never silently expands what an agent may do.
- **Evidence, not summaries.** Every state transition lands in an immutable
  event journal on your machine; digests and summaries are derived views that
  never replace the source record, and observed facts stay labeled distinct
  from inferred ones.
- **Local first.** The daemon and its data live on your machine
  (`127.0.0.1:17419`, SQLite journal under `~/.florina/`). Florina never asks
  for or stores your provider credentials — sign-in always happens inside each
  coding app's own window.

### What is in the box

- **Desktop app (Electron).** Chat-first: the launch view is one persistent
  Secretary conversation with dictation and two-way voice mode, plus
  supporting screens — Attention inbox, session inspector, fleet/quota, ideas,
  preferences, and Secretary — a global push-to-talk hotkey, system tray with
  close-to-tray, auto-reconnect, and automatic daemon start.
- **Guided first-run setup.** One step at a time: meet Florina, check which
  coding apps are installed (with honest "found ≠ signed in" wording), choose
  the folder Florina may look inside, and reach a verified ready state —
  skippable and resumable.
- **First-task guidance.** The empty conversation explains what Florina does
  in plain language and offers an editable example task — filled, never
  auto-sent — that adapts to what was actually found on your machine.
- **Daemon + CLI.** A local WebSocket control plane (`florina start`, alias
  `flor`) exposing a typed command API, including provider discovery that
  reports attached and skipped providers with reasons.
- **Provider adapters.** Codex (JSON-RPC), Claude Code (hooks), ACP-native
  CLIs (`devin acp`, `gemini --acp`), and `agy` stream-json; opt-in/opt-out
  via `FLORINA_PROVIDERS` / `FLORINA_DISABLED_PROVIDERS`; quota-aware
  capacity routing.
- **Worktree isolation.** Tasks run in dedicated git worktrees so agent work
  never touches your checkout; dirty worktrees are never silently deleted.

### Install

Download the installer for your platform from the
[Releases](https://github.com/DurdeuVlad/agent-secretary/releases) page:

| Platform | Download                                                        |
| -------- | --------------------------------------------------------------- |
| Windows  | `Florina.Setup.*.exe` (NSIS installer, x64)                     |
| macOS    | `Florina-*.dmg` (Intel) · `Florina-*-arm64.dmg` (Apple Silicon) |
| Linux    | `Florina-*.AppImage` (x64)                                      |

The guided setup and install docs currently target **Windows and Linux**; the
macOS package is built by the same pipeline but the walkthrough coverage is
thinner there. Running from source (Node.js ≥ 22): `npm install`,
`npm run build`, `florina start` in one terminal, `npm run desktop` in
another. Full walkthrough: [`docs/INSTALL.md`](docs/INSTALL.md).

### Use

1. Launch Florina — the local daemon starts by itself.
2. Follow the setup card: it checks your coding apps, then asks which folder
   to watch. Skipping is safe; the row stays to resume later.
3. Type a request in the chat — or use the example — and watch progress in
   the same thread. Anything that needs permission lands in **Attention**;
   every decision and result stays in the journal.
