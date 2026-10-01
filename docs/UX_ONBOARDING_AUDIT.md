# First-Run UX Audit: One User, Setup Through Daily Use

**Status:** Evidence-backed source audit; target journey is proposed, not shipped.
**Evidence boundary:** Static review of the repository at `6c067c1`. No live
desktop journey or human usability session was run. This document is not user
research.

## Goal and scope

Help one person who has never used Florina understand what it does, set up a
local installation safely, complete a first delegated task, and know what to
do when setup or work fails. The same person administers their local
installation and uses Florina day to day; setup and use are journey phases,
not separate users, accounts, or permission roles.

"First-time" means no assumed knowledge of Florina, its terminology, provider
plumbing, command-line setup, or repository folders. The product remains aimed
at developers; the flow must not require them to know Florina-specific
concepts, configure PATH/environment variables, or infer how provider discovery
works.

## Contract

- **Goal:** A first-time user can prepare one local installation, tell what
  remains to be configured, and safely delegate one task, understand its state,
  respond to a request, and review the result without guessing about
  credentials or file access.
- **System:** Start from observable product behavior and user-visible language.
  Treat setup and use as stages in one continuous journey, not as a hand-off
  between roles.
- **Constraints:** Do not invent multi-user authorization, shared settings, or
  credential-entry behavior. Assume no prior Florina or provider-setup
  knowledge. Preserve the local-first trust boundary and the invariant that
  Florina narrows permissions rather than silently widening them. Treat
  recommendations below as a proposal until accepted.
- **Evaluation:** Each consequential decision has a visible explanation,
  deliberate action, confirmation/feedback, and a recovery route. Present one
  clear next step at a time, explain whether a problem blocks progress, and
  validate comprehension and cognitive load with first-time users before
  claiming that the journey is understandable.

## Repository evidence

| Observed fact                                                                                                                                                                                   | Evidence                                                                                                                                                     | UX implication                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Florina is positioned for individual developers. Teams, organization admins, and multi-user RBAC are deferred.                                                                                  | `BUSINESS.md` target user; `DECISION_LEDGER.md` DEC-017                                                                                                      | The individual user administers their local installation and uses Florina. Do not imply separate accounts, shared roles, or organization-wide controls.                                              |
| The desktop has five top-level destinations: Florina, Attention, Work, History, and Settings. Fleet and Ideas are Work sub-tabs; the Secretary is a Florina lens.                               | `src/adapters/inbound/desktop/renderer/index.html`; `src/adapters/inbound/desktop/renderer/app.js`                                                           | The current IA is already simplified. Onboarding should use this structure rather than add another top-level destination.                                                                            |
| Settings contains routing rules, memory/rules, repository folders, and desktop/voice preferences.                                                                                               | `src/adapters/inbound/desktop/renderer/index.html`; `src/adapters/inbound/desktop/views/prefs-screen.ts`; `src/adapters/inbound/desktop/views/repos-view.ts` | Settings is a collection of configuration surfaces, not a guided readiness journey. Terms such as "routing rules" and "denied" require explanation for a new user.                                   |
| Provider attachment probes for locally installed provider CLIs and records why a provider was skipped. Configuration can also use environment variables.                                        | `src/bootstrap/agent-providers.ts`; `src/bootstrap/desktop.ts`                                                                                               | Setup should report detected readiness in plain language and point to the provider's own install/sign-in path where applicable. Do not imply that Florina currently provides provider account setup. |
| An empty repository-root state offers "Add folder" and "Use default folder," then says only "add a folder so Florina can find your repos." Removing a folder has a scope confirmation.          | `src/adapters/inbound/desktop/views/repos-view.ts`                                                                                                           | Explain what choosing a folder changes before opening the native picker; distinguish "folder selected" from "repository found." Keep removal confirmation.                                           |
| The empty chat message says "say something" and that the Secretary can see the user's "fleet, inbox, and ledgers."                                                                              | `src/adapters/inbound/desktop/views/chat-screen.ts`                                                                                                          | The copy assumes product vocabulary and does not explain a safe first task, what Florina does, or what a coding provider does.                                                                       |
| A first voice session with an empty preference profile asks which providers and models the developer prefers, then says the profile is saved and to move to the inbox.                          | `src/adapters/inbound/voice/voice-tools.ts`                                                                                                                  | This gathers routing preferences; it is not a provider installation/authentication check, repository setup, or a verified readiness check.                                                           |
| The README Quick Start describes Node.js, npm, a C/C++ toolchain, `npm install`, `npm run build`, a blocking daemon terminal, and a second CLI terminal.                                        | `README.md` Quick Start                                                                                                                                      | This is a developer-oriented path, not a plain-language guide for someone installing or opening the packaged desktop app.                                                                            |
| Some recovery and safety behaviors already exist: failed chat sends stay visible with Retry, reconnecting preserves readable content, and consequential actions use a shared confirmation gate. | `src/adapters/inbound/desktop/views/chat-screen.ts`; `docs/VISUAL_QA.md`; issue #270 behavior in the current tree                                            | Reuse these patterns. Do not replace safe inline recovery with a transient toast or silently broaden access for convenience.                                                                         |
| The older gap analysis lists already-landed IA, History, memory audit, and provenance work as open gaps.                                                                                        | `docs/GAP_ANALYSIS.md` compared with current renderer and views                                                                                              | Reconcile the current tracker and implementation before creating related issues; do not copy the old issue list as this campaign.                                                                    |

## Findings

### P1 - First launch does not explain what "ready" means

The code can discover local provider CLIs, and Settings can add repository
folders, but the reviewed first-run path does not bring these facts together
into a readiness check. A first-time user cannot tell whether Florina can
actually send work to a coding app, whether it needs that app to be installed
or signed in separately, or whether Florina can find the intended project.
The existing voice interview asks about preferences, which can be mistaken for
setup completion even though it does not verify provider readiness or project
access.

**Impact:** The user can finish onboarding without knowing whether the product
is ready, or can interpret a missing provider as a broken Florina.

**Direction:** Provide an optional, resumable setup checklist with observable
states and plain-language next steps. Never ask for provider secrets in a new
UI unless a separately reviewed secure credential flow is explicitly approved.

### P1 - The first everyday action assumes product knowledge

The first chat hint tells the user to "say something" and names fleet, inbox,
and ledgers. It does not give a concrete example, explain that Florina
coordinates work performed by another coding app, or tell the user where to
see progress and results.

**Impact:** A user who does not already know Florina's vocabulary has no
reliable first task and may not know how to judge the result.

**Direction:** Give an optional, dismissible first-task example in ordinary
language. Explain the distinct jobs of Florina and the coding app, where work
appears, what a request for permission means, and where verified results can
be reviewed. The user must still deliberately submit their own request.

### P2 - User-facing setup vocabulary is too implementation-shaped

The target flows use terms such as provider, routing rule, denied, repository
root, Fleet, Brief, and fidelity tier. These are useful in advanced inspection
surfaces but do not tell an unfamiliar user what to do or what an action
changes.

**Impact:** Users must learn the implementation's categories before they can
complete a basic task.

**Direction:** Lead with task language ("coding app," "folder Florina can look
in," "what needs you"). Keep precise technical names available as secondary
detail for debugging and advanced settings; do not remove information needed
for a permission or scope decision.

### P2 - Existing docs do not define an end-to-end onboarding campaign

The voice setup interview and empty repository state each handle a narrow
slice, while `docs/GAP_ANALYSIS.md` still describes several implemented
features as missing. Neither provides an end-to-end journey from local setup
through first-task review for the same user.

**Impact:** A new issue campaign risks duplicating completed work and missing
the actual first-run blockers.

**Direction:** Use the implementation and current issue tracker as the
baseline. Keep this campaign separate from the older Persistent AI Supervisor
gap list until that list's statuses are reconciled.

## Knowledge-state ledger

| Step                            | What the person may know                                                                              | What the product currently reveals                                                                 | What must be explained before the next decision                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Open Florina for the first time | They installed or opened an app; they may not know what an attention broker is.                       | A conversation composer; an empty hint naming the Secretary, fleet, inbox, and ledgers.            | What Florina does, whether setup is complete, the smallest safe next step, and how to skip setup and return later.              |
| Check coding-app readiness      | They may know the name of one coding app, but not whether its CLI or sign-in is available to Florina. | Provider attachment happens during bootstrap; Settings has no explicit connect-provider checklist. | Which coding apps were found, which need installation/sign-in elsewhere, what Florina can observe, and how to re-check.         |
| Choose a project folder         | They know which project they want to work on; they may not know what "repo root" means.               | "Add folder" / "Use default folder" and a generic empty hint.                                      | Which folder is selected, what Florina searches there, whether a project was found, and how to remove it.                       |
| Ask for a first task            | They know the outcome they want, not the provider or task-state model.                                | Free-form composer and persistent chat.                                                            | A concrete example; that the coding app does the code work; where progress, questions, and results appear.                      |
| Respond to a request            | They may not know the difference between an approval and a task decision.                             | Attention cards and confirmation behavior.                                                         | What will be permitted, for how long / at what scope, what happens on allow or deny, and how to inspect details.                |
| Review or recover               | They may not know whether "done" is verified, or how to retry safely.                                 | Work/History, evidence surfaces, inline send retry, reconnect state.                               | Plain-language meaning of the result, proof available, what failed, whether the request was preserved, and the safe retry path. |

## Proposed experience contract

This is a target for the campaign, not a statement that the flow already ships.

### One user: set up one local installation

1. Explain Florina in one sentence and distinguish its role from the coding
   app that performs code changes. Offer setup, a clear way to skip, and a way
   to resume later.
2. Guide the user through readiness in small steps. Report only facts the
   application can observe; do not label an unverified provider as connected.
3. Before opening the folder picker, explain what Florina will search. Show the
   selected folder and discovered projects before continuing; never silently
   select a broader folder.
4. Keep optional preferences optional. Summarize what is ready, what remains,
   whether the user can continue, and one next action. Do not collect or reveal
   provider secrets.
5. After setup or skip, return to the same conversation and offer one clear
   next step toward the first task; do not make the user hunt through Settings.

### The same user: one safe first task

1. On an empty conversation, explain the next action and offer an editable,
   unsent example request.
2. Let the user describe the desired outcome in their own words. Show the
   selected project and provider in ordinary language when known. Ask a
   clarifying question only when the request is ambiguous or policy requires
   a decision; do not add a confirmation round-trip to every unambiguous task.
3. After the user submits, show where work is happening and what kind of
   interruption will appear. Make "Needs you," "Working," and "Ready to
   review" understandable without requiring navigation knowledge.
4. For a permission request, show the requested action and scope before the
   decision, explain allow/deny consequences, and preserve the existing
   confirmation and authority rules.
5. On completion, lead with observed verification evidence and offer a
   discoverable path to inspect the change. If work fails or goes offline,
   preserve the request/state where supported, say what happened, and provide
   a safe retry or next step.

## State coverage required by the campaign

| State                             | Required user-visible behavior                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh / not configured            | Explain Florina; show setup and skip/resume; no empty screen that assumes prior vocabulary.                                                                          |
| Partially configured              | Identify exactly what is ready and what is missing; do not imply the whole installation is ready.                                                                    |
| No coding app detected            | Say that no supported coding app was found; provide an actionable install/sign-in/check-again path without exposing a raw environment variable as the only recovery. |
| Coding app found but unavailable  | Distinguish discovery from usable/authenticated readiness only when the system can prove the distinction; otherwise say what is and is not known.                    |
| No folder selected                | Explain why a project folder helps and let the user select one or defer; never silently broaden folder scope.                                                        |
| Folder selected, no project found | Distinguish "folder selected" from "project found"; give a reselect/rescan path.                                                                                     |
| Ready                             | Show a concise readiness summary and one next action, not an advanced dashboard.                                                                                     |
| Working                           | Show plain-language progress and a clear route to the relevant task; avoid requiring raw logs.                                                                       |
| Needs a decision                  | Explain the choice, scope, consequences, and safe decline path.                                                                                                      |
| Complete / verified               | Separate observed evidence from agent claims and show how to inspect the result.                                                                                     |
| Error / offline                   | Preserve readable state and user-entered request when supported; identify recoverable vs. terminal condition and give retry/help.                                    |
| User skips setup                  | Keep the app usable where safe, mark missing capabilities accurately, and make setup easy to find later.                                                             |

## Terminology and interaction rules

- Prefer "coding app" in first-run copy; reveal the exact provider name when
  reporting detection or when the user must act in that provider.
- Prefer "project folder" before introducing "repository" or "repo root."
- Explain a routing rule as "which coding app Florina prefers for this kind
  of work"; keep rule editing in advanced settings unless the user asks.
- Keep "Needs you," "Working," and "Ready to review" as task-oriented status
  language. Define any status that can cause a user to wait or approve.
- Use progressive disclosure for provider tiers, quota details, journal
  events, and environment configuration. Never hide authorization scope,
  missing verification, or a limitation relevant to the current decision.
- Present setup one decision at a time: one primary action, a short explanation
  of what it changes, and a clear way to skip or go back. Keep optional
  technical detail out of the default path.
- Use calm, factual, non-blaming language. For a recoverable problem, say
  whether the user can continue and give one concrete next step; reserve urgent
  treatment for genuinely blocking or safety-critical conditions.
- Do not put the full readiness matrix or multiple unrelated configuration
  choices in front of the user at once. Make it easy to answer: "What is
  happening now?", "What should I do next?", and "Can I safely continue?"
- Keep setup optional/resumable and preserve the current safety boundary:
  no silent grant, no implicit folder expansion, and no accidental task
  submission from an example.
- The supported surface is the desktop app. Responsive behavior means the
  checklist and decision details remain readable at a smaller window size;
  mobile support is not in scope unless product direction changes.

## Evidence gaps and open questions

- No first-time-user observation, support-ticket analysis, onboarding
  analytics, or participant feedback was available. The findings are
  repository-based hypotheses, not validated user pain.
- Can the packaged desktop app identify provider authentication/readiness, or
  only detect installed executables? Do not claim a stronger status until
  verified at the real boundary.
- Which platforms and install paths are first-class for novice onboarding?
  **Resolved (campaign M0):** both install paths — the packaged desktop app
  and the source/developer workflow — behind a guided chooser, on Windows
  and Linux. macOS is out of scope for this campaign; the installers still
  exist via `npm run dist`.
- What is the intended minimal first task and whether a safe demo/sandbox
  project exists are product decisions; this audit does not invent one.

## Source references

- `BUSINESS.md` - target user and individual-developer workflow.
- `DECISION_LEDGER.md` - DEC-017 (teams/admin/RBAC deferred) and DEC-043
  (desktop information architecture).
- `docs/UX_FLOWS.md` - current target flows and states.
- `docs/UX_INFORMATION_ARCHITECTURE.md` - design rationale and current nav
  grouping; interaction details may be target behavior, so use the renderer
  source below as current-state evidence.
- `docs/GAP_ANALYSIS.md` - older, now partly stale gap inventory.
- `README.md` - current developer-oriented Quick Start.
- `src/bootstrap/agent-providers.ts` - local provider discovery and skip
  reasons.
- `src/adapters/inbound/desktop/renderer/index.html` - current Settings and
  Work structure.
- `src/adapters/inbound/desktop/views/chat-screen.ts`,
  `prefs-screen.ts`, `repos-view.ts` - current empty-state and setup copy.
- `src/adapters/inbound/voice/voice-tools.ts` - first-run voice preference
  interview.
