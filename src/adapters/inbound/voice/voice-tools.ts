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

/** Default system instructions for the Florina voice persona. */
export const DEFAULT_VOICE_INSTRUCTIONS = `You are Florina, an attention broker for coding agents.
The developer delegates work to coding agents and you route their attention.
Use the provided tools to query status, list tasks, check the inbox, and approve or deny requests.
Keep responses concise. When the developer asks for status, use get_inbox or list_tasks.
When they say "approve", use approve_permission. When they say "deny", use deny_permission.
When they tell you a provider or model preference ("never Opus", "Codex for heavy lifting"),
repeat it back in one short sentence, then persist it with remember_preference — the rule
becomes a routing fact, not a prompt hint. When they ask what their preferences are,
use list_preferences.
Never make up information — always use the tools.`;

/**
 * Setup-interview block appended to the voice instructions when the
 * preference profile is empty (issue #65): the first voice session
 * becomes a short onboarding interview instead of dead air.
 */
export const SETUP_INTERVIEW_INSTRUCTIONS = `
This is a fresh install — the developer has no saved preferences yet.
Open the session with a brief setup interview: ask which agent providers
they have (Codex, Claude Code, Devin, Gemini, agy), which they prefer for
what kind of work, and any models to avoid. Keep it conversational — three
or four questions, not a form. Confirm each preference back, then persist
it with remember_preference. When done, say the profile is saved and move
to the inbox.`;

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
      description: "Get the current attention inbox — items that need the developer's attention.",
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
            description:
              'Filter by task state: Created, Delegated, Running, Waiting, Completed, Failed, Cancelled.',
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
    /* ---------------------------------------------------------------- *
     * Florina-loop tools (DEC-021 + DEC-034, issue #73)
     * ------------------------------------------------------------------ */
    {
      type: 'function',
      name: 'research',
      description:
        'Start a background research pass on a topic while the conversation continues. ' +
        'The Florina investigates asynchronously and speaks again when the result is ready — ' +
        'this call returns immediately.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to research.' },
          ideaId: {
            type: 'string',
            description: 'Optional idea ledger the findings should append to.',
          },
        },
        required: ['query'],
      },
    },
    {
      type: 'function',
      name: 'update_idea_ledger',
      description:
        'Append notes to an idea ledger — research findings, open questions, ' +
        'decisions in progress. Pass ideaId to update an existing ledger, or ' +
        'title to open a new one.',
      parameters: {
        type: 'object',
        properties: {
          ideaId: { type: 'string', description: 'Existing ledger id to append to.' },
          title: { type: 'string', description: 'Title for a new ledger (when no ideaId).' },
          heading: { type: 'string', description: 'Section heading for the new content.' },
          body: { type: 'string', description: 'Markdown body of the section.' },
        },
        required: ['heading', 'body'],
      },
    },
    {
      type: 'function',
      name: 'compile_brief',
      description:
        'Compile an idea ledger into a reviewable Brief: the frozen spec plus a ' +
        'delegation plan (project + task breakdown). The Brief is shown for review — ' +
        'nothing is dispatched without explicit confirmation.',
      parameters: {
        type: 'object',
        properties: {
          ideaId: { type: 'string', description: 'The ledger to compile.' },
          projectId: { type: 'string', description: 'Project the tasks dispatch into.' },
          tasks: {
            type: 'array',
            description: 'Delegation plan tasks.',
            items: {
              type: 'object',
              properties: {
                objective: { type: 'string', description: 'What the worker should accomplish.' },
                workType: { type: 'string', description: 'Optional work-type tag.' },
                provider: { type: 'string', description: 'Preferred provider.' },
                model: { type: 'string', description: 'Preferred model pin.' },
              },
              required: ['objective'],
            },
          },
        },
        required: ['ideaId', 'projectId', 'tasks'],
      },
    },
    {
      type: 'function',
      name: 'remember_preference',
      description:
        'Record a durable provider/model routing preference ("never Opus", ' +
        '"Codex for heavy lifting") so it persists as a routing fact rather ' +
        'than a one-off instruction.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add-rule', 'deny', 'remove-rule', 'remove-deny'],
            description: 'What to change in the profile.',
          },
          provider: { type: 'string', description: 'Provider id (e.g. claude-code, devin).' },
          model: { type: 'string', description: 'Optional model pin.' },
          workTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Work-type tags a routing rule applies to (add-rule only).',
          },
          note: {
            type: 'string',
            description:
              "The user's own words for this rule (e.g. 'Sonnet for repeatable reading work').",
          },
        },
        required: ['action', 'provider'],
      },
    },
    {
      type: 'function',
      name: 'list_preferences',
      description:
        'Read the durable routing preference profile — answers "what are ' +
        'my rules for Claude?" and similar questions.',
      parameters: {
        type: 'object',
        properties: {
          projectId: {
            type: 'string',
            description: 'Limit the answer to rules visible to this project.',
          },
        },
      },
    },
  ] as const;
}

/**
 * Voice tools that run asynchronously (issue #73): their result cannot
 * come back inside the speech turn, so the session manager answers the
 * tool call immediately and speaks again via `sendUserMessage` when the
 * work finishes. Everything NOT in this set maps to a typed Command and
 * executes synchronously through the command API.
 */
export const ASYNC_VOICE_TOOLS: readonly string[] = ['research'] as const;

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
    case 'update_idea_ledger': {
      const heading = args['heading'];
      const body = args['body'];
      if (typeof heading !== 'string' || typeof body !== 'string') return null;
      if (typeof args['ideaId'] === 'string') {
        return {
          kind: 'idea-append',
          ideaId: args['ideaId'],
          heading,
          body,
        } as Command;
      }
      if (typeof args['title'] === 'string') {
        // No ledger id — open a new one seeded with this section.
        return {
          kind: 'idea-create',
          title: args['title'],
          body: `## ${heading}\n\n${body}`,
        } as Command;
      }
      return null;
    }
    case 'compile_brief': {
      if (typeof args['ideaId'] !== 'string' || typeof args['projectId'] !== 'string') {
        return null;
      }
      const rawTasks = args['tasks'];
      if (!Array.isArray(rawTasks)) return null;
      const tasks = rawTasks.map((t) => {
        const task = t as Record<string, unknown>;
        return {
          objective: typeof task['objective'] === 'string' ? task['objective'] : '',
          ...(typeof task['workType'] === 'string' ? { workType: task['workType'] } : {}),
          ...(typeof task['provider'] === 'string' ? { preferProvider: task['provider'] } : {}),
          ...(typeof task['model'] === 'string' ? { preferModel: task['model'] } : {}),
        };
      });
      if (tasks.some((t) => t.objective === '')) return null;
      return {
        kind: 'brief-compile',
        ideaId: args['ideaId'],
        plan: { projectId: args['projectId'], tasks },
      } as Command;
    }
    case 'remember_preference': {
      const action = args['action'];
      if (
        typeof args['provider'] !== 'string' ||
        (action !== 'add-rule' &&
          action !== 'deny' &&
          action !== 'remove-rule' &&
          action !== 'remove-deny')
      ) {
        return null;
      }
      const workTypes = args['workTypes'];
      return {
        kind: 'update-preference',
        action,
        provider: args['provider'],
        model: typeof args['model'] === 'string' ? args['model'] : undefined,
        workTypes: Array.isArray(workTypes)
          ? (workTypes.filter((w) => typeof w === 'string') as string[])
          : undefined,
        note: typeof args['note'] === 'string' ? args['note'] : undefined,
      } as Command;
    }
    case 'list_preferences': {
      return {
        kind: 'query-preferences',
        projectId: typeof args['projectId'] === 'string' ? args['projectId'] : undefined,
      } as Command;
    }
    default:
      return null;
  }
}
