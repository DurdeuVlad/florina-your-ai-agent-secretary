/**
 * OpenAI Codex project scanner (issue #175).
 *
 * Discovers projects used by Codex Desktop / CLI by reading
 * `~/.codex/.codex-global-state.json` (`local-projects` and
 * `electron-saved-workspace-roots`).
 *
 * READ-ONLY GUARANTEE: Never writes to or modifies any Codex configuration
 * file or directory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DiscoveredProviderProject,
  ProviderProjectScannerPort,
} from '../../../core/application/ports/outbound/provider-projects.js';

export interface CodexProjectScannerOptions {
  readonly homeDir?: string;
  readonly readFileSyncFn?: (path: string, encoding: 'utf8') => string;
  readonly existsSyncFn?: (path: string) => boolean;
}

export class CodexProjectScanner implements ProviderProjectScannerPort {
  readonly providerId = 'codex';
  private readonly homeDir: string;
  private readonly readFile: (path: string, encoding: 'utf8') => string;
  private readonly exists: (path: string) => boolean;

  constructor(options: CodexProjectScannerOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.readFile = options.readFileSyncFn ?? readFileSync;
    this.exists = options.existsSyncFn ?? existsSync;
  }

  scanProjects(): readonly DiscoveredProviderProject[] {
    const projects: DiscoveredProviderProject[] = [];
    const seen = new Set<string>();

    const stateFile = join(this.homeDir, '.codex', '.codex-global-state.json');
    if (this.exists(stateFile)) {
      try {
        const raw = this.readFile(stateFile, 'utf8');
        const data = JSON.parse(raw) as {
          'local-projects'?: Record<
            string,
            { id?: string; name?: string; rootPaths?: readonly string[] }
          >;
          'electron-saved-workspace-roots'?: readonly string[];
        };

        // 1. Check local-projects map
        if (data['local-projects'] && typeof data['local-projects'] === 'object') {
          for (const item of Object.values(data['local-projects'])) {
            if (item && Array.isArray(item.rootPaths)) {
              for (const rootPath of item.rootPaths) {
                if (typeof rootPath === 'string' && rootPath && !seen.has(rootPath)) {
                  seen.add(rootPath);
                  projects.push({
                    provider: this.providerId,
                    folderPath: rootPath,
                    name: item.name,
                    externalId: item.id,
                  });
                }
              }
            }
          }
        }

        // 2. Check electron-saved-workspace-roots list
        if (Array.isArray(data['electron-saved-workspace-roots'])) {
          for (const rootPath of data['electron-saved-workspace-roots']) {
            if (typeof rootPath === 'string' && rootPath && !seen.has(rootPath)) {
              seen.add(rootPath);
              projects.push({
                provider: this.providerId,
                folderPath: rootPath,
              });
            }
          }
        }
      } catch {
        // Corrupt or unreadable file degrades gracefully to empty list.
      }
    }

    return projects;
  }
}
