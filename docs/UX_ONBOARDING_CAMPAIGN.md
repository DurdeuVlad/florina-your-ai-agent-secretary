# First-Run Guidance Campaign

**Status:** M0 decided; campaign issues created externally.
**Handoff:** GitHub milestone **First-Run Onboarding** on
`DurdeuVlad/agent-secretary`; issues #276 (M0 record), #277 (M1 ready state),
#278 (M2 first task), and #279 (M3 usability pilot). Assignees, dates, and
project placement are unset unless separately decided.

## Goal / System / Constraints / Evaluation

- **Goal:** One first-time user can prepare a Florina installation safely, then
  delegate and review a first task without needing prior Florina or provider
  setup knowledge.
- **System:** Treat setup and daily use as stages in the same user's journey.
  Confirm the install path, then deliver local setup guidance, first-use
  guidance, and novice-user validation in dependency order.
- **Constraints:** Respect DEC-017's accepted single-user local-control-plane
  scope. Do not invent organizational roles, shared accounts, credential
  sharing, or a new authorization model. Do not collect provider secrets in
  renderer UI. Do not create external records without explicit authority.
- **Evaluation:** Each issue below has observable acceptance criteria,
  boundaries, dependencies, ownership status, and a verification surface.
  Completion of the campaign requires observed first-time-user evidence, not
  just passing unit tests or a simulated participant.

## Baseline and scope decision

`BUSINESS.md` targets an individual developer and DEC-017 defers teams,
enterprise administration, and multi-user RBAC. This campaign has one user:
the person who administers their local installation and uses Florina to
delegate and review work. Setup and daily use are journey stages, not separate
roles, accounts, or a hand-off between people. Do not add an organizational
admin model.

The current implementation already has the five-destination navigation,
Work sub-tabs, History, Settings memory/rules, repo-root selection, provider
discovery, chat retry, and permission confirmation. The older
`docs/GAP_ANALYSIS.md` predates several of these changes; the issue tracker
status was not inspected. Reconcile existing issues before creating these
drafts externally, and do not re-open completed work just because the older
gap table still lists it.

## Proposed milestone sequence

### M0 - Confirm the primary install path and support baseline

- **Outcome:** The product names the primary first-run install path and
  supported platform(s), and documents the knowledge the path may safely
  assume.
- **Decision (accepted):** Support **both** install paths — the packaged
  desktop app and the source/developer workflow — presented through a guided
  chooser so each path's instructions stay self-contained. Supported platforms
  for this campaign are **Windows and Linux**; macOS is not validated by this
  campaign's milestones.
- **Scope:** Packaged desktop versus source/developer setup, platform target,
  provider sign-in boundary, and starter-task prerequisites. No role or
  authorization changes.
- **Dependencies:** None.
- **Risk:** If the campaign mixes packaged-app and developer setup steps, the
  first-run guide may be unusable for either path — the chooser exists
  precisely to keep the paths separate and each step self-contained.
- **Proof:** A documented decision names the initial install path/platforms,
  lists its actual prerequisites, and assumes no prior Florina, provider
  discovery, command-line/environment setup, or internal-vocabulary knowledge.

### M1 - The user reaches an honest ready state

- **Outcome:** The user preparing an installation can see what is ready,
  what is missing, how to recover, and which project folder Florina can use.
- **Scope:** Desktop-first setup guidance over existing provider discovery
  and repo-folder behavior; optional skip/resume; plain-language setup docs.
- **Dependencies:** M0.
- **Risk:** Provider discovery may not prove authentication or operational
  readiness. The UI must show "unknown" or "needs sign-in" rather than claim
  a provider is connected without evidence.
- **Proof:** Fresh, partial, ready, unavailable, and offline states are
  exercised through the first-run path selected in M0; the chosen folder and
  discovered projects are visible; no credential is exposed or silently
  requested.

### M2 - The user completes and reviews a first task

- **Outcome:** The same user can understand what to ask, where work is happening,
  what a decision means, and how to review or recover from the result.
- **Scope:** First-use guidance in Florina and the existing Work, Attention,
  and History surfaces. No new top-level destination.
- **Dependencies:** M1.
- **Risk:** Guidance must not dispatch an example task, add unnecessary
  confirmations to ordinary unambiguous requests, or confuse a provider's
  action with Florina's.
- **Proof:** A first-time user submits their own task, finds it, responds to
  a decision safely, and reviews verification evidence in the real desktop
  app.

### M3 - Validate the journey and fix demonstrated friction

- **Outcome:** The single-user setup and first-task journey survives a bounded,
  knowledge-isolated formative usability pilot.
- **Scope:** First-time-user task sessions, friction log, and fixes for
  blockers or unsafe misunderstandings found in M1/M2.
- **Dependencies:** M1 and M2.
- **Risk:** A simulated participant or developer walkthrough cannot be
  reported as human usability evidence.
- **Proof:** Consent-based sessions with participants who did not build
  Florina; observed task outcomes, visible UI evidence, contamination notes,
  and re-test results are attached to the implementation PR.

## Issue draft 1 - Record the first-run install paths and knowledge baseline

**Intent:** The README describes a developer-oriented source workflow, while
the packaged desktop app has a separate install path. Onboarding starts from a
guided chooser so instructions for the two paths never mix incompatible setup
steps.

**Expectation:** Decision made (see M0): support both the packaged desktop
app and the source/developer workflow behind a guided chooser, on Windows and
Linux. This issue records the decision and its prerequisites. The guide
assumes no prior Florina, provider discovery, or internal-vocabulary
knowledge and makes operating-system prerequisites explicit.

**Context a new user cannot infer:** `BUSINESS.md` targets individual
developers; DEC-017 defers teams, enterprise administration, and multi-user
RBAC. Provider discovery inspects local executables, while the README
Quick Start is a source/developer workflow. The same individual administers
the local installation and uses Florina day to day.

**Scope:** Product decision and documentation only. Record the supported
install path/platforms and prerequisites in this campaign and the user-facing
install guide. Do not change roles, authorization, or credential ownership.
**Affected areas:** `README.md`, `docs/UX_ONBOARDING_AUDIT.md`,
`docs/UX_ONBOARDING_CAMPAIGN.md`, and user-facing install documentation.

**Non-goals:** Building organization administration, shared accounts, a team
backend, provider installation/authentication, or credential sharing.

**Acceptance criteria:**

1. The recorded decision names both first-run install paths (packaged desktop
   and source workflow, separated by a guided chooser) and the supported
   platforms (Windows and Linux; macOS explicitly out of scope for this
   campaign).
2. The starting state names the prerequisites that Florina cannot set up or
   verify itself, including provider installation/sign-in where applicable.
3. The guide assumes no prior knowledge of Florina's purpose, navigation,
   provider discovery, command-line/environment setup, or internal terms; it
   explains each before relying on it. If provider installation or sign-in is
   required elsewhere, show a plain-language next step and a way back to
   Florina.
4. Setup and task use are described as one user's continuous journey, with no
   account hand-off or implied organizational role.
5. The decision does not imply that Florina stores or transfers provider
   credentials unless a separate secure design is accepted.

**Verification:** Product-owner review of the recorded install path against
`BUSINESS.md`, DEC-017, the packaged app, and current local provider behavior.
No automated test is applicable.

**Dependencies / open decisions:** Decision accepted; the remaining work is
recording it in the user-facing install guide.

**Metadata:** Type: Documentation / product record. Priority: proposed P1.
Labels: proposed `product`, `onboarding`, `documentation`.
Assignee: unassigned. Project: unknown. GitHub issue #276, milestone
"First-Run Onboarding" (campaign M0). Target date: none supplied.

**PR contract:** If the decision is delivered through a PR, include intent,
expectation, accepted decision and non-code context, scope/non-goals,
verification evidence, and remaining risks. Link to the issue does not replace
this context.

## Issue draft 2 - Guide the user to a verified local ready state

**Intent:** A new user currently has to combine developer-oriented
installation instructions, automatic provider discovery, and separate
Settings controls to infer whether Florina is ready.

**Expectation:** The primary desktop onboarding path reports what Florina
can verify, helps the person select the intended project folder, and explains
how to resolve an incomplete setup without collecting secrets or silently
expanding access.

**Context a new user cannot infer:** Provider CLIs are discovered during
bootstrap and may have skip reasons. The repo UI uses a native folder picker.
Provider sign-in and actual authenticated readiness may not be observable by
Florina. A selected folder is not proof that a usable project was found.

**Scope:** Desktop first-run/resume guidance including the install-path
chooser (packaged app vs. source workflow), readiness presentation over
existing discovery facts, repo-folder explanation, and a plain-language
user guide for both install paths accepted in M0. Reuse the current
Settings and native picker; do not add a sixth navigation destination.
**Affected areas:** `src/bootstrap/agent-providers.ts`,
`src/adapters/inbound/desktop/desktop-app.ts`,
`src/adapters/inbound/desktop/renderer/`,
`src/adapters/inbound/desktop/views/`, related provider/repo/desktop tests,
and the user-facing install documentation. Confirm exact file ownership in
the implementation issue after M0.

**Non-goals:** Multi-user roles, organization policy, implementing provider
installation/authentication, accepting raw API keys in renderer forms, or
redesigning all Settings screens.

**Acceptance criteria:**

1. A fresh installation explains Florina in plain language and offers a
   discoverable setup path plus a safe way to skip and resume later.
2. Each provider status is derived from evidence the application can observe.
   The UI distinguishes found/not found and does not equate executable
   discovery with successful authentication unless that is actually tested.
3. A missing or unverified provider has a plain-language next step and a
   retry/check-again path; raw environment variable names are not the only
   recovery shown to a novice.
4. Before the native folder picker opens, copy explains what selecting a
   folder allows Florina to search. The chosen folder and discovered projects
   are shown before the person continues; no broader default folder is added
   without an explicit choice.
5. Setup can be skipped or resumed without discarding saved settings. A
   skipped or failed step is not shown as ready.
6. Provider credentials are never requested in an unreviewed renderer form
   and are not included in logs, screenshots, or setup telemetry.
7. Empty, partial, ready, permission-denied, no-project-found, and offline
   states have visible explanations and a recovery route.
8. Existing narrow-permission behavior, confirmation gates, and folder
   removal confirmation remain intact.
9. Each setup step presents one primary action and a short explanation.
   Optional technical details are disclosed on request, not shown alongside
   every basic setup choice.
10. Recoverable problems use calm, factual, non-blaming copy, say whether the
    user can continue, and provide one concrete next step. Urgent language is
    reserved for genuinely blocking or safety-critical conditions.

**Verification:** Unit tests for status-to-copy and setup state transitions;
desktop integration tests for the chooser, folder selection, and provider
status; manual checks of the real application on Windows and Linux through
both install paths; security review for secret exposure and folder-scope
behavior; `npm run build`, `npm test`, `npm run lint`, and
`npm run visual-qa`.

**Dependencies / open decisions:** M0. Provider authentication readiness
must remain unknown unless a safe real check exists. Owner: unassigned.

**Metadata:** Type: UX feature. Priority: proposed P1 (confirm). Labels:
proposed `desktop`, `onboarding`, `ux`. Project: unknown. GitHub issue #277,
milestone "First-Run Onboarding" (campaign M1). Target date: none supplied.

**PR contract:** State who benefits, what readiness behavior changed, each
acceptance criterion and its evidence, the M0 install-path decision,
scope/non-goals, platform and security checks, and residual unknowns. Do not
claim provider authentication or human usability validation from mocks or
unit tests.

## Issue draft 3 - Guide a first-time user through one task and its result

**Intent:** The empty conversation assumes users know Florina's internal
vocabulary and does not explain how to start, find progress, or judge a
completed result.

**Expectation:** The user can discover an example, submit their own
request, understand where work appears, respond to any permission request,
and inspect the result or recover from a failure.

**Context a new user cannot infer:** Florina coordinates work; the selected
coding provider performs it. The current product already has Florina,
Attention, Work, History, inline send retry, confirmation gates, and
verification/evidence surfaces. DEC-031 avoids asking unnecessary
clarification questions; DEC-011 forbids silently widening permission.

**Scope:** First-use guidance in the existing Florina conversation and
task/decision/result surfaces. Reuse existing navigation and safety behavior.
Any sample request must be editable and unsent until the user submits it.
**Affected areas:** Desktop chat/renderer and existing Work, Attention, and
History view behavior; their unit/integration tests; `docs/UX_FLOWS.md` and
the first-run guidance copy. Confirm exact file ownership after M0/M1.

**Non-goals:** A tutorial that blocks every user, automatic dispatch of a
sample task, changes to provider choice policy, or a new task/permission
model.

**Acceptance criteria:**

1. The empty conversation explains Florina's job without relying on "fleet,"
   "ledgers," "Brief," or other unexplained internal terms.
2. A new user can reveal an ordinary-language example request, edit it, and
   decide whether to submit it; merely opening or selecting the example never
   dispatches work.
3. Before and after submission, the user can identify the selected project
   and provider when known, where to follow progress, and how Florina will
   surface a decision. Missing capability is stated honestly.
4. A permission decision explains the requested action, scope, allow/deny
   consequences, and a safe decline path before the existing confirmation
   gate is invoked.
5. A completed result distinguishes observed verification evidence from
   agent claims and exposes a discoverable route to inspect it.
6. Failed/offline sends preserve the user's text where supported, state
   whether it was sent, and provide the existing safe retry/recovery action.
7. First-use guidance is dismissible or can be revisited without trapping an
   experienced user or hiding important safety information.
8. Keyboard and screen-reader users can discover and operate the guidance,
   sample action, navigation, and recovery controls.
9. Guidance introduces one unfamiliar concept at a time and gives the user
   one clear next action without hiding scope, permission, or verification
   details needed for a safe decision.

**Verification:** Renderer/view unit tests for first-run and empty states;
desktop integration coverage for submit/approval/review/error flows; real
keyboard and screen-reader checks; `npm run build`, `npm test`,
`npm run lint`, and `npm run visual-qa`.

**Dependencies / open decisions:** M0 and M1. The definition of the "first
task" must not require a fabricated demo repo or provider. Owner: unassigned.

**Metadata:** Type: UX feature. Priority: proposed P1 (confirm). Labels:
proposed `desktop`, `onboarding`, `ux`. Project: unknown. GitHub issue #278,
milestone "First-Run Onboarding" (campaign M2). Target date: none supplied.

**PR contract:** Include intent, new-user expectation, evidence for every
criterion, the single-user boundary, scope/non-goals, keyboard/screen-reader
and failure-path evidence, and residual risks. Do not claim a user can
understand the flow based only on source review.

## Issue draft 4 - Run a first-time-user usability pilot and close critical gaps

**Intent:** Product and source inspection identify likely friction but cannot
prove that an unfamiliar person can complete setup and use Florina. A
knowledge-isolated pilot is needed before calling onboarding successful.

**Expectation:** Independent participants complete the agreed setup and
first-task scenarios using only visible product information. Confusion,
backtracking, unsafe misunderstandings, and recovery failures produce
actionable findings and are retested after fixes.

**Context a new user cannot infer:** No human usability evidence was present
in this audit. Simulated participants are hypotheses, not human research.
Participants should be individual developers who are new to Florina and have
no assumed knowledge of its provider, command-line, or repository setup. Use a
disposable/safe project and credentials that are not production secrets.

**Scope:** Formative usability sessions after M1 and M2, with each participant
completing setup and first-task journeys as the same user; fix demonstrated
friction and rerun affected scenarios.
**Affected areas:** The built desktop app, the user-visible flows delivered
by M1/M2, and the audit/evidence report. Add code files only for fixes that
come from observed findings.

**Non-goals:** Statistical claims about all Florina users, public release of
participant data, or changing permission policy to make task completion
easier.

**Acceptance criteria:**

1. A facilitator-independent task brief defines success without revealing the
   intended route. Participant, actuator, and observer roles are separated;
   participants do not see source, selectors, issue text, or expected answers.
2. The brief covers one continuous user journey: check readiness, select the
   intended test project, submit a request, find progress, handle a
   staged/fixture decision if applicable, and review the result.
3. Sessions use a safe test project and do not expose real credentials or
   confidential repository contents. Participants are informed and consent
   before recording or retaining notes.
4. Each consequential action records visible evidence, intent, chosen action,
   expected/observed result, confusion, backtracking, and recovery outcome.
5. The report separately records completion, friction, abandonment, wrong
   outcomes, terminology/discoverability, feedback, recovery, and signs of
   cognitive overload (for example, inability to name the next step or
   believing a recoverable issue means Florina is broken).
6. Any misunderstanding of permission scope, provider readiness, whether work
   was submitted, or whether it is safe to continue is treated as critical.
7. Proposed formative sample: five first-time participants from the individual
   developer audience. This is a qualitative pilot, not a statistically
   representative sample; the product owner may adjust the count before
   recruitment.
8. Critical findings and repeated cognitive-overload findings are fixed or
   explicitly accepted by the product owner with rationale and mitigation.
   Re-run affected tasks after fixes; no unresolved critical misunderstanding
   or repeated inability to identify the next safe step is reported as a pass.
9. The report records contamination and limitations and does not describe
   this pilot as representative research.

**Verification:** Consent-based, moderated sessions on the real first-run
experience decided in M0 (both install paths via the chooser, on Windows and
Linux); evidence artifacts and retest results attached to the issue/PR. Do not
substitute unit tests, developer walkthroughs, or AI simulation for
participant sessions.

**Dependencies / open decisions:** M0-M2; participant recruitment, consent
process, and sample count require an owner. Owner: unassigned.

**Metadata:** Type: UX research / validation. Priority: proposed P1 release
gate (confirm). Labels: proposed `ux`, `usability`, `validation`.
Project: unknown. GitHub issue #279, milestone "First-Run Onboarding"
(campaign M3). Target date: none supplied.

**PR contract:** Include intent, audience and test brief, task outcomes and
visible evidence, contamination/limitations, scope/non-goals, fixes and
retest results, consent/privacy handling, and unresolved risks. Do not claim
human validation when only simulated or developer-run sessions occurred.

## Handoff audit

- GitHub handoff completed: milestone "First-Run Onboarding" and issues
  #276-#279 were created on `DurdeuVlad/agent-secretary`. Assignees, dates,
  and project placement remain unset unless separately decided.
- M0 decided the first-run install paths (packaged desktop + source workflow
  via a guided chooser) and platform baseline (Windows and Linux); it was
  not a decision about user roles. M1/M2 remain scoped to one local user.
  If implementation exposes a new product constraint, update the affected
  issue before proceeding.
- Labels and priorities are proposed, not verified against repository
  settings. No owners, estimates, or dates are invented.
- Before external handoff, reconcile the current issue tracker against
  `docs/GAP_ANALYSIS.md`; this campaign intentionally does not duplicate the
  older #191-#203 list.
- Merge of these planning documents does not mean the product onboarding has
  shipped or passed a usability study.
