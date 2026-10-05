# First-Run Onboarding — Usability Pilot Brief

Issue #279 / milestone M3. Formative pilot for the first-run experience
shipped in #277 (guided setup panel) and #278 (first-task guidance).

> This brief is written to be run by a facilitator who did **not** build the
> feature. It defines success without revealing the intended route, keeps
> participant / actuator / observer roles separate, and gives participants
> only what the product itself shows them.

---

## 1. Roles

| Role                    | Who                                             | Boundaries                                                                                                                        |
| ----------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Participant**         | Individual developer who has never used Florina | Uses only what is visible on screen. May think aloud; does not see source code, issue text, or this section's expected answers.   |
| **Facilitator**         | Runs the session                                | Reads only Section 4 scripts verbatim. Does not demonstrate, hint, or name features. Answers questions of procedure, not product. |
| **Observer** (optional) | Notes evidence                                  | Records timestamps/actions; does not interact with the participant.                                                               |

One person may act as both facilitator and observer if recruitment is thin —
record that merger as a limitation.

## 2. Recruitment

- **Audience:** individual developers (the product's only user persona —
  DEC-017 defers org/team roles). Participants must be new to Florina.
- **Sample:** 5 participants (formative — not statistically representative).
- **Screening disqualifiers:** prior Florina use; having seen this document;
  having been told the expected steps.
- **Recruitment is an open decision** — owner unassigned as of this writing.

## 3. Environment and safety

- Fresh machine or VM per participant; Windows or Linux (macOS is out of
  scope for this campaign).
- Both install paths are exercised across participants via the welcome-step
  chooser: alternate packaged-app vs. source-checkout starting points.
- A **safe disposable project folder** is provided on the machine (e.g. a
  small sandbox repo with an obvious README). No production repositories.
- One real coding app may be pre-installed and signed in per session plan —
  credentials are throwaway test accounts only, never real secrets.
- **Consent** (read verbatim before starting): _"We're testing the product,
  not you. You can stop at any time. With your permission I'll take notes
  about what happens on screen — no passwords or personal files will be
  recorded. Is that OK?"_ Record consent before any notes; no recording
  without consent.

## 4. Session script

Read verbatim. Do not expand, do not hint.

> "Imagine you just heard about this app called Florina. I'm going to open
> it. Please do whatever feels natural, and say out loud what you're
> thinking as you go. There's no wrong answer — we're testing the app, not
> you."

Open Florina. Then, in order:

1. **Setup.** _"Take it from here — set it up however seems right, or skip
   it if you want."_ Let the panel's own copy do the work. Note whether the
   participant can name what Florina is doing at each step.
2. **Project folder.** Observe whether the participant chooses a folder
   (or the sandbox) and understands Florina only looks inside chosen
   folders.
3. **First task.** _"Ask it to do something."_ If the participant stalls,
   the only permitted nudge is: _"Is there anything on the screen that
   suggests what to try?"_ — never name the example button.
4. **Progress & decision.** _"Where do you see it working? If it asked you
   for permission, what would you do?"_ Observe whether Attention is
   discovered unprompted.
5. **Result.** _"How do you know it's done — and how would you check
   whether it actually worked?"_ Observe whether the participant
   distinguishes what Florina verified from what the agent claimed.
6. **Wrap questions** (verbatim):
   - "In one sentence, what is Florina?"
   - "If something went wrong, what would you do next?"
   - "What was the most confusing moment?"

## 5. Evidence record (per participant, per task)

| Field                    | Capture                                            |
| ------------------------ | -------------------------------------------------- |
| Task & timestamp         | Which of steps 1–5                                 |
| Intent                   | What the participant said they were trying to do   |
| Action taken             | Clicked/typed/navigated where                      |
| Expected vs observed     | Participant's stated expectation vs. what happened |
| Confusion / backtracking | Hesitations, wrong turns, re-reads                 |
| Recovery                 | Did they recover unaided? How?                     |
| Outcome                  | completed / completed-with-help / abandoned        |

Report findings separately for: completion, friction, abandonment, wrong
outcomes, terminology/discoverability, recovery, and **cognitive-overload
signals** — e.g. inability to name the next step, or believing a
recoverable issue means "Florina is broken".

## 6. Severity rules

- **Critical:** any misunderstanding of permission scope, provider
  readiness, whether work was submitted, or whether it is safe to continue.
  Any repeated inability to identify the next safe step. These block a
  "pilot passed" verdict.
- **Major:** friction requiring facilitator intervention to recover.
- **Minor:** cosmetic confusion recovered unaided.

Critical and repeated overload findings must be fixed (or explicitly accepted
by the product owner with rationale) and the affected scenarios **re-run**
before the pilot counts as resolved.

## 7. Status

**Deferred — revisit after release.** Product-owner decision: recruitment
is postponed; the pilot will run when new users are reachable post-release.
Sample is now "as many as recruitment yields" rather than a fixed five;
the default consent approach is the verbal script in §3 (no recording
unless the participant opts in). Infrastructure is ready: this brief plus
`docs/pilot/session-materials.md` (disposable sandbox spec,
per-participant evidence sheet, session checklist). No participant
sessions have run, so no human-validation claims exist.
