/**
 * Devin CLI / IDE project scanner (issue #175).
 *
 * Discovers projects used by Devin by inspecting its workspaceStorage
 * directories (`%APPDATA%/Devin/User/workspaceStorage` on Windows,
 * `~/Library/Application Support/Devin/User/workspaceStorage` on macOS,
 * `~/.config/Devin/User/workspaceStorage` on Linux).
 *
 * READ-ONLY GUARANTEE: Never writes to or modifies any Devin configuration
 * file or directory.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DiscoveredProviderProject,
  ProviderProjectScannerPort,
} from '../../../core/application/ports/outbound/provider-projects.js';

export interface DevinProjectScannerOptions {
  readonly appDataDir?: string;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly readFileSyncFn?: (path: string, encoding: 'utf8') => string;
  readonly existsSyncFn?: (path: string) => boolean;
  readonly readdirSyncFn?: (path: string) => readonly string[];
}

export function decodeWorkspaceUri(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      // A `file:///x:/` URI encodes a Windows drive path on every
      // platform — on POSIX, fileURLToPath leaves it as `/x:/...`,
      // which is a meaningless path. Strip the leading slash the same
      // way the URL-parse fallback below does (#284).
      return fileURLToPath(uri).replace(/\\/g, '/').replace(/^\/([a-zA-Z]:)/, '$1');
    } catch {
      try {
        const parsed = new URL(uri);
        let pathName = decodeURIComponent(parsed.pathname);
        if (/^\/[a-zA-Z]:/.test(pathName)) {
          pathName = pathName.slice(1);
        }
        return pathName.replace(/\\/g, '/');
      } catch {
        return uri;
      }
    }
  }
  return uri;
}

export class DevinProjectScanner implements ProviderProjectScannerPort {
  readonly providerId = 'devin';
  private readonly storageDir: string;
  private readonly readFile: (path: string, encoding: 'utf8') => string;
  private readonly exists: (path: string) => boolean;
  private readonly readdir: (path: string) => readonly string[];

  constructor(options: DevinProjectScannerOptions = {}) {
    const platform = options.platform ?? process.platform;
    const home = options.homeDir ?? homedir();
    const appData =
      options.appDataDir ??
      (platform === 'win32'
        ? process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
        : platform === 'darwin'
          ? join(home, 'Library', 'Application Support')
          : join(home, '.config'));

    this.storageDir = join(appData, 'Devin', 'User', 'workspaceStorage');
    this.readFile = options.readFileSyncFn ?? readFileSync;
    this.exists = options.existsSyncFn ?? existsSync;
    this.readdir = options.readdirSyncFn ?? readdirSync;
  }

  scanProjects(): readonly DiscoveredProviderProject[] {
    const projects: DiscoveredProviderProject[] = [];
    const seen = new Set<string>();

    if (!this.exists(this.storageDir)) {
      return projects;
    }

    try {
      const entries = this.readdir(this.storageDir);
      for (const entry of entries) {
        const workspaceFile = join(this.storageDir, entry, 'workspace.json');
        if (this.exists(workspaceFile)) {
          try {
            const raw = this.readFile(workspaceFile, 'utf8');
            const data = JSON.parse(raw) as { folder?: string };
            if (data.folder && typeof data.folder === 'string') {
              const decoded = decodeWorkspaceUri(data.folder);
              if (decoded && !seen.has(decoded)) {
                seen.add(decoded);
                projects.push({
                  provider: this.providerId,
                  folderPath: decoded,
                  externalId: entry,
                });
              }
            }
          } catch {
            // Ignore unreadable individual workspace file.
          }
        }
      }
    } catch {
      // Degrades gracefully on directory read failure.
    }

    return projects;
  }
}
