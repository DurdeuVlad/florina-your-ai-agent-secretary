/**
 * Renderer-side microphone capture for dictation (issue #161).
 *
 * `startCapture(onChunk)` opens an AudioContext at 24 kHz (matching the
 * Realtime API's expected rate — no resampling), pipes mic frames through
 * the `pcm-capture` AudioWorklet, converts Float32 → PCM16 → Base64, and
 * hands each chunk to `onChunk` (app.js forwards it as a `dictation:audio`
 * IPC message). `stopCapture` tears the whole chain down.
 *
 * Errors surface via the returned promise — `getUserMedia` denial,
 * missing devices, and AudioWorklet failures all reject so the caller can
 * toast and abort the round.
 */

/** Float32 [-1,1] samples → Base64 PCM16 little-endian. */
function floatToPcm16Base64(samples) {
  const buf = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(buf.buffer);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function createMicCapture() {
  let ctx = null;
  let stream = null;
  let node = null;
  let source = null;

  return {
    async start(onChunk) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      ctx = new AudioContext({ sampleRate: 24000 });
      await ctx.audioWorklet.addModule('audio-worklet.js');
      source = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'pcm-capture');
      node.port.onmessage = (e) => onChunk(floatToPcm16Base64(e.data));
      source.connect(node);
      node.connect(ctx.destination);
    },
    stop() {
      try {
        if (node) node.port.onmessage = null;
        if (source) source.disconnect();
        if (node) node.disconnect();
        if (stream) stream.getTracks().forEach((t) => t.stop());
        if (ctx) void ctx.close();
      } finally {
        ctx = null;
        stream = null;
        node = null;
        source = null;
      }
    },
  };
}
