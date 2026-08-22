# AGENTS.md

Guidance for coding agents (and humans) working in this repository.

## Project

**Agent Secretary** — an open-source attention broker for coding agents. See
[`README.md`](README.md) and the foundation docs for product context.

## Toolchain & Language Rationale

**Language:** TypeScript (strict mode)
**Runtime:** Node.js >= 20
**Package/repo name:** `agent-secretary`
**CLI binary:** `secretary` with alias `asec` (DEC-026)

### Why TypeScript / Node.js?

- **DEC-019** specifies the canonical `SupervisorEvent` schema as a
  "TypeScript/JSON schema" — the event normalization layer is typed TypeScript.
- The product is a **local control plane + CLI + desktop client**. Node.js is
  the natural fit for a localhost daemon with IPC/WebSocket surfaces, a CLI
  binary, and an Electron/Tauri desktop shell (DEC-028).
- TypeScript's type system lets us model the domain (Project → Task →
  Deliverable → Decision, DEC-004) and the `SupervisorEvent` union precisely,
  while keeping the JSON wire format trivially serializable for adapters.
- First-class async I/O suits an event-driven daemon that fans out to multiple
  concurrent agent sessions (DEC-005).
- The ecosystem (SQLite drivers, WebSocket, WebRTC for the Realtime voice
  pipeline DEC-021, Electron/Tauri) is mature on Node.js.

### Alternatives considered

- **Rust / Go** — stronger runtime guarantees, but slower iteration for the
  product-definition phase and weaker story for the desktop/voice surfaces.
- **Python** — good for the LLM/voice layer, weaker for a typed daemon + CLI
  binary distribution.

## Commands

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

## Project Layout

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

## Conventions

- ESM (`"type": "module"`). Use `.js` extensions in relative imports.
- Strict TypeScript (`strict: true`, `noUnusedLocals`, etc.).
- Lint must pass (`npm run lint`). Format with Prettier (`npm run format`).
- Every meaningful state transition is recorded in the immutable event journal
  before summarizing (DEC-012). Summaries never replace source events.
- The Secretary narrows permissions, never silently widens them (DEC-011).
