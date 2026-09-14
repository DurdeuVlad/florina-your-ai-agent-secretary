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
the screen is keyboard-navigable (`g`-nav, `j/k`, `Enter`, `Esc`).

| View (shot)                            | Mockup             | Screen-specific checks                                                                                                                               |
| -------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-inbox.png`                        | `inbox.html`       | NEEDS YOU / WORKING / DONE sections; calm empty state when nothing pending; approval cards show the shared structured fields (voice↔visual contract) |
| `app-tasks.png`                        | `inspector.html`   | 3-column drill-down (tasks → timeline → detail); `h/l` column focus; condensed rows show the condense marker; `Esc` returns to inbox                 |
| `app-fleet.png`                        | `fleet.html`       | Provider cards with quota bars; parked section; routing-decision entries; the _only_ screen showing capacity                                         |
| `app-ideas.png`                        | `ideas.html`       | Ledger list with entry counts + previews; awaiting-decision briefs; compile-brief gate reachable per card                                            |
| `app-prefs.png`                        | `preferences.html` | Rules + denies listed; inline add/revoke forms; no daemon-side leakage into unrelated fields                                                         |
| `app-secretary.png`                    | `secretary.html`   | Plan, in-flight research, pending memory writes, context health sections — honest empties when unwired                                               |
| HUD pill (in every `app-*.png` header) | `hud.html`         | Five states map correctly (idle/listening/processing/responding/offline); transcript + reply preview in the two-line area; hotkey hint in idle       |

## State coverage matrix

Each pass must cover these states somewhere — not necessarily all on
one screen. A screenshot of the _current_ state plus a note on how it
was reached is enough.

| State                               | How to reach it                               | Where it must be visible                                                          |
| ----------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Empty                               | Fresh DB / no pending items                   | Inbox "Nothing needs you" empty state; section counts = 0                         |
| Loading / first paint               | App launch before first daemon sync           | Window never blanks to white; shell renders immediately                           |
| Offline / reconnecting              | `florina stop` while the app runs             | Amber dot + "reconnecting…"; last-known content stays readable; HUD shows offline |
| Error                               | Malformed command / failed action             | Inline in the affected card/panel; raw daemon error copyable; no toast            |
| Parked                              | Task parked by failover/quota                 | Fleet screen parked section with resume time                                      |
| Degraded                            | Context-health snapshot `degraded`/`critical` | Secretary screen health section                                                   |
| Listening / processing / responding | PTT hotkey or `voice-state` reports           | HUD pill state + transcript lines                                                 |

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
