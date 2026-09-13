import { describe, it, expect, vi } from 'vitest';
import {
  Condenser,
  extractiveSummarizer,
  SecretaryLoop,
  ToolRegistry,
  type ChatMessage,
  type CompletionResponse,
  type LoopEvent,
  type ModelConnector,
} from '../src/secretary/index.js';

const user = (n: number): ChatMessage => ({ role: 'user', content: `message ${n}` });

describe('Condenser', () => {
  it('is a no-op below the threshold', async () => {
    const condenser = new Condenser({ threshold: 10, keepFirst: 2, keepLast: 3 });
    const messages = [user(0), user(1), user(2)];
    const result = await condenser.condense(messages);
    expect(result.condensation).toBeNull();
    expect(result.messages).toEqual(messages);
  });

  it('keeps head and tail verbatim and summarizes the middle', async () => {
    const summarize = vi.fn(async () => 'MIDDLE SUMMARY');
    const condenser = new Condenser({
      threshold: 6,
      keepFirst: 2,
      keepLast: 2,
      summarize,
    });
    const messages = Array.from({ length: 10 }, (_, i) => user(i));

    const result = await condenser.condense(messages);

    expect(summarize).toHaveBeenCalledTimes(1);
    // Middle = indexes 2..7 (8 msgs minus 2 head minus 2 tail).
    expect(summarize.mock.calls[0][0]).toHaveLength(6);
    expect(result.condensation?.summary).toBe('MIDDLE SUMMARY');
    expect(result.condensation?.forgottenIndexes).toEqual([2, 3, 4, 5, 6, 7]);
    expect(result.condensation?.keptCount).toBe(4);
    // Result: 2 head + 1 summary + 2 tail.
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0]).toEqual(user(0));
    expect(result.messages[1]).toEqual(user(1));
    expect(result.messages[2].role).toBe('system');
    expect(result.messages[2]).toMatchObject({ role: 'system' });
    if (result.messages[2].role === 'system') {
      expect(result.messages[2].content).toContain('MIDDLE SUMMARY');
    }
    expect(result.messages[3]).toEqual(user(8));
    expect(result.messages[4]).toEqual(user(9));
  });

  it('does not mutate the input array', async () => {
    const condenser = new Condenser({ threshold: 4, keepFirst: 1, keepLast: 1 });
    const messages = Array.from({ length: 8 }, (_, i) => user(i));
    await condenser.condense(messages);
    expect(messages).toHaveLength(8);
  });

  it('returns input unchanged when head+tail cover the whole history', async () => {
    const condenser = new Condenser({ threshold: 3, keepFirst: 3, keepLast: 3 });
    const messages = Array.from({ length: 6 }, (_, i) => user(i));
    const result = await condenser.condense(messages);
    expect(result.condensation).toBeNull();
    expect(result.messages).toEqual(messages);
  });

  it('extractive fallback names roles and tool calls without a model', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first line\nsecond line' },
      {
        role: 'assistant',
        content: 'calling a tool',
        toolCalls: [{ id: 'c1', name: 'todo', arguments: { action: 'list' } }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'todo', content: 'list result' },
    ];
    const summary = await extractiveSummarizer(messages);
    expect(summary).toContain('user');
    expect(summary).toContain('called todo');
    expect(summary).toContain('tool todo');
  });
});

describe('SecretaryLoop + Condenser', () => {
  it('condenses the model view each iteration and emits provenance', async () => {
    const seen: number[] = [];
    const connector: ModelConnector = {
      complete: async (req) => {
        seen.push(req.messages.length);
        return { content: 'done', toolCalls: [] } satisfies CompletionResponse;
      },
    };
    const condenser = new Condenser({ threshold: 4, keepFirst: 1, keepLast: 1 });
    const events: LoopEvent[] = [];
    const loop = new SecretaryLoop({
      connector,
      tools: new ToolRegistry(),
      condenser,
      onEvent: (e) => events.push(e),
    });

    const input = Array.from({ length: 8 }, (_, i) => user(i));
    const result = await loop.run(input);

    // Model saw 1 head + 1 summary + 1 tail = 3, not 8.
    expect(seen).toEqual([3]);
    const condensed = events.find((e) => e.kind === 'condensed');
    expect(condensed).toMatchObject({ forgottenCount: 6, keptCount: 2 });
    // The returned messages keep the FULL record for the journal.
    expect(result.messages.length).toBe(9);
  });
});
