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
 * Every transition is event-driven — no timers, no polling. The HUD window
 * is independent of the main window so it keeps working while the inbox is
 * closed.
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
  /** Window backend for the overlay (one window per backend instance). */
  readonly window: WindowBackend;
  /** IPC transport attached to the HUD window's contents. */
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
  private readonly window: WindowBackend;
  private readonly bridge: IpcBridge;
  private readonly vm: PttHudViewModel;
  private readonly hudHtmlPath?: string;
  private started = false;

  constructor(options: HudControllerOptions) {
    this.window = options.window;
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
   * Create and show the overlay window, then load the HUD page. Pushes the
   * initial state once the page has had a tick to attach its listeners.
   */
  start(): void {
    if (this.started) return;
    // Register before createWindow — mock backends emit synchronously.
    this.window.on('ready-to-show', () => {
      this.window.show();
      this.pushState(this.vm.getState());
    });
    this.window.createWindow({ ...HUD_WINDOW });
    if (this.hudHtmlPath !== undefined) {
      this.window.loadFile(this.hudHtmlPath);
    }
    this.started = true;
  }

  /**
   * Drive the HUD from the shared renderer state. Daemon connectivity maps
   * to the offline state; the mirrored voice session maps to
   * listening/responding. Safe to call on every {@link DesktopApp} state
   * change — the view model only notifies on real transitions.
   */
  applyRendererState(state: RendererStateData): void {
    const mode: VoicePipelineMode =
      state.daemonStatus !== 'connected'
        ? 'offline'
        : state.voiceState.mode === 'whisper'
          ? 'whisper'
          : 'realtime';
    const realtimeState = state.voiceState.listening
      ? VoiceSessionState.Listening
      : state.voiceState.speaking
        ? VoiceSessionState.Responding
        : VoiceSessionState.Idle;
    this.vm.update({
      mode,
      realtimeState,
      realtimeConnected: state.daemonStatus === 'connected',
      whisperAvailable: mode === 'whisper',
    });
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

  /** Close the overlay and detach the IPC bridge. */
  stop(): void {
    this.bridge.dispose();
    this.window.close();
    this.started = false;
  }

  private pushState(state: PttHudState): void {
    this.bridge.sendToRenderer('hud:state', state);
  }
}
