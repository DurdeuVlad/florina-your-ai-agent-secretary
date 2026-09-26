/**
 * Chat screen view (issue #160): the single Secretary conversation as a
 * RenderTree — user/assistant bubbles, collapsed tool rows, the working
 * indicator, and the clear marker.
 */
import { describe, it, expect } from 'vitest';

import { renderChatScreen } from '../src/adapters/inbound/desktop/views/chat-screen.js';
import type { RenderTree } from '../src/adapters/inbound/desktop/views/view-types.js';
import type { ConversationMessage } from '../src/core/domain/types.js';

function findAll(tree: RenderTree, tag: string): RenderTree[] {
  const out: RenderTree[] = [];
  const walk = (node: RenderTree | string): void => {
    if (typeof node === 'string') return;
    if (node.tag === tag) out.push(node);
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

const msg = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: `m${Math.random()}`,
  role: 'user',
  content: 'hello',
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('chat screen', () => {
  it('renders the empty state with the what-it-can-see hint', () => {
    const tree = renderChatScreen({ messages: [], working: false });
    expect(tree.tag).toBe('ChatView');
    const hint = findAll(tree, 'EmptyHint');
    expect(hint).toHaveLength(1);
    expect(hint[0]!.children?.[0]).toContain('fleet, inbox, and ledgers');
  });

  it('renders the cleared hint when the read window moved', () => {
    const tree = renderChatScreen({
      messages: [],
      working: false,
      clearedAt: '2026-01-02T00:00:00Z',
    });
    expect(findAll(tree, 'EmptyHint')[0]!.children?.[0]).toContain('journal');
  });

  it('maps roles to bubbles and tool rows in journal order', () => {
    const tree = renderChatScreen({
      working: false,
      messages: [
        msg({ id: 'm1', role: 'user', content: 'list my tasks' }),
        msg({
          id: 'm2',
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'list_tasks', arguments: {} }],
        }),
        msg({
          id: 'm3',
          role: 'tool',
          toolCallId: 'c1',
          name: 'list_tasks',
          content: '5 tasks',
        }),
        msg({ id: 'm4', role: 'assistant', content: 'You have 5 tasks.' }),
      ],
    });
    const msgs = findAll(tree, 'ChatMsg');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.props?.['variant']).toBe('user');
    expect(msgs[1]!.props?.['variant']).toBe('assistant');
    const rows = findAll(tree, 'ToolRow');
    // One row from the assistant's toolCalls, one from the tool result.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.children?.[0]).toBe('▸ list_tasks');
    expect(rows[1]!.children?.[0]).toBe('▸ list_tasks ');
    expect(rows[1]!.children?.[2]).toBe(' · 5 tasks');
  });

  it('carries the source message id on ChatMsg/ToolRow — the renderer diffs entrance animation by this, not DOM identity', () => {
    const tree = renderChatScreen({
      working: false,
      messages: [
        msg({ id: 'm1', role: 'user', content: 'hi' }),
        msg({
          id: 'm2',
          role: 'assistant',
          content: 'hello',
          toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
        }),
        msg({ id: 'm3', role: 'tool', name: 'ping', content: 'pong' }),
      ],
    });
    const [userMsg] = findAll(tree, 'ChatMsg');
    expect(userMsg!.props?.['id']).toBe('m1');
    const [assistantMsg] = findAll(tree, 'ChatMsg').slice(1);
    expect(assistantMsg!.props?.['id']).toBe('m2');
    const rows = findAll(tree, 'ToolRow');
    expect(rows[0]!.props?.['id']).toBe('m2-tool-0'); // from m2's toolCalls
    expect(rows[1]!.props?.['id']).toBe('m3'); // the tool-result message itself
  });

  it('marks errored tool results', () => {
    const tree = renderChatScreen({
      working: false,
      messages: [
        msg({ id: 'm1', role: 'tool', name: 'approve', content: 'denied', isError: true }),
      ],
    });
    const status = findAll(tree, 'ToolStatus')[0];
    expect(status?.props?.['variant']).toBe('err');
    expect(status?.children?.[0]).toBe('err');
  });

  it('shows the working row with the running tool', () => {
    const tree = renderChatScreen({
      messages: [msg({ id: 'm1' })],
      working: true,
      workingTool: 'query_inbox',
    });
    const work = findAll(tree, 'WorkRow')[0];
    expect(work).toBeDefined();
    expect(work!.children?.[1]).toBe('Secretary is working — query_inbox…');
  });

  it('shows a bare working row before the first tool call', () => {
    const tree = renderChatScreen({ messages: [msg({ id: 'm1' })], working: true });
    expect(findAll(tree, 'WorkRow')[0]!.children?.[1]).toBe('Secretary is working…');
  });

  it('never renders system rows', () => {
    const tree = renderChatScreen({
      working: false,
      messages: [msg({ id: 'm1', role: 'system', content: 'you are florina' })],
    });
    expect(findAll(tree, 'ChatMsg')).toHaveLength(0);
  });

  it('shows the clear marker above retained history', () => {
    const tree = renderChatScreen({
      working: false,
      clearedAt: '2026-01-02T00:00:00Z',
      messages: [msg({ id: 'm1' })],
    });
    const row = findAll(tree, 'ClearRow')[0];
    expect(row).toBeDefined();
    expect(String(row!.children?.[0])).toContain('cleared 2026-01-02');
    expect(findAll(tree, 'ChatMsg')).toHaveLength(1);
  });
});
