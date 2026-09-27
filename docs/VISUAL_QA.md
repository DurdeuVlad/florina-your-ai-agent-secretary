# Visual QA — mockup parity procedure

Issue #133, per DG-01: unit/integration tests prove behavior, not pixels.
This is the cheap scripted pass run **before closing any screen issue**
and **once per milestone** before shipping.

## Tooling decision

One script, no harness:

```bash
npm run build && npm run visual-qa
```

`scripts/visual-qa-entry.cjs` runs under Electron and writes
`shots/` (gitignored):

- `shots/mockup-<screen>.png` — each `docs/mockups/*.html` rendered at
  the app's real window geometry (1180×760).
- `shots/app-<view>.png` — the **real** app, booted from
  `dist/bootstrap/desktop.js`, cycled through every view with the same
  `g`-prefix keys a user presses. It talks to the real daemon (or
  auto-starts one, #132), so shots show live state, not fixtures.

Compare side by side; the checklist below is the pass/fail record. No
pixel-diffing yet — screenshots are evidence for a human pass, and a
deliberate state matrix (below) covers what screenshots can't.

## The pass

1. `npm run build && npm run visual-qa` — all `shots/app-*.png` written.
2. For each screen, open `app-<view>.png` next to `mockup-<screen>.png`
   and run its checklist.
3. Drive the live app once (it's already running enough state) through
   the state matrix — anything a screenshot can't show (offline,
   degraded) is verified by toggling the daemon.
4. Paste the completed checklist into the issue/PR as the sign-off.

## Per-screen checklist

Apply to every row: layout matches the mockup (regions, spacing, order);
only design tokens (`tokens.css` / `mockup.css` twins) — no ad-hoc
colors or sizes; copy structure matches (same labels, same hierarchy);
the screen is keyboard-navigable (`g`-nav — `g f/a/w/h/s`, `g e` for the Secretary lens, `j/k`, `h/l` in Work's Tasks column, `Enter`, `Esc`).

| View (shot)                            | Mockup               | Screen-specific checks                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app-chat.png`                         | `chat.html`          | Florina is the default launch view (`g f` also reaches it); journaled history hydrates on load — no optimistic bubbles; tool-activity rows inline between bubbles; working indicator during a turn; composer docked, mic + voice toggle enabled; **Activity drawer** (#181): header toggle opens/closes a right-hand panel showing the live task list, reusing the same task-row shape as Fleet/Tasks  |
| `app-inbox.png`                        | `inbox.html`         | Needs you / Working / Done sections; calm empty state when nothing pending; approval cards show the shared structured fields (voice↔visual contract)                                                                                                                                                                                                                                                   |
| `app-tasks.png`                        | `inspector.html`     | Work's Tasks sub-tab: 3-column drill-down (tasks → timeline → detail); `h/l` column focus; condensed rows show the condense marker; `Esc` **pops one level** — row selection, then column focus, then Attention (#266, verified each pass by real `j`/`Esc` key events: select → stay in Work → land on Attention)                                                                                     |
| `app-work-fleet.png`                   | `fleet.html`         | Work's Fleet sub-tab: provider cards with quota bars; parked section; routing-decision entries; the _only_ screen showing capacity                                                                                                                                                                                                                                                                     |
| `app-work-ideas.png`                   | `ideas.html`         | Work's Ideas sub-tab: ledger list with entry counts + previews; awaiting-decision briefs; compile-brief gate reachable per card                                                                                                                                                                                                                                                                        |
| `app-history.png`                      | `history.html`       | Completed work + resolved decisions sections; journal search bar (text + since/until dates); results reuse the inspector timeline row                                                                                                                                                                                                                                                                  |
| `app-prefs.png`                        | `preferences.html`   | Rules + denies listed; inline add/revoke forms; no daemon-side leakage into unrelated fields                                                                                                                                                                                                                                                                                                           |
| `app-settings-repos.png`               | `preferences.html`   | Same Settings view scrolled to Repos + Desktop & voice: root rows in priority order with move/remove, discovered repo cards, mic/language/voice-mode fields                                                                                                                                                                                                                                            |
| `app-secretary.png`                    | `secretary.html`     | Secretary lens reached via `g e` or the Secretary header toggle inside Florina — Florina stays the active nav item, `Esc`/toggle pops back to the thread; context-health cards, plan, in-flight research, pending memory writes (Confirm/Reject keyboard-reachable)                                                                                                                                    |
| `app-chat-senderror.png`               | `chat.html`          | Send-failure row (#263): a daemon-rejected `chat-send` renders a red inline row (`✗ couldn't send "…" — <daemon error>`) with a Retry affordance; driven via a real `florina.command` rejection (whitespace text → "text is required") — the offline variant is the same code path and is covered by the state matrix below                                                                            |
| `app-inbox-journalfail.png`            | `inbox.html`         | Journal-gap card (#264): a real `raise-attention` (`itemKind: JournalFailure`) through a second daemon WS client renders the High/red card with Inspect + Acknowledge gap; the pass then drives `resolve:<id>` through the real renderer verb and verifies the card leaves Needs-you. Retry-write needs a retained row — only real insert failures carry one; that variant is unit/integration-covered |
| HUD pill (in every `app-*.png` header) | `hud.html`           | Five states map correctly (idle/listening/processing/responding/offline); transcript + reply preview in the two-line area; hotkey hint in idle                                                                                                                                                                                                                                                         |
| _(no separate app shot — see below)_   | `voice-overlay.html` | **Voice-mode overlay** (#182): a distinct full-window takeover, not the HUD pill above — engages only while two-way voice mode is active. Not captured in the automated `app-*` pass (engaging real voice mode needs a live Realtime connection); verify manually per the state matrix below.                                                                                                          |

## State coverage matrix

Each pass must cover these states somewhere — not necessarily all on
one screen. A screenshot of the _current_ state plus a note on how it
was reached is enough.

| State                               | How to reach it                                | Where it must be visible                                                                                                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty                               | Fresh DB / no pending items                    | Inbox "Nothing needs you" empty state; section counts = 0; chat shows its empty thread + composer ready                                                                                                                                                 |
| Chat mid-turn                       | Send a chat message while the Secretary thinks | Working/processing row in the chat list; composer stays editable                                                                                                                                                                                        |
| Chat dictating                      | Mic button in the chat composer                | Dictation state in the composer; partial transcript preview; dictated text lands editable — never auto-sent                                                                                                                                             |
| Chat offline                        | `florina stop` while chat is open              | Statusline dot + "reconnecting…"; journaled history stays readable; a send while offline becomes a red inline error row with the daemon error text + a Retry affordance (#263); the draft stays in the composer; retry dedupes via the send's client id |
| Loading / first paint               | App launch before first daemon sync            | Window never blanks to white; shell renders immediately                                                                                                                                                                                                 |
| Offline / reconnecting              | `florina stop` while the app runs              | Amber dot + "reconnecting…"; last-known content stays readable; HUD shows offline                                                                                                                                                                       |
| Error                               | Malformed command / failed action              | Inline in the affected card/panel; raw daemon error copyable; no toast                                                                                                                                                                                  |
| Parked                              | Task parked by failover/quota                  | Fleet screen parked section with resume time                                                                                                                                                                                                            |
| Degraded                            | Context-health snapshot `degraded`/`critical`  | Secretary screen health section                                                                                                                                                                                                                         |
| Listening / processing / responding | PTT hotkey or `voice-state` reports            | HUD pill state + transcript lines                                                                                                                                                                                                                       |
| Chat drawer open/closed             | Click the "Activity" header toggle in Chat     | Drawer panel slides in beside the transcript with the live task list; transcript stays single-column when closed (default)                                                                                                                              |
| Voice-mode overlay engaged          | Toggle voice mode on in the chat composer      | Full-window overlay appears (distinct window, not the HUD pill), mirrors listening/processing/responding; disengaging hides it and the small HUD keeps working                                                                                          |

## Sign-off convention

Paste into the screen issue or PR:

```
- [ ] visual-qa run at <commit>: shots match mockups for <screens>
- [ ] state matrix covered: <states exercised>
- [ ] keyboard nav verified: g-nav, j/k, Enter, Esc
```

A failed check either fixes forward in the same issue or files a
follow-up with the shot attached — never close a screen issue with an
unchecked box.
