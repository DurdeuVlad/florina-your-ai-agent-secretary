# External-Agent-Powered Installation and Setup — Experience Contract

**Status:** Proposal. Experience contract only — not an implementation
plan, not validated by human sessions.

**Evidence boundary:** Grounded in the shipped CLI verb surface
(`src/adapters/inbound/cli/cli.ts`: `start`, `status`, `auth`, `install`,
`keys`, `approve`, … each returning a real exit code), the provider
readiness manifest (`use-cases/readiness/provider-readiness.ts`), the
setup card (`desktop/views/setup-view.ts`), and the onboarding campaign
(`docs/UX_ONBOARDING_CAMPAIGN.md`). _Inference_ marks design judgment.

## The idea

The "dumb as a rock" user already has a coding agent. So the setup journey
becomes: **the user tells their agent "install Florina" — and it does.**
The experience contract is therefore not a wizard for the human; it is a
surface an external agent can drive end-to-end, with the human dropped in
only at moments that genuinely require a human (a browser sign-in, a
folder choice, a secret, a final glance at proof).

Two actors, two knowledge states:

| Actor | Knows | Needs from Florina |
| --- | --- | --- |
| External agent (Claude Code, Codex, Cursor, …) | Shells, files, commands; zero Florina internals | A machine-readable install recipe, deterministic commands, structured honest output, clear "needs a human" signals |
| Human user | "I told my agent to install it" | To be asked only for things only they can do, and a way to *see* the result is real rather than trust the agent's summary |

## What the surface must give the agent

Mostly exists; gaps named honestly:

| Capability | Today | Gap |
| --- | --- | --- |
| Typed verbs with exit codes (`start`, `status`, `auth`, `install`, `keys`, …) | ✅ exists, "the typed verb IS the consent" pattern already governs privileged actions | — |
| Install recipe an agent can follow verbatim | ⚠️ README Quick Start is human/developer prose | A step-for-step recipe (install → build → `florina start` → verify) written for agent execution — or an `AGENTS.md` section |
| Machine-readable readiness | ⚠️ `status` prints human-formatted text | `--json` output on `status`/`inbox`/`tasks` so the agent can parse truth, not scrape prose |
| Self-verification ("did it work?") | ⚠️ implicit in `status` | A doctor-style exit contract: exit 0 = ready, non-zero + machine reason = not ready, so the agent knows when to stop or hand off |
| Project-folder configuration | ❌ desktop-only (`pickfolders` native dialog) | A CLI verb (`florina repos add <path>` or similar) — or accept folder-picking as a deliberate human moment |
| Daemon lifecycle an agent can manage | ✅ `florina start`/`stop` | Foreground-vs-detached behavior must be documented for agent use (a blocking terminal the agent can't leave is a trap) |

## What the agent may do — consent boundary

The existing "typed verb IS the consent" model extends naturally: whatever
a typed verb permits, the agent may run **as the user's instrument** —
`install` opens a visible terminal, sign-in opens the provider's own
flow. DEC-011 still binds: the agent acting through Florina's verbs can
never widen scope beyond what those verbs already allow.

Hard boundaries (same as every Florina surface):

- **Secrets stay out of prose.** The agent may run `florina keys set` only
  if the user hands it the key; the safer default is the agent saying
  "paste your key here" and the human running the command or using
  Settings. Never echo keys to agent transcripts.
- **Sign-in is a hand-off, not an automation.** Browser/device-code
  flows surface a visible terminal and the agent reports "a window opened
  for GitHub — sign in, I'll wait," then re-checks.
- **No self-granted scope.** The agent cannot add folders, install
  providers, or dispatch tasks that Florina's verbs don't already expose —
  and it should never work around that (no editing config files behind
  the verbs' backs).

## Knowledge ledger (human-facing moments only)

| Moment | User knows before | System reveals | Decision | Feedback / recovery |
| --- | --- | --- | --- | --- |
| "Install Florina" | The agent exists and can run commands | Agent narrates steps as it runs them | Let it proceed | Agent reports each step's real exit/output |
| Provider sign-in | The app needs an account they have | A terminal/browser opens, named for the provider | Sign in or skip | Agent re-checks and reports honestly |
| Folder choice | Where their projects live | "Tell me which folder your projects are in" | Name a folder | Agent runs the verb; discovered projects listed |
| Done | Trust but verify | `florina status` truth + desktop card shows the same facts | Open the app / ask agent what failed | Missing pieces stay missing in both surfaces |

## Journey model

```text
user: "install florina and set it up"
→ agent reads the recipe (INSTALL/AGENTS contract)
→ installs + starts the daemon (start/stop lifecycle must not wedge the
  agent — document or provide a backgroundable form)
→ agent queries status (--json) → honest facts: providers, chat model,
  folders
→ per missing provider: `florina install <id>` → visible terminal
  → sign-in hand-off to the human when the flow needs a person
  → re-check; failures reported with their real reasons
→ folder: agent asks the user once → verb → discovered projects reported
→ final verification: agent runs status, reports ready/missing as FACTS
  (never "should be working"), then says "open Florina to see it"
→ user opens app → the setup card shows the same truth the agent claimed
```

Recovery: any step that fails keeps its reason and stays retryable; the
agent may retry a bounded number of times, then hands the failure to the
human with the verb and error to run manually.

## States inventory

| State | Agent-facing contract | Human-facing contract |
| --- | --- | --- |
| Daemon not running | `status` exits non-zero with a parseable reason | Desktop shows offline; agent told to run `start` |
| Probe couldn't answer | `probed: false` — never fabricated emptiness | "Couldn't check" copy, check-again path |
| Provider missing | `installable` flag gates whether `install` can work | Button only when a real installer exists (shipped behavior) |
| Needs human | Sign-in flows block on a person — agent must wait, not loop | Clear ask, named app, way back |
| Ready vs claimed | Exit-0 verification is evidence | Status/card show identical facts — agent's summary is checkable |

## Interaction rules

1. **Agent-legible docs.** Install/setup instructions written as commands
   with expected outputs and exit codes — not prose paragraphs the agent
   must interpret.
2. **Structured truth.** Any surface an agent parses gets `--json`; human
   formatting stays for humans.
3. **One surface of truth.** The CLI `--json`, the desktop card, and the
   daemon protocol must derive from the same readiness facts — an agent
   and a human never see different worlds (a test can pin this).
4. **Auditable.** Every agent-invoked verb lands in the same journal as a
   human click; the human can later see *what their agent did*, not just
   what it claimed (work/History surfaces already exist).
5. **Hand-offs are first-class states.** "Waiting for a human to sign in"
   is a named state the agent reports and Florina reflects — not a stall.
6. **Fail as facts.** Errors surface as exit codes + reasons; the agent
   retries bounded times then escalates to the human verbatim — never
   paraphrases a blocker away.

## Responsive/other-form implications

CLI is the primary agent surface; the desktop card is the human's
verification surface; an `AGENTS.md`/`INSTALL.md` agent section is the
entry point. Nothing here assumes screen size — the contract is a
command/honesty contract, not a layout.

## Open questions

1. Is the source-build path (`npm install && npm run build && florina
   start`) acceptable as the agent's recipe, or must a packaged/agent-
   installable distribution exist first? _Inference: for developers with
   agents, source is fine — packaged adds nothing the agent needs._
2. Does folder selection warrant a new CLI verb, or is "open the app once,
   pick a folder" an acceptable single human moment? _Inference: a verb is
   cheap and keeps the journey fully agent-drivable — `repos add` also
   helps power users._
3. Should `--json` be added per-verb or as a global flag? Convention
   question, cheap either way.
4. Does the agent need an idempotent `florina setup` verb that runs the
   whole check sequence, or is composing existing verbs sufficient?
   _Inference: compose first; a magic verb adds a second thing to keep
   honest._

## What this is not

- Not Florina's Secretary doing setup — that's a separate (rejected-by-
  context) interpretation; this contract is about *external* agents.
- Not unattended autonomous install — human moments (sign-in, secrets,
  folder consent) are designed, not bypassed.
- Not human-validated — the #279 pilot could add an agent-mediated setup
  scenario; until then this is a contract, not evidence.
