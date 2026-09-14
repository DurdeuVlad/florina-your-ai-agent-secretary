/**
 * ChatMessageRepository tests (issue #157) — the single Secretary
 * conversation: append-only journal semantics, visible-window clearing,
 * and lossless tool-call round-trips.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { StorageDatabase } from '../src/storage/index.js';
import { ChatMessageRepository } from '../src/adapters/outbound/persistence/sqlite/repositories/chat-message.js';
import type { ConversationMessage } from '../src/domain/types.js';

function msg(
  partial: Partial<ConversationMessage> & { content: string | null },
): ConversationMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('ChatMessageRepository', () => {
  let db: StorageDatabase;
  let repo: ChatMessageRepository;

  beforeEach(() => {
    db = new StorageDatabase({ path: ':memory:' });
    db.open();
    repo = new ChatMessageRepository(db.connection);
  });

  afterEach(() => {
    db.close();
  });

  it('appends and lists messages in insertion order', () => {
    repo.append(msg({ content: 'one' }));
    repo.append(msg({ content: 'two' }));
    repo.append(msg({ content: 'three' }));
    expect(repo.listVisible().map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('round-trips assistant tool calls and tool results losslessly', () => {
    repo.append(
      msg({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'list_tasks', arguments: { limit: 5 } }],
      }),
    );
    repo.append(
      msg({
        role: 'tool',
        content: '[]',
        toolCallId: 'call_1',
        name: 'list_tasks',
        isError: true,
      }),
    );

    const [assistant, tool] = repo.listVisible();
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.toolCalls?.[0]).toEqual({
      id: 'call_1',
      name: 'list_tasks',
      arguments: { limit: 5 },
    });
    expect(tool?.role).toBe('tool');
    expect(tool?.toolCallId).toBe('call_1');
    expect(tool?.name).toBe('list_tasks');
    expect(tool?.isError).toBe(true);
  });

  it('recordClear moves the visible window without deleting rows', () => {
    repo.append(msg({ content: 'before' }));
    repo.recordClear(new Date().toISOString());
    repo.append(msg({ content: 'after' }));

    expect(repo.listVisible().map((m) => m.content)).toEqual(['after']);
    expect(repo.listAll().map((m) => m.content)).toEqual(['before', 'after']);
    expect(repo.latestClear()).not.toBeNull();
  });

  it('a clear records the boundary exactly — a same-timestamp message still shows', () => {
    // Regression: clearing must key on insertion order (rowid), not
    // wall-clock, or a message appended in the same ms would be hidden.
    const ts = new Date().toISOString();
    repo.append(msg({ content: 'first', createdAt: ts }));
    repo.recordClear(ts);
    repo.append(msg({ content: 'second', createdAt: ts }));
    expect(repo.listVisible().map((m) => m.content)).toEqual(['second']);
  });

  it('rejects UPDATE on chat_messages (append-only, DEC-012)', () => {
    repo.append(msg({ content: 'original' }));
    expect(() => db.connection.prepare("UPDATE chat_messages SET content = 'x'").run()).toThrow(
      /append-only/,
    );
  });

  it('rejects DELETE on chat_messages (append-only, DEC-012)', () => {
    repo.append(msg({ content: 'original' }));
    expect(() => db.connection.prepare('DELETE FROM chat_messages').run()).toThrow(/append-only/);
  });

  it('rejects UPDATE/DELETE on chat_clears', () => {
    repo.recordClear(new Date().toISOString());
    expect(() => db.connection.prepare('DELETE FROM chat_clears').run()).toThrow(/append-only/);
    expect(() => db.connection.prepare("UPDATE chat_clears SET cleared_at = 'x'").run()).toThrow(
      /append-only/,
    );
  });
});
