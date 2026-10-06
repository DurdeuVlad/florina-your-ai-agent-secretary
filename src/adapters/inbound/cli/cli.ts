/**
 * CLI surface for the `florina` / `flor` binary (DEC-026, issue #20,
 * DEC-037).
 *
 * Terminal-first surface over the local Florina daemon. Parses argv with a
 * lightweight, dependency-free parser and dispatches to subcommands that talk
 * to the daemon via {@link DaemonClient} (typed Command API, #19) or manage
 * the daemon lifecycle via an injected {@link DaemonProcessManager}.
 *
 * Works in headless CI/SSH environments (no TUI/desktop dependency, DEC-008).
 * Color output is auto-disabled when stdout is not a TTY.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { DaemonClient, DaemonConnectionError } from './client.js';
import {
  formatInbox,
  formatTask,
  formatTaskList,
  formatDigest,
  formatMetrics,
  formatStatus,
  formatContextHealth,
  formatProviderReadiness,
  formatCatchUp,
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
  RetryJournalWriteCommand,
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
  PreferenceResponse,
  CatchUpResponse,
  ConfirmCatchUpResponse,
  SecretsSetResponse,
  SecretsListResponse,
  SecretsDeleteResponse,
  ProvidersResponse,
  ReposResponse,
  QueryReposCommand,
  AddRepoRootCommand,
  RemoveRepoRootCommand,
  MoveRepoRootCommand,
  SigninProviderResponse,
  InstallProviderResponse,
} from '../../../core/application/use-cases/tasks/command-api.js';
import type { DaemonProcessStatus } from './deps.js';
import type { TaskState } from '../../../core/domain/enums.js';
import type {
  AttentionItemKind,
  AttentionItemPriority,
  AttentionItemStatus,
} from '../../../core/application/use-cases/attention/attention-item.js';

/** CLI version (mirrors package.json version — pinned by cli.test.ts). */
export const VERSION = '0.3.0';

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
 * Flags that are always boolean — they never swallow the next token as a
 * value. A string value is only reachable via `--flag=value`, and every
 * consumer reads these with `=== true`, so `--yes=false` still refuses.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'yes',
  'json',
  'grant',
  'deny',
  'no-color',
  'detach',
  'help',
  'h',
]);

/**
 * Parse a raw argv array into a {@link ParsedArgs} object.
 *
 * - The first non-flag token is the subcommand.
 * - Subsequent non-flag tokens are positionals.
 * - `--flag value` and `--flag=value` set string flags.
 * - `--flag` (no value) sets a boolean `true`.
 * - Flags named in `booleanFlags` never consume the next token, so
 *   `--yes <path>` keeps `<path>` as a positional. Only the `--flag=value`
 *   form can give them a string (which consent checks treat as false).
 * - `-f` short flags are treated like long flags.
 * - A negative number (e.g. `-1`) is treated as a value, not a flag.
 */
export function parseArgs(
  argv: readonly string[],
  booleanFlags: ReadonlySet<string> = new Set(),
): ParsedArgs {
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
        if (next !== undefined && isValueToken(next) && !booleanFlags.has(key)) {
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
      if (next !== undefined && isValueToken(next) && !booleanFlags.has(key)) {
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

const HELP_TEXT = `florina — an open-source attention broker for coding agents

Usage: florina <command> [options] [args]
       flor      <command> [options] [args]

Commands:
  start [--detach] [--json]   Start the daemon (foreground by default;
                              --detach runs it in the background)
  stop                        Stop the running daemon
  status [--json]             Show daemon status (JSON: providers, chat model, repos)
  inbox [--filter <p>]        List attention inbox items
    --priority <Critical|High|Medium|Low>
    --status <Pending|Acknowledged|Resolved|Escalated>
    --kind <ApprovalRequest|FailedRun|...>
    --task <taskId>
  approve <taskId> <approvalId> [--grant|--deny] [--note <text>]
                              Grant or deny a pending approval
  ack <itemId>               Acknowledge an attention item
  resolve <itemId>           Resolve an attention item
  retry <itemId>             Re-attempt a journal failure's retained writes
  escalate <itemId>          Escalate an attention item to Critical
  tasks [--status <state>]    List tasks
  task <taskId>               Show task details
  digest <taskId>             Show completion digest for a task
  catchup                     Show what happened since you were last active
  metrics [--since <ms>]      Show metrics snapshot
  preferences [--project <id>]  Show routing preference rules + deny list
  repos [list] [--json]       Show watched folders and discovered projects
  repos add <path>            Watch a folder for projects
  repos remove <path> [--yes] Stop watching a folder (asks first)
  repos move <path> up|down   Reorder a watched folder's priority
  keys set <name> [--provider <id>] [--project <id>] [--env-var <NAME>]
                              Store an API key or secret (prompts, no echo)
      [--description <text>] [--expires <ISO>]
  keys list                   List stored secrets (metadata only)
  keys remove <name>          Delete a stored secret
  auth                        Show provider sign-in state (re-checks now)
  auth <provider>             Open the provider's sign-in flow (or print
                              the exact fix); use 'chat' for the model key
  install <provider>          Install a missing provider CLI (asks you
                              first; runs the official installer)
  prune <taskId>              Prune the worktree for a task
  voice [--api-key <key>]     Start a voice session (push-to-talk)
      [--litellm-url <url>]   LiteLLM proxy for Florina-loop tools
      [--model <name>]        Model on the proxy (FLORINA_MODEL)
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
    case 'retry':
      return cmdRetry(ctx);
    case 'escalate':
      return cmdEscalate(ctx);
    case 'tasks':
      return cmdTasks(ctx);
    case 'task':
      return cmdTask(ctx);
    case 'digest':
      return cmdDigest(ctx);
    case 'catchup':
      return cmdCatchUp(ctx);
    case 'metrics':
      return cmdMetrics(ctx);
    case 'preferences':
      return cmdPreferences(ctx);
    case 'keys':
      return cmdKeys(ctx);
    case 'auth':
      return cmdAuth(ctx);
    case 'install':
      return cmdInstall(ctx);
    case 'repos':
      return cmdRepos(ctx);
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
        message: `Unknown command: ${ctx.args.command}\nRun 'florina help' for usage.`,
      };
  }
}

/* --- start --- */
async function cmdStart(ctx: CommandContext): Promise<CommandResult> {
  // Unknown flags on this verb are usage errors, not silent ignores —
  // `--deatch` (typo) must never silently become a blocking foreground
  // daemon an agent can't leave.
  for (const flag of Object.keys(ctx.args.flags)) {
    if (!START_FLAGS.has(flag)) {
      return { exitCode: 1, message: `Unknown flag: --${flag}\n` };
    }
  }
  if (ctx.args.positionals.length > 0) {
    return { exitCode: 1, message: 'Usage: florina start [--detach] [--json]\n' };
  }
  // --json only makes sense for the detached path: a foreground start
  // hands stdout to the long-running daemon, so a JSON promise would be
  // a lie. --detach=<value> is likewise a usage error.
  const detachFlag = ctx.args.flags['detach'];
  if (detachFlag !== undefined && detachFlag !== true) {
    return { exitCode: 1, message: 'Usage: florina start [--detach] [--json]\n' };
  }
  const jsonFlag = ctx.args.flags['json'];
  if (jsonFlag !== undefined && (jsonFlag !== true || detachFlag !== true)) {
    return { exitCode: 1, message: 'Usage: florina start [--detach] [--json]\n' };
  }
  const detach = detachFlag === true;
  const json = jsonFlag === true;
  const error = (message: string): CommandResult => ({
    exitCode: 1,
    message: json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`,
  });
  try {
    if (detach) {
      const { pid, logFile } = await ctx.deps.runner.startDetached();
      if (json) {
        return {
          exitCode: 0,
          message: `${JSON.stringify({ started: true, detached: true, pid, logFile })}\n`,
        };
      }
      return {
        exitCode: 0,
        message: `Daemon started in the background (pid ${pid}). Log: ${logFile}\n`,
      };
    }
    const pid = await ctx.deps.runner.start();
    return { exitCode: 0, message: `Daemon started (pid ${pid}).\n` };
  } catch (e) {
    return error(`Failed to start daemon: ${messageOf(e)}`);
  }
}

/** The only flags `florina start` understands. */
const START_FLAGS: ReadonlySet<string> = new Set(['detach', 'json', 'no-color', 'help', 'h']);

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
  // `--json` takes no value and `status` takes no positionals — a stray
  // token must not silently fall back to human output for an agent caller.
  const jsonFlag = ctx.args.flags['json'];
  if (jsonFlag !== undefined || ctx.args.positionals.length > 0) {
    if (jsonFlag !== true || ctx.args.positionals.length > 0) {
      return { exitCode: 1, message: 'Usage: florina status [--json]\n' };
    }
    return statusAsJson(ctx, await ctx.deps.runner.status());
  }
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
    // Provider auth readiness (issue #294): signed-in / not-signed-in /
    // failing per installed provider plus the chat-model key source —
    // the check that would have caught a dead credential before a turn
    // failed on it.
    const provRes = await sendCommand(ctx.deps.client, { kind: 'query-providers' }).catch(
      () => null,
    );
    if (provRes !== null && provRes.ok) {
      const p = provRes as ProvidersResponse;
      message += formatProviderReadiness(p.providers, p.probed === true, p.chatModel);
    }
  }
  return { exitCode: 0, message };
}

/**
 * `status --json` (issue #321): the same readiness facts the desktop
 * setup card renders — provider attach/auth state, chat-model readiness,
 * repo roots + discovered repos — as one JSON document, so an external
 * agent can parse truth instead of scraping prose. `null` marks "couldn't
 * check" / "not reported" — never fabricated emptiness.
 *
 * Exit contract: 0 = the daemon answered (facts delivered, whatever they
 * say); non-zero = the answer could not be obtained (daemon down or
 * protocol-dead), with `error` carrying a machine-readable reason.
 */
async function statusAsJson(
  ctx: CommandContext,
  status: DaemonProcessStatus,
): Promise<CommandResult> {
  const daemon = { running: status.running, port: status.port, pid: status.pid ?? null };
  if (!status.running) {
    return {
      exitCode: 1,
      message: `${JSON.stringify({ cliVersion: VERSION, daemon, error: 'daemon-not-running' })}\n`,
    };
  }
  const [provRes, reposRes] = await Promise.all([
    sendCommand(ctx.deps.client, { kind: 'query-providers' }),
    sendCommand(ctx.deps.client, { kind: 'query-repos' }),
  ]);
  // Shape guards mirror the desktop card's checks: an `ok` reply missing
  // the expected payload keys is "couldn't check", not truth.
  const p =
    provRes.ok && 'providers' in provRes && Array.isArray(provRes.providers)
      ? (provRes as ProvidersResponse)
      : null;
  const r =
    reposRes.ok &&
    'roots' in reposRes &&
    'repos' in reposRes &&
    reposRes.roots !== undefined &&
    reposRes.repos !== undefined
      ? (reposRes as ReposResponse)
      : null;
  if (p === null && r === null) {
    // Process alive but nothing answered — protocol dead, wrong build, or
    // unwired features. The underlying errors go in `detail` so an agent
    // can tell "start the daemon" from "upgrade the daemon".
    return {
      exitCode: 1,
      message: `${JSON.stringify({
        cliVersion: VERSION,
        daemon,
        error: 'daemon-unreachable',
        detail: [
          'error' in provRes ? provRes.error : undefined,
          'error' in reposRes ? reposRes.error : undefined,
        ].filter((e): e is string => e !== undefined),
      })}\n`,
    };
  }
  return {
    exitCode: 0,
    message: `${JSON.stringify({
      cliVersion: VERSION,
      daemon,
      providersChecked: p !== null,
      providersProbed: p === null ? null : p.probed === undefined ? null : p.probed === true,
      providers: p === null ? null : p.providers,
      chatModel: p === null ? null : (p.chatModel ?? null),
      reposChecked: r !== null,
      roots: r === null ? null : (r.roots?.roots ?? null),
      repos: r === null ? null : (r.repos ?? null),
    })}\n`,
  };
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
      message: 'Usage: florina approve <taskId> <approvalId> [--grant|--deny] [--note <text>]\n',
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
    return { exitCode: 1, message: 'Usage: florina ack <itemId>\n' };
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
    return { exitCode: 1, message: 'Usage: florina resolve <itemId>\n' };
  }
  const command: ResolveItemCommand = { kind: 'resolve-item', itemId };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return { exitCode: 1, message: `Resolve failed: ${errorOf(response)}\n` };
  }
  const r = response as ItemMutationResponse;
  return { exitCode: 0, message: `Item ${r.itemId} resolved.\n` };
}

/* --- retry (issue #264: re-attempt a journal failure's retained writes) --- */
async function cmdRetry(ctx: CommandContext): Promise<CommandResult> {
  const [itemId] = ctx.args.positionals;
  if (!itemId) {
    return { exitCode: 1, message: 'Usage: florina retry <itemId>\n' };
  }
  const command: RetryJournalWriteCommand = { kind: 'retry-journal-write', itemId };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return { exitCode: 1, message: `Retry failed: ${errorOf(response)}\n` };
  }
  const r = response as ItemMutationResponse;
  return { exitCode: 0, message: `Item ${r.itemId} retried — the writes landed.\n` };
}

/* --- escalate --- */
async function cmdEscalate(ctx: CommandContext): Promise<CommandResult> {
  const [itemId] = ctx.args.positionals;
  if (!itemId) {
    return { exitCode: 1, message: 'Usage: florina escalate <itemId>\n' };
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
    return { exitCode: 1, message: 'Usage: florina task <taskId>\n' };
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
    return { exitCode: 1, message: 'Usage: florina digest <taskId>\n' };
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

/**
 * `florina catchup` — the "since you were last active" digest (DEC-042,
 * issue #217). Delivery-gated watermark advance: the digest is printed
 * directly here (not via the returned `message`, which the caller prints
 * *after* this function returns) so `confirm-catchup` is only sent once
 * the write has actually happened. If the write throws (e.g. a closed
 * stdout pipe), `confirm-catchup` is skipped — a crash before delivery
 * must not advance the watermark.
 */
async function cmdCatchUp(ctx: CommandContext): Promise<CommandResult> {
  const response = await sendCommand(ctx.deps.client, { kind: 'get-catchup' });
  if (!response.ok) {
    return { exitCode: 1, message: `Failed to compute catch-up digest: ${errorOf(response)}\n` };
  }
  const r = response as CatchUpResponse;
  if (!r.digest) {
    return { exitCode: 1, message: 'Failed to compute catch-up digest: no digest returned.\n' };
  }

  out(formatCatchUp(r.digest));

  const confirmed = await sendCommand(ctx.deps.client, {
    kind: 'confirm-catchup',
    until: r.digest.until,
  });
  if (!confirmed.ok) {
    err(`Warning: failed to advance the catch-up watermark: ${errorOf(confirmed)}\n`);
  }

  return { exitCode: 0 };
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

/* --- preferences --- */
async function cmdPreferences(ctx: CommandContext): Promise<CommandResult> {
  const projectFlag = ctx.args.flags['project'];
  const response = await sendCommand(ctx.deps.client, {
    kind: 'query-preferences',
    ...(typeof projectFlag === 'string' ? { projectId: projectFlag } : {}),
  });
  if (!response.ok) {
    return { exitCode: 1, message: `Failed to query preferences: ${errorOf(response)}\n` };
  }
  const r = response as PreferenceResponse;
  return { exitCode: 0, message: `${r.summary ?? 'no preferences recorded'}\n` };
}

/* --- keys --- */
/**
 * Read a secret value from stdin without echoing it.
 * - TTY: raw-mode read, no character echo at all (sudo-style).
 * - Non-TTY (piped): reads ALL of stdin so multi-line values (PEM keys)
 *   work; trailing line endings are stripped.
 * The caller trims, so a secret with significant leading/trailing
 * whitespace is not preserved — true for every real API key format.
 */
async function readSecretValue(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/[\r\n]+$/, '');
  }
  out('Secret value (input hidden): ');
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const finish = (value: string): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      out('\n');
      resolve(value);
    };
    const onData = (data: string): void => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          finish(buf);
          return;
        } else if (ch === '\u0003') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          out('\n');
          reject(new Error('cancelled'));
          return;
        } else if (ch === '\u007F' || ch === '\b') {
          buf = buf.slice(0, -1);
        } else if (ch >= ' ') {
          // Printable only — arrows/ESC/etc. send multi-byte sequences
          // that would silently corrupt the pasted key.
          buf += ch;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

/** Strip control chars so a hostile/stale vault field can't inject ANSI. */
function safeDisplay(text: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: display sanitizer
  return text.replace(/[\x00-\x1F\x7F-\x9F]/g, '?');
}

async function cmdKeys(ctx: CommandContext): Promise<CommandResult> {
  const [sub, name] = ctx.args.positionals;
  if (sub === 'set') {
    if (!name) {
      return {
        exitCode: 1,
        message:
          'Usage: florina keys set <name> [--provider <id>] [--project <id>] [--env-var <NAME>] [--description <text>] [--expires <ISO>]\n',
      };
    }
    // Fail fast on an unreachable daemon before prompting for a secret.
    const status = await ctx.deps.runner.status();
    if (!status.running) {
      return {
        exitCode: 1,
        message: 'Florina daemon is not running — start it first (`florina start`).\n',
      };
    }
    let value: string;
    try {
      value = (await readSecretValue()).trim();
    } catch {
      return { exitCode: 130, message: 'Cancelled.\n' };
    }
    if (value === '') {
      return { exitCode: 1, message: 'Empty value — nothing stored.\n' };
    }
    const flag = (k: string): string | undefined =>
      typeof ctx.args.flags[k] === 'string' ? (ctx.args.flags[k] as string) : undefined;
    const scope = {
      ...(flag('provider') !== undefined ? { provider: flag('provider') } : {}),
      ...(flag('project') !== undefined ? { projectId: flag('project') } : {}),
      ...(flag('env-var') !== undefined ? { envVarName: flag('env-var') } : {}),
    };
    const response = await sendCommand(ctx.deps.client, {
      kind: 'secrets-set',
      name,
      value,
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
      ...(flag('description') !== undefined ? { description: flag('description') } : {}),
      ...(flag('expires') !== undefined ? { expiresAt: flag('expires') } : {}),
    });
    if (!response.ok) {
      const r = response as SecretsSetResponse;
      return { exitCode: 1, message: `Failed to store secret: ${r.error ?? errorOf(response)}\n` };
    }
    return {
      exitCode: 0,
      message: `Secret "${(response as SecretsSetResponse).name ?? name}" stored.\n`,
    };
  }
  if (sub === 'list') {
    const response = await sendCommand(ctx.deps.client, { kind: 'secrets-list' });
    if (!response.ok) {
      const r = response as SecretsListResponse;
      return { exitCode: 1, message: `Failed to list secrets: ${r.error ?? errorOf(response)}\n` };
    }
    const secrets = (response as SecretsListResponse).secrets ?? [];
    if (secrets.length === 0) {
      return { exitCode: 0, message: 'No secrets stored.\n' };
    }
    const lines = secrets.map((s) => {
      const scope = s.scope ?? {};
      const scopeBits = [
        scope.provider !== undefined ? `provider:${safeDisplay(scope.provider)}` : null,
        scope.projectId !== undefined ? `project:${safeDisplay(scope.projectId)}` : null,
        scope.envVarName !== undefined ? `env:${safeDisplay(scope.envVarName)}` : null,
      ]
        .filter((b): b is string => b !== null)
        .join(' ');
      const scopeStr = scopeBits !== '' ? ` [${scopeBits}]` : ' [global]';
      const desc = s.description !== undefined ? ` — ${safeDisplay(s.description)}` : '';
      return `  ${safeDisplay(s.name)}${scopeStr}${desc}  (stored ${s.createdAt})`;
    });
    return { exitCode: 0, message: `${secrets.length} secret(s):\n${lines.join('\n')}\n` };
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    if (!name) {
      return { exitCode: 1, message: 'Usage: florina keys remove <name>\n' };
    }
    const response = await sendCommand(ctx.deps.client, { kind: 'secrets-delete', name });
    if (!response.ok) {
      const r = response as SecretsDeleteResponse;
      return { exitCode: 1, message: `Failed to delete secret: ${r.error ?? errorOf(response)}\n` };
    }
    const deleted = (response as SecretsDeleteResponse).deleted === true;
    return {
      exitCode: 0,
      message: deleted ? `Secret "${name}" deleted.\n` : `No secret named "${name}".\n`,
    };
  }
  return {
    exitCode: 1,
    message: 'Usage: florina keys <set|list|remove> [args]\nRun "florina help" for details.\n',
  };
}

/* --- auth --- */

/**
 * `florina auth` (issue #294): provider sign-in remediation. With no
 * argument it prints the readiness table (the re-check path); with a
 * provider id it asks the daemon to open that provider's own sign-in
 * flow in a visible terminal, or prints the exact manual fix when the
 * provider has no automatable login.
 */
async function cmdAuth(ctx: CommandContext): Promise<CommandResult> {
  const [providerId] = ctx.args.positionals;
  const status = await ctx.deps.runner.status();
  if (!status.running) {
    return {
      exitCode: 1,
      message: 'Florina daemon is not running — start it first (`florina start`).\n',
    };
  }
  const provRes = await sendCommand(ctx.deps.client, { kind: 'query-providers' });
  if (!provRes.ok) {
    const r = provRes as ProvidersResponse;
    return { exitCode: 1, message: `Couldn't check providers: ${r.error ?? 'unknown error'}\n` };
  }
  const probed = (provRes as ProvidersResponse).probed === true;
  const providers = (provRes as ProvidersResponse).providers;
  const chatModel = (provRes as ProvidersResponse).chatModel;

  if (providerId === undefined) {
    return {
      exitCode: 0,
      message:
        'Sign-in state per provider (re-checked now):\n' +
        formatProviderReadiness(providers, probed, chatModel) +
        'Run `florina auth <provider>` to open a provider’s sign-in, ' +
        '`florina install <provider>` to install a missing CLI, or ' +
        '`florina keys set <name>` to store an API key.\n',
    };
  }

  // 'chat' is the friendly alias for the Secretary model key. The daemon
  // owns the recipe table — ask it rather than gating on the probed list
  // (a provider skipped by the startup probe may still have a recipe).
  const id = providerId === 'chat' || providerId === 'secretary' ? 'chat-model' : providerId;
  const res = await sendCommand(ctx.deps.client, { kind: 'signin-provider', providerId: id });
  if (!res.ok) {
    const r = res as SigninProviderResponse;
    const ids = providers.map((p) => p.id).join(', ');
    return {
      exitCode: 1,
      message:
        `${r.error ?? 'Sign-in could not be started.'}\n` +
        `Known providers: ${ids || '(none probed)'}, chat-model.\n`,
    };
  }
  const r = res as SigninProviderResponse;
  const state = id === 'chat-model' ? chatModel?.state : providers.find((p) => p.id === id)?.auth;
  const already =
    state === 'signed-in' || state === 'ok'
      ? 'Note: this provider already looked healthy — a fresh sign-in is still fine.\n'
      : '';
  return { exitCode: 0, message: `${already}${r.detail ?? r.fix?.detail ?? 'Done.'}\n` };
}

/**
 * `florina install <provider>` (live-proof follow-up): run the
 * provider's verified official installer in a visible terminal — the
 * typed verb IS the consent; nothing installs without the user asking.
 */
async function cmdInstall(ctx: CommandContext): Promise<CommandResult> {
  const [providerId] = ctx.args.positionals;
  if (providerId === undefined) {
    return { exitCode: 1, message: 'Usage: florina install <provider>\n' };
  }
  const status = await ctx.deps.runner.status();
  if (!status.running) {
    return {
      exitCode: 1,
      message: 'Florina daemon is not running — start it first (`florina start`).\n',
    };
  }
  const res = await sendCommand(ctx.deps.client, { kind: 'install-provider', providerId });
  const r = res as InstallProviderResponse;
  if (!res.ok) {
    return { exitCode: 1, message: `${r.error ?? 'Install could not be started.'}\n` };
  }
  return { exitCode: 0, message: `${r.detail ?? 'Done.'}\n` };
}

/* --- repos (issue #322) ---
 *
 * CLI surface for repo-root management. All four verbs map 1:1 onto the
 * existing daemon commands (issue #253) — no new daemon behavior. `add`
 * never guesses a scope: the caller names the literal folder. `remove`
 * keeps a consent moment: a TTY gets a y/N prompt, a non-TTY caller (an
 * agent) must pass --yes — the typed verb stays the consent.
 */
async function cmdRepos(ctx: CommandContext): Promise<CommandResult> {
  const [sub, ...rest] = ctx.args.positionals;
  // `--json=<anything>` is a usage error, same as `status --json=x` —
  // an agent that asked for JSON must never get prose at exit 0.
  const jsonFlag = ctx.args.flags['json'];
  if (jsonFlag !== undefined && jsonFlag !== true) return reposUsage();
  const json = jsonFlag === true;
  switch (sub) {
    case undefined:
    case 'list':
      if (rest.length > 0) return reposUsage();
      return reposList(ctx, json);
    case 'add':
      if (rest.length !== 1) return reposUsage();
      return reposAdd(ctx, rest[0], json);
    case 'remove':
    case 'rm':
    case 'delete':
      if (rest.length !== 1) return reposUsage();
      return reposRemove(ctx, rest[0], json, ctx.args.flags['yes'] === true);
    case 'move':
      if (rest.length !== 2) return reposUsage();
      return reposMove(ctx, rest[0], rest[1], json);
    default:
      return reposUsage();
  }
}

function reposUsage(): CommandResult {
  return {
    exitCode: 1,
    message:
      'Usage: florina repos [list|add <path>|remove <path>|move <path> up|down] [--json] [--yes]\n',
  };
}

/** Error output honors --json: agents get a parseable reason, not prose. */
function reposError(message: string, json: boolean): CommandResult {
  if (json) {
    return { exitCode: 1, message: `${JSON.stringify({ error: message })}\n` };
  }
  return { exitCode: 1, message: `${message}\n` };
}

/**
 * Match a typed path against configured roots. The daemon compares
 * verbatim strings, so we look up the stored spelling and send THAT —
 * a case/spelling variant the user typed still removes the right root,
 * and we never claim success on a path the daemon doesn't watch.
 */
async function findStoredRoot(
  ctx: CommandContext,
  target: string,
): Promise<{ ok: true; stored?: string } | { ok: false }> {
  const query = await sendCommand(ctx.deps.client, { kind: 'query-repos' });
  if (!query.ok || !('roots' in query)) return { ok: false };
  const roots = (query as ReposResponse).roots?.roots;
  if (!Array.isArray(roots)) return { ok: false };
  // Stored roots are verbatim strings; on Windows the filesystem ignores
  // case and treats / and \ alike, so normalize both — and always send the
  // STORED spelling so the daemon's verbatim compare removes the right root.
  const norm = (p: string) =>
    process.platform === 'win32' ? p.toLowerCase().replace(/\//g, '\\') : p;
  return {
    ok: true,
    stored: roots.find((r) => typeof r.path === 'string' && norm(r.path) === norm(target))?.path,
  };
}

/** Format the roots + discovered repos either as JSON or human text. */
function reposMessage(r: ReposResponse, json: boolean): string {
  if (json) {
    const roots = Array.isArray(r.roots?.roots) ? r.roots.roots : null;
    const repos = Array.isArray(r.repos) ? r.repos : null;
    return `${JSON.stringify({ roots, repos })}\n`;
  }
  const roots = Array.isArray(r.roots?.roots) ? r.roots.roots : [];
  const repos = Array.isArray(r.repos) ? r.repos : [];
  const lines: string[] = [];
  if (roots.length === 0) {
    lines.push('No watched folders — add one with `florina repos add <path>`.');
  } else {
    lines.push('Watched folders:');
    for (const [i, root] of roots.entries()) {
      lines.push(`  ${i + 1}. ${root.path}`);
    }
  }
  if (roots.length > 0) {
    if (repos.length === 0) {
      lines.push('No projects found inside the watched folders.');
    } else {
      lines.push('Projects:');
      for (const repo of repos) {
        lines.push(`  ${repo.name} — ${repo.path}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

async function reposList(ctx: CommandContext, json: boolean): Promise<CommandResult> {
  const command: QueryReposCommand = { kind: 'query-repos' };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return reposError(`Failed to query watched folders: ${errorOf(response)}`, json);
  }
  return { exitCode: 0, message: reposMessage(response as ReposResponse, json) };
}

async function reposAdd(
  ctx: CommandContext,
  rawPath: string | undefined,
  json: boolean,
): Promise<CommandResult> {
  if (rawPath === undefined || rawPath.trim() === '') {
    return reposError('Usage: florina repos add <path>', json);
  }
  const target = path.resolve(rawPath);
  try {
    if (!fs.statSync(target).isDirectory()) {
      return reposError(`Not a directory: ${target}`, json);
    }
  } catch {
    return reposError(`Not a directory: ${target}`, json);
  }
  const command: AddRepoRootCommand = { kind: 'add-repo-root', path: target };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return reposError(`Failed to add folder: ${errorOf(response)}`, json);
  }
  // Re-query so the caller sees the discovery result of the add — the
  // command response carries roots only. If it fails, the add still
  // landed — report that, never a fabricated discovery list.
  const query = await sendCommand(ctx.deps.client, { kind: 'query-repos' });
  const r = query.ok ? (query as ReposResponse) : null;
  const knownRoots = r && Array.isArray(r.roots?.roots) ? r.roots.roots : null;
  const knownRepos = r && Array.isArray(r.repos) ? r.repos : null;
  const discovered =
    knownRepos === null ? null : knownRepos.filter((repo) => repo.rootPath === target).length;
  if (json) {
    return {
      exitCode: 0,
      message: `${JSON.stringify({
        added: target,
        roots: knownRoots,
        repos: knownRepos,
        discovered,
        ...(r === null ? { warning: "added, but couldn't list discovered projects" } : {}),
      })}\n`,
    };
  }
  if (r === null) {
    return {
      exitCode: 0,
      message: `Now watching ${target} (couldn't list discovered projects just now).\n`,
    };
  }
  const found = (knownRepos ?? []).filter((repo) => repo.rootPath === target);
  const discovery =
    found.length === 0
      ? 'no projects found inside it — Florina watches it anyway.'
      : `found ${found.length} project${found.length === 1 ? '' : 's'} inside.`;
  return { exitCode: 0, message: `Now watching ${target} — ${discovery}\n` };
}

/** Ask before narrowing scope — only interactive terminals get a prompt. */
async function confirmRemoval(target: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Stop watching ${target}? [y/N] `, resolve);
      // EOF (Ctrl+D) closes without answering — treat as no.
      rl.on('close', () => resolve(''));
    });
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

async function reposRemove(
  ctx: CommandContext,
  rawPath: string | undefined,
  json: boolean,
  yes: boolean,
): Promise<CommandResult> {
  if (rawPath === undefined || rawPath.trim() === '') {
    return reposError('Usage: florina repos remove <path> [--yes]', json);
  }
  // Confirm the target is actually watched before any consent prompt —
  // the daemon no-ops on unknown paths, which would make "stopped
  // watching" a lie. Send the stored spelling so the match is verbatim.
  const stored = await findStoredRoot(ctx, path.resolve(rawPath));
  if (!stored.ok) {
    return reposError('Could not check watched folders — daemon did not answer.', json);
  }
  if (stored.stored === undefined) {
    return reposError(`Not a watched folder: ${path.resolve(rawPath)}`, json);
  }
  const target = stored.stored;
  // Preflight: don't spend a consent moment on a dead daemon.
  if (!yes && (await ctx.deps.runner.status()).running !== true) {
    return reposError('Daemon is not running — nothing to remove it from right now.', json);
  }
  if (!yes && !(await confirmRemoval(target))) {
    return reposError(
      'Not confirmed — pass --yes to remove non-interactively (nothing changed).',
      json,
    );
  }
  const command: RemoveRepoRootCommand = { kind: 'remove-repo-root', path: target };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return reposError(`Failed to remove folder: ${errorOf(response)}`, json);
  }
  const r = response as ReposResponse;
  const roots = Array.isArray(r.roots?.roots) ? r.roots.roots : null;
  if (json) {
    return {
      exitCode: 0,
      message: `${JSON.stringify({ roots, removed: target })}\n`,
    };
  }
  const remaining = roots?.length ?? 0;
  return {
    exitCode: 0,
    message: `Stopped watching ${target} — ${remaining} folder${remaining === 1 ? '' : 's'} still watched.\n`,
  };
}

async function reposMove(
  ctx: CommandContext,
  rawPath: string | undefined,
  direction: string | undefined,
  json: boolean,
): Promise<CommandResult> {
  if (
    rawPath === undefined ||
    rawPath.trim() === '' ||
    (direction !== 'up' && direction !== 'down')
  ) {
    return reposError('Usage: florina repos move <path> up|down', json);
  }
  // move-repo-root no-ops on unknown paths — verify membership first so a
  // typo isn't reported as a successful reorder.
  const stored = await findStoredRoot(ctx, path.resolve(rawPath));
  if (!stored.ok) {
    return reposError('Could not check watched folders — daemon did not answer.', json);
  }
  if (stored.stored === undefined) {
    return reposError(`Not a watched folder: ${path.resolve(rawPath)}`, json);
  }
  const command: MoveRepoRootCommand = {
    kind: 'move-repo-root',
    path: stored.stored,
    direction,
  };
  const response = await sendCommand(ctx.deps.client, command);
  if (!response.ok) {
    return reposError(`Failed to reorder folder: ${errorOf(response)}`, json);
  }
  const r = response as ReposResponse;
  const roots = Array.isArray(r.roots?.roots) ? r.roots.roots : null;
  if (json) {
    return {
      exitCode: 0,
      message: `${JSON.stringify({ roots })}\n`,
    };
  }
  const order = (roots ?? []).map((root) => `  ${root.path}`).join('\n');
  return { exitCode: 0, message: `Watch order now:\n${order}\n` };
}

/* --- prune --- */
async function cmdPrune(ctx: CommandContext): Promise<CommandResult> {
  const [taskId] = ctx.args.positionals;
  if (!taskId) {
    return { exitCode: 1, message: 'Usage: florina prune <taskId>\n' };
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
  return { exitCode: 0, message: `florina ${VERSION}\n` };
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
      message: 'Daemon is not running. Start it first with `florina start` in another terminal.\n',
    };
  }

  try {
    // The voice session connects to the daemon's command API via the same
    // WebSocket client the CLI uses — including its local auth token (#118).
    const voiceClient = ctx.deps.client;

    // Create a minimal command API proxy that routes execute() calls over
    // the WebSocket client. The voice session calls this for each tool call
    // from the voice model.
    const commandApi: CommandExecutor = {
      async execute(command: Command) {
        return voiceClient.send(command);
      },
    };

    // DEC-034 / issue #73: heavyweight voice tools (research, ledger
    // notes, brief compilation) run in the Florina loop on a LiteLLM
    // proxy. Config comes from flags or FLORINA_LITELLM_* env vars;
    // when absent the async tools report "not wired" instead of hanging.
    const litellmUrl =
      typeof ctx.args.flags['litellm-url'] === 'string'
        ? ctx.args.flags['litellm-url']
        : process.env['FLORINA_LITELLM_URL'];
    const litellmModel =
      typeof ctx.args.flags['model'] === 'string'
        ? ctx.args.flags['model']
        : process.env['FLORINA_MODEL'];
    const litellmKey =
      typeof ctx.args.flags['litellm-key'] === 'string'
        ? ctx.args.flags['litellm-key']
        : process.env['FLORINA_LITELLM_KEY'];
    const litellm =
      typeof litellmUrl === 'string' && typeof litellmModel === 'string'
        ? {
            baseUrl: litellmUrl,
            model: litellmModel,
            ...(typeof litellmKey === 'string' ? { apiKey: litellmKey } : {}),
          }
        : undefined;

    const session = await ctx.deps.createVoiceSession({
      apiKey,
      commandApi,
      ...(litellm !== undefined ? { litellm } : {}),
    });

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
  | CatchUpResponse
  | ConfirmCatchUpResponse
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

  const args = parseArgs(argv, BOOLEAN_FLAGS);
  if (args.flags['no-color'] === true) {
    setColorEnabled(false);
  }

  // `version` and `help` don't need a client/runner.
  if (args.command === 'version') {
    out(`florina ${VERSION}\n`);
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
