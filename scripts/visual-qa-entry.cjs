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
 * fleet/ideas are captured below as Work sub-tabs instead; secretary has
 * no capture until a future issue merges it into Florina.
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
  }
});
