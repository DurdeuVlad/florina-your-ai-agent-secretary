import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArgs, main, runCli, VERSION } from '../src/cli/index.js';
import type { CliDependencies } from '../src/adapters/inbound/cli/deps.js';
import {
  formatInbox,
  formatTask,
  formatTaskList,
  formatDigest,
  formatMetrics,
  formatStatus,
  formatPriority,
  setColorEnabled,
  isColorEnabled,
} from '../src/cli/formatters.js';
import { DaemonClient, DaemonConnectionError, type WebSocketTransport } from '../src/cli/client.js';
import { DaemonRunner, DEFAULT_PID_FILE } from '../src/cli/daemon-runner.js';
import type {
  AttentionItemSnapshot,
  TaskSnapshot,
  InboxResponse,
  TaskListResponse,
  TaskResponse,
  MetricsResponse,
  ApproveResponse,
  ItemMutationResponse,
  PruneResponse,
  DigestResponse,
  CatchUpResponse,
  ConfirmCatchUpResponse,
} from '../src/daemon/command-api.js';
import type { MetricsSnapshot } from '../src/daemon/metrics.js';
import type { CompletionDigest } from '../src/attention/completion-digest.js';
import type { CatchUpDigest } from '../src/core/application/use-cases/resumption/catchup-digest.js';

/* ================================================================== *
 * Helpers / fixtures
 * ================================================================== */

/** Disable color for deterministic formatter output. */
beforeEach(() => setColorEnabled(false));
afterEach(() => setColorEnabled(false));

function makeItem(over: Partial<AttentionItemSnapshot> = {}): AttentionItemSnapshot {
  return {
    id: 'attn_1',
    taskId: 'task_1',
    kind: 'ApprovalRequest',
    priority: 'High',
    status: 'Pending',
    createdAt: '2025-01-01T00:00:00.000Z',
    payload: { reason: 'needs approval' },
    ...over,
  };
}

function makeTask(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'task_1',
    projectId: 'proj_1',
    objective: 'Implement feature X',
    state: 'running',
    agentIds: ['agent_1'],
    sessionIds: ['session_1'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T01:00:00.000Z',
    eventCount: 5,
    ...over,
  };
}

function makeDigest(over: Partial<CompletionDigest> = {}): CompletionDigest {
  return {
    taskId: 'task_1',
    sessionId: 'session_1',
    agentId: 'agent_1',
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T01:00:00.000Z',
    duration: 3_600_000,
    summary: 'Implementation complete. 9 files, 23/23 tests passing.',
    filesChangedCount: 9,
    filesChanged: ['src/a.ts', 'src/b.ts'],
    testsRun: 23,
    testsPassed: 23,
    testsFailed: 0,
    approvalsRequested: 1,
    approvalsGranted: 1,
    approvalsDenied: 0,
    decisions: [{ id: 'DEC-010', note: 'High-authority capability requested.' }],
    riskHighlights: [],
    ...over,
  };
}

function emptyMetrics(): MetricsSnapshot {
  return {
    timestamp: '2025-01-01T00:00:00.000Z',
    counters: {
      eventsEmitted: {},
      tasksStarted: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      approvalsRequested: 0,
      approvalsGranted: 0,
      approvalsDenied: 0,
      toolsInvoked: {},
    },
    gauges: {
      activeSessions: 0,
      pendingApprovals: 0,
      inboxSize: 0,
      attentionItemsPending: 0,
    },
    histograms: {
      taskDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
      approvalResponseTime: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
      toolDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
    },
    supervisionCost: {
      modelCallsByStage: {
        'l1-classification': 0,
        'execution-brief-compile': 0,
        'l2-manager-reasoning': 0,
        'l3-florina-reasoning': 0,
      },
      modelCallsByTask: {},
    },
  };
}

/** A unique PID file path per test so runners don't collide. */
function uniquePidFile(): string {
  return path.join(
    os.tmpdir(),
    `florina-test-${process.pid}-${Math.random().toString(36).slice(2)}.pid`,
  );
}

/** A unique lockfile path per test. */
function uniqueLockfile(): string {
  return path.join(
    os.tmpdir(),
    `florina-test-${process.pid}-${Math.random().toString(36).slice(2)}.lock`,
  );
}

/** A unique db path in tmpdir. */
function uniqueDbPath(): string {
  return path.join(
    os.tmpdir(),
    `florina-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/**
 * A db path inside its own mkdtemp — required for tests that actually
 * start a daemon: the daemon's secrets vault lives beside the db file
 * (issue #292), so a bare tmpdir dbPath would litter `secrets.enc`,
 * `credentials/`, and `secrets.audit.jsonl` into the shared tempdir root.
 * `secretsCredentialBackend: 'file'` keeps the test off the real OS
 * keychain.
 */
function isolatedDbPath(): { dbPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'florina-cli-test-'));
  return { dbPath: path.join(dir, 'florina.db'), dir };
}

const HERMETIC_SECRETS = { secretsCredentialBackend: 'file' as const };

/* ================================================================== *
 * Argument parsing
 * ================================================================== */

describe('parseArgs', () => {
  it('parses a bare subcommand', () => {
    const args = parseArgs(['inbox']);
    expect(args.command).toBe('inbox');
    expect(args.positionals).toEqual([]);
    expect(args.flags).toEqual({});
  });

  it('parses subcommand with positionals', () => {
    const args = parseArgs(['approve', 'task_1', 'appr_1']);
    expect(args.command).toBe('approve');
    expect(args.positionals).toEqual(['task_1', 'appr_1']);
  });

  it('parses --flag value pairs', () => {
    const args = parseArgs(['inbox', '--priority', 'High', '--task', 'task_1']);
    expect(args.command).toBe('inbox');
    expect(args.flags['priority']).toBe('High');
    expect(args.flags['task']).toBe('task_1');
  });

  it('parses --flag=value syntax', () => {
    const args = parseArgs(['metrics', '--since=1000']);
    expect(args.flags['since']).toBe('1000');
  });

  it('parses boolean flags', () => {
    const args = parseArgs(['approve', 'task_1', 'appr_1', '--grant']);
    expect(args.flags['grant']).toBe(true);
  });

  it('parses --deny as boolean', () => {
    const args = parseArgs(['approve', 'task_1', 'appr_1', '--deny']);
    expect(args.flags['deny']).toBe(true);
  });

  it('parses --note with a value', () => {
    const args = parseArgs(['approve', 'task_1', 'appr_1', '--grant', '--note', 'looks good']);
    expect(args.flags['note']).toBe('looks good');
  });

  it('parses short -h flag', () => {
    const args = parseArgs(['-h']);
    expect(args.flags['h']).toBe(true);
  });

  it('handles empty argv', () => {
    const args = parseArgs([]);
    expect(args.command).toBe('');
    expect(args.positionals).toEqual([]);
  });

  it('treats a negative number positional as a positional, not a flag', () => {
    // "-1" starts with "-" but is a single char after dash, so it's a short flag.
    // Verify the documented behavior: single-dash tokens are flags.
    const args = parseArgs(['metrics', '--since', '-1']);
    expect(args.flags['since']).toBe('-1');
  });
});

/* ================================================================== *
 * Formatters
 * ================================================================== */

describe('formatters', () => {
  describe('formatPriority', () => {
    it('returns the label when color is disabled', () => {
      setColorEnabled(false);
      expect(formatPriority('Critical')).toBe('Critical');
      expect(formatPriority('High')).toBe('High');
    });

    it('wraps in ANSI codes when color is enabled', () => {
      setColorEnabled(true);
      const out = formatPriority('Critical');
      expect(out).toContain('\x1b[');
      setColorEnabled(false);
    });
  });

  describe('setColorEnabled / isColorEnabled', () => {
    it('toggles color support', () => {
      setColorEnabled(true);
      expect(isColorEnabled()).toBe(true);
      setColorEnabled(false);
      expect(isColorEnabled()).toBe(false);
    });
  });

  describe('formatInbox', () => {
    it('prints an empty message when there are no items', () => {
      expect(formatInbox([])).toContain('Inbox is empty');
    });

    it('groups items by priority', () => {
      const items = [
        makeItem({ id: 'a', priority: 'Low' }),
        makeItem({ id: 'b', priority: 'Critical' }),
        makeItem({ id: 'c', priority: 'High' }),
      ];
      const out = formatInbox(items);
      // Critical group should appear before High, which appears before Low.
      const critIdx = out.indexOf('Critical');
      const highIdx = out.indexOf('High');
      const lowIdx = out.indexOf('Low');
      expect(critIdx).toBeGreaterThanOrEqual(0);
      expect(critIdx).toBeLessThan(highIdx);
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it('includes the item id, task id, and kind', () => {
      const out = formatInbox([makeItem({ id: 'attn_x', taskId: 'task_y', kind: 'FailedRun' })]);
      expect(out).toContain('attn_x');
      expect(out).toContain('task_y');
      expect(out).toContain('FailedRun');
    });

    it('includes a payload summary when available', () => {
      const out = formatInbox([makeItem({ payload: { reason: 'build broke' } })]);
      expect(out).toContain('build broke');
    });
  });

  describe('formatTask', () => {
    it('renders task id, state, objective, and counts', () => {
      const out = formatTask(makeTask());
      expect(out).toContain('task_1');
      expect(out).toContain('running');
      expect(out).toContain('Implement feature X');
      expect(out).toContain('events:   5');
    });

    it('includes worktree path when present', () => {
      const out = formatTask(makeTask({ worktreePath: '/repo/.wt/task_1' }));
      expect(out).toContain('/repo/.wt/task_1');
    });
  });

  describe('formatTaskList', () => {
    it('prints a no-tasks message when empty', () => {
      expect(formatTaskList([])).toContain('No tasks found');
    });

    it('renders a table header and rows', () => {
      const out = formatTaskList([makeTask(), makeTask({ id: 'task_2', state: 'completed' })]);
      expect(out).toContain('ID');
      expect(out).toContain('STATE');
      expect(out).toContain('OBJECTIVE');
      expect(out).toContain('task_1');
      expect(out).toContain('task_2');
    });
  });

  describe('formatDigest', () => {
    it('renders summary, observed facts, and decisions', () => {
      const out = formatDigest(makeDigest());
      expect(out).toContain('Completion Digest');
      expect(out).toContain('task_1');
      expect(out).toContain('Implementation complete');
      expect(out).toContain('files changed: 9');
      expect(out).toContain('23/23 passed');
      expect(out).toContain('DEC-010');
    });

    it('renders risk highlights when present', () => {
      const out = formatDigest(
        makeDigest({
          testsFailed: 2,
          riskHighlights: [{ kind: 'failed-tests', message: '2 test(s) failed.' }],
        }),
      );
      expect(out).toContain('Risk highlights');
      expect(out).toContain('failed-tests');
    });
  });

  describe('formatMetrics', () => {
    it('renders counters, gauges, and histograms', () => {
      const snap = emptyMetrics();
      snap.counters.tasksStarted = 3;
      snap.gauges.activeSessions = 1;
      const out = formatMetrics(snap);
      expect(out).toContain('Metrics Snapshot');
      expect(out).toContain('tasks started:   3');
      expect(out).toContain('active sessions:       1');
      expect(out).toContain('Histograms');
    });

    it('renders event-type counters when present', () => {
      const snap = emptyMetrics();
      snap.counters.eventsEmitted = { AgentStarted: 5, ToolStarted: 2 };
      const out = formatMetrics(snap);
      expect(out).toContain('AgentStarted: 5');
      expect(out).toContain('ToolStarted: 2');
    });
  });

  describe('formatStatus', () => {
    it('renders running status with port and pid', () => {
      const out = formatStatus(true, 17419, 12345);
      expect(out).toContain('running');
      expect(out).toContain('17419');
      expect(out).toContain('12345');
    });

    it('renders stopped status', () => {
      const out = formatStatus(false, 17419);
      expect(out).toContain('stopped');
    });
  });
});

/* ================================================================== *
 * DaemonClient
 * ================================================================== */

describe('DaemonClient', () => {
  it('constructs with default host and port', () => {
    const client = new DaemonClient();
    expect(client.url).toBe('ws://127.0.0.1:17419');
  });

  it('constructs with custom options', () => {
    const client = new DaemonClient({ host: 'localhost', port: 9999, timeoutMs: 5000 });
    expect(client.url).toBe('ws://localhost:9999');
  });

  it('sends a command via an injected transport and returns the response', async () => {
    const mockResponse: InboxResponse = { ok: true, items: [makeItem()] };
    const transport: WebSocketTransport = vi.fn(
      async () => mockResponse,
    ) as unknown as WebSocketTransport;
    const client = new DaemonClient();
    const res = await client.sendRaw({ kind: 'query-inbox' }, transport);
    expect(transport).toHaveBeenCalledWith({ kind: 'query-inbox' }, 10_000);
    expect(res).toEqual(mockResponse);
  });

  it('propagates a connection error from the transport', async () => {
    const transport: WebSocketTransport = vi.fn(async () => {
      throw new DaemonConnectionError('cannot connect');
    }) as unknown as WebSocketTransport;
    const client = new DaemonClient();
    await expect(client.sendRaw({ kind: 'shutdown' }, transport)).rejects.toThrow('cannot connect');
  });

  it('ping resolves false when the transport cannot connect', async () => {
    const client = new DaemonClient({ port: 1, timeoutMs: 500 });
    const result = await client.ping();
    expect(result).toBe(false);
  });
});

/* ================================================================== *
 * DaemonRunner
 * ================================================================== */

describe('DaemonRunner', () => {
  it('status reports stopped when no PID file exists', async () => {
    const runner = new DaemonRunner({
      pidFile: uniquePidFile(),
      lockfile: uniqueLockfile(),
      dbPath: uniqueDbPath(),
      port: 0,
      mcpPort: 0,
    });
    const status = await runner.status();
    expect(status.running).toBe(false);
  });

  it('start and stop a real in-process daemon', async () => {
    const pidFile = uniquePidFile();
    const { dbPath } = isolatedDbPath();
    const runner = new DaemonRunner({
      pidFile,
      lockfile: uniqueLockfile(),
      dbPath,
      port: 0,
      mcpPort: 0, // OS-assigned port
      ...HERMETIC_SECRETS,
    });
    const pid = await runner.start();
    expect(pid).toBe(process.pid);
    expect(fs.existsSync(pidFile)).toBe(true);

    const status = await runner.status();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);

    const stopped = await runner.stop();
    expect(stopped).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('stop returns false when no daemon is running', async () => {
    const runner = new DaemonRunner({
      pidFile: uniquePidFile(),
      lockfile: uniqueLockfile(),
      dbPath: uniqueDbPath(),
      port: 0,
      mcpPort: 0,
    });
    const stopped = await runner.stop();
    expect(stopped).toBe(false);
  });

  it('readPid returns undefined for a missing file', () => {
    const runner = new DaemonRunner({
      pidFile: uniquePidFile(),
      lockfile: uniqueLockfile(),
      dbPath: uniqueDbPath(),
      port: 0,
      mcpPort: 0,
    });
    expect(runner.readPid()).toBeUndefined();
  });

  it('readPid returns the written pid after start', async () => {
    const pidFile = uniquePidFile();
    const { dbPath } = isolatedDbPath();
    const runner = new DaemonRunner({
      pidFile,
      lockfile: uniqueLockfile(),
      dbPath,
      port: 0,
      mcpPort: 0,
      ...HERMETIC_SECRETS,
    });
    await runner.start();
    expect(runner.readPid()).toBe(process.pid);
    await runner.stop();
  });
});

/* ================================================================== *
 * main() — end-to-end CLI dispatch (mocked transport)
 * ================================================================== */

describe('main', () => {
  it('prints help and exits 0 for --help', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
  });

  it('prints help and exits 0 for -h', async () => {
    const code = await main(['-h']);
    expect(code).toBe(0);
  });

  it('prints help and exits 0 for no args', async () => {
    const code = await main([]);
    expect(code).toBe(0);
  });

  it('prints version and exits 0', async () => {
    const code = await main(['version']);
    expect(code).toBe(0);
  });

  it('prints help for the help subcommand', async () => {
    const code = await main(['help']);
    expect(code).toBe(0);
  });

  it('exits 1 for an unknown command', async () => {
    const code = await main(['frobnicate']);
    expect(code).toBe(1);
  });

  it('VERSION matches the expected semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/* ================================================================== *
 * Subcommand dispatch with a mocked DaemonClient transport
 * ================================================================== */

/**
 * Helper: run main() with a mocked DaemonClient transport so subcommands
 * that talk to the daemon can be tested without a real daemon.
 */
async function mainWithTransport(
  argv: readonly string[],
  transport: WebSocketTransport,
): Promise<number> {
  // We patch DaemonClient.prototype.sendRaw to use the injected transport.
  const original = DaemonClient.prototype.sendRaw;
  DaemonClient.prototype.sendRaw = function (
    command: Parameters<WebSocketTransport>[0],
    t?: WebSocketTransport,
  ): ReturnType<WebSocketTransport> {
    return t ? original.call(this, command, t) : transport(command, 10_000);
  };
  try {
    return await main(argv);
  } finally {
    DaemonClient.prototype.sendRaw = original;
  }
}

describe('subcommand dispatch (mocked transport)', () => {
  it('inbox formats items from the daemon response', async () => {
    const response: InboxResponse = { ok: true, items: [makeItem()] };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['inbox'], transport);
    expect(code).toBe(0);
    expect(transport).toHaveBeenCalled();
  });

  it('inbox exits 1 on an error response', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: false,
      error: 'boom',
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['inbox'], transport);
    expect(code).toBe(1);
  });

  it('tasks lists tasks from the daemon', async () => {
    const response: TaskListResponse = { ok: true, tasks: [makeTask()] };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['tasks'], transport);
    expect(code).toBe(0);
  });

  it('tasks --status filters by state', async () => {
    const response: TaskListResponse = { ok: true, tasks: [] };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    await mainWithTransport(['tasks', '--status', 'running'], transport);
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toEqual({ kind: 'list-tasks', status: 'running' });
  });

  it('task <id> shows task details', async () => {
    const response: TaskResponse = { ok: true, task: makeTask() };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['task', 'task_1'], transport);
    expect(code).toBe(0);
  });

  it('task <id> exits 1 when task is not found', async () => {
    const response: TaskResponse = { ok: false, task: null };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['task', 'missing'], transport);
    expect(code).toBe(1);
  });

  it('approve --grant sends an approve command', async () => {
    const response: ApproveResponse = { ok: true, approvalId: 'appr_1' };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['approve', 'task_1', 'appr_1', '--grant'], transport);
    expect(code).toBe(0);
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toEqual({
      kind: 'approve',
      taskId: 'task_1',
      approvalId: 'appr_1',
      decision: 'grant',
      note: undefined,
    });
  });

  it('approve --deny sends a deny decision', async () => {
    const response: ApproveResponse = { ok: true, approvalId: 'appr_1' };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    await mainWithTransport(
      ['approve', 'task_1', 'appr_1', '--deny', '--note', 'too risky'],
      transport,
    );
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toMatchObject({ decision: 'deny', note: 'too risky' });
  });

  it('approve exits 1 without --grant or --deny', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['approve', 'task_1', 'appr_1'], transport);
    expect(code).toBe(1);
  });

  it('approve exits 1 with missing positionals', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['approve', 'task_1'], transport);
    expect(code).toBe(1);
  });

  it('ack <itemId> sends an ack-item command and exits 0', async () => {
    const response: ItemMutationResponse = { ok: true, itemId: 'attn_1' };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['ack', 'attn_1'], transport);
    expect(code).toBe(0);
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toEqual({ kind: 'ack-item', itemId: 'attn_1' });
  });

  it('ack exits 1 without an itemId', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['ack'], transport);
    expect(code).toBe(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it('ack exits 1 on an error response', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: false,
      itemId: 'attn_1',
      error: 'item not found',
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['ack', 'attn_1'], transport);
    expect(code).toBe(1);
  });

  it('resolve <itemId> sends a resolve-item command and exits 0', async () => {
    const response: ItemMutationResponse = { ok: true, itemId: 'attn_1' };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['resolve', 'attn_1'], transport);
    expect(code).toBe(0);
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toEqual({ kind: 'resolve-item', itemId: 'attn_1' });
  });

  it('resolve exits 1 without an itemId', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['resolve'], transport);
    expect(code).toBe(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it('resolve exits 1 on an error response', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: false,
      itemId: 'attn_1',
      error: 'already resolved',
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['resolve', 'attn_1'], transport);
    expect(code).toBe(1);
  });

  it('retry <itemId> sends a retry-journal-write command and exits 0 (#264)', async () => {
    const response: ItemMutationResponse = { ok: true, itemId: 'attn_j1' };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['retry', 'attn_j1'], transport);
    expect(code).toBe(0);
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toEqual({ kind: 'retry-journal-write', itemId: 'attn_j1' });
  });

  it('retry exits 1 on a daemon error (e.g. non-JournalFailure item)', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: false,
      itemId: 'attn_1',
      error: 'item is not a journal failure',
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['retry', 'attn_1'], transport);
    expect(code).toBe(1);
  });

  it('escalate <itemId> sends an escalate-item command and exits 0', async () => {
    const response: ItemMutationResponse = { ok: true, itemId: 'attn_1' };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['escalate', 'attn_1'], transport);
    expect(code).toBe(0);
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toEqual({ kind: 'escalate-item', itemId: 'attn_1' });
  });

  it('escalate exits 1 without an itemId', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['escalate'], transport);
    expect(code).toBe(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it('escalate exits 1 on an error response', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: false,
      itemId: 'attn_1',
      error: 'item not found',
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['escalate', 'attn_1'], transport);
    expect(code).toBe(1);
  });

  it('metrics shows the metrics snapshot', async () => {
    const response: MetricsResponse = { ok: true, snapshot: emptyMetrics() };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['metrics'], transport);
    expect(code).toBe(0);
  });

  it('metrics --since passes the since value', async () => {
    const response: MetricsResponse = { ok: true, snapshot: emptyMetrics() };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    await mainWithTransport(['metrics', '--since', '1000'], transport);
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toMatchObject({ kind: 'query-metrics', since: 1000 });
  });

  it('prune sends a prune-worktree command', async () => {
    const response: PruneResponse = { ok: true, taskId: 'task_1' };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['prune', 'task_1'], transport);
    expect(code).toBe(0);
  });

  it('prune exits 1 on error', async () => {
    const response: PruneResponse = { ok: false, taskId: 'task_1', error: 'dirty worktree' };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['prune', 'task_1'], transport);
    expect(code).toBe(1);
  });

  it('digest sends a get-digest command and renders the digest', async () => {
    const response: DigestResponse = { ok: true, digest: makeDigest() };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['digest', 'task_1'], transport);
    expect(code).toBe(0);
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toEqual({ kind: 'get-digest', taskId: 'task_1' });
  });

  it('digest prints a no-digest message when digest is null', async () => {
    const response: DigestResponse = { ok: true, digest: null };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['digest', 'task_1'], transport);
    expect(code).toBe(0);
  });

  it('digest exits 1 on error response', async () => {
    const response: DigestResponse = { ok: false, digest: null, error: 'repo not configured' };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['digest', 'task_1'], transport);
    expect(code).toBe(1);
  });

  it('digest exits 1 without a taskId', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
    })) as unknown as WebSocketTransport;
    const code = await mainWithTransport(['digest'], transport);
    expect(code).toBe(1);
    expect(transport).not.toHaveBeenCalled();
  });

  function makeCatchUpDigest(overrides: Partial<CatchUpDigest> = {}): CatchUpDigest {
    return {
      since: '2026-09-20T00:00:00.000Z',
      until: '2026-09-21T00:00:00.000Z',
      notable: [],
      stillRunning: [],
      pendingAttention: [],
      failovers: [],
      isEmpty: true,
      ...overrides,
    };
  }

  it('catchup sends get-catchup then confirm-catchup after printing, in order', async () => {
    const digest = makeCatchUpDigest();
    const calls: unknown[] = [];
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      calls.push(command);
      const cmd = command as { kind: string };
      if (cmd.kind === 'get-catchup') {
        return { ok: true, digest } satisfies CatchUpResponse;
      }
      return { ok: true } satisfies ConfirmCatchUpResponse;
    }) as unknown as WebSocketTransport;

    const code = await mainWithTransport(['catchup'], transport);

    expect(code).toBe(0);
    expect(calls).toEqual([
      { kind: 'get-catchup' },
      { kind: 'confirm-catchup', until: digest.until },
    ]);
  });

  it('catchup does not send confirm-catchup when get-catchup fails (no false delivery confirmation)', async () => {
    const calls: unknown[] = [];
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      calls.push(command);
      return { ok: false, digest: null, error: 'daemon unavailable' } satisfies CatchUpResponse;
    }) as unknown as WebSocketTransport;

    const code = await mainWithTransport(['catchup'], transport);

    expect(code).toBe(1);
    expect(calls).toEqual([{ kind: 'get-catchup' }]);
  });

  it('catchup exits 0 and warns (but does not fail the command) when confirm-catchup itself fails', async () => {
    const digest = makeCatchUpDigest();
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const cmd = command as { kind: string };
      if (cmd.kind === 'get-catchup') {
        return { ok: true, digest } satisfies CatchUpResponse;
      }
      return { ok: false, error: 'watermark store unavailable' } satisfies ConfirmCatchUpResponse;
    }) as unknown as WebSocketTransport;

    const code = await mainWithTransport(['catchup'], transport);
    expect(code).toBe(0);
  });

  it('inbox --priority filter is passed to the command', async () => {
    const response: InboxResponse = { ok: true, items: [] };
    const transport: WebSocketTransport = vi.fn(
      async () => response,
    ) as unknown as WebSocketTransport;
    await mainWithTransport(['inbox', '--priority', 'Critical'], transport);
    const sentCommand = (transport as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(sentCommand).toMatchObject({
      kind: 'query-inbox',
      filter: { priority: 'Critical' },
    });
  });
});

/* ================================================================== *
 * status --json (issue #321 — machine-readable readiness)
 * ================================================================== */

describe('status --json', () => {
  function jsonRunner(running: boolean) {
    return {
      status: async () => ({ running, port: 17419, pid: running ? 4321 : undefined }),
      start: async () => 0,
      stop: async () => false,
    };
  }

  async function runStatusJson(
    argv: readonly string[],
    runner: ReturnType<typeof jsonRunner>,
    transport?: WebSocketTransport,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        stdout += c.toString();
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        stderr += c.toString();
        return true;
      });
    const original = DaemonClient.prototype.sendRaw;
    if (transport !== undefined) {
      DaemonClient.prototype.sendRaw = function (command: unknown) {
        return transport(command as never, 10_000);
      };
    }
    try {
      const code = await runCli([...argv], {
        client: new DaemonClient({ port: 1 }),
        runner,
        createVoiceSession: async () => {
          throw new Error('voice not used in these tests');
        },
      } satisfies CliDependencies);
      return { code, stdout, stderr };
    } finally {
      DaemonClient.prototype.sendRaw = original;
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('daemon not running → exit 1 with a machine-readable reason', async () => {
    const { code, stderr } = await runStatusJson(['status', '--json'], jsonRunner(false));
    expect(code).toBe(1);
    const doc = JSON.parse(stderr);
    expect(doc.daemon.running).toBe(false);
    expect(doc.error).toBe('daemon-not-running');
  });

  it('daemon alive → JSON carries the same facts the setup card renders', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-providers') {
        return {
          ok: true,
          probed: true,
          providers: [
            {
              id: 'claude-code',
              found: true,
              auth: 'signed-in',
              installable: false,
            },
            {
              id: 'cursor',
              found: false,
              detail: 'not installed',
              installable: true,
            },
          ],
          chatModel: { configured: true, keySource: 'env', state: 'ok' },
        };
      }
      if (kind === 'query-repos') {
        return {
          ok: true,
          roots: { roots: [{ path: '/home/u/code' }] },
          repos: [{ name: 'florina', path: '/home/u/code/florina', rootPath: '/home/u/code' }],
        };
      }
      return { ok: false, error: `unexpected ${kind}` };
    }) as unknown as WebSocketTransport;

    const { code, stdout } = await runStatusJson(['status', '--json'], jsonRunner(true), transport);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);

    // Same-source pin: the serialized fields are exactly what
    // SetupViewInput's providers/chatModel/roots/repos consume.
    expect(doc.providersChecked).toBe(true);
    expect(doc.providersProbed).toBe(true);
    expect(doc.providers[0]).toMatchObject({ id: 'claude-code', found: true, auth: 'signed-in' });
    expect(doc.providers[1]).toMatchObject({ id: 'cursor', found: false, installable: true });
    expect(doc.chatModel).toMatchObject({ configured: true, keySource: 'env', state: 'ok' });
    expect(doc.reposChecked).toBe(true);
    expect(doc.roots).toEqual([{ path: '/home/u/code' }]);
    expect(doc.repos).toEqual([
      { name: 'florina', path: '/home/u/code/florina', rootPath: '/home/u/code' },
    ]);
  });

  it('probed:false serializes as couldn\'t-check, never as "none found"', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-providers') {
        return { ok: true, probed: false, providers: [] };
      }
      return { ok: true, roots: { roots: [] }, repos: [] };
    }) as unknown as WebSocketTransport;

    const { code, stdout } = await runStatusJson(['status', '--json'], jsonRunner(true), transport);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.providersChecked).toBe(true);
    expect(doc.providersProbed).toBe(false);
    expect(doc.chatModel).toBeNull();
  });

  it('daemon alive but protocol dead → exit 1 daemon-unreachable', async () => {
    const transport: WebSocketTransport = vi.fn(async () => {
      throw new DaemonConnectionError('refused');
    }) as unknown as WebSocketTransport;
    const { code, stderr } = await runStatusJson(['status', '--json'], jsonRunner(true), transport);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toBe('daemon-unreachable');
  });

  it('providers query fails while repos answers → checked flags stay honest', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-repos') {
        return { ok: true, roots: { roots: [] }, repos: [] };
      }
      return { ok: false, error: 'no probe' };
    }) as unknown as WebSocketTransport;

    const { code, stdout } = await runStatusJson(['status', '--json'], jsonRunner(true), transport);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.providersChecked).toBe(false);
    expect(doc.providersProbed).toBeNull();
    // Unchecked side emits null — never a fabricated "none found" list.
    expect(doc.providers).toBeNull();
    expect(doc.chatModel).toBeNull();
    expect(doc.reposChecked).toBe(true);
  });

  it('repos query fails while providers answers → roots/repos emit null', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-providers') {
        return { ok: true, probed: true, providers: [] };
      }
      return { ok: false, error: 'repo roots are not wired into this daemon' };
    }) as unknown as WebSocketTransport;

    const { code, stdout } = await runStatusJson(['status', '--json'], jsonRunner(true), transport);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.reposChecked).toBe(false);
    expect(doc.roots).toBeNull();
    expect(doc.repos).toBeNull();
    expect(doc.providersChecked).toBe(true);
  });

  it('absent probed field (older daemon) → providersProbed:null, not false', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-providers') {
        return { ok: true, providers: [{ id: 'codex', found: true }] };
      }
      return { ok: true, roots: { roots: [] }, repos: [] };
    }) as unknown as WebSocketTransport;

    const { stdout } = await runStatusJson(['status', '--json'], jsonRunner(true), transport);
    const doc = JSON.parse(stdout);
    expect(doc.providersChecked).toBe(true);
    expect(doc.providersProbed).toBeNull();
  });

  it('daemon answering ok:false to both queries → exit 1 with error detail', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      return { ok: false, error: `Unknown command kind: ${kind}` };
    }) as unknown as WebSocketTransport;

    const { code, stderr } = await runStatusJson(['status', '--json'], jsonRunner(true), transport);
    expect(code).toBe(1);
    const doc = JSON.parse(stderr);
    expect(doc.error).toBe('daemon-unreachable');
    expect(doc.detail).toContain('Unknown command kind: query-providers');
    expect(doc.detail).toContain('Unknown command kind: query-repos');
  });

  it('malformed ok response (missing providers key) → providersChecked:false', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-providers') {
        return { ok: true };
      }
      return { ok: true, roots: { roots: [] }, repos: [] };
    }) as unknown as WebSocketTransport;

    const { code, stdout } = await runStatusJson(['status', '--json'], jsonRunner(true), transport);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.providersChecked).toBe(false);
    expect(doc.providers).toBeNull();
  });

  it('--json with a stray value is rejected, not silently human-formatted', async () => {
    const { code, stderr } = await runStatusJson(
      ['status', '--json', 'extra-arg'],
      jsonRunner(false),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('Usage: florina status [--json]');
  });

  it('status with a stray positional is rejected', async () => {
    const { code, stderr } = await runStatusJson(['status', 'foo', '--json'], jsonRunner(false));
    expect(code).toBe(1);
    expect(stderr).toContain('Usage: florina status [--json]');
  });
});

/* ================================================================== *
 * repos verbs (issue #322 — agent-drivable folder scope)
 * ================================================================== */

describe('repos', () => {
  async function runRepos(
    argv: readonly string[],
    transport?: WebSocketTransport,
  ): Promise<{ code: number; stdout: string; stderr: string; calls: unknown[] }> {
    let stdout = '';
    let stderr = '';
    const calls: unknown[] = [];
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        stdout += c.toString();
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        stderr += c.toString();
        return true;
      });
    const original = DaemonClient.prototype.sendRaw;
    if (transport !== undefined) {
      DaemonClient.prototype.sendRaw = function (command: unknown) {
        calls.push(command);
        return transport(command as never, 10_000);
      };
    }
    try {
      const code = await runCli([...argv], {
        client: new DaemonClient({ port: 1 }),
        runner: {
          status: async () => ({ running: true, port: 1 }),
          start: async () => 0,
          stop: async () => false,
        },
        createVoiceSession: async () => {
          throw new Error('voice not used in these tests');
        },
      } satisfies CliDependencies);
      return { code, stdout, stderr, calls };
    } finally {
      DaemonClient.prototype.sendRaw = original;
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('repos lists watched folders and discovered projects', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
      roots: { roots: [{ path: '/home/u/code' }] },
      repos: [{ name: 'florina', path: '/home/u/code/florina', rootPath: '/home/u/code' }],
    })) as unknown as WebSocketTransport;
    const { code, stdout, calls } = await runRepos(['repos'], transport);
    expect(code).toBe(0);
    expect(calls).toEqual([{ kind: 'query-repos' }]);
    expect(stdout).toContain('/home/u/code');
    expect(stdout).toContain('florina');
  });

  it('repos list --json emits the same roots+repos facts', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
      roots: { roots: [{ path: '/r' }] },
      repos: [{ name: 'x', path: '/r/x', rootPath: '/r' }],
    })) as unknown as WebSocketTransport;
    const { code, stdout } = await runRepos(['repos', 'list', '--json'], transport);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.roots).toEqual([{ path: '/r' }]);
    expect(doc.repos).toEqual([{ name: 'x', path: '/r/x', rootPath: '/r' }]);
  });

  it('repos add resolves the path, sends add-repo-root, then re-queries discovery', async () => {
    const dir = os.tmpdir();
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-repos') {
        return {
          ok: true,
          roots: { roots: [{ path: dir }] },
          repos: [{ name: 'p', path: `${dir}/p`, rootPath: dir }],
        };
      }
      return { ok: true, roots: { roots: [{ path: dir }] } };
    }) as unknown as WebSocketTransport;
    const { code, stdout, calls } = await runRepos(['repos', 'add', dir], transport);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({ kind: 'add-repo-root', path: path.resolve(dir) });
    expect(calls[1]).toEqual({ kind: 'query-repos' });
    expect(stdout).toContain('1 project');
  });

  it('repos add a nonexistent path fails without touching the daemon', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
    })) as unknown as WebSocketTransport;
    const { code, stderr, calls } = await runRepos(
      ['repos', 'add', path.join(os.tmpdir(), 'definitely-not-here-zz')],
      transport,
    );
    expect(code).toBe(1);
    expect(stderr).toContain('Not a directory');
    expect(calls).toEqual([]);
  });

  it('repos remove without --yes on a non-TTY refuses before mutating', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-repos') {
        return { ok: true, roots: { roots: [{ path: path.resolve('/some/dir') }] }, repos: [] };
      }
      return { ok: true };
    }) as unknown as WebSocketTransport;
    const { code, stderr, calls } = await runRepos(['repos', 'remove', '/some/dir'], transport);
    expect(code).toBe(1);
    expect(stderr).toContain('--yes');
    // The membership pre-query ran; no remove command was sent.
    expect(calls).toEqual([{ kind: 'query-repos' }]);
  });

  it('repos remove --yes sends remove-repo-root and reports what remains', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-repos') {
        return { ok: true, roots: { roots: [{ path: path.resolve('/gone') }] }, repos: [] };
      }
      return { ok: true, roots: { roots: [{ path: '/kept' }] } };
    }) as unknown as WebSocketTransport;
    const { code, stdout, calls } = await runRepos(
      ['repos', 'remove', '/gone', '--yes'],
      transport,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      { kind: 'query-repos' },
      { kind: 'remove-repo-root', path: path.resolve('/gone') },
    ]);
    expect(stdout).toContain('1 folder');
  });

  it('repos remove a path that is not watched exits 1 — no fake success', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
      roots: { roots: [{ path: '/other' }] },
      repos: [],
    })) as unknown as WebSocketTransport;
    const { code, stderr, calls } = await runRepos(
      ['repos', 'remove', '/gone', '--yes'],
      transport,
    );
    expect(code).toBe(1);
    expect(stderr).toContain('Not a watched folder');
    expect(calls).toEqual([{ kind: 'query-repos' }]);
  });

  it('repos accepts flags before positionals (--yes <path>)', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-repos') {
        return { ok: true, roots: { roots: [{ path: path.resolve('/gone') }] }, repos: [] };
      }
      return { ok: true, roots: { roots: [] } };
    }) as unknown as WebSocketTransport;
    const { code, calls } = await runRepos(['repos', 'remove', '--yes', '/gone'], transport);
    expect(code).toBe(0);
    expect(calls).toEqual([
      { kind: 'query-repos' },
      { kind: 'remove-repo-root', path: path.resolve('/gone') },
    ]);
  });

  it('repos remove --yes=false is refused, not treated as consent', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
      roots: { roots: [{ path: path.resolve('/gone') }] },
      repos: [],
    })) as unknown as WebSocketTransport;
    const { code, calls } = await runRepos(['repos', 'remove', '/gone', '--yes=false'], transport);
    expect(code).toBe(1);
    expect(calls).toEqual([{ kind: 'query-repos' }]);
  });

  it('repos move sends move-repo-root with the stored spelling', async () => {
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-repos') {
        return {
          ok: true,
          roots: { roots: [{ path: '/a' }, { path: path.resolve('/b') }] },
          repos: [],
        };
      }
      return { ok: true, roots: { roots: [{ path: '/a' }, { path: path.resolve('/b') }] } };
    }) as unknown as WebSocketTransport;
    const { code, calls } = await runRepos(['repos', 'move', '/b', 'up'], transport);
    expect(code).toBe(0);
    expect(calls).toEqual([
      { kind: 'query-repos' },
      { kind: 'move-repo-root', path: path.resolve('/b'), direction: 'up' },
    ]);
  });

  it('repos move a path that is not watched exits 1 — no fake reorder', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
      roots: { roots: [{ path: '/a' }] },
      repos: [],
    })) as unknown as WebSocketTransport;
    const { code, calls } = await runRepos(['repos', 'move', '/b', 'up'], transport);
    expect(code).toBe(1);
    expect(calls).toEqual([{ kind: 'query-repos' }]);
  });

  it('repos move with a bad direction is a usage error, no command sent', async () => {
    const { code, calls } = await runRepos(['repos', 'move', '/b', 'sideways']);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  it('repos add with an empty path is a usage error — never resolves cwd', async () => {
    const { code, calls } = await runRepos(['repos', 'add', '']);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  it('repos add --json with failed discovery re-query emits JSON + warning', async () => {
    const dir = os.tmpdir();
    const transport: WebSocketTransport = vi.fn(async (command: unknown) => {
      const kind = (command as { kind: string }).kind;
      if (kind === 'query-repos') {
        return { ok: false, error: 'repo scanner is not wired' };
      }
      return { ok: true, roots: { roots: [{ path: dir }] } };
    }) as unknown as WebSocketTransport;
    const { code, stdout } = await runRepos(['repos', 'add', dir, '--json'], transport);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.added).toBe(path.resolve(dir));
    expect(doc.discovered).toBeNull();
    expect(doc.warning).toContain("couldn't list");
  });

  it('repos errors emit JSON when --json is set', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: false,
      error: 'repo roots are not wired into this daemon',
    })) as unknown as WebSocketTransport;
    const { code, stderr } = await runRepos(['repos', '--json'], transport);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain('not wired');
  });

  it('repos list with a stray positional is a usage error', async () => {
    const { code } = await runRepos(['repos', 'list', 'extra']);
    expect(code).toBe(1);
  });

  it('repos --json=<string> is a usage error, never prose at exit 0', async () => {
    const { code, stdout, calls } = await runRepos(['repos', 'list', '--json=true']);
    expect(code).toBe(1);
    expect(stdout).not.toContain('Watched folders');
    expect(calls).toEqual([]);
  });

  it('repos remove/move with an empty path are usage errors', async () => {
    for (const argv of [
      ['repos', 'remove', '', '--yes'],
      ['repos', 'move', '', 'up'],
    ]) {
      const { code, calls } = await runRepos(argv);
      expect(code).toBe(1);
      expect(calls).toEqual([]);
    }
  });

  it('repos list --json emits nulls, not empty arrays, on missing fields', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: true,
    })) as unknown as WebSocketTransport;
    const { code, stdout } = await runRepos(['repos', 'list', '--json'], transport);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.roots).toBeNull();
    expect(doc.repos).toBeNull();
  });

  it('repos unknown subcommand is a usage error', async () => {
    const { code } = await runRepos(['repos', 'frobnicate']);
    expect(code).toBe(1);
  });

  it('daemon error responses exit 1 with the error message', async () => {
    const transport: WebSocketTransport = vi.fn(async () => ({
      ok: false,
      error: 'repo roots are not wired into this daemon',
    })) as unknown as WebSocketTransport;
    const { code, stderr } = await runRepos(['repos'], transport);
    expect(code).toBe(1);
    expect(stderr).toContain('not wired');
  });
});

/* ================================================================== *
 * Constants
 * ================================================================== */

describe('constants', () => {
  it('DEFAULT_PID_FILE is in the OS tmpdir', () => {
    expect(DEFAULT_PID_FILE).toContain(os.tmpdir());
    expect(DEFAULT_PID_FILE).toContain('florina');
  });
});
