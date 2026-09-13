/**
 * SecretaryLoop — the only agentic loop this project owns (DEC-001/034,
 * issue #70).
 *
 * The loop is deliberately stateless across iterations (OpenHands pattern):
 * each model call receives the full conversation — messages, tool calls,
 * and tool results appended so far — so the append-only history IS the
 * memory and can be journaled verbatim (DEC-012). A run ends when the model
 * answers without tool calls, or when `maxIterations` is hit (a safety net,
 * not a plan).
 *
 * Every step is reported through {@link LoopEvent} callbacks; the daemon
 * wiring journals them as SupervisorEvents.
 */
import type { ChatMessage } from './messages.js';
import { assistantToolCalls, toolResult } from './messages.js';
import type { Condenser } from './condenser.js';
import type { CompletionResponse, ModelConnector } from './model-connector.js';
import { ConnectorError } from './model-connector.js';
import type { ToolContext, ToolRegistry } from './tool-registry.js';

/** One observable step of the loop, for journaling/inspection. */
export type LoopEvent =
  | { readonly kind: 'iteration'; readonly iteration: number }
  | {
      readonly kind: 'tool_call';
      readonly iteration: number;
      readonly name: string;
      readonly callId: string;
      readonly arguments: Record<string, unknown>;
    }
  | {
      readonly kind: 'tool_result';
      readonly iteration: number;
      readonly name: string;
      readonly callId: string;
      readonly isError: boolean;
    }
  | {
      readonly kind: 'usage';
      readonly iteration: number;
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly totalTokens?: number;
    }
  | { readonly kind: 'completed'; readonly iterations: number }
  | {
      readonly kind: 'condensed';
      readonly iteration: number;
      /** Messages rolled up into the summary (positions into the history). */
      readonly forgottenCount: number;
      readonly keptCount: number;
    }
  | {
      readonly kind: 'iteration_limit';
      readonly iterations: number;
    };

/** Options for {@link SecretaryLoop}. */
export interface SecretaryLoopOptions {
  readonly connector: ModelConnector;
  readonly tools: ToolRegistry;
  /** Hard cap on model round-trips per run (default 25). */
  readonly maxIterations?: number;
  /** Optional event sink — the daemon journals these (DEC-012). */
  readonly onEvent?: (event: LoopEvent) => void;
  /** Optional sampling temperature forwarded to the connector. */
  readonly temperature?: number;
  /** Context handed through to every tool execution. */
  readonly toolContext?: ToolContext;
  /**
   * Optional {@link Condenser} — when set, the history is compacted before
   * every model call and each compaction emits a `condensed` event with
   * provenance (DEC-035). The un-condensed history is still returned in
   * `LoopResult.messages` so the full record stays journalable.
   */
  readonly condenser?: Condenser;
}

/** Outcome of {@link SecretaryLoop.run}. */
export interface LoopResult {
  /** The final assistant message (content without tool calls). */
  readonly final: ChatMessage;
  /** Model round-trips used. */
  readonly iterations: number;
  /** Full conversation including tool traffic — the journalable record. */
  readonly messages: readonly ChatMessage[];
  /** True when the run stopped at `maxIterations` rather than completing. */
  readonly truncated: boolean;
}

/** Raised when the connector fails mid-run. */
export class LoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopError';
  }
}

export class SecretaryLoop {
  private readonly connector: ModelConnector;
  private readonly tools: ToolRegistry;
  private readonly maxIterations: number;
  private readonly onEvent: ((event: LoopEvent) => void) | undefined;
  private readonly temperature: number | undefined;
  private readonly toolContext: ToolContext;
  private readonly condenser: Condenser | undefined;

  constructor(options: SecretaryLoopOptions) {
    this.connector = options.connector;
    this.tools = options.tools;
    this.maxIterations = options.maxIterations ?? 25;
    this.onEvent = options.onEvent;
    this.temperature = options.temperature;
    this.toolContext = options.toolContext ?? {};
    this.condenser = options.condenser;
  }

  /**
   * Run the loop over `messages` until the model stops calling tools.
   * The input array is not mutated; the result carries the full record.
   */
  async run(messages: readonly ChatMessage[]): Promise<LoopResult> {
    const history: ChatMessage[] = [...messages];
    let iteration = 0;

    while (true) {
      iteration += 1;
      this.emit({ kind: 'iteration', iteration });

      // Continuous compaction (DEC-035): the model sees the condensed
      // view; `history` keeps the full record for the journal.
      let view: readonly ChatMessage[] = history;
      if (this.condenser !== undefined) {
        const condensed = await this.condenser.condense(history);
        if (condensed.condensation !== null) {
          this.emit({
            kind: 'condensed',
            iteration,
            forgottenCount: condensed.condensation.forgottenIndexes.length,
            keptCount: condensed.condensation.keptCount,
          });
          view = condensed.messages;
        }
      }

      let response: CompletionResponse;
      try {
        response = await this.connector.complete({
          messages: view,
          tools: this.tools.specs(),
          temperature: this.temperature,
        });
      } catch (err) {
        if (err instanceof ConnectorError) {
          throw new LoopError(`model call failed: ${err.message}`);
        }
        throw err;
      }

      if (response.usage !== undefined) {
        this.emit({ kind: 'usage', iteration, ...response.usage });
      }

      if (response.toolCalls.length === 0) {
        const final: ChatMessage = { role: 'assistant', content: response.content ?? '' };
        history.push(final);
        this.emit({ kind: 'completed', iterations: iteration });
        return { final, iterations: iteration, messages: history, truncated: false };
      }

      history.push(assistantToolCalls(response.toolCalls, response.content));

      for (const call of response.toolCalls) {
        this.emit({
          kind: 'tool_call',
          iteration,
          name: call.name,
          callId: call.id,
          arguments: call.arguments,
        });
        const result = await this.tools.execute(call.name, call.arguments, this.toolContext);
        this.emit({
          kind: 'tool_result',
          iteration,
          name: call.name,
          callId: call.id,
          isError: result.isError === true,
        });
        history.push(toolResult(call, result.content, result.isError === true));
      }

      if (iteration >= this.maxIterations) {
        this.emit({ kind: 'iteration_limit', iterations: iteration });
        const final = history[history.length - 1];
        return { final, iterations: iteration, messages: history, truncated: true };
      }
    }
  }

  private emit(event: LoopEvent): void {
    this.onEvent?.(event);
  }
}
