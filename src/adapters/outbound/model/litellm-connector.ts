/**
 * ModelConnector — the Secretary's plug-and-play model boundary
 * (DEC-034, issue #70).
 *
 * {@link ModelConnector} is the single seam between the reasoning loop and
 * whatever model serves it. {@link LiteLLMConnector} implements it against
 * a LiteLLM proxy's OpenAI-compatible `/v1/chat/completions` endpoint, so
 * any of LiteLLM's 100+ providers (and spend tracking — which feeds the
 * QuotaLedger, DEC-029) is reachable by changing config, not code.
 *
 * `fetch` is injectable so tests exercise the connector without network I/O.
 */
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ModelPort,
  ToolCall,
} from '../../../core/application/ports/outbound/model.js';
import { ModelPortError } from '../../../core/application/ports/outbound/model.js';

/**
 * Re-export the core-owned model contract so connector consumers can keep
 * importing it from this module. The source of truth is
 * `src/core/application/ports/outbound/model.ts` (DEC-037).
 */
export type {
  CompletionRequest,
  CompletionResponse,
  ModelConnector,
} from '../../../core/application/ports/outbound/model.js';

/**
 * Raised when the connector's HTTP call fails or returns an unusable
 * payload. Carries the provider-specific details (`status`, `body`) that
 * the core port deliberately does not model.
 */
export class ConnectorError extends ModelPortError {
  readonly status: number | null;
  readonly body: string | null;

  constructor(message: string, status: number | null = null, body: string | null = null) {
    super(message);
    this.name = 'ConnectorError';
    this.status = status;
    this.body = body;
  }
}

/** Options for {@link LiteLLMConnector}. */
export interface LiteLLMConnectorOptions {
  /** LiteLLM proxy base URL (e.g. `http://localhost:4000`); `/v1` suffix optional. */
  readonly baseUrl: string;
  /** Model name as registered in the LiteLLM proxy (e.g. `gpt-5`, `claude-sonnet`). */
  readonly model: string;
  /** Optional proxy key, sent as `Authorization: Bearer`. */
  readonly apiKey?: string;
  /** Injectable fetch implementation (defaults to global fetch). */
  readonly fetch?: typeof fetch;
}

/* ------------------------------------------------------------------ *
 * OpenAI wire shapes (subset)
 * ------------------------------------------------------------------ */
interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface WireCompletion {
  choices: { message: { content: string | null; tool_calls?: WireToolCall[] } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function toWireMessage(message: ChatMessage): WireMessage {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    case 'tool':
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
        name: message.name,
      };
    default:
      return { role: message.role, content: message.content };
  }
}

function parseToolCall(call: WireToolCall): ToolCall {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed arguments surface to the tool as empty; the tool's own
    // validation decides whether that is an error.
  }
  return { id: call.id, name: call.function.name, arguments: args };
}

/**
 * OpenAI-compatible chat-completions client for a LiteLLM proxy.
 *
 * Stateless: each {@link complete} call sends the full message list the loop
 * gives it — the journal is the memory (DEC-012), not connector state.
 */
export class LiteLLMConnector implements ModelPort {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly doFetch: typeof fetch;

  constructor(options: LiteLLMConnectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    const f = options.fetch ?? globalThis.fetch;
    if (f === undefined) {
      throw new ConnectorError('no fetch implementation available');
    }
    this.doFetch = f.bind(globalThis) as typeof fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toWireMessage),
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      // Provider-neutral ToolSpecs are translated to the OpenAI `tools[]`
      // wire shape here — the only place that mapping exists.
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ConnectorError(
        `LiteLLM request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new ConnectorError(
        `LiteLLM responded ${response.status}`,
        response.status,
        text,
      );
    }

    let wire: WireCompletion;
    try {
      wire = JSON.parse(text) as WireCompletion;
    } catch {
      throw new ConnectorError('LiteLLM returned non-JSON response', response.status, text);
    }

    const message = wire.choices?.[0]?.message;
    if (message === undefined) {
      throw new ConnectorError('LiteLLM response contained no choices', response.status, text);
    }

    return {
      content: message.content,
      toolCalls: (message.tool_calls ?? []).map(parseToolCall),
      usage:
        wire.usage === undefined
          ? undefined
          : {
              promptTokens: wire.usage.prompt_tokens,
              completionTokens: wire.usage.completion_tokens,
              totalTokens: wire.usage.total_tokens,
            },
    };
  }
}
