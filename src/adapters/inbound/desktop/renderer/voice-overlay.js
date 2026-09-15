/**
 * Voice-mode overlay renderer (issue #182): receives the SAME `PttHudState`
 * pushes as the small PTT HUD (`hud.js`) on the `hud:state` channel — this
 * is a bigger render target for existing state, not a new state machine.
 *
 * Only the states relevant to an active voice-mode turn are drawn: idle/
 * offline briefly show while the overlay is opening/closing, but the
 * window is hidden (not just re-skinned) the rest of the time by
 * `VoiceOverlayController`.
 */
const $ = (id) => document.getElementById(id);
const bridge = window.florina;

const BARS = '<span class="bars voice-bars"><i></i><i></i><i></i><i></i></span>';

function render(s) {
  const overlay = $('overlay');
  const orb = $('orb');
  const title = $('voiceTitle');
  const sub = $('voiceSub');

  overlay.classList.remove('listening', 'processing', 'responding');

  if (s.isListening) {
    overlay.classList.add('listening');
    orb.innerHTML = BARS;
    title.textContent = 'Listening…';
    sub.textContent = s.currentTranscript || '';
    return;
  }
  if (s.isProcessing) {
    overlay.classList.add('processing');
    orb.textContent = '…';
    title.textContent = 'Thinking';
    sub.textContent = s.currentTranscript || '';
    return;
  }
  if (s.isResponding) {
    overlay.classList.add('responding');
    orb.textContent = '▶';
    title.textContent = 'Secretary';
    sub.textContent = s.responsePreview || '';
    return;
  }
  // idle/offline — transient while the window opens/closes.
  orb.textContent = '🎙';
  title.textContent = 'Voice mode';
  sub.textContent = '';
}

if (bridge) {
  bridge.on('hud:state', render);
}
