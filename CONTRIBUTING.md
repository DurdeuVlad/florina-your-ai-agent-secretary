# Contributing

Thanks for your interest in Agent Secretary.

## Getting started

```bash
npm install
npm run build
npm test
```

See the [README](README.md) for prerequisites and the full CLI reference,
and [`AGENTS.md`](AGENTS.md) for the toolchain/language rationale, command
reference, conventions, and the worktree lifecycle.

## Before opening a PR

- `npm run lint` and `npm run typecheck` must pass.
- `npm test` must pass.
- `npm run format` if you touched formatting-sensitive files.

## Design decisions

Architecture and product decisions are tracked in
[`DECISION_LEDGER.md`](DECISION_LEDGER.md). If your change conflicts with an
existing decision, open an issue to discuss it before implementing — don't
silently diverge from a settled decision.

## Reporting bugs / requesting features

Open a GitHub issue. Include repro steps for bugs where possible.
