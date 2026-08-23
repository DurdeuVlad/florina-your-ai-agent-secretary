import { describe, it, expect, vi } from 'vitest';

import {
  SystemTrayManager,
  MockTrayBackend,
} from '../src/desktop/system-tray.js';
import type { TrayMenuItem, TrayAction } from '../src/desktop/system-tray.js';

/* ------------------------------------------------------------------ *
 * MockTrayBackend
 * ------------------------------------------------------------------ */
describe('MockTrayBackend', () => {
  it('records create and exposes tooltip/menu', () => {
    const tray = new MockTrayBackend();
    const menu: TrayMenuItem[] = [
      { id: 'quit', label: 'Quit', enabled: true },
    ];
    tray.create('Agent Secretary — Daemon: Disconnected', menu);
    expect(tray.isActive).toBe(true);
    expect(tray.tooltip).toBe('Agent Secretary — Daemon: Disconnected');
    expect(tray.menu).toHaveLength(1);
    expect(tray.log).toContain('create:Agent Secretary — Daemon: Disconnected');
  });

  it('records setTooltip and setMenu', () => {
    const tray = new MockTrayBackend();
    tray.create('initial', []);
    tray.setTooltip('updated');
    tray.setMenu([{ id: 'a', label: 'A', enabled: true }]);
    expect(tray.tooltip).toBe('updated');
    expect(tray.menu).toHaveLength(1);
    expect(tray.log).toContain('setTooltip:updated');
    expect(tray.log).toContain('setMenu:1items');
  });

  it('destroy marks the tray inactive and destroyed', () => {
    const tray = new MockTrayBackend();
    tray.create('initial', []);
    tray.destroy();
    expect(tray.isDestroyed).toBe(true);
    expect(tray.isActive).toBe(false);
    expect(tray.log).toContain('destroy');
  });

  it('click invokes the registered select handler', () => {
    const tray = new MockTrayBackend();
    const handler = vi.fn();
    tray.create('initial', []);
    tray.onSelect(handler);
    tray.click('quit');
    expect(handler).toHaveBeenCalledWith('quit');
  });

  it('click is a no-op when no handler is registered', () => {
    const tray = new MockTrayBackend();
    tray.create('initial', []);
    expect(() => tray.click('quit')).not.toThrow();
  });

  it('throws when mutating an inactive tray', () => {
    const tray = new MockTrayBackend();
    expect(() => tray.setTooltip('x')).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * SystemTrayManager — lifecycle
 * ------------------------------------------------------------------ */
describe('SystemTrayManager lifecycle', () => {
  it('start creates the tray with an initial menu and tooltip', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    expect(backend.isActive).toBe(true);
    expect(backend.tooltip).toContain('Disconnected');
    expect(backend.menu.length).toBeGreaterThan(0);
  });

  it('stop destroys the tray', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.stop();
    expect(backend.isDestroyed).toBe(true);
  });

  it('isStarted reflects backend active state', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    expect(tray.isStarted).toBe(false);
    tray.start();
    expect(tray.isStarted).toBe(true);
    tray.stop();
    expect(tray.isStarted).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * SystemTrayManager — menu construction
 * ------------------------------------------------------------------ */
describe('SystemTrayManager.buildMenu', () => {
  it('includes a disabled status row reflecting the current status', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    const statusItem = backend.menu.find((i) => i.id === 'status');
    expect(statusItem).toBeDefined();
    expect(statusItem!.enabled).toBe(false);
    expect(statusItem!.label).toBe('Daemon: Disconnected');
  });

  it('disables start-daemon while connected', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.setStatus('connected');
    const startItem = backend.menu.find((i) => i.id === 'start-daemon');
    const stopItem = backend.menu.find((i) => i.id === 'stop-daemon');
    expect(startItem!.enabled).toBe(false);
    expect(stopItem!.enabled).toBe(true);
  });

  it('enables start-daemon and disables stop-daemon while disconnected', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.setStatus('disconnected');
    const startItem = backend.menu.find((i) => i.id === 'start-daemon');
    const stopItem = backend.menu.find((i) => i.id === 'stop-daemon');
    expect(startItem!.enabled).toBe(true);
    expect(stopItem!.enabled).toBe(false);
  });

  it('disables start-daemon while connecting', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.setStatus('connecting');
    const startItem = backend.menu.find((i) => i.id === 'start-daemon');
    expect(startItem!.enabled).toBe(false);
  });

  it('offers open-inbox, show-window, and quit quick actions', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    const ids = backend.menu.map((i) => i.id);
    expect(ids).toContain('open-inbox');
    expect(ids).toContain('show-window');
    expect(ids).toContain('quit');
  });

  it('open-inbox is disabled when disconnected and enabled when connected', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    expect(backend.menu.find((i) => i.id === 'open-inbox')!.enabled).toBe(false);
    tray.setStatus('connected');
    expect(backend.menu.find((i) => i.id === 'open-inbox')!.enabled).toBe(true);
  });

  it('show-window and quit are always enabled', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    for (const status of ['disconnected', 'connecting', 'connected', 'error'] as const) {
      tray.setStatus(status);
      expect(backend.menu.find((i) => i.id === 'show-window')!.enabled).toBe(true);
      expect(backend.menu.find((i) => i.id === 'quit')!.enabled).toBe(true);
    }
  });

  it('includes separators between sections', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    const separators = backend.menu.filter((i) => i.separator);
    expect(separators.length).toBeGreaterThanOrEqual(3);
  });

  it('surfaces an error-detail row when status is error', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.setStatus('error');
    const errorItem = backend.menu.find((i) => i.id === 'error-detail');
    expect(errorItem).toBeDefined();
    expect(errorItem!.color).toBe('red');
  });

  it('does not surface an error-detail row when connected', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.setStatus('connected');
    expect(backend.menu.find((i) => i.id === 'error-detail')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * SystemTrayManager — status updates
 * ------------------------------------------------------------------ */
describe('SystemTrayManager.setStatus', () => {
  it('updates the tooltip and menu', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.setStatus('connected');
    expect(backend.tooltip).toContain('Connected');
    expect(backend.menu.find((i) => i.id === 'status')!.label).toBe('Daemon: Connected');
  });

  it('tracks the current status', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.setStatus('connecting');
    expect(tray.currentStatus).toBe('connecting');
  });

  it('uses green color for connected status row', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.setStatus('connected');
    expect(backend.menu.find((i) => i.id === 'status')!.color).toBe('green');
  });

  it('uses red color for error status row', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    tray.setStatus('error');
    expect(backend.menu.find((i) => i.id === 'status')!.color).toBe('red');
  });
});

/* ------------------------------------------------------------------ *
 * SystemTrayManager — quick action dispatch
 * ------------------------------------------------------------------ */
describe('SystemTrayManager quick actions', () => {
  it('dispatches quit when the quit item is clicked', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    const cb = vi.fn<(action: TrayAction) => void>();
    tray.onAction(cb);
    tray.start();
    backend.click('quit');
    expect(cb).toHaveBeenCalledWith('quit');
  });

  it('dispatches start-daemon when clicked', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    const cb = vi.fn<(action: TrayAction) => void>();
    tray.onAction(cb);
    tray.start();
    backend.click('start-daemon');
    expect(cb).toHaveBeenCalledWith('start-daemon');
  });

  it('dispatches stop-daemon when clicked', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    const cb = vi.fn<(action: TrayAction) => void>();
    tray.onAction(cb);
    tray.start();
    tray.setStatus('connected');
    backend.click('stop-daemon');
    expect(cb).toHaveBeenCalledWith('stop-daemon');
  });

  it('dispatches open-inbox when clicked', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    const cb = vi.fn<(action: TrayAction) => void>();
    tray.onAction(cb);
    tray.start();
    tray.setStatus('connected');
    backend.click('open-inbox');
    expect(cb).toHaveBeenCalledWith('open-inbox');
  });

  it('dispatches show-window when clicked', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    const cb = vi.fn<(action: TrayAction) => void>();
    tray.onAction(cb);
    tray.start();
    backend.click('show-window');
    expect(cb).toHaveBeenCalledWith('show-window');
  });

  it('ignores clicks on non-action items (separators, status row)', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    const cb = vi.fn<(action: TrayAction) => void>();
    tray.onAction(cb);
    tray.start();
    backend.click('status');
    backend.click('sep1');
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not dispatch when no callback is registered', () => {
    const backend = new MockTrayBackend();
    const tray = new SystemTrayManager(backend);
    tray.start();
    expect(() => backend.click('quit')).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * SystemTrayManager — defaults
 * ------------------------------------------------------------------ */
describe('SystemTrayManager defaults', () => {
  it('defaults to a MockTrayBackend when none is supplied', () => {
    const tray = new SystemTrayManager();
    tray.start();
    expect(tray.isStarted).toBe(true);
    expect(tray.currentStatus).toBe('disconnected');
    tray.stop();
  });
});
