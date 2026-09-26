/**
 * Composite provider project scanner (issue #175).
 *
 * Runs all configured provider scanners (Claude, Codex, Devin, Antigravity)
 * and aggregates their discovered projects into a single list.
 */
import type {
  DiscoveredProviderProject,
  ProviderProjectScannerPort,
} from '../../../core/application/ports/outbound/provider-projects.js';
import { ClaudeProjectScanner, type ClaudeProjectScannerOptions } from './claude-project-scanner.js';
import { CodexProjectScanner, type CodexProjectScannerOptions } from './codex-project-scanner.js';
import { DevinProjectScanner, type DevinProjectScannerOptions } from './devin-project-scanner.js';
import { AntigravityProjectScanner, type AntigravityProjectScannerOptions } from './antigravity-project-scanner.js';

export interface CompositeProviderScannerOptions {
  readonly scanners?: readonly ProviderProjectScannerPort[];
  readonly claudeOptions?: ClaudeProjectScannerOptions;
  readonly codexOptions?: CodexProjectScannerOptions;
  readonly devinOptions?: DevinProjectScannerOptions;
  readonly antigravityOptions?: AntigravityProjectScannerOptions;
}

export class CompositeProviderScanner implements ProviderProjectScannerPort {
  readonly providerId = 'composite';
  private readonly scanners: readonly ProviderProjectScannerPort[];

  constructor(options: CompositeProviderScannerOptions = {}) {
    if (options.scanners) {
      this.scanners = options.scanners;
    } else {
      this.scanners = [
        new ClaudeProjectScanner(options.claudeOptions),
        new CodexProjectScanner(options.codexOptions),
        new DevinProjectScanner(options.devinOptions),
        new AntigravityProjectScanner(options.antigravityOptions),
      ];
    }
  }

  async scanProjects(): Promise<readonly DiscoveredProviderProject[]> {
    const results: DiscoveredProviderProject[] = [];
    for (const scanner of this.scanners) {
      try {
        const found = await scanner.scanProjects();
        results.push(...found);
      } catch {
        // Individual scanner failure does not abort the composite scan.
      }
    }
    return results;
  }
}
