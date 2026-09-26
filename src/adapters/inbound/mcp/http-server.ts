/**
 * Florina MCP HTTP server — the localhost HTTP transport manager agents
 * connect to (DEC-018, DEC-037, issue #63).
 *
 * The daemon owns this server: it lives in the same process so the
 * {@link ManagerToolService} behind it operates on live state (the real
 * quota ledger, inbox, and task repositories) rather than a remote
 * projection. Bound to 127.0.0.1 only — same network boundary as the
 * WebSocket control plane (DEC-008).
 *
 * Transport: MCP Streamable HTTP in **stateless** mode — each request gets
 * a fresh {@link McpServer} + transport pair, so no session state is held
 * and the tool surface stays a pure request/response mapping onto the
 * service.
 *
 * Project scoping: managers are per-project (DEC-003 isolation). The
 * caller supplies a {@link ManagerServiceFactory} that resolves the
 * project from the request (`x-florina-project` header or `?project=`
 * query param) — the server itself is project-agnostic.
 */
import * as http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { ManagerToolService } from '../../../core/application/use-cases/managers/manager-tools.js';
import { createFlorinaMcpServer } from './florina-mcp-server.js';

/** The URL path the MCP transport is mounted on. */
export const MCP_HTTP_PATH = '/mcp';

/**
 * Resolves the {@link ManagerToolService} for an incoming request —
 * typically by reading the `x-florina-project` header or `?project=`
 * query param and composing a service scoped to that project. May throw;
 * the server answers 404 for unknown projects.
 */
export type ManagerServiceFactory = (request: IncomingMessage) => ManagerToolService;

/** Options for {@link FlorinaMcpHttpServer}. */
export interface FlorinaMcpHttpServerOptions {
  /** Localhost port to bind. Pass `0` to let the OS assign a port. */
  readonly port: number;
  /** Resolves the per-request (per-project) manager service. */
  readonly serviceFactory: ManagerServiceFactory;
  /** Invoked for server errors after listening has started. */
  readonly onError?: (error: Error) => void;
}

/**
 * Extract the project identifier a manager tagged its connection with:
 * the `x-florina-project` header wins, then the `?project=` query param.
 */
export function mcpProjectId(request: IncomingMessage): string | null {
  const header = request.headers['x-florina-project'];
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const param = url.searchParams.get('project');
  return param !== null && param.length > 0 ? param : null;
}

/**
 * Localhost HTTP server exposing the manager tool surface over MCP
 * Streamable HTTP (stateless).
 */
export class FlorinaMcpHttpServer {
  private readonly options: FlorinaMcpHttpServerOptions;
  private server: Server | null = null;
  private boundPort: number;

  constructor(options: FlorinaMcpHttpServerOptions) {
    this.options = options;
    this.boundPort = options.port;
  }

  /** The bound port (OS-assigned value when `0` was requested). */
  get port(): number {
    return this.boundPort;
  }

  /** The `http://` URL managers register with their provider CLI. */
  get url(): string {
    return `http://127.0.0.1:${this.boundPort}${MCP_HTTP_PATH}`;
  }

  /** Whether the server is currently listening. */
  get isListening(): boolean {
    return this.server !== null;
  }

  /**
   * Bind 127.0.0.1 and begin serving {@link MCP_HTTP_PATH}.
   *
   * @returns the actual bound port.
   */
  start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server = server;
      server.on('error', (err) => {
        if (this.boundPort !== 0) {
          // Startup failure or post-listen error: surface both the same way.
          reject(err);
          this.options.onError?.(err);
        } else {
          this.options.onError?.(err);
        }
      });
      server.listen(this.options.port, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          this.boundPort = addr.port;
        }
        resolve(this.boundPort);
      });
    });
  }

  /** Stop accepting connections. */
  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      const server = this.server;
      this.server = null;
      server.close(() => resolve());
    });
  }

  /**
   * Route a request: only {@link MCP_HTTP_PATH} is served; everything else
   * is a 404. Each request builds a fresh server+transport pair (stateless
   * mode — no session tracking).
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== MCP_HTTP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let service: ManagerToolService;
    try {
      service = this.options.serviceFactory(req);
    } catch (err) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'unknown project',
        }),
      );
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createFlorinaMcpServer(service);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : 'MCP request failed',
          }),
        );
      } else {
        res.end();
      }
    }
  }
}
