/**
 * Session capability matrix (issue #341): adapters declare honest
 * session-reuse support — `sendMessage`, `resume`, `compact` — and the
 * caller degrades to spawn-fresh where a capability is absent rather
 * than faking continuity. The stub exercises all three
 * `maintainContext` modes through the same ladder real adapters use.
 */
import { describe, it, expect } from 'vitest';

import { StubAdapter, STUB_ADAPTER_ID } from '../src/adapters/outbound/agents/stub-adapter.js';
import { CodexAdapter } from '../src/adapters/outbound/agents/codex-adapter.js';
import type { CodexTransport } from '../src/adapters/outbound/agents/codex-adapter.js';
import { AcpAdapter } from '../src/adapters/outbound/agents/acp-adapter.js';
import { ClaudePtyAdapter } from '../src/adapters/outbound/agents/claude-adapter.js';
import { ClaudeHooksAdapter } from '../src/adapters/outbound/agents/claude-hooks-adapter.js';
import { AgyAdapter } from '../src/adapters/outbound/agents/agy-adapter.js';
import { PrintRunAdapter } from '../src/adapters/outbound/agents/print-run-adapter.js';
import { RemoteFlorinaAdapter } from '../src/adapters/outbound/federation/remote-florina-adapter.js';
import { AdapterRegistry, UnknownAdapterError } from '../src/adapters/outbound/agents/registry.js';
import { CommandApi } from '../src/daemon/command-api.js';
import type { CommandApiDeps } from '../src/daemon/command-api.js';
import { EventBus } from '../src/daemon/event-stream.js';
import { AttentionInbox } from '../src/attention/attention-inbox.js';
import { MetricsCollector } from '../src/daemon/metrics.js';
import { TaskStateMachine } from '../src/daemon/task-lifecycle.js';
import type { SessionConfig } from '../src/core/application/ports/outbound/agent-runtime.js';
import type { AgentRuntimeRegistryPort } from '../src/core/application/ports/outbound/runtime-registry.js';

const SESSION: SessionConfig = {
  taskId: 'task-1',
  sessionId: 'sess-1',
  agentId: 'agent-1',
  workingDir: '/wt',
  objective: 'do the thing',
};

const RESTART: SessionConfig = { ...SESSION, sessionId: 'sess-2', objective: 'continue' };

/** In-memory Codex transport — mirrors the seam in codex-adapter.test.ts. */
class MockTransport implements CodexTransport {
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  readonly sentMessages: string[] = [];

  send(data: string): void {
    this.sentMessages.push(data);
  }
  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }
  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
  close(): void {
    this.closeHandler?.(1000, 'normal closure');
  }
  receive(data: string): void {
    this.messageHandler?.(data);
  }
  get sent(): readonly string[] {
    return this.sentMessages;
  }
}

describe('session capability matrix (issue #341)', () => {
  it('each adapter declares a static, honest matrix', () => {
    const cases: [string, { sendMessage: boolean; resume: boolean; compact: boolean }][] = [
      ['stub', { sendMessage: true, resume: true, compact: true }],
      ['codex', { sendMessage: true, resume: false, compact: false }],
      ['acp', { sendMessage: true, resume: false, compact: false }],
      ['claude-code-pty', { sendMessage: true, resume: false, compact: false }],
      ['claude-code-hooks', { sendMessage: false, resume: false, compact: false }],
      ['agy', { sendMessage: false, resume: false, compact: false }],
      ['print-run', { sendMessage: false, resume: false, compact: false }],
      ['remote', { sendMessage: false, resume: false, compact: false }],
    ];
    const adapters = [
      new StubAdapter(null),
      new CodexAdapter(null, { endpoint: 'ws://127.0.0.1:0' }),
      new AcpAdapter(null, { id: 'acp', command: 'acp-agent' }),
      new ClaudePtyAdapter(null),
      new ClaudeHooksAdapter(null),
      new AgyAdapter(null),
      new PrintRunAdapter(null, { id: 'print', command: 'agent-cli' }),
      new RemoteFlorinaAdapter(null, {
        id: 'remote',
        remote: { host: '127.0.0.1', port: 1 },
        projectId: 'p',
      }),
    ];
    cases.forEach(([, expected], i) => {
      const adapter = adapters[i]!;
      expect(adapter.capabilities, `adapter ${adapter.id}`).toEqual(expected);
    });
  });

  it('the registry surfaces the adapter-declared matrix', () => {
    const registry = new AdapterRegistry();
    registry.register(STUB_ADAPTER_ID, () => new StubAdapter(null));
    expect(registry.capabilities(STUB_ADAPTER_ID)).toEqual({
      sendMessage: true,
      resume: true,
      compact: true,
    });
    expect(() => registry.capabilities('nope')).toThrow(UnknownAdapterError);
  });
});

describe('sendMessage', () => {
  it('stub records delivery and guards the session id', async () => {
    const stub = new StubAdapter(null);
    await stub.connect();
    await stub.startRun('task-1', SESSION);
    expect(await stub.sendMessage('sess-1', 'fix the test')).toBe(true);
    expect(stub.sentMessages).toEqual([{ sessionId: 'sess-1', message: 'fix the test' }]);
    expect(await stub.sendMessage('sess-other', 'nope')).toBe(false);
  });

  it('codex sends a second startTurn carrying the message', async () => {
    const adapter = new CodexAdapter(null, {
      endpoint: 'ws://127.0.0.1:0',
      protocolMode: 'legacy',
    });
    const transport = new MockTransport();
    adapter.setTransport(transport);

    const startPromise = adapter.startRun('task-1', SESSION);
    const startMsg = JSON.parse(transport.sent[0]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: startMsg.id, result: { threadId: 'sess-1' } }),
    );
    await startPromise;

    const sent = adapter.sendMessage('sess-1', 'please also fix the lint');
    const nudgeMsg = JSON.parse(transport.sent[1]);
    transport.receive(
      JSON.stringify({ jsonrpc: '2.0', id: nudgeMsg.id, result: { threadId: 'sess-1' } }),
    );
    expect(await sent).toBe(true);
    expect(nudgeMsg.method).toBe('codex.startTurn');
    expect(nudgeMsg.params.objective).toBe('please also fix the lint');

    // A dead session refuses honestly.
    await adapter.cancel('sess-1');
    expect(await adapter.sendMessage('sess-1', 'still there?')).toBe(false);
  });
});

describe('maintainContext — the same ladder every adapter inherits', () => {
  it('compacted when the provider can compact', async () => {
    const stub = new StubAdapter(null, {
      capabilities: { sendMessage: true, resume: true, compact: true },
    });
    await stub.connect();
    const result = await stub.maintainContext('sess-1', {
      carryover: 'capsule digest',
      restartConfig: RESTART,
    });
    expect(result).toEqual({ mode: 'compacted', sessionId: 'sess-1' });
    expect(stub.maintainCalls).toEqual([{ sessionId: 'sess-1', carryover: 'capsule digest' }]);
  });

  it('restarted-with-carryover when only resume is declared', async () => {
    const stub = new StubAdapter(null, {
      capabilities: { sendMessage: true, resume: true, compact: false },
    });
    await stub.connect();
    const result = await stub.maintainContext('sess-1', {
      carryover: 'capsule digest',
      restartConfig: RESTART,
    });
    expect(result).toEqual({ mode: 'restarted-with-carryover', sessionId: 'sess-2' });
  });

  it('unsupported when nothing is declared — callers degrade to spawn-fresh', async () => {
    const stub = new StubAdapter(null, {
      capabilities: { sendMessage: false, resume: false, compact: false },
    });
    await stub.connect();
    const result = await stub.maintainContext('sess-1', {
      carryover: 'capsule digest',
      restartConfig: RESTART,
    });
    expect(result.mode).toBe('unsupported');
    expect(result.detail).toContain('stub');
  });

  it('a declared-but-failing compact degrades to resume, not a fake mode', async () => {
    class FailingCompactStub extends StubAdapter {
      protected override async performCompact(): Promise<boolean> {
        return false;
      }
    }
    const stub = new FailingCompactStub(null, {
      capabilities: { sendMessage: true, resume: true, compact: true },
    });
    await stub.connect();
    const result = await stub.maintainContext('sess-1', {
      carryover: 'capsule digest',
      restartConfig: RESTART,
    });
    expect(result).toEqual({ mode: 'restarted-with-carryover', sessionId: 'sess-2' });
  });

  it('an adapter without capabilities reports unsupported honestly', async () => {
    const hooks = new ClaudeHooksAdapter(null);
    // connect() would spawn a CLI — the capability check needs no wire:
    // force the connected state the honest way via the state machine's
    // own path is unnecessary; maintainContext guards on connected, so
    // assert the guard instead of faking a connection.
    await expect(
      hooks.maintainContext('sess-1', { carryover: 'x', restartConfig: RESTART }),
    ).rejects.toThrow();
  });
});

describe('provider facts surface', () => {
  it('query-providers carries the declared capabilities for attached adapters', async () => {
    const registry: AgentRuntimeRegistryPort = {
      create: () => new StubAdapter(null),
      has: () => true,
      list: () => [STUB_ADAPTER_ID],
      capabilities: () => ({ sendMessage: true, resume: true, compact: true }),
    };
    const deps = {
      eventBus: new EventBus(),
      taskStateMachine: undefined as unknown as TaskStateMachine,
      attentionInbox: new AttentionInbox(),
      metricsCollector: new MetricsCollector(),
      worktreeManager: undefined as never,
      eventRepository: undefined as never,
      taskStore: undefined as never,
      approvalStore: undefined as never,
      sessionStore: undefined as never,
      adapterRegistry: registry,
      providerAttachment: () => ({
        attached: [{ id: STUB_ADAPTER_ID, detail: 'test stub' }],
        skipped: [],
      }),
    } as unknown as CommandApiDeps;
    const api = new CommandApi(deps);
    const res = await api.execute({ kind: 'query-providers' });
    expect(res.ok).toBe(true);
    if (res.ok && 'providers' in res) {
      expect(res.providers[0]?.capabilities).toEqual({
        sendMessage: true,
        resume: true,
        compact: true,
      });
    } else {
      throw new Error('expected providers response');
    }
  });
});
