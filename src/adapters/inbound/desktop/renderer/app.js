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

function showView(name) {
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
      moveSel(1);
      break;
    case 'k':
      moveSel(-1);
      break;
    case 'Enter': {
      const c = cards()[sel];
      const primary = c && c.querySelector('button:not(.ghost):not(.danger)');
      if (primary) primary.click();
      break;
    }
    case 'Escape':
      sel = -1;
      cards().forEach((c) => c.classList.remove('sel'));
      break;
    case 'g':
      gPending = true;
      break;
  }
});
