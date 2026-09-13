/**
 * Electron {@link TrayBackend} — production system-tray runtime for the
 * desktop client (DEC-028, issue #28).
 *
 * Projects the skeleton's JSON-serializable {@link TrayMenuItem} list onto a
 * real `Tray` + `Menu`. Tray creation is best-effort: on platforms or
 * sessions without a tray (or a missing icon), the backend degrades to a
 * no-op rather than crashing the app.
 */
import { createRequire } from 'node:module';

import type { MenuItemConstructorOptions, Tray } from 'electron';

// See window-backend.ts: require('electron') in main resolves to the real
// API, while named ESM imports may hit the npm shim (issue #114).
const require = createRequire(import.meta.url);
const { Menu, Tray: TrayCtor, nativeImage } = require('electron') as typeof import('electron');

import type { TrayBackend, TrayMenuItem } from '../system-tray.js';

/**
 * 16×16 accent-dot PNG used as the tray icon until a branded asset ships.
 * Embedded as a data URL so the adapter needs no file-system assets.
 */
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export class ElectronTrayBackend implements TrayBackend {
  private tray: Tray | null = null;
  private selectHandler: ((itemId: string) => void) | null = null;

  create(iconTooltip: string, menu: readonly TrayMenuItem[]): void {
    try {
      const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
      this.tray = new TrayCtor(icon.resize({ width: 16, height: 16 }));
      this.tray.setToolTip(iconTooltip);
      this.tray.setContextMenu(Menu.buildFromTemplate(this.toTemplate(menu)));
    } catch {
      // No tray host (headless session / unsupported shell) — degrade to
      // a no-op backend; the app keeps working without a tray.
      this.tray = null;
    }
  }

  setTooltip(tooltip: string): void {
    this.tray?.setToolTip(tooltip);
  }

  setMenu(menu: readonly TrayMenuItem[]): void {
    this.tray?.setContextMenu(Menu.buildFromTemplate(this.toTemplate(menu)));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
    this.selectHandler = null;
  }

  onSelect(callback: (itemId: string) => void): void {
    this.selectHandler = callback;
  }

  /** Map the serializable menu model onto Electron menu items. */
  private toTemplate(menu: readonly TrayMenuItem[]): MenuItemConstructorOptions[] {
    return menu.map((item) =>
      item.separator === true
        ? { type: 'separator' as const }
        : {
            label: item.label,
            enabled: item.enabled,
            type: 'normal' as const,
            click: () => this.selectHandler?.(item.id),
          },
    );
  }
}
