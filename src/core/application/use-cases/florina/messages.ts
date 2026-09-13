/**
 * Chat message helpers for the Florina's agentic loop (DEC-034, issue #70).
 *
 * The `ChatMessage`/`ToolCall` wire types are owned by the model port
 * (`src/core/application/ports/outbound/model.ts`) and re-exported here.
 * The wire shape deliberately follows the OpenAI chat-completions vocabulary
 * so the LiteLLM connector can serialize messages verbatim and any other
 * OpenAI-compatible connector needs no mapping. Internal code treats
 * `tool_calls[].arguments` as a parsed object; connectors handle JSON
 * string encoding/decoding at the wire boundary.
 */
import type { ChatMessage, ToolCall } from '../../ports/outbound/model.js';

export type { ChatMessage, ToolCall } from '../../ports/outbound/model.js';

/** Construct an assistant message carrying tool calls. */
export function assistantToolCalls(
  calls: readonly ToolCall[],
  content: string | null = null,
): ChatMessage {
  return { role: 'assistant', content, toolCalls: calls };
}

/** Construct a tool result message answering `call`. */
export function toolResult(call: ToolCall, content: string, isError = false): ChatMessage {
  return { role: 'tool', toolCallId: call.id, name: call.name, content, isError };
}
