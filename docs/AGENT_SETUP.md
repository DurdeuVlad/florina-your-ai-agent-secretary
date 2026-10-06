# Agent Setup Recipe — install and verify Florina end-to-end

**Audience:** an external coding agent (Claude Code, Codex, Cursor, …)
executing commands on the user's machine. This document is a recipe, not an
explanation — every step names the exact command, the expected output shape,
the exit-code contract, and the failure signal. Experience contract:
[`UX_AGENT_SETUP.md`](UX_AGENT_SETUP.md).

**What "done" means:** `florina status --json` exits 0 and its facts show a
running daemon, at least one `signed-in` provider, and at least one watched
folder — then the human opens the desktop app and sees the same facts. The
chat model (`chatModel`) is required only for in-app chat/voice; if the
human has no OpenAI-compatible endpoint, `unconfigured` with the reason
reported is a legitimate end state.

## Rules of engagement

1. **Typed verbs are the only interface.** Never edit files under
   `~/.florina/`, never edit configs to change Florina's behavior, never
   work around a verb. If a verb can't do it, hand the task to the human
   (DEC-011: scope never widens silently). One documented exception: the
   chat-model connector is configured by `FLORINA_LITELLM_URL` /
   `FLORINA_MODEL` env vars at daemon start — see step 4c; that is the
   product's configuration mechanism, not a workaround.
2. **JSON is truth, prose is for humans.** Parse `--json` output only;
   `auth` and `install` have no `--json` — relay their printed text
   verbatim instead. On failure, JSON `{"error":…}` is printed to
   **stderr**, not stdout — parse whichever stream is non-empty. `null`
   means "couldn't check" — it is not an empty list. Never report a `null`
   field as verified or as empty.
3. **Ask the human for exactly three things:** sign-ins, secrets, and the
   folder choice. Everything else is yours to run. Each hand-off below says
   what to tell the human verbatim.
4. **Never handle a secret value.** Do not echo, log, transcript, or pass a
   key through your context — and never run `florina keys set` yourself:
   on a terminal it prompts the human without echo, and on a pipe it reads
   **all of stdin** to EOF, so a piped key both leaks into your transcript
   and can hang on an open pipe. It is the human's command to run, not
   yours.
5. **`florina start` always means `florina start --detach` for you.** Bare
   `florina start` blocks forever; Florina's own error text ("start it
   first (`florina start`)", "Try 'florina start'") names the blocking
   form — that advice is written for humans at a terminal, not for you.
6. **Bounded retries.** Any step may be retried at most twice. Then stop
   and hand the human the exact verb and the exact error output — do not
   paraphrase the failure away.
7. **Report facts verbatim.** Your final summary quotes `status --json`
   fields. Never write "should be working" — either the JSON shows it or
   you don't claim it.

Audit truth: commands you run go through the same consent surface a human's
clicks would — nothing bypasses it — but they are **not** journaled as
individual history entries. Only secret operations leave a dedicated
machine-readable audit ledger at `~/.florina/secrets.audit.jsonl`.
The daemon log (`daemon.log`) records process output, not a per-verb audit
trail.

## Step 0 — prerequisites

Florina from source needs **Node.js >= 22** and **git**.

```bash
node --version    # must print v22.x.x or newer
git --version     # must print a version
npm --version     # bundled with Node
```

Also needed: a C/C++ toolchain (`python3`, `make`, `g++`) — the `better-sqlite3`
dependency compiles from source when no prebuilt binary matches the platform.
Check on Linux:

```bash
command -v python3 make g++   # all three should print paths
```

On Windows, the prebuilt binary usually applies; if `npm install` fails with a
build error, that's the missing piece — hand the human: "install Visual Studio
Build Tools (Desktop development with C++), then retry."

**Failure signal:** any missing or too-old tool → stop. Report which check
failed and its output. Do not attempt to install Node or git yourself unless
the user explicitly asked.

## Step 1 — install from source

The recipe path is the source build. (A packaged desktop app exists but is
for humans installing by hand — not this recipe.)

```bash
git clone https://github.com/DurdeuVlad/agent-secretary.git
cd agent-secretary
npm install       # exit 0; may take several minutes — postinstall also
                  # downloads the Electron binary (~100 MB); a proxied or
                  # flaky network can fail the install outright
npm run build     # exit 0; produces dist/
```

After the build, invoke the CLI as `node dist/cli/index.js <verb>` from the
repo root. Every command below shows `florina` for readability; substitute
`node dist/cli/index.js` unless you ran `npm link` (optional — it puts
`florina`/`flor` on PATH globally).

Verify:

```bash
florina version   # exit 0, prints a version
```

**Failure signals:** `npm install`/`npm run build` non-zero → capture the
tail of the output, retry once, then hand it to the human verbatim.

## Step 2 — start the daemon

```bash
florina start --detach
```

Expected: `Daemon started in the background (pid <N>). Log: <dir>/daemon.log`
and exit 0. Machine form:

```bash
florina start --detach --json
# → {"started":true,"detached":true,"pid":<N>,"logFile":"<dir>/daemon.log"}
```

The command returns only after the daemon is actually up — a `{started:true}`
(or exit 0) means the child wrote its own PID file after binding its port.
Daemon output goes to the log file named in the output; read it when
diagnosing.

Do **not** run bare `florina start` — it blocks the terminal forever and will
wedge you. `--detach` is the only supported non-blocking form. `--json` is
valid only together with `--detach`.

**Failure signals:**

- non-zero exit with `{"error":...}` or a plain error line → read the log
  file named in output (or `~/.florina/daemon.log`), retry once, then hand
  the human the error verbatim.
- "already running" class errors → the daemon is up; move to step 3.

## Step 3 — read the truth

```bash
florina status --json
```

**Exit contract:** exit 0 = the daemon answered — facts delivered, whatever
they say. Non-zero = the answer could not be obtained; the JSON (on
**stderr**) carries `"error":"<reason>"`:

- `{"daemon":{"running":false,...},"error":"daemon-not-running"}` — start it.
- `{"error":"daemon-unreachable","detail":[...]}` — a process is alive but
  answered nothing; `detail` names the underlying errors (protocol dead,
  wrong build). Retry once, then `florina stop` + `start --detach` once,
  then hand the output to the human.

Note `status --json` is not a cheap read — each call can re-probe provider
CLIs (up to ~10s worst case). Poll at ~15s cadence, never in a tight loop.

Shape (all fields observed on a real daemon):

```json
{
  "cliVersion": "0.0.1",
  "daemon": { "running": true, "port": 17419, "pid": 166260 },
  "providersChecked": true,
  "providersProbed": true,
  "providers": [
    {
      "id": "cursor",
      "found": true,
      "auth": "found-not-signed-in",
      "fix": {
        "kind": "run-command",
        "label": "Sign in to Cursor",
        "command": "cursor-agent login",
        "detail": "…"
      }
    }
  ],
  "chatModel": { "configured": true, "keySource": "env", "state": "unknown" },
  "reposChecked": true,
  "roots": [],
  "repos": []
}
```

Field semantics you must honor:

- `providersChecked`/`reposChecked`: `false` → that section was never
  queried (its field is `null`); treat it as unknown, not healthy.
- `providersProbed`: `false` → the daemon couldn't probe; `providers` is
  then `[]` (not `null`). Report "couldn't check," never "none installed."
- `providers` itself is `null` only when the query itself failed —
  `providersChecked:false` is your signal for that.
- `providers[]` entries:
  - `found: false` → CLI not installed. `installable: true` means
    `florina install <id>` has a verified installer on this OS.
  - `auth`: `signed-in` | `found-not-signed-in` | `auth-failing` | `unknown`.
    Only `signed-in` counts as ready. `unknown` means no credential evidence
    exists on disk for Florina to check — sign-in can happen but a re-check
    may never flip to `signed-in`; don't loop waiting for it, report
    `unknown` as the state.
  - `fix` tells you the remediation class: `run-command` →
    `florina auth <id>` opens it; `store-key`/`set-env` → a human key/config
    step.
- `chatModel.state`: `ok` | `auth-failing` | `misconfigured` | `unreachable`
  | `unknown` | `unconfigured`. `unknown` means untested (key may exist) —
  report it as untested, not broken. `unconfigured`/`misconfigured` → the
  human needs `florina keys set` or the env var.
- `roots`/`repos`: watched folders and discovered projects; `null` = unknown.

## Step 4 — close provider gaps (designed hand-offs)

For each provider in `providers` that isn't `signed-in`, in order:

**4a. `found: false` and `installable: true`** — run:

```bash
florina install <id>
```

This opens a **visible terminal** running the official installer and returns
immediately — it does not wait for the install to finish. These verbs have
**no `--json`** (a `--json` flag is silently ignored — you get prose at
exit 0), so read the printed text itself: **every** "no window opened"
response ends with ``run `<command>` yourself`` or ``run `<command>` in a
terminal`` — relay that command to the human verbatim and mark it a
hand-off. Only when the printed text ends differently did a window really
open.

If `installable` is absent on a `found:false` provider there is no verified
installer for this OS — don't run `install`; tell the human to install it
with the provider's own instructions, then re-check.

After launching, tell the human:

> "A terminal window opened to install `<id>`. Complete it there; I'll
> re-check when you're done."

Then poll `florina status --json` every ~15s for up to ~5 minutes until
`found: true`. If the window lapses, ask the human once whether they
finished; if not, mark the provider unresolved and move on — do not loop
forever.

**4b. `found: true`, `auth` ≠ `signed-in`** — run:

```bash
florina auth <id>
```

For `run-command` fixes this opens a visible terminal with the provider's own
sign-in flow (browser/device-code) and returns immediately. **Apply 4a's
detection rule here too** — printed text ending in ``run `<command>`
yourself`` / `in a terminal` means no window opened; relay it to the
human instead of claiming one did. Otherwise tell the human a window opened
for `<id>`, poll `status --json` up to ~5 minutes for `signed-in` — but see
the `unknown` note in step 3; an `unknown` auth may never flip, so report
the state rather than waiting forever. `auth` may also return instructional
text (`store-key`/`set-env` fixes) — relay it verbatim as a human step. A
printed "already looked healthy" line means sign-in still ran; fine.

**4c. The chat model (optional — in-app chat/voice only).**
`chatModel.configured` is true only when the daemon was started with both
`FLORINA_LITELLM_URL` and `FLORINA_MODEL` in its environment — `keys set`
alone can never make it true (it only flips `keySource` to `vault`). If
`configured: false`, ask the human:

> "Florina's in-app chat/voice needs an OpenAI-compatible endpoint. Do you
> have one? If so, give me the base URL and model name." (The attention
> broker works without it — skipping is legitimate.)

If they provide values, restart the daemon with them set — the detached
child inherits your shell env:

```bash
florina stop
# Linux / macOS / Git Bash:
FLORINA_LITELLM_URL=<url> FLORINA_MODEL=<model> florina start --detach
# Windows PowerShell:
$env:FLORINA_LITELLM_URL='<url>'; $env:FLORINA_MODEL='<model>'; florina start --detach
# Windows cmd (quotes keep a trailing space out of the value):
set "FLORINA_LITELLM_URL=<url>" && set "FLORINA_MODEL=<model>" && florina start --detach
```

Persisting env vars across the _human's_ sessions (shell profile, app
launch env) is their platform choice — say so; the env vars live only in
that daemon process, and the next plain `florina start` (or the app's
auto-start) won't have them.

Then the key — never run `florina keys set` yourself (rule 4). Tell the
human verbatim:

> "Run `florina keys set openai-api-key` in a terminal — it prompts without
> echoing — or use Settings → API keys in the app."

Then poll `status --json` at 15s cadence for up to ~5 minutes until
`chatModel.configured: true` and `keySource` is `vault` (or `env` if the
_human_ set `FLORINA_LITELLM_KEY` in their own session — never put a key
on the `start` line yourself; that's a secret in your transcript).
`state: 'unknown'` after that means "key present, untested" — report it
as such; the first real turn decides.

`florina auth chat` prints the daemon's own remediation text for all of
this — if your summary ever disagrees with it, relay its text instead.

**4d. Skips are legitimate.** The user may decline a provider. Record it as
"skipped by user," move on — the goal is an honest picture, not full coverage.

## Step 5 — the project folder (ask once, use their words)

**Ask the user:** "Which folder should Florina watch for your projects?
Give me the full absolute path." Use exactly what they name — but require
an **absolute** path: `repos add` resolves relative paths against _your_
working directory and does **not** expand `~`, so a human-typed `projects`
or `~/code` silently watches the wrong place or fails confusingly. If they
answer with a relative/`~` path, ask once for the absolute form. Never
guess, never scan for likely folders, never add broad roots (home
directory, drive root) — the folder is the search boundary (DEC-011).

```bash
florina repos add "<their absolute path>" --json
# → {"added":"<path>","roots":[{"path":"<path>"}],"repos":[…],"discovered":<n>}
```

`added` echoes the _normalized_ path (resolved/canonicalized) — compare
against the human's intent, not their keystrokes. `repos` = discovered
projects under the root; `discovered: null` plus a `warning` field means
the follow-up re-query failed — say "folder watched, discovery unknown,"
don't claim zero.

**Failure signals:** path doesn't exist / isn't a directory → exit 1 with
`{"error":...}` — ask the human to re-check the path; do not retry with a
different folder on your own. Non-TTY note: `repos remove` requires `--yes`;
`repos list --json` shows current roots.

## Step 6 — verify and report

Run the final check:

```bash
florina status --json
```

Exit 0 is required. Then report to the human, quoting fields verbatim:

- `daemon.running`, `daemon.pid`
- per provider: `id` → `auth` (and `found` when false)
- `chatModel.state` / `configured` / `keySource`
- `roots` and `repos` count

End with:

> "Open Florina — the setup card in the app shows these same facts. If the
> app disagrees with what I reported, the app is right."

Never summarize beyond what the JSON shows. Unresolved providers/folders
stay listed as unresolved — a partial honest setup beats a falsely complete
one.

## Failure semantics quick table

| Step             | Failure signal                                                         | Action                                                             |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Prereqs          | missing/old `node`/`git`                                               | Stop; name the check + output                                      |
| Install          | `npm install`/`build` non-zero                                         | Retry once → hand output verbatim                                  |
| Start            | `start --detach` non-zero                                              | Read the log file → retry once → hand error verbatim               |
| Status           | non-zero, `error` field                                                | Daemon down → `start --detach`; else hand verbatim                 |
| Install provider | printed text ends `run \`…\` yourself`/`in a terminal`                 | No window opened — relay the printed command to the human          |
| Install provider | `already installed … run florina auth <id>` (exit 1)                   | Not an error — the probe raced; go to 4b                           |
| Install provider | no `installable` flag on `found:false`                                 | No verified installer — relay the provider's own docs to the human |
| Mid-recipe       | output says "start it first (`florina start`)" / "Try 'florina start'" | They mean `florina start --detach` — never the bare blocking form  |
| Auth             | still not `signed-in` after window                                     | Ask human once; else mark unresolved                               |
| Secrets          | —                                                                      | Always a human step; never agent-run                               |
| Folder           | exit 1 `{"error":…}`                                                   | Ask human to re-check the path                                     |
| Verify           | exit non-zero                                                          | Hand the whole `status` output to the human                        |

## Stopping

`florina stop` stops the daemon (exit 0 when it was running; exit 1
`Daemon is not running.` when it wasn't — treat that as already-stopped,
not a failure). Leave it running when setup succeeds — the human opens the
app against it.
