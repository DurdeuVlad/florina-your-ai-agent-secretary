# War Room: a general-and-commanders UI for Florina

**Status:** PROPOSED. Nothing in `src/` changes with this document. The runnable
proof of concept is [`docs/prototypes/war-room/index.html`](prototypes/war-room/index.html)
(open it in a browser, no build step). It is disposable prototype code: fixtures
only, no daemon, no network.

**What this is.** A redesign of the desktop app around one sentence of the brief:
_"It should feel like you are in a meeting with your secretary, who listens to
you and gets things done. You are the general; you know the objective, maybe only
vaguely. Your commanders deal with the local failures and bring you results only."_

**Revision 2 (transparency).** The first draft summarized the work and asked for
trust. The brief that followed was blunt: _"I don't trust what I don't see. I want
to see per-project sessions and the discussion between the worker and the
coordinator, and intervene if I want. Like a group chat."_ Every project now has a
live **channel** (§ 7.1) where you, Florina, the coordinator and its workers talk,
and where you can speak. This revises two earlier statements, flagged in § 12: the
user may now address a commander and a worker, and the "Handled" count is
backed by the actual conversation it came from.

**Revision 3 (decided, and the handoff made explicit).** The maintainer answered the
two open questions from revision 2 with **yes** (you may address a commander or a
worker directly) and **yes** (Florina speaks in the channels), and stated the
delegation rule: **Florina gives the goals to the managers.** She hands over a goal
(outcome, limits, what "done" means), never a worker choice or steps. Each manager
decomposes it into orders and chooses the workers (DEC-018, DEC-029). The channel
now opens with that goal as a structured row, and the read-back says "the
coordinator chooses the worker; likely X" instead of Florina naming one.

**Naming.** "War Room" is the whole experience. **The Table** is its home screen.
Both are working names for this proposal; see § 12 for the naming conflict with
`docs/UX_INFORMATION_ARCHITECTURE.md`.

---

## 1. Contract

```text
Goal:        The user can state an outcome (precisely or vaguely), walk away, and
             come back to a short, honest account: what needs their call, what is
             finished and proven, and what was handled without them. At any
             time they can open any project, read the real conversation between
             its coordinator and workers, and step in.
System:      Florina is the default party the user talks to. Per-project managers
             ("commanders") absorb failures at supervision levels L0-L3. Only L4
             (human judgment) interrupts. Nothing is hidden behind a summary:
             every project has a readable, live, journaled channel the user can
             join. Reading it is never required; it is always one click away.
             Florina hands each manager a goal (outcome, limits, done-means).
             The manager breaks it into orders and chooses the workers.
Constraints: PRODUCT_DESIGN principles hold: attention over activity, energy
             conservation, done means proven, inspectability, voice first-class,
             DEC-011 (narrow, never silently widen), DEC-010 (voice never approves
             an LLM summary). Not a fleet-cockpit dashboard (docs/DESKTOP_UI.md).
Evaluation:  See § 11. Behaviour verified in a real browser; human usability
             evidence is NOT yet collected and is listed as unproven.
```

## 2. The idea in one paragraph

The sidebar stops being a list of features and becomes the **chain of command**:
one commander per project, each showing a plain status word, evidence-based
progress (verified orders, never a fake percentage) and a count of problems it
solved without you. The centre of the screen stops being a chat log and becomes
a **briefing**: Florina's one-sentence headline ("2 things need your call."),
then your decisions (each with her recommendation and the reason), then finished
reports with proof attached. The conversation moves to a drawer called
**Minutes**. You give orders by talking or typing an _outcome_; Florina reads
back what she understood (outcome, front, worker, limits, what "done" means)
before anything is dispatched. Behind every seat is a **channel**: the live
group chat of that project (coordinator, workers, Florina, you), with a
"New since you last looked" line, filters, and a box to speak into.

## 3. Metaphor mapped to what the repo already has

The metaphor is not invented decoration. `docs/ARCHITECTURE.md` already draws
`YOU → SECRETARY → one MANAGER per project → workers`, and
`docs/RULES_MEMORY_AND_SUPERVISION.md` § 7 already defines L0-L4 escalation.

| Game / meeting term | Florina object                                                                      | Where it lives today                                                                                                  | War Room treatment                                     |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| General             | The user                                                                            | PRODUCT_DESIGN: "permanent relationship is User ↔ Florina"                                                            | Order bar, Your call                                   |
| Chief of staff      | Florina (Secretary loop, L3)                                                        | `docs/ARCHITECTURE.md` graph, DEC-034                                                                                 | Her seat: headline, read-back, "Catch me up"           |
| Commander           | Per-project manager agent (L2)                                                      | DEC-018, `managers/manager-tools.ts`                                                                                  | Rail seat, commander view                              |
| Units               | Worker sessions: Codex, Claude Code, Gemini…                                        | adapters                                                                                                              | Participants in the channel, with tier                 |
| Goal                | Florina's handoff to a manager: outcome, limits, done-means, your stated preference | Delegation payload plus Execution Brief (`docs/RULES_MEMORY_AND_SUPERVISION.md` § 6, DEC-040); `delegate-task`        | Read-back sheet, first row of the channel              |
| Order               | A manager's instruction to one worker (a Task)                                      | Manager MCP tool `florina_spawn_task`, DEC-018                                                                        | `Order N` rows in the channel, Orders list in Overview |
| Standing orders     | Preference memory + hard policy                                                     | RULES § 2-5, DEC-011, DEC-039                                                                                         | Standing orders screen                                 |
| Your call           | `AttentionItem` that survived the ladder (L4)                                       | `attention/supervision-ladder.ts`, `domain/types.ts`                                                                  | Decision card                                          |
| Report              | Completion digest + verification evidence                                           | DEC-032, `attention/completion-digest.ts`                                                                             | Reports in                                             |
| Supplies            | Quota ledger + capacity router                                                      | DEC-029, Work › Fleet                                                                                                 | Supplies chip + drawer tab                             |
| Radio chatter       | Events resolved at L0-L2                                                            | `TaskFailedOver`, `TaskNudged`, `TaskVerifyFailed`, `TaskParked`, `ContextCondensed` in `domain/events.ts`            | Seat one-liner (5 s) + Handled ledger                  |
| After-action review | Immutable event journal                                                             | DEC-012                                                                                                               | Record, "Prove it"                                     |
| Hold my calls       | Urgency vs batching                                                                 | RULES § 8                                                                                                             | Switch in Florina's seat                               |
| Minutes             | Journaled chat thread                                                               | `chat-service.ts`                                                                                                     | Drawer tab                                             |
| Channel             | One room per project: coordinator + workers                                         | Merged journal events of the manager task and its worker tasks (`query-events`), plus a new human-message verb (§ 10) | Commander view › Channel, Wire drawer tab              |
| Florina's desk      | Secretary lens                                                                      | `secretary:update` view                                                                                               | Drawer tab                                             |

**Reconciling with "we are the inbox, not the fleet cockpit"
(`docs/DESKTOP_UI.md`).** That principle stands. The Table has no telemetry wall:
the home screen is led by one sentence and at most three decision cards, and the
rail is navigation with a one-line roll-up, not a monitor. Commander detail is a
drill-down. The "game" lives in the structure (a chain of command, orders and
reports, handled problems ticking up), not in HUD chrome.

## 4. How others do it

Research was a lightweight pass (`flux-how-others-do-it`). Evidence quality is
marked: **read** = I fetched and read the page; **snippet** = only a search-result
summary; **judgment** = my own knowledge, not verified in this pass.

| Source                                                                                                                                                                                                                                                                                                      | Finding                                                                                                                                                                                                                                                                                       | Used for                                                                                                           | Evidence                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [Mission command](https://en.wikipedia.org/wiki/Mission_command); [Army Research Centre](https://researchcentre.army.gov.au/library/land-power-forum/command-mission-understanding-mission-command); [Vandergriff](https://donvandergriff.substack.com/p/commanders-intent-in-modern-combat)                | Brief intent as end state and purpose, not steps. Intent should be understood two levels down. A long, detailed intent encourages blind execution. NATO AJP-01: mutual understanding and trust set how much autonomy subordinates get.                                                        | Orders are outcomes. Per-commander "Limits" and track record. Autonomy is earned, shown, revocable.                | snippet                                                       |
| Backbrief (military practice: subordinate restates the order)                                                                                                                                                                                                                                               | The cheapest check that intent survived transmission.                                                                                                                                                                                                                                         | The read-back sheet.                                                                                               | judgment                                                      |
| [Osmani, "The Code Agent Orchestra"](https://addyosmani.com/blog/code-agent-orchestra/)                                                                                                                                                                                                                     | "The bottleneck is no longer generation. It's verification." 3-5 concurrent agents is the practical ceiling. Check progress every 5-10 minutes. Plan approval before coding. Kill an agent stuck 3+ iterations on one error; pause at 85% budget. Vague specs multiply errors across a fleet. | Reports lead with proof. Rail is sized for 5 fronts and sorted by need. Read-back is the plan-approval gate.       | read                                                          |
| Rochester "playbook" delegation paper ([Miller](https://www.cs.rochester.edu/research/mipas2005/final-drafts/miller.pdf))                                                                                                                                                                                   | A supervisor sets goals and constraints; intelligent actors decide how, within them.                                                                                                                                                                                                          | Confirms the order shape: outcome + limits.                                                                        | snippet (PDF returned 404 when fetched)                       |
| ASME engineering-design-games paper ([Stevens](https://researchwith.stevens.edu/en/publications/operational-and-strategic-decisions-in-engineering-design-games/))                                                                                                                                          | Partial automation of operational decisions frees effort for strategic ones.                                                                                                                                                                                                                  | Commanders own operational failures; only strategic calls reach the user.                                          | snippet                                                       |
| Management by exception (BI alerting, e.g. [PI World](https://www.piworld.com/article/business-intelligence-solutions-and-8212-how-to-gauge-success-30951/23/))                                                                                                                                             | Alert only when a defined threshold is crossed.                                                                                                                                                                                                                                               | "Your call" is exception-only.                                                                                     | snippet                                                       |
| [Game Developer: strategy UI dos and don'ts](https://www.gamedeveloper.com/design/ui-strategy-game-design-dos-and-don-ts)                                                                                                                                                                                   | Strategy UIs must show both the micro and macro layer.                                                                                                                                                                                                                                        | We show the macro layer by default and make the micro layer one click away (commander view, Handled, Prove it).    | snippet                                                       |
| [Nobunaga's Ambition review](https://matchstickeyes.com/2016/01/10/nobunagas-ambition-late-game-observations-and-reflections-on-ai-automation)                                                                                                                                                              | Late-game strategy suffers from micromanagement; AI automation of routine choices keeps it playable.                                                                                                                                                                                          | Validates the delegation premise.                                                                                  | snippet                                                       |
| Conductor, Vibe Kanban, Cursor background agents, Devin ([DEV roundup](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8), [Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/), [Vibe Kanban overview](https://ai-deck.app/blog/vibe-kanban/)) | Converged on isolated worktrees, per-agent status, diff review before merge. They differ on the main surface: board, sidebar, or cloud dashboard. Coverage of Devin and Codex UIs was thin.                                                                                                   | Florina already has worktrees. The differentiator is that the main surface is _decisions and reports_, not agents. | snippet (secondary blog posts)                                |
| Crusader Kings council, Civilization advisors, XCOM Geoscape alerts, Frostpunk laws, Factorio persistent alerts                                                                                                                                                                                             | Advisors who present a recommendation with consequences; alerts that persist until resolved and jump to the source.                                                                                                                                                                           | Decision cards carry a recommendation plus consequence; the seat lights until its call is answered.                | **judgment** (searches returned nothing usable; not verified) |
| Automation bias (human-factors literature)                                                                                                                                                                                                                                                                  | People over-trust a recommended default.                                                                                                                                                                                                                                                      | Mitigations in § 9: widening needs two presses, Critical items carry no pre-armed default, Undo, revocable grants. | **judgment**                                                  |
| [AutoGen GroupChat + UserProxyAgent](https://nbviewer.org/format/script/github/microsoft/autogen/blob/v0.2.37/notebook/agentchat_groupchat.ipynb); [overview](https://www.liziu.com/ai-agents/autogen.html)                                                                                                 | The human is a participant in the group chat with a `human_input_mode` (ALWAYS / TERMINATE / NEVER) deciding how often they are asked. Termination and `max_round` are real stop conditions. Tutorials, 0.2-era API.                                                                          | You are a participant in the channel, not a viewer. Per-commander **check-in mode** (§ 7.1).                       | snippet (third-party tutorials; no official docs reached)     |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)                                                                                                                                                                                                                                      | Each teammate is a full session; you can message any teammate directly to redirect it, and `Esc` interrupts its current turn. Teammates share a task list. Experimental.                                                                                                                      | Direct address of a worker; `Pause` as an interrupt that never destroys work.                                      | snippet                                                       |
| GitHub Copilot cloud agent steering ([agent management](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/agent-management), [steer agents](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-cli/use-copilot-cli-agents/steer-agents))                               | You can step into a running session and steer without stopping it. Each steering message costs a premium request.                                                                                                                                                                             | Steer without stop. The To: note warns that a message to a worker may use its quota.                               | snippet                                                       |
| Slack agent channels ([agent governance](https://docs.slack.dev/ai/agent-governance), [Slack coding agent report](https://yourstory.com/ai-story/slack-code-brings-ai-coding-agents-into-team-chats))                                                                                                       | Slack said private agent chats made complex work hard to follow and single threads got messy, so coding agents work in a shared channel where people can spot issues early and redirect. Docs frame agent design around human-in-the-loop controls and progressive trust. Vendor claims.      | One shared room per project instead of a private chat per worker; auditability.                                    | snippet (vendor material)                                     |

**What the group-chat research changed.** (1) One room per project, not one chat
per worker, so the coordinator-worker discussion and your interventions are in a
single ordered record. (2) Steering must not require stopping. (3) The human's
participation level is a setting, not an accident (check-in mode). (4) Direct
messaging a worker is common; the open question is cost and side effects, so
every message is journaled, visible to the coordinator, and cannot grant
permissions.

**Alternatives rejected**

- _Spatial map / territories (RTS minimap)._ Projects have no geography, so
  position would carry no data. Decorative, costs density.
- _Kanban board (Vibe Kanban style)._ Already rejected by PRODUCT_DESIGN ("not a
  Kanban"); organizes by status, not by what needs the human.
- _Keep chat-first and add a status strip (the current IA §4)._ This is what ships
  today. It keeps the secretary but not the meeting: the user must scroll a
  transcript to find the one thing that matters.

## 5. User and knowledge state

**User (from the repo, not invented research):** a developer running several
coding agents across several projects, with limited attention and a life outside
work (BUSINESS.md / PRODUCT_DESIGN "Energy Conservation"). First-time users are
also in scope for the first-run flow.

| Step           | Prior knowledge                                | Visible now                                                                                                                   | Safe inference                                                                           | Hidden                                | Decision asked              | Feedback                                                                          | Recovery                                                                                  |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Arrive         | Gave orders earlier                            | Headline, counts, commanders with status words                                                                                | "2 things need me; the rest is fine"                                                     | Journal detail                        | None yet                    | Calm or amber orb matches the headline                                            | "Catch me up" re-reads it; Minutes shows what was said                                    |
| Decision card  | Knows the project                              | The question, her recommendation and reason, observed facts, what is blocked                                                  | "Allowing this is narrow and matches my past choice"                                     | Raw adapter payload                   | Allow once / Deny / Later   | Card leaves, seat status changes, toast with Undo                                 | Undo (9 s), revoke later in Standing orders, Inspect shows the evidence chain first       |
| Goal read-back | Typed an outcome                               | Goal, front, who chooses the worker (the coordinator) and the likely one with why, limits, done-means, rules used             | "She understood; the limits are what I set"                                              | The compiled Execution Brief text     | Go / Adjust / Cancel        | Goal appears at the top of that project's channel, with Undo                      | Adjust returns the text to the box; Undo withdraws the goal before the coordinator acts   |
| Commander view | Saw the seat                                   | Orders with proof state, handled-here list, limits, track record                                                              | "This front is healthy / stuck / waiting on me"                                          | Event timeline                        | Hold, redirect, or leave it | Status word changes                                                               | Resume; "Open full timeline" (existing inspector)                                         |
| Channel        | Saw "14 handled" and a seat that is not moving | The real conversation: orders, worker replies, nudges, tool results, handled problems, Florina's notes, with times and levels | "I can see why it is stuck, and who said what"                                           | Raw event payloads (Everything level) | None (reading)              | "New since you last looked" line, unread badge clears                             | Detail level and participant filters; Wire shows everything newest first                  |
| Intervene      | Read the channel; has an opinion               | To: chips (Coordinator, each worker, Everyone, Florina), a one-line note on what that does, the box                           | "The coordinator and the worker will both see it; it is saved; it cannot approve things" | Provider delivery mechanics           | Send or not                 | Message appears at once with ✓ Journaled, then ✓ Delivered to X, then the replies | Pause/Resume is one click; Undo on dispatch; a failed delivery says where it went instead |
| Handled ledger | Saw "14 handled"                               | Each problem, what was done, level, event kind                                                                                | "They really did handle it"                                                              | Raw events                            | None (audit)                | n/a                                                                               | Each row links to the journal (Record)                                                    |
| Daemon offline | Was using it                                   | Amber banner, last known time, read-only content                                                                              | "Nothing is lost; I can read but not act"                                                | Cause                                 | Retry                       | Banner clears on reconnect                                                        | Retry now                                                                                 |

## 6. Information architecture

Three destinations plus a drill-down, instead of the five in DEC-043:

```text
THE TABLE            home. Florina's briefing, Your call, Reports in.
  └ Commander view   one front. Tabs: CHANNEL (live group chat, default) and OVERVIEW
                     (orders, handled here, limits, check-in mode). Reached from the rail.
RECORD               replaces History. Reports accepted, decisions, handled problems, journal search.
STANDING ORDERS      replaces Settings. Rules (provenance, revoke), calls and read-back preferences,
                     and, unchanged, providers/supplies, keys, repos, mic and push-to-talk.
Side drawer          Minutes · Handled · Wire · Supplies · Desk (+ contextual Evidence). Keys 1-5.
```

| Today (DEC-043)                 | Becomes                                                               | Why                                                    |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Florina (chat + Secretary lens) | Table headline + order bar; transcript → **Minutes**; lens → **Desk** | A meeting's transcript is its minutes, not the meeting |
| Attention                       | **Your call** + **Reports in** on the Table                           | One place for "what needs me"; no tab to remember      |
| Work (Tasks / Fleet / Ideas)    | Rail + commander view; Fleet → **Supplies**; Ideas → Desk             | Navigate by project, which is how the user thinks      |
| History                         | **Record**                                                            | Same substance, plus Handled                           |
| Settings                        | **Standing orders**                                                   | The rules are the point; keys/repos stay inside        |

**Keyboard.** Existing chords and vi-keys are kept where they still mean something.
`g t` Table, `g r` Record, `g s` Standing orders. `j`/`k` move through cards and
commanders, `Enter` runs the card's primary action, `Esc` backs out one level
(box focus → speech → sheet → drawer → commander view). `o` focuses the order bar.
`Hold Space` talks. `1-5` open drawer tabs (3 is Wire). `?` lists them.
Old `g f / a / w / h / e` would need an alias table (issue W9 in § 13).

## 7. The Table, zone by zone

Hierarchy rule: one focal point (Florina's headline), then Your call, then
Reports, then everything else. Colour keeps its DG-01 meaning: amber = needs you,
green = verified, red = critical, violet = interactive, slate = idle.

1. **Florina's seat** (no card chrome). State label, headline (28 px / 650),
   one-sentence detail, then chips: `N need you`, `N handled for you`,
   handled, Wire (new lines across all channels), supplies, Minutes, Florina's desk. Right side: **Hold my calls** switch and
   **Catch me up**. The orb is her presence: static when idle, bars while
   listening, a spinning arc while thinking, a pulse while speaking.
2. **Your call** (max 3 visible, the rest counted). The decision card is the one
   heavy component:
   - top line: kind, priority chip (Critical red, High amber, Medium violet, Low slate per existing ladder), commander, age
   - title is the _question_, in plain words
   - **Florina recommends: X**, then one italic line of reason (inferred text is muted italic, per DG-01)
   - observed facts in a row (capability, destination, scope, adapter tier), non-italic, from the adapter
   - blocking impact in one line ("Remove dead coupon code is waiting on this")
   - actions: recommended first with `Enter`, then alternatives, `Later`, `Inspect`
3. **Reports in.** Flatter than decisions because they ask less of you. Order:
   outcome, evidence (proof first: "23/23 tests · build green · 9 files +284 −71"),
   risk in amber, "Handled on the way", actions `Accept`, `Open PR`, `Send back`,
   `Prove it`. Grouped completions collapse to one row.
4. **Commanders rail** (left, 296 px). Per seat: monogram, name, status word,
   one-line objective, verified-order segments, `N of M verified`, handled count.
   Needs-you seats float to the top with an amber edge; critical is red;
   holding is a dashed amber edge. A one-line green "radio chatter" replaces the
   objective for 5 s after a problem is handled. A violet **unread badge** on the
   monogram counts new channel lines (conversation only, never tool noise);
   opening the channel clears it. Selecting a seat opens its channel.
5. **Order bar** (bottom). Mic, text box, Send. On the Table it talks to Florina
   (an addressee chip appears after "Send back"). Inside a channel it becomes the
   channel box with a **To:** row (§ 7.1). Florina stays the default recipient and
   the only one who compiles orders; the commander and workers are addressable
   but never required.
6. **Read-back sheet.** Goal / Front (coordinator) / Worker ("The coordinator
   chooses. Likely claude-code", with the rule that makes it likely) / Limits /
   Done means / Because of (rule chips linking to Standing orders). `Go`, `Adjust`,
   `Cancel`. Florina hands over the goal; she never assigns the worker.
   If the front is ambiguous she asks "Which front is this for?" rather than guessing.
7. **Calm state.** When nothing needs you, the two empty zones collapse into
   "Handled while you were heads-down": the latest four resolved problems and a
   link to all. DEC-006/008 call "nothing needs you" the product's most valuable
   state; this renders it as proof, not as a blank page.

### 7.1 The channel: a group chat per project

"14 problems handled without you" asks for faith. The channel is the evidence,
and it is the answer to "I don't trust what I don't see". It is **opt-in reading**:
nothing in it interrupts you; the only signal is an unread badge. The Table stays
the default surface (attention over activity).

**Florina in the channel (decided).** She opens it with the goal, adds short italic
notes (rule matches, containment, "I logged this in the Record") and flags limits
when your text would stretch them. She does not give workers instructions.

**Participants.** You · Florina (Secretary) · the coordinator (the commander,
shown by project monogram) · each worker (provider, adapter tier A-E, live state).
Participant chips filter the log; a worker chip carries its own `Pause`/`Resume`.

**What a row is, and where it comes from today**

| Row                                                           | What you see                                                                                                         | Real source                                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Goal** (framed box: `GOAL`, "You said", Limits, Done means) | Florina's handoff to the coordinator, always the first row of a front's channel and again for each new goal you give | `delegate-task` payload / Execution Brief (DEC-040). **Verify** how the payload is journaled today                                               |
| Coordinator says                                              | Plans, decisions, verification verdicts, escalations                                                                 | The manager session's own text (`AgentProgress.message` on the manager task). **Verify** that manager sessions are journaled with readable prose |
| **Order** (accent bar, `Order 2`, "to @codex")                | The coordinator's instruction to one worker, issued after it has read the goal and chosen who does what              | Manager `florina_spawn_task` call, journaled as the worker's dispatch objective (DEC-018)                                                        |
| **Nudge** (dashed amber bar, `Nudge 1 of 2`)                  | "There is no test run in your log, so this is not done."                                                             | `TaskNudged.prompt`, journaled today                                                                                                             |
| Worker says                                                   | Progress, findings, requests                                                                                         | `AgentProgress.message`                                                                                                                          |
| Tool group (collapsed: "ran 2 commands · 1 failed")           | Commands and results, expandable and stays open across live updates                                                  | `ToolStarted/Finished`, `TestFinished`, `VerificationObserved`                                                                                   |
| **Handled without you** (green ✓, level chip, event kind)     | A problem solved at L0-L3, in the place and time it happened                                                         | `TaskFailedOver`, `TaskVerifyFailed`, `TaskNudged`, `ContextCondensed`… The Handled drawer is the same rows, filtered                            |
| **Ask** (embedded decision card)                              | The L4 call, answerable here or on the Table, same object, resolves in both                                          | `AttentionItem` / `ApprovalRequested`                                                                                                            |
| Florina note (italic)                                         | "Matches R3: you allowed this twice before", containment, limits                                                     | Deterministic rule match (RULES § 6.2)                                                                                                           |
| System line                                                   | "Florina briefed the coordinator: …"                                                                                 | Journal                                                                                                                                          |
| **You** (violet avatar, receipts)                             | Your messages                                                                                                        | New verb (§ 10)                                                                                                                                  |

**Reading.** Three detail levels: **Conversation** (talk, orders, nudges, asks,
handled rows), **Actions** (default; adds collapsed tool groups) and **Everything**
(adds raw events such as `FileChanged`). A footer says how many rows are hidden.
Unread lines are marked by a "New since you last looked" divider; if you are
scrolled up, a `↓ N new` button appears. Links in: **Discussion** on a decision
card, **Open thread** on a report, **Open in channel** on a Handled row, and any
line in the **Wire** drawer jump to the exact message, highlighted.

**Speaking.** The box has a **To:** row: Coordinator (default), each worker,
Everyone, or Florina (a new goal: she reads it back first, § 7). A one-line note
says what the choice does ("claude-code gets it as a user message between turns.
The coordinator sees it too. May use quota."). Each message shows receipts:
`✓ Journaled`, then `✓ Delivered to …`. Mic and `Hold Space` work here too.

**Rules that keep intervention safe**

1. **Journaled before delivered** (DEC-012). The Record gets a `message` entry.
2. **A message is never a grant.** Capabilities come only from structured cards
   (DEC-010/011). If your text includes push, merge or deploy, Florina says so in
   the channel, forwards it as advice only (receipt: "Advice only: Limits still
   apply") and offers to raise the card.
3. **No side channels.** A message to a worker is visible in the same log, and the
   coordinator is told. This preserves DEC-018's one-channel rule.
4. **Capability-gated.** A worker with no live session (out of quota) or an adapter that
   declares no `sendMessage` capability (today: `agy`, tier D) cannot take messages: its chip is disabled with the reason, and the
   message goes to the coordinator instead.
5. **Pause is non-destructive.** The worktree is untouched; `Resume` continues.
6. **Done still means proven.** After your intervention the coordinator re-verifies
   before reporting (DEC-032).
7. **Check-in mode** (Overview tab, per commander): _only at decision points_
   (default), _before it dispatches any order_, or _only when blocked_. It changes
   how often a commander asks; it never changes Limits.

### Headline copy (deterministic first, DEC-042)

Priority: offline > first-run > critical > calls > reports > quiet. Digits, never words.

| Condition              | Headline                                                          | Detail                                                                                                          |
| ---------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| calls = N              | `1 thing needs your call.` / `N things need your call.`           | `A fronts advancing, B holding, R reports ready. H problems handled without you today. Nothing else needs you.` |
| calls = 0, reports = R | `1 report is ready to review.` / `R reports are ready to review.` | `Nothing needs your call. …`                                                                                    |
| nothing                | `Nothing needs you.`                                              | `A fronts advancing. H problems handled without you today. I'll speak up when that changes.`                    |
| critical               | `<front> stopped itself.`                                         | what it attempted, what was contained, what changed                                                             |
| offline                | `I can't reach the daemon.`                                       | last-known time, "Actions are paused until I do."                                                               |
| first run              | `Hello. I'm Florina.`                                             | ask for folders, promise one commander per project                                                              |

"Nothing else needs you." appears only when every pending item is on screen
(explicit close, RULES § 9).

### State coverage

| State                                | Prototype scenario                             | Behaviour                                                                                            |
| ------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Busy morning                         | `morning`                                      | 2 calls, 2 reports, one front holding for quota                                                      |
| All quiet                            | `quiet`                                        | Calm headline + handled feed                                                                         |
| Critical                             | `critical`                                     | Red banner with Keep paused / Inspect / Resume / Discard; destructive and resume need a second press |
| Daemon offline                       | `offline`                                      | Read-only: actions `aria-disabled`, banner with Retry, stale time shown                              |
| First run                            | `firstrun`                                     | Welcome → choose folders → "Appoint N commanders"                                                    |
| Hold my calls                        | switch                                         | Copy changes; interrupts suppressed except Critical                                                  |
| Voice                                | Hold Space                                     | listening → thinking → text lands in the box, never auto-sent                                        |
| Catch me up                          | button                                         | Florina reads the briefing (browser speech if available); talking or `Esc` cuts her off              |
| Quota hold                           | `infra-ci`                                     | Dashed amber seat, reason shown, "Run on Claude Code anyway" is a one-time override of R2            |
| Verification failed                  | invisible                                      | Routed back to the worker; appears only in Handled (DEC-032)                                         |
| Failover                             | invisible                                      | Appears in Handled and as a "Handled on the way" line on the report                                  |
| Channel: live                        | `morning`                                      | Coordinator and workers talk; tool rows collapsed; badge on seats you have not read                  |
| Channel: worker cannot take messages | `checkout` (codex), `pagination` (agy, tier D) | Chip disabled with the reason; message goes to the coordinator                                       |
| Channel: your message                | any front                                      | Receipts, coordinator reply, relay to worker, worker confirmation, a one-time Florina note           |
| Channel: limits guard                | type "just push it to main"                    | Advice only, Florina cites R1, no approval is created                                                |
| Channel: paused worker               | `Pause` on a worker chip                       | Chip says paused, coordinator acknowledges, worktree untouched                                       |
| Channel: decision in context         | `Discussion` on a card                         | Opens the exact message; answering in the channel resolves the Table card too                        |

## 8. Visual direction

Local design language first: the prototype uses DG-01 tokens **verbatim**
(`renderer/tokens.css`), the system font stack, 4-px spacing grid and the
existing priority ladder. New: layout variables only (`--rail-w`, `--drawer-w`,
`--topbar-h`).

- **Directions considered.** (A) Briefing Table, chosen. (B) Front map: rejected (§ 4).
  (C) Agenda feed, a single vertical document of agenda items: the least change,
  but it makes the rail's persistent chain of command impossible.
- **Hierarchy.** Contrast, then weight, then size. Headline 28/650; card titles
  16/600; body 14; meta 12; mono 12.5. Florina's seat has no box so it cannot
  compete with the cards.
- **Cards are used twice** (decisions; the read-back sheet). Reports, seats,
  ledgers and rules are rows with hairlines: the generic-AI card-soup default is
  avoided on purpose.
- **Responsive.** ≥ 1100 px: two columns. < 1100: one column. < 860: the rail
  becomes a horizontal strip of seats and the drawer becomes full width. Checked
  at 1440, 1180, 1024, 820 and 390 px for page-level horizontal overflow.

### Motion: a proposed amendment to DG-01 § 0

DG-01 says "no decorative motion". This proposal keeps that and adds a stricter
test: **motion is allowed only when it communicates a state change**.

- Enter/leave of a card, report, drawer or sheet: ≤ 260 ms, one-shot.
- Loops only while Florina is listening, thinking or speaking. Never ambient.
- A seat pulses once (700 ms) when a commander handles a problem, plus the 5 s
  one-liner. This is the "game feel": you see the machine working without being asked.
- First-open seat stagger (70 ms steps). Skipped with `?sim=0`.
- `prefers-reduced-motion` flattens all of it (also testable via the prototype menu).
- No sound by default. Speech is only ever triggered by pressing "Catch me up".

## 9. Trust, safety and what could go wrong

| Risk                                                                          | Mitigation in the design                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hidden failures erode trust ("what did they do while I was away?")            | Handled ledger with level and event kind; every row reaches the journal; the count is always visible                                                                                                                                                                                                                       |
| Automation bias: the recommended button gets clicked blindly                  | Recommendation is a default, not a decision; reason is shown; widening ("Allow for this project") needs a second press; Undo for 9 s; grants revocable; Critical items carry no pre-armed default; track acceptance vs. undo rate (§ 11)                                                                                   |
| A commander or worker is mistaken for a second relationship you must maintain | Florina remains the default recipient and the only compiler of orders. The channel is opt-in; you may never visit it. Messages to commanders are journaled and visible. **Decided: allowed** (§ 12 item 6), though PRODUCT_DESIGN says providers and managers must not be "a second relationship the user has to maintain" |
| Enter-to-approve is dangerous                                                 | Enter fires the card's primary only when the card itself is focused; high-authority actions (push/merge/deploy, per DEC-010 hierarchy) stay behind the existing confirm gate and are not on the Table at all                                                                                                               |
| Metaphor confusion for a first-time user                                      | Plain status words, no military jargon in labels ("Your call", "Reports in", "Standing orders"); "Commander" is a heading and a single word, never an action                                                                                                                                                               |
| Calm screen hides a stuck system                                              | Calm state shows proof (recent handled items); offline and quota-hold are loud; liveness timeouts still raise items (existing L0)                                                                                                                                                                                          |
| Voice approves something it should not                                        | Unchanged: DEC-010. Voice stages, the card verifies structured fields                                                                                                                                                                                                                                                      |
| You and the coordinator give a worker conflicting instructions                | Every message is in one ordered log. A message to a worker is relayed to the coordinator, who reconciles it in the same log. Orders carry `Order N` tags so it is clear which instruction is current                                                                                                                       |
| Reading the channel becomes a chore (monitoring dashboard creep)              | Nothing in it interrupts. Default level hides raw events. Unread badges count conversation only. Wire merges all channels into one short feed                                                                                                                                                                              |
| A message sneaks past Limits                                                  | A message cannot grant capability. Push, merge and deploy wording is flagged and downgraded to advice. In production this check must use capability classes, not wording (the prototype uses a regex)                                                                                                                      |
| Messages burn quota                                                           | The To: note says so; Supplies shows the effect. Copilot's steering also bills per message (source in § 4)                                                                                                                                                                                                                 |
| Over-claiming                                                                 | Prototype labels simulated parts; § 11 lists what is unproven                                                                                                                                                                                                                                                              |

## 10. Where the data comes from, and what is missing

Class **A** = exists and can be rendered now. **B** = needs a new view-model over
existing data. **C** = needs new backend behaviour or a decision first.

| UI element                                                       | Source                                                                                                                     | Class | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs-you count, Your call list                                  | `AttentionItem` (`category`, `priority`, `decisionRequested`, `affectedCapability`, `blockingImpact`)                      | A     | Structured observed facts already exist (DEC-010)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Florina recommends X + reason**                                | `AttentionItem.suggestedSafeOptions` is `string[]` with no ranking or rationale                                            | **C** | Needs a `recommended` option plus a provenance-bearing reason (rule id, past approvals). Must come from the deterministic memory match (RULES § 6.2), never LLM-only                                                                                                                                                                                                                                                                                                                                                   |
| Headline + detail                                                | Counts over tasks, attention, reports, handled                                                                             | B     | Pure function; fully unit-testable from § 7 table                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Commander seat (status word, verified/total, handled count)      | Tasks grouped by `projectId`; `TaskState`; `VerificationObserved`; journal                                                 | B     | "Verified N of M" is a roll-up of verification outcomes (DEC-032)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Commander track record, per-commander limits                     | Journal outcomes; grants and `autonomyLevel`                                                                               | C     | Needs a defined measure ("accepted without rework") before it is shown                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Handled ledger                                                   | Journal kinds `TaskFailedOver`, `TaskNudged`, `TaskVerifyFailed`, `TaskParked`, `TaskResumed`, `ContextCondensed`, retries | B     | Level label (L0-L3) depends on resolvers from #214/#215 recording the level they resolved at: **verify before relying on it**                                                                                                                                                                                                                                                                                                                                                                                          |
| **Channel history** (coordinator, workers, tools)                | `query-events` per task, merged by time across the project's manager task and worker tasks                                 | B     | Text exists for `AgentProgress.message`, `TaskNudged.prompt`, tool and test events, approvals, failovers. **To verify:** that the manager session's prose is journaled under a task id the UI can map to the project                                                                                                                                                                                                                                                                                                   |
| Channel live updates                                             | Daemon event stream (`event-stream.ts`)                                                                                    | A/B   | New events append to the open channel; the seat badge counts unread                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Goal handoff** (Florina to manager) and who chooses the worker | `delegate-task` command; manager MCP tools; capacity router + preference rules (DEC-029)                                   | B/C   | The architecture already has managers dispatch workers through the daemon, which enforces quota. **Verify** the `delegate-task` payload carries limits and done-means; if not, the Brief compiler must. The "likely worker" in the read-back needs a **routing preview** (dry run of rules + quota, no dispatch), which does not exist (C)                                                                                                                                                                             |
| **Send a message to a worker or coordinator**                    | `AgentRuntimePort.sendMessage` and `capabilities.sendMessage` exist; Claude, Codex, ACP and stub adapters declare it true  | **C** | **No command exposes it.** The command list in `command-api.ts` has no send-message verb. Needs a `send-task-message` command, a new journaled event kind (none in `SUPERVISOR_EVENT_TYPES`), delivery receipts (accepted, queued between turns, unsupported, session ended), and capability gating. Note: `nudge-loop.ts`'s header says corrective re-dispatch is a fresh run because there was no send surface until M2 (#341/#342); #341 has since added the adapter capability, so that comment may be out of date |
| Worker tier / can-it-be-messaged                                 | Adapter `capabilities.sendMessage`, fidelity tier A-E                                                                      | A     | Whether a worker can take messages is its adapter's `capabilities.sendMessage`, not its tier. Only the stub, Claude, Codex and ACP adapters declare it; `agy` (tier D) does not, so it is read-only here. The tier chip is context                                                                                                                                                                                                                                                                                     |
| Pause / Resume a worker                                          | `TaskParked`, `TaskResumed` exist for quota parking                                                                        | C     | Human-initiated pause with resume is not a command today                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Limits guard on your text                                        | Hard policies (RULES § 4), capability classes                                                                              | C     | Must be structural, not wording                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Unread watermark per channel                                     | Client-side preference                                                                                                     | B     | Per-user; can live in `desktop-settings.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Check-in mode per commander                                      | Attention policy, `autonomyLevel`                                                                                          | C     | Needs a defined mapping onto escalation triggers                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Reports in (proof, risk, along-the-way)                          | Completion digest, `VerificationObserved`, failover events                                                                 | A/B   | "Handled on the way" joins digest to ledger by task                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Prove it                                                         | Provenance trail (gap #11)                                                                                                 | C     | Same gap as GAP_ANALYSIS #11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Supplies chip + tab                                              | `query-fleet`, quota ledger                                                                                                | A     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Read-back sheet                                                  | Execution Brief compiler (DEC-040, gap #2)                                                                                 | **C** | Prototype fakes the compile. Needs the compiler's output exposed as a preview before dispatch                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Order dispatch + Undo                                            | `delegate-task`, `stop`                                                                                                    | A/C   | Undo of an _unstarted_ dispatch needs a cancel-before-start guarantee                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Hold my calls                                                    | Urgency vs batching (RULES § 8)                                                                                            | **C** | No setting exists today. Needs: preference, attention routing honouring it, tray/voice interrupt suppression. Critical must always interrupt                                                                                                                                                                                                                                                                                                                                                                           |
| Catch me up                                                      | `get-catchup`, `catchup-message.ts`, voice pipeline                                                                        | A/B   | Spoken delivery reuses the Realtime/TTS path rather than browser speech                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Minutes                                                          | `chat-read` journal                                                                                                        | A     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Desk                                                             | `secretary:update` tree                                                                                                    | A     | Pending memory confirmations already exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Standing orders                                                  | Preference/memory views                                                                                                    | A     | Revoke and provenance exist; locked hard policies per RULES § 4                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Appoint commander                                                | repos roots + discovery                                                                                                    | A     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Hold this front / Run on Claude Code once                        | `stop`, capacity router override                                                                                           | C     | Needs a one-shot override that does not edit the rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## 11. Evidence and what is still unproven

**Verified (real Chromium via Playwright, `file://`, `?sim=0`):** 131 checks in three
scripts (59 + 19 + 53), all passing on the final build, including:

- headline and counts for each scenario; deterministic copy for 2 calls, 1 call, quiet
- keyboard-only resolution of a decision (`j`, `Enter`), Undo restoring state
- widening and destructive actions require a second press (decision and critical banner)
- order → read-back → dispatch; ambiguous order asks "Which front"
- commander drill-in, `Esc` returns and restores focus to the seat
- drawer tabs `1-5`, `Esc` closes (found and fixed a bug: the `hidden` attribute lost to `display:flex`)
- focus survives re-render on the Hold-my-calls switch (found and fixed)
- Space-hold voice simulation, text lands in the box and is not auto-sent; no layout shift while listening
- Catch me up enters the speaking state; `Esc` and talking both cut it off
- Record search; Standing orders revoke (hard policies not revocable)
- calm feed, offline read-only state, first-run appointing
- no horizontal page overflow at 1440, 1180, 1024, 820, 390 px
- **axe-core** (wcag2a, wcag2aa, wcag21aa, best-practice): 0 violations in `morning`, `critical`, `offline`, `quiet`, `firstrun` (found and fixed a real contrast failure on `<kbd>` inside the primary button)
- **Channel (49 checks):** unread badges and the "New since" divider; badge clears on open; Handled rows in the channel equal the ledger; Conversation / Actions / Everything levels; a tool row you opened stays open across live updates; participant filter; intervention to the coordinator with journaled and delivered receipts, coordinator reply, relay to the worker and worker confirmation; direct message to a worker with the coordinator kept informed; recipients that cannot take messages are disabled with the reason (out-of-quota Codex, tier D agy); push-wording becomes advice only and no approval is created; answering a decision inside the channel resolves it on the Table and Undo restores both; pause and resume a worker; "To Florina" opens the read-back; `Esc` leaves the box first, the channel second; `Discussion` and `Open thread` jump to the exact highlighted message; Wire rows open their channel in context; first-run commander gets a channel; resolved asks never show stale buttons; no page overflow and a usable log height at 1440, 1024, 820 and 390 px
- **Goal handoff (4 checks):** a new goal appears as a structured `GOAL` row first, with no worker and no order yet; the coordinator then answers with a plan and issues the worker order itself; your stated preference ("Codex if it is free") travels inside the goal; withdrawing the goal inside the undo window cancels the coordinator's plan and orders
- **axe-core on the channel, the channel after an intervention, the Wire drawer, the Overview tab and a tier D channel:** 0 violations after fixing two real defects the first run found (non-tab children inside a `role="tablist"`, and a heading level skip in the embedded decision card)
- zero console errors or warnings across the run
- Prettier-clean with the repo config

The Playwright script that produced these results is an ad-hoc scratch file and is
**not committed**: the repo has no Playwright dependency. Issue W5 should add durable
tests for the real renderer instead of porting the scratch script.

**Not proven. Do not read the prototype as evidence for these:**

- **Human comprehension.** No usability session was run. `/flux-usability` should
  test the five tasks below with first-time users before production commitment.
  Simulated reasoning is not human evidence.
- **Screen-reader behaviour.** axe is automated and catches roughly a third of issues.
  No VoiceOver/NVDA pass. Live-region wording is untested with real AT.
- **Electron.** Not run inside the app shell; IPC, tray, global hotkey and
  `RenderTree` delivery are not exercised. Real push-to-talk and Realtime audio are simulated.
- **Real data shapes.** All content is fixtures. The 2-3 decision cap and the
  5-seat rail assume a handful of projects; behaviour with 12 projects is untested.
- **The recommendation engine** (§ 10, class C) does not exist.
- **The conversation is authored.** Every coordinator and worker line in the
  prototype was written by hand to be readable. Real agent output will be longer,
  messier and tool-heavy, and whether the coordinator's own prose is journaled in a
  readable form is unverified (§ 10). The channel's value depends on that.
- **Volume.** The fixtures hold 5-25 rows per project. A busy day may be thousands
  of events; virtualization, retention and search in the channel are not designed here.
- **Delivery semantics.** What happens when a message arrives mid-turn differs by
  provider (queue, interrupt, ignore). The prototype's receipts assume a clean
  "delivered".
- **Whether people will actually read it.** The channel is meant to be consulted,
  not watched. That claim needs the usability study.
- **Contrast in states other than the default** was only covered by axe's automatic
  checks, not a manual audit of every hover/armed state.

**Proposed usability script (for `/flux-usability`).** Information boundary: the
participant sees only the UI. (1) "You have a minute: what needs you?" (2) Approve
the network request safely. (3) Ask for something vague and notice the read-back.
(4) Find out what happened to the failed test you heard about. (5) Come back after
the daemon dropped; what can you do? (6) "Something looks wrong with
checkout-refactor": find what its worker said and tell it to stop touching a file.
(7) Try to get it to push to main, and explain why it did not happen.

**Success measures once built:** attention compression (existing ACR, DEC-015);
time to first decision on open; recommendation acceptance **and** undo/revoke
rate (high acceptance alone is not success); "surprise" interviews on the Handled
ledger; first-run completion to first dispatched order.

## 12. Open decisions for the maintainer

These are recorded rather than silently decided. Defaults in the prototype are
reversible.

1. **Naming.** `docs/UX_INFORMATION_ARCHITECTURE.md` § 5 says UI copy should say
   "project manager" or the project name, not a new noun. The prototype uses
   **Commander** because the brief asked for that fiction. Alternative: keep
   "Commander" as a metaphor in marketing and onboarding only, and show
   "project manager" in labels. Either works; mixing both in one screen does not.
2. **IA.** This reverses part of DEC-043 (five items → three plus drill-down).
   It would need a new decision entry. DEC-043's own reconsideration trigger
   (user testing does not show the five-item split reduces confusion) has no
   evidence either way yet.
3. **Chat is no longer the launch view.** `docs/UX_GUIDELINES.md` § 2 and #160
   made the conversation the centre. Here the conversation is the order bar plus
   the briefing, and the transcript is Minutes. Voice-first (PRODUCT_DESIGN) is
   preserved; the transcript-first assumption is not.
4. **Motion amendment** in § 8.
5. **Hold my calls** semantics, especially "Critical always interrupts".
6. **Direct address. DECIDED: yes.** PRODUCT_DESIGN says providers, managers and
   workers are "never a second relationship the user has to maintain". The
   maintainer chose to let you read and speak in any channel, to the coordinator
   or to a worker. Constraints that follow: always journaled, always visible to the
   coordinator, never required, messages never grant permissions. PRODUCT_DESIGN
   should be amended to say the relationship is _default_, not _exclusive_.
7. **Does Florina speak in channels? DECIDED: yes.** She opens each channel with the
   goal and adds short notes. She does not instruct workers.
8. **Who picks the worker? DECIDED: the manager.** Florina gives goals; managers
   choose workers within the rules and quota the daemon enforces (DEC-018,
   DEC-029). The read-back therefore shows an _expected_ worker, not an
   assignment.

## 13. Implementation plan (each is independently shippable)

Dependency order. Hexagonal rule: pure view-models go in `src/core/application/use-cases/`
(no Node globals); renderer code stays in `src/adapters/inbound/desktop/renderer/`.
Tests first for anything with behaviour (vitest); screenshots through `npm run visual-qa`.

| #   | Issue                                                                                                                                                      | Class | Acceptance (observable)                                                                                                                                                                                            | Tests                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| W1  | `compose-briefing` view-model: headline + detail from counts                                                                                               | B     | Table in § 7 reproduced exactly, including pluralization and the "nothing else" close rule                                                                                                                         | Unit, table-driven; one row per § 7 condition       |
| W2  | `commander-roll-up`: per-project status word, verified/total, handled count                                                                                | B     | Status precedence: critical > awaiting > holding/paused > verifying > advancing > idle; counts match journal fixtures                                                                                              | Unit + journal fixture                              |
| W3  | `handled-ledger` query over journal kinds                                                                                                                  | B     | Returns what/did/level/event for the kinds in § 10; never includes items that became attention items                                                                                                               | Unit; ladder integration                            |
| W4  | Recommendation + reason on `AttentionItem` (decide: new field vs. view-model)                                                                              | **C** | Deterministic: only from matched rules or past approvals; absent → no recommendation shown; hard-policy and widening items never carry one                                                                         | Unit; "never auto-learn" guard (#16)                |
| W5  | Table renderer: rail, Florina's seat, decision card v2, report rows, calm feed                                                                             | A/B   | Matches the prototype at 1180×760 and passes the responsive checks in § 8                                                                                                                                          | visual-qa + keyboard test                           |
| W6  | Goal read-back over the Execution Brief preview, with a routing preview ("likely worker")                                                                  | **C** | Nothing is handed over before Go unless "Only when unsure" and confident; the coordinator, not Florina, selects the worker; Undo withdraws a goal before the coordinator acts                                      | Unit + integration                                  |
| W7  | Hold my calls: preference, attention routing, tray/voice suppression                                                                                       | **C** | Critical still interrupts; everything else queues; journaled as a Decision                                                                                                                                         | Unit + attention-engine tests                       |
| W8  | Order bar + Minutes drawer + Desk/Supplies drawer tabs on existing data                                                                                    | A     | Same journaling and dedupe (`clientId`) guarantees as today                                                                                                                                                        | Existing chat tests + new view tests                |
| W9  | IA migration: three destinations, chord aliases for `g f/a/w/h/e`, docs and mockups updated                                                                | A     | No orphaned screen: Fleet, Ideas, Secretary, Settings forms all reachable                                                                                                                                          | `visual-qa` matrix updated                          |
| W10 | Usability study (`/flux-usability`)                                                                                                                        | n/a   | Script in § 11 run with first-time users; findings folded back                                                                                                                                                     | Evidence report                                     |
| W11 | **Channel read model**: merge manager-task and worker-task events into one ordered stream per project, with message kind, author, target and tool grouping | B     | Fixture journal reproduces the row kinds in § 7.1; manager prose confirmed readable or the gap recorded                                                                                                            | Unit + journal fixture                              |
| W12 | **`send-task-message` command**: journaled event kind, capability gate, receipts, coordinator notification                                                 | **C** | A message to a live worker is journaled first, delivered, and receipted. Tier D/E and ended sessions return `unsupported` / `session-ended` and route to the coordinator. Cannot carry or imply a capability grant | Unit + adapter contract + `architecture-boundaries` |
| W13 | Channel renderer: log, levels, filters, divider, jump, To: row, receipts, embedded decision card                                                           | A/B   | Matches the prototype; keyboard path and axe clean on the real renderer                                                                                                                                            | visual-qa + keyboard + axe                          |
| W14 | Unread watermark, seat badges, Wire drawer, deep links (`Discussion`, `Open thread`, `Open in channel`)                                                    | B     | Counts conversation only; links land on the highlighted message                                                                                                                                                    | Unit + view tests                                   |
| W15 | Limits guard and Florina notes in channel (capability-class based) and per-commander check-in mode                                                         | **C** | "Push" intent never produces a grant; check-in mode changes asking frequency only                                                                                                                                  | Unit + "never auto-learn" guard                     |

## 14. Running the prototype

```bash
# any static server, or just open the file
python3 -m http.server -d docs/prototypes/war-room 8080
# http://localhost:8080/?scenario=critical      (morning | quiet | critical | offline | firstrun)
# http://localhost:8080/?sim=0                  (freeze live events and entrance motion)
```

Use the **PROTOTYPE ▾** menu (top right) to switch scenarios, toggle live
simulation, or preview reduced motion. `window.__war` exposes `fireCall()`,
`fireReport()`, `fireHandled()`, `emitScript()` (adds a live worker line),
`appendMsg(id, msg)`, `openChannel(id, msgId)` and `load(name)` for demos and tests.

What is **interactive**: every control on the Table, the commander view and its
channel (levels, filters, To:, receipts, pause, embedded decisions, deep links),
Record, Standing orders, the drawer including Wire, keyboard shortcuts, the voice
simulation, Undo. What is **simulated**: speech recognition (a canned phrase),
parsing of orders (keyword match on project names), the coordinator's and workers'
replies to your messages (scripted), live worker lines (a short script per front),
the daemon, all data. What is **not drawn**:
the three-column inspector ("Open full timeline"), Providers/Keys/Repos/Voice
settings, the PR flow.
