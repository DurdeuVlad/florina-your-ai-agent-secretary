import { describe, it, expect, vi } from 'vitest';
import {
  SecretaryLoop,
  LoopError,
  ConnectorError,
  ToolRegistry,
  TodoStore,
  createTodoTool,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type LoopEvent,
  type ModelConnector,
} from '../src/secretary/index.js';

/** Scripted fake connector: pops one canned response per complete() call. */
class ScriptedConnector implements ModelConnector {
  readonly requests: CompletionRequest[] = [];
  private readonly script: (CompletionResponse | ((req: CompletionRequest) => CompletionResponse))[];

  constructor(script: typeof this.script) {
    this.script = [...script];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (next === undefined) {
      throw new ConnectorError('script exhausted');
    }
    return typeof next === 'function' ? next(request) : next;
  }
}

const ok = (content: string | null): CompletionResponse => ({ content, toolCalls: [] });

describe('SecretaryLoop', () => {
  it('returns the final answer when the model does not call tools', async () => {
    const connector = new ScriptedConnector([ok('all done')]);
    const loop = new SecretaryLoop({ connector, tools: new ToolRegistry() });

    const result = await loop.run([{ role: 'user', content: 'hi' }]);

    expect(result.iterations).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.final).toEqual({ role: 'assistant', content: 'all done' });
    expect(result.messages).toHaveLength(2);
  });

  it('executes tool calls and feeds results back until a final answer', async () => {
    const connector = new ScriptedConnector([
      {
        content: null,
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hello' } }],
      },
      (req) => {
        // The last message must be the tool result for c1.
        const last = req.messages[req.messages.length - 1];
        expect(last).toMatchObject({
          role: 'tool',
          toolCallId: 'c1',
          name: 'echo',
          content: 'hello',
        });
        return ok('echoed: hello');
      },
    ]);

    const tools = new ToolRegistry();
    const execute = vi.fn(async (args: Record<string, unknown>) => ({
      content: String(args.text),
    }));
    tools.register({
      name: 'echo',
      description: 'echo text',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute,
    });

    const events: LoopEvent[] = [];
    const loop = new SecretaryLoop({
      connector,
      tools,
      onEvent: (e) => events.push(e),
    });

    const result = await loop.run([{ role: 'user', content: 'echo hello' }]);

    expect(execute).toHaveBeenCalledWith({ text: 'hello' }, {});
    expect(result.iterations).toBe(2);
    expect(result.final).toEqual({ role: 'assistant', content: 'echoed: hello' });
    // user → assistant(tool_calls) → tool result → assistant(final)
    expect(result.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      'iteration',
      'tool_call',
      'tool_result',
      'iteration',
      'completed',
    ]);
  });

  it('reports unknown tools back to the model as error results', async () => {
    const connector = new ScriptedConnector([
      {
        content: null,
        toolCalls: [{ id: 'c1', name: 'nonexistent', arguments: {} }],
      },
      ok('recovered'),
    ]);
    const loop = new SecretaryLoop({ connector, tools: new ToolRegistry() });

    const result = await loop.run([{ role: 'user', content: 'x' }]);

    const toolMsg = result.messages[2];
    expect(toolMsg).toMatchObject({ role: 'tool', isError: true });
    if (toolMsg.role === 'tool') {
      expect(toolMsg.content).toContain('unknown tool');
    }
    expect(result.truncated).toBe(false);
  });

  it('reports tool exceptions as error results without crashing', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'explode',
      description: 'throws',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const connector = new ScriptedConnector([
      { content: null, toolCalls: [{ id: 'c1', name: 'explode', arguments: {} }] },
      ok('handled'),
    ]);
    const loop = new SecretaryLoop({ connector, tools });
    const result = await loop.run([{ role: 'user', content: 'x' }]);
    expect(result.messages[2]).toMatchObject({ role: 'tool', isError: true });
  });

  it('stops at maxIterations and reports truncated', async () => {
    const connector = new ScriptedConnector(
      Array.from({ length: 10 }, (_, i) => ({
        content: null,
        toolCalls: [{ id: `c${i}`, name: 'noop', arguments: {} }],
      })),
    );
    const tools = new ToolRegistry();
    tools.register({
      name: 'noop',
      description: 'no-op',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: 'ok' }),
    });
    const events: LoopEvent[] = [];
    const loop = new SecretaryLoop({
      connector,
      tools,
      maxIterations: 3,
      onEvent: (e) => events.push(e),
    });

    const result = await loop.run([{ role: 'user', content: 'loop forever' }]);

    expect(result.truncated).toBe(true);
    expect(result.iterations).toBe(3);
    expect(events.some((e) => e.kind === 'iteration_limit')).toBe(true);
  });

  it('wraps connector failures in LoopError', async () => {
    const connector = new ScriptedConnector([]);
    const loop = new SecretaryLoop({ connector, tools: new ToolRegistry() });
    await expect(loop.run([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(
      LoopError,
    );
  });

  it('forwards usage events for journaling', async () => {
    const connector = new ScriptedConnector([
      {
        content: 'done',
        toolCalls: [],
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      },
    ]);
    const events: LoopEvent[] = [];
    const loop = new SecretaryLoop({
      connector,
      tools: new ToolRegistry(),
      onEvent: (e) => events.push(e),
    });
    await loop.run([{ role: 'user', content: 'x' }]);
    const usage = events.find((e) => e.kind === 'usage');
    expect(usage).toMatchObject({ promptTokens: 3, totalTokens: 5 });
  });

  it('does not mutate the caller-provided message array', async () => {
    const connector = new ScriptedConnector([ok('ok')]);
    const loop = new SecretaryLoop({ connector, tools: new ToolRegistry() });
    const input: ChatMessage[] = [{ role: 'user', content: 'x' }];
    await loop.run(input);
    expect(input).toHaveLength(1);
  });
});

describe('todo tool', () => {
  it('supports add, list, update, remove, replace, clear', async () => {
    const store = new TodoStore();
    const tool = createTodoTool(store);

    const added = await tool.execute({ action: 'add', content: 'first' }, {});
    expect(added.content).toContain('todo-1');
    expect(added.content).toContain('first');

    await tool.execute({ action: 'add', content: 'second' }, {});
    await tool.execute({ action: 'update', id: 'todo-1', status: 'completed' }, {});
    const items = store.list();
    expect(items.map((i) => i.status)).toEqual(['completed', 'pending']);

    await tool.execute({ action: 'remove', id: 'todo-2' }, {});
    expect(store.list()).toHaveLength(1);

    await tool.execute({ action: 'replace', items: ['a', 'b'] }, {});
    expect(store.list().map((i) => i.content)).toEqual(['a', 'b']);
    expect(store.list().every((i) => i.status === 'pending')).toBe(true);

    await tool.execute({ action: 'clear' }, {});
    expect(store.list()).toHaveLength(0);
    expect((await tool.execute({ action: 'list' }, {})).content).toContain('empty');
  });

  it('rejects malformed arguments with a typed error the registry converts', async () => {
    const registry = new ToolRegistry();
    registry.register(createTodoTool(new TodoStore()));

    const bad = await registry.execute('todo', { action: 'update', id: 'nope' });
    expect(bad.isError).toBe(true);

    const unknown = await registry.execute('todo', { action: 'bogus' });
    expect(unknown.isError).toBe(true);
  });
});

describe('ToolRegistry', () => {
  it('rejects duplicate and empty tool names', () => {
    const registry = new ToolRegistry();
    const tool = {
      name: 'x',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: 'ok' }),
    } as const;
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
    expect(() => registry.register({ ...tool, name: '' })).toThrow(/empty/);
  });
});
