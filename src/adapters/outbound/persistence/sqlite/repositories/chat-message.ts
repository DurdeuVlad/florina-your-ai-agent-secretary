/**
 * Repository for the `chat_messages` + `chat_clears` tables (issue #157).
 *
 * The single Secretary conversation is append-only like the events
 * journal (DEC-012) — triggers reject UPDATE/DELETE at the schema level.
 * `chat-clear` appends a row to `chat_clears` recording the last message
 * rowid at clear time, and {@link listVisible} returns only rows beyond
 * that mark — clearing moves the read window instead of destroying
 * history, and same-millisecond timestamps can't hide a live message.
 */
import type Database from 'better-sqlite3';

import type {
  ConversationMessage,
  ConversationToolCall,
  ISODateString,
} from '../../../../../core/domain/types.js';
import { BaseRepository } from './base.js';
import type { ChatMessageRepositoryPort } from '../../../../../core/application/ports/outbound/repositories.js';

/** Database row shape for the `chat_messages` table. */
interface ChatMessageRow {
  id: string;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  name: string | null;
  is_error: number | null;
  created_at: string;
}

export class ChatMessageRepository extends BaseRepository implements ChatMessageRepositoryPort {
  private readonly insertStmt: Database.Statement;
  private readonly listAllStmt: Database.Statement;
  private readonly listVisibleStmt: Database.Statement;
  private readonly insertClearStmt: Database.Statement;
  private readonly lastRowidStmt: Database.Statement;
  private readonly latestClearStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);
    this.insertStmt = this.prepare(
      `INSERT INTO chat_messages
         (id, role, content, tool_calls, tool_call_id, name, is_error, created_at)
       VALUES (@id, @role, @content, @tool_calls, @tool_call_id, @name, @is_error, @created_at)`,
    );
    this.listAllStmt = this.prepare('SELECT * FROM chat_messages ORDER BY rowid ASC');
    this.listVisibleStmt = this.prepare(
      `SELECT * FROM chat_messages
       WHERE rowid > COALESCE((SELECT MAX(before_rowid) FROM chat_clears), 0)
       ORDER BY rowid ASC`,
    );
    this.insertClearStmt = this.prepare(
      'INSERT INTO chat_clears (id, cleared_at, before_rowid) VALUES (@id, @cleared_at, @before_rowid)',
    );
    this.lastRowidStmt = this.prepare('SELECT MAX(rowid) AS r FROM chat_messages');
    this.latestClearStmt = this.prepare('SELECT MAX(cleared_at) AS c FROM chat_clears');
  }

  append(message: ConversationMessage): void {
    this.insertStmt.run({
      id: message.id,
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls !== undefined ? this.toJson(message.toolCalls) : null,
      tool_call_id: message.toolCallId ?? null,
      name: message.name ?? null,
      is_error: message.isError === undefined ? null : this.toBool(message.isError),
      created_at: message.createdAt,
    });
  }

  listVisible(): ConversationMessage[] {
    return (this.listVisibleStmt.all() as ChatMessageRow[]).map((row) => this.toMessage(row));
  }

  listAll(): ConversationMessage[] {
    return (this.listAllStmt.all() as ChatMessageRow[]).map((row) => this.toMessage(row));
  }

  recordClear(at: ISODateString): void {
    const last = this.lastRowidStmt.get() as { r: number | null };
    this.insertClearStmt.run({
      id: `clear_${Date.now().toString(36)}`,
      cleared_at: at,
      before_rowid: last.r ?? 0,
    });
  }

  latestClear(): ISODateString | null {
    const row = this.latestClearStmt.get() as { c: string | null };
    return row.c;
  }

  private toMessage(row: ChatMessageRow): ConversationMessage {
    return {
      id: row.id,
      role: row.role as ConversationMessage['role'],
      content: row.content,
      ...(row.tool_calls !== null
        ? { toolCalls: this.fromJson<ConversationToolCall[]>(row.tool_calls) }
        : {}),
      ...(row.tool_call_id !== null ? { toolCallId: row.tool_call_id } : {}),
      ...(row.name !== null ? { name: row.name } : {}),
      ...(row.is_error !== null ? { isError: this.fromBool(row.is_error) } : {}),
      createdAt: row.created_at,
    };
  }
}
