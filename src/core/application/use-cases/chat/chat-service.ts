/**
 * ChatService — the single Secretary conversation's turn runner
 * (issue #158).
 *
 * `chat-send` journals the user message (command layer); this service
 * then runs a FlorinaLoop turn over the full stored history — the
 * append-only `chat_messages` journal IS the loop's memory (DEC-012) —
 * journals every new message verbatim, and fans out:
 *   - journaled appends → `onMessage` (daemon broadcasts `chat:message`)
 *   - loop progress   → `onEvent`   (ephemeral `chat:event` pushes —
 *     iteration/tool_call/tool_result — never journaled, same contract
 *     as `voice:state`, DEC-012 covers transitions not ephemera)
 *
 * One turn runs at a time; a second `chat-send` while a turn is in
 * flight is rejected before journaling so the conversation stays
 * coherent.
 */
import type {
  ConversationMessage,
  ConversationToolCall,
  ISODateString,
} from '../../../domain/types.js';
import type { ChatMessage } from '../../ports/outbound/model.js';
import { ModelPortError, type ModelPort } from '../../ports/outbound/model.js';
import type { ChatMessageRepositoryPort } from '../../ports/outbound/repositories.js';
import { FlorinaLoop, LoopError, type LoopEvent } from '../florina/loop.js';
import { FLORINA_CONTRACT_VERSION, renderFlorinaContract } from '../prompting/florina-method.js';
import type { ChatTurnPort, CommandExecutor } from '../tasks/command-api.js';
import { buildChatToolRegistry } from './chat-tools.js';

export interface ChatServiceDeps {
  /** The append-only conversation store (journals every new message). */
  readonly store: ChatMessageRepositoryPort;
  /** Model connector (LiteLLM or compatible). Optional — see below. */
  readonly connector?: ModelPort;
  /** Command executor the chat tools route through (the daemon itself). */
  readonly commandApi: CommandExecutor;
  /** Sink for each journaled message (daemon → `chat:message` push). */
  readonly onMessage?: (message: ConversationMessage) => void;
  /** Sink for ephemeral loop progress (daemon → `chat:event` push). */
  readonly onEvent?: (event: LoopEvent) => void;
  /**
   * System prompt prepended at run time (not journaled — it's config).
   * When set, it replaces the entire default prompt *including the
   * Florina Method contract* — a deliberate opt-out, reported by
   * `methodVersion` becoming undefined.
   */
  readonly systemPrompt?: string;
  readonly maxIterations?: number;
  /** Injectable clock for tests. */
  readonly now?: () => ISODateString;
}

/**
 * Default Secretary persona for the chat surface — plain-language
 * supervision of the user's coding agents, honest about what it can see.
 */
const SECRETARY_PERSONA =
  'You are Florina, the user’s Secretary for their coding agents. ' +
  'You can see the task fleet, the attention inbox, digests, provider quota, ' +
  'and idea ledgers through your tools — check them rather than guessing. ' +
  'Answer concisely and concretely. When something needs the user’s decision ' +
  'or approval, use raise_attention so it lands in their inbox; never grant ' +
  'permissions the user has not asked for in this conversation. ' +
  'When the user asks you to start work, delegate_task is the only path — ' +
  'report what you actually did, not what you would do.';

/**
 * The default Secretary system prompt: the persona composed with the
 * versioned Florina Method contract (#287). The contract disciplines
 * the Secretary's *work* — evidence over assertion, honest states,
 * user-owned decisions surfaced rather than guessed — not its tone.
 */
export const DEFAULT_CHAT_INSTRUCTIONS = `${SECRETARY_PERSONA}\n\n${renderFlorinaContract()}`;

let seq = 0;
function messageId(): string {
  seq += 1;
  return `msg_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** Map a journaled record back onto the model wire union. */
export function toWireMessage(m: ConversationMessage): ChatMessage {
  switch (m.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls !== undefined
          ? {
              toolCalls: m.toolCalls.map((c) => ({
                id: c.id,
                name: c.name,
                arguments: { ...c.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return {
        role: 'tool',
        toolCallId: m.toolCallId ?? '',
        name: m.name ?? '',
        content: m.content ?? '',
        ...(m.isError !== undefined ? { isError: m.isError } : {}),
      };
    default:
      return { role: m.role, content: m.content ?? '' };
  }
}

/** Flatten a wire message into a journalable record. */
export function toConversationMessage(
  m: ChatMessage,
  createdAt: ISODateString,
): Omit<ConversationMessage, 'id'> {
  const base = { createdAt };
  switch (m.role) {
    case 'assistant':
      return {
        ...base,
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls !== undefined
          ? {
              toolCalls: m.toolCalls.map((c): ConversationToolCall => ({
                id: c.id,
                name: c.name,
                arguments: c.arguments,
              })),
            }
          : {}),
      };
    case 'tool':
      return {
        ...base,
        role: 'tool',
        content: m.content,
        toolCallId: m.toolCallId,
        name: m.name,
        ...(m.isError !== undefined ? { isError: m.isError } : {}),
      };
    default:
      return { ...base, role: m.role, content: m.content };
  }
}

export class ChatService implements ChatTurnPort {
  private readonly store: ChatMessageRepositoryPort;
  private readonly connector: ModelPort | undefined;
  private readonly onMessage: ((message: ConversationMessage) => void) | undefined;
  private readonly onEvent: ((event: LoopEvent) => void) | undefined;
  private readonly systemPrompt: string;
  private readonly methodActive: boolean;
  private readonly maxIterations: number | undefined;
  private readonly now: () => ISODateString;
  private readonly tools;
  private inFlight = false;

  constructor(deps: ChatServiceDeps) {
    this.store = deps.store;
    this.connector = deps.connector;
    this.onMessage = deps.onMessage;
    this.onEvent = deps.onEvent;
    this.systemPrompt = deps.systemPrompt ?? DEFAULT_CHAT_INSTRUCTIONS;
    this.methodActive = deps.systemPrompt == null;
    this.maxIterations = deps.maxIterations;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.tools = buildChatToolRegistry(deps.commandApi);
  }

  turnInFlight(): boolean {
    return this.inFlight;
  }

  /** Whether a model is configured — when false, sends journal only. */
  get modelAvailable(): boolean {
    return this.connector !== undefined;
  }

  /**
   * The Florina Method contract version in effect, or `undefined` when
   * a custom `systemPrompt` replaced the composed default. The version
   * also travels inside the system prompt itself (the wire-observable
   * channel — prompts are config, not journaled).
   */
  get methodVersion(): string | undefined {
    return this.methodActive ? FLORINA_CONTRACT_VERSION : undefined;
  }

  /**
   * Run a turn over the visible history. Fire-and-forget from the
   * command layer; failures journal an honest assistant message.
   */
  startTurn(): void {
    if (this.inFlight || this.connector === undefined) return;
    this.inFlight = true;
    void this.runTurn()
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = false;
      });
  }

  private async runTurn(): Promise<void> {
    const connector = this.connector;
    if (connector === undefined) return;

    const history = this.store.listVisible().map(toWireMessage);
    const input: ChatMessage[] = [{ role: 'system', content: this.systemPrompt }, ...history];

    const loop = new FlorinaLoop({
      connector,
      tools: this.tools,
      ...(this.maxIterations !== undefined ? { maxIterations: this.maxIterations } : {}),
      onEvent: (e) => this.onEvent?.(e),
    });

    let result;
    try {
      result = await loop.run(input);
    } catch (err) {
      // Honest failure surface: journal an assistant message so the user
      // sees the turn failed in the thread itself, not a silent gap.
      const detail =
        err instanceof LoopError || err instanceof ModelPortError ? err.message : String(err);
      this.journal({
        role: 'assistant',
        content: `I couldn't complete that turn — ${detail}`,
        createdAt: this.now(),
      });
      return;
    }

    // Journal everything the loop produced beyond the input, in order.
    for (const wire of result.messages.slice(input.length)) {
      this.journal(toConversationMessage(wire, this.now()));
    }
  }

  private journal(record: Omit<ConversationMessage, 'id'>): ConversationMessage {
    const message: ConversationMessage = { ...record, id: messageId() };
    this.store.append(message);
    this.onMessage?.(message);
    return message;
  }
}
