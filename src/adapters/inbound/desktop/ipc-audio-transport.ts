/**
 * IPC-backed {@link AudioTransport} for the desktop main process
 * (issue #161).
 *
 * The microphone lives in the renderer (`getUserMedia` + AudioWorklet);
 * this transport is the main-process endpoint of that pipeline:
 *
 *  - `startCapture(cb)` → pushes `dictation:capture {capturing:true}` so
 *    the renderer opens the mic; each `dictation:audio` IPC message from
 *    the renderer (Base64 PCM16, 24 kHz mono) is delivered to `cb`.
 *  - `stopCapture()` → pushes `{capturing:false}`; late chunks that land
 *    after the stop are dropped.
 *  - `play(chunk)` → forwards to the renderer on `dictation:audio-out`
 *    (voice-mode playback, issue #162); `stopPlayback` pushes
 *    `{stop:true}` on the same channel.
 *
 * The transport programs against the pluggable {@link IpcTransport} so
 * the whole path is testable headlessly with {@link MockIpcTransport}.
 */
import type { AudioChunk, AudioTransport } from '../../../core/application/ports/outbound/voice.js';
import type { IpcTransport } from './ipc-bridge.js';

/** PCM parameters of the renderer capture pipeline (AudioContext@24k, mono). */
const IPC_SAMPLE_RATE = 24000;
const IPC_CHANNELS = 1;

interface CaptureToggle {
  readonly capturing: boolean;
}

interface AudioChunkMessage {
  readonly pcm?: unknown;
}

export class IpcAudioTransport implements AudioTransport {
  private readonly ipc: IpcTransport;
  private capturing = false;
  private onChunk: ((chunk: AudioChunk) => void) | null = null;
  private readonly unsubChunk: () => void;

  constructor(ipc: IpcTransport) {
    this.ipc = ipc;
    this.unsubChunk = ipc.onMessage('dictation:audio', (data) => {
      if (!this.capturing || this.onChunk === null) return;
      const pcm = (data as AudioChunkMessage).pcm;
      if (typeof pcm !== 'string' || pcm.length === 0) return;
      this.onChunk({ pcm, sampleRate: IPC_SAMPLE_RATE, channels: IPC_CHANNELS });
    });
  }

  startCapture(onChunk: (chunk: AudioChunk) => void): void {
    this.onChunk = onChunk;
    if (!this.capturing) {
      this.capturing = true;
      this.ipc.sendToRenderer('dictation:capture', { capturing: true } satisfies CaptureToggle);
    }
  }

  stopCapture(): void {
    this.onChunk = null;
    if (this.capturing) {
      this.capturing = false;
      this.ipc.sendToRenderer('dictation:capture', { capturing: false } satisfies CaptureToggle);
    }
  }

  /** Forward AI audio to the renderer for playback (voice mode, #162). */
  play(chunk: AudioChunk): void {
    this.ipc.sendToRenderer('dictation:audio-out', chunk);
  }

  stopPlayback(): void {
    this.ipc.sendToRenderer('dictation:audio-out', { stop: true });
  }

  /**
   * Session teardown — stops capture/playback but keeps the chunk listener
   * subscribed. The transport proxies the renderer's mic for the app's
   * lifetime and is shared between dictation and voice sessions: a
   * `VoiceSessionManager.stop()` must not kill the pipeline for the next
   * session (a closed listener silently dropped all audio, leaving the
   * transcription session to commit an empty buffer and die).
   */
  close(): void {
    this.stopCapture();
    this.stopPlayback();
  }

  /** App-level teardown — releases the IPC subscription entirely. */
  dispose(): void {
    this.close();
    this.unsubChunk();
  }
}
