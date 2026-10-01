# User Flows, UX States, and Component Concepts

Covers brief §§ 15, 17, 21 — the human-facing flows through Florina, the
non-happy-path states each surface must render, and the key UI component
concepts (described experientially, not pixel specs — pixel specs live in
`docs/UX_GUIDELINES.md`). Cross-links: `docs/UX_INFORMATION_ARCHITECTURE.md`
(where each flow lands in the nav), `docs/RULES_MEMORY_AND_SUPERVISION.md`
(mechanisms behind catch-up, evidence, rules), `docs/SYSTEM_FLOWS.md`
(machine-side sequence diagrams for the same flows), and
`docs/UX_ONBOARDING_AUDIT.md` (one user's setup and first-task journey; the
separate implementation campaign is in
`docs/UX_ONBOARDING_CAMPAIGN.md`).

## A. Delegate a simple task

User states an objective conversationally (Florina/home). Florina resolves
applicable rules and project context, compiles an Execution Brief
(`docs/RULES_MEMORY_AND_SUPERVISION.md` § 6), selects a provider per the
capacity router (DEC-029), and dispatches. If nothing is ambiguous, no
question is asked (DEC-031) — the reply is a confirmation with the chosen
provider and a one-line rationale, and the Task now appears under Work.

## B. Delegate a complex objective

Same entry point, but the request doesn't resolve to one Task. Florina
proposes a decomposition (via a project manager, DEC-018) — parallel
workstreams shown as a short list before dispatch, not after. The user can
adjust the breakdown before confirming (this is the DEC-033 Brief-gate
pattern generalized beyond ideation: any multi-task decomposition is shown,
not silently executed). Once confirmed, each workstream becomes a Task
under the same Project, visible in Work's drill-down (project -> tasks ->
workers) so the user can progressively inspect any one of them without the
others crowding the view.

## C. User walks away and returns (full catch-up)

The flagship flow — full mechanism in `docs/RULES_MEMORY_AND_SUPERVISION.md`
§ 9. UX shape: returning to the app (or issuing "catch me up") renders the
digest as the next message in the Florina thread: N completed / M running /
K need-decision, one line each for notable items, explicit "nothing else
needs you" close. Every line is a live link into Work/Attention/History —
the digest is a summary _with_ drill-down, never a dead end.

## D. Work needs human judgment

Worker hits something outside its authority -> escalates to its manager
(L2) -> manager either resolves within scope or escalates to Florina (L3)
-> Florina checks memory/grants/context (DEC-031) and either resolves
silently (journaled) or raises an Attention Item (L4) -> user answers
(chat, or the Attention card's structured action) -> the answer routes back
down the same path as a Decision, unblocking the original worker. See
`docs/SYSTEM_FLOWS.md` diagram 4.

## E. Routine problem handled automatically (inspectable)

E.g. a flaky test retried once, a transient network error retried with
backoff, a lint autofix applied. These resolve at L0/L1/L2
(`docs/RULES_MEMORY_AND_SUPERVISION.md` § 7) and are journaled but never
surfaced as an Attention Item. The user can inspect them after the fact via
Work's event timeline or History's journal view — inspectable by choice,
invisible by default (Attention Over Activity, `PRODUCT_DESIGN.md`).

## F. Provider failover

Quota exhaustion detected (proactive poll or reactive 429) -> CapacityRouter
selects the next preferred provider with capacity (DEC-029) -> session
freezes, Task resumes in the same worktree from the Task Capsule on the new
provider -> the transition is journaled with both providers named
(provenance, not hidden) -> the next catch-up or Work drill-down for that
Task shows "started on Codex, moved to Claude at 14:32 (quota)" as a plain
fact in the Task's timeline, not buried. If every provider is exhausted, the
Task parks and the earliest `resets_at` becomes a visible countdown
(Settings > Providers, and the Task's own status).

## G. Completion and review

Worker claims done -> manager drives verification before reporting up
(DEC-032) -> if verification evidence is missing, the claim is routed back
to the worker as a verification objective, never surfaced to the human as
"complete" -> once evidence exists, Florina produces a Completion Digest
(`PRODUCT_DESIGN.md` § Deliverable Review) -> appears in Attention
(ready-for-review) -> user reviews digest, optionally drills into diff/tests
via "Prove it" (`docs/RULES_MEMORY_AND_SUPERVISION.md` § 10) -> accepts,
requests changes (creates a follow-up Task), or sends back.

## H. Explicit rule creation

User says "remember this" / "always do X" / "for this project, never Y
without agreeing on direction first." Recorded immediately as `explicit`
provenance (`docs/RULES_MEMORY_AND_SUPERVISION.md` § 3), scoped
global/project per context, confirmed back in one line ("Got it — for this
project, I'll hold UX changes until we've agreed on direction"). No
confirmation round-trip needed beyond that acknowledgment; explicit rules
don't require the two-strike threshold inferred rules do.

## I. Implicit rule learning

User repeats a directional correction across sessions -> second occurrence
promotes the rule from `candidate` to `proposed` -> next time it's about to
apply, Florina surfaces it once, low-friction ("You've mentioned scoping bug
fixes tightly a couple of times — should I make that a standing rule for
this project, or just this task?") -> user confirms/narrows/declines ->
recorded with full provenance chain (the two originating turns, if
available). Never silently activated for the § 4 exclusion list regardless
of repetition count.

## J. Rule inspection

"What do you remember about how I work?" (conversational) or Settings'
memory audit (browsable, filterable by scope/kind/provenance). Both render
the same underlying rows: statement, scope, provenance, confidence, when
learned, when last applied. Every row supports "forget this," "narrow this
to X," "make this global" (with the promotion friction noted in
`docs/RULES_MEMORY_AND_SUPERVISION.md` § 2 — never silent) inline.

## K. Rule conflict resolution

New rule contradicts an existing active rule on the same topic+scope -> both
enter `conflict` status -> surfaced the next time either would apply, not
immediately and not out of context ("You've repeatedly preferred Claude for
UI reasoning, but I still have an older rule preferring Codex for frontend
work — replace or narrow?") -> user's answer resolves both to a single
`active` rule, the loser marked `superseded` (kept for provenance, never
re-applied).

## L. Project-specific behavior

Global rules + project rules combine at Execution Brief compile time
(`docs/RULES_MEMORY_AND_SUPERVISION.md` § 6.2) — project rules on the same
topic outrank global ones for that project only. A user can inspect "what
applies here" from a project's Work view, which is the compiled union, not
two separate lists the user must merge mentally.

## M. Deep inspection

Objective/Task -> Worker/Run -> event timeline -> transcript/tool call ->
diff/test/evidence. This is the existing three-column Session Inspector
pattern (`docs/DESKTOP_UI.md`), reachable from Work without polluting the
default experience — Florina/home and Attention never show this level of
detail unprompted; it exists exactly one deliberate drill-down away
(Progressive Disclosure, `PRODUCT_DESIGN.md`).

## N. New provider setup

User adds a provider (CLI installed, or credentials supplied) -> Florina
probes for availability/auth/capability (adapter fidelity tier, DEC-013) ->
reports back in structured terms: what's supported (auto-approve eligible?
which event types?), what isn't (e.g. Tier D/E gets no auto-approval,
`PRODUCT_DESIGN.md` § Agent Adapters), and any known caveats
(`docs/PROVIDER_TOPOLOGY.md` § 2, e.g. Gemini's flaky-429 quota signal) ->
provider appears in Settings > Providers with its tier badge, and becomes
selectable by the capacity router per any preference rules that name it.

## O. Something goes badly wrong

A worker's edits diverge far outside its Brief's declared scope, or repeated
failures exceed the retry ceiling, or a sandbox violation fires. This is an
L0/L1 hard trigger (`docs/RULES_MEMORY_AND_SUPERVISION.md` § 7) — bypasses
L2/L3 softening and reaches L4 immediately as a Critical Attention Item with
the deterministic evidence attached (what changed, what was expected,
what's out of scope) and a recommended containment action (pause the
worktree, don't merge, inspect). Never auto-resolved, never batched.

---

## UX states (brief § 17)

Applied to the surfaces that matter most — Attention, Work item, Florina
home, Settings/Providers:

| State                     | Attention (item)                                                                | Work (task)                                                       | Florina home                                                | Settings/Providers                                    |
| ------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Empty                     | "Nothing needs you" (explicit, calm)                                            | "No active work"                                                  | Composer only, no strip                                     | "No providers configured" + setup CTA                 |
| Working                   | n/a (not attention-worthy by itself)                                            | Live status word (`editing`, `tests running`)                     | Ambient strip count                                         | n/a                                                   |
| Needs attention           | The card itself                                                                 | Badge on the task row                                             | Strip count > 0                                             | Provider degraded badge                               |
| Ready for review          | Completion digest card                                                          | "Ready for review" status                                         | Surfaces via strip/digest                                   | n/a                                                   |
| Partially complete        | n/a                                                                             | "3/5 workstreams done" rollup                                     | n/a                                                         | n/a                                                   |
| Failed                    | Failure card, evidence attached                                                 | "Failed" + retry/inspect actions                                  | n/a                                                         | Provider auth failed                                  |
| Recovering                | n/a (handled silently unless escalated)                                         | "Retrying (2/3)"                                                  | n/a                                                         | n/a                                                   |
| Paused                    | n/a                                                                             | "Parked until 14:32" + countdown                                  | n/a                                                         | n/a                                                   |
| Provider unavailable      | Elevated if it blocks active work                                               | Task shows blocked reason                                         | n/a                                                         | Tier badge greys out, reason shown                    |
| Degraded observability    | n/a                                                                             | Inspector shows "Tier D — verified output only, no permission UI" | n/a                                                         | Tier badge (not an error — a fidelity fact)           |
| Offline (daemon)          | Stale-but-readable, amber indicator                                             | Same                                                              | Amber "reconnecting," content stays                         | Same                                                  |
| Returned after inactivity | n/a                                                                             | n/a                                                               | Catch-up digest renders first                               | n/a                                                   |
| Conflicting learned rule  | n/a                                                                             | n/a                                                               | n/a                                                         | Conflict badge on the rule row, resolves via Decision |
| Insufficient confidence   | n/a                                                                             | n/a                                                               | Florina asks rather than assumes (last resort, DEC-025/031) | Candidate rule shown greyed, "not yet applied"        |
| Waiting for worker        | n/a                                                                             | "waiting" status word                                             | n/a                                                         | n/a                                                   |
| Waiting for human         | The card, with explicit deadline/blocking-impact field                          | "blocked — needs your decision"                                   | n/a                                                         | n/a                                                   |
| Verification failed       | Routed back to worker, not shown as human-facing failure unless retries exhaust | "verification failed, retrying"                                   | n/a                                                         | n/a                                                   |
| Verification passed       | Feeds the completion digest headline                                            | "verified"                                                        | n/a                                                         | n/a                                                   |

---

## Component concepts (brief § 21)

Described experientially — these are concepts, not implementations, and
several already exist as shipped components (`docs/UX_GUIDELINES.md` § 3);
this list names the ones the new model adds or reframes.

- **Catch-up digest**: a message, not a screen — renders inline in the
  Florina thread, structured (counts, then lines, then the "nothing else"
  close), each line a live drill-down.
- **Objective/work card**: exists today as the Task row; unchanged in
  substance, relabeled per `docs/UX_INFORMATION_ARCHITECTURE.md`.
- **Attention card**: exists today (`docs/UX_GUIDELINES.md` § 3.1),
  unchanged.
- **Ready-for-review card**: the completion digest card, unchanged.
- **Execution brief panel**: new — the inspectable object from
  `docs/RULES_MEMORY_AND_SUPERVISION.md` § 6.4, rendered as a structured
  panel (Objective / Relevant context / Applicable rules / Constraints /
  Required verification / Definition of done / Provider rationale) reachable
  from a Task's drill-down and directly from "why did you send this to
  X?"-type questions.
- **Manager/workstream summary**: the project-manager card in Work's
  drill-down (`docs/DESKTOP_UI.md`), unchanged.
- **Rule/memory explanation**: new — a rule row rendered with its full
  provenance chain (statement, scope, confidence, originating turns) and
  inline forget/narrow/broaden/promote actions (Settings, § J above).
- **Provenance trail**: new, general-purpose — the visual pattern behind
  "Prove it": claim -> journaled event(s) -> adapter fact -> (optional) raw
  transcript, rendered as a simple linear breadcrumb, not a graph.
- **Verification/evidence panel**: exists today as the digest's
  verification section (DEC-032); the provenance trail (above) is what lets
  a user go one level deeper from it.
- **Provider transition/failover indication**: new — a small inline marker
  in a Task's timeline ("moved to Claude — Codex quota, 14:32") rather than
  a separate notification; provenance without noise.
- **Lightweight worker peek**: exists today as the Task row's live status
  word; kept intentionally minimal (one line, no live log stream) to avoid
  becoming a monitoring dashboard.
- **Deep run inspector**: exists today (Session Inspector, three columns);
  unchanged.

None of these are "pretty cards" for their own sake — each one exists to
answer a specific question from brief §§ 12/29 (what's happening, why, is
it proven, what changed) without requiring the user to reconstruct the
answer by reading raw session output.

## P. First-run setup and first successful task

The first-run path is one user's journey: that person administers their local
installation, then uses Florina to delegate and review work. Setup and daily
use are phases, not separate people, accounts, or permission roles. DEC-017
continues to defer organization-level administration and multi-user RBAC.

The target journey is: understand what Florina does -> follow one setup step
at a time -> check only readiness facts Florina can observe -> select and
confirm the project folder -> see whether setup is blocking and one next
action -> submit an editable first task -> follow progress -> handle a clearly
scoped decision -> review observed verification evidence. Setup can be skipped
and resumed, but missing capabilities must not be described as ready.

Keep the default path calm and light: explain the current step in ordinary
language, show one primary action, and disclose technical detail only when
needed. For errors, say what happened, whether the user can continue, and how
to recover without blame or false reassurance. Never hide permission scope or
other facts needed for a safe decision.

This is a proposed experience, not a claim about shipped behavior. The
repository evidence, current-state findings, state inventory, open decisions,
and milestone issues are recorded in `docs/UX_ONBOARDING_AUDIT.md` and
`docs/UX_ONBOARDING_CAMPAIGN.md`.

### Shipped so far (M1 #277, M2 #278)

The guided setup card lives at the top of the Florina home view (no sixth
nav destination). It walks welcome (install-mode chooser: packaged vs.
source) -> coding apps -> project folder -> done, persists open/skipped/done
in desktop settings, and renders "couldn't check" distinctly from "none
found" so a failed query never masquerades as an empty machine. Missing
providers name the honest recovery (restart the helper via tray -> Stop
daemon) rather than promising a re-probe the daemon does not perform.

The empty conversation explains Florina's job in plain language ("watches
your coding apps, brings anything that needs you into one place"), names the
chosen project folder and detected coding app only when actually checked,
and offers `firsttask:fill` — a renderer-local verb that puts an editable
sample request into the composer and never sends it. Progress copy points at
the conversation itself and Attention for decisions.
