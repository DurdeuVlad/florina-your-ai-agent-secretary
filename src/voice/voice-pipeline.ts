/**
 * Voice pipeline — orchestrates realtime (primary) + whisper (fallback)
 * (DEC-021).
 *
 * {@link VoicePipeline} wraps a {@link RealtimeBridge} (the sub-second
 * OpenAI Realtime path) and a {@link WhisperAdapter} (the local whisper.cpp
 * fallback). It presents a single unified transcript callback regardless of
 * which engine is active, and automatically fails over to whisper when the
 * realtime connection drops, then recovers back to realtime once the
 * connection is re-established.
 *
 * State machine:
 * ```
 * offline -> realtime (primary) -> whisper (fallback on disconnect)
 *                                -> realtime (recovery on reconnect)
 * ```
 */
import type { AudioChunk } from './audio-types.js';
import { VoiceSessionState } from './audio-types.js';
import type { RealtimeBridge } from './realtime-bridge.js';
import type { WhisperAdapter } from './whisper-adapter.js';
import type { TranscriptResult } from './whisper-adapter.js';

/* ================================================================== *
 * Pipeline mode + state
 * ================================================================== */

/**
 * Which STT engine is currently active.
 *
 * - `realtime` — OpenAI Realtime API (primary, sub-second).
 * - `whisper`  — local whisper.cpp fallback (offline, higher latency).
 * - `offline`  — neither engine is available / started.
 */
export type VoicePipelineMode = 'realtime' | 'whisper' | 'offline';

/**
 * Snapshot of the voice pipeline's current mode and underlying session state.
 */
export interface VoicePipelineState {
  /** Which engine is currently producing transcripts. */
  readonly mode: VoicePipelineMode;
  /** The RealtimeBridge session state (when in realtime mode). */
  readonly realtimeState: VoiceSessionState;
  /** Whether the realtime connection is currently open. */
  readonly realtimeConnected: boolean;
  /** Whether the whisper fallback has been initialized. */
  readonly whisperAvailable: boolean;
}

/* ================================================================== *
 * Unified transcript event
 * ================================================================== */

/**
 * A unified transcript event emitted by the pipeline regardless of mode.
 *
 * `source` indicates which engine produced the text. In `realtime` mode the
 * pipeline forwards the bridge's streaming {@link TranscriptEvent}s directly.
 * In `whisper` mode it emits a single final event per `transcribe` call.
 */
export interface PipelineTranscriptEvent {
  /** Which engine produced this transcript. */
  readonly source: VoicePipelineMode;
  /** Whether this is a partial (interim) or final transcript. */
  readonly partial: boolean;
  /** The transcribed text. */
  readonly text: string;
  /** Confidence in [0, 1] (whisper mode only; 1.0 for realtime). */
  readonly confidence: number;
}

export type PipelineTranscriptCallback = (event: PipelineTranscriptEvent) => void;
export type PipelineModeCallback = (mode: VoicePipelineMode) => void;

/* ================================================================== *
 * Pipeline options
 * ================================================================== */

/**
 * Configuration for {@link VoicePipeline}.
 */
export interface VoicePipelineOptions {
  /**
   * Interval in ms at which the pipeline attempts to recover the realtime
   * connection while in whisper fallback mode (default 10s).
   */
  readonly recoveryIntervalMs?: number;
  /**
   * Whether to attempt automatic failover to whisper when realtime
   * disconnects (default true).
   */
  readonly autoFailover?: boolean;
  /**
   * Whether to attempt automatic recovery back to realtime once it is
   * available again (default true).
   */
  readonly autoRecover?: boolean;
}

const DEFAULT_RECOVERY_INTERVAL_MS = 10_000;

/* ================================================================== *
 * VoicePipeline
 * ================================================================== */

/**
 * Orchestrates the realtime primary and whisper fallback voice paths.
 *
 * Construct with a {@link RealtimeBridge} and a {@link WhisperAdapter}, then
 * call {@link VoicePipeline.start} to enter realtime mode. Register a unified
 * transcript callback via {@link VoicePipeline.onTranscript}. The pipeline
 * monitors the bridge's connection state and automatically switches to the
 * whisper fallback on disconnect, then back to realtime on recovery.
 */
export class VoicePipeline {
  private readonly bridge: RealtimeBridge;
  private readonly whisper: WhisperAdapter;
  private readonly recoveryIntervalMs: number;
  private readonly autoFailover: boolean;
  private readonly autoRecover: boolean;

  private mode: VoicePipelineMode = 'offline';
  private recoveryTimer: NodeJS.Timeout | null = null;
  private unsubBridgeTranscript: (() => void) | null = null;
  private unsubBridgeState: (() => void) | null = null;

  private readonly transcriptCallbacks: PipelineTranscriptCallback[] = [];
  private readonly modeCallbacks: PipelineModeCallback[] = [];

  constructor(
    bridge: RealtimeBridge,
    whisper: WhisperAdapter,
    options?: VoicePipelineOptions,
  ) {
    this.bridge = bridge;
    this.whisper = whisper;
    this.recoveryIntervalMs =
      options?.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
    this.autoFailover = options?.autoFailover ?? true;
    this.autoRecover = options?.autoRecover ?? true;
  }

  /* ---------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------- */

  /** Current pipeline mode. */
  get currentMode(): VoicePipelineMode {
    return this.mode;
  }

  /** Whether the realtime connection is currently open. */
  get realtimeConnected(): boolean {
    return this.bridge.isConnected;
  }

  /**
   * Start the pipeline in realtime mode. Wires bridge callbacks and enters
   * `realtime` mode. The caller is responsible for having connected the
   * bridge (via `bridge.connect`) beforehand, or may pass `connect` options
   * to have the pipeline connect it.
   */
  async start(): Promise<void> {
    this.wireBridge();
    this.setMode('realtime');
  }

  /**
   * Register a unified transcript callback. Fires for both realtime
   * (streaming) and whisper (final) transcripts. Returns an unsubscribe fn.
   */
  onTranscript(callback: PipelineTranscriptCallback): () => void {
    this.transcriptCallbacks.push(callback);
    return () => this.removeListener(this.transcriptCallbacks, callback);
  }

  /**
   * Register a callback fired whenever the pipeline mode changes
   * (realtime <-> whisper <-> offline). Returns an unsubscribe fn.
   */
  onModeChange(callback: PipelineModeCallback): () => void {
    this.modeCallbacks.push(callback);
    return () => this.removeListener(this.modeCallbacks, callback);
  }

  /**
   * Snapshot of the current pipeline state.
   */
  getState(): VoicePipelineState {
    return {
      mode: this.mode,
      realtimeState: this.bridge.currentState,
      realtimeConnected: this.bridge.isConnected,
      whisperAvailable: this.whisper.isInitialized,
    };
  }

  /**
   * Transcribe a batch of audio chunks using the whisper fallback, emitting a
   * unified transcript event. Useful when the pipeline is in whisper mode or
   * when the caller wants an offline transcription regardless of mode.
   */
  async transcribeWithWhisper(chunks: readonly AudioChunk[]): Promise<TranscriptResult> {
    const result = await this.whisper.transcribe(chunks);
    this.emitTranscript({
      source: 'whisper',
      partial: false,
      text: result.text,
      confidence: result.confidence,
    });
    return result;
  }

  /**
   * Manually force the pipeline into whisper fallback mode (e.g. when the
   * user opts for the local/offline privacy path). Stops the recovery timer.
   */
  switchToWhisper(): void {
    this.stopRecoveryTimer();
    this.setMode('whisper');
  }

  /**
   * Manually attempt to recover back to realtime mode. Starts the recovery
   * probe if the bridge is not currently connected.
   */
  attemptRecovery(): void {
    if (this.bridge.isConnected) {
      this.setMode('realtime');
      this.stopRecoveryTimer();
    } else {
      this.startRecoveryTimer();
    }
  }

  /**
   * Shut down the pipeline: unwires bridge callbacks, stops the recovery
   * timer, and leaves the pipeline in `offline` mode. Does not disconnect the
   * bridge or close the whisper adapter — the caller owns those lifecycles.
   */
  stop(): void {
    this.unsubBridgeTranscript?.();
    this.unsubBridgeState?.();
    this.unsubBridgeTranscript = null;
    this.unsubBridgeState = null;
    this.stopRecoveryTimer();
    this.setMode('offline');
  }

  /* ---------------------------------------------------------------- *
   * Bridge wiring + failover
   * ---------------------------------------------------------------- */

  /** Wire bridge transcript + state callbacks for unified emission / failover. */
  private wireBridge(): void {
    if (this.unsubBridgeTranscript !== null) {
      return;
    }
    this.unsubBridgeTranscript = this.bridge.onTranscript((event) => {
      // Forward realtime transcripts through the unified callback.
      this.emitTranscript({
        source: 'realtime',
        partial: event.partial,
        text: event.text,
        confidence: 1,
      });
    });
    this.unsubBridgeState = this.bridge.onStateChange((event) => {
      this.handleBridgeStateChange(event.to);
    });
  }

  /**
   * React to a RealtimeBridge state transition: fail over to whisper on
   * disconnect / error, recover to realtime when reconnected.
   */
  private handleBridgeStateChange(next: VoiceSessionState): void {
    if (next === VoiceSessionState.Error || !this.bridge.isConnected) {
      // Realtime connection lost — fail over to whisper.
      if (this.autoFailover && this.mode === 'realtime') {
        this.setMode('whisper');
        if (this.autoRecover) {
          this.startRecoveryTimer();
        }
      }
      return;
    }
    // Bridge is connected (Idle / Listening / etc.) — recover to realtime.
    if (
      this.autoRecover &&
      this.mode === 'whisper' &&
      this.bridge.isConnected
    ) {
      this.stopRecoveryTimer();
      this.setMode('realtime');
    }
  }

  /* ---------------------------------------------------------------- *
   * Recovery timer
   * ---------------------------------------------------------------- */

  /** Start the periodic realtime-recovery probe (only if not already running). */
  private startRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      return;
    }
    this.recoveryTimer = setInterval(() => {
      if (this.bridge.isConnected) {
        this.stopRecoveryTimer();
        this.setMode('realtime');
      }
    }, this.recoveryIntervalMs);
    // Don't keep the process alive solely for the recovery probe.
    this.recoveryTimer.unref?.();
  }

  private stopRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /* ---------------------------------------------------------------- *
   * Mode + emission helpers
   * ---------------------------------------------------------------- */

  private setMode(mode: VoicePipelineMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    for (const cb of this.modeCallbacks) {
      cb(mode);
    }
  }

  private emitTranscript(event: PipelineTranscriptEvent): void {
    for (const cb of this.transcriptCallbacks) {
      cb(event);
    }
  }

  private removeListener<T>(list: T[], item: T): void {
    const idx = list.indexOf(item);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
  }
}
