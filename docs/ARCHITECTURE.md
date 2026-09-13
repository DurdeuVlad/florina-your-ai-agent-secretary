# Architecture: Multi-Provider Orchestration

**Status: design locked 2026-09-13.**

The directed graph of how Agent Secretary works. See DECISION_LEDGER.md for the
rulings (DEC-011/012/013/018/020/021/024/029–034) and milestone
`M6-Multi-Provider-Orchestration` (issues #60–#71) for the work breakdown.

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

| Provider | Adapter surface | Tier | Quota signal | Session resume |
|---|---|---|---|---|
| Codex | `codex app-server` JSON-RPC | A | `account/rateLimits/read` → `usedPercent`, `resetsAt` (5h + weekly) | thread resume |
| Claude Code | CLI + lifecycle hooks / Agent SDK | B | statusline `rate_limits` (5h + 7d `resets_at`); `anthropic-ratelimit-unified-*` headers | `--resume` |
| Devin CLI | `devin acp` (ACP/JSON-RPC stdio); `-p` print mode; hooks | C | none documented → reactive | `-c` / `-r` / `/fork` |
| Gemini CLI | `gemini --acp` (ACP); `-p --output-format stream-json` | C / D | none → 429 detection + session-file token sums | `--continue` |
| Antigravity `agy` | `agy -p --output-format stream-json` | D | none → reactive | `--continue` / `--conversation` |

Non-TTY caveat for `agy`: stdout is gated on `isatty()` (upstream bug) — a PTY
bridge is required for headless capture. That is an I/O shim over structured
stream-json, not Tier E scraping.

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
3. **Dispatch**: managers call daemon MCP tools (`secretary_spawn_task` …) —
   journaled, policy-checked, quota-checked (issue #63).
4. **Routing**: `CapacityRouter` picks the highest-preference provider with
   capacity; `QuotaLedger` polls quota APIs proactively and reacts to
   exhaustion errors everywhere (issue #60).
5. **Failover**: exhaustion → freeze session → resume in same worktree from
   Task Capsule on next provider; all exhausted → park until earliest
   `resets_at` (issue #64).
6. **Attention**: provider events normalize to `SupervisorEvent`s → journal →
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
