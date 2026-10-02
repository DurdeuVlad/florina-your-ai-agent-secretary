# Changelog

All notable changes to Florina are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

| Platform | Download                          |
| -------- | --------------------------------- |
| Windows  | `Florina-Setup-*.exe` (NSIS, x64) |
| macOS    | `Florina-*.dmg` (x64 + arm64)     |
| Linux    | `Florina-*.AppImage` (x64)        |

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
