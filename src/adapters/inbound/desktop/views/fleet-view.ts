/**
 * Fleet/quota view (issue #74): per-provider utilization, reset
 * countdowns, and parked tasks with resume times — the capacity
 * differentiator made visible.
 *
 * Pure view model + {@link RenderTree} template: the renderer gets a
 * serializable structure built from quota-ledger snapshots and the
 * parked-task list. No live services cross the IPC boundary — callers
 * pass snapshots (`ProviderStatus`, task snapshots).
 */
import type {
  ProviderQuotaState,
  QuotaWindow,
} from '../../../../core/application/ports/outbound/quota-reader.js';
import type { TaskSnapshot } from '../../../../core/application/use-cases/tasks/command-api.js';
import type { RenderTree } from './view-types.js';

/** Task-state values that mean "waiting on quota" in the fleet view. */
const PARKED_STATES: readonly string[] = ['blocked', 'attention-needed'];

/** One provider row in the fleet view. */
export interface ProviderView {
  readonly provider: string;
  readonly available: boolean;
  /** Earliest known quota reset (ISO), if the provider is exhausted. */
  readonly exhaustedUntil: string | null;
  /** Utilization bars, one per recorded window. */
  readonly windows: readonly QuotaWindowView[];
}

/** One quota window rendered as a labeled utilization bar. */
export interface QuotaWindowView {
  readonly window: string;
  /** Fraction consumed 0..1. */
  readonly usedPct: number;
  readonly status: QuotaWindow['status'];
  readonly resetsAt: string | null;
  /** ms until reset from `now`; null when unknown or already reset. */
  readonly resetsInMs: number | null;
}

/** A parked task waiting on provider capacity. */
export interface ParkedTaskView {
  readonly taskId: string;
  readonly objective: string;
  readonly state: string;
}

/** Full fleet/quota view data. */
export interface FleetViewData {
  readonly providers: readonly ProviderView[];
  readonly parkedTasks: readonly ParkedTaskView[];
  readonly generatedAt: string;
  readonly isEmpty: boolean;
}

/**
 * Build fleet view data from quota-ledger provider snapshots and the
 * task list. `now` drives reset countdowns deterministically.
 */
export function buildFleetView(input: {
  readonly providers: readonly ProviderQuotaState[];
  readonly tasks: readonly TaskSnapshot[];
  readonly now?: string;
}): FleetViewData {
  const nowMs = input.now !== undefined ? Date.parse(input.now) : Date.now();
  const providers = input.providers.map((p) => ({
    provider: p.provider,
    available: p.available,
    exhaustedUntil: p.exhaustedUntil,
    windows: p.windows.map((w) => toWindowView(w, nowMs)),
  }));
  const parkedTasks = input.tasks
    .filter((t) => PARKED_STATES.includes(t.state))
    .map((t) => ({ taskId: t.id, objective: t.objective, state: t.state }));
  return {
    providers,
    parkedTasks,
    generatedAt: new Date(nowMs).toISOString(),
    isEmpty: providers.length === 0 && parkedTasks.length === 0,
  };
}

function toWindowView(w: QuotaWindow, nowMs: number): QuotaWindowView {
  const resetMs = w.resetsAt !== null ? Date.parse(w.resetsAt) : null;
  const resetsInMs = resetMs !== null && resetMs > nowMs ? resetMs - nowMs : null;
  return {
    window: w.window,
    usedPct: w.usedPct,
    status: w.status,
    resetsAt: w.resetsAt,
    resetsInMs,
  };
}

/** Color token for a utilization level. */
function fillColor(usedPct: number): string {
  if (usedPct >= 0.9) return 'red';
  if (usedPct >= 0.75) return 'orange';
  if (usedPct >= 0.5) return 'amber';
  return 'green';
}

/** Human-readable countdown (e.g. `2h 14m`). */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** Render one provider row: status dot + utilization bars + reset. */
export function renderProviderRow(view: ProviderView): RenderTree {
  return el('ProviderRow', { provider: view.provider, available: view.available }, [
    el('ProviderHeader', { layout: 'row', gap: 'sm' }, [
      el('StatusDot', { color: view.available ? 'green' : 'red' }, []),
      el('ProviderName', {}, [view.provider]),
      view.exhaustedUntil !== null
        ? el('ResetBadge', { color: 'red' }, [`resets ${view.exhaustedUntil}`])
        : el('ResetBadge', { color: 'green' }, ['available']),
    ]),
    el(
      'WindowBars',
      {},
      view.windows.map((w) =>
        el('UtilizationBar', {
          label: w.window,
          pct: w.usedPct,
          color: fillColor(w.usedPct),
          status: w.status,
          resetIn: w.resetsInMs !== null ? formatCountdown(w.resetsInMs) : null,
        }),
      ),
    ),
  ]);
}

/** Render a parked task row with its blocked state. */
export function renderParkedTask(view: ParkedTaskView): RenderTree {
  return el('ParkedTask', { taskId: view.taskId, state: view.state, color: 'amber' }, [
    el('TaskObjective', {}, [view.objective]),
  ]);
}

/** Render the full fleet/quota panel. */
export function renderFleetView(view: FleetViewData): RenderTree {
  return el('FleetView', { generatedAt: view.generatedAt, empty: view.isEmpty }, [
    el('FleetSection', { title: 'Providers' }, view.providers.map(renderProviderRow)),
    el(
      'FleetSection',
      { title: 'Parked tasks' },
      view.parkedTasks.length > 0
        ? view.parkedTasks.map(renderParkedTask)
        : [el('EmptyHint', {}, ['no parked tasks'])],
    ),
  ]);
}
