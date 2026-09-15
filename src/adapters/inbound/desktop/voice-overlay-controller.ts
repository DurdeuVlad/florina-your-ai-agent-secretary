/**
 * Full-window immersive voice-mode overlay (issue #182, mockup
 * `docs/mockups/voice-overlay.html`).
 *
 * A distinct, larger takeover surface from the small always-on-top PTT HUD
 * pill (`hud-controller.ts`) — matching the ChatGPT-desktop reference
 * decided in milestone planning. Engages only while two-way voice mode
 * (DG-01 §5) is active; the small HUD keeps serving as the idle/hold-to-
 * talk affordance and keeps working with the main window closed.
 *
 * Deliberately reuses the SAME {@link PttHudViewModel} instance as
 * `HudController` (single source of truth for listening/processing/
 * responding) instead of a second state machine, and the same `hud:state`
 * IPC channel — this is a second render target for existing state, not a
 * new one.
 */
import { IpcBridge } from './ipc-bridge.js';
import type { IpcTransport } from './ipc-bridge.js';
import type { WindowBackend } from './window-backend.js';
import type { PttHudViewModel, PttHudState } from './views/ptt-hud.js';

/** Options for constructing a {@link VoiceOverlayController}. */
export interface VoiceOverlayControllerOptions {
  /** Window backend for the dedicated overlay window. */
  readonly window: WindowBackend;
  /** IPC transport the `hud:state` pushes are sent over. */
  readonly ipc: IpcTransport;
  /** The HUD pill's view model — shared, not duplicated. */
  readonly viewModel: PttHudViewModel;
  /** Absolute path to the bundled `voice-overlay.html`. */
  readonly overlayHtmlPath?: string;
}

/** Overlay geometry: a large centered card, per the ChatGPT-desktop reference. */
const OVERLAY_WINDOW = {
  width: 480,
  height: 480,
  title: 'Florina Voice',
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  resizable: false,
  skipTaskbar: true,
} as const;

/**
 * Orchestrates the full-window voice-mode overlay: create it lazily on
 * first {@link show}, mirror the shared view model's state into it while
 * visible, and hide (never destroy) it on {@link hide} so re-engaging
 * voice mode doesn't pay window-creation cost every turn.
 */
export class VoiceOverlayController {
  private readonly window: WindowBackend;
  private readonly bridge: IpcBridge;
  private readonly vm: PttHudViewModel;
  private readonly overlayHtmlPath?: string;
  private created = false;
  private visible = false;
  private unsubscribe: (() => void) | null = null;

  constructor(options: VoiceOverlayControllerOptions) {
    this.window = options.window;
    this.bridge = new IpcBridge(options.ipc);
    this.vm = options.viewModel;
    this.overlayHtmlPath = options.overlayHtmlPath;
  }

  /** Whether the overlay is currently shown. */
  get isVisible(): boolean {
    return this.visible;
  }

  /** Show the overlay for an active voice-mode turn. Idempotent. */
  show(): void {
    if (this.visible) return;
    this.visible = true;
    if (!this.created) {
      this.created = true;
      this.window.on('ready-to-show', () => {
        this.window.show();
        this.pushState(this.vm.getState());
      });
      this.window.createWindow({ ...OVERLAY_WINDOW });
      if (this.overlayHtmlPath !== undefined) this.window.loadFile(this.overlayHtmlPath);
    } else {
      this.window.show();
      this.pushState(this.vm.getState());
    }
    this.unsubscribe = this.vm.onStateChange((state) => this.pushState(state));
  }

  /** Hide the overlay when voice mode ends — the window survives for reuse. */
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!this.window.isClosed()) this.window.hide();
  }

  /** Close the overlay window and detach the IPC bridge. */
  stop(): void {
    this.hide();
    this.bridge.dispose();
    if (this.created && !this.window.isClosed()) this.window.close();
  }

  private pushState(state: PttHudState): void {
    this.bridge.sendToRenderer('hud:state', state);
  }
}
