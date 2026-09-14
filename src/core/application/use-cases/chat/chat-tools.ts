/**
 * ChatToolRegistry — the Secretary's tool surface inside a chat turn
 * (issue #158).
 *
 * Every tool maps verbatim onto an existing typed command executed
 * through the daemon's own {@link CommandExecutor} — the loop can do
 * exactly what a local client can do, never more (DEC-011: narrow,
 * never widening). Approval grants are allowed only because the
 * journaled conversation records the user instruction that authorized
 * them — provenance is preserved in `chat_messages`.
 */
import type { CommandExecutor, Command, Response } from '../tasks/command-api.js';
import { ToolRegistry, type ToolDefinition } from '../florina/tool-registry.js';

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function strList(args: Args, key: string): string[] | undefined {
  const v = args[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/** Run a command and hand the serialized response back to the model. */
async function call(
  api: CommandExecutor,
  command: Command,
): Promise<{ content: string; isError?: boolean }> {
  const res: Response = await api.execute(command);
  return { content: JSON.stringify(res), isError: !res.ok };
}

const EMPTY: Record<string, never> = Object.freeze({});

/** The tools available to the Secretary inside a chat turn. */
export function chatToolDefinitions(api: CommandExecutor): ToolDefinition[] {
  return [
    {
      name: 'list_tasks',
      description: 'List all tasks with their state, agent, and event counts.',
      parameters: { type: 'object', properties: EMPTY },
      execute: () => call(api, { kind: 'list-tasks' }),
    },
    {
      name: 'query_inbox',
      description: 'Read the attention inbox — pending approvals, failures, decisions.',
      parameters: { type: 'object', properties: EMPTY },
      execute: () => call(api, { kind: 'query-inbox' }),
    },
    {
      name: 'get_digest',
      description: 'Fetch the completion digest for a task (what shipped, evidence).',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      execute: (a) => call(api, { kind: 'get-digest', taskId: str(a, 'taskId') ?? '' }),
    },
    {
      name: 'query_fleet',
      description: 'Provider quota windows, parked tasks, and routing decisions.',
      parameters: { type: 'object', properties: EMPTY },
      execute: () => call(api, { kind: 'query-fleet' }),
    },
    {
      name: 'query_secretary',
      description:
        'The Secretary working surface — plan, in-flight research, memory writes, context health.',
      parameters: { type: 'object', properties: EMPTY },
      execute: () => call(api, { kind: 'query-secretary' }),
    },
    {
      name: 'list_ideas',
      description: 'List idea ledgers (title, entry count, preview).',
      parameters: { type: 'object', properties: EMPTY },
      execute: () => call(api, { kind: 'idea-list' }),
    },
    {
      name: 'create_idea',
      description: 'Start a new idea ledger.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['title'],
      },
      execute: (a) =>
        call(api, {
          kind: 'idea-create',
          title: str(a, 'title') ?? '',
          body: str(a, 'body') ?? '',
        }),
    },
    {
      name: 'append_idea',
      description: 'Append a titled section to an idea ledger.',
      parameters: {
        type: 'object',
        properties: {
          ideaId: { type: 'string' },
          heading: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['ideaId', 'heading', 'body'],
      },
      execute: (a) =>
        call(api, {
          kind: 'idea-append',
          ideaId: str(a, 'ideaId') ?? '',
          heading: str(a, 'heading') ?? '',
          body: str(a, 'body') ?? '',
        }),
    },
    {
      name: 'delegate_task',
      description:
        'Delegate a task to a coding agent on a project. Only when the user asked for work to start.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          objective: { type: 'string' },
          workType: { type: 'string' },
          preferProvider: { type: 'string' },
          preferModel: { type: 'string' },
          excludeProviders: { type: 'array', items: { type: 'string' } },
        },
        required: ['projectId', 'objective'],
      },
      execute: (a) =>
        call(api, {
          kind: 'delegate-task',
          projectId: str(a, 'projectId') ?? '',
          objective: str(a, 'objective') ?? '',
          ...(str(a, 'workType') !== undefined ? { workType: str(a, 'workType') } : {}),
          ...(str(a, 'preferProvider') !== undefined
            ? { preferProvider: str(a, 'preferProvider') }
            : {}),
          ...(str(a, 'preferModel') !== undefined ? { preferModel: str(a, 'preferModel') } : {}),
          ...(strList(a, 'excludeProviders') !== undefined
            ? { excludeProviders: strList(a, 'excludeProviders') }
            : {}),
        }),
    },
    {
      name: 'approve',
      description:
        'Grant or deny a pending approval — only when the user just authorized it in this conversation.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          approvalId: { type: 'string' },
          decision: { type: 'string', enum: ['grant', 'deny'] },
          note: { type: 'string' },
        },
        required: ['taskId', 'approvalId', 'decision'],
      },
      execute: (a) =>
        call(api, {
          kind: 'approve',
          taskId: str(a, 'taskId') ?? '',
          approvalId: str(a, 'approvalId') ?? '',
          decision: str(a, 'decision') === 'deny' ? 'deny' : 'grant',
          ...(str(a, 'note') !== undefined ? { note: str(a, 'note') } : {}),
        }),
    },
    {
      name: 'raise_attention',
      description:
        'Surface a decision or question to the user’s inbox — the canonical route when a turn needs human action. Attention items are task-scoped: attach the relevant taskId.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          summary: { type: 'string' },
          details: { type: 'string' },
          priority: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
        },
        required: ['taskId', 'summary'],
      },
      execute: (a) =>
        call(api, {
          kind: 'raise-attention',
          taskId: str(a, 'taskId') ?? '',
          summary: str(a, 'summary') ?? '',
          ...(str(a, 'details') !== undefined ? { details: str(a, 'details') } : {}),
          ...(str(a, 'priority') !== undefined
            ? { priority: str(a, 'priority') as 'Low' | 'Medium' | 'High' | 'Critical' }
            : {}),
          source: 'chat',
        }),
    },
    {
      name: 'update_preference',
      description:
        'Persist a routing/model preference the user stated (durable memory — rules the capacity router enforces).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add-rule', 'deny', 'remove-rule', 'remove-deny'],
          },
          provider: { type: 'string' },
          model: { type: 'string' },
          workTypes: { type: 'array', items: { type: 'string' } },
          projectId: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['action', 'provider'],
      },
      execute: (a) =>
        call(api, {
          kind: 'update-preference',
          action: (str(a, 'action') ?? 'add-rule') as
            'add-rule' | 'deny' | 'remove-rule' | 'remove-deny',
          provider: str(a, 'provider') ?? '',
          ...(str(a, 'model') !== undefined ? { model: str(a, 'model') } : {}),
          ...(strList(a, 'workTypes') !== undefined ? { workTypes: strList(a, 'workTypes') } : {}),
          ...(str(a, 'projectId') !== undefined ? { projectId: str(a, 'projectId') } : {}),
          ...(str(a, 'note') !== undefined ? { note: str(a, 'note') } : {}),
        }),
    },
  ];
}

/** Build the registry for a chat turn — one executor, no extra powers. */
export function buildChatToolRegistry(api: CommandExecutor): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of chatToolDefinitions(api)) {
    registry.register(tool);
  }
  return registry;
}
