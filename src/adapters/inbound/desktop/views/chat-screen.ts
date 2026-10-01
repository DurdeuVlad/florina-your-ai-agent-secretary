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
  /**
   * First-run context line for the empty conversation (issue #278):
   * the chosen project folder and detected coding app, when known.
   * `undefined` fields mean "couldn't check" — the line omits them
   * rather than claiming they don't exist.
   */
  readonly context?: {
    readonly project?: string;
    readonly provider?: string;
  };
}

/**
 * Editable example task (issue #278). Filling it is a renderer-local
 * verb (`firsttask:fill:`) — it lands in the composer as editable text
 * and never dispatches on its own (Non-goal: no auto-sent sample task).
 * Read-only by design: summarizing a project is a safe first ask.
 */
const EXAMPLE_TASK = 'Look at my project folder and summarize what it does.';

/** Build the chat screen's message-list tree. */
export function renderChatScreen(state: ChatScreenState): RenderTree {
  const children: RenderTree[] = [];

  if (state.messages.length === 0) {
    if (state.clearedAt !== undefined) {
      children.push(
        el('EmptyState', {}, [
          el('EmptyHint', {}, ['history cleared — earlier messages stay in the journal']),
        ]),
      );
    } else {
      // First-use guidance (issue #278): plain language, one concept per
      // line, one clear next action — and nothing internal named that a
      // new user couldn't already know.
      const hints: (RenderTree | string)[] = [
        el('EmptyHint', {}, [
          'Florina watches your coding apps and brings anything that needs you into one place.',
        ]),
        el('EmptyHint', {}, [
          'Type a request below — or fill in this example and edit it before it ever sends:',
        ]),
        el(
          'Button',
          { variant: 'ghost', command: `firsttask:fill:${encodeURIComponent(EXAMPLE_TASK)}` },
          ['Use an example'],
        ),
      ];
      // Honest capability context: only state what was actually checked.
      if (state.context !== undefined) {
        const parts: string[] = [];
        if (state.context.project !== undefined) parts.push(`Project: ${state.context.project}`);
        if (state.context.provider !== undefined)
          parts.push(`Coding app: ${state.context.provider}`);
        if (parts.length > 0) hints.push(el('EmptyHint', {}, [parts.join('  ·  ')]));
      }
      hints.push(
        el('EmptyHint', {}, [
          'You’ll see progress right here. If anything needs your permission, it lands ' +
            'in Attention — you decide.',
        ]),
      );
      children.push(el('EmptyState', {}, hints));
    }
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
