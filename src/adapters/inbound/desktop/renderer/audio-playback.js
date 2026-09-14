/**
 * Renderer-side AI audio playback for voice mode (issue #162).
 *
 * `dictation:audio-out` pushes carry Base64 PCM16 chunks from the main
 * process (the realtime engine's spoken response). Chunks are decoded to
 * Float32 and scheduled back-to-back on a 24 kHz AudioContext so the
 * reply plays without gaps. `{ stop: true }` (barge-in/interrupt) drops
 * the queue and closes the context.
 *
 * CSP-safe: no eval, no blob: URLs — the module is loaded like every
 * other renderer file.
 */

/** Base64 PCM16 little-endian → Float32 [-1,1] samples. */
function pcm16Base64ToFloat(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ints = new Int16Array(bytes.buffer);
  const out = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) out[i] = ints[i] / 0x8000;
  return out;
}

export function createPlayback() {
  let ctx = null;
  let nextTime = 0;

  function ensureCtx() {
    if (ctx === null || ctx.state === 'closed') {
      ctx = new AudioContext({ sampleRate: 24000 });
      nextTime = ctx.currentTime;
    }
    return ctx;
  }

  return {
    /** Queue a Base64 PCM16 chunk for gapless playback. */
    play(pcm) {
      const c = ensureCtx();
      const samples = pcm16Base64ToFloat(pcm);
      if (samples.length === 0) return;
      const buf = c.createBuffer(1, samples.length, 24000);
      buf.copyToChannel(samples, 0);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      const startAt = Math.max(nextTime, c.currentTime);
      src.start(startAt);
      nextTime = startAt + buf.duration;
    },
    /** Drop the queue — barge-in or session end. */
    stop() {
      nextTime = 0;
      if (ctx !== null) {
        void ctx.close().catch(() => {});
        ctx = null;
      }
    },
  };
}
