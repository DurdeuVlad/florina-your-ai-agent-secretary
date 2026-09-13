/**
 * Terminal output formatters for the `secretary` / `asec` CLI (#20, DEC-026).
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
import type { CompletionDigest } from '../../../core/application/use-cases/attention/completion-digest.js';

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

/** Format a single task snapshot for `secretary task <id>`. */
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

/** Format a compact task list for `secretary tasks`. */
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

/** Format a completion digest for `secretary digest <taskId>`. */
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
  lines.push(`  tests: ${digest.testsPassed}/${digest.testsRun} passed` +
    (digest.testsFailed > 0 ? `, ${RED(String(digest.testsFailed))} failed` : ''));
  lines.push(`  approvals: ${digest.approvalsRequested} requested` +
    ` (${digest.approvalsGranted} granted, ${digest.approvalsDenied} denied)`);
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

/** Format a metrics snapshot for `secretary metrics`. */
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
