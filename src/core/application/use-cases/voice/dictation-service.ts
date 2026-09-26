/**
 * DictationService — mic → editable composer text (issue #161).
 *
 * Dictation is NOT a conversation turn: speech becomes text the user can
 * review and edit before sending (DG-01 §5 — the model never acts on
 * unreviewed speech). The pipeline reuses the existing audio boundary:
 *
 * ```
 * mic (renderer) --dictation:audio--> AudioTransport --PCM--> Realtime
 *                                        |                (transcriptionOnly:
 *                                        v                 commit, never
 *                              WhisperAdapter fallback     response.create)
 *                                        |
 *                          partial → onTranscript;  final → onTranscript
 * ```
 *
 * The realtime session connects lazily and stays open across dictations
 * — press-mic latency is one `startListening`, not a WebSocket handshake.
 * When no realtime engine is configured (no key, connect failure) the
 * service falls back to batch transcription via {@link TranscriptionPort}
 * (whisper.cpp), collecting chunks itself instead of going through the
 * session's transport callback.
 */
import type {
  AudioChunk,
  AudioTransport,
  RealtimeSessionOptions,
  RealtimeSessionPort,
  TranscriptionPort,
  TranscriptEvent,
} from '../../ports/outbound/voice.js';

/** Dictation lifecycle states surfaced to the UI. */
export type DictationState = 'idle' | 'connecting' | 'listening' | 'transcribing' | 'error';

export interface DictationUpdate {
  readonly state: DictationState;
  readonly error?: string;
}

export interface DictationServiceDeps {
  /** Audio boundary — desktop: the IPC transport fed by the renderer mic. */
  readonly transport: AudioTransport;
  /**
   * Realtime session to dictate through (constructed with the same
   * transport). Absent → whisper-only.
   */
  readonly session?: RealtimeSessionPort;
  /** Engine credential for {@link RealtimeSessionPort.connect}. */
  readonly apiKey?: string;
  /** Session options — `transcriptionOnly` is forced on. */
  readonly sessionOptions?: RealtimeSessionOptions;
  /** Batch fallback engine (whisper.cpp adapter) for offline/no-key. */
  readonly whisper?: TranscriptionPort;
  /** State transitions for the UI (mic pulse, preview, toasts). */
  readonly onUpdate?: (update: DictationUpdate) => void;
  /** Transcript events — `partial` previews, `partial:false` inserts. */
  readonly onTranscript?: (event: TranscriptEvent) => void;
  /** Max wait for the final transcript after stop (default 8s). */
  readonly finalTimeoutMs?: number;
}

export class DictationService {
  private readonly transport: AudioTransport;
  private readonly session: RealtimeSessionPort | undefined;
  private readonly apiKey: string | undefined;
  private sessionOptions: RealtimeSessionOptions | undefined;
  private readonly whisper: TranscriptionPort | undefined;
  private readonly onUpdate: ((update: DictationUpdate) => void) | undefined;
  private readonly onTranscript: ((event: TranscriptEvent) => void) | undefined;
  private readonly finalTimeoutMs: number;

  private state: DictationState = 'idle';
  /** 'realtime' | 'whisper' — chosen at start; kept for stop(). */
  private mode: 'realtime' | 'whisper' | null = null;
  /** Chunks collected directly when running on the whisper path. */
  private whisperChunks: AudioChunk[] = [];
  /** Latest partial text — base for a timeout-degraded final. */
  private lastPartial = '';
  private awaitingFinal: ((text: string) => void) | null = null;
  private sessionReady = false;
  /** A language change mid-round drops the session when the round ends. */
  private dropSessionAfterRound = false;
  /** Set by cancel() — the in-flight final is swallowed, not inserted. */
  private suppressFinal = false;
  /**
   * Monotonic round id — a cancel() during an in-flight connect bumps it so
   * start() abandons the round instead of resurrecting it as 'listening'.
   */
  private generation = 0;

  constructor(deps: DictationServiceDeps) {
    this.transport = deps.transport;
    this.session = deps.session;
    this.apiKey = deps.apiKey;
    this.sessionOptions = deps.sessionOptions;
    this.whisper = deps.whisper;
    this.onUpdate = deps.onUpdate;
    this.onTranscript = deps.onTranscript;
    this.finalTimeoutMs = deps.finalTimeoutMs ?? 8_000;

    this.session?.onTranscript((event) => {
      if (event.partial) {
        this.lastPartial = event.text;
        this.onTranscript?.(event);
        return;
      }
      // A cancel() during flight swallows the round's final.
      if (this.suppressFinal) {
        this.suppressFinal = false;
        return;
      }
      // Final transcript: resolve a pending stop() first (it re-emits),
      // otherwise forward directly.
      if (this.awaitingFinal !== null) {
        const resolve = this.awaitingFinal;
        this.awaitingFinal = null;
        resolve(event.text);
      } else {
        this.onTranscript?.(event);
      }
    });
    this.session?.onStateChange((event) => {
      // A dropped realtime session makes the next start() reconnect.
      if (this.session !== undefined && !this.session.isConnected) {
        this.sessionReady = false;
      }
      // Mid-round engine failure is user-visible — don't sit 'listening'
      // on a dead socket.
      if (event.to === 'error' && this.active) {
        this.setState('error', 'voice engine connection lost');
      }
    });
  }

  get currentState(): DictationState {
    return this.state;
  }

  /**
   * Update the transcription language hint for future rounds (issue
   * #163). An idle realtime session is dropped so the next start()
   * reconnects with the new config; mid-round changes drop the session
   * when the round ends so the following round renegotiates. The
   * whisper fallback's language is fixed at initialize() time.
   */
  setSessionLanguage(language: string | undefined): void {
    this.sessionOptions = {
      ...this.sessionOptions,
      transcriptionLanguage: language,
    };
    if (!this.sessionReady) return;
    if (this.active) {
      this.dropSessionAfterRound = true;
    } else {
      this.releaseSession();
    }
  }

  /** Whether a dictation round is active (any non-idle, non-error state). */
  get active(): boolean {
    return this.state !== 'idle' && this.state !== 'error';
  }

  /**
   * Begin a dictation round: open the realtime session (lazily, once) and
   * start capture. Falls back to the whisper batch path when realtime is
   * unavailable. Errors land in `state: 'error'` — callers see a toast.
   */
  async start(): Promise<void> {
    if (this.active) return;
    const gen = ++this.generation;
    this.lastPartial = '';
    this.whisperChunks = [];
    this.suppressFinal = false;

    if (this.session !== undefined && this.apiKey !== undefined) {
      this.setState('connecting');
      try {
        if (!this.sessionReady) {
          await this.session.connect(this.apiKey, {
            ...this.sessionOptions,
            transcriptionOnly: true,
          });
          this.sessionReady = true;
        }
        // A cancel() during connect wins — leave the session connected but
        // not listening; the next start() reuses it.
        if (gen !== this.generation) return;
        this.session.startListening();
        this.mode = 'realtime';
        this.setState('listening');
        return;
      } catch (err) {
        // Realtime unreachable — degrade to whisper if it's there.
        this.sessionReady = false;
        if (this.whisper === undefined || !(await this.whisper.isAvailable())) {
          this.setState('error', `dictation unavailable — ${errorText(err)}`);
          return;
        }
      }
    }

    // Whisper path: collect chunks ourselves — the session owns the
    // transport callback when realtime runs, so this is the fallback lane.
    if (this.whisper === undefined) {
      this.setState('error', 'dictation unavailable — no voice engine configured');
      return;
    }
    this.mode = 'whisper';
    this.whisperChunks = [];
    this.transport.startCapture((chunk) => {
      this.whisperChunks.push(chunk);
    });
    this.setState('listening');
  }

  /**
   * End the round: stop capture, wait for the final transcript, emit it
   * via `onTranscript` (`partial: false`), and return to idle. The UI
   * inserts the text into the composer — editable, never auto-sent.
   */
  async stop(): Promise<void> {
    if (!this.active) return;
    this.setState('transcribing');

    if (this.mode === 'realtime' && this.session !== undefined) {
      this.session.stopListening();
      const text = await this.waitForFinal();
      if (text !== '') {
        this.onTranscript?.({ partial: false, text });
      } else if (this.lastPartial !== '') {
        // Server never returned a final — degrade to the last partial so
        // the dictated words aren't lost.
        this.onTranscript?.({ partial: false, text: this.lastPartial });
      }
    } else if (this.mode === 'whisper' && this.whisper !== undefined) {
      this.transport.stopCapture();
      try {
        const result = await this.whisper.transcribe(this.whisperChunks);
        if (result.text.trim() !== '') {
          this.onTranscript?.({ partial: false, text: result.text.trim() });
        }
      } catch (err) {
        this.setState('error', `transcription failed — ${errorText(err)}`);
        return;
      }
    }

    this.mode = null;
    this.setState('idle');
    if (this.dropSessionAfterRound) {
      this.dropSessionAfterRound = false;
      this.releaseSession();
    }
  }

  /** Abort without emitting a final transcript (e.g. window closing). */
  cancel(): void {
    this.generation += 1;
    this.awaitingFinal = null;
    this.suppressFinal = true;
    if (this.mode === 'realtime') {
      this.session?.stopListening();
    } else {
      this.transport.stopCapture();
    }
    this.mode = null;
    this.setState('idle');
    if (this.dropSessionAfterRound) {
      this.dropSessionAfterRound = false;
      this.releaseSession();
    }
  }

  /** Close the cached realtime session so the next start() reconnects. */
  private releaseSession(): void {
    this.sessionReady = false;
    void this.session?.disconnect();
  }

  /** Wait for the next final transcript, bounded by {@link finalTimeoutMs}. */
  private waitForFinal(): Promise<string> {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.awaitingFinal = null;
        resolve('');
      }, this.finalTimeoutMs);
      this.awaitingFinal = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
    });
  }

  private setState(state: DictationState, error?: string): void {
    this.state = state;
    this.onUpdate?.(error !== undefined ? { state, error } : { state });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
