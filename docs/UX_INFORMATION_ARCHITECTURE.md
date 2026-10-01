# UX Information Architecture

Records the rationale for the desktop information architecture in DEC-043 and
its implementation. The current renderer has five top-level destinations:
Florina, Attention, Work, History, and Settings. Work groups Tasks, Fleet, and
Ideas as sub-tabs; the Secretary remains a lens from Florina. See
`src/adapters/inbound/desktop/renderer/index.html` and `app.js` for the shipped
structure.

The sections below also describe intended ownership and interactions; they
are product guidance, not proof that every detail is implemented. Historical
references to the seven-item sidebar describe the pre-#219 navigation.

## 1. Diagnosis of the pre-implementation nav

Before the five-item navigation was implemented, the seven-item sidebar
(`docs/UX_GUIDELINES.md` § 2) reflected implementation history: each item
shipped as its own vertical slice (#120 Inbox, #126 Inspector, #127 Fleet,
#128 Preferences, #129 Ideas, #157-163 Chat). The resulting issues were:

- **Fleet** and **Preferences** sat at the same nav level as **Chat** and
  **Inbox**, but they are diagnostic/audit surfaces (brief § 13), not
  destinations a user goes to for their own sake.
- **Tasks** and the **Session Inspector** overlapped in purpose (both were
  "what's happening in a project") without a clear ownership line.
- **Secretary** (her plan/todo/research) was a lens on Chat, not a
  separate place.
- The old nav did not answer "what needs me" and "what's the state of my
  world" as two distinct, equally-weighted top-level questions — they're
  both folded into Inbox, competing with a literal Kanban-adjacent Tasks list.

## 2. Accepted IA

```
FLORINA (home)     — conversation + the catch-up digest; "what's going on" in one place
ATTENTION          — the inbox: needs-you, ready-for-review, decisions
WORK               — objectives/tasks/projects; drill-down to manager -> worker -> run -> event
HISTORY            — completed/reviewed work, journal, evidence, past decisions
SETTINGS           — providers, memory/rules audit, autonomy boundaries, desktop prefs
```

The five top-level items implement the broad grouping evaluated against the
brief's candidate hypothesis and existing screens. The table records the
rationale; the shipped locations are summarized above:

| Destination                     | Previously grouped                                           | Rationale                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Florina** (home, launch view) | Chat + Secretary                                             | These were always one thing — a conversation with a lens on her current plan/research. "Florina" as the label (not "Chat") matches the product's own framing: the user talks to Florina, not to "chat." Catch-up (`docs/RULES_MEMORY_AND_SUPERVISION.md` § 9) renders here first, before any list-based UI, on return from inactivity. |
| **Attention**                   | Inbox                                                        | Unchanged in substance (`PRODUCT_DESIGN.md`'s attention model is sound) — renamed to match its job description rather than an email metaphor, and to sit conceptually next to Work/History rather than imply a mailbox the user must triage.                                                                                           |
| **Work**                        | Tasks + Projects + Session Inspector's non-historical parts  | One surface, progressively disclosed: project list -> manager card + task list -> worker/run -> event timeline -> transcript/diff. This is `docs/DESKTOP_UI.md`'s existing three-column drill-down; the change is that it is reached from one "Work" entry point instead of "Tasks" and "Projects" implying two different things.      |
| **History**                     | Completed-work views previously scattered across Inbox/Tasks | A dedicated place for "what already happened": completed deliverables, resolved decisions, the append-only event journal, and evidence trails. "Done" work has different needs (search, evidence review, no actions pending) from active work.                                                                                         |
| **Settings**                    | Preferences + provider setup + desktop prefs                 | Preferences is an audit/inspection surface for what Florina remembers, learned rules with provenance, provider connections and their fidelity tier, autonomy/safety boundaries, and desktop-local preferences (mic device, hotkey). Capacity diagnostics are under the shipped Work > Fleet sub-tab.                                   |

**Infrastructure never dominates top-level nav** (brief § 13 principle):
neither "Agent," "Session," nor "Provider" is a top-level item in this IA —
they're all reachable through Work's drill-down or Settings' Providers
sub-view, never a first-class destination competing with Florina/Attention.

## 3. Does Florina/home subsume Attention and Work?

Partially, by design, not by collapsing screens. The conversational surface
("catch me up," "what needs me," "show me the auth work") is the _primary_
way most sessions touch Attention/Work/History — per brief § 12, the GUI is
"a visual extension of Florina's cognition," navigated by the conversation.
The five sections remain as addressable, bookmarkable, keyboard-reachable
surfaces (unchanged interaction model, `docs/UX_GUIDELINES.md` § 4) for when
a user wants to browse rather than ask. Florina/home is not merely one of
five equal tabs — it is the default launch view and the place every other
surface is reachable _from_ conversationally, consistent with the existing
"Chat is the launch view" decision (`docs/UX_GUIDELINES.md` § 2) which this
document keeps, renaming only the destination Chat/Secretary merge into.

## 4. Primary home experience

Per brief § 22, the home view (Florina) must answer in seconds: does
anything need me? what's happening? what finished? what changed while I was
gone? can I safely look away? It does this with three ingredients, not a new
dashboard:

1. **The conversation itself** — the persistent Secretary thread, unchanged
   from today's Chat.
2. **An ambient state strip** (not a new screen — a compact header/footer
   element on the Florina view): counts only, no detail —
   `NEEDS YOU 3 · WORKING 5 · DONE TODAY 4` — each count navigates to
   Attention/Work/History filtered accordingly. This is the "conceptual
   home screen" mockup from `PRODUCT_DESIGN.md` § Visual Experience,
   demoted from full-screen to a strip because the full inbox view still
   exists at **Attention** for when it's needed (progressive disclosure).
3. **Automatic or on-demand catch-up**: on first render after an idle gap
   past a configurable threshold, or on the explicit "catch me up" command,
   the catch-up digest (`docs/RULES_MEMORY_AND_SUPERVISION.md` § 9) renders
   as the next message in the thread — not a modal, not a separate screen.

"Nothing needs you" is rendered exactly as prominently as an urgent item —
per DEC-006/008 and brief § 9, this is the product's most valuable state,
not a null case to be minimized.

## 5. Terminology audit (brief § 23)

| Term           | Keep?                                       | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Florina        | Keep                                        | Product + persona name (DEC-038); also the new home nav label                                                                                                                                                                                                                                                                                                                                                                    |
| Secretary      | Keep, internal-only                         | Persona framing inside docs/domain (`FlorinaLoop`, "the Secretary" in prose); not user-facing nav copy — "Florina" is what the user sees                                                                                                                                                                                                                                                                                         |
| Agent          | Keep, disambiguated                         | Three senses per `docs/PROVIDER_TOPOLOGY.md` § 1: Provider/runtime, Agent Profile, Session/Run. UI copy should say "provider" or "worker" rather than the bare word "agent" wherever the sense matters                                                                                                                                                                                                                           |
| Manager        | Keep                                        | A Task with a special capsule/tool set (DEC-018) — UI-facing as "project manager" or the project's name, not a separate object type in nav                                                                                                                                                                                                                                                                                       |
| Worker         | Keep                                        | UI-facing synonym for a Task's executing provider instance; internal domain type stays `Session`/Run                                                                                                                                                                                                                                                                                                                             |
| Session / Run  | Keep as domain vocabulary; avoid in UI copy | `docs/DESKTOP_UI.md` already treats these as implementation detail (DEC-004) — this audit reinforces it should stay that way in nav/labels, appearing only inside Work's drill-down                                                                                                                                                                                                                                              |
| Task           | Keep                                        | Human-facing unit of delegated work (DEC-004); this audit does not adopt the brief's candidate "Objective" as a replacement — see § 5.1                                                                                                                                                                                                                                                                                          |
| Project        | Keep                                        | Durable work context (DEC-004)                                                                                                                                                                                                                                                                                                                                                                                                   |
| Attention Item | Keep                                        | Domain type unchanged; nav label shortens to "Attention"                                                                                                                                                                                                                                                                                                                                                                         |
| Decision       | Keep                                        | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Approval       | Keep                                        | Unchanged; kept distinct from Decision (DEC-010 — approvals are structured-capability-specific)                                                                                                                                                                                                                                                                                                                                  |
| Deliverable    | Keep                                        | Unchanged (DEC-004)                                                                                                                                                                                                                                                                                                                                                                                                              |
| Idea           | Keep                                        | Pre-delegation ledger (DEC-033); surfaced from Work (a promoted idea becomes a project's backlog) rather than a separate top-level nav item                                                                                                                                                                                                                                                                                      |
| Brief          | Keep, expanded meaning                      | Was DEC-033's ideation-to-delegation artifact; `docs/RULES_MEMORY_AND_SUPERVISION.md` § 6 reuses the same word for the Execution Brief compiled per-task. Both are "the artifact you approve before agents act on it" — same word, consistent meaning, different granularity (project-level Brief from ideation vs. task-level Execution Brief from rule resolution). Not a naming collision worth resolving by renaming either. |
| Fleet          | Keep as internal label, demoted             | Moves under Settings > Providers (§ 2); "Fleet" stays an apt internal name for the quota/capacity view, just not a top-level destination                                                                                                                                                                                                                                                                                         |
| Provider       | Keep                                        | Unchanged (DEC-013)                                                                                                                                                                                                                                                                                                                                                                                                              |

### 5.1 "Objective" — considered, not adopted

The brief's candidate primary unit of work is "Objective." Current domain
uses **Task** for the human-facing unit (DEC-004), with Projects containing
multiple Tasks. Renaming Task -> Objective repo-wide would touch the domain
model, CLI verbs (`florina task`), and four foundation docs for a
terminology change with no behavioral difference — a real cost for a word
swap. Recommendation: **keep Task**, and use "objective" only as prose for
_what a Task is trying to achieve_ (already how `PRODUCT_DESIGN.md` and the
Execution Brief's `Objective:` field use it) — not as a competing domain
noun. This is recorded as an explicit decision, not an oversight (DEC-043).

## 6. Reconciling with #180–#190

The five-item navigation and Work grouping are implemented in the renderer
through #219/#220. This IA remains about _what the top-level destinations
are and what each owns_, not a redesign of individual screens' internals.
The Inbox, Inspector, Fleet, Ideas, Preferences, and Chat keep their visual
language and component patterns; the regrouping changes which nav item reaches
them. Older implementation references in `docs/GAP_ANALYSIS.md` and
`docs/UX_GUIDELINES.md` describe historical status and should be reconciled
before external planning.
