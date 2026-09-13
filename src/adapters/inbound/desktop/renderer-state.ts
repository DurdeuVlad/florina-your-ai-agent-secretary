/**
 * Renderer view-state manager for the desktop client (DEC-028, issue #24).
 *
 * The desktop app is a strict client of the daemon — it holds no business
 * logic, only a view-state mirror of daemon state (inbox, tasks, metrics,
 * voice). {@link RendererState} is the single source of truth for what the
 * renderer renders. It is updated by messages arriving over the
 * {@link IpcBridge} and notifies subscribers (the DesktopApp, React/Vue
 * components, etc.) on every change.
 *
 * State is kept as plain JSON-serializable objects so it can be shipped to
 * the renderer verbatim. {@link snapshot} returns a deep copy so consumers
 * cannot mutate the internal state.
 */

import type {
  AttentionItemSnapshot,
  TaskSnapshot,
} from '../../../core/application/use-cases/tasks/command-api.js';
import type { MetricsSnapshot } from '../../../core/application/use-cases/metrics.js';

/** Voice pipeline state mirrored from the daemon. */
export interface VoiceState {
  /** Whether the voice pipeline is currently listening. */
  readonly listening: boolean;
  /** Whether a TTS utterance is currently playing. */
  readonly speaking: boolean;
  /** Whether the microphone is muted. */
  readonly muted: boolean;
  /** Currently-active wake-word/transport mode label, if any. */
  readonly mode?: string;
}

/** The current renderer view (which screen is shown). */
export type RendererView = 'inbox' | 'task' | 'digest' | 'metrics' | 'settings';

/** Daemon connection status surfaced to the UI. */
export type DaemonStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** The full renderer view-state. */
export interface RendererStateData {
  /** Whether the desktop app is connected to the daemon. */
  readonly connected: boolean;
  /** Coarse daemon connection status for UI badges. */
  readonly daemonStatus: DaemonStatus;
  /** Current attention inbox items (mirrored from daemon). */
  readonly inboxItems: readonly AttentionItemSnapshot[];
  /** The currently-focused task, if any. */
  readonly activeTask: TaskSnapshot | null;
  /** Latest metrics snapshot mirrored from the daemon. */
  readonly metrics: MetricsSnapshot | null;
  /** Voice pipeline state mirrored from the daemon. */
  readonly voiceState: VoiceState;
  /** Which view is currently displayed in the renderer. */
  readonly currentView: RendererView;
  /** Human-readable error message when daemonStatus is 'error'. */
  readonly error?: string;
}

/** Default voice state (nothing active). */
export const DEFAULT_VOICE_STATE: VoiceState = {
  listening: false,
  speaking: false,
  muted: false,
};

/** The initial / reset state for {@link RendererState}. */
export const DEFAULT_RENDERER_STATE: RendererStateData = {
  connected: false,
  daemonStatus: 'disconnected',
  inboxItems: [],
  activeTask: null,
  metrics: null,
  voiceState: { ...DEFAULT_VOICE_STATE },
  currentView: 'inbox',
};

/** Callback invoked when the renderer state changes. */
export type StateChangeCallback = (state: RendererStateData) => void;

/**
 * Manages the renderer's view-state.
 *
 * State is updated via {@link update}, which merges a partial into the
 * current state, notifies all subscribers, and returns the new state.
 * Subscribers receive a {@link snapshot} (deep copy) so they cannot mutate
 * internal state.
 */
export class RendererState {
  private state: RendererStateData;
  private readonly subscribers = new Set<StateChangeCallback>();

  constructor(initial: RendererStateData = DEFAULT_RENDERER_STATE) {
    this.state = deepClone(initial);
  }

  /**
   * Merge a partial state update. Notifies all subscribers with a deep copy
   * of the new state. Returns the new state (also a deep copy).
   */
  update(partial: Partial<RendererStateData>): RendererStateData {
    const next: RendererStateData = { ...this.state, ...partial };
    this.state = next;
    const snap = this.snapshot();
    this.notify(snap);
    return snap;
  }

  /**
   * Subscribe to state changes. The callback is invoked with a deep copy of
   * the state on every {@link update}. Returns an unsubscribe function.
   */
  subscribe(callback: StateChangeCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** Returns a deep copy of the current state. */
  snapshot(): RendererStateData {
    return deepClone(this.state);
  }

  /** Reset state to {@link DEFAULT_RENDERER_STATE} and notify subscribers. */
  reset(): void {
    this.state = deepClone(DEFAULT_RENDERER_STATE);
    this.notify(this.snapshot());
  }

  /** Notify all subscribers with a snapshot. */
  private notify(snap: RendererStateData): void {
    for (const cb of this.subscribers) {
      try {
        cb(snap);
      } catch {
        // A subscriber throwing must not break other subscribers.
      }
    }
  }
}

/**
 * Structured clone of a JSON-serializable value. Uses `structuredClone` when
 * available (Node >= 17), falling back to JSON round-trip otherwise.
 */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
