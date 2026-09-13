/**
 * Outbound port: idea-ledger persistence (DEC-033, issue #69).
 *
 * An {@link IdeaLedger}'s body lives in a markdown file the human can
 * read and edit; the port abstracts where that file lives (global ideas
 * directory by default, project directory after promotion) and how the
 * YAML frontmatter index is maintained.
 */
import type { IdeaLedger, IdeaStatus } from '../../../domain/ideas.js';

export interface IdeaLedgerPort {
  /**
   * Create a new ledger file with the given id/title and optional seed
   * body. `now` stamps `createdAt`/`updatedAt`.
   */
  create(input: { id: string; title: string; body?: string; now: string }): IdeaLedger;

  /** Look up a ledger by id, or `null` when no file exists. */
  get(id: string): IdeaLedger | null;

  /** All ledgers the store can see, oldest first. */
  list(): IdeaLedger[];

  /** The ledger's markdown body (everything after the frontmatter). */
  readBody(id: string): string | null;

  /**
   * Append a titled section to the ledger body and bump `updatedAt`.
   * `heading` is rendered as a `##` section; `body` follows verbatim.
   */
  append(id: string, heading: string, body: string, now: string): IdeaLedger;

  /** Update the frontmatter status (and `updatedAt`). */
  setStatus(id: string, status: IdeaStatus, now: string): IdeaLedger;

  /**
   * Promote the ledger into a project: move the file into
   * `targetDir` and record `projectId` + `promoted` status (DEC-033).
   */
  promote(id: string, projectId: string, targetDir: string, now: string): IdeaLedger;
}
