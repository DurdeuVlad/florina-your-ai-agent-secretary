/**
 * ChatService tests (issue #158) — Secretary turns over the journaled
 * conversation: loop orchestration, tool routing through the command
 * executor, journaled message tail, ephemeral progress events, and the
 * in-flight guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { StorageDatabase } from '../src/storage/index.js';
import { ChatMessageRepository } from '../src/adapters/outbound/persistence/sqlite/repositories/chat-message.js';
import {
  ChatService,
  DEFAULT_CHAT_INSTRUCTIONS,
  toWireMessage,
  toConversationMessage,
} from '../src/core/application/use-cases/chat/chat-service.js';
import {
  FLORINA_CONTRACT_VERSION,
  renderFlorinaContract,
} from '../src/core/application/use-cases/prompting/florina-method.js';
import { ModelPortError } from '../src/core/application/ports/outbound/model.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ModelPort,
} from '../src/core/application/ports/outbound/model.js';
import type { Command, CommandExecutor, Response } from '../src/daemon/command-api.js';
import type { ConversationMessage } from '../src/domain/types.js';

/** Scripted connector — each queued response answers one model call. */
class ScriptedConnector implements ModelPort {
  readonly requests: CompletionRequest[] = [];
  private readonly queue: (CompletionResponse | Error)[] = [];

  enqueue(res: CompletionResponse | Error): void {
    this.queue.push(res);
  }

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    // Snapshot — the loop mutates the history array after this returns.
    this.requests.push({ ...req, messages: [...req.messages] });
    const next = this.queue.shift();
    if (next === undefined) return Promise.reject(new Error('scripted connector exhausted'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}

function userMessage(content: string): ConversationMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  };
}

describe('ChatService', () => {
  let db: StorageDatabase;
  let store: ChatMessageRepository;
  let connector: ScriptedConnector;
  let executed: Command[];
  let journaled: ConversationMessage[];
  let events: unknown[];
  let executor: CommandExecutor;

  beforeEach(() => {
    db = new StorageDatabase({ path: ':memory:' });
    db.open();
    store = new ChatMessageRepository(db.connection);
    connector = new ScriptedConnector();
    executed = [];
    journaled = [];
    events = [];
    executor = {
      execute: (cmd: Command) => {
        executed.push(cmd);
        return Promise.resolve({ ok: true, items: [] } as Response);
      },
    };
  });

  afterEach(() => {
    db.close();
  });

  function service(extra: Partial<ConstructorParameters<typeof ChatService>[0]> = {}) {
    return new ChatService({
      store,
      connector,
      commandApi: executor,
      onMessage: (m) => journaled.push(m),
      onEvent: (e) => events.push(e),
      ...extra,
    });
  }

  it('journals the assistant reply and emits progress events', async () => {
    store.append(userMessage('what is running?'));
    connector.enqueue({ content: 'Two tasks are running.', toolCalls: [] });

    const svc = service();
    svc.startTurn();
    await vi.waitFor(() => expect(svc.turnInFlight()).toBe(false));

    const visible = store.listVisible();
    expect(visible).toHaveLength(2);
    expect(visible[1]?.role).toBe('assistant');
    expect(visible[1]?.content).toBe('Two tasks are running.');
    // The journaled append was pushed to subscribers.
    expect(journaled.map((m) => m.content)).toEqual(['Two tasks are running.']);
    // Ephemeral progress events flowed (iteration + completed).
    expect(events).toContainEqual({ kind: 'iteration', iteration: 1 });
    expect(events).toContainEqual({ kind: 'completed', iterations: 1 });
    // The model saw the system prompt + the journaled user message.
    const seen = connector.requests[0]?.messages;
    expect(seen?.[0]?.role).toBe('system');
    expect(seen?.at(-1)).toEqual({ role: 'user', content: 'what is running?' });
  });

  it('routes tool calls through the command executor and journals the traffic', async () => {
    store.append(userMessage('anything need me?'));
    connector.enqueue({
      content: null,
      toolCalls: [{ id: 'c1', name: 'query_inbox', arguments: {} }],
    });
    connector.enqueue({ content: 'One approval is pending.', toolCalls: [] });

    const svc = service();
    svc.startTurn();
    await vi.waitFor(() => expect(svc.turnInFlight()).toBe(false));

    // The tool call hit the daemon's own command surface.
    expect(executed).toEqual([{ kind: 'query-inbox' }]);

    // Assistant tool-call + tool result + final all journaled in order.
    const roles = store.listVisible().map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const toolMsg = store.listVisible()[2];
    expect(toolMsg?.toolCallId).toBe('c1');
    expect(toolMsg?.name).toBe('query_inbox');
  });

  it('journals an honest failure message when the model call fails', async () => {
    store.append(userMessage('hello'));
    connector.enqueue(new ModelPortError('quota exhausted', 429));

    const svc = service();
    svc.startTurn();
    await vi.waitFor(() => expect(svc.turnInFlight()).toBe(false));

    const last = store.listVisible().at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.content).toContain("couldn't complete that turn");
    expect(last?.content).toContain('quota exhausted');
  });

  it('ignores a second startTurn while one is in flight', async () => {
    store.append(userMessage('slow question'));
    let release!: (r: CompletionResponse) => void;
    const gate = new Promise<CompletionResponse>((r) => (release = r));
    const svc = service();
    // First call hangs until we release it.
    (connector as unknown as { complete: ModelPort['complete'] }).complete = () => gate;

    svc.startTurn();
    expect(svc.turnInFlight()).toBe(true);
    svc.startTurn(); // must not start a second run
    release({ content: 'done', toolCalls: [] });
    await vi.waitFor(() => expect(svc.turnInFlight()).toBe(false));
    expect(store.listVisible().filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('is a no-op without a connector (message already journaled upstream)', () => {
    const svc = new ChatService({ store, commandApi: executor });
    expect(svc.modelAvailable).toBe(false);
    svc.startTurn();
    expect(svc.turnInFlight()).toBe(false);
  });

  it('resume: replays journaled history verbatim into the model call', async () => {
    // Simulate a prior turn surviving a restart — everything below came
    // from the store, not in-memory state.
    store.append(userMessage('first'));
    store.append({
      id: 'a1',
      role: 'assistant',
      content: 'answer one',
      createdAt: new Date().toISOString(),
    });
    store.append(userMessage('second'));

    connector.enqueue({ content: 'answer two', toolCalls: [] });
    const svc = service();
    svc.startTurn();
    await vi.waitFor(() => expect(svc.turnInFlight()).toBe(false));

    const sent = connector.requests[0]?.messages ?? [];
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[2]).toEqual({ role: 'assistant', content: 'answer one' });
  });
});

describe('Florina Method composition (#287)', () => {
  let db: StorageDatabase;
  let store: ChatMessageRepository;
  let connector: ScriptedConnector;
  let executor: CommandExecutor;

  beforeEach(() => {
    db = new StorageDatabase({ path: ':memory:' });
    db.open();
    store = new ChatMessageRepository(db.connection);
    connector = new ScriptedConnector();
    executor = {
      execute: () => Promise.resolve({ ok: true, items: [] } as Response),
    };
  });

  afterEach(() => {
    db.close();
  });

  function service(extra: Partial<ConstructorParameters<typeof ChatService>[0]> = {}) {
    return new ChatService({ store, connector, commandApi: executor, ...extra });
  }

  it('composes the persona with the Method contract', () => {
    expect(DEFAULT_CHAT_INSTRUCTIONS).toContain('You are Florina');
    expect(DEFAULT_CHAT_INSTRUCTIONS).toContain(renderFlorinaContract());
    expect(DEFAULT_CHAT_INSTRUCTIONS).toContain(FLORINA_CONTRACT_VERSION);
    // Goal + standing rules reach the Secretary; raise_attention is the
    // persona's surfacing channel (the contract names no tools).
    expect(DEFAULT_CHAT_INSTRUCTIONS).toContain("deliver the user's task working");
    expect(DEFAULT_CHAT_INSTRUCTIONS).toContain('Evidence over assertion');
    expect(DEFAULT_CHAT_INSTRUCTIONS).toContain('raise_attention');
  });

  it('sends the contract to the model on the wire', async () => {
    store.append(userMessage('hello'));
    connector.enqueue({ content: 'hi', toolCalls: [] });
    const svc = service();
    svc.startTurn();
    await vi.waitFor(() => expect(svc.turnInFlight()).toBe(false));

    const sys = connector.requests[0]?.messages[0];
    expect(sys?.role).toBe('system');
    expect(sys?.content).toBe(DEFAULT_CHAT_INSTRUCTIONS);
    expect(svc.methodVersion).toBe(FLORINA_CONTRACT_VERSION);
  });

  it('an explicit systemPrompt replaces the whole prompt — contract included', async () => {
    store.append(userMessage('hello'));
    connector.enqueue({ content: 'hi', toolCalls: [] });
    const svc = service({ systemPrompt: 'Custom persona only.' });
    svc.startTurn();
    await vi.waitFor(() => expect(svc.turnInFlight()).toBe(false));

    const sys = connector.requests[0]?.messages[0];
    expect(sys?.content).toBe('Custom persona only.');
    expect(svc.methodVersion).toBeUndefined();
  });

  it('treats a defined-but-empty systemPrompt as an override, not the default', () => {
    const svc = service({ systemPrompt: '' });
    expect(svc.methodVersion).toBeUndefined();
  });

  it('keeps the repertoire non-prescriptive in the prompt', () => {
    expect(DEFAULT_CHAT_INSTRUCTIONS).toContain('No fixed order');
    expect(DEFAULT_CHAT_INSTRUCTIONS).not.toMatch(/must follow|always run/i);
  });
});

describe('chat message mapping', () => {
  it('round-trips assistant tool calls through the store shape', () => {
    const conv: ConversationMessage = {
      id: 'm1',
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1 } }],
      createdAt: new Date().toISOString(),
    };
    const wire = toWireMessage(conv);
    const back = toConversationMessage(wire, conv.createdAt);
    expect(back.role).toBe('assistant');
    expect(back.toolCalls?.[0]?.name).toBe('t');
  });

  it('round-trips tool results', () => {
    const conv: ConversationMessage = {
      id: 'm2',
      role: 'tool',
      content: 'result text',
      toolCallId: 'c1',
      name: 't',
      isError: true,
      createdAt: new Date().toISOString(),
    };
    const wire = toWireMessage(conv);
    expect(wire).toMatchObject({ role: 'tool', toolCallId: 'c1', name: 't', isError: true });
  });
});
