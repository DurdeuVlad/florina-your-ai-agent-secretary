/**
 * HUD renderer (issue #123): receives PttHudState pushes on the `hud:state`
 * channel and projects them onto the fixed overlay DOM from
 * docs/mockups/hud.html. All transitions are event-driven — no timers.
 *
 * States: idle / listening (pulsing accent ring + level bars) /
 * processing (amber) / responding (green + reply preview) / offline (slate).
 */
const $ = (id) => document.getElementById(id);
const bridge = window.florina;

const BARS = '<span class="bars"><i></i><i></i><i></i><i></i></span>';

function render(s) {
  const hud = $('hud');
  const ring = $('ring');
  const title = $('hudTitle');
  const sub = $('hudSub');

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

if (bridge) {
  bridge.on('hud:state', render);
  $('hud').addEventListener('click', () => void bridge.command('ptt:toggle'));
}
