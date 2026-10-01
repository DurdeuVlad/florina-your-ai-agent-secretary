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
  it('renders first-use guidance in plain language with an editable example (issue #278)', () => {
    const tree = renderChatScreen({ messages: [], working: false });
    expect(tree.tag).toBe('ChatView');
    const hints = findAll(tree, 'EmptyHint').map((h) => h.children?.join(' '));
    // Plain language — no unexplained internal vocabulary, any casing.
    expect(hints[0]).toContain('Florina watches your coding apps');
    const joined = hints.join(' ');
    const lowered = joined.toLowerCase();
    for (const jargon of ['fleet', 'ledger', 'brief']) {
      expect(lowered).not.toContain(jargon);
    }
    // One clear next action: an editable example that never auto-sends —
    // the verb is renderer-local (`firsttask:fill:` fills the composer).
    const fill = findAll(tree, 'Button').find((b) =>
      String(b.props?.['command']).startsWith('firsttask:fill:'),
    );
    expect(fill).toBeDefined();
    expect(String(fill!.props?.['command'])).toContain('summarize');
    // Where work + decisions surface, stated honestly.
    expect(joined).toContain('progress right here');
    expect(joined).toContain('Attention');
  });

  it('names the project and coding app only when actually checked', () => {
    const withCtx = renderChatScreen({
      messages: [],
      working: false,
      context: { project: 'C:\\code\\app', provider: 'Claude Code' },
    });
    const ctxText = findAll(withCtx, 'EmptyHint')
      .map((h) => h.children?.join(' '))
      .join(' ');
    expect(ctxText).toContain('Project: C:\\code\\app');
    expect(ctxText).toContain('Coding app: Claude Code');
    // Unchecked → the context line is omitted entirely, not fabricated.
    const unchecked = renderChatScreen({ messages: [], working: false, context: {} });
    const uncheckedText = findAll(unchecked, 'EmptyHint')
      .map((h) => h.children?.join(' '))
      .join(' ');
    expect(uncheckedText).not.toContain('Project:');
    expect(uncheckedText).not.toContain('Coding app:');
  });

  it('labels a bare watch root as Watching — a container is not a project (issue #278 follow-up)', () => {
    const tree = renderChatScreen({
      messages: [],
      working: false,
      context: { watching: 'C:\\code' },
    });
    const text = findAll(tree, 'EmptyHint')
      .map((h) => h.children?.join(' '))
      .join(' ');
    expect(text).toContain('Watching: C:\\code');
    expect(text).not.toContain('Project:');
  });

  it('honors a caller-supplied example so the first task never contradicts setup facts', () => {
    const tree = renderChatScreen({
      messages: [],
      working: false,
      context: { example: 'Look around and tell me what you can see on this machine.' },
    });
    const fill = findAll(tree, 'Button').find((b) =>
      String(b.props?.['command']).startsWith('firsttask:fill:'),
    );
    const cmd = String(fill!.props?.['command']);
    expect(decodeURIComponent(cmd.slice('firsttask:fill:'.length))).toBe(
      'Look around and tell me what you can see on this machine.',
    );
    expect(cmd).not.toContain('project');
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

  it('renders a failed send as an inline row with the daemon error + Retry (issue #263)', () => {
    const tree = renderChatScreen({
      working: false,
      messages: [msg({ id: 'm1' })],
      sendError: { text: 'check the oauth migration', error: 'daemon unreachable' },
    });
    const row = findAll(tree, 'SendErrorRow')[0];
    expect(row).toBeDefined();
    const text = String(row!.children?.[0]);
    expect(text).toContain('check the oauth migration');
    expect(text).toContain('daemon unreachable');
    const retry = findAll(row!, 'Button')[0];
    expect(retry?.props?.['command']).toBe('chat-retry');
  });

  it('renders no error row on a healthy thread', () => {
    const tree = renderChatScreen({ working: false, messages: [msg({ id: 'm1' })] });
    expect(findAll(tree, 'SendErrorRow')).toHaveLength(0);
  });
});
