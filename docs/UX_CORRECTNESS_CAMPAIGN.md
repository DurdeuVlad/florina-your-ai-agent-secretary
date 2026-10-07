# UX Correctness Campaign

**Status:** in flight — milestone **UX Correctness Pass** and issues
created on `DurdeuVlad/florina-your-ai-agent-secretary`; #331 (PR #335),
#332 (PR #336), #333 (PR #337) merged; #334 in progress.

**Source:** live findings from the 2026-10-07 evidence run catalogued in
[`UX_ISSUE_CATALOGUE.md`](UX_ISSUE_CATALOGUE.md) (v0.3.0, real daemon,
`npm run visual-qa`).

## Goal / System / Constraints / Evaluation

- **Goal:** The desktop UI honors its own readability contract, the PTT
  hotkey is recoverable in-app, the bottom-edge paint artifact is gone,
  and visual-qa covers the first-run state so onboarding surfaces cannot
  regress silently.
- **System:** Four independently executable issues; no dependency
  ordering required. Suggested order if sequencing is wanted: 1 → 3 →
  2 → 4.
- **Constraints:** Renderer is sandboxed (strict CSP, whitelisted IPC —
  see `index.html` CSP meta and `preload.cjs`). The honesty contract
  holds: failures surface, never get masked. The visual-qa fixture must
  never read or write the real `~/.florina`. No external records without
  authority.
- **Evaluation:** Each issue carries finite acceptance criteria with an
  observable pass signal. Campaign proof = all four merged plus a clean
  post-fix visual-qa run recorded in the catalogue.

## Sequencing note

Land before the #279 usability pilot sessions so participants hit the
fixed UI; #279 itself stays open and out of scope here.

## Issue 1 — Chat, errors, and journal text are selectable and copyable

- **Labels:** `ux`, `desktop`, `bug` · **Type:** bug
- **Intent:** Every message, error row, and journal entry is uncopyable —
  `body { -webkit-user-select: none }` (`index.html:15`) has zero content
  re-enables and no app-level context/Edit menu exists (only the tray
  menu). This violates DG-01's "raw daemon error readable/copyable"
  requirement (`desktop-app.ts:815-816`, `UX_GUIDELINES.md:270`). Flagged
  as the highest-value open gap in the catalogue.
- **Expectation:** Users can select and copy text from chat messages,
  error rows, inbox cards, history/journal rows, and settings content.
  Interactive chrome (nav items, buttons, HUD pill) stays unselectable
  where selection would fight click targets. Copy works via keyboard and
  an explicit affordance.
- **Acceptance criteria:**
  - Drag-select + Ctrl/Cmd+C copies text from a chat message, a
    send-error row, an inbox card body, and a history journal row.
  - A right-click context menu (or Edit menu) offers Copy on selectable
    content — required for Cmd+C in packaged macOS builds, where an Edit
    role menu is needed.
  - Nav items, buttons, sub-tabs, and the PTT pill remain click-first
    (no accidental text selection during normal use).
  - Inputs and textareas remain editable/selectable.
  - The context menu exposes only safe items (Copy; no Inspect/Reload in
    production).
- **Context code cannot infer:** DG-01 is the governing design contract;
  the global `none` overshot its intent — no design doc endorses
  uncopyable text.
- **Scope:** `renderer/index.html` CSS; optionally
  `bootstrap/desktop.ts` (Electron `Menu`) or `renderer/app.js`
  (`contextmenu` listener). No daemon/CLI changes. Unassigned.
- **Non-goals:** clipboard history, copy-as-markdown, selection inside
  the HUD window.
- **Verification:** assert computed `user-select` on
  `.msg`/`.senderror`/card bodies via a desktop test or a visual-qa DOM
  check; manual copy check in a packaged build on macOS if available;
  `npm test` + `npm run lint` green.

## Issue 2 — Recover from a global-PTT-hotkey conflict inside Settings

- **Labels:** `ux`, `desktop`, `enhancement` · **Type:** enhancement
- **Intent:** When `globalShortcut.register` fails, PTT is dead until the
  user edits env vars — a developer-only remediation for an end-user
  feature. The catalogue shows the conflict notification firing on every
  shot. The blocker noted in code ("env until #128 lands the preferences
  editor", `bootstrap/desktop.ts:375`) is resolved: the Settings
  "Desktop & voice" card and `deskset:` persistence shipped (#128, #163).
- **Expectation:** A hotkey conflict still surfaces honestly, and the
  user can rebind the accelerator in Settings; registration retries
  without an app restart.
- **Acceptance criteria:**
  - Settings > Desktop & voice gains a PTT-hotkey field
    (capture-then-confirm UX), persisted to `desktop-settings.json` via
    `deskset:`.
  - A saved hotkey re-registers the global shortcut without restart; a
    failed rebind names the conflicting accelerator inline and keeps any
    previously working registration.
  - `FLORINA_PTT_HOTKEY` still works; precedence (env override vs saved
    setting) is defined in the PR and surfaced in the UI hint.
  - The conflict hint in the HUD pill points at Settings, not only the
    env var.
- **Context code cannot infer:** `ElectronKeyboardBackend.register`
  returns the OS boolean — never claim a binding that did not register.
- **Scope:** `bootstrap/desktop.ts` (register/re-register path),
  `desktop-settings.ts` schema (`pttHotkey`), prefs view card,
  `hotkeys.ts`. Unassigned.
- **Non-goals:** multiple hotkeys, per-action rebinding beyond PTT,
  auto-detecting the conflicting application.
- **Dependencies:** none. **Open decision (implementer-owned):**
  accelerator capture UX — record-the-combo vs free text; must be
  keyboard-operable.
- **Verification:** unit test for schema + re-register path; live check —
  register a conflicting accelerator, rebind in Settings, confirm PTT
  fires; visual-qa unchanged.

## Issue 3 — Remove the pale strip artifact at the window's bottom edge

- **Labels:** `ux`, `desktop`, `bug` · **Type:** bug
- **Intent:** A thin pale horizontal strip renders at the bottom edge on
  `app-tasks`, `app-history`, `app-prefs`, `app-work-fleet`,
  `app-work-ideas`, `app-settings-repos` (`shots/`). It visibly breaks
  the dark-surface illusion on most screens — a craft-bar defect under
  DG-01.
- **Expectation:** No unexplained strip at the window's bottom edge on
  any view, at standard and at least one non-standard window size.
- **Acceptance criteria:**
  - Root cause identified and named in the PR body (hypothesis:
    `.content` overflow/scrollbar-gutter interaction with the `100vh`
    shell, or sub-pixel rounding — verify, do not assume).
  - Strip absent on all six affected views in a fresh visual-qa run.
  - No regression to `.statusline`, `.content` scrolling, or the
    3-column inspector layout.
- **Scope:** `tokens.css` / `index.html` CSS expected; if the artifact is
  compositor-level, document it and pick the minimal fix. Unassigned.
- **Non-goals:** redesigning the statusline or scrollbar theming.
- **Verification:** before/after `app-*.png` diff; resize smoke check.

## Issue 4 — Visual-qa captures the first-run setup card (fresh-profile fixture)

- **Labels:** `ux`, `testing` · **Type:** testing/tooling
- **Intent:** #277's guided setup card has never been captured — it only
  renders when `onboardingState` is `open`/`skipped`, which never happens
  on a configured machine. The parity pass (#133) silently cannot guard
  the onboarding surface; the same gap class left #122 (reconnect),
  #278 (empty-chat guidance), and #218/#260 (idle catch-up) unexercised.
- **Expectation:** `npm run visual-qa` deterministically produces
  `app-setup-*.png` shots of the first-run card by booting against a
  throwaway profile (temp `HOME`/`USERPROFILE`, or a `FLORINA_*` dir
  override so `desktop-settings.json` is absent → `onboardingState`
  defaults to `open`).
- **Acceptance criteria:**
  - `app-setup-welcome.png` captured every run; at least one non-welcome
    step captured if reachable without side effects.
  - The fixture never reads or writes the real `~/.florina` (log/assert
    the temp path).
  - Run stays hermetic: temp dir removed, no daemon state mutated.
  - `docs/VISUAL_QA.md` documents the fixture and how to add further
    state-matrix captures.
- **Scope:** `scripts/visual-qa-entry.cjs`; possibly a dir-override env
  wired in bootstrap (`desktopSettingsPath(dir)` already accepts a dir).
  Unassigned.
- **Non-goals:** a fully unconfigured _daemon_ fixture (larger —
  follow-up); reconnect-state capture (#122) — next candidate for the
  same pattern.
- **Dependencies:** none. **Open decision (implementer-owned):**
  temp-HOME vs explicit dir-override env; document the choice.
- **Verification:** run output lists the new shots; deleting and
  re-running reproduces them.

## PR contract (all issues)

Every PR body must carry, even when it links the issue:

1. **Intent** — why this change exists and who benefits.
2. **Expectation** — what is now observably true.
3. **Acceptance criteria** — each criterion with evidence or status.
4. **Non-code context** — DG-01 references, why-now.
5. **Scope & non-goals** — what changed and what deliberately did not.
6. **Verification & risk** — commands run, before/after shots,
   unsupported checks.

Use `None` / `Not applicable` / `Unknown—blocked` explicitly; a linked
issue does not substitute.

## Unresolved decisions

- **Handoff target:** creating the GitHub milestone + issues is an
  external action awaiting explicit authorization; until then this doc
  is the draft of record.
- Each issue's implementer-owned open decisions are marked inline.
