# Contributing to Florina

Thanks for your interest. Florina is a local-first supervisory layer for
coding agents — contributions are welcome.

## Development setup

```bash
npm install
npm run typecheck   # strict TypeScript
npm test            # vitest suite
npm run lint        # eslint
npm run format      # prettier
```

All four must pass before a change lands — CI enforces this on Node 22.x
and 24.x.

## Architecture

The codebase is strictly hexagonal (DEC-037):

- `src/core/domain/` — the domain model; imports nothing outside core
- `src/core/application/` — ports and use cases
- `src/adapters/inbound/` — CLI, WebSocket control plane, MCP, voice, desktop
- `src/adapters/outbound/` — agent runtimes, persistence, git, quota, model
- `src/bootstrap/` — the only place concrete implementations are composed

`tests/architecture-boundaries.test.ts` enforces the dependency direction
mechanically — keep new code inside the right layer.

## Conventions

- ESM with `.js` extensions on relative imports
- Every meaningful state transition is journaled before summarizing (DEC-012)
- Florina narrows permissions, never silently widens them (DEC-011)
- Worktree branches use the `florina/` prefix; worktrees live in
  `.florina-worktrees/` (DEC-024)
- Write a failing test that demonstrates the bug before fixing it, and
  prove behavior by running the real system — not by inspection

## Commit & PR style

Small, focused PRs — one issue each. Commit messages describe *why*.
See `AGENTS.md` for the full repo guide.
