/**
 * Push-to-talk HUD controller (DEC-028, issue #123, mockup `docs/mockups/hud.html`).
 *
 * Owns the frameless, always-on-top overlay window and drives a
 * {@link PttHudViewModel} from two event sources:
 *
 *  - daemon connection status (disconnected → HUD `offline` state), and
 *  - voice-session state mirrored in the renderer state (`voice:state`
 *    pushes → listening / processing / responding / idle).
 *
 * Every transition is event-driven — no timers, no polling.
 *
 * The HUD can run in two modes:
 *  - **overlay**: own frameless always-on-top window (`window` option), or
 *  - **inline**: no window — `hud:state` pushes go over the supplied IPC
 *    transport, which in the desktop composition is the main window's
 *    transport, so the pill renders inside the app header (#126 feedback:
 *    merged into the main app rather than a separate floating overlay).
 */
import { IpcBridge } from './ipc-bridge.js';
import type { IpcTransport } from './ipc-bridge.js';
import type { RendererStateData, DaemonStatus } from './renderer-state.js';
import type { WindowBackend } from './window-backend.js';
import { PttHudViewModel } from './views/ptt-hud.js';
import type { PttHudState } from './views/ptt-hud.js';
import { VoiceSessionState } from '../../../core/application/ports/outbound/voice.js';
import type { VoicePipelineMode } from '../../../core/application/use-cases/voice/voice-pipeline.js';

/** Options for constructing a {@link HudController}. */
export interface HudControllerOptions {
  /**
   * Window backend for a dedicated overlay window. When omitted the
   * controller runs inline: it creates no window and `hud:state` pushes
   * go over {@link HudControllerOptions.ipc} to whatever renderer is
   * attached there (the main app window in the desktop composition).
   */
  readonly window?: WindowBackend;
  /** IPC transport the `hud:state` pushes are sent over. */
  readonly ipc: IpcTransport;
  /**
   * Absolute path to the bundled `hud.html`. When omitted the window is
   * created but nothing is loaded (tests inject a mock backend).
   */
  readonly hudHtmlPath?: string;
  /** Hotkey hint rendered in the idle state (e.g. "Hold Space to talk"). */
  readonly hotkeyHint?: string;
}

/** HUD window geometry per the mockup (380px card, ~72px tall). */
const HUD_WINDOW = {
  width: 380,
  height: 96,
  title: 'Florina Voice',
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  resizable: false,
  skipTaskbar: true,
} as const;

/**
 * Orchestrates the PTT overlay window: create it, feed the view model from
 * app state changes, and push each {@link PttHudState} to the HUD renderer
 * over the `hud:state` channel.
 */
export class HudController {
  private readonly window: WindowBackend | null;
  private readonly bridge: IpcBridge;
  private readonly vm: PttHudViewModel;
  private readonly hudHtmlPath?: string;
  private lastRendererState: RendererStateData | null = null;
  private localListening = false;
  private started = false;

  constructor(options: HudControllerOptions) {
    this.window = options.window ?? null;
    this.bridge = new IpcBridge(options.ipc);
    this.vm = new PttHudViewModel();
    this.hudHtmlPath = options.hudHtmlPath;
    if (options.hotkeyHint !== undefined) {
      this.vm.setHotkeyHint(options.hotkeyHint);
    }
    this.vm.onStateChange((state) => this.pushState(state));
  }

  /** The underlying view model (test/inspection access). */
  get viewModel(): PttHudViewModel {
    return this.vm;
  }

  /**
   * Local PTT toggle (issue #124): the global hotkey flips the HUD into
   * `listening` even before the voice pipeline emits real session events
   * (#131). A second press releases — the capture is "sent" and the HUD
   * returns to idle. Takes precedence over the mirrored voice state.
   * @returns `true` when the HUD is now listening.
   */
  toggleLocalListening(): boolean {
    return this.setLocalListening(!this.localListening);
  }

  /**
   * Set the local-PTT flag to a known state. Used when a real audio
   * pipeline (dictation / voice talk-turn) drives the HUD — the pill
   * then mirrors actual capture instead of optimistic intent.
   */
  setLocalListening(listening: boolean): boolean {
    if (this.localListening === listening) return this.localListening;
    this.localListening = listening;
    this.refreshFromCurrent();
    return this.localListening;
  }

  /** Whether a local PTT capture is currently held open. */
  get isLocallyListening(): boolean {
    return this.localListening;
  }

  /**
   * Create and show the overlay window, then load the HUD page. Pushes the
   * initial state once the page has had a tick to attach its listeners.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.window === null) return; // inline mode — no overlay window
    // Register before createWindow — mock backends emit synchronously.
    this.window.on('ready-to-show', () => {
      this.window?.show();
      this.pushState(this.vm.getState());
    });
    this.window.createWindow({ ...HUD_WINDOW });
    if (this.hudHtmlPath !== undefined) {
      this.window.loadFile(this.hudHtmlPath);
    }
  }

  /**
   * Drive the HUD from the shared renderer state. Daemon connectivity maps
   * to the offline state; the mirrored voice session maps to
   * listening/responding. Safe to call on every {@link DesktopApp} state
   * change — the view model only notifies on real transitions.
   */
  applyRendererState(state: RendererStateData): void {
    this.lastRendererState = state;
    this.refreshFromCurrent();
  }

  /** Recompute the view model from the last renderer state + local PTT flag. */
  private refreshFromCurrent(): void {
    const state = this.lastRendererState;
    if (state === null) return;
    const mode: VoicePipelineMode =
      state.daemonStatus !== 'connected'
        ? 'offline'
        : state.voiceState.mode === 'whisper'
          ? 'whisper'
          : 'realtime';
    // A dropped daemon can't hold a capture — clear the local flag so it
    // doesn't resurface on reconnect.
    if (mode === 'offline') this.localListening = false;
    // Five-state mapping (issue #131): offline < daemon drop; listening <
    // capture held (local PTT or reported); processing < request in
    // flight; responding < reply streaming; idle otherwise.
    const realtimeState =
      this.localListening || state.voiceState.listening
        ? VoiceSessionState.Listening
        : state.voiceState.processing
          ? VoiceSessionState.Processing
          : state.voiceState.speaking
            ? VoiceSessionState.Responding
            : VoiceSessionState.Idle;
    this.vm.update({
      mode,
      realtimeState,
      realtimeConnected: state.daemonStatus === 'connected',
      whisperAvailable: mode === 'whisper',
    });
    // Transcript partials/finals and reply previews stream into the
    // HUD's two-line area.
    this.vm.setTranscript(state.voiceState.transcript ?? '');
    this.vm.setResponsePreview(state.voiceState.responsePreview ?? '');
  }

  /** Update the daemon status directly (shortcut for {@link applyRendererState}). */
  applyDaemonStatus(status: DaemonStatus): void {
    this.vm.update({
      mode: status === 'connected' ? 'realtime' : 'offline',
      realtimeState: VoiceSessionState.Idle,
      realtimeConnected: status === 'connected',
      whisperAvailable: false,
    });
  }

  /** Stream a (partial) transcript into the HUD. */
  setTranscript(text: string): void {
    this.vm.setTranscript(text);
  }

  /** Stream the secretary's reply preview into the HUD. */
  setResponsePreview(text: string): void {
    this.vm.setResponsePreview(text);
  }

  /**
   * Force-push the current state to the HUD renderer. Used on
   * `did-finish-load` — the initial `ready-to-show` push can race the page
   * load, and the view model's dedup would otherwise leave a stale default
   * frame (e.g. "offline" while the daemon is connected).
   */
  refresh(): void {
    this.pushState(this.vm.getState());
  }

  /** Current HUD state snapshot. */
  getState(): PttHudState {
    return this.vm.getState();
  }

  /** Close the overlay (if any) and detach the IPC bridge. */
  stop(): void {
    this.bridge.dispose();
    this.window?.close();
    this.started = false;
  }

  private pushState(state: PttHudState): void {
    this.bridge.sendToRenderer('hud:state', state);
  }
}
