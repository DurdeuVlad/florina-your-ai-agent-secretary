/**
 * Renderer app (issue #119): subscribes to pushed RenderTrees over the
 * preload bridge, mounts them via the tree walker, dispatches string
 * commands back to the daemon, and owns keyboard navigation (DG-01 §4).
 *
 * The page holds no daemon connection of its own — the main process owns
 * the socket and pushes trees/status; commands travel the other way.
 */
import { mount } from './tree-renderer.js';
import { createMicCapture } from './audio-capture.js';
import { createPlayback } from './audio-playback.js';

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

  /* preferences screen (issue #128) */
  bridge.on('prefs:update', (tree) => mount(tree, $('prefs')));

  /* ideas screen (issue #129) */
  bridge.on('ideas:update', (tree) => mount(tree, $('ideas')));

  /* secretary screen (issue #130) */
  bridge.on('secretary:update', (tree) => mount(tree, $('secretary')));

  /* chat screen (issue #160): the message list is a RenderTree; the
     composer is static DOM so re-mounts never drop a draft. */
  bridge.on('chat:update', (tree) => {
    mount(tree, $('chatmsgs'));
    const wrap = $('chatwrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  });

  /* dictation (issue #161): main drives the mic via dictation:capture;
     transcripts arrive on dictation:update — partials preview above the
     composer, the final inserts as editable text (never auto-sends). */
  bridge.on('dictation:capture', (d) => {
    if (d && d.capturing) startMic();
    else stopMic();
  });
  bridge.on('dictation:update', (d) => {
    if (!d) return;
    if (typeof d.partial === 'string') {
      $('dictation').hidden = false;
      $('dictationText').textContent = d.partial;
    }
    if (typeof d.final === 'string' && d.final.trim() !== '') {
      insertDictated(d.final.trim());
      $('dictation').hidden = true;
      $('dictationText').textContent = '';
    }
    if (d.state === 'error') {
      toast(d.error || 'dictation failed');
      $('dictation').hidden = true;
      setMicListening(false);
    }
    if (d.state === 'listening') setMicListening(true);
    if (d.state === 'idle') setMicListening(false);
    if (d.state === 'transcribing') {
      $('dictation').querySelector('b').textContent = 'transcribing…';
    }
    if (d.state === 'listening') {
      $('dictation').querySelector('b').textContent = 'listening…';
    }
  });

  /* voice mode (issue #162): the same capture toggle drives the mic, but
     transcripts preview as captions — finals journal into the thread via
     chat-append, they never enter the composer. AI audio plays back over
     dictation:audio-out. */
  bridge.on('voice:update', (d) => {
    if (!d) return;
    if (d.config) {
      micDeviceId = d.config.micDeviceId || null;
      applyDesktopSettings(d.config);
      if (d.config.voiceModeDefault && !voiceOn && !voiceDefaultApplied) {
        voiceDefaultApplied = true;
        toggleVoiceMode();
      }
    }
    if (typeof d.active === 'boolean') setVoiceMode(d.active);
    if (typeof d.listening === 'boolean') setMicListening(d.listening);
    if (d.suspended) toast('daemon lost — voice turn suspended');
    if (typeof d.state === 'string' && d.state !== 'listening') setMicListening(false);
    if (typeof d.partial === 'string' && voiceOn) {
      $('dictation').hidden = false;
      $('dictation').querySelector('b').textContent = 'voice…';
      $('dictationText').textContent = d.partial;
    }
    if (typeof d.final === 'string') {
      $('dictation').hidden = true;
      $('dictationText').textContent = '';
    }
  });
  bridge.on('dictation:audio-out', (d) => {
    if (d && d.stop) playback.stop();
    else if (d && typeof d.pcm === 'string') playback.play(d.pcm);
  });

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
  const cmd = btn.dataset.command;
  /* renderer-only verbs: open the inline preference forms (#128) */
  if (cmd.startsWith('prefedit:')) {
    openPrefEditor(btn.closest('.card'), JSON.parse(decodeURIComponent(cmd.slice(9))));
    return;
  }
  if (cmd === 'prefadd') {
    openPrefAdder();
    return;
  }
  /* ideas screen forms (issue #129) — renderer-local, daemon via ideacmd: */
  if (cmd === 'ideaadd') {
    openIdeaAdder();
    return;
  }
  if (cmd.startsWith('ideacompile:')) {
    openIdeaCompiler(btn.closest('.card'), cmd.slice('ideacompile:'.length));
    return;
  }
  void bridge.command(cmd).then((res) => {
    if (res && res.ok === false) toast(res.error || 'command failed');
  });
});

/* ---------- preferences inline editing (issue #128) ---------- */

/** Wrap an update-preference payload in the prefcmd: wire verb. */
function prefCmd(payload) {
  return 'prefcmd:' + encodeURIComponent(JSON.stringify(payload));
}

/**
 * Send a sequence of update-preference commands in order, toasting the
 * first failure. Returns true when all succeeded.
 */
async function sendPrefCmds(cmds) {
  for (const c of cmds) {
    const res = await bridge.command(prefCmd(c));
    if (res && res.ok === false) {
      toast(res.error || 'preference update failed');
      return false;
    }
  }
  return true;
}

function formRow(input, onSave) {
  const row = document.createElement('div');
  row.className = 'pref-form';
  row.appendChild(input);
  const save = document.createElement('button');
  save.textContent = 'Save';
  save.addEventListener('click', (e) => {
    e.stopPropagation();
    void onSave(input.value.trim());
  });
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', (e) => {
    e.stopPropagation();
    row.remove();
  });
  row.appendChild(save);
  row.appendChild(cancel);
  return row;
}

/**
 * Inline Edit: turns the card's note into an input; Save revokes the old
 * rule and re-adds it with the new note (update-preference has no in-place
 * edit, so edit = remove + add with the same structured fields).
 */
function openPrefEditor(card, rule) {
  if (!card || card.querySelector('.pref-form')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = rule.note || '';
  input.placeholder = 'your words for this rule';
  const structured = {
    provider: rule.provider,
    ...(rule.model ? { model: rule.model } : {}),
    ...(rule.projectId ? { projectId: rule.projectId } : {}),
  };
  card.appendChild(
    formRow(input, async (note) => {
      const remove = { kind: 'update-preference', action: 'remove-rule', ...structured };
      const add = {
        kind: 'update-preference',
        action: 'add-rule',
        ...structured,
        ...(rule.workTypes ? { workTypes: rule.workTypes } : {}),
        ...(note ? { note } : {}),
      };
      await sendPrefCmds([remove, add]);
    }),
  );
  input.focus();
}

/**
 * + Add rule: a small inline form at the top of the prefs view —
 * provider (required), note, optional project scope.
 */
function openPrefAdder() {
  const host = $('prefs');
  if (!host || host.querySelector('.pref-addform')) return;
  const card = document.createElement('div');
  card.className = 'card pref-addform';
  const provider = document.createElement('input');
  provider.type = 'text';
  provider.placeholder = 'provider (e.g. codex, devin, claude-code)';
  const note = document.createElement('input');
  note.type = 'text';
  note.placeholder = 'rule in your own words';
  const project = document.createElement('input');
  project.type = 'text';
  project.placeholder = 'project scope (optional)';
  card.appendChild(provider);
  card.appendChild(note);
  card.appendChild(project);
  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = document.createElement('button');
  save.textContent = 'Save rule';
  save.addEventListener('click', () => {
    if (!provider.value.trim()) {
      toast('provider is required');
      return;
    }
    void sendPrefCmds([
      {
        kind: 'update-preference',
        action: 'add-rule',
        provider: provider.value.trim(),
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
        ...(project.value.trim() ? { projectId: project.value.trim() } : {}),
      },
    ]).then((ok) => {
      if (ok) card.remove();
    });
  });
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => card.remove());
  actions.appendChild(save);
  actions.appendChild(cancel);
  card.appendChild(actions);
  host.prepend(card);
  provider.focus();
}

/* ---------- ideas screen forms (issue #129) ---------- */

function ideaCmd(payload) {
  return 'ideacmd:' + encodeURIComponent(JSON.stringify(payload));
}

function makeInput(placeholder, textarea) {
  const el = document.createElement(textarea ? 'textarea' : 'input');
  if (!textarea) el.type = 'text';
  el.placeholder = placeholder;
  return el;
}

function formActions() {
  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = document.createElement('button');
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  actions.appendChild(save);
  actions.appendChild(cancel);
  return { actions, save, cancel };
}

/** + New idea: title + optional seed body → idea-create. */
function openIdeaAdder() {
  const host = $('ideas');
  if (!host || host.querySelector('.pref-addform')) return;
  const card = document.createElement('div');
  card.className = 'card pref-addform';
  const title = makeInput('idea title');
  const body = makeInput('first note (optional)');
  card.appendChild(title);
  card.appendChild(body);
  const { actions, save, cancel } = formActions();
  save.addEventListener('click', () => {
    if (!title.value.trim()) {
      toast('title is required');
      return;
    }
    void bridge
      .command(
        ideaCmd({
          kind: 'idea-create',
          title: title.value.trim(),
          ...(body.value.trim() ? { body: body.value.trim() } : {}),
        }),
      )
      .then((res) => {
        if (res && res.ok === false) toast(res.error || 'idea-create failed');
        else card.remove();
      });
  });
  cancel.addEventListener('click', () => card.remove());
  card.appendChild(actions);
  host.prepend(card);
  title.focus();
}

/**
 * Compile brief: the delegation plan is human-supplied (DEC-033) — a
 * project id plus one task objective per line (`| provider` optional).
 * Produces `brief-compile`; the draft Brief then awaits confirmation.
 */
function openIdeaCompiler(card, ideaId) {
  if (!card || card.querySelector('.pref-form, .pref-addform')) return;
  const form = document.createElement('div');
  form.className = 'pref-addform';
  const project = makeInput('project id (e.g. agent-secretary)');
  const tasks = makeInput('one task per line — "objective | provider"', true);
  tasks.rows = 4;
  form.appendChild(project);
  form.appendChild(tasks);
  const { actions, save, cancel } = formActions();
  save.textContent = 'Compile brief';
  save.addEventListener('click', () => {
    const projectId = project.value.trim();
    const planTasks = tasks.value
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .map((l) => {
        const [objective, provider] = l.split('|').map((s) => s.trim());
        return { objective, ...(provider ? { preferProvider: provider } : {}) };
      });
    if (!projectId || planTasks.length === 0) {
      toast('project and at least one task are required');
      return;
    }
    void bridge
      .command(ideaCmd({ kind: 'brief-compile', ideaId, plan: { projectId, tasks: planTasks } }))
      .then((res) => {
        if (res && res.ok === false) toast(res.error || 'brief-compile failed');
        else form.remove();
      });
  });
  cancel.addEventListener('click', () => form.remove());
  form.appendChild(actions);
  card.appendChild(form);
  project.focus();
}

/* ---------- chat composer (issue #160) ---------- */

/** Wrap a chat command payload in the chatcmd: wire verb. */
function chatCmd(payload) {
  return 'chatcmd:' + encodeURIComponent(JSON.stringify(payload));
}

/**
 * Send the composer text — journaled by the daemon, echoed back as a
 * `chat:message` push (no optimistic bubble, DG-01 §3.9). The input
 * clears on accept; an in-flight turn or daemon error toasts honestly.
 */
function sendChat() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text || !bridge) return;
  void bridge.command(chatCmd({ kind: 'chat-send', text })).then((res) => {
    if (res && res.ok === false) {
      toast(res.error || 'send failed');
      return;
    }
    input.value = '';
    input.focus();
  });
}

/* ---------- dictation (issue #161) ---------- */

const mic = createMicCapture();
const playback = createPlayback();
let micOn = false;
let voiceOn = false;
let micDeviceId = null;
let voiceDefaultApplied = false;

/** Start the renderer mic; chunks flow to main as dictation:audio IPC. */
function startMic() {
  if (micOn) return;
  micOn = true;
  mic
    .start((pcm) => bridge.dictationAudio(pcm), micDeviceId)
    .then(() => {
      // A capture:false arrived while getUserMedia was still pending —
      // the round is over; tear the freshly-built chain straight down.
      if (!micOn) mic.stop();
    })
    .catch((err) => {
      // getUserMedia denied / no device — tell main to abort the round so
      // it doesn't wait on chunks that will never arrive.
      micOn = false;
      toast(err && err.name === 'NotAllowedError' ? 'microphone access denied' : 'no microphone');
      // Voice-mode turn in flight → end it; dictation round → cancel it.
      void bridge.command(voiceOn ? 'voice:talk' : 'dictation:cancel');
    });
}

function stopMic() {
  if (!micOn) return;
  micOn = false;
  mic.stop();
}

function setMicListening(on) {
  $('chatMic').classList.toggle('listening', on);
  if (!on) {
    $('dictation').hidden = true;
  }
}

/* ---------- desktop & voice settings card (issue #163) ---------- */

/** Reflect saved desktop settings into the prefs card fields. */
function applyDesktopSettings(cfg) {
  const micSel = $('deskMic');
  if (micSel && cfg.micDeviceId !== undefined) {
    micSel.dataset.saved = cfg.micDeviceId || '';
    if (cfg.micDeviceId) {
      // A saved device that isn't enumerated (unplugged, or list not
      // yet run) stays selected as an explicit option — saving must
      // never silently wipe it back to the default.
      if (![...micSel.options].some((o) => o.value === cfg.micDeviceId)) {
        const opt = document.createElement('option');
        opt.value = cfg.micDeviceId;
        opt.textContent = 'Saved device (not detected)';
        micSel.appendChild(opt);
      }
      micSel.value = cfg.micDeviceId;
    }
  }
  if (cfg.voiceModeDefault !== undefined) $('deskVoiceMode').checked = cfg.voiceModeDefault;
  if (cfg.stopDaemonOnQuit !== undefined) $('deskStopDaemon').checked = cfg.stopDaemonOnQuit;
  if (cfg.dictationLanguage !== undefined) $('deskLang').value = cfg.dictationLanguage || '';
}

/** Enumerate mics once; labels need a prior getUserMedia grant. */
let micsListed = false;
async function listMicrophones() {
  if (micsListed || !navigator.mediaDevices?.enumerateDevices) return;
  micsListed = true;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audioinput',
    );
    const sel = $('deskMic');
    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      sel.appendChild(opt);
    });
    const saved = sel.dataset.saved;
    if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
  } catch {
    /* enumeration unsupported — the default-only select stays */
  }
}

$('deskSave').addEventListener('click', () => {
  const patch = {
    micDeviceId: $('deskMic').value || null,
    dictationLanguage: $('deskLang').value.trim() || null,
    voiceModeDefault: $('deskVoiceMode').checked,
    stopDaemonOnQuit: $('deskStopDaemon').checked,
  };
  void bridge.command('deskset:' + encodeURIComponent(JSON.stringify(patch))).then((res) => {
    if (res && res.ok === false) toast(res.error || 'could not save desktop settings');
    else toast('desktop settings saved');
  });
});

/** Insert dictated text at the composer cursor — editable, not sent. */
function insertDictated(text) {
  const input = $('chatInput');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const needsSpace = start > 0 && !/\s$/.test(input.value.slice(0, start));
  input.setRangeText((needsSpace ? ' ' : '') + text + ' ', start, end, 'end');
  input.focus();
}

/** Flip voice-mode visuals + local flag (driven by voice:update). */
function setVoiceMode(on) {
  voiceOn = on;
  $('chatVoice').classList.toggle('listening', on);
  $('chatMic').title = on
    ? 'Talk — a spoken turn the Secretary answers'
    : 'Dictate — speech becomes editable text here';
  if (!on) {
    playback.stop();
    $('dictation').hidden = true;
    $('dictationText').textContent = '';
  }
}

/** Toggle voice mode through the daemon-side session verbs. */
function toggleVoiceMode() {
  if (!bridge) return;
  void bridge.command(voiceOn ? 'voicemode:stop' : 'voicemode:start').then((res) => {
    if (res && res.ok === false) toast(res.error || 'voice mode failed');
  });
}

$('chatVoice').addEventListener('click', toggleVoiceMode);

$('chatMic').addEventListener('click', () => {
  if (!bridge) return;
  // Voice mode on → the mic button is push-to-talk; off → dictation.
  const verb = voiceOn ? 'voice:talk' : micOn ? 'dictation:stop' : 'dictation:start';
  void bridge.command(verb).then((res) => {
    if (res && res.ok === false) toast(res.error || 'mic failed');
  });
});

$('chatSend').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
$('chatClear').addEventListener('click', () => {
  if (!bridge) return;
  if (!window.confirm('Clear the visible conversation? History stays in the journal.')) return;
  void bridge.command(chatCmd({ kind: 'chat-clear' })).then((res) => {
    if (res && res.ok === false) toast(res.error || 'clear failed');
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
  chat: ['Chat', 'one conversation with your Secretary'],
  inbox: ['Attention Inbox', 'what needs you right now'],
  tasks: ['Tasks', 'delegated work and its state'],
  fleet: ['Fleet', 'provider capacity and routing'],
  ideas: ['Ideas', 'ledger entries — compile a Brief when one is ready'],
  prefs: ['Preferences', 'durable routing rules and denies'],
  secretary: ['Secretary', 'her plan, research, and memory — context health is first-class'],
};

let currentView = 'chat';

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
  $('chatClear').style.display = name === 'chat' ? '' : 'none';
  if (name === 'chat') $('chatInput').focus();
  // Enumerate mics whenever prefs opens — covers g p as well as clicks.
  if (name === 'prefs') void listMicrophones();
  // Leaving Chat suspends an open capture (issue #162): voice talk turns
  // end (the reply still journals into the thread); dictation rounds
  // cancel — inserting dictated text while the user is away would be a
  // surprise on return.
  if (name !== 'chat' && micOn) {
    void bridge.command(voiceOn ? 'voice:talk' : 'dictation:cancel');
  }
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
  if (
    e.target.tagName === 'INPUT' ||
    e.target.tagName === 'SELECT' ||
    e.target.tagName === 'TEXTAREA'
  )
    return;
  if (gPending) {
    gPending = false;
    const map = {
      c: 'chat',
      i: 'inbox',
      t: 'tasks',
      f: 'fleet',
      d: 'ideas',
      p: 'prefs',
      s: 'secretary',
    };
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
