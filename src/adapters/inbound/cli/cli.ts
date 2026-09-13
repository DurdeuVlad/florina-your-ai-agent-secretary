/**
 * CLI surface for the `secretary` / `asec` binary (DEC-026, issue #20,
 * DEC-037).
 *
 * Terminal-first surface over the local Secretary daemon. Parses argv with a
 * lightweight, dependency-free parser and dispatches to subcommands that talk
 * to the daemon via {@link DaemonClient} (typed Command API, #19) or manage
 * the daemon lifecycle via an injected {@link DaemonProcessManager}.
 *
 * Works in headless CI/SSH environments (no TUI/desktop dependency, DEC-008).
 * Color output is auto-disabled when stdout is not a TTY.
 */
import { DaemonClient, DaemonConnectionError } from './client.js';
import {
  formatInbox,
  formatTask,
  formatTaskList,
  formatDigest,
  formatMetrics,
  formatStatus,
  formatContextHealth,
  setColorEnabled,
} from './formatters.js';
import type { CliDependencies } from './deps.js';
import type {
  Command,
  CommandExecutor,
  QueryInboxCommand,
  ListTasksCommand,
  QueryMetricsCommand,
  ApproveCommand,
  AcknowledgeItemCommand,
  ResolveItemCommand,
  EscalateItemCommand,
  GetDigestCommand,
  InboxFilter,
  InboxResponse,
  TaskListResponse,
  TaskResponse,
  MetricsResponse,
  ApproveResponse,
  ItemMutationResponse,
  PruneResponse,
  ShutdownResponse,
  DigestResponse,
  ContextHealthResponse,
} from '../../../core/application/use-cases/tasks/command-api.js';
import type { TaskState } from '../../../core/domain/enums.js';
import type {
  AttentionItemKind,
  AttentionItemPriority,
  AttentionItemStatus,
} from '../../../core/application/use-cases/attention/attention-item.js';

/** CLI version (mirrors package.json version). */
export const VERSION = '0.0.1';

/* ================================================================== *
 * Argument parsing (minimal, no external deps)
 * ================================================================== */

/** Parsed CLI invocation: subcommand, positional args, and flags. */
interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Parse a raw argv array into a {@link ParsedArgs} object.
 *
 * - The first non-flag token is the subcommand.
 * - Subsequent non-flag tokens are positionals.
 * - `--flag value` and `--flag=value` set string flags.
 * - `--flag` (no value) sets a boolean `true`.
 * - `-f` short flags are treated like long flags.
 * - A negative number (e.g. `-1`) is treated as a value, not a flag.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = '';

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        const key = tok.slice(2, eq);
        flags[key] = tok.slice(eq + 1);
        i++;
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && isValueToken(next)) {
          flags[key] = next;
          i += 2;
        } else {
          flags[key] = true;
          i++;
        }
      }
    } else if (tok.startsWith('-') && tok.length > 1 && !isNegativeNumber(tok)) {
      const key = tok.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && isValueToken(next)) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      if (command === '') {
        command = tok;
      } else {
        positionals.push(tok);
      }
      i++;
    }
  }

  return { command, positionals, flags };
}

/** Whether a token looks like a negative number (e.g. `-1`, `-3.5`). */
function isNegativeNumber(tok: string): boolean {
  return /^-\d+(\.\d+)?$/.test(tok);
}

/** Whether a token can be consumed as a flag value (not a flag itself). */
function isValueToken(tok: string): boolean {
  if (isNegativeNumber(tok)) return true;
  return !tok.startsWith('-');
}

/* ================================================================== *
 * Help text
 * ================================================================== */

const HELP_TEXT = `secretary — an open-source attention broker for coding agents

Usage: secretary <command> [options] [args]
       asec      <command> [options] [args]

Commands:
  start                       Start the daemon (in-process for MVP)
  stop                        Stop the running daemon
  status                      Show daemon status
  inbox [--filter <p>]        List attention inbox items
    --priority <Critical|High|Medium|Low>
    --status <Pending|Acknowledged|Resolved|Escalated>
    --kind <ApprovalRequest|FailedRun|...>
    --task <taskId>
  approve <taskId> <approvalId> [--grant|--deny] [--note <text>]
                              Grant or deny a pending approval
  ack <itemId>               Acknowledge an attention item
  resolve <itemId>           Resolve an attention item
  escalate <itemId>          Escalate an attention item to Critical
  tasks [--status <state>]    List tasks
  task <taskId>               Show task details
  digest <taskId>             Show completion digest for a task
  metrics [--since <ms>]      Show metrics snapshot
  prune <taskId>              Prune the worktree for a task
  voice [--api-key <key>]     Start a voice session (push-to-talk)
  version                     Print version
  help                        Print this help

Options:
  --no-color                  Disable ANSI color output
  -h, --help                  Show help

Environment:
  The CLI connects to the daemon at ws://127.0.0.1:17419 by default.
`;

/* ================================================================== *
 * Output helper
 * ================================================================== */

/** Write a string to stdout. */
function out(text: string): void {
  process.stdout.write(text);
}

/** Write a string to stderr. */
function err(text: string): void {
  process.stderr.write(text);
}

/* ================================================================== *
 * Subcommand handlers
 * ================================================================== */

/** Context passed to each subcommand handler. */
interface CommandContext {
  readonly args: ParsedArgs;
  readonly deps: CliDependencies;
}

/** Result of a subcommand: exit code and optional message. */
interface CommandResult {
  readonly exitCode: number;
  readonly message?: string;
}

/** Run a subcommand by name. Returns the exit code. */
async function runSubcommand(ctx: CommandContext): Promise<CommandResult> {
  switch (ctx.args.command) {
    case 'start':
      return cmdStart(ctx);
    case 'stop':
      return cmdStop(ctx);
    case 'status':
      return cmdStatus(ctx);
    case 'inbox':
      return cmdInbox(ctx);
    case 'approve':
      return cmdApprove(ctx);
    case 'ack':
      return cmdAck(ctx);
    case 'resolve':
      return cmdResolve(ctx);
    case 'escalate':
      return cmdEscalate(ctx);
    case 'tasks':
      return cmdTasks(ctx);
    case 'task':
      return cmdTask(ctx);
    case 'digest':
      return cmdDigest(ctx);
    case 'metrics':
      return cmdMetrics(ctx);
    case 'prune':
      return cmdPrune(ctx);
    case 'voice':
      return cmdVoice(ctx);
    case 'version':
      return cmdVersion(ctx);
    case 'help':
      return cmdHelp(ctx);
    default:
      return {
        exitCode: 1,
        message: `Unknown command: ${ctx.args.command}\nRun 'secretary help' for usage.`,
      };
  }
}

/* --- start --- */
async function cmdStart(ctx: CommandContext): Promise<CommandResult> {
  try {
    const pid = await ctx.deps.runner.start();
    return { exitCode: 0, message: `Daemon started (pid ${pid}).\n` };
  } catch (e) {
    return { exitCode: 1, message: `Failed to start daemon: ${messageOf(e)}\n` };
  }
}

/* --- stop --- */
async function cmdStop(ctx: CommandContext): Promise<CommandResult> {
  const stopped = await ctx.deps.runner.stop();
  if (stopped) {
    return { exitCode: 0, message: 'Daemon stopped.\n' };
  }
  return { exitCode: 1, message: 'Daemon is not running.\n' };
}

/* --- status --- */
async function cmdStatus(ctx: CommandContext): Promise<CommandResult> {
  const status = await ctx.deps.runner.status();
  let message = formatStatus(status.running, status.port, status.pid);
  // Surface per-agent context health when the daemon is reachable
  // (DEC-035, issue #77) — a degrading context is a liveness-adjacent
  // signal the human should see at a glance.
  if (status.running) {
    const response = await sendCommand(ctx.deps.client, { kind: 'context-health' });
    if (response.ok) {
      message += formatContextHealth((response as ContextHealthResponse).snapshots);
    }
  }
  return { exitCode: 0, message };
}

/* --- inbox --- */
async function cmdInbox(ctx: CommandContext): Promise<CommandResult> {
  const filter = buildInboxFilter(ctx.args.flags);
  const command: QueryInboxCommand = { kind: 'query-inbox', filter };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return { exitCode: 1, message: `Failed to query inbox: ${errorOf(response)}\n` };
  }
  const items = (response as InboxResponse).items;
  return { exitCode: 0, message: formatInbox(items) };
}

/* --- approve --- */
async function cmdApprove(ctx: CommandContext): Promise<CommandResult> {
  const [taskId, approvalId] = ctx.args.positionals;
  if (!taskId || !approvalId) {
    return {
      exitCode: 1,
      message: 'Usage: secretary approve <taskId> <approvalId> [--grant|--deny] [--note <text>]\n',
    };
  }
  const decision = resolveDecision(ctx.args.flags);
  if (decision === undefined) {
    return {
      exitCode: 1,
      message: 'Specify either --grant or --deny.\n',
    };
  }
  const note = typeof ctx.args.flags['note'] === 'string' ? ctx.args.flags['note'] : undefined;
  const command: ApproveCommand = {
    kind: 'approve',
    taskId,
    approvalId,
    decision,
    note,
  };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return { exitCode: 1, message: `Approval failed: ${errorOf(response)}\n` };
  }
  const r = response as ApproveResponse;
  return {
    exitCode: 0,
    message: `Approval ${r.approvalId} ${decision}ed.\n`,
  };
}

/* --- ack --- */
async function cmdAck(ctx: CommandContext): Promise<CommandResult> {
  const [itemId] = ctx.args.positionals;
  if (!itemId) {
    return { exitCode: 1, message: 'Usage: secretary ack <itemId>\n' };
  }
  const command: AcknowledgeItemCommand = { kind: 'ack-item', itemId };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return { exitCode: 1, message: `Ack failed: ${errorOf(response)}\n` };
  }
  const r = response as ItemMutationResponse;
  return { exitCode: 0, message: `Item ${r.itemId} acknowledged.\n` };
}

/* --- resolve --- */
async function cmdResolve(ctx: CommandContext): Promise<CommandResult> {
  const [itemId] = ctx.args.positionals;
  if (!itemId) {
    return { exitCode: 1, message: 'Usage: secretary resolve <itemId>\n' };
  }
  const command: ResolveItemCommand = { kind: 'resolve-item', itemId };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return { exitCode: 1, message: `Resolve failed: ${errorOf(response)}\n` };
  }
  const r = response as ItemMutationResponse;
  return { exitCode: 0, message: `Item ${r.itemId} resolved.\n` };
}

/* --- escalate --- */
async function cmdEscalate(ctx: CommandContext): Promise<CommandResult> {
  const [itemId] = ctx.args.positionals;
  if (!itemId) {
    return { exitCode: 1, message: 'Usage: secretary escalate <itemId>\n' };
  }
  const command: EscalateItemCommand = { kind: 'escalate-item', itemId };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return { exitCode: 1, message: `Escalate failed: ${errorOf(response)}\n` };
  }
  const r = response as ItemMutationResponse;
  return { exitCode: 0, message: `Item ${r.itemId} escalated.\n` };
}

/* --- tasks --- */
async function cmdTasks(ctx: CommandContext): Promise<CommandResult> {
  const statusFlag = ctx.args.flags['status'];
  const command: ListTasksCommand = {
    kind: 'list-tasks',
    status: typeof statusFlag === 'string' ? (statusFlag as TaskState) : undefined,
  };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return { exitCode: 1, message: `Failed to list tasks: ${errorOf(response)}\n` };
  }
  const tasks = (response as TaskListResponse).tasks;
  return { exitCode: 0, message: formatTaskList(tasks) };
}

/* --- task --- */
async function cmdTask(ctx: CommandContext): Promise<CommandResult> {
  const [taskId] = ctx.args.positionals;
  if (!taskId) {
    return { exitCode: 1, message: 'Usage: secretary task <taskId>\n' };
  }
  const response = await sendCommand(ctx.deps.client, { kind: 'query-task', taskId });
  if (!response.ok) {
    return { exitCode: 1, message: `Failed to query task: ${errorOf(response)}\n` };
  }
  const r = response as TaskResponse;
  if (!r.task) {
    return { exitCode: 1, message: `Task not found: ${taskId}\n` };
  }
  return { exitCode: 0, message: formatTask(r.task) };
}

/* --- digest --- */
async function cmdDigest(ctx: CommandContext): Promise<CommandResult> {
  const [taskId] = ctx.args.positionals;
  if (!taskId) {
    return { exitCode: 1, message: 'Usage: secretary digest <taskId>\n' };
  }
  const command: GetDigestCommand = { kind: 'get-digest', taskId };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    const r = response as DigestResponse;
    return { exitCode: 1, message: `Failed to query digest: ${r.error ?? errorOf(response)}\n` };
  }
  const r = response as DigestResponse;
  if (!r.digest) {
    return { exitCode: 0, message: `No completion digest found for task ${taskId}.\n` };
  }
  return { exitCode: 0, message: formatDigest(r.digest) };
}

/* --- metrics --- */
async function cmdMetrics(ctx: CommandContext): Promise<CommandResult> {
  const sinceFlag = ctx.args.flags['since'];
  const since = typeof sinceFlag === 'string' ? Number.parseInt(sinceFlag, 10) : undefined;
  const command: QueryMetricsCommand = {
    kind: 'query-metrics',
    since: since !== undefined && !Number.isNaN(since) ? since : undefined,
  };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return { exitCode: 1, message: `Failed to query metrics: ${errorOf(response)}\n` };
  }
  const r = response as MetricsResponse;
  if (!r.snapshot) {
    return { exitCode: 0, message: 'No metrics available.\n' };
  }
  return { exitCode: 0, message: formatMetrics(r.snapshot) };
}

/* --- prune --- */
async function cmdPrune(ctx: CommandContext): Promise<CommandResult> {
  const [taskId] = ctx.args.positionals;
  if (!taskId) {
    return { exitCode: 1, message: 'Usage: secretary prune <taskId>\n' };
  }
  const response = await sendCommand(ctx.deps.client, { kind: 'prune-worktree', taskId });
  if (!response.ok) {
    const r = response as PruneResponse;
    return { exitCode: 1, message: `Prune failed: ${r.error ?? errorOf(response)}\n` };
  }
  return { exitCode: 0, message: `Worktree pruned for task ${taskId}.\n` };
}

/* --- version --- */
function cmdVersion(_ctx: CommandContext): CommandResult {
  return { exitCode: 0, message: `secretary ${VERSION}\n` };
}

/* --- voice --- */
async function cmdVoice(ctx: CommandContext): Promise<CommandResult> {
  const apiKey =
    typeof ctx.args.flags['api-key'] === 'string'
      ? ctx.args.flags['api-key']
      : process.env['OPENAI_API_KEY'];
  if (!apiKey || typeof apiKey !== 'string') {
    return {
      exitCode: 1,
      message: 'Voice requires an OpenAI API key. Set OPENAI_API_KEY or pass --api-key <key>.\n',
    };
  }

  // The voice command needs a running daemon to route tool calls. Check
  // connectivity first by querying status.
  const status = await ctx.deps.runner.status();
  if (!status.running) {
    return {
      exitCode: 1,
      message:
        'Daemon is not running. Start it first with `secretary start` in another terminal.\n',
    };
  }

  try {
    // The voice session connects to the daemon's command API via the same
    // WebSocket client the CLI uses. We create a long-lived client that
    // stays open for the duration of the voice session.
    const voiceClient = new DaemonClient();

    // Create a minimal command API proxy that routes execute() calls over
    // the WebSocket client. The voice session calls this for each tool call
    // from the voice model.
    const commandApi: CommandExecutor = {
      async execute(command: Command) {
        return voiceClient.send(command);
      },
    };

    const session = await ctx.deps.createVoiceSession({ apiKey, commandApi });

    session.onTranscript((text, partial) => {
      if (partial) {
        err(`[you] ${text}\r`);
      } else {
        err(`[you] ${text}\n`);
      }
    });
    session.onModeChange((mode) => {
      err(`[voice] mode: ${mode}\n`);
    });
    session.onToolCall((name, success, result) => {
      err(`[tool] ${name}: ${success ? 'ok' : 'failed'} ${JSON.stringify(result).slice(0, 200)}\n`);
    });
    session.onStateChange((state) => {
      err(`[voice] state: ${state}\n`);
    });

    err('Voice session starting. Press Enter to talk, Ctrl-C to stop.\n');
    await session.start();

    // Keep the process alive until interrupted.
    return new Promise<CommandResult>((resolve) => {
      const cleanup = async (): Promise<void> => {
        await session.stop();
        resolve({ exitCode: 0, message: 'Voice session ended.\n' });
      };
      process.on('SIGINT', () => {
        void cleanup();
      });
      process.on('SIGTERM', () => {
        void cleanup();
      });
    });
  } catch (e) {
    return { exitCode: 1, message: `Voice session failed: ${messageOf(e)}\n` };
  }
}

/* --- help --- */
function cmdHelp(_ctx: CommandContext): CommandResult {
  return { exitCode: 0, message: HELP_TEXT };
}

/* ================================================================== *
 * Helpers
 * ================================================================== */

/** Build an inbox filter object from CLI flags. */
function buildInboxFilter(
  flags: Readonly<Record<string, string | boolean>>,
): InboxFilter | undefined {
  const priority =
    typeof flags['priority'] === 'string'
      ? (flags['priority'] as AttentionItemPriority)
      : undefined;
  const status =
    typeof flags['status'] === 'string' ? (flags['status'] as AttentionItemStatus) : undefined;
  const kind = typeof flags['kind'] === 'string' ? (flags['kind'] as AttentionItemKind) : undefined;
  const taskId = typeof flags['task'] === 'string' ? flags['task'] : undefined;
  if (
    priority === undefined &&
    status === undefined &&
    kind === undefined &&
    taskId === undefined
  ) {
    return undefined;
  }
  return { priority, status, kind, taskId };
}

/** Resolve --grant / --deny into a decision. */
function resolveDecision(
  flags: Readonly<Record<string, string | boolean>>,
): 'grant' | 'deny' | undefined {
  if (flags['grant'] === true) return 'grant';
  if (flags['deny'] === true) return 'deny';
  return undefined;
}

/** Send a command via the client and translate connection errors. */
async function sendCommand(
  client: DaemonClient,
  command: Command,
): Promise<
  | InboxResponse
  | TaskListResponse
  | TaskResponse
  | MetricsResponse
  | ApproveResponse
  | ItemMutationResponse
  | PruneResponse
  | ShutdownResponse
  | DigestResponse
  | ContextHealthResponse
  | { ok: false; error: string }
> {
  try {
    return await client.send(command);
  } catch (e) {
    if (e instanceof DaemonConnectionError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: messageOf(e) };
  }
}

/** Extract an error message from a response. */
function errorOf(response: { ok: boolean; error?: string }): string {
  return response.error ?? 'unknown error';
}

/** Extract a human-readable message from an unknown error. */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/* ================================================================== *
 * Entry point
 * ================================================================== */

/**
 * Run the CLI against injected dependencies. Parses argv, dispatches to a
 * subcommand, and writes output. The bootstrap composition root calls this
 * with the concrete client, daemon runner, and voice session factory;
 * tests may inject fakes.
 */
export async function runCli(argv: readonly string[], deps: CliDependencies): Promise<number> {
  // Handle --no-color and --help before anything else.
  if (argv.includes('--no-color')) {
    setColorEnabled(false);
  }
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    out(HELP_TEXT);
    return 0;
  }

  const args = parseArgs(argv);
  if (args.flags['no-color'] === true) {
    setColorEnabled(false);
  }

  // `version` and `help` don't need a client/runner.
  if (args.command === 'version') {
    out(`secretary ${VERSION}\n`);
    return 0;
  }
  if (args.command === 'help') {
    out(HELP_TEXT);
    return 0;
  }

  const ctx: CommandContext = { args, deps };

  const result = await runSubcommand(ctx);
  if (result.message) {
    if (result.exitCode === 0) {
      out(result.message);
    } else {
      err(result.message);
    }
  }
  return result.exitCode;
}
