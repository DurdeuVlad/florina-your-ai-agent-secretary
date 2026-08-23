import * as net from 'node:net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  DesktopApp,
  DesktopConnectionError,
  IpcBridge,
  IpcError,
  IPC_CHANNELS,
  MockIpcTransport,
  MockWindowBackend,
  RendererState,
  DEFAULT_RENDERER_STATE,
  DEFAULT_WINDOW_BOUNDS,
} from '../src/desktop/index.js';
import type { IpcChannel, WindowOptions } from '../src/desktop/index.js';

/* ------------------------------------------------------------------ *
 * Mock daemon WebSocket server (pushes state updates to the desktop app)
 * ------------------------------------------------------------------ */
class MockDaemonServer {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  readonly port: number;

  constructor(port = 0) {
    this.port = port;
    this.wss = new WebSocketServer({ port });
  }

  get actualPort(): number {
    const addr = this.wss.address();
    return typeof addr === 'object' && addr !== null ? (addr as { port: number }).port : this.port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.actualPort}`;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.once('listening', () => resolve());
    });
  }

  /** Wait for the desktop app to connect. */
  async waitForConnection(): Promise<WebSocket> {
    return new Promise((resolve) => {
      this.wss.once('connection', (socket) => {
        this.client = socket;
        resolve(socket);
      });
    });
  }

  /** Push a JSON message to the connected desktop client. */
  push(message: unknown): void {
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(message));
    }
  }

  /** Respond to a command (echo back a response). */
  autoRespond(): void {
    if (!this.client) return;
    this.client.on('message', (data) => {
      const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
      const parsed = JSON.parse(text) as { kind: string };
      // Echo a minimal ok response shaped per command kind.
      if (parsed.kind === 'query-inbox') {
        this.client!.send(JSON.stringify({ ok: true, items: [] }));
      } else if (parsed.kind === 'shutdown') {
        this.client!.send(JSON.stringify({ ok: true }));
      } else {
        this.client!.send(JSON.stringify({ ok: true }));
      }
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.client?.close();
      this.wss.close(() => resolve());
    });
  }
}

/* ------------------------------------------------------------------ *
 * RendererState
 * ------------------------------------------------------------------ */
describe('RendererState', () => {
  it('starts with default state', () => {
    const rs = new RendererState();
    expect(rs.snapshot()).toEqual(DEFAULT_RENDERER_STATE);
  });

  it('update merges partial state and returns a deep copy', () => {
    const rs = new RendererState();
    const next = rs.update({ connected: true, daemonStatus: 'connected' });
    expect(next.connected).toBe(true);
    expect(next.daemonStatus).toBe('connected');
    // Returned value is a copy — mutating it must not affect internal state.
    (next as unknown as { connected: boolean }).connected = false;
    expect(rs.snapshot().connected).toBe(true);
  });

  it('snapshot returns a deep copy', () => {
    const rs = new RendererState();
    const items = [{ id: 'a', taskId: 't', kind: 'k', priority: 'low', status: 'pending', createdAt: '', payload: {} }];
    rs.update({ inboxItems: items });
    const snap = rs.snapshot();
    snap.inboxItems[0]!.id = 'mutated';
    expect(rs.snapshot().inboxItems[0]!.id).toBe('a');
  });

  it('subscribe is notified on update with a snapshot', () => {
    const rs = new RendererState();
    const cb = vi.fn();
    const unsub = rs.subscribe(cb);
    rs.update({ connected: true });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0].connected).toBe(true);
    unsub();
    rs.update({ connected: false });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('reset clears state to defaults and notifies', () => {
    const rs = new RendererState();
    const cb = vi.fn();
    rs.subscribe(cb);
    rs.update({ connected: true, daemonStatus: 'connected' });
    cb.mockClear();
    rs.reset();
    expect(rs.snapshot()).toEqual(DEFAULT_RENDERER_STATE);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not break other subscribers', () => {
    const rs = new RendererState();
    const good = vi.fn();
    rs.subscribe(() => {
      throw new Error('boom');
    });
    rs.subscribe(good);
    rs.update({ connected: true });
    expect(good).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * MockWindowBackend
 * ------------------------------------------------------------------ */
describe('MockWindowBackend', () => {
  it('createWindow sets bounds from options and emits ready-to-show', () => {
    const wb = new MockWindowBackend();
    const ready = vi.fn();
    wb.on('ready-to-show', ready);
    wb.createWindow({ width: 1024, height: 768, title: 'Test' });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(wb.getBounds()).toEqual({
      x: DEFAULT_WINDOW_BOUNDS.x,
      y: DEFAULT_WINDOW_BOUNDS.y,
      width: 1024,
      height: 768,
    });
    expect(wb.windowOptions.title).toBe('Test');
  });

  it('show/hide toggles visibility and emits events', () => {
    const wb = new MockWindowBackend();
    wb.createWindow();
    const showCb = vi.fn();
    const hideCb = vi.fn();
    wb.on('show', showCb);
    wb.on('hide', hideCb);
    expect(wb.isVisible()).toBe(false);
    wb.show();
    expect(wb.isVisible()).toBe(true);
    expect(showCb).toHaveBeenCalledTimes(1);
    wb.hide();
    expect(wb.isVisible()).toBe(false);
    expect(hideCb).toHaveBeenCalledTimes(1);
  });

  it('loadURL / loadFile record the target', () => {
    const wb = new MockWindowBackend();
    wb.createWindow();
    wb.loadURL('http://localhost:5173');
    expect(wb.currentURL).toBe('http://localhost:5173');
    expect(wb.currentFile).toBeNull();
    wb.loadFile('renderer/index.html');
    expect(wb.currentFile).toBe('renderer/index.html');
    expect(wb.currentURL).toBeNull();
  });

  it('setBounds updates bounds and emits resize+move', () => {
    const wb = new MockWindowBackend();
    wb.createWindow();
    const resize = vi.fn();
    const move = vi.fn();
    wb.on('resize', resize);
    wb.on('move', move);
    wb.setBounds({ x: 10, y: 20, width: 300, height: 200 });
    expect(wb.getBounds()).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(resize).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('close emits close then closed and marks closed', () => {
    const wb = new MockWindowBackend();
    wb.createWindow();
    wb.show();
    const closeCb = vi.fn();
    const closedCb = vi.fn();
    wb.on('close', closeCb);
    wb.on('closed', closedCb);
    wb.close();
    expect(closeCb).toHaveBeenCalledTimes(1);
    expect(closedCb).toHaveBeenCalledTimes(1);
    expect(wb.isClosed()).toBe(true);
    expect(wb.isVisible()).toBe(false);
  });

  it('operations on a closed window throw', () => {
    const wb = new MockWindowBackend();
    wb.createWindow();
    wb.close();
    expect(() => wb.show()).toThrow();
    expect(() => wb.loadURL('http://x')).toThrow();
    expect(() => wb.setBounds(DEFAULT_WINDOW_BOUNDS)).toThrow();
  });

  it('on returns an unsubscribe function', () => {
    const wb = new MockWindowBackend();
    wb.createWindow();
    const cb = vi.fn();
    const unsub = wb.on('show', cb);
    wb.show();
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    wb.hide();
    wb.show();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ *
 * IpcBridge
 * ------------------------------------------------------------------ */
describe('IpcBridge', () => {
  it('IPC_CHANNELS contains the six required channels', () => {
    expect(IPC_CHANNELS).toEqual([
      'inbox:update',
      'task:update',
      'approval:request',
      'digest:update',
      'metrics:update',
      'voice:state',
    ]);
  });

  it('sendToRenderer delegates to the transport', () => {
    const transport = new MockIpcTransport();
    const bridge = new IpcBridge(transport);
    bridge.sendToRenderer('inbox:update', { items: [] });
    expect(transport.toRenderer).toHaveLength(1);
    expect(transport.toRenderer[0]).toEqual({ channel: 'inbox:update', data: { items: [] } });
    bridge.dispose();
  });

  it('sendToMain delegates to the transport', () => {
    const transport = new MockIpcTransport();
    const bridge = new IpcBridge(transport);
    bridge.sendToMain('voice:state', { listening: true });
    expect(transport.toMain).toHaveLength(1);
    expect(transport.toMain[0]).toEqual({ channel: 'voice:state', data: { listening: true } });
    bridge.dispose();
  });

  it('on receives messages delivered via the transport', () => {
    const transport = new MockIpcTransport();
    const bridge = new IpcBridge(transport);
    const handler = vi.fn();
    bridge.on('task:update', handler);
    transport.emitToMain('task:update', { id: 't1' });
    expect(handler).toHaveBeenCalledWith({ id: 't1' });
    bridge.dispose();
  });

  it('all six channels can be subscribed and receive messages', () => {
    const transport = new MockIpcTransport();
    const bridge = new IpcBridge(transport);
    const handlers = new Map<IpcChannel, ReturnType<typeof vi.fn>>();
    for (const ch of IPC_CHANNELS) {
      const h = vi.fn();
      handlers.set(ch, h);
      bridge.on(ch, h);
    }
    for (const ch of IPC_CHANNELS) {
      transport.emitToRenderer(ch, { channel: ch });
    }
    for (const ch of IPC_CHANNELS) {
      expect(handlers.get(ch)).toHaveBeenCalledWith({ channel: ch });
    }
    bridge.dispose();
  });

  it('send on an invalid channel throws IpcError', () => {
    const transport = new MockIpcTransport();
    const bridge = new IpcBridge(transport);
    expect(() => bridge.sendToRenderer('unknown' as IpcChannel, {})).toThrow(IpcError);
    bridge.dispose();
  });

  it('transport error is wrapped in IpcError', () => {
    const failingTransport: MockIpcTransport = new MockIpcTransport();
    failingTransport.sendToRenderer = () => {
      throw new Error('transport down');
    };
    const bridge = new IpcBridge(failingTransport);
    expect(() => bridge.sendToRenderer('inbox:update', {})).toThrow(IpcError);
    bridge.dispose();
  });

  it('dispose prevents further use and unsubscribes transport', () => {
    const transport = new MockIpcTransport();
    const bridge = new IpcBridge(transport);
    bridge.dispose();
    expect(bridge.isDisposed).toBe(true);
    expect(() => bridge.sendToRenderer('inbox:update', {})).toThrow(IpcError);
    expect(() => bridge.on('inbox:update', () => undefined)).toThrow(IpcError);
  });

  it('a throwing handler does not break other handlers on the same channel', () => {
    const transport = new MockIpcTransport();
    const bridge = new IpcBridge(transport);
    const good = vi.fn();
    bridge.on('inbox:update', () => {
      throw new Error('boom');
    });
    bridge.on('inbox:update', good);
    transport.emitToMain('inbox:update', { x: 1 });
    expect(good).toHaveBeenCalledWith({ x: 1 });
    bridge.dispose();
  });
});

/* ------------------------------------------------------------------ *
 * DesktopApp lifecycle
 * ------------------------------------------------------------------ */
describe('DesktopApp', () => {
  let server: MockDaemonServer;

  beforeEach(() => {
    server = new MockDaemonServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('start creates and shows the window', () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport });
    app.start();
    expect(app.isStarted).toBe(true);
    expect(window.isVisible()).toBe(true);
    expect(window.log).toContain('show');
  });

  it('getState returns initial state before connecting', () => {
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: new MockIpcTransport(),
    });
    const state = app.getState();
    expect(state.connected).toBe(false);
    expect(state.daemonStatus).toBe('disconnected');
    expect(state.inboxItems).toEqual([]);
    expect(state.activeTask).toBeNull();
  });

  it('connectToDaemon connects and updates state to connected', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport });
    app.start();
    const connecting = server.waitForConnection();
    const connectPromise = app.connectToDaemon(server.url);
    await connecting;
    await connectPromise;
    expect(app.isConnected).toBe(true);
    expect(app.getState().connected).toBe(true);
    expect(app.getState().daemonStatus).toBe('connected');
  });

  it('onStateChange fires when connection establishes', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport });
    app.start();
    const cb = vi.fn();
    app.onStateChange(cb);
    const connecting = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await connecting;
    // At least one notification with connected: true.
    const connectedCall = cb.mock.calls.find((c) => c[0].connected === true);
    expect(connectedCall).toBeTruthy();
  });

  it('daemon push messages update renderer state and forward over IPC', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await conn;

    const items = [
      { id: 'i1', taskId: 't1', kind: 'approval', priority: 'critical', status: 'pending', createdAt: 'now', payload: {} },
    ];
    server.push({ type: 'inbox:update', items });
    await tick();
    expect(app.getState().inboxItems).toEqual(items);
    expect(transport.toRenderer.some((m) => m.channel === 'inbox:update')).toBe(true);

    const task = { id: 't1', projectId: 'p1', objective: 'do thing', state: 'Running', agentIds: [], sessionIds: [], createdAt: '', updatedAt: '', eventCount: 0 };
    server.push({ type: 'task:update', task });
    await tick();
    expect(app.getState().activeTask).toEqual(task);
    expect(transport.toRenderer.some((m) => m.channel === 'task:update')).toBe(true);

    const metrics = { timestamp: 'now', counters: { eventsEmitted: {}, tasksStarted: 0, tasksCompleted: 0, tasksFailed: 0, approvalsRequested: 0, approvalsGranted: 0, approvalsDenied: 0, toolsInvoked: {} }, gauges: { activeSessions: 0, pendingApprovals: 0, inboxSize: 0, attentionItemsPending: 0 }, histograms: { taskDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} }, approvalResponseTime: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} }, toolDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} } } };
    server.push({ type: 'metrics:update', snapshot: metrics });
    await tick();
    expect(app.getState().metrics).toEqual(metrics);
    expect(transport.toRenderer.some((m) => m.channel === 'metrics:update')).toBe(true);

    // approval/request, digest:update, voice:state are forwarded but not stored.
    server.push({ type: 'approval:request', approvalId: 'a1' });
    server.push({ type: 'digest:update', summary: 'done' });
    server.push({ type: 'voice:state', listening: true });
    await tick();
    expect(transport.toRenderer.some((m) => m.channel === 'approval:request')).toBe(true);
    expect(transport.toRenderer.some((m) => m.channel === 'digest:update')).toBe(true);
    expect(transport.toRenderer.some((m) => m.channel === 'voice:state')).toBe(true);

    // Unknown push type is ignored.
    server.push({ type: 'unknown-type' });
    await tick();
    // No new renderer messages beyond what we already checked.
    expect(transport.toRenderer.filter((m) => m.channel === 'inbox:update')).toHaveLength(1);
  });

  it('disconnect closes the socket and resets state', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await conn;
    expect(app.isConnected).toBe(true);
    await app.disconnect();
    expect(app.isConnected).toBe(false);
    expect(app.getState().connected).toBe(false);
    expect(app.getState().daemonStatus).toBe('disconnected');
  });

  it('stop disconnects, disposes IPC bridge, and closes window', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await conn;
    await app.stop();
    expect(app.isStarted).toBe(false);
    expect(window.isClosed()).toBe(true);
    expect(app.ipc.isDisposed).toBe(true);
  });

  it('connection failure sets error state and rejects with DesktopConnectionError', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport, connectTimeoutMs: 500 });
    app.start();
    // Connect to a port that is not listening.
    await expect(app.connectToDaemon('ws://127.0.0.1:1')).rejects.toThrow(DesktopConnectionError);
    expect(app.getState().daemonStatus).toBe('error');
    expect(app.getState().connected).toBe(false);
    expect(app.getState().error).toBeTruthy();
  });

  it('connection timeout rejects with DesktopConnectionError', async () => {
    // A raw TCP server that accepts the connection but never completes the
    // WebSocket upgrade handshake, so the client's 'open' never fires and the
    // connect timeout triggers.
    const stall = net.createServer((socket) => {
      // Hold the socket open without responding to the HTTP upgrade request.
      socket.resume();
    });
    await new Promise<void>((resolve) => stall.listen(0, resolve));
    const port = (stall.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}`;

    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: new MockIpcTransport(),
      connectTimeoutMs: 300,
    });
    app.start();
    await expect(app.connectToDaemon(url)).rejects.toThrow(DesktopConnectionError);
    expect(app.getState().daemonStatus).toBe('error');
    await new Promise<void>((resolve) => stall.close(() => resolve()));
  });

  it('sendCommand rejects when not connected', async () => {
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: new MockIpcTransport(),
    });
    await expect(app.sendCommand({ kind: 'shutdown' })).rejects.toThrow(DesktopConnectionError);
  });

  it('sendCommand sends a command and resolves with the daemon response', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    socket.on('message', (data) => {
      const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
      const parsed = JSON.parse(text) as { kind: string };
      socket.send(JSON.stringify({ ok: true, items: [parsed.kind] }));
    });
    const res = await app.sendCommand({ kind: 'query-inbox' });
    expect(res.ok).toBe(true);
  });

  it('daemon socket close updates state to disconnected', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    // Wait for the state to flip to disconnected after the server closes.
    const disconnected = waitForState(app, (s) => !s.connected);
    socket.close();
    await disconnected;
    expect(app.getState().connected).toBe(false);
    expect(app.getState().daemonStatus).toBe('disconnected');
  });

  it('windowOptions are passed through to createWindow', () => {
    const window = new MockWindowBackend();
    const opts: WindowOptions = { width: 400, height: 300, title: 'Mini', alwaysOnTop: true };
    const app = new DesktopApp({ window, ipcTransport: new MockIpcTransport(), windowOptions: opts });
    app.start();
    expect(window.windowOptions.width).toBe(400);
    expect(window.windowOptions.title).toBe('Mini');
    expect(window.windowOptions.alwaysOnTop).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Wait one macrotask so async socket messages flush. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Resolve once the app state satisfies the predicate (or timeout). */
function waitForState(
  app: DesktopApp,
  predicate: (s: ReturnType<DesktopApp['getState']>) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  if (predicate(app.getState())) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`waitForState timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = app.onStateChange((s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}
