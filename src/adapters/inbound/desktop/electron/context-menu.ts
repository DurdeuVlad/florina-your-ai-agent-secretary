/**
 * Copy context menu for the main window (issue #331, DG-01).
 *
 * The renderer is sandboxed — no Node, context isolation — so the
 * right-click menu is installed main-side on the window's WebContents.
 * The menu exposes editing roles only (cut/copy/paste on editable
 * fields, copy on a selection) — never Inspect/Reload — so it cannot
 * widen the renderer's power, and it pops up only when there is
 * something to do.
 */
import type { MenuItemConstructorOptions } from 'electron';

/** The slice of Electron's context-menu params the installer reads. */
export interface CopyMenuParams {
  readonly isEditable: boolean;
  readonly selectionText?: string;
  readonly editFlags?: { canCut?: boolean; canCopy?: boolean; canPaste?: boolean };
}

/** Structural stand-in for `WebContents` — keeps this unit-testable. */
export interface CopyMenuHost {
  on(event: 'context-menu', listener: (event: unknown, params: CopyMenuParams) => void): unknown;
}

export interface PopupMenu {
  popup(): void;
}

/**
 * Attach a `context-menu` handler that pops a minimal editing menu:
 * cut/copy/paste for editable targets (filtered by what the field can
 * actually do), copy for a plain text selection, nothing otherwise.
 */
export function installCopyContextMenu(
  contents: CopyMenuHost,
  buildFromTemplate: (items: MenuItemConstructorOptions[]) => PopupMenu,
): void {
  contents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    const flags = params.editFlags ?? {};
    if (params.isEditable) {
      if (flags.canCut) items.push({ role: 'cut' });
      if (flags.canCopy) items.push({ role: 'copy' });
      if (flags.canPaste) items.push({ role: 'paste' });
      items.push({ role: 'selectAll' });
    } else if (flags.canCopy !== false && (params.selectionText ?? '').trim().length > 0) {
      items.push({ role: 'copy' });
    }
    if (items.length === 0) return;
    buildFromTemplate(items).popup();
  });
}
