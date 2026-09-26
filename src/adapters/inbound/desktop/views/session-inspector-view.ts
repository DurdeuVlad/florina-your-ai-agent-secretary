/**
 * Session/agent inspector (issue #74): a SupervisorEvent timeline with
 * progressive disclosure — timeline → transcript → diff — tier-aware
 * (A/B tiers get the structured transcript; D/E surface only verified
 * output, since their event fidelity is weaker).
 *
 * Pure view model + {@link RenderTree} template over journaled
 * {@link SupervisorEvent}s.
 */
import type { SupervisorEvent } from '../../../../core/domain/events.js';
import type { AdapterFidelityTier } from '../../../../core/domain/enums.js';
import type { RenderTree } from './view-types.js';

/** Display section of the inspector. */
export type InspectorSection = 'timeline' | 'transcript' | 'diff';

/** One row in the event timeline. */
export interface TimelineEntryView {
  readonly index: number;
  readonly type: string;
  readonly timestamp: string;
  /** One-line detail (tool name, file path, reason, …). */
  readonly detail?: string;
  /** Severity hint for the row color. */
  readonly severity: 'info' | 'warn' | 'error' | 'success';
}

/** A transcript line (agent message, tool call, or verification note). */
export interface TranscriptLineView {
  readonly speaker: 'agent' | 'tool' | 'system';
  readonly text: string;
  readonly timestamp: string;
}

/** A file-change reference for the diff section. */
export interface DiffRefView {
  readonly path: string;
  readonly changeType?: string;
}

/** Full inspector view data. */
export interface SessionInspectorData {
  readonly sessionId: string;
  readonly fidelityTier: AdapterFidelityTier;
  /** True for D/E tiers — only verified output is trustworthy. */
  readonly verifiedOutputOnly: boolean;
  readonly timeline: readonly TimelineEntryView[];
  readonly transcript: readonly TranscriptLineView[];
  readonly diffs: readonly DiffRefView[];
  readonly terminalState?: 'completed' | 'failed' | 'stopped';
}

/** Whether the event's JSON payload has a usable string field. */
function str(e: SupervisorEvent, key: string): string | undefined {
  const v = (e as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function severityOf(type: string): TimelineEntryView['severity'] {
  if (type === 'AgentFailed' || type === 'AgentBlocked') return 'error';
  if (type === 'ApprovalRequested' || type === 'HumanInputRequested') return 'warn';
  if (type === 'AgentCompleted' || type === 'VerificationObserved') return 'success';
  return 'info';
}

/**
 * Build the inspector view. `sessionId` labels the panel; events should
 * already be journal-ordered. Tier D/E sessions collapse to
 * verified-output-only mode: the transcript section is suppressed and
 * the timeline only keeps terminal + verification events.
 */
export function buildSessionInspector(input: {
  readonly sessionId: string;
  readonly fidelityTier: AdapterFidelityTier;
  readonly events: readonly SupervisorEvent[];
}): SessionInspectorData {
  const verifiedOnly = input.fidelityTier === 'D' || input.fidelityTier === 'E';
  const timelineSource = verifiedOnly
    ? input.events.filter((e) =>
        [
          'AgentStarted',
          'AgentCompleted',
          'AgentFailed',
          'AgentStopped',
          'VerificationObserved',
          'TestFinished',
        ].includes(e.type),
      )
    : input.events;

  const timeline = timelineSource.map((e, index) => ({
    index,
    type: e.type,
    timestamp: e.timestamp,
    detail:
      str(e, 'toolName') ??
      str(e, 'path') ??
      str(e, 'reason') ??
      str(e, 'summary') ??
      str(e, 'objective'),
    severity: severityOf(e.type),
  }));

  const transcript: TranscriptLineView[] = verifiedOnly
    ? []
    : input.events.flatMap((e): TranscriptLineView[] => {
        const message = str(e, 'message') ?? str(e, 'detail');
        if (e.type === 'AgentProgress' && message !== undefined) {
          return [{ speaker: 'agent', text: message, timestamp: e.timestamp }];
        }
        if (e.type === 'ToolStarted') {
          return [
            {
              speaker: 'tool',
              text: `→ ${str(e, 'toolName') ?? 'tool'}`,
              timestamp: e.timestamp,
            },
          ];
        }
        if (e.type === 'VerificationObserved') {
          return [
            {
              speaker: 'system',
              text: `verified: ${str(e, 'claim') ?? str(e, 'method') ?? 'evidence observed'}`,
              timestamp: e.timestamp,
            },
          ];
        }
        return [];
      });

  const diffs = input.events
    .filter((e) => e.type === 'FileChanged')
    .map((e) => ({
      path: str(e, 'path') ?? 'unknown',
      ...(str(e, 'changeType') !== undefined ? { changeType: str(e, 'changeType') } : {}),
    }));

  const last = input.events[input.events.length - 1];
  const terminalState =
    last?.type === 'AgentCompleted'
      ? 'completed'
      : last?.type === 'AgentFailed'
        ? 'failed'
        : last?.type === 'AgentStopped'
          ? 'stopped'
          : undefined;

  return {
    sessionId: input.sessionId,
    fidelityTier: input.fidelityTier,
    verifiedOutputOnly: verifiedOnly,
    timeline,
    transcript,
    diffs,
    ...(terminalState !== undefined ? { terminalState } : {}),
  };
}

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** Render one timeline row. */
export function renderTimelineEntry(view: TimelineEntryView): RenderTree {
  const color = { info: 'slate', warn: 'amber', error: 'red', success: 'green' }[view.severity];
  return el('TimelineEntry', { index: view.index, severity: view.severity }, [
    el('Timestamp', { color: 'slate' }, [view.timestamp]),
    el('EventType', { color }, [view.type]),
    ...(view.detail !== undefined ? [el('EventDetail', {}, [view.detail])] : []),
  ]);
}

/** Render one transcript line. */
export function renderTranscriptLine(view: TranscriptLineView): RenderTree {
  const color = { agent: 'blue', tool: 'amber', system: 'slate' }[view.speaker];
  return el('TranscriptLine', { speaker: view.speaker }, [
    el('SpeakerBadge', { color }, [view.speaker]),
    el('LineText', {}, [view.text]),
  ]);
}

/**
 * Render the full inspector: timeline → transcript → diff sections
 * with progressive disclosure (each section collapsible). D/E-tier
 * sessions render a fidelity notice and verified output only.
 */
export function renderSessionInspector(view: SessionInspectorData): RenderTree {
  return el(
    'SessionInspector',
    {
      sessionId: view.sessionId,
      tier: view.fidelityTier,
      ...(view.terminalState !== undefined ? { terminal: view.terminalState } : {}),
    },
    [
      ...(view.verifiedOutputOnly
        ? [
            el('FidelityNotice', { color: 'amber' }, [
              `tier ${view.fidelityTier} — verified output only`,
            ]),
          ]
        : []),
      el(
        'InspectorSection',
        { title: 'Timeline', collapsible: true, expanded: true },
        view.timeline.map(renderTimelineEntry),
      ),
      ...(view.transcript.length > 0
        ? [
            el(
              'InspectorSection',
              { title: 'Transcript', collapsible: true, expanded: false },
              view.transcript.map(renderTranscriptLine),
            ),
          ]
        : []),
      ...(view.diffs.length > 0
        ? [
            el(
              'InspectorSection',
              { title: 'Files changed', collapsible: true, expanded: false },
              view.diffs.map((d) =>
                el('DiffRef', { path: d.path, changeType: d.changeType ?? 'modified' }),
              ),
            ),
          ]
        : []),
    ],
  );
}
