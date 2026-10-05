/**
 * Repository for the `attention_inbox_snapshot` table (issue #272).
 *
 * The whole serialized `AttentionInbox` state lives in a single-row
 * table: every successful inbox mutation rewrites the blob in place.
 * Attention inboxes are small (bounded by the JournalFailure collapse
 * and human-scale queues), so whole-snapshot replacement is both correct
 * by construction and cheap enough to run synchronously on change.
 *
 * The blob is the only durable copy of `JournalFailure` cards' retained
 * `writes[]` — rows that never reached the journal. A corrupt or
 * unreadable blob degrades to `null` (empty inbox) rather than crashing
 * boot: losing the snapshot is the pre-#272 status quo, wedging the
 * daemon over it would be strictly worse.
 */
import type Database from 'better-sqlite3';

import type { AttentionInboxSnapshot } from '../../../../../core/application/use-cases/attention/attention-inbox.js';
import {
  ATTENTION_ITEM_KINDS,
  ATTENTION_ITEM_STATUSES,
  PRIORITY_ORDER,
  type AttentionItem,
} from '../../../../../core/application/use-cases/attention/attention-item.js';
import type { AttentionInboxStorePort } from '../../../../../core/application/ports/outbound/repositories.js';
import { BaseRepository } from './base.js';

/** Database row shape for the `attention_inbox_snapshot` table. */
interface AttentionInboxSnapshotRow {
  id: number;
  payload: string;
  saved_at: string;
}

/**
 * Whether a deserialized element has the minimum well-formed shape of an
 * inbox item. Elements failing the check are dropped rather than wedging
 * the whole restore — a `{items:[null]}` blob would otherwise propagate
 * into `restore()` and crash the daemon at boot.
 */
function isWellFormedItem(value: unknown): value is AttentionItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<AttentionItem>;
  return (
    typeof item.id === 'string' &&
    typeof item.taskId === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.kind === 'string' &&
    (ATTENTION_ITEM_KINDS as readonly string[]).includes(item.kind) &&
    typeof item.status === 'string' &&
    (ATTENTION_ITEM_STATUSES as readonly string[]).includes(item.status) &&
    typeof item.priority === 'string' &&
    (PRIORITY_ORDER as readonly string[]).includes(item.priority) &&
    (item.payload === undefined || typeof item.payload === 'object')
  );
}

export class AttentionInboxSnapshotRepository
  extends BaseRepository
  implements AttentionInboxStorePort<AttentionInboxSnapshot>
{
  private readonly loadStmt: Database.Statement;
  private readonly saveStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.loadStmt = this.prepare('SELECT * FROM attention_inbox_snapshot WHERE id = 1');
    this.saveStmt = this.prepare(
      `INSERT INTO attention_inbox_snapshot (id, payload, saved_at)
       VALUES (1, @payload, @saved_at)
       ON CONFLICT(id) DO UPDATE SET payload = @payload, saved_at = @saved_at`,
    );
  }

  /** The last persisted snapshot, or `null` when none exists or it is unreadable. */
  load(): AttentionInboxSnapshot | null {
    const row = this.loadStmt.get() as AttentionInboxSnapshotRow | undefined;
    if (row === undefined) return null;
    try {
      const parsed = this.fromJson<AttentionInboxSnapshot>(row.payload);
      if (!Array.isArray(parsed?.items)) return null;
      return { items: parsed.items.filter(isWellFormedItem) };
    } catch {
      return null;
    }
  }

  /** Replace the persisted snapshot atomically. */
  save(snapshot: AttentionInboxSnapshot): void {
    this.saveStmt.run({
      payload: this.toJson(snapshot),
      saved_at: new Date().toISOString(),
    });
  }
}
