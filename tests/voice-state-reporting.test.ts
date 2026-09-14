import { describe, it, expect, vi } from 'vitest';

import { attachVoiceStateReporting } from '../src/bootstrap/voice-session.js';
import type {
  Command,
  CommandExecutor,
  CommandResponseFor,
} from '../src/core/application/use-cases/tasks/command-api.js';
import type { VoiceSessionState } from '../src/core/application/ports/outbound/voice.js';
import type { VoicePipelineMode } from '../src/core/application/use-cases/voice/voice-pipeline.js';

/** Minimal stand-in for VoiceSessionManager's callback registration. */
function makeManagerStub() {
  const state: ((s: VoiceSessionState) => void)[] = [];
  const mode: ((m: VoicePipelineMode) => void)[] = [];
  const transcript: ((text: string, partial: boolean) => void)[] = [];
  return {
    onStateChange: (cb: (s: VoiceSessionState) => void) => {
      state.push(cb);
      return () => {};
    },
    onModeChange: (cb: (m: VoicePipelineMode) => void) => {
      mode.push(cb);
      return () => {};
    },
    onTranscript: (cb: (text: string, partial: boolean) => void) => {
      transcript.push(cb);
      return () => {};
    },
    emitState: (s: VoiceSessionState) => state.forEach((cb) => cb(s)),
    emitMode: (m: VoicePipelineMode) => mode.forEach((cb) => cb(m)),
    emitTranscript: (text: string, partial = false) =>
      transcript.forEach((cb) => cb(text, partial)),
  };
}

function makeApi() {
  const executed: Command[] = [];
  const executor: CommandExecutor = {
    execute: vi.fn(async <C extends Command>(cmd: C): Promise<CommandResponseFor<C>> => {
      executed.push(cmd);
      return { ok: true } as CommandResponseFor<C>;
    }),
  };
  return { executed, executor };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('attachVoiceStateReporting (issue #131)', () => {
  it('maps session lifecycle onto voice-state reports', async () => {
    const manager = makeManagerStub();
    const { executed, executor } = makeApi();
    attachVoiceStateReporting(manager, executor);

    manager.emitState('listening' as VoiceSessionState);
    manager.emitState('processing' as VoiceSessionState);
    manager.emitState('responding' as VoiceSessionState);
    manager.emitState('idle' as VoiceSessionState);
    await flush();

    const states = executed
      .filter((c) => c.kind === 'voice-state')
      .map((c) => (c as { state: string }).state);
    expect(states).toEqual(['listening', 'processing', 'responding', 'idle']);
    for (const cmd of executed) {
      expect(cmd).toMatchObject({ kind: 'voice-state', mode: 'realtime' });
    }
  });

  it('collapses transitional engine states (connecting, error) to idle', async () => {
    const manager = makeManagerStub();
    const { executed, executor } = makeApi();
    attachVoiceStateReporting(manager, executor);

    manager.emitState('connecting' as VoiceSessionState);
    manager.emitState('error' as VoiceSessionState);
    await flush();

    const states = executed.map((c) => (c as { state: string }).state);
    expect(states).toEqual(['idle', 'idle']);
  });

  it('tracks whisper/realtime mode and carries it on every report', async () => {
    const manager = makeManagerStub();
    const { executed, executor } = makeApi();
    attachVoiceStateReporting(manager, executor);

    manager.emitMode('whisper' as VoicePipelineMode);
    manager.emitState('listening' as VoiceSessionState);
    await flush();

    expect(executed[0]).toMatchObject({ kind: 'voice-state', mode: 'whisper' });
    expect(executed[1]).toMatchObject({ state: 'listening', mode: 'whisper' });
  });

  it('streams transcripts (partial and final) onto the report', async () => {
    const manager = makeManagerStub();
    const { executed, executor } = makeApi();
    attachVoiceStateReporting(manager, executor);

    manager.emitTranscript('par', true);
    manager.emitTranscript('partial final', false);
    await flush();

    expect(executed[0]).toMatchObject({ kind: 'voice-state', transcript: 'par' });
    expect(executed[1]).toMatchObject({ transcript: 'partial final' });
  });

  it('is fire-and-forget: a rejected execute never throws into the session', async () => {
    const manager = makeManagerStub();
    const executor: CommandExecutor = {
      execute: vi.fn(() => Promise.reject(new Error('daemon dead'))),
    };
    attachVoiceStateReporting(manager, executor);

    manager.emitState('listening' as VoiceSessionState);
    // The rejection must be swallowed — no unhandled rejection, no throw.
    await flush();
    expect(executor.execute).toHaveBeenCalled();
  });
});
