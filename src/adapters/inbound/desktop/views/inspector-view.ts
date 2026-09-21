/**
 * Session inspector view (issue #126, mockup `docs/mockups/inspector.html`).
 *
 * Three-column progressive disclosure over the daemon's event journal:
 *
 *   tasks ──► event timeline ──► detail pane
 *
 * - Column 1 lists tasks; selecting one issues `inspect-task:<id>` which
 *   makes the app pull `query-events` and re-render.
 * - Column 2 is the journaled event timeline. `ContextCondensed` events
 *   render as one row — "N events condensed — expand" (DG-01: compression
 *   never hides; the journal keeps `forgottenEventIds`).
 * - Column 3 shows the selected event's observed payload verbatim plus a
 *   fidelity notice for D/E-tier sessions.
 *
 * Tier-aware per DEC-035: when `fidelityTier` is 'D' or 'E' the timeline
 * collapses to terminal + verification events only (verified output).
 *
 * Everything stays a {@link RenderTree}: string command identifiers, no
 * closures, JSON-serializable across the IPC boundary.
 */
import type { Event } from '../../../../core/domain/types.js';
import type { FailoverReason } from '../../../../core/domain/events.js';
import type { TaskSnapshot } from '../../../../core/application/use-cases/tasks/command-api.js';
import type { RenderTree } from './view-types.js';
import { renderProviderTransitionRow, currentProvider, priorProviders } from './provider-transition.js';

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** Fidelity tiers whose event fidelity is too weak for a raw timeline. */
const VERIFIED_ONLY_TIERS = new Set(['D', 'E']);

/** Event kinds that stay visible in verified-output-only mode. */
const TERMINAL_KINDS = new Set([
  'AgentStarted',
  'AgentCompleted',
  'AgentFailed',
  'AgentStopped',
  'VerificationObserved',
  'TestFinished',
  // A provider transition is a structural fact about the run, not raw
  // agent chatter — it stays visible even in verified-output-only mode.
  'TaskFailedOver',
]);

/** Inspector view input. */
export interface InspectorViewInput {
  /** All known tasks (column 1). */
  readonly tasks: readonly TaskSnapshot[];
  /** The task whose events are shown (column 2/3). */
  readonly selectedTaskId: string | null;
  /** Journaled events for the selected task, journal order. */
  readonly events: readonly Event[];
  /** Selected timeline row index (into {@link events}), or null. */
  readonly selectedEventIndex: number | null;
  /** Adapter fidelity tier of the selected task's session, when known. */
  readonly fidelityTier?: string;
}

/** Detail one-liner for a journaled event (payload fields only). */
function eventDetail(e: Event): string | undefined {
  const p = e.payload;
  for (const key of ['toolName', 'path', 'reason', 'summary', 'command', 'claim', 'message']) {
    const v = p[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function severityOf(kind: string): 'info' | 'warn' | 'error' | 'success' {
  if (kind === 'AgentFailed' || kind === 'AgentBlocked') return 'error';
  if (kind === 'ApprovalRequested' || kind === 'HumanInputRequested') return 'warn';
  if (kind === 'AgentCompleted' || kind === 'VerificationObserved' || kind === 'TestFinished') {
    return 'success';
  }
  return 'info';
}

function timeOf(e: Event): string {
  // Keep just HH:MM:SS when the timestamp is ISO-shaped.
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(e.timestamp);
  return m !== null ? m[1] : e.timestamp;
}

function renderTaskRow(task: TaskSnapshot, selected: boolean): RenderTree {
  const provider = currentProvider(task.agentIds);
  const prior = priorProviders(task.agentIds);
  return el(
    'InspRow',
    {
      command: `inspect-task:${task.id}`,
      selected,
      selectable: true,
      // Hover/expand target for prior providers + implicit transition
      // history (#202) — empty when the task never failed over.
      ...(prior.length > 0 ? { priorProviders: prior.join(', ') } : {}),
    },
    [
      el('InspRowTitle', {}, [task.objective]),
      el('InspRowSub', {}, [`${task.state}${provider !== '' ? ` · ${provider}` : ''}`]),
    ],
  );
}

/** Exported for reuse by History's journal search (issue #222) — same row shape everywhere an event appears. */
export function renderTimelineRow(e: Event, index: number, selected: boolean): RenderTree {
  if (e.kind === 'TaskFailedOver') {
    return renderProviderTransitionRow(
      {
        fromProvider: String(e.payload['fromProvider'] ?? '?'),
        toProvider: String(e.payload['toProvider'] ?? '?'),
        reason: (e.payload['reason'] as FailoverReason | undefined) ?? 'error',
      },
      timeOf(e),
      { command: `inspect-event:${index}`, selected },
    );
  }
  if (e.kind === 'ContextCondensed') {
    const forgotten = e.payload['forgottenEventIds'];
    const n = Array.isArray(forgotten) ? forgotten.length : 0;
    return el(
      'InspRow',
      { command: `inspect-event:${index}`, selected, selectable: true, muted: true },
      [
        el('InspRowTitle', {}, [`▸ ${n} events condensed`]),
        el('InspRowSub', {}, [`${timeOf(e)} · expand — nothing discarded`]),
      ],
    );
  }
  const detail = eventDetail(e);
  return el('InspRow', { command: `inspect-event:${index}`, selected, selectable: true }, [
    el('InspRowTitle', { color: severityOf(e.kind) }, [e.kind]),
    el('InspRowSub', {}, [`${timeOf(e)}${detail !== undefined ? ` · ${detail}` : ''}`]),
  ]);
}

function renderDetail(e: Event | null, tier: string | undefined): RenderTree {
  if (e === null) {
    return el('InspectorCol', { title: 'Detail' }, [
      el('InspRow', { muted: true }, [el('InspRowSub', {}, ['select an event'])]),
    ]);
  }
  const lines: string[] = [`${e.kind}`, '', `task ${e.taskId} · session ${e.sessionId}`];
  const entries = Object.entries(e.payload);
  if (entries.length > 0) {
    lines.push('');
    for (const [k, v] of entries) {
      lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  lines.push('', `observed · from event journal · ${e.timestamp}`);
  const children: (RenderTree | string)[] = [
    ...(tier !== undefined && VERIFIED_ONLY_TIERS.has(tier)
      ? [el('FidelityNotice', {}, [`tier ${tier} — verified output only`])]
      : []),
    el('DetailMono', {}, [lines.join('\n')]),
  ];
  return el('InspectorCol', { title: `Detail — ${e.kind}` }, children);
}

/**
 * Render the three-column session inspector.
 */
export function renderInspectorView(input: InspectorViewInput): RenderTree {
  const tier = input.fidelityTier;
  const verifiedOnly = tier !== undefined && VERIFIED_ONLY_TIERS.has(tier);
  const rows = input.events
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e }) => !verifiedOnly || TERMINAL_KINDS.has(e.kind) || e.kind === 'ContextCondensed',
    );

  const selected =
    input.selectedEventIndex !== null && input.selectedEventIndex < input.events.length
      ? input.events[input.selectedEventIndex]
      : null;

  return el('Inspector', { taskId: input.selectedTaskId ?? '' }, [
    el('InspectorCol', { title: 'Tasks' }, [
      ...(input.tasks.length === 0
        ? [el('InspRow', { muted: true }, [el('InspRowSub', {}, ['no tasks yet'])])]
        : input.tasks.map((t) => renderTaskRow(t, t.id === input.selectedTaskId))),
    ]),
    el('InspectorCol', { title: 'Event timeline' }, [
      ...(input.selectedTaskId === null
        ? [el('InspRow', { muted: true }, [el('InspRowSub', {}, ['select a task'])])]
        : rows.length === 0
          ? [el('InspRow', { muted: true }, [el('InspRowSub', {}, ['no events journaled'])])]
          : rows.map(({ e, i }) => renderTimelineRow(e, i, i === input.selectedEventIndex))),
    ]),
    renderDetail(selected, tier),
  ]);
}
