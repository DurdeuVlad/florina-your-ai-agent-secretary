/**
 * Voice session composition root (DEC-021, DEC-037, issue #93).
 *
 * Wires the inbound voice surface ({@link VoiceSessionManager}) to the
 * concrete outbound engines: the stdin/stdout {@link AudioTransport}, the
 * OpenAI {@link RealtimeBridge}, and the whisper.cpp fallback adapter.
 * Inbound surfaces never compose concrete engines themselves — this is the
 * only place the combination happens.
 */
import type { CommandExecutor } from '../core/application/use-cases/tasks/command-api.js';
import type { VoiceSessionManager } from '../adapters/inbound/voice/voice-session-manager.js';

/**
 * Compose a {@link VoiceSessionManager} backed by the stdin audio
 * transport, the OpenAI Realtime bridge, and the whisper.cpp fallback.
 *
 * The concrete engines are lazy-imported so processes that never start a
 * voice session don't pay the module load (the `ws` / voice stack).
 */
export async function createStdinVoiceSession(options: {
  readonly apiKey: string;
  readonly commandApi: CommandExecutor;
}): Promise<VoiceSessionManager> {
  const { StdinAudioTransport } = await import(
    '../adapters/outbound/voice/stdin-audio-transport.js'
  );
  const { WhisperCppBackend } = await import('../adapters/outbound/voice/whisper-backend.js');
  const { WhisperAdapter } = await import('../adapters/outbound/voice/whisper-adapter.js');
  const { RealtimeBridge, defaultSocketFactory } = await import(
    '../adapters/outbound/voice/realtime-bridge.js'
  );
  const { VoiceSessionManager: Manager } = await import(
    '../adapters/inbound/voice/voice-session-manager.js'
  );

  const audioTransport = new StdinAudioTransport();
  const bridge = new RealtimeBridge(audioTransport, defaultSocketFactory);
  const whisperAdapter = new WhisperAdapter(new WhisperCppBackend());

  return new Manager({
    apiKey: options.apiKey,
    audioTransport,
    bridge,
    whisperAdapter,
    commandApi: options.commandApi,
  });
}
