/**
 * Voice tool surface — the typed tools the voice model may invoke and the
 * translation from model tool calls into daemon {@link Command}s
 * (DEC-021, DEC-002, DEC-011, issue #93).
 *
 * The voice model never executes arbitrary commands — it sees only the
 * typed tool definitions built here, and every tool call is mapped to a
 * typed {@link Command} executed through the command API. Unknown tool
 * names produce an error, never an execution.
 */
import type { VoiceToolDefinition } from '../../../core/application/ports/outbound/voice.js';
import type { Command } from '../../../core/application/use-cases/tasks/command-api.js';

/** Default system instructions for the Secretary voice persona. */
export const DEFAULT_VOICE_INSTRUCTIONS = `You are Agent Secretary, an attention broker for coding agents.
The developer delegates work to coding agents and you route their attention.
Use the provided tools to query status, list tasks, check the inbox, and approve or deny requests.
Keep responses concise. When the developer asks for status, use get_inbox or list_tasks.
When they say "approve", use approve_permission. When they say "deny", use deny_permission.
Never make up information — always use the tools.`;

/**
 * Build the default typed tool definitions exposed to the voice model
 * (DEC-021). These map directly to command API commands.
 *
 * The voice model never executes arbitrary shell commands — only these
 * typed tools, which the session manager routes to the command API
 * (DEC-011). The provider-neutral {@link VoiceToolDefinition} shape is
 * mapped onto each engine's wire schema by its outbound adapter.
 */
export function buildDefaultVoiceTools(): readonly VoiceToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'get_inbox',
      description: 'Get the current attention inbox — items that need the developer\'s attention.',
      parameters: {
        type: 'object',
        properties: {
          priority: {
            type: 'string',
            description: 'Filter by priority: Critical, High, Medium, or Low.',
          },
          status: {
            type: 'string',
            description: 'Filter by status: Pending, Acknowledged, Resolved, or Escalated.',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'list_tasks',
      description: 'List all tasks, optionally filtered by status.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by task state: Created, Delegated, Running, Waiting, Completed, Failed, Cancelled.',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'query_task',
      description: 'Get details for a specific task by its id.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task identifier.' },
        },
        required: ['taskId'],
      },
    },
    {
      type: 'function',
      name: 'get_metrics',
      description: 'Get the current metrics snapshot (attention compression ratio, etc.).',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'Epoch-milliseconds lower bound.' },
        },
      },
    },
    {
      type: 'function',
      name: 'approve_permission',
      description: 'Grant a pending approval request for a task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task that has the pending approval.' },
          approvalId: { type: 'string', description: 'The approval request id.' },
          note: { type: 'string', description: 'Optional note explaining the grant.' },
        },
        required: ['taskId', 'approvalId'],
      },
    },
    {
      type: 'function',
      name: 'deny_permission',
      description: 'Deny a pending approval request for a task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task that has the pending approval.' },
          approvalId: { type: 'string', description: 'The approval request id.' },
          note: { type: 'string', description: 'Optional note explaining the denial.' },
        },
        required: ['taskId', 'approvalId'],
      },
    },
    {
      type: 'function',
      name: 'get_digest',
      description: 'Get the completion digest for a task (summary of what the agent delivered).',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task id.' },
        },
        required: ['taskId'],
      },
    },
  ] as const;
}

/**
 * Map a voice tool call (name + parsed args) to a typed {@link Command}.
 *
 * Returns `null` for unrecognized tool names so the caller can return an
 * error to the voice model without executing anything (DEC-011).
 */
export function mapToolCallToCommand(
  toolName: string,
  args: Record<string, unknown>,
): Command | null {
  switch (toolName) {
    case 'get_inbox': {
      const filter: Record<string, unknown> = {};
      if (typeof args['priority'] === 'string') filter['priority'] = args['priority'];
      if (typeof args['status'] === 'string') filter['status'] = args['status'];
      return {
        kind: 'query-inbox',
        filter: Object.keys(filter).length > 0 ? filter : undefined,
      } as Command;
    }
    case 'list_tasks':
      return {
        kind: 'list-tasks',
        status: typeof args['status'] === 'string' ? (args['status'] as never) : undefined,
      } as Command;
    case 'query_task':
      if (typeof args['taskId'] !== 'string') return null;
      return { kind: 'query-task', taskId: args['taskId'] } as Command;
    case 'get_metrics':
      return {
        kind: 'query-metrics',
        since: typeof args['since'] === 'number' ? args['since'] : undefined,
      } as Command;
    case 'approve_permission': {
      if (typeof args['taskId'] !== 'string' || typeof args['approvalId'] !== 'string') return null;
      return {
        kind: 'approve',
        taskId: args['taskId'],
        approvalId: args['approvalId'],
        decision: 'grant',
        note: typeof args['note'] === 'string' ? args['note'] : undefined,
      } as Command;
    }
    case 'deny_permission': {
      if (typeof args['taskId'] !== 'string' || typeof args['approvalId'] !== 'string') return null;
      return {
        kind: 'approve',
        taskId: args['taskId'],
        approvalId: args['approvalId'],
        decision: 'deny',
        note: typeof args['note'] === 'string' ? args['note'] : undefined,
      } as Command;
    }
    case 'get_digest':
      if (typeof args['taskId'] !== 'string') return null;
      return { kind: 'get-digest', taskId: args['taskId'] } as Command;
    default:
      return null;
  }
}
