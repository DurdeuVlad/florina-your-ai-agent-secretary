# Security Policy

## Scope

Florina is a local control plane that launches coding agents, brokers
credentials, and accepts remote connections over an authenticated
WebSocket. Security issues that matter most here:

- Anything that widens permissions beyond what the human granted (DEC-011
  is a hard architectural invariant — an LLM must never expand its own
  authority)
- Credential vault access paths (`src/adapters/outbound/credentials/`)
- Remote/federated daemon authentication and command scoping
- Approval bypass — any path where a permission-like action completes
  without the required human confirmation for that fidelity tier

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Email the maintainer via the address on the repository owner's GitHub
profile, or use GitHub's private vulnerability reporting ("Security" tab
→ "Report a vulnerability"). Include:

- A description of the issue and its impact
- Steps to reproduce against the current `master`
- Affected surfaces (CLI, daemon WS, MCP, voice, federation)

Expect an acknowledgement within a few days. We'll coordinate disclosure
with you once a fix lands.

## Supported versions

Florina is pre-1.0 — only `master` receives security fixes.
