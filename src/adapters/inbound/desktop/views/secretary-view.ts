/**
 * Secretary view (issue #74): the Secretary's own working state —
 * her plan/todo list, in-flight research, and pending memory writes.
 * A transparency panel, not a control surface.
 *
 * Pure view model + {@link RenderTree} template over a serializable
 * {@link SecretarySnapshot} (the daemon projects live loop state into
 * this shape for the wire).
 */
import type {
  TodoItem,
  TodoStatus,
} from '../../../../core/application/use-cases/secretary/todo-tool.js';
import type { RenderTree } from './view-types.js';

/** A research pass the Secretary is running in the background. */
export interface ResearchJobView {
  readonly id: string;
  readonly query: string;
  readonly startedAt: string;
  /** Optional idea ledger the findings append to. */
  readonly ideaId?: string;
}

/** A durable fact the Secretary intends to persist (e.g. a preference). */
export interface PendingMemoryView {
  readonly id: string;
  readonly summary: string;
  /** Capsule/scope the write targets (e.g. 'user', 'project:x'). */
  readonly scope: string;
}

/** The wire shape the daemon produces for this view. */
export interface SecretarySnapshot {
  readonly todos: readonly TodoItem[];
  readonly research: readonly ResearchJobView[];
  readonly pendingMemories: readonly PendingMemoryView[];
}

/** Full Secretary view data. */
export interface SecretaryViewData {
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

/** Build the view from a Secretary snapshot. */
export function buildSecretaryView(snapshot: SecretarySnapshot): SecretaryViewData {
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

/** Render the full Secretary panel. */
export function renderSecretaryView(view: SecretaryViewData): RenderTree {
  return el('SecretaryView', { empty: view.isEmpty }, [
    el(
      'SecretarySection',
      { title: 'Plan' },
      view.todos.length > 0
        ? view.todos.map(renderTodoRow)
        : [el('EmptyHint', {}, ['no plan yet'])],
    ),
    el(
      'SecretarySection',
      { title: 'Research in flight' },
      view.research.length > 0
        ? view.research.map(renderResearchJob)
        : [el('EmptyHint', {}, ['idle'])],
    ),
    el(
      'SecretarySection',
      { title: 'Pending memory writes' },
      view.pendingMemories.length > 0
        ? view.pendingMemories.map(renderPendingMemory)
        : [el('EmptyHint', {}, ['none'])],
    ),
  ]);
}
