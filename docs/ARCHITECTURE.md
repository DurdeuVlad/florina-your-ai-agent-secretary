# Architecture: Multi-Provider Orchestration

**Status: design locked 2026-09-13.**

The directed graph of how Agent Secretary works. See DECISION_LEDGER.md for the
rulings (DEC-011/012/013/018/020/021/024/029–034) and milestone
`M6-Multi-Provider-Orchestration` (issues #60–#71) for the work breakdown.

## Hexagonal Architecture

The repository is migrating to a ports-and-adapters layout (DEC-037, issue
#90). The **core** owns the domain model and every port contract; concrete
technology (git, SQLite, WebSocket, provider CLIs, LLM endpoints) lives in
adapters that depend inward on the ports — never the reverse.

### Target tree

```
src/
  core/
    domain/                      # canonical domain model (DEC-004/019)
      enums.ts types.ts factories.ts capabilities.ts
      policy.ts approval.ts events.ts index.ts
    application/
      ports/
        outbound/                # contracts the core needs implemented
          clock.ts id-generator.ts event-stream.ts
          agent-runtime.ts worktree.ts index.ts
        index.ts
      use-cases/                 # application services (emerge in #91/#92)
      index.ts
    index.ts
  adapters/                      # outbound adapters: agent runtimes, git, sqlite
  daemon/                        # inbound adapters: IPC/WS API, daemon services
  cli/  desktop/  voice/         # inbound adapters: human-facing surfaces
  bootstrap/                     # the ONLY place concrete adapters are wired
  domain/                        # COMPAT: facades -> src/core/domain (temporary)
tests/                           # vitest specs + architecture-boundaries test
```

### Dependency rule

```
        src/core/domain                (centre — depends on nothing)
              ▲
              │   src/core/application   ports/, use-cases/
              ▲
              │   inbound + outbound     adapters/, daemon/, cli/, desktop/,
              │   adapters               voice/, storage/, attention/, secretary/
              ▲
              │   src/bootstrap          composition root — wires concrete
                                     adapters into the ports, nothing else
```

Every arrow points **inward**: adapters `import` the port interfaces from
`src/core/application/ports/`; the core never imports an adapter, a node
builtin, or an external package. `tests/architecture-boundaries.test.ts`
scans every core module specifier and fails the build on an outward edge.

The legacy `src/domain/` path remains as thin `export *` facades into
`src/core/domain` so existing consumers migrate incrementally; they are
temporary compatibility surfaces, not the public API.

> **Note:** the product graph below ("The Graph") describes _runtime
> topology_ — which running components talk to which — not dependency
> direction. A daemon WebSocket is an inbound adapter even though events
> flow outward through it, and an agent adapter is an outbound port
> implementation even though `SupervisorEvent`s stream inward through it.

## The Graph

```
                        ┌───────────────┐
                        │      YOU      │
                        │ voice · CLI · │
                        │ desktop inbox │
                        └───────┬───────┘
                                │ speech ↔ speech (OpenAI Realtime API, DEC-021)
              ┌─────────────────▼─────────────────┐
              │            SECRETARY              │  the ONLY agent loop we own
              │  own loop + todo + tools +        │  (DEC-034) — reasoning runs on
              │  context mgmt · idea ledgers      │  any model via LiteLLM proxy;
              └─────────────────┬─────────────────┘  Realtime = ears/mouth
                                │ typed commands (same API as CLI)
        ┌───────────────────────▼────────────────────────┐
        │                SECRETARY DAEMON                 │
        │ ┌────────────────────────────────────────────┐ │
        │ │ CAPACITY ROUTER + QUOTA LEDGER (DEC-029)   │ │
        │ │  preference profile + per-provider quota   │ │
        │ │  → route → failover → park/resume at       │ │
        │ │  earliest resets_at                        │ │
        │ ├────────────────────────────────────────────┤ │
        │ │ policy + capability/credential broker      │ │ DEC-011/022
        │ │ immutable event journal                    │ │ DEC-012
        │ │ deterministic attention engine → inbox     │ │ DEC-014
        │ │ MCP tool server (manager dispatch, DEC-018)│ │
        │ └────────────────────────────────────────────┘ │
        └───┬───────────┬───────────┬───────────┬────────┘
            ▼           ▼           ▼           ▼            one manager per project
      ┌──────────┐┌──────────┐┌──────────┐┌──────────┐
      │ MANAGER A││ MANAGER B││ MANAGER C││   ...    │  a provider agent launched
      └────┬─────┘└────┬─────┘└──────────┘└──────────┘  with the Secretary MCP config
           │           │
           │ secretary_spawn_task() via MCP → daemon enforces policy + quota
   ┌───────┴───────────┼──────────────┬─────────────┐
   ▼                   ▼              ▼             ▼
┌─────────┐      ┌───────────┐ ┌───────────┐ ┌───────────┐
│ Codex   │      │ Claude    │ │ Devin acp │ │ Gemini /  │  workers:
│app-server│     │ hooks/SDK │ │  Tier C   │ │ agy (C/D) │  Task → worktree
│ Tier A  │      │  Tier B   │ │  DEC-030  │ │           │  → Deliverable
└────┬────┘      └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
     └──── SupervisorEvents ────────┴─────────────┘
                        ▼
            journal → attention engine → NEEDS YOU / WORKING / DONE

   FAILOVER PATH: provider quota exhausted → freeze session → resume
   in the SAME worktree, primed from the Task Capsule, on the next
   preferred provider (all providers local → uniform handoff)
```

## Provider Surfaces

| Provider          | Adapter surface                                                     | Tier  | Quota signal                                                                            | Session resume                  |
| ----------------- | ------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------- | ------------------------------- |
| Codex             | `codex app-server` JSON-RPC                                         | A     | `account/rateLimits/read` → `usedPercent`, `resetsAt` (5h + weekly)                     | thread resume                   |
| Claude Code       | CLI + lifecycle hooks / Agent SDK                                   | B     | statusline `rate_limits` (5h + 7d `resets_at`); `anthropic-ratelimit-unified-*` headers | `--resume`                      |
| Devin CLI         | `devin acp` (ACP/JSON-RPC stdio); `-p` print mode; hooks            | C     | none documented → reactive                                                              | `-c` / `-r` / `/fork`           |
| Gemini CLI        | `gemini --experimental-acp` (ACP); `-p --output-format stream-json` | C / D | none → 429 detection + session-file token sums                                          | `--continue`                    |
| Antigravity `agy` | `agy -p --output-format stream-json`                                | D     | none → reactive                                                                         | `--continue` / `--conversation` |
| Copilot CLI       | `copilot --acp` (ACP/JSON-RPC stdio, public preview)                | C     | none documented → reactive                                                              | `--resume=<id>` / `--continue`  |
| OpenCode          | `opencode acp` (ACP/JSON-RPC stdio)                                 | C     | none documented → reactive                                                              | `opencode run --session <id>`   |
| Cursor CLI        | `agent acp` (ACP/JSON-RPC stdio)                                    | C     | none documented → reactive                                                              | `agent resume`                  |

OpenCode credential caveat: v2 stores `auth login` tokens inside
`opencode.db`, which exists from first launch whether or not it holds a
credential row — so an installed-but-unprobed OpenCode reports sign-in
"unknown" (not "signed in", not "not signed in") until `auth.json` or a
model-provider env var gives positive evidence.

Non-TTY caveat for `agy`: stdout is gated on `isatty()` (upstream bug) — a PTY
bridge is required for headless capture. That is an I/O shim over structured
stream-json, not Tier E scraping.

### Adding a provider (issue #300)

Everything Florina knows about a provider lives in **one manifest entry** in
`src/core/application/use-cases/readiness/provider-manifests.ts`
(`PROVIDER_MANIFESTS`): id (= adapter id), `docsUrl` audit trail,
`FLORINA_*_CMD` env override, executable name, beyond-PATH candidates,
transport, not-found wording, credential evidence, sign-in recipe, and
per-platform installers. From that one entry the code derives:

- **attachment** — `attachLocalAgentProviders` iterates manifests, resolves the
  executable (env override → PATH → candidate specs), and dispatches on
  `transport.kind` to the right adapter (hooks / acp / app-server / stream-json);
- **readiness** — `FIXES`, `INSTALLERS`, and `CREDENTIAL_EVIDENCE` are all
  `providerTables(PROVIDER_MANIFESTS)` derivations, so sign-in recipes,
  installers, and credential probes can never drift from the provider list.

So: **to add a provider, write one manifest entry.** Only when it needs a
transport kind that doesn't exist yet do you also add an arm to the
attachment switch plus its adapter class. `tests/provider-manifest.test.ts`
enforces the contract — manifest ids ≡ adapter ids, every manifest carries a
`docsUrl`, credential probes are existence-metadata only. Two hardcoded id
lists deliberately trip when a provider is added (`adapterIds` in
provider-manifest.test.ts, the expected list in provider-readiness.test.ts) —
updating them is part of the one-entry ceremony, not a second edit site.

One honesty note on transports: `kind` maps 1:1 to an adapter class today —
reusing `stream-json` for a non-agy CLI would silently spawn agy's invocation.
A provider on a shared kind must speak that adapter's exact protocol; extend
the variant or add a kind otherwise (see `ProviderTransport`'s doc comment).

Safety rules for manifest entries: installers come only from the provider's
**official** docs (cite `docsUrl`; `null` on unverified platforms → manual
instructions, never a guessed command); sign-in recipes run the provider's own
command in a _visible_ terminal; credential evidence names files / env vars /
keyring targets for existence probes — nothing ever reads a secret value.

Attachment is not a once-at-startup snapshot (issue #301): every
`query-providers` call re-resolves providers previously skipped `not-found`
via `refreshSkippedProviders` — concurrent queries share one in-flight
refresh, already-registered ids are never re-attached, and a refresh-spawned
app-server child composes into the same dispose. A CLI installed mid-run
appears on the next `florina status`; restart remains only for PATH entries
the daemon's stale env can't see and no manifest candidate covers (why agy's
installer dir is also a `win32` candidate).

## Flow

1. **Preference learning** (voice): the Secretary auto-writes preference
   memories — model-level natural-language rules conditioned on work type
   and quota (e.g. "Claude: deny Opus/Faber, Sonnet default, Haiku for
   reading; Devin: GPT extra-high until quota → SWE-2/GLM-5"). Preferences
   are **prompts, scoped per project on a need-to-know basis**: a project's
   manager sees its own project's preferences + global defaults. Managers
   express preference in spawn calls; the daemon enforces the hard floor —
   quota ledger, deny rules, policy (issue #65).
2. **Ideation** (DEC-033): unstructured voice monologue → collaborative
   thinking (background research, structure, open questions, the right
   questions asked back) → a growing **per-idea markdown ledger** → on your
   say-so, a compiled **Brief** shown for approval → only then delegation.
   Nothing dispatches automatically; confirming the Brief is the gate.
3. **Delegation**: the Secretary routes the Brief through the daemon; the
   project's manager agent decomposes the work.
4. **Dispatch**: managers call daemon MCP tools (`secretary_spawn_task` …) —
   journaled, policy-checked, quota-checked (issue #63).
5. **Routing**: `CapacityRouter` picks the highest-preference provider with
   capacity; `QuotaLedger` polls quota APIs proactively and reacts to
   exhaustion errors everywhere (issue #60).
6. **Failover**: exhaustion → freeze session → resume in same worktree from
   Task Capsule on next provider; all exhausted → park until earliest
   `resets_at` (issue #64).
7. **Attention**: provider events normalize to `SupervisorEvent`s → journal →
   deterministic attention engine → inbox / voice digest.

## Key Invariants

- Secretary is the only self-owned agent loop; every worker/manager is a
  provider agent behind an adapter (DEC-001, DEC-013).
- No parallel orchestration channel: managers dispatch exclusively through
  daemon MCP tools (DEC-018 amendment).
- Failover never crosses the local/cloud boundary — Devin Cloud is out of
  scope (DEC-029).
- Permissions auto-approve only inside user-granted scopes (DEC-007/010/011);
  anything outside escalates to a structured approval card — voice for
  low-risk readbacks, visual confirmation for the rest.
- **Federation** (DEC-036): a remote machine runs the full stack and
  registers as a sub-secretary — a provider-shaped capacity pool reached
  through the same typed API. Its fleet appears in the parent's QuotaLedger
  as `provider@host`; its events roll up the chain; Task Capsule is the
  delegation payload. Recurses: a child may have sub-secretaries.
