# Agent Secretary

> **An open-source attention broker for coding agents.**

One inbox that lets developers delegate work, monitors heterogeneous agent sessions, suppresses routine noise, and interrupts only when a human decision is genuinely needed.

## The Problem

Coding agents are now capable enough to handle meaningful implementation tasks independently. The constraint has shifted from agent capability to **human supervision capacity**. Once a developer runs 3–5+ concurrent coding agent sessions, they spend more time managing agents than doing productive work.

Agent Secretary sits between **human attention** and **agent sessions**, turning a messy collection of parallel agent work into a manageable stream of tasks, deliverables, decisions, and attention requests.

## What This Is

- A **supervisory layer**, not another coding agent
- An **attention router**, not a terminal multiplexer
- An **inbox**, not a Kanban board
- **Voice-first** interaction with visual support — not a dashboard with a microphone button

## What This Is Not

- Not a code generation tool (your existing coding agents do the work)
- Not an agent framework (it works *with* Codex, Claude Code, etc. through adapters)
- Not a replacement for any coding agent you already use

## Repository Structure

| File | Purpose |
|------|---------|
| [`BUSINESS.md`](BUSINESS.md) | Problem, target user, value proposition, MVP success criteria |
| [`PRODUCT_DESIGN.md`](PRODUCT_DESIGN.md) | Product model, domain objects, attention model, voice/visual UX |
| [`DEEP_RESEARCH.md`](DEEP_RESEARCH.md) | Landscape analysis, reusable components, what's solved vs. open |
| [`DECISION_LEDGER.md`](DECISION_LEDGER.md) | Settled and open product decisions with rationale |

These four files are the **foundational source of truth**. Implementation architecture, contracts, models, and code should be derived from them.

## Core Thesis

> Developers can now parallelize implementation with coding agents faster than they can supervise the resulting work. Agent Secretary removes that supervisory bottleneck.

## Status

**Pre-implementation product definition phase.** The four foundation documents define the product; architecture and implementation follow.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- npm (bundled with Node.js)

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

Produces compiled JavaScript + type declarations in `dist/`. The CLI binary is
`dist/cli/index.js` (exposed as `secretary` / `asec` via the `bin` field).

### Test

```bash
npm test            # run once
npm run test:watch  # watch mode
```

### Lint & Format

```bash
npm run lint          # eslint
npm run lint:fix      # eslint --fix
npm run format        # prettier --write
npm run format:check  # prettier --check
npm run typecheck     # tsc --noEmit
```

### Development

```bash
npm install
npm run typecheck   # type-check without emitting
npm run lint
npm test
npm run build
```

See [`AGENTS.md`](AGENTS.md) for the toolchain/language rationale, full
command reference, and project layout.

## License

TBD
