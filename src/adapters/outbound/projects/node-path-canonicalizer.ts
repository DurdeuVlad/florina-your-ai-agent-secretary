/**
 * Node.js filesystem path canonicalizer (issue #175).
 *
 * Implements PathCanonicalizerPort by resolving symlinks via realpathSync,
 * normalizing separators to forward slashes, stripping trailing slashes,
 * and applying the host OS case policy (case-folded on Windows and macOS,
 * case-preserved on Linux).
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PathCanonicalizerPort } from '../../../core/application/ports/outbound/provider-projects.js';

export interface NodePathCanonicalizerOptions {
  /** Override the detected platform (for tests). */
  readonly platform?: NodeJS.Platform;
  /** Custom realpath implementation (for tests). */
  readonly realpathFn?: (p: string) => string;
}

export class NodePathCanonicalizer implements PathCanonicalizerPort {
  private readonly platform: NodeJS.Platform;
  private readonly realpathFn: (p: string) => string;

  constructor(options: NodePathCanonicalizerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.realpathFn = options.realpathFn ?? ((p: string) => {
      try {
        return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
      } catch {
        return resolve(p);
      }
    });
  }

  canonicalize(rawPath: string): string {
    if (!rawPath || rawPath.trim() === '') {
      return '';
    }

    // 1. Resolve symlinks or absolute path
    let resolved: string;
    try {
      resolved = this.realpathFn(rawPath);
    } catch {
      resolved = resolve(rawPath);
    }

    // 2. Normalize backslashes to forward slashes
    let normalized = resolved.replace(/\\/g, '/');

    // 3. Strip trailing slashes, preserving drive root (e.g. "C:/") or root ("/")
    if (normalized.length > 1 && normalized.endsWith('/')) {
      // Check if it's a Windows drive root like "C:/" or POSIX root "/"
      const isDriveRoot = /^[a-zA-Z]:\/$/.test(normalized);
      if (!isDriveRoot) {
        normalized = normalized.replace(/\/+$/, '');
      }
    }

    // 4. Apply OS case policy: Windows and macOS filesystems are case-insensitive
    if (this.platform === 'win32' || this.platform === 'darwin') {
      normalized = normalized.toLowerCase();
    }

    return normalized;
  }
}
