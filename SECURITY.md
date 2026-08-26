# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in Agent Secretary, please report it
privately via [GitHub's private vulnerability reporting](https://github.com/DurdeuVlad/agent-secretary/security/advisories/new)
rather than opening a public issue.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce
- Affected version/commit

## Scope notes

- The daemon binds to `ws://127.0.0.1:17419` by default (local-only control
  plane, see DEC-005 in [`DECISION_LEDGER.md`](DECISION_LEDGER.md)); it is
  not designed to be exposed to a network.
- The only external credential the project handles is `OPENAI_API_KEY` for
  the voice pipeline, supplied via environment variable or `--api-key` flag
  — never hardcoded or logged. The project ships its own log-scrubbing
  auditor (`src/security/auditors.ts`) that checks for accidental secret
  leakage in log calls.
- There is no deploy pipeline or hosted service; CI (`.github/workflows/ci.yml`)
  only runs lint/typecheck/test/build and references no secrets beyond the
  default `GITHUB_TOKEN`.

## Supported Versions

Pre-1.0; the latest commit on `master` is the only supported version.
