/**
 * Stdin-based {@link AudioTransport} for CLI voice testing (DEC-021, issue #41).
 *
 * Reads Base64-encoded PCM16 audio chunks from stdin (one chunk per line) and
 * feeds them to the capture callback. Playback audio is written to stdout as
 * Base64-encoded lines. This allows basic voice pipeline testing from the
 * CLI without a microphone or speakers — the user pipes audio in via stdin
 * and reads AI responses from stdout.
 *
 * In production (desktop app), this is replaced by a WebRTC-backed
 * {@link AudioTransport} that reads from the local microphone and writes to
 * the speakers. The stdin transport is the minimal viable path for headless
 * / SSH environments where no audio hardware is available.
 */
import type { AudioChunk, AudioTransport } from '../../../core/application/ports/outbound/voice.js';

/**
 * {@link AudioTransport} backed by stdin (capture) and stdout (playback).
 *
 * Capture: reads lines from stdin, each line is a Base64-encoded PCM16
 * chunk. An empty line or EOF stops capture.
 *
 * Playback: writes Base64-encoded PCM16 chunks to stdout, one per line.
 */
export class StdinAudioTransport implements AudioTransport {
  private capturing = false;
  private onChunk: ((chunk: AudioChunk) => void) | null = null;
  private readonly sampleRate: number;
  private readonly channels: number;

  constructor(options?: { sampleRate?: number; channels?: number }) {
    this.sampleRate = options?.sampleRate ?? 24000;
    this.channels = options?.channels ?? 1;
  }

  startCapture(onChunk: (chunk: AudioChunk) => void): void {
    if (this.capturing) {
      return;
    }
    this.capturing = true;
    this.onChunk = onChunk;

    const readline = globalThis.process?.stdin;
    if (!readline) {
      return;
    }

    // Set stdin to raw mode if possible (for binary input), then read lines.
    let buffer = '';
    readline.on('data', (data: Buffer) => {
      if (!this.capturing || !this.onChunk) {
        return;
      }
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        this.onChunk({
          pcm: trimmed,
          sampleRate: this.sampleRate,
          channels: this.channels,
        });
      }
    });

    readline.on('end', () => {
      this.capturing = false;
      this.onChunk = null;
    });
  }

  stopCapture(): void {
    this.capturing = false;
    this.onChunk = null;
  }

  play(chunk: AudioChunk): void {
    // Write the PCM as Base64 to stdout, one line per chunk.
    const line = chunk.pcm + '\n';
    globalThis.process?.stdout.write(line);
  }

  stopPlayback(): void {
    // No-op: stdout writes are immediate.
  }

  close(): void {
    this.stopCapture();
    this.stopPlayback();
  }
}
