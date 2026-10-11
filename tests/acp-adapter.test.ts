import { describe, it, expect, vi } from 'vitest';
import {
  AcpAdapter,
  devinAcpAdapter,
  geminiAcpAdapter,
  type AcpProcess,
  type AcpSpawner,
} from '../src/adapters/acp-adapter.js';
import type { SupervisorEvent } from '../src/domain/events.js';
import type { SessionConfig } from '../src/adapters/base.js';

/** A scripted ACP process: auto-answers configured requests, records traffic. */
class FakeAcpProcess implements AcpProcess {
  readonly sent: string[] = [];
  killed = false;
  private readonly lineHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];

  /** Auto-reply map: method → result payload. */
  constructor(private readonly replies: Record<string, unknown> = {}) {}

  send(line: string): void {
    this.sent.push(line);
    const msg = JSON.parse(line) as { id?: number; method?: string };
    if (msg.id !== undefined && msg.method !== undefined && msg.method in this.replies) {
      const reply = this.replies[msg.method];
      queueMicrotask(() => this.feed({ jsonrpc: '2.0', id: msg.id, result: reply }));
    }
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onExit(handler: (code: number | null, signal: string | null) => void): void {
    this.exitHandlers.push(handler);
  }

  kill(): void {
    this.killed = true;
  }

  /** Feed one JSON-RPC message to the adapter. */
  feed(msg: Record<string, unknown>): void {
    for (const h of this.lineHandlers) {
      h(JSON.stringify(msg));
    }
  }

  /** Last *request* sent (parsed) — ignores adapter responses. */
  lastRequest(): { id: number; method: string; params?: unknown } {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const msg = JSON.parse(this.sent[i]) as { id?: number; method?: string };
      if (msg.method !== undefined && msg.id !== undefined) {
        return msg as { id: number; method: string; params?: unknown };
      }
    }
    throw new Error('no requests sent');
  }

  /** All responses the adapter sent for a given request id. */
  responsesFor(id: number): Record<string, unknown>[] {
    return this.sent
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((m) => m['id'] === id && m['method'] === undefined);
  }

  exit(code: number): void {
    for (const h of this.exitHandlers) {
      h(code, null);
    }
  }
}

const config: SessionConfig = {
  taskId: 'task-1',
  sessionId: 'sess-1',
  agentId: 'devin-1',
  workingDir: '/repo/wt',
  objective: 'fix the bug',
};

function makeAdapter(
  replies: Record<string, unknown> = {},
  opts: {
    auth?: {
      methodId: string;
      apiKey: () => string | undefined | Promise<string | undefined>;
      signInHint: string;
    };
    sessionMode?: string;
    modelConfigId?: string;
  } = {},
) {
  const proc = new FakeAcpProcess({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'acp-s1' },
    authenticate: {},
    'session/set_mode': {},
    'session/set_config_option': { configOptions: [] },
    ...replies,
  });
  const spawner: AcpSpawner = () => proc;
  const adapter = new AcpAdapter(null, {
    id: 'devin',
    command: 'devin',
    args: ['acp'],
    spawner,
    ...opts,
  });
  return { adapter, proc };
}

async function collect(adapter: AcpAdapter): Promise<SupervisorEvent[]> {
  const out: SupervisorEvent[] = [];
  for await (const e of adapter.streamEvents()) {
    out.push(e);
  }
  return out;
}

describe('AcpAdapter', () => {
  it('sends initialize on connect and sets connected', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    expect(adapter.connectionState).toBe('connected');
    expect(proc.lastRequest().method).toBe('initialize');
    await adapter.disconnect();
    expect(proc.killed).toBe(true);
  });

  it('session/new + prompt on startRun; AgentStarted emitted', async () => {
    const { adapter, proc } = makeAdapter({
      'session/prompt': { stopReason: 'end_turn' },
    });
    await adapter.connect();
    const events = collect(adapter);
    const res = await adapter.startRun('task-1', config);
    expect(res.started).toBe(true);
    const collected = await events;
    const methods = proc.sent
      .map((l) => (JSON.parse(l) as { method?: string }).method)
      .filter(Boolean);
    expect(methods).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(collected[0].type).toBe('AgentStarted');
    expect(collected[collected.length - 1].type).toBe('AgentCompleted');
  });

  it('session/new registers MCP servers from the launch config (issue #63)', async () => {
    const { adapter, proc } = makeAdapter({
      'session/prompt': { stopReason: 'end_turn' },
    });
    await adapter.connect();
    void collect(adapter);
    await adapter.startRun('task-1', {
      ...config,
      mcpServers: [
        {
          name: 'florina',
          url: 'http://127.0.0.1:9090/mcp',
          headers: { 'x-florina-project': 'proj-1' },
        },
      ],
    });

    const sessionNew = proc.sent
      .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'session/new');
    expect(sessionNew?.params?.['mcpServers']).toEqual([
      {
        type: 'http',
        name: 'florina',
        url: 'http://127.0.0.1:9090/mcp',
        headers: [{ name: 'x-florina-project', value: 'proj-1' }],
      },
    ]);
    await adapter.disconnect();
  });

  it('maps session/update notifications to SupervisorEvents', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);

    proc.feed({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'acp-s1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'looking at the code' },
        },
      },
    });
    proc.feed({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'acp-s1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc1',
          title: 'shell: npm test',
          kind: 'execute',
          status: 'in_progress',
        },
      },
    });
    proc.feed({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'acp-s1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc1',
          title: 'shell: npm test',
          status: 'completed',
        },
      },
    });
    proc.feed({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'acp-s1',
        update: { sessionUpdate: 'usage_update', used: 1234, size: 200000 },
      },
    });
    // End the turn.
    proc.feed({
      jsonrpc: '2.0',
      id: proc.lastRequest().id,
      result: { stopReason: 'end_turn' },
    });

    const collected = await events;
    const types = collected.map((e) => e.type);
    expect(types).toEqual([
      'AgentStarted',
      'AgentProgress',
      'ToolStarted',
      'ToolFinished',
      'UsageReported',
      'AgentCompleted',
    ]);
    const progress = collected[1];
    expect(progress.type === 'AgentProgress' && progress.message).toBe('looking at the code');
  });

  it('emits ApprovalRequested and cancels permission by default', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);

    proc.feed({
      jsonrpc: '2.0',
      id: 900,
      method: 'session/request_permission',
      params: {
        sessionId: 'acp-s1',
        toolCall: {
          toolCallId: 'tc9',
          title: 'rm -rf /tmp/x',
          kind: 'execute',
          locations: [{ path: '/tmp/x' }],
        },
        options: [{ optionId: 'allow' }, { optionId: 'deny' }],
      },
    });
    // End the turn so the stream completes.
    proc.feed({ jsonrpc: '2.0', id: proc.lastRequest().id, result: { stopReason: 'end_turn' } });
    const collected = await events;

    const approval = collected.find((e) => e.type === 'ApprovalRequested');
    expect(approval).toBeDefined();
    if (approval?.type === 'ApprovalRequested') {
      expect(approval.capability).toBe('shell');
      expect(approval.destination).toBe('/tmp/x');
    }
    // Default responder: cancelled.
    await new Promise((r) => setImmediate(r));
    const responses = proc.responsesFor(900);
    expect(responses[0]).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  });

  it('selects the responder-chosen option when a permissionResponder is set', async () => {
    const proc = new FakeAcpProcess({
      initialize: { protocolVersion: 1 },
      'session/new': { sessionId: 'acp-s1' },
    });
    const adapter = new AcpAdapter(null, {
      id: 'gemini',
      command: 'gemini',
      args: ['--acp'],
      spawner: () => proc,
      permissionResponder: async () => ({ optionId: 'allow' }),
    });
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);

    proc.feed({
      jsonrpc: '2.0',
      id: 901,
      method: 'session/request_permission',
      params: { sessionId: 'acp-s1', toolCall: { kind: 'read' }, options: [] },
    });
    proc.feed({ jsonrpc: '2.0', id: proc.lastRequest().id, result: { stopReason: 'end_turn' } });
    await events;
    await new Promise((r) => setImmediate(r));
    const responses = proc.responsesFor(901);
    expect(responses[0]).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
  });

  it('grants the narrowest allow option when the run declares autonomyLevel auto', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', { ...config, autonomyLevel: 'auto' });

    proc.feed({
      jsonrpc: '2.0',
      id: 902,
      method: 'session/request_permission',
      params: {
        sessionId: 'acp-s1',
        toolCall: { toolCallId: 'tc10', title: 'git commit -m x', kind: 'execute' },
        options: [
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          { optionId: 'allow-always', kind: 'allow_always', name: 'Allow always' },
          { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
        ],
      },
    });
    proc.feed({ jsonrpc: '2.0', id: proc.lastRequest().id, result: { stopReason: 'end_turn' } });
    await events;
    await new Promise((r) => setImmediate(r));
    const responses = proc.responsesFor(902);
    // allow_once wins over allow_always — narrowest grant first.
    expect(responses[0]).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
  });

  it('autonomyLevel auto cannot override a wired responder denial', async () => {
    const proc = new FakeAcpProcess({
      initialize: { protocolVersion: 1 },
      'session/new': { sessionId: 'acp-s1' },
    });
    const adapter = new AcpAdapter(null, {
      id: 'devin',
      command: 'devin',
      args: ['acp'],
      spawner: () => proc,
      permissionResponder: async () => null, // explicit deny
    });
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', { ...config, autonomyLevel: 'auto' });

    proc.feed({
      jsonrpc: '2.0',
      id: 903,
      method: 'session/request_permission',
      params: {
        sessionId: 'acp-s1',
        toolCall: { kind: 'execute' },
        options: [{ optionId: 'allow-once', kind: 'allow_once' }],
      },
    });
    proc.feed({ jsonrpc: '2.0', id: proc.lastRequest().id, result: { stopReason: 'end_turn' } });
    await events;
    await new Promise((r) => setImmediate(r));
    const responses = proc.responsesFor(903);
    expect(responses[0]).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  });

  it('autonomyLevel auto still cancels when no allow option exists', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', { ...config, autonomyLevel: 'auto' });

    proc.feed({
      jsonrpc: '2.0',
      id: 904,
      method: 'session/request_permission',
      params: {
        sessionId: 'acp-s1',
        toolCall: { kind: 'execute' },
        options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
      },
    });
    proc.feed({ jsonrpc: '2.0', id: proc.lastRequest().id, result: { stopReason: 'end_turn' } });
    await events;
    await new Promise((r) => setImmediate(r));
    const responses = proc.responsesFor(904);
    expect(responses[0]).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
  });

  it('answers fs/terminal agent requests with method-not-implemented', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.feed({
      jsonrpc: '2.0',
      id: 902,
      method: 'fs/read_text_file',
      params: { path: '/etc/passwd' },
    });
    proc.feed({ jsonrpc: '2.0', id: proc.lastRequest().id, result: { stopReason: 'end_turn' } });
    await events;
    const responses = proc.responsesFor(902);
    expect(responses[0]).toMatchObject({ error: { code: -32601 } });
  });

  it('maps prompt JSON-RPC errors to AgentFailed', async () => {
    const proc = new FakeAcpProcess({
      initialize: { protocolVersion: 1 },
      'session/new': { sessionId: 'acp-s1' },
    });
    const adapter = new AcpAdapter(null, {
      id: 'devin',
      command: 'devin',
      spawner: () => proc,
    });
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    // Fail the pending session/prompt request.
    proc.feed({
      jsonrpc: '2.0',
      id: proc.lastRequest().id,
      error: { code: -32000, message: '429 quota exceeded' },
    });
    const collected = await events;
    const last = collected[collected.length - 1];
    expect(last.type).toBe('AgentFailed');
    if (last.type === 'AgentFailed') {
      expect(last.error).toContain('429');
      expect(last.recoverable).toBe(true);
    }
  });

  it('cancel sends session/cancel and emits AgentStopped', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    await adapter.cancel('sess-1');
    const collected = await events;
    const cancels = proc.sent.filter(
      (l) => (JSON.parse(l) as { method?: string }).method === 'session/cancel',
    );
    expect(cancels).toHaveLength(1);
    expect(collected[collected.length - 1].type).toBe('AgentStopped');
  });

  it('unexpected process exit emits AgentFailed and completes the stream', async () => {
    const { adapter, proc } = makeAdapter();
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.exit(1);
    const collected = await events;
    expect(collected[collected.length - 1].type).toBe('AgentFailed');
    expect(adapter.connectionState).toBe('disconnected');
  });

  it('sends authenticate between initialize and session/new when configured', async () => {
    const { adapter, proc } = makeAdapter(
      {},
      {
        auth: {
          methodId: 'devin-browser',
          apiKey: () => 'devin-session-token$abc',
          signInHint: 'run `devin auth login`',
        },
      },
    );
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.feed({
      jsonrpc: '2.0',
      id: proc.lastRequest().id,
      result: { stopReason: 'end_turn' },
    });
    await events;

    const methods = proc.sent
      .map((l) => (JSON.parse(l) as { method?: string }).method)
      .filter(Boolean);
    expect(methods).toEqual(['initialize', 'authenticate', 'session/new', 'session/prompt']);
    const authMsg = proc.sent
      .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'authenticate');
    expect(authMsg?.params).toEqual({
      methodId: 'devin-browser',
      meta: { api_key: 'devin-session-token$abc' },
    });
  });

  it('fails connect with the sign-in hint when no credential resolves', async () => {
    const { adapter, proc } = makeAdapter(
      {},
      {
        auth: {
          methodId: 'devin-browser',
          apiKey: () => undefined,
          signInHint: 'run `devin auth login`',
        },
      },
    );
    await expect(adapter.connect()).rejects.toThrow('devin auth login');
    // The spawned child must not outlive a failed handshake.
    expect(proc.killed).toBe(true);
    expect(adapter.connectionState).not.toBe('connected');
  });

  it('pins model via set_config_option and applies sessionMode per run', async () => {
    const { adapter, proc } = makeAdapter({}, { sessionMode: 'smart', modelConfigId: 'model' });
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', { ...config, model: 'swe-2-high' });
    proc.feed({
      jsonrpc: '2.0',
      id: proc.lastRequest().id,
      result: { stopReason: 'end_turn' },
    });
    await events;

    const sent = proc.sent.map(
      (l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> },
    );
    const setMode = sent.find((m) => m.method === 'session/set_mode');
    const setConfig = sent.find((m) => m.method === 'session/set_config_option');
    expect(setMode?.params).toEqual({ sessionId: 'acp-s1', modeId: 'smart' });
    expect(setConfig?.params).toEqual({
      sessionId: 'acp-s1',
      configId: 'model',
      value: 'swe-2-high',
    });
    // Both run between session/new and session/prompt.
    const methods = sent.map((m) => m.method).filter(Boolean);
    expect(methods.indexOf('session/set_mode')).toBeLessThan(methods.indexOf('session/prompt'));
    expect(methods.indexOf('session/set_config_option')).toBeLessThan(
      methods.indexOf('session/prompt'),
    );
  });

  it('skips the model pin when the session supplies no model', async () => {
    const { adapter, proc } = makeAdapter({}, { modelConfigId: 'model' });
    await adapter.connect();
    const events = collect(adapter);
    await adapter.startRun('task-1', config);
    proc.feed({
      jsonrpc: '2.0',
      id: proc.lastRequest().id,
      result: { stopReason: 'end_turn' },
    });
    await events;
    const hasSetConfig = proc.sent.some(
      (l) => (JSON.parse(l) as { method?: string }).method === 'session/set_config_option',
    );
    expect(hasSetConfig).toBe(false);
  });

  it('session/prompt has no 30s deadline — long turns stay pending', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, proc } = makeAdapter();
      await adapter.connect();
      const events = collect(adapter);
      await adapter.startRun('task-1', config);
      // The prompt request is in flight; advancing past the old 30s cap
      // must not reject it — a devin turn legitimately runs for minutes.
      await vi.advanceTimersByTimeAsync(120000);
      proc.feed({
        jsonrpc: '2.0',
        id: proc.lastRequest().id,
        result: { stopReason: 'end_turn' },
      });
      const collected = await events;
      expect(collected[collected.length - 1].type).toBe('AgentCompleted');
      expect(collected.some((e) => e.type === 'AgentFailed')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('factories produce provider-shaped adapters', () => {
    const devin = devinAcpAdapter(null);
    const gemini = geminiAcpAdapter(null);
    expect(devin.id).toBe('devin');
    expect(gemini.id).toBe('gemini');
    expect(devin.fidelityTier).toBe('C');
  });
});
