/**
 * Voice ↔ Florina-loop binding (DEC-021 + DEC-034, issue #73).
 *
 * - New loop-facing voice tools map to typed commands.
 * - `research` runs asynchronously: the speech turn closes with a
 *   `started` output and the result is spoken later via sendUserMessage.
 * - `update-preference` persists routing facts on the profile.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  ASYNC_VOICE_TOOLS,
  buildDefaultVoiceTools,
  mapToolCallToCommand,
} from '../src/adapters/inbound/voice/voice-tools.js';
import { VoiceSessionManager } from '../src/adapters/inbound/voice/voice-session-manager.js';
import { createResearchRunner } from '../src/bootstrap/voice-session.js';
import {
  CommandApi,
  type CommandApiDeps,
} from '../src/core/application/use-cases/tasks/command-api.js';
import type { PreferenceResponse } from '../src/core/application/use-cases/tasks/command-api.js';
import { TaskStateMachine } from '../src/core/application/use-cases/tasks/task-lifecycle.js';
import { MetricsCollector } from '../src/core/application/use-cases/metrics.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  ApprovalRepository,
  SessionRepository,
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import type {
  AudioTransport,
  RealtimeSessionPort,
  ToolCallEvent,
  TranscriptionPort,
  TranscriptEvent,
  VoiceStateChangeEvent,
} from '../src/core/application/ports/outbound/voice.js';
import { VoiceSessionState } from '../src/core/application/ports/outbound/voice.js';
import type { PreferenceProfilePort } from '../src/core/application/ports/outbound/preference-profile.js';
import type {
  RoutingRule,
  DenyRule,
} from '../src/core/application/ports/outbound/preference-profile.js';
import type {
  ModelPort,
  CompletionResponse,
} from '../src/core/application/ports/outbound/model.js';
import type { Command, Response } from '../src/core/application/use-cases/tasks/command-api.js';

/* ================================================================== *
 * Tool definitions + command mapping
 * ================================================================== */

describe('voice loop tools', () => {
  it('the default catalog exposes the loop-facing tools', () => {
    const names = buildDefaultVoiceTools().map((t) => t.name);
    expect(names).toContain('research');
    expect(names).toContain('update_idea_ledger');
    expect(names).toContain('compile_brief');
    expect(names).toContain('remember_preference');
  });

  it('update_idea_ledger maps to idea-append when ideaId is present', () => {
    const cmd = mapToolCallToCommand('update_idea_ledger', {
      ideaId: 'idea-1',
      heading: 'Research',
      body: 'findings',
    });
    expect(cmd?.kind).toBe('idea-append');
    if (cmd?.kind === 'idea-append') {
      expect(cmd.ideaId).toBe('idea-1');
      expect(cmd.heading).toBe('Research');
    }
  });

  it('update_idea_ledger maps to idea-create when only a title is given', () => {
    const cmd = mapToolCallToCommand('update_idea_ledger', {
      title: 'fleet failover',
      heading: 'Notes',
      body: 'raw ideas',
    });
    expect(cmd?.kind).toBe('idea-create');
    if (cmd?.kind === 'idea-create') {
      expect(cmd.title).toBe('fleet failover');
      expect(cmd.body).toContain('## Notes');
    }
  });

  it('compile_brief maps provider/model intent into the plan', () => {
    const cmd = mapToolCallToCommand('compile_brief', {
      ideaId: 'idea-1',
      projectId: 'proj-1',
      tasks: [
        { objective: 'build it', provider: 'codex', model: 'gpt-5' },
        { objective: 'prove it', workType: 'verify' },
      ],
    });
    expect(cmd?.kind).toBe('brief-compile');
    if (cmd?.kind === 'brief-compile') {
      expect(cmd.plan.projectId).toBe('proj-1');
      expect(cmd.plan.tasks[0]!.preferProvider).toBe('codex');
      expect(cmd.plan.tasks[0]!.preferModel).toBe('gpt-5');
      expect(cmd.plan.tasks[1]!.workType).toBe('verify');
    }
  });

  it('compile_brief rejects malformed task lists', () => {
    expect(
      mapToolCallToCommand('compile_brief', {
        ideaId: 'i',
        projectId: 'p',
        tasks: [{ noObjective: true }],
      }),
    ).toBeNull();
  });

  it('remember_preference maps to update-preference', () => {
    const cmd = mapToolCallToCommand('remember_preference', {
      action: 'deny',
      provider: 'claude-code',
      model: 'opus-4',
    });
    expect(cmd?.kind).toBe('update-preference');
    if (cmd?.kind === 'update-preference') {
      expect(cmd.action).toBe('deny');
      expect(cmd.provider).toBe('claude-code');
      expect(cmd.model).toBe('opus-4');
    }
  });

  it('research is async — it maps to no command', () => {
    expect(ASYNC_VOICE_TOOLS).toContain('research');
    expect(mapToolCallToCommand('research', { query: 'q' })).toBeNull();
  });
});

/* ================================================================== *
 * Async tool execution — the turn never blocks
 * ================================================================== */

/** Minimal {@link RealtimeSessionPort} fake recording the wire calls. */
class FakeBridge implements RealtimeSessionPort {
  connected = false;
  readonly outputs: { callId: string; output: string }[] = [];
  readonly userMessages: string[] = [];
  private toolCallCb?: (e: ToolCallEvent) => void;

  get currentState(): VoiceSessionState {
    return this.connected ? VoiceSessionState.Connected : VoiceSessionState.Disconnected;
  }
  get isConnected(): boolean {
    return this.connected;
  }
  onTranscript(_cb: (e: TranscriptEvent) => void): () => void {
    return () => undefined;
  }
  onStateChange(_cb: (e: VoiceStateChangeEvent) => void): () => void {
    return () => undefined;
  }
  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
  startListening(): void {}
  stopListening(): void {}
  sendToolCallOutput(callId: string, output: string): void {
    this.outputs.push({ callId, output });
  }
  sendUserMessage(text: string): void {
    this.userMessages.push(text);
  }
  onToolCall(cb: (e: ToolCallEvent) => void): () => void {
    this.toolCallCb = cb;
    return () => undefined;
  }
  /** Test hook: simulate the model requesting a tool. */
  emitToolCall(e: ToolCallEvent): void {
    this.toolCallCb?.(e);
  }
}

const fakeAudio: AudioTransport = {
  startCapture: () => undefined,
  stopCapture: () => undefined,
  play: () => undefined,
  close: () => undefined,
  onAudioChunk: () => () => undefined,
};
const fakeWhisper: TranscriptionPort = {
  transcribe: () => Promise.resolve({ text: '' }),
};
const noopExecutor = {
  execute: (_c: Command): Promise<Response> => Promise.resolve({ ok: true } as Response),
};

function sessionFixture(runner?: (n: string, a: Record<string, unknown>) => Promise<string>) {
  const bridge = new FakeBridge();
  const manager = new VoiceSessionManager({
    apiKey: 'k',
    audioTransport: fakeAudio,
    bridge,
    whisperAdapter: fakeWhisper,
    commandApi: noopExecutor,
    ...(runner !== undefined ? { asyncToolRunner: runner } : {}),
  });
  return { bridge, manager };
}

describe('async voice tools', () => {
  it('research answers immediately with started, then speaks the result', async () => {
    const { bridge, manager } = sessionFixture(async () => 'findings: quota resets hourly');
    await manager.start();

    bridge.emitToolCall({ callId: 'c1', name: 'research', arguments: '{"query":"codex quota"}' });

    // The turn closes immediately with a started output.
    expect(bridge.outputs).toHaveLength(1);
    expect(JSON.parse(bridge.outputs[0]!.output)).toEqual({
      status: 'started',
      tool: 'research',
    });

    // The result arrives as a spoken user message once the runner resolves.
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.userMessages).toHaveLength(1);
    expect(bridge.userMessages[0]).toContain('quota resets hourly');
    await manager.stop();
  });

  it('a runner failure is spoken as an error, not swallowed', async () => {
    const { bridge, manager } = sessionFixture(async () => {
      throw new Error('model offline');
    });
    await manager.start();
    bridge.emitToolCall({ callId: 'c1', name: 'research', arguments: '{"query":"x"}' });
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.userMessages[0]).toContain('model offline');
    await manager.stop();
  });

  it('async tools report not-wired instead of hanging when no runner exists', async () => {
    const { bridge, manager } = sessionFixture(); // no runner
    await manager.start();
    bridge.emitToolCall({ callId: 'c1', name: 'research', arguments: '{"query":"x"}' });
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(bridge.outputs[0]!.output).error).toContain('not wired');
    expect(bridge.userMessages).toHaveLength(0);
    await manager.stop();
  });
});

/* ================================================================== *
 * update-preference command
 * ================================================================== */

function fakePreferenceStore(): PreferenceProfilePort & { saved: number } {
  const rules: RoutingRule[] = [];
  const denied: DenyRule[] = [];
  const store = {
    saved: 0,
    toProfile: () => ({ rules: [...rules], denied: [...denied] }),
    addRule: (r: RoutingRule) => {
      rules.push(r);
    },
    addDeny: (d: DenyRule) => {
      denied.push(d);
    },
    removeRule: (p: string, m?: string) => {
      const i = rules.findIndex((r) => r.provider === p && r.model === m);
      if (i === -1) return false;
      rules.splice(i, 1);
      return true;
    },
    removeDeny: (p: string, m?: string) => {
      const i = denied.findIndex((d) => d.provider === p && d.model === m);
      if (i === -1) return false;
      denied.splice(i, 1);
      return true;
    },
    save: () => {
      store.saved++;
      return Promise.resolve();
    },
  };
  return store;
}

describe('update-preference command', () => {
  let api: CommandApi;
  let store: ReturnType<typeof fakePreferenceStore>;

  beforeEach(() => {
    const db = new StorageDatabase({ path: ':memory:' });
    db.open();
    const raw = db.connection;
    store = fakePreferenceStore();
    const deps: CommandApiDeps = {
      eventBus: new EventBus(),
      taskStateMachine: new TaskStateMachine(new TaskRepository(raw), new EventRepository(raw)),
      attentionInbox: new AttentionInbox(),
      metricsCollector: new MetricsCollector(),
      worktreeManager: {
        createWorktree: () => '/wt',
        detectDirty: () => false,
        worktreeStatus: () => ({ clean: true, dirty: false }),
        pruneWorktree: () => undefined,
        listWorktrees: () => [],
        worktreePathFor: () => '/wt',
      },
      eventRepository: new EventRepository(raw),
      taskStore: { getById: () => null, listAll: () => [], update: () => undefined },
      approvalStore: new ApprovalRepository(raw),
      sessionStore: new SessionRepository(raw),
      preferences: store,
    };
    api = new CommandApi(deps);
  });

  it('persists a routing rule and echoes the profile', async () => {
    const res = (await api.execute({
      kind: 'update-preference',
      action: 'add-rule',
      provider: 'codex',
      workTypes: ['heavy'],
    })) as PreferenceResponse;
    expect(res.ok).toBe(true);
    expect(store.saved).toBe(1);
    expect(store.toProfile().rules[0]!.provider).toBe('codex');
    expect(res.summary).toContain('rule: codex');
  });

  it('persists a deny rule', async () => {
    const res = (await api.execute({
      kind: 'update-preference',
      action: 'deny',
      provider: 'claude-code',
      model: 'opus-4',
    })) as PreferenceResponse;
    expect(res.ok).toBe(true);
    expect(store.toProfile().denied[0]!.model).toBe('opus-4');
  });

  it('remove-rule reports a miss cleanly', async () => {
    const res = (await api.execute({
      kind: 'update-preference',
      action: 'remove-rule',
      provider: 'ghost',
    })) as PreferenceResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no rule');
  });

  it('fails cleanly without a wired profile', async () => {
    const db = new StorageDatabase({ path: ':memory:' });
    db.open();
    const bare = new CommandApi({
      eventBus: new EventBus(),
      taskStateMachine: new TaskStateMachine(
        new TaskRepository(db.connection),
        new EventRepository(db.connection),
      ),
      attentionInbox: new AttentionInbox(),
      metricsCollector: new MetricsCollector(),
      worktreeManager: {
        createWorktree: () => '/wt',
        detectDirty: () => false,
        worktreeStatus: () => ({ clean: true, dirty: false }),
        pruneWorktree: () => undefined,
        listWorktrees: () => [],
        worktreePathFor: () => '/wt',
      },
      eventRepository: new EventRepository(db.connection),
      taskStore: { getById: () => null, listAll: () => [], update: () => undefined },
      approvalStore: new ApprovalRepository(db.connection),
      sessionStore: new SessionRepository(db.connection),
    });
    const res = (await bare.execute({
      kind: 'update-preference',
      action: 'deny',
      provider: 'x',
    })) as PreferenceResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not wired');
  });
});

/* ================================================================== *
 * createResearchRunner — the loop does the heavyweight work
 * ================================================================== */

describe('createResearchRunner', () => {
  const connector: ModelPort = {
    complete: (_req): Promise<CompletionResponse> =>
      Promise.resolve({ content: 'structured findings about codex quota', toolCalls: [] }),
  };

  it('runs the query through the Florina loop and returns findings', async () => {
    const runner = createResearchRunner(connector);
    const result = await runner('research', { query: 'codex quota windows' });
    expect(result).toContain('Research complete');
    expect(result).toContain('structured findings');
  });

  it('appends findings to the idea ledger when ideaId + sink are given', async () => {
    const notes: { ideaId: string; body: string }[] = [];
    const runner = createResearchRunner(connector, {
      onResearchNote: (ideaId, _heading, body) => notes.push({ ideaId, body }),
    });
    await runner('research', { query: 'q', ideaId: 'idea-9' });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.ideaId).toBe('idea-9');
    expect(notes[0]!.body).toContain('structured findings');
  });

  it('rejects non-research calls cleanly', async () => {
    const runner = createResearchRunner(connector);
    expect(await runner('summarize', {})).toContain('unsupported');
  });
});
