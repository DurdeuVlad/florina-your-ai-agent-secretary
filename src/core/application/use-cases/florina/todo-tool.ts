/**
 * TodoStore + todo tool — the Florina maintains its own working plan
 * (DEC-034, issue #70; goose plan-maintenance pattern).
 *
 * The store is plain in-memory state owned by whoever hosts the loop (the
 * daemon journals mutations — DEC-012). The `todo` tool definition exposes
 * it to the model with simple item-level actions plus whole-plan replace,
 * which models use to restate an evolving plan in one call.
 */
import type { ToolDefinition, ToolResult } from './tool-registry.js';

/** Status of one todo item. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One item in the Florina's working plan. */
export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
}

/** Raised for malformed todo tool arguments. */
export class TodoToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TodoToolError';
  }
}

/** In-memory todo list with id-addressable items. */
export class TodoStore {
  private items: TodoItem[] = [];
  private nextId = 1;

  /** All items, in insertion order. */
  list(): readonly TodoItem[] {
    return [...this.items];
  }

  /** Append an item; returns its assigned id. */
  add(content: string): TodoItem {
    const item: TodoItem = { id: `todo-${this.nextId++}`, content, status: 'pending' };
    this.items.push(item);
    return item;
  }

  /** Replace the whole list (whole-plan restatement). Ids are reassigned. */
  replaceAll(contents: readonly string[]): readonly TodoItem[] {
    this.items = contents.map((content) => ({
      id: `todo-${this.nextId++}`,
      content,
      status: 'pending' as const,
    }));
    return this.list();
  }

  /** Set one item's status; throws for unknown ids. */
  setStatus(id: string, status: TodoStatus): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new TodoToolError(`unknown todo id "${id}"`);
    }
    this.items[index] = { ...this.items[index], status };
  }

  /** Remove one item; throws for unknown ids. */
  remove(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new TodoToolError(`unknown todo id "${id}"`);
    }
    this.items.splice(index, 1);
  }
}

function render(items: readonly TodoItem[]): string {
  if (items.length === 0) {
    return 'todo list is empty';
  }
  return items.map((item) => `[${item.status}] ${item.id}: ${item.content}`).join('\n');
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TodoToolError(`"${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Build the `todo` tool bound to `store`.
 *
 * Actions: `list`, `add {content}`, `update {id,status}`, `remove {id}`,
 * `replace {items: string[]}` (whole-plan restatement), `clear`.
 */
export function createTodoTool(store: TodoStore): ToolDefinition {
  return {
    name: 'todo',
    description:
      'Maintain the working plan: list, add, update, or remove items, or replace the whole plan. ' +
      'Use it to keep track of multi-step work and to record what remains.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'update', 'remove', 'replace', 'clear'],
        },
        id: { type: 'string', description: 'Item id (update/remove).' },
        content: { type: 'string', description: 'Item text (add).' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'New status (update).',
        },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Whole replacement plan (replace).',
        },
      },
      required: ['action'],
    },
    async execute(args): Promise<ToolResult> {
      const action = requireString(args, 'action');
      switch (action) {
        case 'list':
          return { content: render(store.list()) };
        case 'add': {
          const item = store.add(requireString(args, 'content'));
          return { content: `added ${item.id}\n${render(store.list())}` };
        }
        case 'update': {
          const id = requireString(args, 'id');
          const status = requireString(args, 'status');
          if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
            throw new TodoToolError(`invalid status "${status}"`);
          }
          store.setStatus(id, status);
          return { content: render(store.list()) };
        }
        case 'remove':
          store.remove(requireString(args, 'id'));
          return { content: render(store.list()) };
        case 'replace': {
          const items = args.items;
          if (!Array.isArray(items) || items.some((i) => typeof i !== 'string')) {
            throw new TodoToolError('"items" must be an array of strings');
          }
          store.replaceAll(items as readonly string[]);
          return { content: render(store.list()) };
        }
        case 'clear':
          store.replaceAll([]);
          return { content: 'todo list cleared' };
        default:
          throw new TodoToolError(`unknown action "${action}"`);
      }
    },
  };
}
