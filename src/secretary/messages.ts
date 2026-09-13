/**
 * Chat message types for the Secretary's agentic loop (DEC-034, issue #70).
 *
 * The wire shape deliberately follows the OpenAI chat-completions vocabulary
 * so the LiteLLM connector can serialize messages verbatim and any other
 * OpenAI-compatible connector needs no mapping. Internal code treats
 * `tool_calls[].arguments` as a parsed object; connectors handle JSON
 * string encoding/decoding at the wire boundary.
 */

/** A tool invocation requested by the model. */
export interface ToolCall {
  /** Unique call id, echoed back in the tool result message. */
  readonly id: string;
  /** Registered tool name. */
  readonly name: string;
  /** Parsed argument object for the tool. */
  readonly arguments: Record<string, unknown>;
}

/** A message in the Secretary's conversation. */
export type ChatMessage =
  | {
      readonly role: 'system' | 'user';
      readonly content: string;
    }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: 'tool';
      /** Which tool_call this message answers. */
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
      /** True when the tool execution failed (still a valid response). */
      readonly isError?: boolean;
    };

/** Construct an assistant message carrying tool calls. */
export function assistantToolCalls(
  calls: readonly ToolCall[],
  content: string | null = null,
): ChatMessage {
  return { role: 'assistant', content, toolCalls: calls };
}

/** Construct a tool result message answering `call`. */
export function toolResult(
  call: ToolCall,
  content: string,
  isError = false,
): ChatMessage {
  return { role: 'tool', toolCallId: call.id, name: call.name, content, isError };
}
