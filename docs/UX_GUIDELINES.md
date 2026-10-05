# Florina UX/UI Guidelines (DG-01)

Design language for the desktop app (DEC-028, issue #43) and every visual
surface that follows. Complements `docs/DESKTOP_UI.md` (view inventory) —
that doc says _what_ the screens are; this one says _how they look, feel,
and behave_. Companion mockups: `docs/mockups/` (open `index.html`).

## 0. First principles (from PRODUCT_DESIGN.md)

| Principle               | Design consequence                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Attention over activity | The home screen is an **inbox**, never a dashboard. Idle state is a quiet empty inbox, not a wall of telemetry.                               |
| Energy conservation     | No decorative motion, no ambient badges, no counts that don't demand action. If it doesn't need a decision, it whispers or stays out of view. |
| Done means proven       | Completion cards always lead with _verification evidence_, not the agent's claim. "23/23 tests" is the headline; the diff is a drill-down.    |
| Progressive disclosure  | Every screen is one summary layer deep by default; drilling is cheap (click / `Enter` / `j`), coming back is cheaper (`Esc` / `h`).           |
| Inspectability          | Anything the Florina summarized is visibly labeled **inferred**; anything from the journal is **observed**. The two never share a text style. |
| Voice-first             | The window is a companion to voice, not a container for it. The PTT HUD works with the main window closed.                                    |

## 1. Design tokens

The view layer emits **semantic tokens** (`color: 'amber'`, `spacing: 'md'`,
icon glyph names). Renderers map tokens to values — this table is the
canonical mapping. Tokens, not hex values, are the API.

### 1.1 Color

Rebuilt for #180 to a warmer, Codex/ChatGPT-desktop-caliber neutral scale;
rebranded to a lavender accent (`accent` = `purple`). Purple carries the
dev-tool convention (Stripe/Sentry/GitHub/Heroku) while `amber` keeps its
exclusive "needs you" semantics — attention and interactivity stay
hue-separated. `blue` was demoted to a supporting token (Medium/info rung of
the severity ladder). `green`/`red` keep exclusive status semantics —
priority and status must never share a hue.

| Token             | Hex       | Use                                        |
| ----------------- | --------- | ------------------------------------------ |
| `bg`              | `#0e0a16` | app background — violet-black              |
| `surface`         | `#151022` | sidebar, chrome                            |
| `panel`           | `#1d1730` | cards                                      |
| `panel-raised`    | `#261e3f` | hovered/active card, popovers              |
| `border`          | `#342b4e` | hairlines only — never decorative boxes    |
| `text`            | `#eeecf5` | primary copy                               |
| `muted`           | `#9b93b3` | metadata, timestamps, secondary copy       |
| `accent`          | `#a98af0` | brand hue: primary buttons, focus, links   |
| `accent-contrast` | `#1a1028` | text/icons rendered on top of `accent`     |
| `green`           | `#3fb984` | verified, connected, completed-ok          |
| `amber`           | `#e3a94a` | approval required, parked, elevated risk   |
| `red`             | `#ef5959` | critical, failed, sandbox violation        |
| `orange`          | `#e2814f` | degraded context, dirty worktree           |
| `purple`          | `#a98af0` | digests, reviewed/accepted (= accent)      |
| `slate`           | `#847d99` | idle/stale — intentionally quiet           |
| `blue`            | `#4f8dff` | Medium/info severity — supporting hue only |

Elevation/shape tokens introduced alongside the palette:

| Token       | Value                         | Use                               |
| ----------- | ----------------------------- | --------------------------------- |
| `radius-sm` | `6px`                         | small controls                    |
| `radius-md` | `10px`                        | buttons, nav items, task rows     |
| `radius-lg` | `14px`                        | cards, columns, popovers, gallery |
| `shadow-sm` | `0 1px 2px rgba(0,0,0,.4)`    | subtle lift                       |
| `shadow-md` | `0 8px 24px rgba(0,0,0,.45)`  | popovers                          |
| `shadow-lg` | `0 16px 48px rgba(0,0,0,.55)` | PTT HUD, floating overlays        |

Rules:

- **Color is reserved for attention semantics.** Priority colors appear only
  on the item's left edge (3px) and its chip — never as fills.
- A surface gets _lighter_ as it rises: `bg` → `surface` → `panel` →
  `panel-raised`. Never invert.
- Observed vs inferred: observed text is `text`; inferred/summarized text
  is `muted` + italic.

### 1.2 Type

| Token     | Spec                | Use                                 |
| --------- | ------------------- | ----------------------------------- |
| `display` | 20px / 650          | view titles ("Attention Inbox")     |
| `title`   | 15px / 600          | card titles, task objectives        |
| `body`    | 14px / 400          | summaries, digest prose             |
| `meta`    | 12px / 400 `muted`  | ids, timestamps, provenance         |
| `mono`    | 12.5px ui-monospace | rules, diffs, event payloads, paths |

System font stack only (`-apple-system, "Segoe UI", Roboto`). No custom
fonts — the app must feel instant and native.

### 1.3 Space / radius / elevation

- Grid base **4px**; spacing scale `xs=4 sm=8 md=12 lg=16 xl=24`.
- Radius: `radius-sm` (6) controls, `8` chips, `radius-md` (10) buttons/nav
  items, `radius-lg` (14) cards/columns/popovers, `50%` status dots.
- No drop shadows except the PTT HUD (floating overlay) and popovers —
  `shadow-lg`/`shadow-md` respectively (§1.1).
- Density: default comfortable; inbox groups collapse to one line each when
  a group holds >3 items.

### 1.4 Iconography

Icon props are glyph _names_ (`shield`, `alert`, `branch`, `pause`,
`clock`, `document`, `gauge`, `info`, `check`, `play`, `stop`, `mic`).
Renderer maps names to its icon set. Icons are 14–16px, `muted` by
default, tinted only when carrying priority meaning.

## 2. Layout

```
┌──────────┬─────────────────────────────────────────┐
│ sidebar  │ header: view title · qualifier · actions│
│ 216px    ├─────────────────────────────────────────┤
│ nav +    │                                         │
│ daemon   │        content (single column,          │
│ status   │        max-width ~960px, scrolls)       │
└──────────┴─────────────────────────────────────────┘
```

- **Sidebar**: 5-item nav — **Florina** (home, the conversation), **Attention**
  (inbox, w/ count badge), **Work** (tasks, w/ count badge), **History**,
  **Settings** — plus daemon status footer (dot + one word). Never shows
  project pickers or filters — the inbox decides what matters. This
  replaces the earlier 7-item nav (Chat, Inbox, Tasks, Fleet, Ideas,
  Preferences, Secretary) per `docs/UX_INFORMATION_ARCHITECTURE.md` §2
  (issue #219): infrastructure (Fleet, Ideas) is absorbed into Work,
  Secretary into Florina, rather than staying a top-level peer. As of
  #219, this is a relabel of the nav surface only — the underlying Fleet/
  Ideas/Secretary views still exist and are reachable programmatically,
  but not yet from a nav button; issue #220 wires them in as Work/Florina
  sub-views. History is a stub pending issue #199's children.
- **Florina is the launch view** — the single Secretary conversation is
  the product's center; Attention/Work/etc. are support surfaces. Launch
  flow: the window opens on Florina, the daemon auto-starts if absent,
  and journaled history hydrates via `chat-read` — resume is automatic,
  there is no thread picker. Desktop voice prefs (mic device, dictation
  language, voice-mode default) load from
  `~/.florina/desktop-settings.json` and push to the renderer on
  `did-finish-load`; a saved `voiceModeDefault` engages voice mode.
- **Header**: view title + one-line qualifier ("what needs you right now")
  - at most two actions. No breadcrumbs — depth is ≤2.
- **Content**: single column of cards. Three-column layouts exist _only_
  inside the Session Inspector drill-down.

## 3. Components

### 3.1 Attention card (the atomic unit)

```
┃ HIGH   Approval Required              ● 12:04
┃ checkout-refactor
┃ Codex wants network access to registry.npmjs.org
┃ observed: package install · scope: this task only
┃ [Allow once]  [Deny]  [Inspect]
```

- Left 3px border carries the priority color. Title is the _decision_, not
  the event type.
- Structured fields (task, capability, destination, scope) render as
  **observed** — this is what voice readback and the visual card share
  (DEC-010/011).
- Primary action first, destructive last, `Inspect` always available.

### 3.2 Completion digest card

Headline = verification evidence (`23/23 tests, build green`). Risk line
follows in `amber` when present. Actions: `Review digest` → opens
side-by-side digest/diff viewer; `Create PR`; `Dismiss`. Grouped
completions collapse to one row ("3 tasks completed · no production
behavior changed").

### 3.3 Task row (WORKING strip / Tasks view)

`objective · provider chip · live status word` — status words are plain:
`editing`, `tests running`, `parked until 14:32`. Parked tasks show the
resume countdown in `amber`.

### 3.4 Session inspector (drill-down, 3 columns)

Projects/tasks → **event timeline** → detail pane. Timeline rows are
SupervisorEvents; expanding a row reveals transcript/tool calls/diff.
Condensed ranges render as a single row labeled `N events condensed —
expand` (journaled `forgotten_event_ids` — compression never hides).
Tier D–E sessions render verified output only; no permission UI.

### 3.5 Fleet/quota panel

Per-provider utilization bar + reset countdown + `denied`/`parked`
markers. This is the _only_ screen where capacity is visualized — it stays
out of the inbox.

### 3.6 Preferences

Learned rules as readable lines: `RULE codex · catch-all — "heavy lifting"`.
Scoped entries carry an `amber` `project:<id>` tag. Every entry shows
provenance in `meta` ("learned from voice · Sep 13"). Edit and revoke are
inline; changes journal through `update-preference`.

Below the learned rules, a **Desktop & voice** card holds app-local
settings — microphone device, dictation language hint, voice-mode
default, stop-daemon-on-quit. These persist to
`~/.florina/desktop-settings.json` via `deskset:` — they are _not_
daemon profile rules, save while offline, and never surface as learned
routing entries.

### 3.7 PTT HUD (floating overlay)

Always-on-top, ~360×72px, radius 10, `panel-raised`, the only shadowed
surface. States:

| State      | Glyph         | Ring                                     |
| ---------- | ------------- | ---------------------------------------- |
| idle       | `mic`         | none — `muted` text "Hold Space to talk" |
| listening  | animated bars | `accent` pulsing ring                    |
| processing | `…`           | `amber` ring                             |
| responding | `▶`           | `green` ring + response preview line     |
| offline    | `mic-off`     | `slate`                                  |

Transcript streams inline (max 2 lines, `meta` for partials). The HUD is
the only surface allowed to interrupt — and only while held/active.

### 3.8 System tray

Status word + 5 actions max (`Start/Stop daemon`, `Open inbox`,
`Show window`, `Quit`). Status mirrors the sidebar dot exactly.

### 3.9 Chat — the central thread

One conversation with the Secretary — no thread list, no sessions to
pick. History is journaled; resume on launch is automatic.

```
┌─ You ────────────────────────────────┐  user: right-aligned, panel-raised
│ ship the rate-limit fix …            │
└──────────────────────────────────────┘
 ▸ list_tasks ok · 5 tasks              tool rows: mono, muted, collapsed by default
┌─ Secretary ──────────────────────────┐  assistant: left, panel + border
│ Codex has headroom — delegated …     │
└──────────────────────────────────────┘
 ● Secretary is working — query_inbox…  working row: amber dot + latest tool
[🎙] [textarea — grows to 140px] [🔊 voice] [Send]
```

- **Composer**: Enter sends, Shift+Enter newline. Mic = dictation
  (Codex-style): live partial transcript previews above the input
  (`accent` left border), final text inserts at the cursor **editable**
  — never auto-sends. `🔊 voice` toggles two-way voice mode (§5).
- **Tool activity** renders as collapsed mono rows between messages —
  progressive disclosure: presence is honest, detail stays in the
  inspector.
- **No optimistic bubbles**: a sent message renders only after the
  journal confirms it (`chat:message`) — same rule as approvals.
- **Actions needed mid-turn** still route to the inbox — chat replies
  never replace attention items.
- `Clear` (header) archives the thread via journaled `chat-clear` —
  confirmation first; history is never destroyed.

## 4. Interaction model

- **Keyboard-first**: `j/k` move selection, `Enter` drills, `Esc` pops,
  `g f/a/w/h/s` jump to views (Florina/Attention/Work/History/Settings —
  remapped from the old 7-item `g c/i/t/f/d/p/s` per issue #219; letters
  now match each view's name rather than preserving the old positions),
  `a` (standalone, not part of a `g` chord) applies the card's primary
  action, the global hotkey (`FLORINA_PTT_HOTKEY`, default Space-hold)
  toggles the PTT HUD.
- **Composer keys** (chat): `Enter` sends, `Shift+Enter` newline; the
  mic button toggles dictation, `🔊 voice` toggles voice mode.
- **Pointer**: single click selects; double/`Enter` drills. Cards show
  hover at `panel-raised` — no other hover effects.
- **Focus**: visible 1px `accent` outline. Everything reachable by keyboard.
- **Empty states**: one line headline + one line help. Never a modal.
- **Errors**: inline in the affected card/panel, `red` text, with the raw
  daemon error copyable. No toast for errors — toasts are confirm-only.
- **Reconnect**: sidebar dot `amber` + "reconnecting"; content stays
  readable (last known state), never blanks.

## 5. Voice ↔ visual contract

- Anything approvable by voice must be confirmable visually with the same
  structured fields (DEC-010) — the approval card is the shared contract.
- Above low-risk scope, voice _stages_ the approval: the card appears in
  the inbox and waits for visual confirm.
- Spoken replies never exceed what fits on two HUD lines; longer answers
  end with "— in the inbox."
- **Dictation ≠ voice mode.** Dictation (default) only fills the composer
  — the user reviews and sends; the model never acts on unreviewed speech.
  Voice mode is an explicit toggle for two-way turns; spoken Secretary
  replies also append to the chat thread so the visual record stays whole.

## 6. Accessibility

- Contrast: all text ≥ 4.5:1 on its surface; chips ≥ 3:1.
- Priority is never color-only: label text + icon accompany every color.
- `prefers-reduced-motion`: HUD ring and listening bars go static.
- All actions have text labels; icon-only buttons are forbidden.
