/**
 * Condenser — rolling context compaction for the Secretary's loop
 * (DEC-035, issue #75).
 *
 * Conversation histories grow without bound; the model's context window
 * does not. The condenser implements the OpenHands pattern adapted to our
 * message model:
 *
 * - Keep the first `keepFirst` messages verbatim (the system prompt and the
 *   original instruction set the frame).
 * - Keep the last `keepLast` messages verbatim (recent turns are load-bearing).
 * - Replace the middle span with a single system message containing a
 *   summary produced by an injectable `summarize` function — a LiteLLM call
 *   in production, a deterministic extractive fallback in tests or when no
 *   model is wired.
 *
 * Provenance: the returned {@link Condensation} names which message
 * positions were rolled up so the daemon can emit a journaled
 * `ContextCondensed` event with `forgottenEventIds` (DEC-012/035 — source
 * events stay in the journal; only the active context shrinks).
 */
import type { ChatMessage } from './messages.js';

/** Provenance record of one condensation. */
export interface Condensation {
  /** The summary that replaced the middle span. */
  readonly summary: string;
  /** Positions (into the input array) of the messages rolled up. */
  readonly forgottenIndexes: readonly number[];
  /** How many messages were kept verbatim (head + tail). */
  readonly keptCount: number;
}

/** Result of {@link Condenser.condense}. */
export interface CondenseResult {
  /** The compacted conversation (or the original when below threshold). */
  readonly messages: readonly ChatMessage[];
  /** The condensation record, or null when nothing was compacted. */
  readonly condensation: Condensation | null;
}

/** Summarizer seam — production wires a model call; tests stay deterministic. */
export type Summarizer = (messages: readonly ChatMessage[]) => Promise<string>;

/** Options for {@link Condenser}. */
export interface CondenserOptions {
  /**
   * Compact only when the conversation exceeds this many messages
   * (default 40). Set lower to compact more aggressively — DEC-035 wants
   * continuous compaction, not just near-limit rescue.
   */
  readonly threshold?: number;
  /** Messages preserved verbatim from the head (default 2: system + first user turn). */
  readonly keepFirst?: number;
  /** Messages preserved verbatim from the tail (default 12). */
  readonly keepLast?: number;
  /**
   * Summarizer for the middle span. Defaults to
   * {@link extractiveSummarizer}, which needs no model.
   */
  readonly summarize?: Summarizer;
}

const CONDENSED_PREFIX = '[context condensed — earlier messages summarized; full history remains in the event journal]';

/**
 * Deterministic extractive fallback: keeps each message's role, tool names,
 * and first line of content, truncated. Used when no model summarizer is
 * configured — lossy but honest (the journal holds the originals).
 */
export const extractiveSummarizer: Summarizer = async (messages) => {
  const lines = messages.map((m, i) => {
    switch (m.role) {
      case 'assistant': {
        const calls = m.toolCalls?.map((c) => c.name).join(', ');
        const head = (m.content ?? '').split('\n')[0].slice(0, 120);
        return `- [${i}] assistant${calls !== undefined ? ` called ${calls}` : ''}: ${head}`;
      }
      case 'tool':
        return `- [${i}] tool ${m.name}${m.isError === true ? ' (error)' : ''}: ${m.content.split('\n')[0].slice(0, 120)}`;
      default:
        return `- [${i}] ${m.role}: ${m.content.split('\n')[0].slice(0, 160)}`;
    }
  });
  return lines.join('\n');
};

export class Condenser {
  private readonly threshold: number;
  private readonly keepFirst: number;
  private readonly keepLast: number;
  private readonly summarize: Summarizer;

  constructor(options: CondenserOptions = {}) {
    this.threshold = options.threshold ?? 40;
    this.keepFirst = options.keepFirst ?? 2;
    this.keepLast = options.keepLast ?? 12;
    this.summarize = options.summarize ?? extractiveSummarizer;
  }

  /**
   * Compact `messages` when they exceed the threshold. The input is not
   * mutated. Below threshold (or when head+tail would overlap) returns the
   * input unchanged with `condensation: null`.
   */
  async condense(messages: readonly ChatMessage[]): Promise<CondenseResult> {
    if (messages.length <= this.threshold) {
      return { messages, condensation: null };
    }
    const head = this.keepFirst;
    const tail = this.keepLast;
    if (head + tail >= messages.length) {
      return { messages, condensation: null };
    }

    const middle = messages.slice(head, messages.length - tail);
    const summary = await this.summarize(middle);
    const forgottenIndexes = middle.map((_, i) => head + i);

    const condensed: ChatMessage = {
      role: 'system',
      content: `${CONDENSED_PREFIX}\n${summary}`,
    };

    return {
      messages: [...messages.slice(0, head), condensed, ...messages.slice(messages.length - tail)],
      condensation: {
        summary,
        forgottenIndexes,
        keptCount: head + tail,
      },
    };
  }
}
