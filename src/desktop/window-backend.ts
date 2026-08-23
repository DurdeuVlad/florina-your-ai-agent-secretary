/**
 * Window backend abstraction for the desktop client (DEC-028, issue #24).
 *
 * The {@link WindowBackend} interface abstracts over the concrete windowing
 * runtime — Electron `BrowserWindow` or Tauri `WebviewWindow` — so the
 * desktop skeleton can be built and tested without installing either as a
 * real dependency. A real integration later supplies an adapter that
 * implements this interface against the chosen runtime.
 *
 * {@link MockWindowBackend} is an in-memory implementation used by tests and
 * by {@link DesktopApp} when no real window runtime is present. It records
 * every call so tests can assert on window lifecycle behaviour.
 */

/** Window bounds (position + size) in device pixels. */
export interface WindowBounds {
  /** X coordinate of the top-left corner, in pixels from the screen origin. */
  readonly x: number;
  /** Y coordinate of the top-left corner, in pixels from the screen origin. */
  readonly y: number;
  /** Window width in pixels. */
  readonly width: number;
  /** Window height in pixels. */
  readonly height: number;
}

/** Options passed to {@link WindowBackend.createWindow}. */
export interface WindowOptions {
  /** Initial window width in pixels (default 800). */
  readonly width?: number;
  /** Initial window height in pixels (default 600). */
  readonly height?: number;
  /** Window title. */
  readonly title?: string;
  /** Whether the window is user-resizable (default true). */
  readonly resizable?: boolean;
  /** Whether the window has a frame/chrome (default true). */
  readonly frame?: boolean;
  /** Whether the window background is transparent (default false). */
  readonly transparent?: boolean;
  /** Whether the window stays on top of all other windows (default false). */
  readonly alwaysOnTop?: boolean;
  /** Whether to skip showing the window in the taskbar (default false). */
  readonly skipTaskbar?: boolean;
}

/** Window lifecycle / interaction events emitted by a {@link WindowBackend}. */
export type WindowEvent =
  | 'ready-to-show'
  | 'close'
  | 'closed'
  | 'show'
  | 'hide'
  | 'focus'
  | 'blur'
  | 'resize'
  | 'move';

/** Callback invoked when a window event fires. */
export type WindowEventHandler = (...args: unknown[]) => void;

/**
 * Pluggable abstraction over an Electron `BrowserWindow` or Tauri
 * `WebviewWindow`. The desktop skeleton programs against this interface so
 * it never imports a real windowing runtime directly.
 *
 * A single instance represents one window. Implementations are expected to
 * be cheap to construct; {@link DesktopApp} creates the window via
 * {@link createWindow} during startup.
 */
export interface WindowBackend {
  /** Create the underlying window with the given options. */
  createWindow(options?: WindowOptions): void;
  /** Navigate the window to a URL (e.g. a bundled dev-server URL). */
  loadURL(url: string): void;
  /** Load a local HTML file from the filesystem. */
  loadFile(path: string): void;
  /** Close the window (emits `close` then `closed`). */
  close(): void;
  /** Register a handler for a window event. Returns an unsubscribe function. */
  on(event: WindowEvent, callback: WindowEventHandler): () => void;
  /** Show the window (emits `show`). */
  show(): void;
  /** Hide the window (emits `hide`). */
  hide(): void;
  /** Set the window's position and size. */
  setBounds(bounds: WindowBounds): void;
  /** Get the window's current position and size. */
  getBounds(): WindowBounds;
  /** Whether the window is currently visible. */
  isVisible(): boolean;
  /** Whether the window has been closed and is no longer usable. */
  isClosed(): boolean;
}

/** Default window options used when none are supplied. */
export const DEFAULT_WINDOW_OPTIONS: WindowOptions = {
  width: 800,
  height: 600,
  title: 'Agent Secretary',
  resizable: true,
  frame: true,
  transparent: false,
  alwaysOnTop: false,
  skipTaskbar: false,
};

/** Default window bounds (centered-ish, 800x600). */
export const DEFAULT_WINDOW_BOUNDS: WindowBounds = {
  x: 100,
  y: 100,
  width: 800,
  height: 600,
};

/**
 * In-memory {@link WindowBackend} implementation for tests and headless use.
 *
 * No real OS window is created. Every mutating call is recorded in a log so
 * tests can assert on the sequence of operations. Event handlers registered
 * via {@link on} are invoked synchronously when the corresponding action is
 * taken (e.g. {@link close} fires `close` then `closed`).
 */
export class MockWindowBackend implements WindowBackend {
  private visible = false;
  private closed = false;
  private bounds: WindowBounds = { ...DEFAULT_WINDOW_BOUNDS };
  private options: WindowOptions = { ...DEFAULT_WINDOW_OPTIONS };
  private loadedURL: string | null = null;
  private loadedFile: string | null = null;
  private readonly handlers = new Map<WindowEvent, Set<WindowEventHandler>>();
  /** Ordered log of operations performed on this window. */
  readonly log: string[] = [];

  createWindow(options: WindowOptions = DEFAULT_WINDOW_OPTIONS): void {
    if (this.closed) {
      throw new Error('Cannot create window on a closed MockWindowBackend');
    }
    this.options = { ...DEFAULT_WINDOW_OPTIONS, ...options };
    this.bounds = {
      x: DEFAULT_WINDOW_BOUNDS.x,
      y: DEFAULT_WINDOW_BOUNDS.y,
      width: this.options.width ?? DEFAULT_WINDOW_BOUNDS.width,
      height: this.options.height ?? DEFAULT_WINDOW_BOUNDS.height,
    };
    this.log.push(`createWindow:${this.options.title ?? 'untitled'}`);
    // Emit ready-to-show so the app can call show().
    this.emit('ready-to-show');
  }

  loadURL(url: string): void {
    this.assertNotClosed('loadURL');
    this.loadedURL = url;
    this.loadedFile = null;
    this.log.push(`loadURL:${url}`);
  }

  loadFile(path: string): void {
    this.assertNotClosed('loadFile');
    this.loadedFile = path;
    this.loadedURL = null;
    this.log.push(`loadFile:${path}`);
  }

  close(): void {
    if (this.closed) return;
    this.log.push('close');
    this.emit('close');
    this.visible = false;
    this.closed = true;
    this.emit('closed');
  }

  on(event: WindowEvent, callback: WindowEventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(callback);
    return () => {
      const s = this.handlers.get(event);
      if (s) s.delete(callback);
    };
  }

  show(): void {
    this.assertNotClosed('show');
    this.visible = true;
    this.log.push('show');
    this.emit('show');
  }

  hide(): void {
    this.assertNotClosed('hide');
    this.visible = false;
    this.log.push('hide');
    this.emit('hide');
  }

  setBounds(bounds: WindowBounds): void {
    this.assertNotClosed('setBounds');
    this.bounds = { ...bounds };
    this.log.push(`setBounds:${bounds.width}x${bounds.height}`);
    this.emit('resize');
    this.emit('move');
  }

  getBounds(): WindowBounds {
    return { ...this.bounds };
  }

  isVisible(): boolean {
    return this.visible;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /* ---- test-only introspection helpers ---- */

  /** The URL last passed to {@link loadURL}, or null. */
  get currentURL(): string | null {
    return this.loadedURL;
  }

  /** The file path last passed to {@link loadFile}, or null. */
  get currentFile(): string | null {
    return this.loadedFile;
  }

  /** The options used to create the window. */
  get windowOptions(): WindowOptions {
    return { ...this.options };
  }

  /** Emit an event to all registered handlers for that event. */
  private emit(event: WindowEvent, ...args: unknown[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      handler(...args);
    }
  }

  private assertNotClosed(action: string): void {
    if (this.closed) {
      throw new Error(`Cannot ${action} on a closed window`);
    }
  }
}
