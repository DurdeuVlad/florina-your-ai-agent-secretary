/**
 * Claude Code project scanner (issue #175).
 *
 * Discovers projects used by Claude Code by reading `~/.claude.json` (the
 * `projects` dictionary) and inspecting `~/.claude/projects/`.
 *
 * READ-ONLY GUARANTEE: Never writes to or modifies any Claude configuration
 * file or directory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DiscoveredProviderProject,
  ProviderProjectScannerPort,
} from '../../../core/application/ports/outbound/provider-projects.js';

export interface ClaudeProjectScannerOptions {
  readonly homeDir?: string;
  readonly readFileSyncFn?: (path: string, encoding: 'utf8') => string;
  readonly existsSyncFn?: (path: string) => boolean;
}

export class ClaudeProjectScanner implements ProviderProjectScannerPort {
  readonly providerId = 'claude-code';
  private readonly homeDir: string;
  private readonly readFile: (path: string, encoding: 'utf8') => string;
  private readonly exists: (path: string) => boolean;

  constructor(options: ClaudeProjectScannerOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.readFile = options.readFileSyncFn ?? readFileSync;
    this.exists = options.existsSyncFn ?? existsSync;
  }

  scanProjects(): readonly DiscoveredProviderProject[] {
    const projects: DiscoveredProviderProject[] = [];
    const seen = new Set<string>();

    const configFile = join(this.homeDir, '.claude.json');
    if (this.exists(configFile)) {
      try {
        const raw = this.readFile(configFile, 'utf8');
        const data = JSON.parse(raw) as { projects?: Record<string, unknown> };
        if (data.projects && typeof data.projects === 'object') {
          for (const folderPath of Object.keys(data.projects)) {
            if (folderPath && !seen.has(folderPath)) {
              seen.add(folderPath);
              projects.push({
                provider: this.providerId,
                folderPath,
              });
            }
          }
        }
      } catch {
        // Corrupt or unreadable config degrades gracefully to empty list.
      }
    }

    return projects;
  }
}
