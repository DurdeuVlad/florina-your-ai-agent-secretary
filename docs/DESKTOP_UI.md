# Desktop App: View Inventory & Continuous-Agent Context

Design for the Electron/Tauri client (DEC-028, issue #43). Locked 2026-09-13.

**Principle: we are the inbox, not the fleet cockpit.** Every competitor
(Runner, KanbAgent, CodexOpsStudio, Dorchestrator, vibe-editor) builds a
mission-control dashboard. Our home screen stays NEEDS YOU / WORKING / DONE
(DEC-006/008). What we steal from them is the _drill-down_ — how a human
inspects one manager, one worker, one session, once attention is earned.

## Prior art worth stealing

| Project        | Pattern                                                             | What we take                                                             |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Runner (ADE)   | crews + missions over an append-only event log; `ask_human` in feed | event-log drill-down; human questions inline in the stream               |
| vibe-editor    | Leader recruits workers via tools                                   | already our manager→MCP-spawn shape; their canvas = our graph drill-down |
| CodexOpsStudio | three columns: sessions / orchestrator timeline / review gate       | manager view layout: task list / run timeline / approval+digest rail     |
| KanbAgent      | task tree via parent_task_id; cost analytics                        | Brief → task tree for delegated work; quota/cost panel                   |
| OpenHands      | condenser + two-tier MEMORY.md                                      | continuous-agent context model (below)                                   |

## Views

```
┌──────────────────────────────────────────────────────────┐
│ INBOX (home)         NEEDS YOU 3 · WORKING 5 · DONE 4    │
│  approval cards · digests · decisions · failures         │
└──────────────────────────────────────────────────────────┘
        │ drill down (progressive disclosure, j/k nav)
        ▼
┌─────────────┬──────────────────────┬─────────────────────┐
│ PROJECTS    │ PROJECT VIEW         │ AGENT/SESSION       │
│ list        │ manager card +       │ INSPECTOR           │
│             │ its tasks + workers  │ event timeline →    │
│             │                      │ transcript → diff   │
└─────────────┴──────────────────────┴─────────────────────┘

┌──────────────┬───────────────┬───────────────┬───────────┐
│ FLEET/QUOTA  │ IDEAS         │ PREFERENCES   │ SECRETARY │
│ per-provider │ ledger list   │ learned rules │ her plan, │
│ bars + reset │ + reader +    │ editable +    │ research, │
│ countdowns   │ compile→Brief │ provenance    │ memory    │
└──────────────┴───────────────┴───────────────┴───────────┘
```

- **Inbox** (exists): approval cards, completion digests, grouped completions.
- **Project view**: the manager card (status, current objective, context
  health) + its task list + workers. Manager is first-class — you talk to the
  manager, not its workers.
- **Agent/session inspector**: SupervisorEvent timeline → expandable into
  transcript/tool calls → diff/deliverables. Tier-aware: Tier A–B show
  structured permission events; Tier D shows verified output only.
- **Fleet/quota** (novel — our differentiator gets a surface): per-provider
  utilization bars, reset countdowns, active routing decisions, parked tasks
  with resume times. This is where "Codex is dry until 14:32 — moved to
  Gemini" becomes visible.
- **Ideas**: the global ledger directory; reader view; "Compile Brief" →
  Brief approval card in the inbox (the DEC-033 gate, surfaced visually).
- **Preferences**: learned rules rendered readably, edit/confirm/revoke,
  provenance ("learned from voice, Sept 13").
- **Secretary**: her current plan/todo, in-flight research, pending memory
  writes awaiting confirmation.

## Continuous-agent context (DEC-035)

Secretary and managers run for days — context is a three-layer system:

| Layer    | Holds                               | Mechanism                                                                                                                                      |
| -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hot**  | current working context             | in-window events/messages                                                                                                                      |
| **Warm** | condensed history + loaded capsules | condenser (threshold-triggered LLM summarization, keep first N + last M, summarize middle — OpenHands pattern) + capsule load/unload (DEC-020) |
| **Cold** | everything, forever                 | event journal (DEC-012), preference memories, idea ledgers, MEMORY.md-style durable notes                                                      |

Invariants:

- Condensation emits a journaled event carrying `forgotten_event_ids` —
  compression never destroys the record (DEC-012). The inspector can expand
  through any summary into the raw events.
- The **context health indicator** per continuous agent (Secretary,
  managers) is a first-class UI element: window fill, last condensation,
  memory size. Degraded context = degraded reasoning = an attention item.
- Two-tier durable memory mirrors capsules: User scope (cross-project
  preferences) + Project scope (repo knowledge) — convergent with OpenHands'
  USER/PROJECT memory tiers.
