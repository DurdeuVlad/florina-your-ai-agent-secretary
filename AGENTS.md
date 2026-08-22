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

## Worktree Lifecycle (DEC-024)

In the MVP each Task maps 1:1 to one git worktree and one run (DEC-020). The
worktree lifecycle is implemented in `src/daemon/worktree.ts`
(`WorktreeManager`).

### Branch naming convention

Every task worktree is created on a branch named exactly:

```
secretary/<task-slug>
```

where `<task-slug>` is a sanitized, git- and filesystem-safe identifier
(lowercase alphanumeric and hyphens only). The `secretary/` prefix namespaces
all Secretary-managed branches so they are clearly distinguishable from
human-authored branches and can be listed/cleaned up safely. Use the
`secretaryBranchName(slug)` helper to build the canonical branch name.

### Worktree placement

Worktrees are placed in a sibling `.secretary-worktrees/` directory (outside
the main working tree) at a deterministic path derived from the repository
path and the task slug, so paths are stable across runs.

### Prune policy

- Worktrees are **retained** until an explicit prune (`secretary prune`).
- `pruneWorktree` removes a worktree **only when it is clean** (no
  uncommitted changes).
- **Dirty worktrees are never silently deleted** — `pruneWorktree` throws a
  `DirtyWorktreeError` so the human can decide what to do with the
  uncommitted work (DEC-011: destroying uncommitted work would be a
  destructive widening of permissions).

### Dirty detection

`detectDirty(worktreePath)` runs `git status --porcelain` and returns whether
there are uncommitted (staged, unstaged, or untracked) changes.
`worktreeStatus(worktreePath)` returns a `{ clean, dirty, branch, baseCommit }`
snapshot that the attention engine can use to surface a dirty
completed/cancelled worktree for human review.
