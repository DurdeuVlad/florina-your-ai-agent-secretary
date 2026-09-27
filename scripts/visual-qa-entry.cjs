/**
 * Visual QA capture entry (issue #133) — runs inside Electron main.
 *
 * Pass 1: loads each docs/mockups/*.html in a hidden window and
 * captures it to shots/mockup-<name>.png at the app's real window
 * geometry, so mockup and app shots compare 1:1.
 *
 * Pass 2: boots the real desktop bootstrap (dist/bootstrap/desktop.js)
 * in-process, waits for the window + first daemon sync, then cycles
 * every view via the same `g`-prefix keyboard nav a user would use
 * (sendInputEvent — no product hooks) and captures shots/app-<view>.png.
 *
 * Usage: node scripts/visual-qa.mjs  (spawns this under Electron)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Any listener suppresses Electron's default quit-on-all-windows-closed;
// without it, destroying the last mockup window kills the process before
// the app pass starts. The desktop bootstrap's own handler still quits
// explicitly when invoked.
app.on('window-all-closed', () => {});

const ROOT = path.resolve(__dirname, '..');
const MOCKUPS = path.join(ROOT, 'docs', 'mockups');
const SHOTS = path.join(ROOT, 'shots');
const WIDTH = 1180;
const HEIGHT = 760;
const SETTLE_MS = 600;
const APP_SETTLE_MS = 3500;

/*
 * Top-level view name -> keys after 'g' (renderer keymap, DG-01 §4,
 * remapped to the 5-item IA by issue #219: docs/UX_GUIDELINES.md §4).
 * fleet/ideas/secretary have no top-level nav entry as of #219/#220 —
 * fleet/ideas are captured below as Work sub-tabs; secretary is
 * captured as the Florina lens via the `g e` chord (issue #262).
 */
const APP_VIEWS = {
  chat: null, // default launch view (#160) — no keys needed
  inbox: 'a',
  tasks: 'w',
  history: 'h',
  prefs: 's',
};

/* Work (tasks) sub-tabs (issue #220) — captured after navigating to
 * 'tasks', via a real DOM click on the tab button (not a product hook —
 * the same event listener a user's click fires). */
const WORK_SUBTABS = ['fleet', 'ideas'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureWindow(win, file) {
  /* capturePage returns the LAST presented frame — a DOM state read can
   * confirm a view switch while the compositor still holds the previous
   * view's paint (esp. when the window is even briefly occluded). Wait
   * two animation frames so the frame we grab reflects current DOM. */
  await win.webContents.executeJavaScript(
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
  );
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
  console.log(`[visual-qa] wrote ${path.relative(ROOT, file)}`);
}

async function shotMockups() {
  const pages = fs.readdirSync(MOCKUPS).filter((f) => f.endsWith('.html') && f !== 'index.html');
  // One reused window — rapid create/destroy races Electron's cache
  // setup on Windows (ERR_FAILED on the second loadFile).
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    webPreferences: { sandbox: true },
  });
  for (const page of pages) {
    await win.loadFile(path.join(MOCKUPS, page));
    await sleep(SETTLE_MS);
    await captureWindow(win, path.join(SHOTS, `mockup-${page.replace('.html', '')}.png`));
  }
  win.destroy();
}

function pressKey(win, key) {
  // Electron 44 validates `keyCode` (not `key`) for keyboard events;
  // keyDown is what the renderer's keydown listener needs.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
}

async function shotApp() {
  // Booting the real bootstrap starts DesktopApp, tray, HUD, hotkeys —
  // exactly what a user sees. It connects to the running daemon (or
  // auto-starts one, #132) and renders real state.
  await import(pathToFileURL(path.join(ROOT, 'dist', 'bootstrap', 'desktop.js')).href);

  // Wait for the main window and its first daemon sync.
  let win = null;
  for (let i = 0; i < 40 && win === null; i += 1) {
    win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Florina') ?? null;
    if (win === null) await sleep(250);
  }
  if (win === null) throw new Error('main Florina window never appeared');
  if (!win.webContents.isLoading()) {
    // already loaded
  } else {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  // An occluded/backgrounded window throttles painting and capturePage
  // can stall — disable throttling and keep the window foregrounded.
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.focus();
  await sleep(APP_SETTLE_MS);

  for (const [view, key] of Object.entries(APP_VIEWS)) {
    if (key !== null) {
      pressKey(win, 'g');
      await sleep(80);
      pressKey(win, key);
      await sleep(SETTLE_MS);
    }
    await captureWindow(win, path.join(SHOTS, `app-${view}.png`));
    console.log(`[visual-qa] captured view ${view}`);
  }

  // Work sub-tabs (issue #220): already on 'tasks' from the loop above
  // (it's the last APP_VIEWS entry before prefs... actually prefs is
  // last, so re-select tasks explicitly before clicking sub-tabs).
  pressKey(win, 'g');
  await sleep(80);
  pressKey(win, 'w');
  await sleep(SETTLE_MS);
  for (const sub of WORK_SUBTABS) {
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-worksub="${sub}"]')?.click()`,
    );
    await sleep(SETTLE_MS);
    await captureWindow(win, path.join(SHOTS, `app-work-${sub}.png`));
    console.log(`[visual-qa] captured Work sub-tab ${sub}`);
  }

  // Settings > Repos (issue #253): scrolled below Routing rules/Memory,
  // so it needs its own capture beyond the top-of-page app-prefs.png.
  // Waits for #reposView to actually have content (the repos:update push
  // is a real daemon round trip, slower than the SETTLE_MS UI-only wait).
  pressKey(win, 'g');
  await sleep(80);
  pressKey(win, 's');
  await sleep(SETTLE_MS);
  for (let i = 0; i < 20; i++) {
    const hasContent = await win.webContents.executeJavaScript(
      `document.getElementById('reposView')?.children.length > 0`,
    );
    if (hasContent) break;
    await sleep(300);
  }
  await win.webContents.executeJavaScript(
    `document.getElementById('reposView')?.scrollIntoView({block: 'start'})`,
  );
  await sleep(SETTLE_MS);
  await captureWindow(win, path.join(SHOTS, 'app-settings-repos.png'));
  console.log('[visual-qa] captured Settings > Repos');

  // Secretary lens (issue #262): reachable via the g e chord inside
  // Florina. Waits for the lens view to be active, captures, then Esc
  // pops back to the thread — the same path a user takes.
  pressKey(win, 'g');
  await sleep(80);
  pressKey(win, 'e');
  await sleep(SETTLE_MS);
  // .content is the shared scroller — the repos scroll above leaves it
  // deep in prefs; reset so the lens captures top-anchored.
  await win.webContents.executeJavaScript(`document.querySelector('.content').scrollTop = 0`);
  await captureWindow(win, path.join(SHOTS, 'app-secretary.png'));
  console.log('[visual-qa] captured Secretary lens');
  pressKey(win, 'Escape');
  await sleep(SETTLE_MS);

  // Send-failure row (issue #263): a genuine daemon rejection through the
  // real command path — a whitespace-only chat-send resolves {ok:false},
  // main mirrors the failure, and chat:update renders the error row.
  // (The offline case needs daemon teardown the harness doesn't own —
  // the state matrix documents it; this proves the row end-to-end.)
  pressKey(win, 'g');
  await sleep(80);
  pressKey(win, 'f');
  await sleep(SETTLE_MS);
  await win.webContents.executeJavaScript(
    `window.florina.command('chatcmd:' + encodeURIComponent(JSON.stringify({kind:'chat-send', text:'   ', clientId:'qa-fail-1'})))`,
  );
  // chat:update is a daemon round trip — wait for the row in the DOM.
  for (let i = 0; i < 20; i++) {
    const rowVisible = await win.webContents.executeJavaScript(
      `document.querySelector('.senderror') !== null`,
    );
    if (rowVisible) break;
    await sleep(250);
  }
  await captureWindow(win, path.join(SHOTS, 'app-chat-senderror.png'));
  console.log('[visual-qa] captured chat send-failure row');

  // Journal-gap card (issue #264): a second WS client sends the real
  // raise-attention command (itemKind 'JournalFailure') to the running
  // daemon; the next inbox refresh pulls it and the real card renders.
  // A Retry-bearing card needs a retained row, which only real insert
  // failures produce — the shot proves the card + acknowledge path;
  // retry wiring is covered by tests/desktop.test.ts.
  const WebSocket = require('ws');
  const os = require('node:os');
  const daemonUrl = process.env.FLORINA_DAEMON_URL ?? 'ws://127.0.0.1:17419';
  const ws = new WebSocket(daemonUrl);
  const raised = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(null), 5000);
    const sendRaise = () => {
      ws.send(
        JSON.stringify({
          kind: 'raise-attention',
          taskId: 'qa-journal-gap',
          summary: 'visual-qa journal gap probe',
          itemKind: 'JournalFailure',
          priority: 'High',
          source: 'visual-qa',
        }),
      );
    };
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        // Auth handshake ack — send the command only after it.
        if (msg !== null && msg.type === 'auth') {
          if (msg.ok === true) sendRaise();
          else resolvePromise(null);
          return;
        }
        // Command responses carry `ok`; pushes carry `type` — skip those.
        if (msg !== null && typeof msg === 'object' && 'ok' in msg) {
          clearTimeout(timer);
          resolvePromise(msg);
        }
      } catch {
        /* non-JSON frame — ignore */
      }
    });
    ws.once('open', () => {
      // Same credential the desktop uses (~/.florina/auth-token); absent
      // file = unauthenticated daemon, commands work straight away.
      let token = process.env.FLORINA_DAEMON_TOKEN;
      if (!token) {
        try {
          token = fs.readFileSync(path.join(os.homedir(), '.florina', 'auth-token'), 'utf8').trim();
        } catch {
          token = undefined;
        }
      }
      if (token) ws.send(JSON.stringify({ type: 'auth', token }));
      else sendRaise();
    });
    ws.once('error', () => resolvePromise(null));
  });
  const raisedId = raised && raised.ok ? raised.itemId : null;
  if (raisedId === null) {
    console.log('[visual-qa] raise-attention did not land — journal-fail shot may be empty');
  }
  // Attention items surface on the next refresh (add publishes no bus
  // event — same as every other kind). `ideaclose` is the real desktop
  // round-trip that re-pulls the inbox tree without mutating anything.
  await win.webContents.executeJavaScript(`window.florina.command('ideaclose')`);
  await sleep(SETTLE_MS);
  // The senderror probe above left focus in the composer — synthesized
  // keypresses land on the input and hit the renderer's focus guard, so
  // navigate via the nav item's real click listener (the same showView
  // call g a reaches, immune to focus quirks). Poll the ACTIVE view:
  // the card DOM lives in a hidden #v-inbox even when another view shows.
  const navState = await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('.navitem[data-view="inbox"]');
      if (!el) return 'nav element missing';
      el.click();
      return document.querySelector('.view.active')?.id ?? 'no active view';
    })()`,
  );
  console.log(`[visual-qa] nav click → ${navState}`);
  for (let i = 0; i < 20; i++) {
    const state = await win.webContents.executeJavaScript(
      `({ id: document.querySelector('.view.active')?.id, hasCard: document.querySelector('.view.active')?.textContent.includes('Journal gap') })`,
    );
    if (state && state.id === 'v-inbox' && state.hasCard) break;
    if (i === 19) console.log(`[visual-qa] WARN inbox state: ${JSON.stringify(state)}`);
    await sleep(250);
  }
  await captureWindow(win, path.join(SHOTS, 'app-inbox-journalfail.png'));
  console.log('[visual-qa] captured journal-failure inbox card');
  // Prove the acknowledge path end-to-end: the renderer's resolve:<id>
  // verb → real resolve-item → post-mutation refresh → card gone.
  if (raisedId !== null) {
    await win.webContents.executeJavaScript(`window.florina.command('resolve:${raisedId}')`);
    let gone = false;
    for (let i = 0; i < 20; i++) {
      const stillVisible = await win.webContents.executeJavaScript(
        `document.querySelector('.view.active')?.textContent.includes('Journal gap')`,
      );
      if (!stillVisible) {
        gone = true;
        break;
      }
      await sleep(250);
    }
    console.log(
      gone
        ? '[visual-qa] journal-failure card resolved via real resolve: verb'
        : '[visual-qa] WARN: card still visible after resolve',
    );
  }
  ws.close();
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    await shotMockups();
    await shotApp();
    console.log('[visual-qa] done — compare shots/app-*.png against shots/mockup-*.png');
  } catch (err) {
    console.error('[visual-qa] failed:', err);
    process.exitCode = 1;
  } finally {
    app.quit();
    /* close-to-tray can veto window close and leave the app running —
     * hard-exit if quit doesn't take within a few seconds. */
    setTimeout(() => app.exit(process.exitCode ?? 0), 5000).unref();
  }
});
