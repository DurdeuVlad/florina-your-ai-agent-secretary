# Installing Florina

This guide is for the person who will run Florina on their own machine — the
same person who will use it day to day. It assumes no prior knowledge of
Florina, coding-agent tooling, or command-line setup.

Supported platforms: **Windows** and **Linux**.

## Before you start

Florina is an attention broker: it watches the coding tools you already use —
for example Claude Code, Codex, or Gemini CLI — and turns their activity into
one inbox of tasks, decisions, and results. Throughout this guide those tools
are called **coding apps**.

Florina does **not** install coding apps for you, and it does not sign you in
to them. Before Florina can do useful work you need:

1. **At least one supported coding app, installed and signed in** on this
   machine. Install and sign in using that app's own installer or
   instructions. Florina can detect which supported apps are present, but it
   cannot create accounts, store your provider credentials, or sign in on
   your behalf. If an app asks you to sign in, do it in that app's own window
   or terminal, then come back to Florina.
2. **Git**, if you plan to let Florina work on a project folder. Florina
   creates a separate working copy so your files stay untouched.
3. For the source path only: **Node.js 22 or newer** and a C/C++ build
   toolchain (`python3`, `make`, `g++`) — one dependency compiles from source
   on machines without a prebuilt binary.

If none of this is set up yet, that is fine — install Florina anyway. It will
tell you what is missing and what to do next.

## Choose how to install

There are two ways to run Florina. Pick the row that matches you:

| If you…                                 | Use                                             |
| --------------------------------------- | ----------------------------------------------- |
| …just want to use Florina               | **Packaged app** — a normal application install |
| …want to build or change Florina itself | **Run from source** — requires Node.js          |

### Path A — packaged desktop app

1. Download the installer for your platform from the project's
   [GitHub Releases](https://github.com/DurdeuVlad/agent-secretary/releases)
   page:
   - **Windows:** the `.exe` (NSIS) installer
   - **Linux:** the `.AppImage`
2. Run it like any other application installer.
3. Launch Florina. The app starts the local background service it needs by
   itself — no terminal window is required.

### Path B — run from source

```bash
npm install
npm run build

# Terminal 1 — start the daemon (blocks until stopped)
florina start

# Terminal 2 — launch the desktop app
npm run desktop
```

The **daemon** is Florina's local background service; the desktop app talks to
it at `ws://127.0.0.1:17419`. The packaged app starts it automatically — from
source you run it yourself in its own terminal.

## After you open Florina

Whichever path you chose, Florina checks which supported coding apps are
installed on this machine when it starts. You can see what it found in
**Settings**, and choose which folder it may look in for your projects.

Two things worth knowing going in:

- **Detection is not sign-in.** Florina can tell whether a coding app is
  installed, but only the app itself knows whether you are signed in. If
  Florina reports that an app needs attention, open that app once, finish its
  own sign-in, then return to Florina.
- **Florina never asks for your credentials.** It does not store or transfer
  provider logins; sign-in always happens inside the coding app's own window.
- **A folder is a search boundary, not a promise.** Choosing a folder lets
  Florina look for projects inside it — it does not guarantee a project is
  there, and Florina will not look outside the folders you choose.

Campaign context and acceptance criteria: see
[`UX_ONBOARDING_CAMPAIGN.md`](UX_ONBOARDING_CAMPAIGN.md) and
[`UX_ONBOARDING_AUDIT.md`](UX_ONBOARDING_AUDIT.md).
