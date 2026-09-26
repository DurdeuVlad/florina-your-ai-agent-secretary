/**
 * Florina view (issue #74): the Florina's own working state —
 * her plan/todo list, in-flight research, and pending memory writes.
 * A transparency panel, not a control surface.
 *
 * Pure view model + {@link RenderTree} template over a serializable
 * {@link FlorinaSnapshot} (the daemon projects live loop state into
 * this shape for the wire).
 */
import type {
  TodoItem,
  TodoStatus,
} from '../../../../core/application/use-cases/florina/todo-tool.js';
import type { RenderTree } from './view-types.js';

/** A research pass the Florina is running in the background. */
export interface ResearchJobView {
  readonly id: string;
  readonly query: string;
  readonly startedAt: string;
  /** Optional idea ledger the findings append to. */
  readonly ideaId?: string;
}

/** A durable fact the Florina intends to persist (e.g. a preference). */
export interface PendingMemoryView {
  readonly id: string;
  readonly summary: string;
  /** Capsule/scope the write targets (e.g. 'user', 'project:x'). */
  readonly scope: string;
}

/** The wire shape the daemon produces for this view. */
export interface FlorinaSnapshot {
  readonly todos: readonly TodoItem[];
  readonly research: readonly ResearchJobView[];
  readonly pendingMemories: readonly PendingMemoryView[];
}

/** Full Florina view data. */
export interface FlorinaViewData {
  readonly todos: readonly TodoItem[];
  readonly research: readonly ResearchJobView[];
  readonly pendingMemories: readonly PendingMemoryView[];
  readonly isEmpty: boolean;
}

/** Display metadata per todo status. */
export const TODO_STATUS_METADATA: Readonly<Record<TodoStatus, { icon: string; color: string }>> = {
  pending: { icon: 'circle', color: 'slate' },
  in_progress: { icon: 'spinner', color: 'blue' },
  completed: { icon: 'check', color: 'green' },
};

/** Build the view from a Florina snapshot. */
export function buildFlorinaView(snapshot: FlorinaSnapshot): FlorinaViewData {
  return {
    todos: snapshot.todos,
    research: snapshot.research,
    pendingMemories: snapshot.pendingMemories,
    isEmpty:
      snapshot.todos.length === 0 &&
      snapshot.research.length === 0 &&
      snapshot.pendingMemories.length === 0,
  };
}

function el(
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly (RenderTree | string)[],
): RenderTree {
  return { tag, props, children };
}

/** Render one todo row. */
export function renderTodoRow(todo: TodoItem): RenderTree {
  const meta = TODO_STATUS_METADATA[todo.status];
  return el('TodoRow', { todoId: todo.id, status: todo.status }, [
    el('Icon', { name: meta.icon, color: meta.color }, []),
    el('TodoText', { done: todo.status === 'completed' }, [todo.content]),
  ]);
}

/** Render one in-flight research job. */
export function renderResearchJob(job: ResearchJobView): RenderTree {
  return el('ResearchJob', { jobId: job.id, startedAt: job.startedAt }, [
    el('Icon', { name: 'search', color: 'blue' }, []),
    el('ResearchQuery', {}, [job.query]),
    ...(job.ideaId !== undefined
      ? [el('ResearchTarget', { color: 'slate' }, [`→ ${job.ideaId}`])]
      : []),
  ]);
}

/** Render one pending memory write. */
export function renderPendingMemory(mem: PendingMemoryView): RenderTree {
  return el('PendingMemory', { memoryId: mem.id, scope: mem.scope }, [
    el('Icon', { name: 'memory', color: 'amber' }, []),
    el('MemorySummary', {}, [mem.summary]),
    el('MemoryScope', { color: 'slate' }, [mem.scope]),
  ]);
}

/** Render the full Florina panel. */
export function renderFlorinaView(view: FlorinaViewData): RenderTree {
  return el('FlorinaView', { empty: view.isEmpty }, [
    el(
      'FlorinaSection',
      { title: 'Plan' },
      view.todos.length > 0
        ? view.todos.map(renderTodoRow)
        : [el('EmptyHint', {}, ['no plan yet'])],
    ),
    el(
      'FlorinaSection',
      { title: 'Research in flight' },
      view.research.length > 0
        ? view.research.map(renderResearchJob)
        : [el('EmptyHint', {}, ['idle'])],
    ),
    el(
      'FlorinaSection',
      { title: 'Pending memory writes' },
      view.pendingMemories.length > 0
        ? view.pendingMemories.map(renderPendingMemory)
        : [el('EmptyHint', {}, ['none'])],
    ),
  ]);
}
