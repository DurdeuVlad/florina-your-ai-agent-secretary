/**
 * Model port — the core-owned seam between the Florina's reasoning loop
 * and whatever model serves it (DEC-034, issue #70).
 *
 * Provider-neutral: the port carries an abstract chat/tool vocabulary —
 * messages, tool calls, and JSON-Schema parameter specs — with no
 * provider wire format baked in. Each outbound model adapter maps these
 * contracts onto its provider's protocol (the OpenAI-style `tools[]`
 * envelope, for example, is applied by the LiteLLM adapter at its own
 * boundary). Internal code treats `toolCalls[].arguments` as a parsed
 * object; adapters handle wire encoding/decoding.
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

/** A message in the Florina's conversation. */
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

/** JSON-Schema object describing a tool's parameters (subset we emit). */
export type ToolParameters = {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
};

/** Provider-neutral specification of one tool a model may call. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameters;
}

/** One completion request to the model. */
export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  /** Sampling temperature; omitted = provider default. */
  readonly temperature?: number;
}

/** The model's response to a completion request. */
export interface CompletionResponse {
  /** Assistant content; may be null when the response is only tool calls. */
  readonly content: string | null;
  /** Tool calls the model wants executed. */
  readonly toolCalls: readonly ToolCall[];
  /** Token accounting when the provider reports it (feeds QuotaLedger). */
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
  };
}

/** The model seam: given conversation + available tools, produce the next step. */
export interface ModelPort {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/**
 * Raised when a model call fails. Provider-specific failure details (HTTP
 * status, response body, ...) belong to the concrete adapter's own error
 * subclass — the core only sees the message.
 */
export class ModelPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelPortError';
  }
}

/** @deprecated Use {@link ModelPort}; retained for compatibility. */
export type ModelConnector = ModelPort;
