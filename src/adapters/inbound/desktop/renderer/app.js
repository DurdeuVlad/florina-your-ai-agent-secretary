/**
 * Renderer app (issue #119): subscribes to pushed RenderTrees over the
 * preload bridge, mounts them via the tree walker, dispatches string
 * commands back to the daemon, and owns keyboard navigation (DG-01 §4).
 *
 * The page holds no daemon connection of its own — the main process owns
 * the socket and pushes trees/status; commands travel the other way.
 */
import { mount } from './tree-renderer.js';

const $ = (id) => document.getElementById(id);
const bridge = window.florina;

/* ---------- daemon status ---------- */

const STATUS_LABEL = {
  connected: ['on', 'daemon connected'],
  connecting: ['wait', 'connecting…'],
  reconnecting: ['wait', 'reconnecting…'],
  disconnected: ['err', 'daemon disconnected'],
  error: ['err', 'daemon unreachable'],
};

if (bridge) {
  bridge.on('daemon:status', (d) => {
    const [cls, label] = STATUS_LABEL[d.status] || ['err', d.status];
    $('dot').className = 'dot ' + cls;
    $('statusText').textContent = d.error || label;
  });

  bridge.on('inbox:update', (tree) => {
    mount(tree, $('inbox'));
    const n = tree.props && tree.props.needsYou ? tree.props.needsYou : 0;
    const badge = $('navInbox');
    badge.textContent = n;
    badge.className = 'navbadge' + (n ? '' : ' zero');
    sel = -1;
  });

  /* session inspector (#126): main process pushes the 3-column tree */
  bridge.on('inspector:update', (tree) => {
    mount(tree, $('inspector'));
    inspSel = -1;
    markInspSel();
  });

  /* main process can switch views (e.g. Inspect on an approval card) */
  bridge.on('view:show', (name) => {
    if (TITLES[name]) showView(name);
  });

  /* fleet/quota screen (issue #127) */
  bridge.on('fleet:update', (tree) => mount(tree, $('fleet')));

  /* PTT pill in the header — same states as the old overlay (issue #123) */
  bridge.on('hud:state', renderHud);
}

/* ---------- HUD pill (merged into the header; was the overlay window) ---------- */

const BARS = '<span class="bars"><i></i><i></i><i></i><i></i></span>';

function renderHud(s) {
  const hud = $('hud');
  const ring = $('ring');
  const title = $('hudTitle');
  const sub = $('hudSub');
  if (!hud) return;

  hud.classList.remove('listening', 'processing', 'responding');
  ring.style.borderColor = '';
  ring.style.color = '';

  if (s.voiceMode === 'offline') {
    ring.textContent = '⌀';
    ring.style.borderColor = 'var(--slate)';
    ring.style.color = 'var(--slate)';
    title.textContent = 'Daemon unreachable';
    sub.textContent = 'start it with florina start';
    return;
  }
  if (s.isListening) {
    hud.classList.add('listening');
    ring.innerHTML = BARS;
    title.textContent = 'Listening…';
    sub.textContent = s.currentTranscript || '';
    return;
  }
  if (s.isProcessing) {
    hud.classList.add('processing');
    ring.textContent = '…';
    title.textContent = 'Thinking';
    sub.textContent = s.currentTranscript || 'routing to Florina loop';
    return;
  }
  if (s.isResponding) {
    hud.classList.add('responding');
    ring.textContent = '▶';
    title.textContent = 'Done.';
    sub.textContent = s.responsePreview || '';
    return;
  }
  // idle
  ring.textContent = '🎙';
  title.textContent = s.hotkeyHint || 'Hold Space to talk';
  sub.textContent = 'or click — daemon connected';
}

/* ---------- command dispatch ---------- */

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-command]');
  if (!btn || !bridge) return;
  void bridge.command(btn.dataset.command).then((res) => {
    if (res && res.ok === false) toast(res.error || 'command failed');
  });
});

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 4000);
}

/* ---------- view navigation ---------- */

const TITLES = {
  inbox: ['Attention Inbox', 'what needs you right now'],
  tasks: ['Tasks', 'delegated work and its state'],
  fleet: ['Fleet', 'provider capacity and routing'],
  prefs: ['Preferences', 'durable routing rules and denies'],
};

let currentView = 'inbox';

function showView(name) {
  currentView = name;
  document
    .querySelectorAll('.navitem')
    .forEach((x) => x.classList.toggle('active', x.dataset.view === name));
  document
    .querySelectorAll('.view')
    .forEach((x) => x.classList.toggle('active', x.id === 'v-' + name));
  $('viewTitle').textContent = TITLES[name][0];
  $('viewSub').textContent = TITLES[name][1];
}

document
  .querySelectorAll('.navitem')
  .forEach((n) => n.addEventListener('click', () => showView(n.dataset.view)));

/* ---------- keyboard nav (DG-01 §4) ---------- */

let sel = -1;
let gPending = false;
/* inspector column focus (#126): 0 tasks, 1 timeline, 2 detail */
let inspCol = 0;
let inspSel = -1;

function cards() {
  return [...document.querySelectorAll('.view.active [data-selectable]')];
}

function moveSel(d) {
  const list = cards();
  if (!list.length) return;
  sel = Math.max(0, Math.min(list.length - 1, sel + d));
  list.forEach((c, i) => c.classList.toggle('sel', i === sel));
  list[sel].scrollIntoView({ block: 'nearest' });
}

/* inspector keyboard model: h/l pick a column, j/k move inside it */
function inspCols() {
  return [...document.querySelectorAll('#inspector .col')];
}

function inspRows() {
  const col = inspCols()[inspCol];
  return col ? [...col.querySelectorAll('.row[data-selectable]')] : [];
}

function markInspSel() {
  inspCols().forEach((c, i) => c.classList.toggle('colfocus', i === inspCol));
  inspRows().forEach((r, i) => r.classList.toggle('kbsel', i === inspSel));
  const rows = inspRows();
  if (inspSel >= 0 && rows[inspSel]) rows[inspSel].scrollIntoView({ block: 'nearest' });
}

function inspMoveCol(d) {
  inspCol = Math.max(0, Math.min(inspCols().length - 1, inspCol + d));
  inspSel = -1;
  markInspSel();
}

function inspMoveRow(d) {
  const rows = inspRows();
  if (!rows.length) return;
  inspSel = Math.max(0, Math.min(rows.length - 1, inspSel + d));
  markInspSel();
}

function inspActivate() {
  const row = inspRows()[inspSel];
  if (row && row.dataset.command && bridge) {
    void bridge.command(row.dataset.command).then((res) => {
      if (res && res.ok === false) toast(res.error || 'command failed');
    });
  }
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (gPending) {
    gPending = false;
    const map = { i: 'inbox', t: 'tasks', f: 'fleet', p: 'prefs' };
    if (map[e.key]) showView(map[e.key]);
    return;
  }
  switch (e.key) {
    case 'j':
      if (currentView === 'tasks') inspMoveRow(1);
      else moveSel(1);
      break;
    case 'k':
      if (currentView === 'tasks') inspMoveRow(-1);
      else moveSel(-1);
      break;
    case 'h':
      if (currentView === 'tasks') inspMoveCol(-1);
      break;
    case 'l':
      if (currentView === 'tasks') inspMoveCol(1);
      break;
    case 'Enter': {
      if (currentView === 'tasks') {
        inspActivate();
        break;
      }
      const c = cards()[sel];
      const primary = c && c.querySelector('button:not(.ghost):not(.danger)');
      if (primary) primary.click();
      else if (c && c.dataset.command && bridge) {
        /* selectable rows (e.g. task rows) activate their command */
        void bridge.command(c.dataset.command);
      }
      break;
    }
    case 'Escape':
      if (currentView === 'tasks') {
        /* inspector → back to inbox (DG-01 §4) */
        showView('inbox');
        break;
      }
      sel = -1;
      cards().forEach((c) => c.classList.remove('sel'));
      break;
    case 'g':
      gPending = true;
      break;
  }
});
