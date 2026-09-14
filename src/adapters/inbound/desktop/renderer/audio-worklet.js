/**
 * AudioWorklet processor for dictation capture (issue #161).
 *
 * Receives Float32 frames from the microphone (the AudioContext is opened
 * at 24 kHz so no resampling is needed) and posts them to the main thread
 * for PCM16 conversion + IPC. Kept as a real file so the page's
 * `script-src 'self'` CSP loads it without blob: URLs.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Copy — the underlying buffer is reused by the audio thread.
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
