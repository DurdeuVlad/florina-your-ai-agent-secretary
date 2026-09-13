/**
 * View model for the Push-to-Talk voice HUD (DEC-002, DEC-028, issue #28).
 *
 * {@link PttHudViewModel} mirrors the voice pipeline's state into a compact,
 * display-ready {@link PttHudState} suitable for an always-on-top overlay HUD.
 * The HUD shows whether the secretary is listening / processing / responding,
 * the active voice mode (realtime / whisper / offline), a live transcript
 * preview, a response preview, and the current hotkey hint.
 *
 * The view model is pure and synchronous: no DOM, no framework, no side
 * effects beyond notifying subscribers. This keeps the HUD logic fully
 * testable with vitest and identical across rendering surfaces (desktop
 * webview, TUI, overlay window).
 *
 * Per DEC-002, voice is core to the product identity — the HUD is the visual
 * surface that supports voice, not the other way around (DEC-006). Per
 * DEC-028, the desktop app provides native OS integration: global
 * push-to-talk hotkeys and a floating voice HUD.
 */
import { VoiceSessionState } from '../../../../core/application/ports/outbound/voice.js';
import type {
  VoicePipelineMode,
  VoicePipelineState,
} from '../../../../core/application/use-cases/voice/voice-pipeline.js';

/* ------------------------------------------------------------------ *
 * PttHudState
 * ------------------------------------------------------------------ */

/**
 * The display state for the push-to-talk HUD.
 *
 * All fields are readonly primitives so the whole state is JSON-serializable
 * and can cross the IPC boundary to the renderer verbatim.
 */
export interface PttHudState {
  /** Whether the microphone is currently active (user is speaking). */
  readonly isListening: boolean;
  /** Whether the AI is currently processing the user's speech. */
  readonly isProcessing: boolean;
  /** Whether the AI is currently responding (TTS playing). */
  readonly isResponding: boolean;
  /** Which voice engine is currently active. */
  readonly voiceMode: VoicePipelineMode;
  /** Live (possibly partial) transcript of the user's speech. */
  readonly currentTranscript: string;
  /** Preview of the AI's current response text. */
  readonly responsePreview: string;
  /** Keyboard shortcut hint shown to the user (e.g. "Hold ⌘␣ to talk"). */
  readonly hotkeyHint: string;
}

/** The initial / reset HUD state (nothing active, offline). */
export const DEFAULT_PTT_HUD_STATE: PttHudState = {
  isListening: false,
  isProcessing: false,
  isResponding: false,
  voiceMode: 'offline',
  currentTranscript: '',
  responsePreview: '',
  hotkeyHint: '',
};

/** Callback invoked when the HUD state changes. */
export type PttHudStateCallback = (state: PttHudState) => void;

/* ------------------------------------------------------------------ *
 * PttHudViewModel
 * ------------------------------------------------------------------ */

/**
 * Manages the push-to-talk HUD display state.
 *
 * Construct a view model, then drive it with {@link update} whenever the
 * voice pipeline emits a new {@link VoicePipelineState}. The boolean
 * listening / processing / responding flags and the `voiceMode` are derived
 * from the pipeline state; the transcript, response preview, and hotkey hint
 * are set via their dedicated setters (they come from streaming events and
 * UI configuration, not the pipeline snapshot).
 *
 * Subscribers registered via {@link onStateChange} are notified with a deep
 * copy of the new state on every change.
 */
export class PttHudViewModel {
  private state: PttHudState;
  private readonly subscribers = new Set<PttHudStateCallback>();

  constructor(initial: PttHudState = DEFAULT_PTT_HUD_STATE) {
    this.state = { ...initial };
  }

  /**
   * Update the HUD state from a voice pipeline snapshot.
   *
   * Derives `voiceMode` and the listening / processing / responding flags
   * from the pipeline state. When the pipeline is `offline`, all activity
   * flags are cleared. The transcript, response preview, and hotkey hint are
   * preserved across the update (use their dedicated setters to change
   * them). Notifies subscribers if the resulting state differs.
   *
   * @param pipelineState - The current voice pipeline state.
   * @returns The new HUD state (a copy).
   */
  update(pipelineState: VoicePipelineState): PttHudState {
    const { isListening, isProcessing, isResponding } = deriveActivityFlags(pipelineState);
    const next: PttHudState = {
      ...this.state,
      voiceMode: pipelineState.mode,
      isListening,
      isProcessing,
      isResponding,
    };
    return this.commit(next);
  }

  /**
   * Set the live transcript preview. Pass an empty string to clear it.
   * Notifies subscribers if the value changed.
   */
  setTranscript(text: string): PttHudState {
    return this.commit({ ...this.state, currentTranscript: text });
  }

  /**
   * Set the AI response preview. Pass an empty string to clear it.
   * Notifies subscribers if the value changed.
   */
  setResponsePreview(text: string): PttHudState {
    return this.commit({ ...this.state, responsePreview: text });
  }

  /**
   * Set the keyboard shortcut hint shown to the user
   * (e.g. "Hold ⌘␣ to talk"). Notifies subscribers if the value changed.
   */
  setHotkeyHint(hint: string): PttHudState {
    return this.commit({ ...this.state, hotkeyHint: hint });
  }

  /**
   * Reset the HUD to {@link DEFAULT_PTT_HUD_STATE} and notify subscribers.
   */
  reset(): PttHudState {
    return this.commit({ ...DEFAULT_PTT_HUD_STATE });
  }

  /** Returns a copy of the current HUD state. */
  getState(): PttHudState {
    return { ...this.state };
  }

  /**
   * Subscribe to HUD state changes. The callback is invoked with a copy of
   * the state on every change. Returns an unsubscribe function.
   */
  onStateChange(callback: PttHudStateCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /* ---------------------------------------------------------------- *
   * Internal
   * ---------------------------------------------------------------- */

  /**
   * Commit a new state: only notify subscribers when the state actually
   * changed (shallow field-wise comparison). Returns a copy of the new
   * state.
   */
  private commit(next: PttHudState): PttHudState {
    const changed = !shallowEqualPttHudState(this.state, next);
    this.state = next;
    if (changed) {
      const snap = { ...next };
      for (const cb of this.subscribers) {
        try {
          cb(snap);
        } catch {
          // A subscriber throwing must not break other subscribers.
        }
      }
    }
    return { ...next };
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/**
 * Derive the listening / processing / responding activity flags from a
 * voice pipeline snapshot.
 *
 * In `realtime` mode the flags map directly to the bridge session state. In
 * `whisper` mode the bridge state is not meaningful (the bridge may be
 * disconnected), so only `isListening` is surfaced when the whisper fallback
 * is the active engine and the bridge is not in an active realtime state —
 * whisper is a capture-then-transcribe path, so the HUD shows "listening"
 * while a whisper capture is implied. In `offline` mode all flags are false.
 */
function deriveActivityFlags(pipelineState: VoicePipelineState): {
  isListening: boolean;
  isProcessing: boolean;
  isResponding: boolean;
} {
  const { mode, realtimeState } = pipelineState;
  if (mode === 'offline') {
    return { isListening: false, isProcessing: false, isResponding: false };
  }
  if (mode === 'whisper') {
    // Whisper is a capture-then-transcribe path; surface listening while
    // the realtime bridge is not actively processing/responding.
    const realtimeBusy =
      realtimeState === VoiceSessionState.Processing ||
      realtimeState === VoiceSessionState.Responding;
    return {
      isListening: !realtimeBusy,
      isProcessing: realtimeState === VoiceSessionState.Processing,
      isResponding: realtimeState === VoiceSessionState.Responding,
    };
  }
  // realtime mode — map directly to the bridge session state.
  return {
    isListening: realtimeState === VoiceSessionState.Listening,
    isProcessing: realtimeState === VoiceSessionState.Processing,
    isResponding: realtimeState === VoiceSessionState.Responding,
  };
}

/** Shallow, field-wise equality check for two {@link PttHudState} values. */
function shallowEqualPttHudState(a: PttHudState, b: PttHudState): boolean {
  return (
    a.isListening === b.isListening &&
    a.isProcessing === b.isProcessing &&
    a.isResponding === b.isResponding &&
    a.voiceMode === b.voiceMode &&
    a.currentTranscript === b.currentTranscript &&
    a.responsePreview === b.responsePreview &&
    a.hotkeyHint === b.hotkeyHint
  );
}
