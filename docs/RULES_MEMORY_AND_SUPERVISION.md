# Rules, Memory & Supervision Model

Evolves `PRODUCT_DESIGN.md`'s Attention Model and DEC-020/029 (Context
Capsules, provider preference profile) into a general-purpose rule/memory
system and a formal supervision ladder. This is the doctrine for the
**"user <-> Florina" cognitive-load transfer** described in `PRODUCT_DESIGN.md`
§ Core Domain Objects — the part of the product that lets a user stop
repeating themselves and stop reconstructing state by hand.

Cross-links: `PRODUCT_DESIGN.md` (domain objects, attention model),
`DECISION_LEDGER.md` DEC-020, DEC-029, DEC-031, DEC-033, DEC-035, DEC-039–DEC-042,
`docs/PROVIDER_TOPOLOGY.md`, `docs/UX_FLOWS.md`, `docs/GAP_ANALYSIS.md`.

## 1. Why this generalizes DEC-029

DEC-029 already gives Florina an auto-written, provenance-carrying memory —
but scoped to one thing: provider/model routing preference. The first user's
actual requests ("research prior art before deciding," "don't refactor
unrelated files," "review auth changes with a second agent") are the same
shape of fact — a preference or rule inferred from conversation, with
provenance, scope, and confidence — about **how work should be done**, not
just **which provider does it**. Section 2 below is DEC-029's memory model
made general; the `CapacityRouter` becomes one consumer of it, not the whole
of it.

## 2. Memory taxonomy

Every persisted unit of memory carries the same envelope regardless of kind:

```
{
  id, kind, scope, statement, provenance, confidence,
  created_at, updated_at, status, supersedes?, conflicts_with?
}
```

**Kinds** (internal distinction; the user never has to pick one — see § 3):

| Kind | Example | Mutability |
|---|---|---|
| **Fact** | "This repo's tests are `npm test`" | Rarely revised; usually re-derived from observation, not conversation |
| **Preference** | "Prefer Codex for mechanical refactors" | Soft — nudges routing/selection, never gates safety |
| **Rule** | "Research prior art before large architecture decisions" | Shapes the Execution Brief (§ 5); can be scoped/narrowed/retired |
| **Hard policy / safety boundary** | "Never deploy without approval" | Explicit-only (§ 4); never silently inferred, never silently loosened |
| **Project knowledge** | "This project uses hexagonal architecture; new code goes in `src/core`" | Project-scoped fact, feeds every Task in that project |
| **Decision** | "We chose LiteLLM as the model connector (DEC-034)" | Immutable once recorded; a fact about a past judgment |
| **Temporary instruction** | "For this task only, skip the lint gate" | Task/session-scoped; expires when the task closes |
| **Learned pattern** | "User corrects scope creep on bug fixes roughly every third session" | Lowest confidence; informs rule *proposals*, not enforcement, until confirmed |

**Scopes**: `global` (User capsule, DEC-020 amendment), `project` (Project
capsule), `task`/`session` (temporary, expires with the task). A rule learned
inside a project never silently promotes to global — promotion is always an
explicit user action (brief § 4 principle: "project-specific preferences
should not automatically become global").

## 3. Provenance and confidence

Every memory item's `provenance` is one of:

- `explicit` — the user said "remember this," "always do X," or gave a
  direct instruction Florina recorded verbatim intent from. Strongest;
  never auto-revised without a new explicit statement.
- `inferred-repeated` — the same directional correction observed ≥2 times
  across distinct sessions/turns (brief § 4 examples: "research first,"
  "keep it scoped," repeated). Recorded as `status: proposed` until the user
  confirms it once (conversationally or via the Settings memory audit, §
  6.3) — after confirmation it behaves like `explicit`.
- `inferred-single` — a single strong statement that looks rule-shaped but
  hasn't repeated. Recorded as `status: candidate`, surfaced passively (never
  interrupts), never applied to an Execution Brief until either it repeats
  (promotes to `inferred-repeated`) or the user confirms it directly.
- `observed` — derived from deterministic state (git, test results, adapter
  events), not conversation. Facts, mostly.

`confidence` is a coarse three-value field (`low` / `medium` / `high`) driven
by provenance + repetition count, not a numeric score — a numeric score
implies precision the underlying signal doesn't have, and the UI (§ 6.3)
only ever needs to render three states plus "explicit."

## 4. What must never be automatically learned

Per DEC-011 (narrow, never silently widen) and the brief's explicit
requirement (§ 4, § 30 non-goals): the following classes are **never**
written from `inferred-*` provenance, regardless of repetition. They require
an explicit, confirmed Decision (DEC-010/031 discipline — structured
confirmation, not vibes):

- Anything that loosens an approval/autonomy boundary (auto-approve a
  previously-gated capability, widen a permission scope).
- Anything touching credentials, secrets, or the capability broker (DEC-022).
- Anything that disables or narrows a hard policy / safety boundary.
- Anything that changes who can trigger deploy/merge/push.

A statement that *sounds* like one of these ("stop asking me about network
access") is captured as a `candidate` rule and surfaced as a Decision the
next time it would apply — never silently activated. This is the one place
interruption-avoidance (DEC-031) yields to safety.

## 5. Rule lifecycle

```
proposed/candidate --(user confirms)--> active --(user narrows/edits)--> active (revised)
                    --(contradicted)---> conflict --(user resolves)-----> active | retired
active --(user says "stop / forget that")--> retired
active --(new explicit rule on same topic)--> superseded (old kept for provenance, not applied)
```

- **Contradiction detection** runs when a new rule is written: does it
  conflict in scope+topic with an existing active rule? If yes, the item
  enters `conflict` status and is *not* silently overwritten — a Decision is
  raised the next natural time it's relevant (brief's worked example: "you've
  repeatedly preferred Claude for UI reasoning, but I still have an older
  rule preferring Codex for frontend work — replace or narrow?"). Conflict
  resolution is never forced onto an unrelated turn; it rides along with
  the next relevant request.
- **Retirement** is soft-delete: the row moves to `retired` with the
  retiring event linked, never physically erased (DEC-012 journal discipline
  extends to memory — every write is an event first).
- **Narrowing** ("I changed my mind, stop doing that for internal
  refactors") creates a new `active` rule with a tighter scope/tag and
  supersedes the old one for that scope only — the parent rule can remain
  active for cases outside the narrowed exception.

## 6. Retrieval without prompt bloat: the Execution Brief Compiler

This is the concrete answer to brief § 5 and Key Product Question 14/15.
Florina must not inject hundreds of rules into every worker prompt.

### 6.1 Inputs

```
user request + project context + current work state (task graph, quota, git)
  + user-scope memory (rules/preferences/facts, global)
  + project-scope memory (rules/preferences/facts, this project)
  + hard policies (never filtered out)
  + provider capability/fidelity data (DEC-013/030)
```

### 6.2 Resolution algorithm (deterministic filter, then compile)

1. **Tag-match**: every rule carries topic tags (`frontend`, `bugfix`,
   `security`, `provider-choice`, `verification`, …) assigned at write time
   (inferred from the conversation that produced it, or explicit). A
   candidate set is pulled by tag overlap with the request's inferred
   topic(s) — this step is cheap/deterministic (string/tag matching), not an
   LLM call.
2. **Scope filter**: keep global rules always; keep project rules only for
   this project; drop expired temporary instructions.
3. **Conflict resolution** within the candidate set, in priority order:
   `hard policy` > `explicit` > `inferred-repeated (confirmed)` >
   `project-specific` beats `global` on the same topic > most recent wins
   ties. Hard policies are never excluded by this ranking — they're unioned
   in after ranking, unconditionally.
4. **Compile**: the surviving rule set + task objective + relevant project
   knowledge + verification requirements are assembled into an **Execution
   Brief** (§ 6.4) by a single LLM call whose job is compilation/wording,
   not selection — selection already happened deterministically in steps
   1–3. This keeps the *decision* of what's relevant auditable outside the
   model, per DEC-014's "deterministic first" philosophy.

### 6.3 Worked example (brief's own case)

Request: "Fix this TypeScript API bug."
Tag-match surfaces: `bugfix` (scoped-diff rule, reproduce-first rule),
`verification` (done-means-proven, DEC-032), `global-dev` (inspect existing
conventions before adding abstractions). It does **not** surface unrelated
tags like `frontend-research-first` or `deploy-approval`. The compiled brief
carries exactly those four rules plus the project's hexagonal-architecture
fact (project knowledge) — not the other ~dozen active global rules about
voice interaction or provider routing.

### 6.4 Execution Brief structure (inspectable artifact)

```
Objective:            <what the worker must achieve>
Relevant context:     <project knowledge, prior related work, links>
Applicable rules:     <rule text + id + provenance + scope, one line each>
Constraints:          <non-goals, scope boundaries>
Required verification:<tests/build/lint/manual checks that must run before "done">
Definition of done:   <observable, not "looks right">
Provider/worker rationale: <why this provider/model, referencing quota + preference>
```

The Brief is the literal thing shown in the inspector when a user asks "why
did you send this to Gemini?" (brief flow M) — it is not reconstructed after
the fact, it is the actual object handed to the manager/worker's prompt
(consistent with DEC-034's journaled-loop-events philosophy: the Brief is
generated as a journaled artifact, not synthesized retroactively).

## 7. Supervision ladder (event-driven, cost-aware)

Extends DEC-014's deterministic-first attention engine with the explicit
5-level ladder from the brief. Levels 0–1 already exist in the shipped
attention engine (`ALWAYS SURFACE` / `BATCH` / `ELEVATE` rules,
`PRODUCT_DESIGN.md` § Attention Model); this section names the two levels
above it that are currently implicit in "manager reasoning" and formalizes
when each is invoked, so cost stays bounded as rule count grows.

| Level | What runs | Trigger | Cost |
|---|---|---|---|
| **L0 deterministic** | Event/state transitions: test result, git state, liveness timer, quota reading, policy check | Every event | Free (no model call) |
| **L1 cheap classification** | Small/fast model or heuristic: normal vs suspicious, routine vs anomalous | L0 flags "ambiguous" (not clearly routine, not clearly always-surface) | Cheap, high volume |
| **L2 manager reasoning** | Project manager agent decides: retry, refine task, request independent verification, recover worker | L1 flags anomaly the manager's scope can resolve | Moderate, bounded by manager's own budget/context (DEC-035) |
| **L3 Florina reasoning** | Cross-objective/cross-project implications, priority conflicts, provider failover decisions | L2 escalates (manager can't resolve within its authority, or it's cross-project) | Higher, but rare by construction |
| **L4 human** | Genuine judgment: product decision, ambiguous consequential trade-off, safety-adjacent change | L3 exhausts silent resolution (DEC-031) or hits a Never-Auto-Learn boundary (§ 4) | Human attention — the scarce resource this whole ladder protects |

**Escalation triggers** (concrete, extending the existing ALWAYS
SURFACE/ELEVATE rule tables): repeated test failure past a threshold;
inactivity beyond the liveness timeout; edits outside declared task scope
(git diff paths not matching the Brief's constraints); a "done" claim with
no verification evidence attached (DEC-032 gate — this one is a hard L0
block, not even reaching L4 as a question, it's routed back as a task); a
provider quota exhaustion event; measured context-window degradation
(DEC-035 context health); a retry loop exceeding N attempts; a permission
request; a new event contradicting an active rule (§ 5 conflict path); an
ambiguous product decision; a cross-project priority conflict (two active
objectives now compete for the same scarce provider capacity).

Cost discipline: most agent activity (normal file edits, tests running,
heartbeats, expected tool calls) never leaves L0. L1 only fires on
already-flagged ambiguity, not on every event. This is the mechanism that
keeps "hundreds of rules" from becoming "hundreds of LLM calls per task" —
rule matching in § 6.2 is a filter, not a classifier.

## 8. Attention brokerage refinements

Builds on the shipped ALWAYS SURFACE / BATCH / ELEVATE engine
(`PRODUCT_DESIGN.md`):

- **Deduplication**: identical attention reasons across sibling tasks (e.g.
  5 doc-only tasks all completing cleanly) collapse to one digest row before
  ever reaching L4 — this already exists conceptually in the mockup ("5
  completed doc tasks collapse into one digest"); this doc makes it a named
  behavior of the L0→L1 boundary, not a UI-only grouping.
- **Bundling**: attention items sharing a project and a time window bundle
  under one card with an expand affordance, not N separate interruptions.
- **Urgency vs batching**: an item's priority (from the existing HIGH/MED/LOW
  model) determines whether it interrupts immediately, waits for the next
  natural check-in, or waits for an explicit "catch me up" (§ 10).
- **"Tell me later"**: any attention item can be explicitly deferred by the
  user; deferral is itself a journaled Decision with a re-surface condition
  (time-based or event-based), not a silent dismissal.
- **The valuable null state**: "nothing needs you" is a first-class,
  deliberately rendered state (see `docs/UX_FLOWS.md` § Home, § UX States) —
  not the absence of UI, an explicit confirmation that the ladder ran and
  found nothing.

## 9. Resumption as a first-class capability

**"Catch me up"** is the flagship flow (brief § 10, § 15C). Mechanism:

1. Florina records `last_active_at` per user session (not per task — a
   single global watermark, since the point is reconstructing the *human's*
   context, not each project's).
2. On return (explicit command, or automatically on the Chat view's first
   render after an idle gap past a threshold), Florina queries: tasks that
   transitioned to `completed`/`failed`/`attention-needed` since the
   watermark; tasks still `running`; attention items currently `pending`
   grouped by priority; any provider failovers that occurred (DEC-029) with
   before/after provider named (continuity/provenance, not silently hidden).
3. These are compiled through the same digest-writing path as completion
   digests (`PRODUCT_DESIGN.md` § Deliverable Review) — deterministic facts
   first, LLM narrative layered on top, never the reverse.
4. Output follows the brief's example shape: N completed / M running / K
   need-decision, then one line per notable item, then an explicit "nothing
   else needs you" close. Every line drills into its underlying Task,
   Deliverable, or Attention Item (progressive disclosure, not a dead-end
   paragraph).
5. The watermark advances only after the digest is actually delivered
   (read/spoken), so a client crash before delivery doesn't silently skip a
   catch-up window.

## 10. Proof of completion ("Prove it")

Already grounded by DEC-032 (verification-gated completion) and DEC-012
(journal is truth). This section specifies the UX contract: any claim
Florina makes ("implementation complete," "root cause identified," "31/31
tests pass") must resolve, on request, to the underlying evidence chain:
journaled event(s) → adapter-reported tool call/test result → (optionally)
the raw transcript. "Prove it" is not a new subsystem — it's a guaranteed
drill-down path required on every completion/decision-adjacent statement
Florina's chat surface renders. See `docs/UX_FLOWS.md` flow M and the
evidence/provenance component in `docs/GAP_ANALYSIS.md`.

## 11. Risks this model must confront (per brief § 28), with mitigations

| Risk | Mitigation already designed above |
|---|---|
| A single permanent conversation degrades over long timeframes | Three-layer context model (DEC-035) already applies to the Florina loop itself; rules are retrieved by tag-match (§ 6.2), not replayed into every turn |
| Persistent manager agents drift/misbehave over long runs | L2/L3 escalation ladder (§ 7) + context health as an attention-worthy signal (DEC-035) |
| Automatic rule learning becomes annoying or unsafe | Two-strike `inferred-repeated` threshold before anything applies (§ 3); hard exclusion list (§ 4); conflicts surface as Decisions, never silent overwrites (§ 5) |
| Over-automation erodes trust | Every silent resolution is journaled and user-auditable (DEC-031); "Prove it" is guaranteed (§ 10); DEC-010 structured-approval discipline is untouched by any of this |
| Summaries hide critical information | DEC-012 discipline preserved — summaries are projections, raw events always reachable; condensation journals `forgotten_event_ids` (DEC-035) |
| Cross-provider failover loses context | Task Capsule is the uniform handoff artifact (DEC-029/036) — this doc adds nothing new here, it was already solved; catch-up (§ 9) surfaces the failover explicitly rather than hiding it |
| Provider-native subagents can't be controlled uniformly | Addressed in `docs/PROVIDER_TOPOLOGY.md` via the Observed tier — Florina doesn't pretend to control what it can only see |
| Large personal memory causes prompt/context degradation | § 6 exists specifically to prevent "dump everything into the prompt"; retrieval is deterministic and scoped, not a growing preamble |

## 12. Key product questions answered (brief § 29)

| # | Question | Answer |
|---|---|---|
| 9 | How are rules created? | Explicit ("remember this," direct instruction) or via `inferred-repeated` after ≥2 corroborating turns, with a confirmation step for the latter (§ 3) |
| 10 | How are rules inferred? | Correction/repetition pattern detection over conversation turns; never from a single utterance for anything safety-adjacent (§ 4) |
| 11 | How are conflicting rules resolved? | Deterministic priority order in § 6.2, with unresolved topic-level conflicts raised as a Decision at the next relevant moment (§ 5) |
| 12 | What may become persistent memory? | Anything in the taxonomy (§ 2) except the § 4 exclusion list, which requires explicit confirmation regardless of repetition |
| 13 | How does the user inspect/correct/forget memory? | Conversationally ("what do you remember about how I work?", "forget that," "narrow that to X") and via the Settings memory audit surface (`docs/UX_INFORMATION_ARCHITECTURE.md` § Settings) |
| 14 | How are applicable rules selected without prompt-dumping? | Tag-match + scope-filter + deterministic conflict resolution, § 6.2 |
| 15 | What does an Execution Brief contain? | § 6.4 |
| 17 | How does monitoring stay cost-efficient? | L0/L1 deterministic-first ladder, § 7 |
| 18 | What happens when a worker goes haywire? | Escalation triggers in § 7 route through manager (L2) before ever reaching the human (L4); out-of-scope edits are one of the explicit triggers |
| 6 | How does Florina reconstruct state after inactivity? | § 9 |
| 7 | How does Florina know what warrants attention? | Existing ALWAYS SURFACE/BATCH/ELEVATE rules (`PRODUCT_DESIGN.md`) plus § 7's escalation triggers |
| 8 | What constitutes "done"? | DEC-032, unchanged: verification evidence attached, not agent self-report |
| 24 | How is every AI conclusion traced to evidence? | § 10, "Prove it" contract |
