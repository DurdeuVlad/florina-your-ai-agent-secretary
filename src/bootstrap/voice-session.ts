/**
 * Voice session composition root (DEC-021, DEC-037, issue #93).
 *
 * Wires the inbound voice surface ({@link VoiceSessionManager}) to the
 * concrete outbound engines: the stdin/stdout {@link AudioTransport}, the
 * OpenAI {@link RealtimeBridge}, and the whisper.cpp fallback adapter.
 * Inbound surfaces never compose concrete engines themselves — this is the
 * only place the combination happens.
 */
import type {
  CommandExecutor,
  PreferenceResponse,
  ReportVoiceStateCommand,
} from '../core/application/use-cases/tasks/command-api.js';
import type { VoiceSessionManager } from '../adapters/inbound/voice/voice-session-manager.js';
import type { AsyncVoiceToolRunner } from '../adapters/inbound/voice/voice-session-manager.js';
import type { ModelPort } from '../core/application/ports/outbound/model.js';
import { isProfileEmpty } from '../core/application/ports/outbound/preference-profile.js';

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
  /**
   * Runner for long-lived voice tools (issue #73) — e.g. `research`.
   * {@link createResearchRunner} builds one from a model connector; when
   * absent the async tools report "not wired" instead of hanging a turn.
   */
  readonly asyncToolRunner?: AsyncVoiceToolRunner;
  /**
   * LiteLLM proxy config (DEC-034). When present, this composes a
   * {@link LiteLLMConnector} + `research` runner so the voice session's
   * heavyweight work runs in the Florina loop. Research findings
   * route back through `commandApi` as `idea-append` commands, so the
   * daemon's ledger stays the single source of truth.
   */
  readonly litellm?: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey?: string;
  };
  /**
   * Override the session instructions (issue #65) — when absent, an empty
   * preference profile triggers the first-run setup-interview block.
   */
  readonly instructions?: string;
}): Promise<VoiceSessionManager> {
  const { StdinAudioTransport } =
    await import('../adapters/outbound/voice/stdin-audio-transport.js');
  const { WhisperCppBackend } = await import('../adapters/outbound/voice/whisper-backend.js');
  const { WhisperAdapter } = await import('../adapters/outbound/voice/whisper-adapter.js');
  const { RealtimeBridge, defaultSocketFactory } =
    await import('../adapters/outbound/voice/realtime-bridge.js');
  const { VoiceSessionManager: Manager } =
    await import('../adapters/inbound/voice/voice-session-manager.js');

  const audioTransport = new StdinAudioTransport();
  const bridge = new RealtimeBridge(audioTransport, defaultSocketFactory);
  const whisperAdapter = new WhisperAdapter(new WhisperCppBackend());

  let asyncToolRunner = options.asyncToolRunner;
  if (asyncToolRunner === undefined && options.litellm !== undefined) {
    const { LiteLLMConnector } = await import('../adapters/outbound/model/litellm-connector.js');
    asyncToolRunner = createResearchRunner(new LiteLLMConnector(options.litellm), {
      onResearchNote: (ideaId, heading, body) => {
        // Fire-and-forget through the daemon — a failed note must not
        // break the spoken result.
        void options.commandApi
          .execute({ kind: 'idea-append', ideaId, heading, body })
          .catch(() => undefined);
      },
    });
  }

  // Issue #65: an empty preference profile means a fresh install — the first
  // voice session opens with the setup interview so durable provider/model
  // rules get captured conversationally. Skipped when the caller supplies
  // custom instructions or the query fails.
  let instructions = options.instructions;
  if (instructions === undefined) {
    try {
      const prefs = (await options.commandApi.execute({
        kind: 'query-preferences',
      })) as PreferenceResponse;
      if (prefs.ok && prefs.profile !== undefined && isProfileEmpty(prefs.profile)) {
        const { DEFAULT_VOICE_INSTRUCTIONS, SETUP_INTERVIEW_INSTRUCTIONS } =
          await import('../adapters/inbound/voice/voice-tools.js');
        instructions = DEFAULT_VOICE_INSTRUCTIONS + SETUP_INTERVIEW_INSTRUCTIONS;
      }
    } catch {
      /* preferences unwired — default instructions only */
    }
  }

  const manager = new Manager({
    apiKey: options.apiKey,
    audioTransport,
    bridge,
    whisperAdapter,
    commandApi: options.commandApi,
    ...(asyncToolRunner !== undefined ? { asyncToolRunner } : {}),
    ...(instructions !== undefined ? { bridgeOptions: { instructions } } : {}),
  });

  attachVoiceStateReporting(manager, options.commandApi);

  return manager;
}

/**
 * Issue #131: mirror session state onto the daemon so subscribed
 * surfaces (the desktop HUD) track the five-state model live. Reports
 * are ephemeral pushes, not journaled events — fire-and-forget so a
 * dead daemon never blocks the voice turn.
 */
export function attachVoiceStateReporting(
  manager: Pick<VoiceSessionManager, 'onStateChange' | 'onModeChange' | 'onTranscript'>,
  commandApi: CommandExecutor,
): void {
  let lastState: 'idle' | 'listening' | 'processing' | 'responding' = 'idle';
  let lastMode: 'realtime' | 'whisper' = 'realtime';
  const report = (fields: Partial<ReportVoiceStateCommand>): void => {
    void commandApi
      .execute({ kind: 'voice-state', state: lastState, mode: lastMode, ...fields })
      .catch(() => undefined);
  };
  manager.onStateChange((s) => {
    if (s === 'listening' || s === 'processing' || s === 'responding') {
      lastState = s;
    } else {
      lastState = 'idle'; // connecting/error collapse to idle — daemon loss is what reads offline
    }
    report({});
  });
  manager.onModeChange((mode) => {
    lastMode = mode === 'whisper' ? 'whisper' : 'realtime';
    report({});
  });
  manager.onTranscript((text) => {
    report({ transcript: text });
  });
}

/**
 * Build the `research` async tool runner (issue #73): heavyweight
 * ideation work runs in the Florina loop on the injected model
 * connector (LiteLLM-backed, DEC-034) — the voice turn that triggered
 * it was never blocked, and the result is spoken when ready.
 *
 * When `args.ideaId` is present and an `onResearchNote` sink is wired,
 * the findings are also appended to that idea ledger (DEC-033).
 */
export function createResearchRunner(
  connector: ModelPort,
  options?: {
    readonly onResearchNote?: (ideaId: string, heading: string, body: string) => void;
    readonly maxIterations?: number;
  },
): AsyncVoiceToolRunner {
  return async (name, args) => {
    if (name !== 'research' || typeof args['query'] !== 'string') {
      return `unsupported async tool call: ${name}`;
    }
    const { FlorinaLoop } = await import('../core/application/use-cases/florina/loop.js');
    const { ToolRegistry } = await import('../core/application/use-cases/florina/tool-registry.js');
    const loop = new FlorinaLoop({
      connector,
      tools: new ToolRegistry(),
      maxIterations: options?.maxIterations ?? 4,
    });
    const result = await loop.run([
      {
        role: 'user',
        content:
          `Research the following and report concise, structured findings ` +
          `(what it is, how it works, open questions, risks):\n\n${args['query']}`,
      },
    ]);
    const findings = result.final.content ?? 'no findings';
    const ideaId = args['ideaId'];
    if (typeof ideaId === 'string' && options?.onResearchNote !== undefined) {
      options.onResearchNote(ideaId, 'Research', findings);
    }
    return `Research complete.\n\n${findings}`;
  };
}
