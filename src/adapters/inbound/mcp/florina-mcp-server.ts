/**
 * Florina MCP tool server — the inbound surface manager agents use to
 * dispatch work through the daemon (DEC-018, DEC-037, issue #63).
 *
 * Provider CLIs register this server (`devin mcp add`, `claude mcp add`,
 * codex/gemini equivalents); every tool call becomes a typed daemon command,
 * so a manager can never spawn outside the journaled, quota- and
 * policy-checked path.
 *
 * The server is a thin adapter over the core {@link ManagerToolService} —
 * all logic lives in the application layer; this file only maps MCP tool
 * calls to service methods.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { ManagerToolService } from '../../../core/application/use-cases/managers/manager-tools.js';

/** Server identity reported in the MCP handshake. */
export const FLORINA_MCP_SERVER_NAME = 'florina';
export const FLORINA_MCP_SERVER_VERSION = '0.1.0';

function text(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Build an {@link McpServer} exposing the manager tool set. The caller
 * connects it to a transport — stdio in production, in-memory in tests.
 */
export function createFlorinaMcpServer(service: ManagerToolService): McpServer {
  const server = new McpServer({
    name: FLORINA_MCP_SERVER_NAME,
    version: FLORINA_MCP_SERVER_VERSION,
  });

  server.registerTool(
    'florina_spawn_task',
    {
      description:
        'Delegate a piece of work to a worker agent through the Florina daemon. ' +
        'Routes through the quota-aware CapacityRouter and preference rules; returns ' +
        'the spawned task/session ids, or a parked result with the earliest quota reset. ' +
        'All work dispatched to agents must go through this tool.',
      inputSchema: {
        objective: z.string().describe('What the worker should accomplish.'),
        workType: z
          .string()
          .optional()
          .describe('Work-type tag for work-type-specific routing rules.'),
        preferProvider: z
          .string()
          .optional()
          .describe('Preferred provider id (honored when quota and deny rules allow).'),
        preferModel: z.string().optional().describe('Model pin for the preferred provider.'),
        excludeProviders: z
          .array(z.string())
          .optional()
          .describe('Providers to exclude (e.g. already tried on this task).'),
      },
    },
    async (args) => text(await service.spawnTask(args)),
  );

  server.registerTool(
    'florina_stop_task',
    {
      description: 'Cancel a running worker task.',
      inputSchema: {
        taskId: z.string(),
        reason: z.string().optional(),
      },
    },
    async (args) => text(await service.stopTask(args)),
  );

  server.registerTool(
    'florina_get_task_status',
    {
      description: 'Get the current state snapshot of a task by id.',
      inputSchema: { taskId: z.string() },
    },
    async (args) => text(await service.getTaskStatus(args)),
  );

  server.registerTool(
    'florina_list_tasks',
    {
      description: 'List tasks, optionally filtered by lifecycle state.',
      inputSchema: {
        status: z
          .enum([
            'created',
            'delegated',
            'running',
            'attention-needed',
            'blocked',
            'completed',
            'reviewed',
            'accepted',
            'failed',
            'cancelled',
          ])
          .optional(),
      },
    },
    async (args) => text(await service.listTasks(args)),
  );

  server.registerTool(
    'florina_get_inbox',
    {
      description: 'List open attention items the human has not yet resolved.',
      inputSchema: {},
    },
    async () => text(await service.getInbox()),
  );

  server.registerTool(
    'florina_request_human_input',
    {
      description:
        'Ask the human a consequential question. Creates an attention item in the ' +
        'inbox. Use only for decisions that are not already granted by scope or ' +
        'inferable from the objective — the human should not be bothered otherwise.',
      inputSchema: {
        taskId: z.string().describe('Task the question belongs to.'),
        question: z.string().describe('The question or decision needed.'),
        details: z.string().optional().describe('Longer context for the human.'),
        priority: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(),
      },
    },
    async (args) => text(await service.requestHumanInput(args)),
  );

  return server;
}

/**
 * Run the Florina MCP server over stdio — the transport provider CLIs use
 * when the daemon is registered as a local MCP server.
 */
export async function runFlorinaMcpStdio(service: ManagerToolService): Promise<void> {
  const server = createFlorinaMcpServer(service);
  await server.connect(new StdioServerTransport());
}
