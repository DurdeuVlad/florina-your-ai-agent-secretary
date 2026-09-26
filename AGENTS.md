# AGENTS.md

Guidance for coding agents (and humans) working in this repository.

## Project

**Florina** — an open-source attention broker for coding agents. See
[`README.md`](README.md) and the foundation docs for product context.

## Toolchain & Language Rationale

**Language:** TypeScript (strict mode)
**Runtime:** Node.js >= 22
**Package/repo name:** `florina`
**CLI binary:** `florina` with alias `flor` (DEC-026)

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

| Task                    | Command                    |
| ----------------------- | -------------------------- |
| Install deps            | `npm install`              |
| Build                   | `npm run build`            |
| Typecheck only          | `npm run typecheck`        |
| Run tests               | `npm test`                 |
| Watch tests             | `npm run test:watch`       |
| Lint                    | `npm run lint`             |
| Lint (autofix)          | `npm run lint:fix`         |
| Format                  | `npm run format`           |
| Check formatting        | `npm run format:check`     |
| Package desktop (all)   | `npm run dist`             |
| Package desktop (unpack)| `npm run dist:dir`         |

## Project Layout

The repository follows a hexagonal (ports & adapters) architecture
(DEC-037, issues #90–#93): `src/core` owns the domain model, port contracts,
and application use cases; adapters depend inward on those ports; and
`src/bootstrap` is the only place concrete inbound + outbound adapters are
composed. Dependency rule:
`domain <- application ports/use-cases <- inbound/outbound adapters`,
enforced by `tests/architecture-boundaries.test.ts` (44 checks — static,
dynamic, and CommonJS import scanning, Node-global detection in core,
adapter-family isolation, facade verification, and a catch-all that rejects
any implementation file outside the hexagonal zones).

```
src/
  core/
    domain/                    # canonical domain model (DEC-004/019)
    application/
      ports/outbound/          # core-owned outbound port contracts
      use-cases/               # application services (attention, tasks,
                               #   sessions, voice orchestration, …)
  adapters/
    inbound/                   # driving surfaces: websocket, desktop, cli, voice
    outbound/                  # driven tech: agents, sqlite, git, voice
                               #   engines, files, security, platform
  bootstrap/                   # composition roots: daemon, cli, voice sessions
  domain/ attention/ storage/ daemon/ cli/ voice/ desktop/ adapters/*.ts
                               # COMPATIBILITY facades only — re-exports into
                               #   the canonical locations (temporary)
tests/         # vitest specs
dist/          # build output (gitignored)
```

**New production code** goes under `src/core` (domain, ports, use-cases),
`src/adapters/inbound|outbound/<family>`, or `src/bootstrap` — never in the
legacy roots (`src/domain`, `src/daemon`, `src/storage`, `src/attention`,
`src/florina`, `src/cli`, `src/voice`, `src/desktop`, `src/security`),
which exist only as compatibility facades re-exporting the canonical
implementations.

The locked multi-provider architecture lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (DEC-029–034, milestone M6).

## Conventions

- ESM (`"type": "module"`). Use `.js` extensions in relative imports.
- Hexagonal layering (DEC-037): adapters and surfaces import inward from
  `src/core`; `src/core` never imports outward (no adapters, daemon,
  storage, node builtins, or external packages).
- Strict TypeScript (`strict: true`, `noUnusedLocals`, etc.).
- Lint must pass (`npm run lint`). Format with Prettier (`npm run format`).
- Every meaningful state transition is recorded in the immutable event journal
  before summarizing (DEC-012). Summaries never replace source events.
- The Florina narrows permissions, never silently widens them (DEC-011).

## Worktree Lifecycle (DEC-024)

In the MVP each Task maps 1:1 to one git worktree and one run (DEC-020). The
worktree lifecycle is implemented in `src/daemon/worktree.ts`
(`WorktreeManager`).

### Branch naming convention

Every task worktree is created on a branch named exactly:

```
florina/<task-slug>
```

where `<task-slug>` is a sanitized, git- and filesystem-safe identifier
(lowercase alphanumeric and hyphens only). The `florina/` prefix namespaces
all Florina-managed branches so they are clearly distinguishable from
human-authored branches and can be listed/cleaned up safely. Use the
`florinaBranchName(slug)` helper to build the canonical branch name.

### Worktree placement

Worktrees are placed in a sibling `.florina-worktrees/` directory (outside
the main working tree) at a deterministic path derived from the repository
path and the task slug, so paths are stable across runs.

### Prune policy

- Worktrees are **retained** until an explicit prune (`florina prune`).
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

## Desktop App Status (DEC-028, issue #43)

The desktop module is a **runnable Electron app** — `npm run desktop` launches
`src/bootstrap/desktop.ts` on the real Electron backends
(`ElectronWindowBackend`, `ElectronIpcTransport`, `ElectronTrayBackend`,
`ElectronKeyboardBackend`). The launch view is **Chat** (#160) — one
persistent, journaled Secretary conversation — with the supporting screens
(inbox, inspector, fleet, ideas, preferences, secretary) a `g`-key away. The
PTT HUD is inline in the main window with a global hotkey; tray,
close-to-tray, auto-reconnect, and daemon auto-start are wired. Visual parity
is checked via `npm run visual-qa` (see `docs/VISUAL_QA.md`).

**Audio transport is wired** (the old gap closed by #161/#162): renderer-side
`audio-capture.js`/`audio-playback.js` stream PCM16@24k through IPC to
`IpcAudioTransport` in the main process, feeding the OpenAI Realtime GA
pipeline (whisper.cpp fallback via `FLORINA_WHISPER_MODEL`). Dictation lands
editable text in the composer (#161); voice mode runs two-way spoken turns
journaled into the same chat thread (#162). Desktop-local preferences — mic
device, voice-mode default, dictation language — persist to
`~/.florina/desktop-settings.json` via the `deskset:` verb (#163).

**OS-native packaging implemented** (issue #171, DEC-028): `electron-builder`
produces platform-native installers via `npm run dist` (NSIS on Windows, DMG
on macOS, AppImage on Linux). Renderer assets are bundled via `extraResources`
and located at runtime through `resolveRendererAsset()` in
`src/bootstrap/desktop.ts` which branches on `app.isPackaged`. A
`.github/workflows/release.yml` CI job builds all three platforms and attaches
the installers to GitHub Releases when a `v*` tag is pushed.
