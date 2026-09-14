import { describe, it, expect, beforeEach } from 'vitest';

import { IpcAudioTransport } from '../src/adapters/inbound/desktop/ipc-audio-transport.js';
import { MockIpcTransport } from '../src/adapters/inbound/desktop/ipc-bridge.js';
import type { AudioChunk } from '../src/core/application/ports/outbound/voice.js';

/**
 * Issue #161: the IPC transport is the main-process endpoint of the
 * renderer mic. Capture toggles go out on `dictation:capture`; PCM
 * chunks arrive on `dictation:audio`; playback (voice mode, #162)
 * goes out on `dictation:audio-out`.
 */
describe('IpcAudioTransport', () => {
  let ipc: MockIpcTransport;
  let transport: IpcAudioTransport;

  beforeEach(() => {
    ipc = new MockIpcTransport();
    transport = new IpcAudioTransport(ipc);
  });

  it('startCapture asks the renderer to open the mic', () => {
    transport.startCapture(() => undefined);
    expect(ipc.toRenderer).toEqual([{ channel: 'dictation:capture', data: { capturing: true } }]);
  });

  it('stopCapture tells the renderer to close the mic', () => {
    transport.startCapture(() => undefined);
    transport.stopCapture();
    expect(ipc.toRenderer.at(-1)).toEqual({
      channel: 'dictation:capture',
      data: { capturing: false },
    });
  });

  it('forwards renderer audio chunks as 24kHz mono PCM', () => {
    const received: AudioChunk[] = [];
    transport.startCapture((c) => received.push(c));
    ipc.emitToMain('dictation:audio', { pcm: 'QUJD' });
    expect(received).toEqual([{ pcm: 'QUJD', sampleRate: 24000, channels: 1 }]);
  });

  it('drops chunks that arrive before capture starts or after it stops', () => {
    const received: AudioChunk[] = [];
    ipc.emitToMain('dictation:audio', { pcm: 'EARLY' });
    transport.startCapture((c) => received.push(c));
    transport.stopCapture();
    ipc.emitToMain('dictation:audio', { pcm: 'LATE' });
    expect(received).toHaveLength(0);
  });

  it('drops malformed chunk payloads', () => {
    const received: AudioChunk[] = [];
    transport.startCapture((c) => received.push(c));
    ipc.emitToMain('dictation:audio', { pcm: 42 });
    ipc.emitToMain('dictation:audio', { pcm: '' });
    ipc.emitToMain('dictation:audio', 'not-an-object');
    expect(received).toHaveLength(0);
  });

  it('forwards playback chunks and stop signals on dictation:audio-out', () => {
    const chunk = { pcm: 'QUJD', sampleRate: 24000, channels: 1 };
    transport.play(chunk);
    transport.stopPlayback();
    expect(ipc.toRenderer).toEqual([
      { channel: 'dictation:audio-out', data: chunk },
      { channel: 'dictation:audio-out', data: { stop: true } },
    ]);
  });

  it('close() stops capture, playback, and unsubscribes from audio chunks', () => {
    const received: AudioChunk[] = [];
    transport.startCapture((c) => received.push(c));
    transport.close();
    ipc.emitToMain('dictation:audio', { pcm: 'AFTER' });
    expect(received).toHaveLength(0);
    expect(ipc.toRenderer.filter((m) => m.channel === 'dictation:capture').at(-1)?.data).toEqual({
      capturing: false,
    });
  });
});
