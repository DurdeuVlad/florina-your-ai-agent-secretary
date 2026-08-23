# Agent Secretary

> **An open-source attention broker for coding agents.**

One inbox that lets developers delegate work, monitors heterogeneous agent
sessions, suppresses routine noise, and interrupts only when a human decision
is genuinely needed.

Agent Secretary sits between **human attention** and **agent sessions**,
turning a messy collection of parallel agent work into a manageable stream of
tasks, deliverables, decisions, and attention requests.

## What This Is

- A **supervisory layer**, not another coding agent
- An **attention router**, not a terminal multiplexer
- An **inbox**, not a Kanban board
- **Voice-first** interaction with visual support — not a dashboard with a
  microphone button

## Architecture

| Component | Description |
|-----------|-------------|
| **Daemon** | Local control plane — a WebSocket server on `ws://127.0.0.1:17419` that fans out to concurrent agent sessions (DEC-005). |
| **Adapters** | Bridges from Codex (JSON-RPC) and Claude Code (PTY) into a canonical `SupervisorEvent` stream (DEC-019). A stub adapter is included for local testing. |
| **Attention engine** | Deterministic policy that ranks events into a priority inbox, suppresses routine noise, and supports adaptive tuning (DEC-014). |
| **Voice pipeline** | OpenAI Realtime API with a `whisper.cpp` fallback; supports voice approvals and spoken notifications (DEC-021). |
| **Desktop skeleton** | Electron/Tauri-ready client with an IPC bridge and view components (DEC-028). |
| **Storage** | Immutable SQLite event journal, context capsules, and completion digests — summaries never replace source events (DEC-012/020). |
| **Security** | Audit framework and hardening utilities enforcing DEC-011 (the Secretary narrows permissions, never silently widens them). |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- npm (bundled with Node.js)

### Install & Build

```bash
npm install
npm run build
```

### Run

```bash
secretary start     # start the daemon
secretary inbox     # view attention items
secretary help      # see all commands
```

The CLI connects to the daemon at `ws://127.0.0.1:17419` by default. `asec` is
available as an alias for `secretary` (DEC-026).

## CLI Usage

```bash
secretary start                              # start the daemon
secretary stop                               # stop the running daemon
secretary status                             # show daemon status

secretary inbox                              # list attention inbox items
secretary inbox --priority Critical           # filter by priority
secretary inbox --status Pending              # filter by item state

secretary approve <taskId> <approvalId> --grant   # grant a pending approval
secretary approve <taskId> <approvalId> --deny    # deny a pending approval
secretary ack <itemId>                       # acknowledge an attention item
secretary resolve <itemId>                   # resolve an attention item
secretary escalate <itemId>                  # escalate an item to Critical

secretary tasks                              # list tasks
secretary tasks --status InProgress           # filter by task state
secretary task <taskId>                      # show task details
secretary digest <taskId>                    # show completion digest for a task

secretary metrics                            # show metrics snapshot
secretary metrics --since 3600000             # metrics for the last hour

secretary prune <taskId>                     # prune a task's worktree
secretary version                            # print version
secretary help                               # print full help
```

## Development

| Task             | Command                |
| ---------------- | ---------------------- |
| Install deps     | `npm install`          |
| Build            | `npm run build`        |
| Typecheck only   | `npm run typecheck`    |
| Run tests        | `npm test`             |
| Watch tests      | `npm run test:watch`   |
| Lint             | `npm run lint`         |
| Lint (autofix)   | `npm run lint:fix`     |
| Format           | `npm run format`       |
| Check formatting | `npm run format:check` |

## Project Structure

```
src/
  daemon/      # local control plane (IPC/WebSocket server)
  adapters/    # Codex / Claude Code bridges -> SupervisorEvent
  attention/   # deterministic attention engine (DEC-014)
  cli/         # `secretary` / `asec` binary (DEC-026)
  voice/       # Realtime + whisper.cpp pipeline (DEC-021)
  desktop/     # Electron/Tauri client (DEC-028)
  storage/     # SQLite event journal + Context Capsules (DEC-012/020)
  domain/      # core domain objects (DEC-004)
tests/         # vitest specs
dist/          # build output (gitignored)
```

See [`AGENTS.md`](AGENTS.md) for the toolchain/language rationale, full
command reference, conventions, and the worktree lifecycle.

## Foundation Docs

These four documents are the **foundational source of truth**. Implementation
architecture, contracts, models, and code are derived from them.

| File | Purpose |
|------|---------|
| [`BUSINESS.md`](BUSINESS.md) | Problem, target user, value proposition, MVP success criteria |
| [`PRODUCT_DESIGN.md`](PRODUCT_DESIGN.md) | Product model, domain objects, attention model, voice/visual UX |
| [`DEEP_RESEARCH.md`](DEEP_RESEARCH.md) | Landscape analysis, reusable components, what's solved vs. open |
| [`DECISION_LEDGER.md`](DECISION_LEDGER.md) | Settled and open product decisions with rationale |

## Status

**MVP — actively implemented.** 32+ issues landed, 1380+ tests passing.

**Works today:**

- Local daemon with WebSocket control plane
- Codex (JSON-RPC) and Claude Code (PTY) adapters
- Deterministic attention engine with priority inbox
- SQLite event journal, context capsules, completion digests
- CLI (`secretary` / `asec`) with inbox, approvals, tasks, digest, metrics
- Voice pipeline (OpenAI Realtime + whisper.cpp fallback)
- Desktop skeleton (Electron/Tauri-ready IPC bridge)
- Security/audit framework (DEC-011 compliance)
- Git worktree lifecycle per task (DEC-024)

**Planned:**

- Production desktop client packaging
- Additional adapter integrations
- Refined adaptive attention tuning
- Multi-run task lifecycle beyond 1:1 worktree mapping

## License

TBD
