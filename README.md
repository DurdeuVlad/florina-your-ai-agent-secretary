# Florina

> **An open-source attention broker for coding agents.**

One inbox that lets developers delegate work, monitors heterogeneous agent
sessions, suppresses routine noise, and interrupts only when a human decision
is genuinely needed.

Florina sits between **human attention** and **agent sessions**,
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
| **Florina loop** | The only self-owned agent loop — reasoning, plan/todo tool, typed tool registry, context management — connected to any model via a LiteLLM proxy (DEC-034). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). |
| **Daemon** | Local control plane — a WebSocket server on `ws://127.0.0.1:17419` that fans out to concurrent agent sessions (DEC-005). Hosts the MCP tool server managers dispatch through (DEC-018). |
| **Capacity router** | Quota-aware provider routing: `QuotaLedger` tracks per-provider windows (`used_pct`, `resets_at`), `CapacityRouter` enforces the hard floor — quota, deny rules — while managers express NL preferences (DEC-029). |
| **Adapters** | Bridges into a canonical `SupervisorEvent` stream (DEC-019): Codex (JSON-RPC, Tier A), Claude Code (hooks, Tier B), ACP-native CLIs — `devin acp`, `gemini --acp` (Tier C, DEC-030), `agy` headless stream-json (Tier D). A stub adapter is included for local testing. |
| **Attention engine** | Deterministic policy that ranks events into a priority inbox, suppresses routine noise, and supports adaptive tuning (DEC-014). |
| **Voice pipeline** | OpenAI Realtime API with a `whisper.cpp` fallback; supports voice approvals and spoken notifications (DEC-021). |
| **Desktop skeleton** | Electron/Tauri-ready client with an IPC bridge and view components (DEC-028). |
| **Storage** | Immutable SQLite event journal, context capsules, completion digests, and per-idea markdown ledgers (DEC-012/020/033). |
| **Security** | Audit framework and hardening utilities enforcing DEC-011 (the Florina narrows permissions, never silently widens them). |

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

The daemon runs in-process for the MVP — `florina start` blocks the calling
terminal until stopped. Use two terminals:

```bash
# Terminal 1 — start the daemon (blocks until stopped)
florina start

# Terminal 2 — query the running daemon
florina inbox     # view attention items
florina tasks     # list tasks
florina help      # see all commands
florina stop      # stop the daemon (from Terminal 2)
```

The CLI connects to the daemon at `ws://127.0.0.1:17419` by default. `flor` is
available as an alias for `florina` (DEC-026).

## CLI Usage

```bash
florina start                              # start the daemon (blocks; use a separate terminal for other commands)
florina stop                               # stop the running daemon
florina status                             # show daemon status

florina inbox                              # list attention inbox items
florina inbox --priority Critical           # filter by priority
florina inbox --status Pending              # filter by item state

florina approve <taskId> <approvalId> --grant   # grant a pending approval
florina approve <taskId> <approvalId> --deny    # deny a pending approval
florina ack <itemId>                       # acknowledge an attention item
florina resolve <itemId>                   # resolve an attention item
florina escalate <itemId>                  # escalate an item to Critical

florina tasks                              # list tasks
florina tasks --status InProgress           # filter by task state
florina task <taskId>                      # show task details
florina digest <taskId>                    # show completion digest for a task

florina metrics                            # show metrics snapshot
florina metrics --since 3600000             # metrics for the last hour

florina prune <taskId>                     # prune a task's worktree
florina voice [--api-key <key>]            # start a voice session (push-to-talk)
florina version                            # print version
florina help                               # print full help
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
  daemon/      # local control plane (IPC/WebSocket server), quota ledger, capacity router
  adapters/    # Codex / Claude Code / ACP bridges -> SupervisorEvent
  attention/   # deterministic attention engine (DEC-014)
  florina/   # the self-owned agent loop (DEC-034)
  cli/         # `florina` / `flor` binary (DEC-026)
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

**MVP — actively implemented.** 32+ issues landed, 1585+ tests passing.

**Works today:**

- Local daemon with WebSocket control plane
- Codex (JSON-RPC, Tier A) and Claude Code (hooks, Tier B) adapters
- Deterministic attention engine with priority inbox
- SQLite event journal, context capsules, completion digests
- CLI (`florina` / `flor`) with inbox, approvals, tasks, digest, metrics, voice
- Voice pipeline (OpenAI Realtime + whisper.cpp fallback) wired into daemon + CLI
- Desktop skeleton (Electron/Tauri-ready IPC bridge)
- Security/audit framework (DEC-011 compliance)
- Git worktree lifecycle per task (DEC-024)

**Planned (milestone [M6-Multi-Provider-Orchestration](https://github.com/DurdeuVlad/florina/milestone/7)):**

- Florina agentic loop + LiteLLM model connector (DEC-034, #70)
- Quota-aware capacity routing across subscriptions (DEC-029, #60, #71)
- ACP generic adapter → Devin + Gemini; `agy` headless (DEC-030, #61, #62)
- Per-project manager agents dispatching via daemon MCP tools (DEC-018, #63)
- Cross-provider failover via worktree + Task Capsule (#64)
- Auto-learned preference memories, scoped auto-approval (DEC-029, #65, #67)
- Idea ledgers → compiled Briefs → gated delegation (DEC-033, #69)
- Verification-gated completion — done means proven (DEC-032, #68)
- Production desktop client packaging (#43)
- Refined adaptive attention tuning

## License

[MIT](LICENSE)
