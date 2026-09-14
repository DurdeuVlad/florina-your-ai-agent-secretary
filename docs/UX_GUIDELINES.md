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

| Token          | Hex       | Use                                      |
| -------------- | --------- | ---------------------------------------- |
| `bg`           | `#0f1115` | app background                           |
| `surface`      | `#14171d` | sidebar, chrome                          |
| `panel`        | `#1a1e27` | cards                                    |
| `panel-raised` | `#20252f` | hovered/active card, popovers            |
| `border`       | `#2a3040` | hairlines only — never decorative boxes  |
| `text`         | `#e8ebf0` | primary copy                             |
| `muted`        | `#8a93a6` | metadata, timestamps, secondary copy     |
| `accent`       | `#6e9eff` | links, focused items, primary buttons    |
| `green`        | `#4cc38a` | verified, connected, completed-ok        |
| `amber`        | `#e0a84f` | approval required, parked, elevated risk |
| `red`          | `#f06060` | critical, failed, sandbox violation      |
| `orange`       | `#e07a4f` | degraded context, dirty worktree         |
| `purple`       | `#b08cff` | digests, reviewed/accepted               |
| `slate`        | `#8a93a6` | idle/stale — intentionally quiet         |

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
- Radius: `6` controls, `8` chips, `10` cards/popovers, `50%` status dots.
- No drop shadows except the PTT HUD (floating overlay) and popovers.
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

- **Sidebar**: nav (Chat, Inbox w/ count badge, Tasks, Fleet, Ideas,
  Preferences, Secretary) + daemon status footer (dot + one word). Never
  shows project pickers or filters — the inbox decides what matters.
- **Chat is the launch view** — the single Secretary conversation is the
  product's center; inbox/fleet/etc. are support surfaces.
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
  `g c/i/t/f/d/p/s` jump to views, `a` applies the card's primary action,
  `Space` (global) = push-to-talk dictation.
- **Composer keys** (chat): `Enter` sends, `Shift+Enter` newline, mic
  button or `Ctrl+Space` toggles dictation.
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
