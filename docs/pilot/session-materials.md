# Pilot Session Materials — Issue #279

Print-ready artifacts for `docs/UX_ONBOARDING_PILOT.md`. Facilitator uses
the brief; this file supplies the disposable sandbox spec and the
per-participant evidence sheet. No participant ever sees this file.

## A. Disposable sandbox project

Create on the participant machine before the session — a throwaway repo
with obvious contents, no secrets, and one deliberately visible bug the
participant can ask Florina to fix (gives the "first task" a natural target):

```
florina-sandbox/
├── README.md          # "Tiny demo app — a CLI greeter. There's a bug
│                      #  somewhere: it greets 'Word' instead of 'World'."
├── package.json       # { "name": "sandbox-greeter", "scripts": { "test": "node test.js" } }
├── greet.js           # exports greet() → returns 'Hello, Word!'
├── greet.test.js      # asserts 'Hello, World!' — currently FAILING
└── .git/              # git init + one commit
```

Build it in 30 seconds:

```bash
mkdir florina-sandbox && cd florina-sandbox && git init
# write the four files above, then:
git add -A && git commit -m "sandbox greeter with a bug"
```

Safety: nothing private inside; deleting the folder afterwards loses
nothing. Florina's worktree for the task lands in the sibling
`.florina-worktrees/` dir — also disposable.

## B. Per-participant evidence sheet

Participant #: ___ | OS: Windows / Linux | Install path: packaged / source
Facilitator: _______ | Observer: _______ | Consent recorded: Y / N (time: ___)

### Setup journey (brief steps 1–2)

| Time | Participant intent (their words) | Action taken | Expected vs observed | Confusion / backtrack | Recovered? | Outcome |
| ---- | -------------------------------- | ------------ | -------------------- | --------------------- | ---------- | ------- |
|      |                                  |              |                      |                       |            |         |

### Task journey (brief steps 3–5)

| Time | Participant intent (their words) | Action taken | Expected vs observed | Confusion / backtrack | Recovered? | Outcome |
| ---- | -------------------------------- | ------------ | -------------------- | --------------------- | ---------- | ------- |
|      |                                  |              |                      |                       |            |         |

### Wrap answers (verbatim quotes)

1. "In one sentence, what is Florina?":
2. "If something went wrong, what would you do next?":
3. "What was the most confusing moment?":

### Severity tally

- Critical (permission/readiness/submitted/safety misunderstanding): ___
- Major (needed facilitator rescue): ___
- Minor (self-recovered confusion): ___
- Cognitive-overload signals (couldn't name next step / "Florina is
  broken" belief on a recoverable issue): ___

### Contamination notes

Anything that compromised the session (participant saw docs, prior
knowledge surfaced, environment failure):


## C. Session log checklist

- [ ] Consent script read verbatim; consent recorded
- [ ] Participant never shown this file, the brief's §4 answers, source, or issue text
- [ ] Fresh profile/VM used; sandbox built fresh
- [ ] Timestamps noted per task step
- [ ] Verbatim quotes captured where possible
- [ ] Session artifacts retained per consent scope only
