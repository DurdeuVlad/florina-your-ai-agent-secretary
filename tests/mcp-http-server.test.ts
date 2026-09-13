import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { FlorinaMcpHttpServer, mcpProjectId } from '../src/adapters/inbound/mcp/http-server.js';
import { managerServiceFactory } from '../src/bootstrap/mcp-server.js';
import {
  managerMcpRegistration,
  managerMcpRegistrations,
} from '../src/adapters/inbound/mcp/manager-registration.js';
import { CommandApi } from '../src/core/application/use-cases/tasks/command-api.js';
import type { CommandApiDeps } from '../src/core/application/use-cases/tasks/command-api.js';
import { QuotaLedger } from '../src/core/application/use-cases/routing/quota-ledger.js';
import { PreferenceProfileStore } from '../src/adapters/outbound/preferences/json-preference-profile.js';
import { EventBus } from '../src/adapters/outbound/events/in-memory-event-bus.js';
import { AttentionInbox } from '../src/core/application/use-cases/attention/attention-inbox.js';
import { MetricsCollector } from '../src/core/application/use-cases/metrics.js';
import { TaskStateMachine } from '../src/core/application/use-cases/tasks/task-lifecycle.js';
import {
  StorageDatabase,
  TaskRepository,
  EventRepository,
  ApprovalRepository,
  SessionRepository,
  ProjectRepository,
} from '../src/adapters/outbound/persistence/sqlite/index.js';
import { buildProject } from '../src/core/domain/index.js';

interface Fixture {
  server: FlorinaMcpHttpServer;
  db: StorageDatabase;
  projectId: string;
  tmpDir: string;
}

async function createFixture(): Promise<Fixture> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'sec-mcp-'));
  const db = new StorageDatabase({ path: ':memory:' });
  db.open();
  const raw = db.connection;

  const project = buildProject({ name: 'p', repo: { path: '/repo' } });
  raw
    .prepare(
      'INSERT INTO projects (id, name, repo, policies, capsule_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      project.id,
      project.name,
      JSON.stringify(project.repo),
      JSON.stringify(project.policies),
      project.capsuleId,
      project.createdAt,
      project.updatedAt,
    );

  const taskRepo = new TaskRepository(raw);
  const projectRepo = new ProjectRepository(raw);
  const eventRepo = new EventRepository(raw);
  const approvalRepo = new ApprovalRepository(raw);
  const sessionRepo = new SessionRepository(raw);
  const inbox = new AttentionInbox();

  const deps: CommandApiDeps = {
    eventBus: new EventBus(),
    taskStateMachine: new TaskStateMachine(taskRepo, eventRepo),
    attentionInbox: inbox,
    metricsCollector: new MetricsCollector(),
    worktreeManager: { pruneWorktree: vi.fn(), detectDirty: vi.fn(() => false) } as never,
    eventRepository: eventRepo,
    taskStore: taskRepo,
    approvalStore: approvalRepo,
    sessionStore: sessionRepo,
  };
  const api = new CommandApi(deps);
  const preferenceStore = await PreferenceProfileStore.load(join(tmpDir, 'preferences.json'));

  const server = new FlorinaMcpHttpServer({
    port: 0,
    serviceFactory: managerServiceFactory({
      commandApi: api,
      taskStore: taskRepo,
      worktreeManager: { createWorktree: vi.fn(() => '/wt') },
      quotaLedger: new QuotaLedger(),
      preferenceStore,
      projects: projectRepo,
    }),
  });
  await server.start();
  return { server, db, projectId: project.id, tmpDir };
}

async function mcpClient(url: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe('FlorinaMcpHttpServer', () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await createFixture();
  });
  afterEach(async () => {
    await fx.server.stop();
    fx.db.close();
    await rm(fx.tmpDir, { recursive: true, force: true });
  });

  it('serves the manager tool surface over real MCP Streamable HTTP', async () => {
    const client = await mcpClient(`${fx.server.url}?project=${fx.projectId}`);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'florina_get_inbox',
        'florina_get_task_status',
        'florina_list_tasks',
        'florina_request_human_input',
        'florina_spawn_task',
        'florina_stop_task',
      ]);

      const result = await client.callTool({
        name: 'florina_list_tasks',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as { type: string; text: string }[];
      expect(JSON.parse(content[0].text)).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('resolves the project scope from the x-florina-project header', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(fx.server.url), {
      requestInit: { headers: { 'x-florina-project': fx.projectId } },
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: 'florina_get_inbox',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('rejects connections without a project scope', async () => {
    const res = await fetch(fx.server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('missing its project scope');
  });

  it('404s unknown projects and unknown paths', async () => {
    const res = await fetch(`${fx.server.url}?project=nope`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);

    const other = await fetch(`http://127.0.0.1:${fx.server.port}/other`);
    expect(other.status).toBe(404);
  });

  it('mcpProjectId prefers the header over the query param', () => {
    const req = {
      headers: { 'x-florina-project': 'p_header' },
      url: '/mcp?project=p_query',
    } as Parameters<typeof mcpProjectId>[0];
    expect(mcpProjectId(req)).toBe('p_header');
    const noHeader = { headers: {}, url: '/mcp?project=p_query' } as Parameters<
      typeof mcpProjectId
    >[0];
    expect(mcpProjectId(noHeader)).toBe('p_query');
    const none = { headers: {}, url: '/mcp' } as Parameters<typeof mcpProjectId>[0];
    expect(mcpProjectId(none)).toBeNull();
  });
});

describe('managerMcpRegistration', () => {
  it('produces per-provider registration commands carrying the project scope', () => {
    const reg = managerMcpRegistration('claude-code', 'http://127.0.0.1:17420/mcp', 'proj_1');
    expect(reg.command).toBe('claude');
    expect(reg.args).toContain('mcp');
    expect(reg.url).toBe('http://127.0.0.1:17420/mcp?project=proj_1');
    const all = managerMcpRegistrations('http://127.0.0.1:17420/mcp');
    expect(all.map((r) => r.provider)).toEqual(['claude-code', 'codex', 'gemini', 'devin']);
  });
});
