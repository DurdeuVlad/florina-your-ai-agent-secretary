/**
 * Terminal output formatters for the `florina` / `flor` CLI (#20, DEC-026).
 *
 * Each formatter turns a typed response payload (from the typed command API,
 * issue #19) into a human-readable, scannable string suitable for a terminal.
 * The tone follows PRODUCT_DESIGN.md "Visual Experience": terse, factual,
 * scannable. ANSI colors are used sparingly — only for priority indicators
 * and status emphasis — so output stays readable in headless CI/SSH
 * environments (DEC-008).
 *
 * Color support is gated on `supportsColor()` so piping output to a file or
 * running in a non-TTY environment produces plain text.
 */
import type {
  AttentionItemSnapshot,
  TaskSnapshot,
} from '../../../core/application/use-cases/tasks/command-api.js';
import type { MetricsSnapshot } from '../../../core/application/use-cases/metrics.js';
import { checkSupervisionCostDiscipline } from '../../../core/application/use-cases/metrics.js';
import type { CompletionDigest } from '../../../core/application/use-cases/attention/completion-digest.js';
import type { ContextHealthSnapshot } from '../../../core/application/use-cases/context/context-health-monitor.js';
import type { CatchUpDigest } from '../../../core/application/use-cases/resumption/catchup-digest.js';
import type {
  ChatModelStatusView,
  ProviderStatusView,
} from '../../../core/application/use-cases/tasks/command-api.js';

/* ------------------------------------------------------------------ *
 * ANSI color helpers (sparing usage per PRODUCT_DESIGN.md tone)
 * ------------------------------------------------------------------ */

/** Whether ANSI color codes should be emitted. */
let colorEnabled = detectColorSupport();

/**
 * Detect whether the current stdout supports ANSI color. Overridable via
 * `setColorEnabled` for tests and forced plain-text mode.
 */
function detectColorSupport(): boolean {
  return process.stdout.isTTY === true;
}

/**
 * Force-enable or force-disable ANSI color output. Useful for tests and for
 * respecting a `--no-color` flag.
 */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

/** Whether color output is currently enabled. */
export function isColorEnabled(): boolean {
  return colorEnabled;
}

/** Wrap text in an ANSI color escape when color is enabled. */
function color(code: string, text: string): string {
  if (!colorEnabled) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const RED = (t: string): string => color('31', t);
const YELLOW = (t: string): string => color('33', t);
const GREEN = (t: string): string => color('32', t);
const CYAN = (t: string): string => color('36', t);
const GRAY = (t: string): string => color('90', t);
const BOLD = (t: string): string => color('1', t);

/* ------------------------------------------------------------------ *
 * Priority formatting
 * ------------------------------------------------------------------ */

/** Map an attention-item priority string to a colorized label. */
export function formatPriority(priority: string): string {
  switch (priority) {
    case 'Critical':
      return RED(BOLD(priority));
    case 'High':
      return YELLOW(priority);
    case 'Medium':
      return CYAN(priority);
    case 'Low':
      return GRAY(priority);
    default:
      return priority;
  }
}

/* ------------------------------------------------------------------ *
 * Inbox formatting
 * ------------------------------------------------------------------ */

/**
 * Format a list of attention inbox items into a scannable terminal view.
 *
 * Items are grouped by priority (Critical > High > Medium > Low) and rendered
 * one per line with the task id, kind, and a short payload summary. Matches
 * the PRODUCT_DESIGN.md "Visual Experience" inbox tone.
 */
export function formatInbox(items: readonly AttentionItemSnapshot[]): string {
  if (items.length === 0) {
    return 'Inbox is empty. Nothing needs your attention right now.\n';
  }

  const order = ['Critical', 'High', 'Medium', 'Low'] as const;
  const groups = new Map<string, AttentionItemSnapshot[]>();
  for (const item of items) {
    const bucket = groups.get(item.priority) ?? [];
    bucket.push(item);
    groups.set(item.priority, bucket);
  }

  const lines: string[] = [];
  for (const priority of order) {
    const bucket = groups.get(priority);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`${formatPriority(priority).padEnd(10)} ${bucket.length}`);
    for (const item of bucket) {
      const summary = inboxItemSummary(item);
      lines.push(`  ${item.id}  ${item.taskId}  ${item.kind}`);
      if (summary) lines.push(`    ${GRAY(summary)}`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

/** Build a short one-line summary from an item's payload, if available. */
function inboxItemSummary(item: AttentionItemSnapshot): string {
  const p = item.payload;
  if (typeof p === 'object' && p !== null) {
    const reason = p['reason'];
    const message = p['message'];
    const capability = p['capability'];
    if (typeof reason === 'string' && reason) return reason;
    if (typeof message === 'string' && message) return message;
    if (typeof capability === 'string' && capability) return `capability: ${capability}`;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Task formatting
 * ------------------------------------------------------------------ */

/** Format a single task snapshot for `florina task <id>`. */
export function formatTask(task: TaskSnapshot): string {
  const lines: string[] = [];
  lines.push(`${BOLD('Task')} ${task.id}`);
  lines.push(`  state:    ${formatTaskState(task.state)}`);
  lines.push(`  project:  ${task.projectId}`);
  lines.push(`  objective: ${task.objective}`);
  lines.push(`  agents:   ${task.agentIds.length ? task.agentIds.join(', ') : '—'}`);
  lines.push(`  sessions: ${task.sessionIds.length}`);
  lines.push(`  events:   ${task.eventCount}`);
  if (task.worktreePath) {
    lines.push(`  worktree: ${task.worktreePath}`);
  }
  lines.push(`  created:  ${task.createdAt}`);
  lines.push(`  updated:  ${task.updatedAt}`);
  return lines.join('\n') + '\n';
}

/** Format a compact task list for `florina tasks`. */
export function formatTaskList(tasks: readonly TaskSnapshot[]): string {
  if (tasks.length === 0) {
    return 'No tasks found.\n';
  }
  const lines: string[] = [];
  lines.push(`${'ID'.padEnd(24)} ${'STATE'.padEnd(16)} ${'OBJECTIVE'}`);
  lines.push(`${'-'.repeat(24)} ${'-'.repeat(16)} ${'-'.repeat(40)}`);
  for (const t of tasks) {
    const objective = t.objective.length > 40 ? t.objective.slice(0, 37) + '…' : t.objective;
    lines.push(`${t.id.padEnd(24)} ${formatTaskState(t.state).padEnd(16)} ${objective}`);
  }
  return lines.join('\n') + '\n';
}

/** Colorize a task state label. */
function formatTaskState(state: string): string {
  switch (state) {
    case 'running':
      return GREEN(state);
    case 'attention-needed':
    case 'blocked':
      return YELLOW(state);
    case 'failed':
      return RED(state);
    case 'completed':
    case 'reviewed':
    case 'accepted':
      return CYAN(state);
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ *
 * Completion digest formatting
 * ------------------------------------------------------------------ */

/** Format a completion digest for `florina digest <taskId>`. */
export function formatDigest(digest: CompletionDigest): string {
  const lines: string[] = [];
  lines.push(`${BOLD('Completion Digest')} — task ${digest.taskId}`);
  lines.push(`  session:   ${digest.sessionId}`);
  lines.push(`  agent:     ${digest.agentId}`);
  lines.push(`  started:   ${digest.startedAt}`);
  lines.push(`  completed: ${digest.completedAt}`);
  lines.push(`  duration:  ${formatDuration(digest.duration)}`);
  lines.push('');
  lines.push(`${BOLD('Summary')}`);
  lines.push(`  ${digest.summary}`);
  lines.push('');
  lines.push(`${BOLD('Observed')}`);
  lines.push(`  files changed: ${digest.filesChangedCount}`);
  if (digest.filesChanged.length > 0) {
    for (const f of digest.filesChanged.slice(0, 20)) {
      lines.push(`    ${f}`);
    }
    if (digest.filesChanged.length > 20) {
      lines.push(`    … and ${digest.filesChanged.length - 20} more`);
    }
  }
  lines.push(
    `  tests: ${digest.testsPassed}/${digest.testsRun} passed` +
      (digest.testsFailed > 0 ? `, ${RED(String(digest.testsFailed))} failed` : ''),
  );
  lines.push(
    `  approvals: ${digest.approvalsRequested} requested` +
      ` (${digest.approvalsGranted} granted, ${digest.approvalsDenied} denied)`,
  );
  if (digest.commitHash) lines.push(`  commit: ${digest.commitHash}`);
  if (digest.branchName) lines.push(`  branch: ${digest.branchName}`);

  if (digest.decisions.length > 0) {
    lines.push('');
    lines.push(`${BOLD('Decision references')}`);
    for (const d of digest.decisions) {
      lines.push(`  ${d.id}: ${d.note}`);
    }
  }

  if (digest.riskHighlights.length > 0) {
    lines.push('');
    lines.push(`${BOLD('Risk highlights')}`);
    for (const r of digest.riskHighlights) {
      lines.push(`  ${YELLOW('!')} [${r.kind}] ${r.message}`);
    }
  }

  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Catch-up digest formatting (DEC-042, issue #217)
 * ------------------------------------------------------------------ */

/**
 * Format a catch-up digest for `florina catchup`. Follows §9's shape: N
 * notable / M running / K pending, one line per item, then an explicit
 * "nothing else needs you" close when the digest is empty.
 */
export function formatCatchUp(digest: CatchUpDigest): string {
  if (digest.isEmpty) {
    return `${BOLD('Since you were last active:')}\n\nNothing needs you.\n`;
  }

  const lines: string[] = [];
  lines.push(
    `${BOLD('Since you were last active:')} ${digest.notable.length} notable, ` +
      `${digest.stillRunning.length} still running, ${digest.pendingAttention.length} need your attention.`,
  );

  if (digest.notable.length > 0) {
    lines.push('');
    lines.push(BOLD('Notable:'));
    for (const t of digest.notable) {
      lines.push(`  [${t.state}] ${t.objective} (${t.taskId})`);
    }
  }

  if (digest.stillRunning.length > 0) {
    lines.push('');
    lines.push(BOLD('Still running:'));
    for (const t of digest.stillRunning) {
      lines.push(`  ${t.objective} (${t.taskId})`);
    }
  }

  if (digest.pendingAttention.length > 0) {
    lines.push('');
    lines.push(BOLD('Needs your decision:'));
    for (const item of digest.pendingAttention) {
      lines.push(`  [${item.priority}] ${item.kind} — task ${item.taskId}`);
    }
  }

  if (digest.failovers.length > 0) {
    lines.push('');
    lines.push(BOLD('Provider failovers:'));
    for (const f of digest.failovers) {
      lines.push(`  task ${f.taskId}: ${f.fromProvider} -> ${f.toProvider} (${f.reason})`);
    }
  }

  lines.push('');
  lines.push('Nothing else needs you.');
  return lines.join('\n') + '\n';
}

/** Format a duration in milliseconds as a compact human string. */
function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSec}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

/* ------------------------------------------------------------------ *
 * Metrics formatting
 * ------------------------------------------------------------------ */

/** Format a metrics snapshot for `florina metrics`. */
export function formatMetrics(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  lines.push(`${BOLD('Metrics Snapshot')} — ${snapshot.timestamp}`);
  lines.push('');
  lines.push(`${BOLD('Counters')}`);
  const c = snapshot.counters;
  lines.push(`  tasks started:   ${c.tasksStarted}`);
  lines.push(`  tasks completed: ${c.tasksCompleted}`);
  lines.push(`  tasks failed:    ${c.tasksFailed}`);
  lines.push(`  approvals req:   ${c.approvalsRequested}`);
  lines.push(`  approvals granted: ${c.approvalsGranted}`);
  lines.push(`  approvals denied:  ${c.approvalsDenied}`);
  const eventTypes = Object.keys(c.eventsEmitted);
  if (eventTypes.length > 0) {
    lines.push(`  events emitted:`);
    for (const type of eventTypes.sort()) {
      lines.push(`    ${type}: ${c.eventsEmitted[type]}`);
    }
  }
  const tools = Object.keys(c.toolsInvoked);
  if (tools.length > 0) {
    lines.push(`  tools invoked:`);
    for (const t of tools.sort()) {
      lines.push(`    ${t}: ${c.toolsInvoked[t]}`);
    }
  }

  lines.push('');
  lines.push(`${BOLD('Gauges')}`);
  const g = snapshot.gauges;
  lines.push(`  active sessions:       ${g.activeSessions}`);
  lines.push(`  pending approvals:     ${g.pendingApprovals}`);
  lines.push(`  inbox size:            ${g.inboxSize}`);
  lines.push(`  attention items pending: ${g.attentionItemsPending}`);

  lines.push('');
  lines.push(`${BOLD('Histograms')}`);
  const h = snapshot.histograms;
  lines.push(`  task duration:          ${histSummary(h.taskDuration)}`);
  lines.push(`  approval response time: ${histSummary(h.approvalResponseTime)}`);
  lines.push(`  tool duration:          ${histSummary(h.toolDuration)}`);

  lines.push('');
  lines.push(`${BOLD('Supervision cost')} (§7 model calls per stage)`);
  const sc = snapshot.supervisionCost;
  lines.push(`  L1 classification:      ${sc.modelCallsByStage['l1-classification']}`);
  lines.push(`  Execution Brief compile: ${sc.modelCallsByStage['execution-brief-compile']}`);
  lines.push(`  L2 manager reasoning:    ${sc.modelCallsByStage['l2-manager-reasoning']}`);
  lines.push(`  L3 Florina reasoning:    ${sc.modelCallsByStage['l3-florina-reasoning']}`);
  const costCheck = checkSupervisionCostDiscipline(snapshot);
  if (!costCheck.ok) {
    lines.push(`  ${RED('!')} ${costCheck.reason}`);
  }

  return lines.join('\n') + '\n';
}

/** One-line histogram summary: count, mean, min, max. */
function histSummary(h: { count: number; mean: number; min: number; max: number }): string {
  if (h.count === 0) return 'no observations';
  return `n=${h.count} mean=${formatDuration(h.mean)} min=${formatDuration(h.min)} max=${formatDuration(h.max)}`;
}

/* ------------------------------------------------------------------ *
 * Status formatting
 * ------------------------------------------------------------------ */

/** Format a daemon status line. */
export function formatStatus(running: boolean, port: number, pid?: number): string {
  if (running) {
    const pidPart = pid !== undefined ? ` (pid ${pid})` : '';
    return `${GREEN('running')} on port ${port}${pidPart}\n`;
  }
  return `${GRAY('stopped')} — daemon is not running\n`;
}

/**
 * Format per-agent context health (DEC-035, issue #77).
 *
 * Each line shows the agent, status, and estimated window fill. A
 * degraded/critical agent is a liveness-adjacent risk — the fill is the
 * signal that a condensation or failover may be due.
 */
export function formatContextHealth(snapshots: readonly ContextHealthSnapshot[]): string {
  if (snapshots.length === 0) {
    return `  ${GRAY('context health: no agents tracked')}\n`;
  }
  const statusColor = (s: ContextHealthSnapshot['status']): ((t: string) => string) =>
    s === 'critical' ? RED : s === 'degraded' ? YELLOW : GREEN;
  const lines = ['  context health:'];
  for (const s of snapshots) {
    const fill = `${Math.round(s.windowFillPct * 100)}%`;
    const condense =
      s.condensationCount > 0 && s.lastCondensationAt !== undefined
        ? `, last condensed ${s.lastCondensationAt}`
        : ', never condensed';
    lines.push(`    ${s.agentId}: ${statusColor(s.status)(s.status)} (fill ${fill}${condense})`);
  }
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * Provider readiness formatting (issue #294)
 * ------------------------------------------------------------------ */

/** Plain-language label for a provider auth state — never the enum verbatim. */
function authStateLabel(state: string | undefined): { text: string; color: (t: string) => string } {
  switch (state) {
    case 'signed-in':
      return { text: 'signed in (stored credentials found)', color: GREEN };
    case 'found-not-signed-in':
      return { text: 'installed but not signed in', color: YELLOW };
    case 'auth-failing':
      return { text: 'sign-in is failing', color: RED };
    default:
      return { text: 'sign-in unknown', color: GRAY };
  }
}

/**
 * Format provider + chat-model readiness lines for `florina status` and
 * `florina auth` (issue #294). Rows that need action name the next step;
 * rows with nothing actionable stay terse. `probed: false` reports the
 * probe never ran rather than implying an empty world.
 */
export function formatProviderReadiness(
  providers: readonly ProviderStatusView[],
  probed: boolean,
  chatModel: ChatModelStatusView | undefined,
): string {
  const lines: string[] = ['  providers:'];
  if (!probed) {
    lines.push(`    ${GRAY('provider check did not run on this daemon')}`);
  } else if (providers.length === 0) {
    lines.push(`    ${GRAY('none found — install a supported provider CLI')}`);
  } else {
    for (const p of providers) {
      if (!p.found) {
        const installHint =
          p.installable === true ? ` ${GRAY(`— fix: florina install ${p.id}`)}` : '';
        lines.push(
          `    ${p.id}: ${GRAY('not installed')} ${GRAY(`— ${p.detail ?? ''}`)}${installHint}`,
        );
        continue;
      }
      const { text, color } = authStateLabel(p.auth);
      const hint =
        p.fix !== undefined
          ? ` — fix: ${
              // run-command: the CLI verb does it. store-key/set-env:
              // the label names the action (`Set GOOGLE_CLOUD_PROJECT`).
              p.fix.kind === 'run-command' && p.fix.command !== undefined
                ? `florina auth ${p.id}`
                : p.fix.label
            }`
          : '';
      // Show the classified failure detail whenever one stands — a 429 or
      // ENOTFOUND on an `unknown` row is still real information, not noise.
      const detail =
        p.auth !== 'signed-in' && p.authDetail !== undefined
          ? ` (${p.authDetail.slice(0, 120)})`
          : '';
      lines.push(`    ${p.id}: ${color(text)}${detail}${hint}`);
    }
  }
  if (chatModel !== undefined) {
    const source =
      ({ env: 'env var', vault: 'key vault', none: 'no key' } as Record<string, string>)[
        chatModel.keySource
      ] ?? chatModel.keySource;
    const state =
      chatModel.state === 'ok'
        ? GREEN('working')
        : chatModel.state === 'auth-failing'
          ? RED('sign-in is failing')
          : chatModel.state === 'misconfigured'
            ? YELLOW('missing a setting')
            : chatModel.state === 'unreachable'
              ? YELLOW('unreachable')
              : chatModel.state === 'unconfigured'
                ? GRAY('not configured')
                : GRAY('untested');
    const fix =
      // A working keyless model (unauthenticated local LiteLLM) is not
      // broken — don't nag for a key it doesn't need. A misconfigured
      // model needs the env var the detail names, not a key.
      chatModel.state !== 'ok' &&
      (chatModel.state === 'auth-failing' || chatModel.keySource === 'none')
        ? ` ${GRAY('— fix: florina auth chat-model')}`
        : chatModel.state === 'misconfigured'
          ? ` ${GRAY('— fix: the error names the missing setting')}`
          : '';
    // The classified failure detail is what actually tells the user
    // what broke — render it so hints like "the error names the
    // missing setting" aren't a dangling pointer.
    const detail =
      chatModel.state !== 'ok' && chatModel.detail !== undefined
        ? `\n    ${GRAY(chatModel.detail.slice(0, 160))}`
        : '';
    lines.push(`  chat model: ${state} (${source})${fix}${detail}`);
  }
  return `${lines.join('\n')}\n`;
}
