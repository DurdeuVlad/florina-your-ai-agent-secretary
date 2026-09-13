/**
 * System tray integration for the desktop app (DEC-028, issue #28).
 *
 * The system tray surfaces daemon connection status and quick actions
 * (start/stop daemon, open inbox, quit) to the user without requiring them
 * to focus the main window. Like {@link WindowBackend}, the concrete tray
 * runtime (Electron `Tray` / Tauri `SystemTray`) is abstracted behind a
 * pluggable {@link TrayBackend} interface so the tray logic is fully testable
 * without a real OS tray.
 *
 * {@link SystemTrayManager} owns the menu construction, status updates, and
 * action dispatch. It is a strict client of the daemon — it holds no business
 * logic, only mirrors connection status and forwards quick-action selections
 * to callbacks supplied by the {@link DesktopApp} orchestrator.
 *
 * Per DEC-028, the desktop app provides native OS integration; the tray is
 * one of those surfaces. Per DEC-011, the tray never widens permissions —
 * quick actions only navigate or quit; they do not auto-approve anything.
 */
import type { DaemonStatus } from './renderer-state.js';

/* ------------------------------------------------------------------ *
 * Tray menu model
 * ------------------------------------------------------------------ */

/**
 * A single tray menu item.
 *
 * Items are plain, JSON-serializable data so the menu can be projected onto
 * any concrete tray runtime. `command` is a string identifier (never a
 * closure) so the whole menu stays serializable and can cross the IPC
 * boundary if needed.
 */
export interface TrayMenuItem {
  /** Stable identifier for this item (also used as the command id). */
  readonly id: string;
  /** Human-readable label shown in the menu. */
  readonly label: string;
  /** Whether the item is currently enabled / clickable. */
  readonly enabled: boolean;
  /** Whether the item is a separator (no label, no command). */
  readonly separator?: boolean;
  /** Whether the item is checked (for toggle-style status rows). */
  readonly checked?: boolean;
  /** Optional icon glyph identifier the runtime maps to its icon set. */
  readonly icon?: string;
  /** Optional semantic color token (e.g. 'green', 'red', 'slate'). */
  readonly color?: string;
}

/** Logical quick-action identifiers raised by the tray menu. */
export type TrayAction = 'start-daemon' | 'stop-daemon' | 'open-inbox' | 'show-window' | 'quit';

/** Callback invoked when the user selects a quick action from the tray. */
export type TrayActionCallback = (action: TrayAction) => void;

/* ------------------------------------------------------------------ *
 * TrayBackend — pluggable OS-level tray
 * ------------------------------------------------------------------ */

/**
 * Pluggable abstraction over an Electron `Tray` or Tauri `SystemTray`.
 *
 * The desktop skeleton programs against this interface so it never imports a
 * real tray runtime directly. Implementations:
 * - **Production**: wraps Electron `Tray` / Tauri `SystemTray`.
 * - **Tests**: {@link MockTrayBackend} records every call in memory.
 *
 * The backend only handles OS-level tray lifecycle and menu projection; the
 * {@link SystemTrayManager} owns menu construction and action dispatch.
 */
export interface TrayBackend {
  /** Create the tray with an initial icon tooltip and menu. */
  create(iconTooltip: string, menu: readonly TrayMenuItem[]): void;
  /** Update the tray icon tooltip text. */
  setTooltip(tooltip: string): void;
  /** Replace the entire tray menu. */
  setMenu(menu: readonly TrayMenuItem[]): void;
  /** Destroy the tray, releasing OS resources. */
  destroy(): void;
  /**
   * Register a handler invoked when the user selects a menu item. The
   * handler receives the item's `id` (which maps to a {@link TrayAction}).
   */
  onSelect(callback: (itemId: string) => void): void;
}

/* ------------------------------------------------------------------ *
 * MockTrayBackend
 * ------------------------------------------------------------------ */

/**
 * In-memory {@link TrayBackend} implementation for tests and headless use.
 *
 * No real OS tray is created. Every mutating call is recorded in a log so
 * tests can assert on the sequence of operations. The current tooltip and
 * menu are introspectable via {@link tooltip} and {@link menu}.
 */
export class MockTrayBackend implements TrayBackend {
  private created = false;
  private destroyed = false;
  private currentTooltip = '';
  private currentMenu: readonly TrayMenuItem[] = [];
  private selectHandler: ((itemId: string) => void) | null = null;
  /** Ordered log of operations performed on this tray. */
  readonly log: string[] = [];

  create(iconTooltip: string, menu: readonly TrayMenuItem[]): void {
    if (this.destroyed) {
      throw new Error('Cannot create tray on a destroyed MockTrayBackend');
    }
    this.created = true;
    this.currentTooltip = iconTooltip;
    this.currentMenu = [...menu];
    this.log.push(`create:${iconTooltip}`);
  }

  setTooltip(tooltip: string): void {
    this.assertNotCreated('setTooltip');
    this.currentTooltip = tooltip;
    this.log.push(`setTooltip:${tooltip}`);
  }

  setMenu(menu: readonly TrayMenuItem[]): void {
    this.assertNotCreated('setMenu');
    this.currentMenu = [...menu];
    this.log.push(`setMenu:${menu.length}items`);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.log.push('destroy');
    this.destroyed = true;
    this.created = false;
    this.selectHandler = null;
  }

  onSelect(callback: (itemId: string) => void): void {
    this.selectHandler = callback;
  }

  /* ---- test-only introspection helpers ---- */

  /** Whether the tray has been created and not yet destroyed. */
  get isActive(): boolean {
    return this.created && !this.destroyed;
  }

  /** Whether the tray has been destroyed. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** The current tooltip text. */
  get tooltip(): string {
    return this.currentTooltip;
  }

  /** A copy of the current menu. */
  get menu(): readonly TrayMenuItem[] {
    return [...this.currentMenu];
  }

  /**
   * Simulate the user clicking a menu item by id. Invokes the registered
   * select handler. No-op if no handler is registered or the id is unknown.
   */
  click(itemId: string): void {
    if (this.selectHandler === null) return;
    this.selectHandler(itemId);
  }

  private assertNotCreated(action: string): void {
    if (!this.created || this.destroyed) {
      throw new Error(`Cannot ${action} on an inactive tray`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * SystemTrayManager
 * ------------------------------------------------------------------ */

/**
 * Manages the system tray lifecycle: menu construction, status updates, and
 * quick-action dispatch.
 *
 * Construct with a {@link TrayBackend} (defaults to a
 * {@link MockTrayBackend}), then call {@link start} to create the tray with
 * an initial menu. Drive status updates via {@link setStatus}. The manager
 * translates {@link DaemonStatus} into a tray tooltip and icon, and rebuilds
 * the menu so quick actions reflect the current connection state (e.g.
 * "Start daemon" is disabled while connected).
 *
 * Quick-action selections are forwarded to the callback supplied via
 * {@link onAction}. The manager performs no business logic — it only
 * translates the menu item id into a {@link TrayAction} and delegates.
 */
export class SystemTrayManager {
  private readonly backend: TrayBackend;
  private status: DaemonStatus = 'disconnected';
  private actionCallback: TrayActionCallback | null = null;

  constructor(backend: TrayBackend = new MockTrayBackend()) {
    this.backend = backend;
  }

  /** Whether the tray has been started and not yet stopped. */
  get isStarted(): boolean {
    return this.backend instanceof MockTrayBackend
      ? (this.backend as MockTrayBackend).isActive
      : true;
  }

  /** The current daemon status mirrored into the tray. */
  get currentStatus(): DaemonStatus {
    return this.status;
  }

  /**
   * Create the tray with an initial menu reflecting the current status.
   * Registers the select handler that translates item ids into
   * {@link TrayAction}s and forwards them to the {@link onAction} callback.
   */
  start(): void {
    this.backend.create(this.tooltipFor(this.status), this.buildMenu());
    this.backend.onSelect((itemId) => this.handleSelect(itemId));
  }

  /** Destroy the tray and release OS resources. */
  stop(): void {
    this.backend.destroy();
  }

  /**
   * Update the daemon connection status. Rebuilds the tooltip and menu so
   * the tray reflects the new state.
   */
  setStatus(status: DaemonStatus): void {
    this.status = status;
    this.backend.setTooltip(this.tooltipFor(status));
    this.backend.setMenu(this.buildMenu());
  }

  /**
   * Register the callback invoked when the user selects a quick action.
   */
  onAction(callback: TrayActionCallback): void {
    this.actionCallback = callback;
  }

  /* ---------------------------------------------------------------- *
   * Internal
   * ---------------------------------------------------------------- */

  /** Translate a menu item id into a {@link TrayAction} and dispatch it. */
  private handleSelect(itemId: string): void {
    const action = itemId as TrayAction;
    if (!isTrayAction(action)) return;
    if (this.actionCallback !== null) {
      this.actionCallback(action);
    }
  }

  /** Build the tray menu for the current status. */
  buildMenu(): readonly TrayMenuItem[] {
    const connected = this.status === 'connected';
    const connecting = this.status === 'connecting';
    const error = this.status === 'error';
    const items: TrayMenuItem[] = [
      {
        id: 'status',
        label: statusLabel(this.status),
        enabled: false,
        icon: statusIcon(this.status),
        color: statusColor(this.status),
      },
      { id: 'sep1', label: '', enabled: false, separator: true },
      {
        id: 'start-daemon',
        label: 'Start daemon',
        enabled: !connected && !connecting,
        icon: 'play',
      },
      {
        id: 'stop-daemon',
        label: 'Stop daemon',
        enabled: connected,
        icon: 'stop',
      },
      { id: 'sep2', label: '', enabled: false, separator: true },
      {
        id: 'open-inbox',
        label: 'Open inbox',
        enabled: connected,
        icon: 'inbox',
      },
      {
        id: 'show-window',
        label: 'Show window',
        enabled: true,
        icon: 'window',
      },
      { id: 'sep3', label: '', enabled: false, separator: true },
      { id: 'quit', label: 'Quit', enabled: true, icon: 'power' },
    ];
    // Surface an error row when the daemon is in an error state.
    if (error) {
      items.splice(2, 0, {
        id: 'error-detail',
        label: 'Connection error — check daemon',
        enabled: false,
        color: 'red',
      });
    }
    return items;
  }

  /** Derive the tray tooltip text for a daemon status. */
  private tooltipFor(status: DaemonStatus): string {
    return `Florina — ${statusLabel(status)}`;
  }
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

/** Type guard: is the string a valid {@link TrayAction}? */
function isTrayAction(value: string): value is TrayAction {
  return (
    value === 'start-daemon' ||
    value === 'stop-daemon' ||
    value === 'open-inbox' ||
    value === 'show-window' ||
    value === 'quit'
  );
}

/** Human-readable label for a daemon status (used in the tray). */
function statusLabel(status: DaemonStatus): string {
  switch (status) {
    case 'connected':
      return 'Daemon: Connected';
    case 'connecting':
      return 'Daemon: Connecting…';
    case 'error':
      return 'Daemon: Error';
    case 'disconnected':
    default:
      return 'Daemon: Disconnected';
  }
}

/** Icon glyph identifier for a daemon status. */
function statusIcon(status: DaemonStatus): string {
  switch (status) {
    case 'connected':
      return 'circle-check';
    case 'connecting':
      return 'circle-dots';
    case 'error':
      return 'circle-x';
    case 'disconnected':
    default:
      return 'circle-slash';
  }
}

/** Semantic color token for a daemon status. */
function statusColor(status: DaemonStatus): string {
  switch (status) {
    case 'connected':
      return 'green';
    case 'connecting':
      return 'amber';
    case 'error':
      return 'red';
    case 'disconnected':
    default:
      return 'slate';
  }
}
