/**
 * Antigravity (Google AGY) project scanner (issue #175).
 *
 * Best-effort project scanner for Antigravity: discovers workspace paths from
 * Antigravity brain / conversation logs and state under `~/.gemini/antigravity`.
 *
 * READ-ONLY GUARANTEE: Never writes to or modifies any Antigravity configuration
 * file or directory.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DiscoveredProviderProject,
  ProviderProjectScannerPort,
} from '../../../core/application/ports/outbound/provider-projects.js';
import { decodeWorkspaceUri } from './devin-project-scanner.js';

export interface AntigravityProjectScannerOptions {
  readonly homeDir?: string;
  readonly baseDir?: string;
  readonly readFileSyncFn?: (path: string, encoding: 'utf8') => string;
  readonly existsSyncFn?: (path: string) => boolean;
  readonly readdirSyncFn?: (path: string) => readonly string[];
  readonly statSyncFn?: (path: string) => { mtimeMs: number };
}

export class AntigravityProjectScanner implements ProviderProjectScannerPort {
  readonly providerId = 'antigravity';
  private readonly baseDir: string;
  private readonly readFile: (path: string, encoding: 'utf8') => string;
  private readonly exists: (path: string) => boolean;
  private readonly readdir: (path: string) => readonly string[];
  private readonly stat: (path: string) => { mtimeMs: number };

  constructor(options: AntigravityProjectScannerOptions = {}) {
    const home = options.homeDir ?? homedir();
    this.baseDir = options.baseDir ?? join(home, '.gemini', 'antigravity');
    this.readFile = options.readFileSyncFn ?? readFileSync;
    this.exists = options.existsSyncFn ?? existsSync;
    this.readdir = options.readdirSyncFn ?? readdirSync;
    this.stat = options.statSyncFn ?? statSync;
  }

  scanProjects(): readonly DiscoveredProviderProject[] {
    const projects: DiscoveredProviderProject[] = [];
    const seen = new Set<string>();

    if (!this.exists(this.baseDir)) {
      return projects;
    }

    // Inspect recent brain conversation logs for workspaceUris
    const brainDir = join(this.baseDir, 'brain');
    if (this.exists(brainDir)) {
      try {
        const convoDirs = this.readdir(brainDir)
          .map((id) => {
            const fullPath = join(brainDir, id);
            let mtimeMs = 0;
            try {
              mtimeMs = this.stat(fullPath).mtimeMs;
            } catch {
              mtimeMs = 0;
            }
            return { id, mtimeMs };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .map((item) => item.id)
          .slice(0, 20);

        for (const convoId of convoDirs) {
          const logFile = join(brainDir, convoId, '.system_generated', 'logs', 'transcript.jsonl');
          if (this.exists(logFile)) {
            try {
              const content = this.readFile(logFile, 'utf8');
              const uriRegex = /"workspaceUris"\s*:\s*\[\s*"([^"]+)"/g;
              let match: RegExpExecArray | null;
              while ((match = uriRegex.exec(content)) !== null) {
                if (match[1]) {
                  const folder = decodeWorkspaceUri(match[1]);
                  if (folder && !seen.has(folder)) {
                    seen.add(folder);
                    projects.push({
                      provider: this.providerId,
                      folderPath: folder,
                    });
                  }
                }
              }
            } catch {
              // Ignore unreadable log.
            }
          }
        }
      } catch {
        // Degrades gracefully.
      }
    }

    return projects;
  }
}
