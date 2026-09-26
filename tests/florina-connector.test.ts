import { describe, it, expect, vi } from 'vitest';
import { LiteLLMConnector, ConnectorError, ToolRegistry } from '../src/florina/index.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LiteLLMConnector', () => {
  it('posts an OpenAI-shaped request to the proxy /v1 endpoint', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'hi' } }] }),
    );
    const connector = new LiteLLMConnector({
      baseUrl: 'http://litellm.local:4000/',
      model: 'claude-sonnet',
      apiKey: 'sk-proxy',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const registry = new ToolRegistry();
    registry.register({
      name: 'lookup',
      description: 'look a thing up',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
      execute: async () => ({ content: 'ok' }),
    });

    await connector.complete({
      messages: [
        { role: 'system', content: 'you are Florina' },
        { role: 'user', content: 'hello' },
      ],
      tools: registry.specs(),
      temperature: 0.2,
    });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://litellm.local:4000/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-proxy');

    // The registry emits provider-neutral specs; translation to the
    // OpenAI `tools[]` wire shape happens only inside the connector.
    const spec = registry.specs()[0] as unknown as Record<string, unknown>;
    expect(spec).toEqual({
      name: 'lookup',
      description: 'look a thing up',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    });
    expect(spec.type).toBeUndefined();
    expect(spec.function).toBeUndefined();

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet');
    expect(body.temperature).toBe(0.2);
    expect(body.tool_choice).toBe('auto');
    const tools = body.tools as {
      type: string;
      function: { name: string; description: string; parameters: unknown };
    }[];
    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('lookup');
    expect(tools[0].function.description).toBe('look a thing up');
    expect(tools[0].function.parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    const messages = body.messages as { role: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('sends reasoning_effort when configured (e.g. gpt-5.6-luna requires it for tools)', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'hi' } }] }),
    );
    const connector = new LiteLLMConnector({
      baseUrl: 'http://litellm.local:4000',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'none',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    await connector.complete({ messages: [{ role: 'user', content: 'hi' }] });

    const [, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('none');
  });

  it('serializes tool calls and tool results back onto the wire', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'done' } }] }),
    );
    const connector = new LiteLLMConnector({
      baseUrl: 'http://litellm.local:4000',
      model: 'm',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    await connector.complete({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
        },
        { role: 'tool', toolCallId: 'c1', name: 'lookup', content: 'result' },
      ],
    });

    const [, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    const messages = (JSON.parse(init.body as string) as { messages: unknown[] })
      .messages as Record<string, unknown>[];
    expect(messages[1].tool_calls).toEqual([
      {
        id: 'c1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"x"}' },
      },
    ]);
    expect(messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
      name: 'lookup',
      content: 'result',
    });
  });

  it('parses tool_calls and usage from the response', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'todo', arguments: '{"action":"list"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const connector = new LiteLLMConnector({
      baseUrl: 'http://litellm.local:4000',
      model: 'm',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const res = await connector.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'todo', arguments: { action: 'list' } }]);
    expect(res.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('treats malformed tool-call arguments as an empty object', async () => {
    const fakeFetch = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c',
                  type: 'function',
                  function: { name: 'todo', arguments: 'not json' },
                },
              ],
            },
          },
        ],
      }),
    );
    const connector = new LiteLLMConnector({
      baseUrl: 'http://x',
      model: 'm',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const res = await connector.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.toolCalls[0].arguments).toEqual({});
  });

  it('throws ConnectorError with status and body on HTTP failure', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const connector = new LiteLLMConnector({
      baseUrl: 'http://x',
      model: 'm',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const err = await connector
      .complete({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).status).toBe(500);
  });

  it('throws ConnectorError when the proxy returns non-JSON', async () => {
    const fakeFetch = vi.fn(async () => new Response('<html>proxy down</html>', { status: 200 }));
    const connector = new LiteLLMConnector({
      baseUrl: 'http://x',
      model: 'm',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(
      connector.complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it('throws ConnectorError when fetch itself rejects', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('socket hangup');
    });
    const connector = new LiteLLMConnector({
      baseUrl: 'http://x',
      model: 'm',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(
      connector.complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });
});
