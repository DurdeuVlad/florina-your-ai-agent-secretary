/**
 * Filesystem {@link IdeaLedgerPort} (DEC-033, issue #69).
 *
 * One markdown file per idea with YAML frontmatter
 * (`id`, `title`, `status`, `project`, `created`, `updated`) — human-
 * readable, machine-indexable. Ledgers live in a global ideas directory
 * until promoted into a project's directory.
 *
 * Frontmatter is intentionally scalar-only — no YAML dependency; values
 * that could break the line format are sanitized on write.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { IdeaLedger, IdeaStatus } from '../../../core/domain/ideas.js';
import { IDEA_STATUSES } from '../../../core/domain/ideas.js';
import type { IdeaLedgerPort } from '../../../core/application/ports/outbound/idea-ledger.js';

const FRONTMATTER_DELIMITER = '---';

export class FsIdeaLedger implements IdeaLedgerPort {
  private readonly rootDir: string;

  /**
   * @param rootDir Global ideas directory (e.g. `~/.agent-secretary/ideas`).
   *   Created lazily on first write.
   */
  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  create(input: { id: string; title: string; body?: string; now: string }): IdeaLedger {
    const ledger: IdeaLedger = {
      id: input.id,
      title: input.title,
      status: 'open',
      path: this.filePath(input.id),
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.writeFile(ledger, input.body ?? '');
    return ledger;
  }

  get(id: string): IdeaLedger | null {
    const found = this.findFile(id);
    if (found === null) return null;
    return this.readFrontmatter(found);
  }

  list(): IdeaLedger[] {
    const dirs = [this.rootDir, ...this.promotedDirs()];
    const ledgers: IdeaLedger[] = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const ledger = this.readFrontmatter(path.join(dir, file));
        if (ledger !== null) ledgers.push(ledger);
      }
    }
    return ledgers.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  readBody(id: string): string | null {
    const found = this.findFile(id);
    if (found === null) return null;
    const text = fs.readFileSync(found, 'utf8');
    const end = text.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, 0);
    if (!text.startsWith(FRONTMATTER_DELIMITER) || end === -1) return text;
    return text.slice(end + FRONTMATTER_DELIMITER.length + 2).replace(/^\n/, '');
  }

  append(id: string, heading: string, body: string, now: string): IdeaLedger {
    const found = this.findFile(id);
    if (found === null) {
      throw new Error(`idea ledger not found: ${id}`);
    }
    const existing = fs.readFileSync(found, 'utf8');
    const section = `\n## ${heading}\n\n${body.trimEnd()}\n`;
    fs.writeFileSync(found, existing.trimEnd() + section, 'utf8');
    return this.touch(found, now);
  }

  setStatus(id: string, status: IdeaStatus, now: string): IdeaLedger {
    const ledger = this.mustGet(id);
    const updated: IdeaLedger = { ...ledger, status, updatedAt: now };
    this.writeFile(updated, this.readBody(id) ?? '');
    return updated;
  }

  promote(id: string, projectId: string, targetDir: string, now: string): IdeaLedger {
    const ledger = this.mustGet(id);
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, path.basename(ledger.path));
    fs.renameSync(ledger.path, target);
    const promoted: IdeaLedger = {
      ...ledger,
      status: 'promoted',
      projectId,
      path: target,
      updatedAt: now,
    };
    this.writeFile(promoted, this.readBodyFromFile(target));
    return promoted;
  }

  /* ---------------------------------------------------------------- *
   * Internal helpers
   * ---------------------------------------------------------------- */

  private filePath(id: string): string {
    return path.join(this.rootDir, `${sanitizeFileName(id)}.md`);
  }

  private mustGet(id: string): IdeaLedger {
    const ledger = this.get(id);
    if (ledger === null) {
      throw new Error(`idea ledger not found: ${id}`);
    }
    return ledger;
  }

  /**
   * Search the global root first, then promoted subdirectories one level
   * deep (`<root>/<project-slug>/` is where promote() may place files if
   * a caller chose a target under the root).
   */
  private findFile(id: string): string | null {
    const name = `${sanitizeFileName(id)}.md`;
    const direct = path.join(this.rootDir, name);
    if (fs.existsSync(direct)) return direct;
    for (const dir of this.promotedDirs()) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Immediate subdirectories of the root (promotion targets). */
  private promotedDirs(): string[] {
    if (!fs.existsSync(this.rootDir)) return [];
    return fs
      .readdirSync(this.rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(this.rootDir, e.name));
  }

  private readBodyFromFile(filePath: string): string {
    const text = fs.readFileSync(filePath, 'utf8');
    const end = text.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, 0);
    if (!text.startsWith(FRONTMATTER_DELIMITER) || end === -1) return text;
    return text.slice(end + FRONTMATTER_DELIMITER.length + 2).replace(/^\n/, '');
  }

  private readFrontmatter(filePath: string): IdeaLedger | null {
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.startsWith(FRONTMATTER_DELIMITER)) return null;
    const end = text.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, 0);
    if (end === -1) return null;
    const block = text.slice(FRONTMATTER_DELIMITER.length + 1, end + 1);
    const fields: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const sep = line.indexOf(':');
      if (sep === -1) continue;
      fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
    }
    const status = fields['status'];
    if (
      fields['id'] === undefined ||
      fields['title'] === undefined ||
      status === undefined ||
      !IDEA_STATUSES.includes(status as IdeaStatus)
    ) {
      return null;
    }
    return {
      id: fields['id'],
      title: fields['title'],
      status: status as IdeaStatus,
      path: filePath,
      ...(fields['project'] !== undefined && fields['project'] !== ''
        ? { projectId: fields['project'] }
        : {}),
      createdAt: fields['created'] ?? '',
      updatedAt: fields['updated'] ?? '',
    };
  }

  /** Rewrite the file with refreshed frontmatter, preserving the body. */
  private writeFile(ledger: IdeaLedger, body: string): void {
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    const lines = [
      FRONTMATTER_DELIMITER,
      `id: ${ledger.id}`,
      `title: ${sanitizeScalar(ledger.title)}`,
      `status: ${ledger.status}`,
      `project: ${ledger.projectId ?? ''}`,
      `created: ${ledger.createdAt}`,
      `updated: ${ledger.updatedAt}`,
      FRONTMATTER_DELIMITER,
      '',
    ];
    fs.writeFileSync(ledger.path, lines.join('\n') + body.trimStart(), 'utf8');
  }

  /** Bump `updated` in the existing frontmatter and return the ledger. */
  private touch(filePath: string, now: string): IdeaLedger {
    const text = fs.readFileSync(filePath, 'utf8');
    const bumped = text.replace(/^updated: .*$/m, `updated: ${now}`);
    fs.writeFileSync(filePath, bumped, 'utf8');
    const ledger = this.readFrontmatter(filePath);
    if (ledger === null) {
      throw new Error(`corrupt idea ledger: ${filePath}`);
    }
    return ledger;
  }
}

/** Keep a frontmatter scalar on one line (no YAML parser involved). */
function sanitizeScalar(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Keep an id safe as a filename on all platforms. */
function sanitizeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, '-');
}
