# UX Issue Catalogue — issues ↔ screenshot evidence

**Evidence run:** 2026-10-07, commit `2d14120` (v0.3.0), real daemon
(detached, pid 119484), `npm run visual-qa`. 11 app captures + 10 mockup
captures in `shots/` (gitignored). A screenshot proves a view _renders_ —
not that its behavior is correct; behavioral claims come from the issues'
own verification.

**Scope:** every `ux`- or `onboarding`-labeled issue (18) plus the
unlabeled issues that own a user-visible surface (screen, HUD, tray,
setup). Only **#279** (first-run usability pilot) is open — everything
else shipped.

## Screen ↔ evidence map

| Screen                               | App shot                                     | Mockup                                       | Issues covering it                       |
| ------------------------------------ | -------------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| Florina / chat thread                | `app-chat.png`, `app-chat-senderror.png`     | `mockup-chat.png`                            | #160, #181, #218, #260, #262, #263, #278 |
| Attention inbox                      | `app-inbox.png`, `app-inbox-journalfail.png` | `mockup-inbox.png`                           | #25, #26, #120, #122                     |
| Work · Tasks (3-col inspector)       | `app-tasks.png`                              | `mockup-inspector.png`                       | #266, (#126 unlabeled)                   |
| Work · Fleet/quota                   | `app-work-fleet.png`                         | `mockup-fleet.png`                           | #127, #74                                |
| Work · Ideas                         | `app-work-ideas.png`                         | `mockup-ideas.png`                           | #129, #74                                |
| History                              | `app-history.png`                            | `mockup-history.png`                         | #221, (#222 journal search unlabeled)    |
| Settings (rules/memory/repos)        | `app-prefs.png`, `app-settings-repos.png`    | `mockup-preferences.png`                     | #128, (#223, #253 unlabeled)             |
| Secretary lens                       | `app-secretary.png`                          | `mockup-secretary.png`                       | #130, #262                               |
| PTT HUD + tray                       | — not captured (window decoration/tray)      | `mockup-hud.png`                             | #28                                      |
| Voice-mode overlay                   | — not captured                               | `mockup-voice-overlay.png`                   | (#182 unlabeled)                         |
| Digest/diff viewer                   | — opens from inbox cards                     | `mockup-inspector.png` (side-by-side in #27) | #27                                      |
| Setup card (in chat, first-run only) | — not visible (this machine is configured)   | —                                            | #277, #278                               |
| Cross-cutting / architectural        | all                                          | —                                            | #42, #49, #50, #65, #183, #261, #279     |

## All UX-surface issues (authoritative)

18 `ux`/`onboarding`-labeled + 13 unlabeled screen-owners (120, 122,
127–130, 133, 160, 181, 183, 218, 221, 223).

| #   | State    | Closed     | Contract                                                       | Evidence shot(s)                                                                            |
| --- | -------- | ---------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 25  | closed   | 2026-08-23 | Inbox as prioritized NEEDS YOU / WORKING card sections         | `app-inbox.png` — sections + priority chips render                                          |
| 26  | closed   | 2026-08-23 | Structured approve/deny/inspect capability cards               | `app-inbox-journalfail.png` — card buttons (Inspect/Acknowledge) render                     |
| 27  | closed   | 2026-08-23 | Side-by-side completion digest + diff viewer                   | no dedicated shot — opens from a card; mockup-level only                                    |
| 28  | closed   | 2026-08-23 | PTT HUD five states + global hotkey + tray                     | no HUD window shot; **hotkey conflict visible live** (see findings)                         |
| 42  | closed   | 2026-09-13 | Docs fix — `start` blocks (superseded by #323 `--detach`)      | docs, not a screen                                                                          |
| 49  | closed   | 2026-08-24 | Wayfinder: task lifecycle + entry surface                      | architectural — resolved by the app as shipped                                              |
| 50  | closed   | 2026-08-24 | Wayfinder: desktop runtime + daemon lifecycle + distribution   | architectural — packaged v0.3.0 exists                                                      |
| 65  | closed   | 2026-09-13 | Provider preference profile + voice setup interview            | Settings surfaces; voice interview not exercised by shots                                   |
| 74  | closed   | 2026-09-13 | M6 views: fleet, ideas, preferences, secretary, context health | `app-work-fleet.png`, `app-work-ideas.png`, `app-prefs.png`, `app-secretary.png` all render |
| 120 | closed   | 2026-09-13 | Inbox wired to live daemon data                                | `app-inbox.png` shows live items (real 401 sign-in card)                                    |
| 122 | closed   | 2026-09-13 | Amber reconnect state, last-known-state readable               | not captured (needs a daemon-kill pass); statusline exists                                  |
| 127 | closed   | 2026-09-14 | Per-provider quota bars, resets, parked tasks                  | `app-work-fleet.png` — 10 providers, "no quota observations yet" honest empty state         |
| 128 | closed   | 2026-09-14 | Readable rules + provenance + inline edit/revoke               | `app-prefs.png` — rules with scope tags, Edit/Revoke buttons render                         |
| 129 | closed   | 2026-09-14 | Ledger list + reader + Compile Brief gate                      | `app-work-ideas.png` — compiled brief card with "Review & approve" (DEC-033 gate visible)   |
| 130 | closed   | 2026-09-14 | Secretary view: plan, in-flight research, memory writes        | `app-secretary.png` — all sections render with honest empty states                          |
| 133 | closed   | 2026-09-14 | `npm run visual-qa` parity procedure                           | this run — 21 shots, zero capture failures                                                  |
| 160 | closed   | 2026-09-14 | Chat as launch view: message column + composer                 | `app-chat.png` — thread, composer, PTT pill render                                          |
| 181 | closed   | 2026-09-14 | Toggleable activity/diff drawer                                | `app-chat.png` — "Activity" header toggle + LIVE ACTIVITY rail visible                      |
| 183 | closed   | 2026-09-15 | Consistency pass across five screens                           | all shots share tokens/typography — consistent                                              |
| 218 | closed   | 2026-09-21 | Idle auto-catch-up on Florina view                             | wired; not exercised (no idle gap in run)                                                   |
| 221 | closed   | 2026-09-21 | History: completed work + resolved decisions                   | `app-history.png` — sections + journal search render                                        |
| 223 | closed   | 2026-09-21 | Settings memory/rules browse                                   | `app-prefs.png` — browse list + filters render                                              |
| 260 | closed   | 2026-09-27 | Idle catch-up digest as next chat message                      | wired; not exercised                                                                        |
| 261 | closed   | 2026-09-27 | Shared confirm affordance for destructive actions              | gates render on cards; destructive path not exercised                                       |
| 262 | closed   | 2026-09-27 | Secretary lens reachable from Florina view                     | `app-secretary.png` captured via `g e` — reachability proven                                |
| 263 | closed   | 2026-09-27 | Inline send-failure row + retry                                | `app-chat-senderror.png` — red error row + Retry rendered live                              |
| 266 | closed   | 2026-09-27 | Esc pops inspector drill-down one level                        | script log: "Esc pops one level per press" — exercised live                                 |
| 276 | closed   | 2026-10-01 | Onboarding M0 — install paths baseline recorded                | docs artifact                                                                               |
| 277 | closed   | 2026-10-01 | M1 — guided setup card to verified ready state                 | card not in shots (machine already configured); see gap note                                |
| 278 | closed   | 2026-10-01 | M2 — first-task guidance in empty chat                         | chat isn't empty on this machine; guidance path not exercised                               |
| 279 | **open** | —          | M3 — five-participant usability pilot                          | **the only open UX issue**; materials shipped, sessions deferred                            |

## Unlabeled but UX-owning (for completeness)

#119 RenderTree foundation, #121 approval actions, #123 HUD window,
#124 global hotkey, #125 close-to-tray, #126 inspector 3-column, #131 HUD
event wiring, #132 daemon auto-start, #157/#158 chat thread+turns,
#161 dictation, #162 voice mode, #163 voice settings, #182 voice overlay,
#198/#219 five-item IA, #199/#221/#222 history+journal search, #200/#224
memory browse+inline actions, #201 provenance trail, #202 failover
indicator, #253 repos picker, #264 journal-failure cards, #265 icon/color
consistency, #270 shared confirmation (merged PR, not an issue), #272 inbox persistence,
#294 provider-readiness UI, #292 secrets surfaces. All closed; most are
visible in today's shots (nav IA, inspector columns, repos picker, journal
search bar, provenance affordances).

## Live findings from this capture (not covered by any closed issue)

1. **Text is not selectable anywhere.** `index.html` sets global
   `-webkit-user-select: none` with zero content re-enables, and no
   context menu / Edit menu exists — chat messages, error text, journal
   rows are all uncopyable, contradicting DG-01's "readable/copyable"
   error requirement (`desktop-app.ts:816`). **Highest-value open gap.**
2. **Global PTT hotkey dead on this machine.** Every shot carries the
   "Hotkey conflict: CommandOrControl+Space" notification — the feature
   from #28 is registered-conflict → unregistered. The notification
   surface itself works correctly (good), but the user-facing outcome is
   degraded with no in-app remediation path shown.
3. **Bottom-edge artifact.** A thin pale horizontal strip renders at the
   window's bottom edge on `app-tasks`, `app-history`, `app-prefs`,
   `app-work-fleet`, `app-work-ideas`, `app-settings-repos` — likely a
   scrollbar-gutter/paint artifact. Cosmetic, worth one look.
4. **Setup card uncaptured.** #277's first-run card only renders on an
   unconfigured machine; this machine is configured so the card never
   appeared — the visual-qa pass has no first-run fixture. A parity gap
   in #133's procedure.
5. **`chatModel` failure does surface correctly** — the LiteLLM 401
   appears as a High "Sign-in needed" card with an "Add key" affordance
   (`app-inbox.png`) and as an honest Secretary turn in chat. The honesty
   contract (#294) is working live.
