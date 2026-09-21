/**
 * Electron {@link FolderPickerPort} — the native folder-selection dialog
 * for Settings > Repos (issue #253).
 *
 * `require('electron')` (not a named ESM import) for the same reason as
 * the other Electron adapters here — see `window-backend.ts` / issue #114.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { OpenDialogOptions } from 'electron';

const require = createRequire(import.meta.url);
const { dialog } = require('electron') as typeof import('electron');

import type { FolderPickerPort } from '../desktop-app.js';

const PICK_OPTIONS: OpenDialogOptions = {
  properties: ['openDirectory', 'multiSelections'],
  title: 'Select folders Florina should search for repos',
};

export class ElectronFolderPicker implements FolderPickerPort {
  async pickFolders(): Promise<readonly string[]> {
    const result = await dialog.showOpenDialog(PICK_OPTIONS);
    if (result.canceled) return [];
    return result.filePaths;
  }

  defaultFolder(): string | null {
    const candidate = join(homedir(), 'repos');
    return existsSync(candidate) ? candidate : null;
  }
}
