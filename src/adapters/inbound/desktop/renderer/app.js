/**
 * Renderer app (issue #119): subscribes to pushed RenderTrees over the
 * preload bridge, mounts them via the tree walker, dispatches string
 * commands back to the daemon, and owns keyboard navigation (DG-01 §4).
 *
 * The page holds no daemon connection of its own — the main process owns
 * the socket and pushes trees/status; commands travel the other way.
 */
import { mount } from './tree-renderer.js';
import { confirmGate } from './command-gate.js';
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
    // Cold launch and every reconnect both report 'connected' — the
    // window-focus listener can't cover a cold boot (the page loads
    // into an already-focused window on some platforms), so this is the
    // reliable first-open hook for the idle catch-up (#260).
    if (d.status === 'connected') maybeCatchUp();
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
  bridge.on('history:update', (tree) => mount(tree, $('history')));
  bridge.on('history:search-results', (tree) => mount(tree, $('historySearchResults')));
  bridge.on('memory:update', (tree) => {
    mount(tree, $('memorySettings'));
    wireMemoryFilters();
  });

  /* Settings > Repos (issue #253) */
  bridge.on('repos:update', (tree) => mount(tree, $('reposView')));

  /* secretary screen (issue #130); re-mount drops .sel classes, so reset
   * the selection index too — Enter must never act on an invisible
   * selection (memory writes gate Confirm/Reject). */
  bridge.on('secretary:update', (tree) => {
    mount(tree, $('secretary'));
    sel = -1;
  });

  /* chat screen (issue #160): the message list is a RenderTree; the
     composer is static DOM so re-mounts never drop a draft. */
  bridge.on('chat:update', (tree) => {
    mount(tree, $('chatmsgs'));
    animateNewChatEntries();
    const wrap = $('chatwrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  });

  /* chat activity/diff drawer (#181): live task list, same data as the
   * Fleet/Tasks screens — no new daemon query, just a second rendering
   * of `tasks` alongside the transcript. */
  bridge.on('chat:activity', (tree) => mount(tree, $('chatDrawerList')));

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
    if (d.connecting) $('chatVoice').classList.add('connecting');
    if (typeof d.active === 'boolean') setVoiceMode(d.active);
    if (typeof d.listening === 'boolean') setMicListening(d.listening);
    if (d.suspended) toast('daemon lost — voice turn suspended');
    if (typeof d.error === 'string') toast(d.error);
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
  /* shared confirm gate (issue #261): data-confirm prompts before
   * dispatch — cancel sends nothing, confirm sends exactly the encoded
   * command. Placed first so it also guards any renderer-only verb that
   * ever carries the attribute. Covers the former confirmPromote flag
   * (#224). */
  if (!confirmGate(btn)) return;
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

/* ---------- chat entrance/word-reveal polish ---------- */

/**
 * Ids already animated in this window session. `mount()` replaces the
 * whole message list on every `chat:update` (even a single new tool row
 * re-renders the full thread), so "new" is tracked here — by message id,
 * not DOM identity — rather than by diffing nodes. Never cleared: a
 * cleared/reloaded thread gets fresh message ids from the journal anyway.
 */
const seenChatIds = new Set();
/**
 * The first `chat:update` after launch/reconnect delivers the full
 * existing history, not new messages — without this flag every past
 * message in the thread would play the entrance animation at once (and
 * the last one would word-reveal) on every app open. That first push
 * seeds `seenChatIds` silently; only pushes after it can mark anything
 * `.enter`.
 */
let chatHistoryLoaded = false;

/**
 * Tag genuinely-new message/tool-row/working-row elements with `.enter`
 * (triggers the CSS entrance animation) and word-reveal the single
 * newest assistant bubble. Call once per `chat:update`, after `mount()`.
 */
function animateNewChatEntries() {
  const list = $('chatmsgs').firstElementChild; // the mounted .chatlist
  if (!list) return;
  if (!chatHistoryLoaded) {
    chatHistoryLoaded = true;
    for (const el of list.children) {
      if (el.dataset.id !== undefined) seenChatIds.add(el.dataset.id);
    }
    return;
  }
  let newestAssistant = null;
  for (const el of list.children) {
    const id = el.dataset.id;
    if (id === undefined) {
      // The working row has no stable id — animate every appearance,
      // it's transient by nature (on for one turn, then gone).
      if (el.classList.contains('workrow')) el.classList.add('enter');
      continue;
    }
    if (seenChatIds.has(id)) continue;
    seenChatIds.add(id);
    el.classList.add('enter');
    if (el.classList.contains('msg') && el.classList.contains('assistant')) {
      newestAssistant = el;
    }
  }
  if (newestAssistant) revealWords(newestAssistant);
}

/**
 * Split a freshly-arrived assistant bubble's text into staggered word
 * spans — a "generation" feel over an already-complete string (the
 * daemon doesn't stream partial content over chat:update; real token
 * streaming would need that wired first). Total stagger is capped so a
 * long reply doesn't crawl in.
 */
function revealWords(bubble) {
  // The bubble is [ChatWho div, text node] — only touch the text node.
  const textNode = [...bubble.childNodes].find(
    (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() !== '',
  );
  if (!textNode) return;
  const tokens = textNode.textContent.split(/(\s+)/);
  const wordCount = tokens.filter((t) => t.trim() !== '').length;
  if (wordCount === 0) return;
  const perWordDelay = Math.min(14, 260 / wordCount);
  const frag = document.createDocumentFragment();
  let i = 0;
  for (const token of tokens) {
    if (token.trim() === '') {
      frag.appendChild(document.createTextNode(token));
      continue;
    }
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = token;
    span.style.animationDelay = `${i * perWordDelay}ms`;
    frag.appendChild(span);
    i += 1;
  }
  bubble.replaceChild(frag, textNode);
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
  $('chatVoice').classList.remove('connecting');
  $('chatVoice').classList.toggle('on', on);
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
    if (res && res.ok === false) {
      $('chatVoice').classList.remove('connecting');
      toast(res.error || 'voice mode failed');
    }
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

/* ---------- idle catch-up digest (issue #260, DEC-042 §9) ---------- */

/**
 * Report the Florina view opening/focusing to main; the trigger and the
 * `get-catchup`/`chat-append`/`confirm-catchup` sequence live in
 * `desktop-app.ts`. Skipped while the composer holds a draft — the
 * digest must never eat a half-typed reply.
 */
function maybeCatchUp() {
  if (!bridge || currentView !== 'chat') return;
  const input = $('chatInput');
  if (input && input.value.trim() !== '') return;
  void bridge.command('catchup:opened');
}

/* chat activity/diff drawer (#181): a per-viewer UI toggle, not a daemon
 * preference — persisted to localStorage only (best-effort; a private
 * window or blocked storage just falls back to closed). */
let drawerOpen = false;
try {
  drawerOpen = window.localStorage.getItem('florina.chatDrawerOpen') === '1';
} catch {
  /* storage unavailable — default closed */
}
function applyDrawerState() {
  $('chatDrawer').hidden = !drawerOpen;
  $('chatDrawerToggle').classList.toggle('open', drawerOpen);
}
applyDrawerState();
$('chatDrawerToggle').addEventListener('click', () => {
  drawerOpen = !drawerOpen;
  applyDrawerState();
  try {
    window.localStorage.setItem('florina.chatDrawerOpen', drawerOpen ? '1' : '0');
  } catch {
    /* best-effort only */
  }
});

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 4000);
}

/* ---------- view navigation ---------- */

// 5-item IA labels (docs/UX_INFORMATION_ARCHITECTURE.md §2, issue #219).
// View ids (map keys) are unchanged from before the relabel to avoid
// touching the routing/focus/mic-listing logic keyed off them elsewhere
// in this file — only the displayed title/subtitle text changed.
// fleet/ideas are reached as Work sub-tabs and secretary as the
// Florina lens (#262) — none has a top-level nav button.
const TITLES = {
  chat: ['Florina', 'one conversation with your Secretary'],
  inbox: ['Attention', 'what needs you right now'],
  tasks: ['Work', 'delegated work and its state'],
  history: ['History', 'completed work, resolved decisions, and evidence trails'],
  fleet: ['Fleet', 'provider capacity and routing'],
  ideas: ['Ideas', 'ledger entries — compile a Brief when one is ready'],
  prefs: ['Settings', 'durable routing rules and denies'],
  secretary: ['Secretary', 'her plan, research, and memory — context health is first-class'],
};

let currentView = 'chat';

function showView(name) {
  currentView = name;
  // The Secretary lens lives inside Florina (issue #262): while it is
  // open the nav stays on Florina — it is not a sixth destination.
  const navKey = name === 'secretary' ? 'chat' : name;
  document
    .querySelectorAll('.navitem')
    .forEach((x) => x.classList.toggle('active', x.dataset.view === navKey));
  document
    .querySelectorAll('.view')
    .forEach((x) => x.classList.toggle('active', x.id === 'v-' + name));
  $('viewTitle').textContent = TITLES[name][0];
  $('viewSub').textContent = TITLES[name][1];
  $('chatClear').style.display = name === 'chat' ? '' : 'none';
  $('chatDrawerToggle').style.display = name === 'chat' ? '' : 'none';
  $('secLensToggle').style.display = name === 'chat' || name === 'secretary' ? '' : 'none';
  $('secLensToggle').classList.toggle('open', name === 'secretary');
  /* A view switch drops card selection — a stale index could otherwise
   * Enter-activate an unhighlighted card in the new view (#262). Clear
   * every view's paint too, not just the one we're entering. */
  sel = -1;
  document.querySelectorAll('.sel').forEach((c) => c.classList.remove('sel'));
  if (name === 'chat') {
    $('chatInput').focus();
    maybeCatchUp();
  }
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

/* Secretary lens (issue #262): the header toggle opens/closes it from
 * the Florina thread — same affordance as the g e chord and Esc. */
$('secLensToggle').addEventListener('click', () => {
  showView(currentView === 'secretary' ? 'chat' : 'secretary');
});

/* Refocus while on Florina = a "return" worth checking against the idle
 * threshold (registered after currentView exists — see maybeCatchUp). */
window.addEventListener('focus', maybeCatchUp);

/* ---------- Work sub-tabs: Tasks/Fleet/Ideas (issue #220) ---------- */

function showWorkSub(name) {
  document
    .querySelectorAll('.worksubtab')
    .forEach((b) => b.classList.toggle('active', b.dataset.worksub === name));
  document
    .querySelectorAll('.worksubpanel')
    .forEach((p) => p.classList.toggle('active', p.id === name));
}

document
  .querySelectorAll('.worksubtab')
  .forEach((b) => b.addEventListener('click', () => showWorkSub(b.dataset.worksub)));

/* ---------- Settings memory/rules browse: client-side filters (issue #223) ---------- */

let memoryScopeFilter = '';
let memoryKindFilter = '';

function applyMemoryFilters() {
  const rows = document.querySelectorAll('#memorySettings [data-scope]');
  rows.forEach((row) => {
    const scopeOk = !memoryScopeFilter || row.dataset.scope.startsWith(memoryScopeFilter);
    const kindOk = !memoryKindFilter || row.dataset.kind === memoryKindFilter;
    row.style.display = scopeOk && kindOk ? '' : 'none';
  });
}

function wireMemoryFilters() {
  document.querySelectorAll('#memorySettings [data-filter-kind]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const kind = chip.dataset.filterKind;
      const value = chip.dataset.value || '';
      if (kind === 'scope') memoryScopeFilter = value;
      else memoryKindFilter = value;
      document
        .querySelectorAll(`#memorySettings [data-filter-kind="${kind}"]`)
        .forEach((c) => c.classList.toggle('active', c.dataset.value === value));
      applyMemoryFilters();
    });
  });
  applyMemoryFilters();
}

/* ---------- History journal search (issue #222) ---------- */

/** Wrap a search-journal payload in the historysearch: wire verb. */
function historySearchCmd(payload) {
  return 'historysearch:' + encodeURIComponent(JSON.stringify(payload));
}

function runHistorySearch() {
  if (!bridge) return;
  const text = $('historySearchText').value.trim();
  const since = $('historySearchSince').value; // yyyy-mm-dd or ''
  const until = $('historySearchUntil').value;
  const payload = { kind: 'search-journal' };
  if (text) payload.text = text;
  if (since) payload.since = since + 'T00:00:00.000Z';
  if (until) payload.until = until + 'T23:59:59.999Z';
  void bridge.command(historySearchCmd(payload)).then((res) => {
    if (res && res.ok === false) toast(res.error || 'search failed');
  });
}

$('historySearchGo').addEventListener('click', runHistorySearch);
$('historySearchText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runHistorySearch();
});

/* ---------- Settings > Repos search (issue #253) ---------- */

/** Wrap a query-repos payload in the reposcmd: wire verb. */
function reposCmd(payload) {
  return 'reposcmd:' + encodeURIComponent(JSON.stringify(payload));
}

function runReposSearch() {
  if (!bridge) return;
  const query = $('reposSearchText').value.trim();
  void bridge.command(reposCmd({ kind: 'query-repos', query })).then((res) => {
    if (res && res.ok === false) toast(res.error || 'search failed');
  });
}

$('reposSearchGo').addEventListener('click', runReposSearch);
$('reposSearchText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runReposSearch();
});

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
    /* #261: the same confirm gate guards keyboard dispatch */
    if (!confirmGate(row)) return;
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
    // Remapped to the 5-item IA (docs/UX_GUIDELINES.md §4, issue #219):
    // g f Florina, g a Attention, g w Work, g h History, g s Settings;
    // g e opens the Secretary lens inside Florina (#262).
    // This breaks some old single-letter muscle memory (g c/i/t/p) in
    // exchange for each letter matching its new, clearer name (the same
    // tradeoff the IA doc makes for the nav labels themselves) — fleet
    // and ideas lose a dedicated chord entirely, pending #220's merge
    // into Work.
    const map = {
      f: 'chat',
      a: 'inbox',
      w: 'tasks',
      h: 'history',
      s: 'prefs',
      /* #262: the Secretary lens — inside Florina, reachable from anywhere */
      e: 'secretary',
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
        /* selectable rows (e.g. task rows) activate their command —
         * through the same confirm gate (#261) */
        if (!confirmGate(c)) break;
        void bridge.command(c.dataset.command);
      }
      break;
    }
    case 'Escape':
      /* #262: Esc pops the Secretary lens back to the Florina thread. */
      if (currentView === 'secretary') {
        showView('chat');
        break;
      }
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
