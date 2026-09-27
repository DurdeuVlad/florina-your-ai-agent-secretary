/**
 * Chat screen (issue #160, mockup `docs/mockups/chat.html`).
 *
 * Renders the single Secretary conversation into a {@link RenderTree}:
 *
 *  - `user` messages → right-aligned `msg user` bubbles ("You")
 *  - `assistant` messages → left-aligned `msg assistant` bubbles
 *    ("Secretary"); an assistant message whose only content is tool
 *    calls renders no bubble — the calls surface as tool rows
 *  - `tool` messages → collapsed mono `toolrow`s ("▸ name ok · preview")
 *    — progressive disclosure: presence is honest, detail stays in the
 *    inspector (DG-01 §3.9)
 *  - `system` rows are never rendered — they're config, not conversation
 *  - a `workrow` trails the list while a turn is in flight, carrying the
 *    latest tool name when one is running
 *  - a cleared marker row when `chat-clear` moved the read window
 *  - a `senderror` row after a rejected `chat-send` (issue #263) —
 *    red toolrow-family line with the daemon error and a Retry affordance
 *
 * The message list is the only part of the screen that lives in the
 * RenderTree — the composer is static DOM in `index.html` so re-mounts
 * never drop the user's draft.
 */
import type { ConversationMessage } from '../../../../core/domain/types.js';
import type { RenderTree } from './view-types.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** First line of a tool result, capped — the row stays a one-liner. */
function preview(content: string | null): string {
  if (content === null) return '';
  const line = content.split('\n', 1)[0]!.trim();
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

function messageNodes(m: ConversationMessage): RenderTree[] {
  switch (m.role) {
    case 'user':
      return [
        el('ChatMsg', { variant: 'user', id: m.id }, [el('ChatWho', {}, ['You']), m.content ?? '']),
      ];
    case 'assistant': {
      const nodes: RenderTree[] = [];
      if (m.content !== null && m.content.trim() !== '') {
        nodes.push(
          el('ChatMsg', { variant: 'assistant', id: m.id }, [
            el('ChatWho', {}, ['Secretary']),
            m.content,
          ]),
        );
      }
      // Tool calls ride on the assistant message but render as rows so
      // the thread reads like the mockup: bubble, then ▸ activity lines.
      m.toolCalls?.forEach((call, i) => {
        nodes.push(el('ToolRow', { id: `${m.id}-tool-${i}` }, [`▸ ${call.name}`]));
      });
      return nodes;
    }
    case 'tool': {
      const status = m.isError === true ? 'err' : 'ok';
      const tail = preview(m.content);
      return [
        el('ToolRow', { id: m.id }, [
          `▸ ${m.name ?? 'tool'} `,
          el('ToolStatus', { variant: status }, [status]),
          ...(tail !== '' ? [` · ${tail}`] : []),
        ]),
      ];
    }
    default:
      return []; // system — config, not conversation
  }
}

export interface ChatScreenState {
  /** Visible history — messages after the latest `chat-clear`. */
  readonly messages: readonly ConversationMessage[];
  /** A Secretary turn is running (driven by ephemeral `chat:event`s). */
  readonly working: boolean;
  /** Latest tool the turn invoked, for the working row's qualifier. */
  readonly workingTool?: string;
  /** Latest clear mark — shown as a divider so clearing stays honest. */
  readonly clearedAt?: string;
  /**
   * A `chat-send` the daemon rejected or that never reached it (issue
   * #263). Renders as an inline row in the thread so a lost send stays
   * visible until a successful send or `chat-clear` resolves it.
   */
  readonly sendError?: { readonly text: string; readonly error: string };
}

/** Build the chat screen's message-list tree. */
export function renderChatScreen(state: ChatScreenState): RenderTree {
  const children: RenderTree[] = [];

  if (state.messages.length === 0) {
    children.push(
      el('EmptyState', {}, [
        el('EmptyHint', {}, [
          state.clearedAt !== undefined
            ? 'history cleared — earlier messages stay in the journal'
            : 'say something — the Secretary can see your fleet, inbox, and ledgers',
        ]),
      ]),
    );
  } else {
    if (state.clearedAt !== undefined) {
      children.push(
        el('ClearRow', {}, [`cleared ${state.clearedAt} — earlier history is in the journal`]),
      );
    }
    for (const m of state.messages) {
      children.push(...messageNodes(m));
    }
  }

  if (state.sendError !== undefined) {
    children.push(
      el('SendErrorRow', {}, [
        `✗ couldn't send "${preview(state.sendError.text)}" — ${state.sendError.error}`,
        el('Button', { variant: 'ghost', command: 'chat-retry' }, ['Retry']),
      ]),
    );
  }

  if (state.working) {
    children.push(
      el('WorkRow', {}, [
        el('WorkDot', {}),
        state.workingTool !== undefined
          ? `Secretary is working — ${state.workingTool}…`
          : 'Secretary is working…',
      ]),
    );
  }

  return el('ChatView', {}, children);
}
