import * as net from 'node:net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';

import {
  DesktopApp,
  DesktopConnectionError,
  IpcBridge,
  IpcError,
  IPC_CHANNELS,
  MockIpcTransport,
  MockWindowBackend,
  MockTrayBackend,
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

  /** Abruptly drop the connected client while keeping the server listening. */
  dropClient(): void {
    this.client?.terminate();
    this.client = null;
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
    const items = [
      {
        id: 'a',
        taskId: 't',
        kind: 'k',
        priority: 'low',
        status: 'pending',
        createdAt: '',
        payload: {},
      },
    ];
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
  it('IPC_CHANNELS contains the required channels', () => {
    expect(IPC_CHANNELS).toEqual([
      'inbox:update',
      'task:update',
      'approval:request',
      'digest:update',
      'metrics:update',
      'voice:state',
      'daemon:status',
      'inspector:update',
      'view:show',
      'fleet:update',
      'hud:state',
      'command',
      'command:result',
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
      {
        id: 'i1',
        taskId: 't1',
        kind: 'approval',
        priority: 'critical',
        status: 'pending',
        createdAt: 'now',
        payload: {},
      },
    ];
    server.push({ type: 'inbox:update', items });
    await waitFor(() => app.getState().inboxItems.length === items.length);
    expect(app.getState().inboxItems).toEqual(items);
    expect(transport.toRenderer.some((m) => m.channel === 'inbox:update')).toBe(true);

    const task = {
      id: 't1',
      projectId: 'p1',
      objective: 'do thing',
      state: 'Running',
      agentIds: [],
      sessionIds: [],
      createdAt: '',
      updatedAt: '',
      eventCount: 0,
    };
    server.push({ type: 'task:update', task });
    await waitFor(() => app.getState().activeTask !== null);
    expect(app.getState().activeTask).toEqual(task);
    expect(transport.toRenderer.some((m) => m.channel === 'task:update')).toBe(true);

    const metrics = {
      timestamp: 'now',
      counters: {
        eventsEmitted: {},
        tasksStarted: 0,
        tasksCompleted: 0,
        tasksFailed: 0,
        approvalsRequested: 0,
        approvalsGranted: 0,
        approvalsDenied: 0,
        toolsInvoked: {},
      },
      gauges: { activeSessions: 0, pendingApprovals: 0, inboxSize: 0, attentionItemsPending: 0 },
      histograms: {
        taskDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
        approvalResponseTime: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
        toolDuration: { count: 0, min: 0, max: 0, mean: 0, sum: 0, buckets: {} },
      },
    };
    server.push({ type: 'metrics:update', snapshot: metrics });
    await waitFor(() => app.getState().metrics !== null);
    expect(app.getState().metrics).toEqual(metrics);
    expect(transport.toRenderer.some((m) => m.channel === 'metrics:update')).toBe(true);

    // approval:request and digest:update are forwarded but not stored.
    server.push({ type: 'approval:request', approvalId: 'a1' });
    server.push({ type: 'digest:update', summary: 'done' });
    await waitFor(
      () =>
        transport.toRenderer.some((m) => m.channel === 'approval:request') &&
        transport.toRenderer.some((m) => m.channel === 'digest:update'),
    );

    // voice:state is forwarded AND mirrored into renderer state.
    server.push({
      type: 'voice:state',
      listening: true,
      speaking: false,
      muted: false,
      mode: 'wake-word',
    });
    await waitFor(() => app.getState().voiceState.listening === true);
    expect(transport.toRenderer.some((m) => m.channel === 'voice:state')).toBe(true);
    expect(app.getState().voiceState).toEqual({
      listening: true,
      speaking: false,
      muted: false,
      mode: 'wake-word',
    });

    // Unknown push type is ignored. ws frames are ordered, so once a
    // subsequent known push is processed the unknown one was handled already.
    server.push({ type: 'unknown-type' });
    server.push({ type: 'digest:update', summary: 'again' });
    await waitFor(
      () => transport.toRenderer.filter((m) => m.channel === 'digest:update').length === 2,
    );
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
    // Connect to a port that is not listening. The first attempt rejects
    // and the app drops into the auto-reconnect loop (#122): status is
    // 'reconnecting' and the last error stays readable in state.
    await expect(app.connectToDaemon('ws://127.0.0.1:1')).rejects.toThrow(DesktopConnectionError);
    expect(app.getState().daemonStatus).toBe('reconnecting');
    expect(app.getState().connected).toBe(false);
    expect(app.getState().error).toBeTruthy();
    await app.disconnect();
    expect(app.getState().daemonStatus).toBe('disconnected');
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
    expect(app.getState().daemonStatus).toBe('reconnecting');
    await app.disconnect();
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

  it('daemon socket close flips to reconnecting, then disconnect stops retries', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window, ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    // Wait for the state to leave 'connected' after the server closes —
    // the app now reports 'reconnecting' instead of dying (#122).
    const dropped = waitForState(app, (s) => !s.connected);
    socket.close();
    await dropped;
    expect(app.getState().connected).toBe(false);
    expect(app.getState().daemonStatus).toBe('reconnecting');
    await app.disconnect();
    expect(app.getState().daemonStatus).toBe('disconnected');
  });

  it('windowOptions are passed through to createWindow', () => {
    const window = new MockWindowBackend();
    const opts: WindowOptions = { width: 400, height: 300, title: 'Mini', alwaysOnTop: true };
    const app = new DesktopApp({
      window,
      ipcTransport: new MockIpcTransport(),
      windowOptions: opts,
    });
    app.start();
    expect(window.windowOptions.width).toBe(400);
    expect(window.windowOptions.title).toBe('Mini');
    expect(window.windowOptions.alwaysOnTop).toBe(true);
  });

  /* ---------------------------------------------------------------- *
   * System tray integration (issue #28)
   * ---------------------------------------------------------------- */
  it('creates the system tray on start when a tray backend is supplied', () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const trayBackend = new MockTrayBackend();
    const app = new DesktopApp({ window, ipcTransport: transport, trayBackend });
    app.start();
    expect(trayBackend.isActive).toBe(true);
    expect(trayBackend.tooltip).toContain('Disconnected');
    expect(app.trayManager).not.toBeNull();
  });

  it('does not create a tray when no tray backend is supplied', () => {
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: new MockIpcTransport(),
    });
    app.start();
    expect(app.trayManager).toBeNull();
  });

  it('mirrors daemon connection status into the tray', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const trayBackend = new MockTrayBackend();
    const app = new DesktopApp({ window, ipcTransport: transport, trayBackend });
    app.start();
    expect(trayBackend.tooltip).toContain('Disconnected');
    const connecting = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await connecting;
    expect(trayBackend.tooltip).toContain('Connected');
    expect(trayBackend.menu.find((i) => i.id === 'status')!.label).toBe('Daemon: Connected');
  });

  it('forwards tray quick actions to the onTrayAction callback', () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const trayBackend = new MockTrayBackend();
    const onTrayAction = vi.fn();
    const app = new DesktopApp({
      window,
      ipcTransport: transport,
      trayBackend,
      onTrayAction,
    });
    app.start();
    trayBackend.click('quit');
    expect(onTrayAction).toHaveBeenCalledWith('quit');
    trayBackend.click('open-inbox');
    expect(onTrayAction).toHaveBeenCalledWith('open-inbox');
  });

  it('destroys the tray on stop', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const trayBackend = new MockTrayBackend();
    const app = new DesktopApp({ window, ipcTransport: transport, trayBackend });
    app.start();
    expect(trayBackend.isActive).toBe(true);
    await app.stop();
    expect(trayBackend.isDestroyed).toBe(true);
  });

  it('mirrors error status into the tray on connection failure', async () => {
    const window = new MockWindowBackend();
    const transport = new MockIpcTransport();
    const trayBackend = new MockTrayBackend();
    const app = new DesktopApp({ window, ipcTransport: transport, trayBackend });
    app.start();
    // Connect to a port that is not listening -> reconnect loop (#122).
    await expect(app.connectToDaemon('ws://127.0.0.1:1')).rejects.toBeDefined();
    expect(trayBackend.tooltip).toContain('Reconnecting');
    await app.disconnect();
  });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Poll until the predicate holds (or timeout). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

/* ================================================================== *
 * Renderer command round-trip (issue #121)
 * ================================================================== */

describe('handleRendererCommand', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  function seededApp(transport: MockIpcTransport): DesktopApp {
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    return app;
  }

  it('resolves approve:<itemId> to a typed approve command and relays the response', async () => {
    const transport = new MockIpcTransport();
    const app = seededApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;

    // Seed inbox state via a push so resolveRendererCommand can find the item.
    socket.send(
      JSON.stringify({
        type: 'inbox:update',
        items: [
          {
            id: 'attn_1',
            taskId: 'task_9',
            kind: 'ApprovalRequest',
            priority: 'High',
            status: 'Pending',
            createdAt: '2026-09-16T10:00:00Z',
            payload: { approvalId: 'ap_77' },
          },
        ],
      }),
    );
    await waitForState(app, (s) => s.inboxItems.length === 1);

    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'approve') {
        expect(cmd).toMatchObject({
          taskId: 'task_9',
          approvalId: 'ap_77',
          decision: 'grant',
        });
        socket.send(JSON.stringify({ ok: true }));
      }
    });

    await app.handleRendererCommand({ id: 1, cmd: 'approve:attn_1' });
    const result = transport.toRenderer.find((m) => m.channel === 'command:result');
    expect(result?.data).toEqual({ id: 1, res: { ok: true } });
  });

  it('deny:<itemId> maps to decision deny', async () => {
    const transport = new MockIpcTransport();
    const app = seededApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    socket.send(
      JSON.stringify({
        type: 'inbox:update',
        items: [
          {
            id: 'attn_2',
            taskId: 'task_5',
            kind: 'ApprovalRequest',
            priority: 'High',
            status: 'Pending',
            createdAt: '2026-09-16T10:00:00Z',
            payload: { approvalId: 'ap_5' },
          },
        ],
      }),
    );
    await waitForState(app, (s) => s.inboxItems.length === 1);
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'approve') {
        expect(cmd['decision']).toBe('deny');
        socket.send(JSON.stringify({ ok: true }));
      }
    });
    await app.handleRendererCommand({ id: 2, cmd: 'deny:attn_2' });
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 2,
      res: { ok: true },
    });
  });

  it('returns an error result when the item has no pending approval', async () => {
    const transport = new MockIpcTransport();
    const app = seededApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await conn;
    await app.handleRendererCommand({ id: 3, cmd: 'approve:attn_missing' });
    const result = transport.toRenderer.find((m) => m.channel === 'command:result');
    expect((result?.data as { res: { ok: boolean } }).res.ok).toBe(false);
  });

  it('acknowledges UI-only verbs without hitting the daemon', async () => {
    const transport = new MockIpcTransport();
    const app = seededApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    let sawCommand = false;
    socket.on('message', () => {
      sawCommand = true;
    });
    await app.handleRendererCommand({ id: 4, cmd: 'inspect:attn_1' });
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 4,
      res: { ok: true },
    });
    expect(sawCommand).toBe(false);
  });
});

/* ================================================================== *
 * Auto-reconnect / offline UX (issue #122)
 * ================================================================== */

describe('reconnect', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  function fastApp(transport: MockIpcTransport): DesktopApp {
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: transport,
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 80,
    });
    app.start();
    return app;
  }

  it('reports reconnecting after a drop, then re-syncs when the daemon returns', async () => {
    const transport = new MockIpcTransport();
    const app = fastApp(transport);
    const first = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await first;
    socket.on('message', () => {}); // drain
    server.dropClient();

    await waitForState(app, (s) => s.daemonStatus === 'reconnecting');

    const second = server.waitForConnection();
    const socket2 = await second;
    socket2.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as { kind?: string };
      if (cmd.kind === 'query-inbox') socket2.send(JSON.stringify({ ok: true, items: [] }));
      else if (cmd.kind !== undefined) socket2.send(JSON.stringify({ ok: true }));
    });
    await waitForState(app, (s) => s.daemonStatus === 'connected' && s.connected);
    // Resync pushed a fresh tree to the renderer.
    await waitFor(() => transport.toRenderer.some((m) => m.channel === 'inbox:update'));
    await app.disconnect();
  });

  it('keeps last-known inbox items readable while reconnecting', async () => {
    const transport = new MockIpcTransport();
    const app = fastApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    socket.send(
      JSON.stringify({
        type: 'inbox:update',
        items: [
          {
            id: 'attn_keep',
            taskId: 't1',
            kind: 'Failure',
            priority: 'Normal',
            status: 'Pending',
            createdAt: '2026-09-16T10:00:00Z',
            payload: {},
          },
        ],
      }),
    );
    await waitForState(app, (s) => s.inboxItems.length === 1);
    server.dropClient();
    await waitForState(app, (s) => s.daemonStatus === 'reconnecting');
    expect(app.getState().inboxItems).toHaveLength(1);
    await app.disconnect();
  });

  it('retries an unreachable daemon until it comes up', async () => {
    const transport = new MockIpcTransport();
    const app = fastApp(transport);
    const dead = new MockDaemonServer();
    await dead.start();
    const url = dead.url;
    const port = dead.actualPort;
    await dead.close(); // port now refuses connections

    const attempt = app.connectToDaemon(url);
    await expect(attempt).rejects.toThrow(DesktopConnectionError);
    await waitForState(app, (s) => s.daemonStatus === 'reconnecting');

    const revived = new MockDaemonServer(port);
    await revived.start();
    const conn = revived.waitForConnection();
    const socket = await conn;
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as { kind?: string };
      if (cmd.kind === 'query-inbox') socket.send(JSON.stringify({ ok: true, items: [] }));
      else if (cmd.kind !== undefined) socket.send(JSON.stringify({ ok: true }));
    });
    await waitForState(app, (s) => s.daemonStatus === 'connected' && s.connected, 5000);
    await app.disconnect();
    await revived.close();
  });

  it('an explicit disconnect cancels the retry loop', async () => {
    const transport = new MockIpcTransport();
    const app = fastApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await conn;
    await app.disconnect();
    expect(app.getState().daemonStatus).toBe('disconnected');
    server.dropClient();
    // Give any pending timer a chance to fire — none should be pending.
    await new Promise((r) => setTimeout(r, 120));
    let reconnects = 0;
    void server.waitForConnection().then(() => {
      reconnects += 1;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(reconnects).toBe(0);
    expect(app.getState().daemonStatus).toBe('disconnected');
  });
});

/* ================================================================== *
 * Close-to-tray (issue #125)
 * ================================================================== */

describe('close-to-tray', () => {
  it('close request hides the window instead of closing when enabled', () => {
    const window = new MockWindowBackend();
    const trayBackend = new MockTrayBackend();
    const app = new DesktopApp({
      window,
      ipcTransport: new MockIpcTransport(),
      trayBackend,
      closeToTray: true,
    });
    app.start();
    window.close();
    expect(window.isClosed()).toBe(false);
    expect(window.isVisible()).toBe(false);
    expect(window.log).toContain('close-vetoed');
    // Tray + HUD keep the app alive — app is still started.
    expect(app.isStarted).toBe(true);
  });

  it('stop() bypasses the interceptor and really closes', async () => {
    const window = new MockWindowBackend();
    const app = new DesktopApp({
      window,
      ipcTransport: new MockIpcTransport(),
      trayBackend: new MockTrayBackend(),
      closeToTray: true,
    });
    app.start();
    await app.stop();
    expect(window.isClosed()).toBe(true);
    expect(app.isStarted).toBe(false);
  });

  it('a vetoed window can be shown again from the tray', () => {
    const window = new MockWindowBackend();
    const trayBackend = new MockTrayBackend();
    const shown: string[] = [];
    const app = new DesktopApp({
      window,
      ipcTransport: new MockIpcTransport(),
      trayBackend,
      closeToTray: true,
      onTrayAction: (a) => shown.push(a),
    });
    app.start();
    window.close();
    expect(window.isVisible()).toBe(false);
    trayBackend.click('show-window');
    expect(shown).toEqual(['show-window']);
    window.show();
    expect(window.isVisible()).toBe(true);
  });

  it('without closeToTray, close() closes normally', () => {
    const window = new MockWindowBackend();
    const app = new DesktopApp({ window, ipcTransport: new MockIpcTransport() });
    app.start();
    window.close();
    expect(window.isClosed()).toBe(true);
  });
});

/* ================================================================== *
 * Session inspector (issue #126)
 * ================================================================== */

describe('session inspector', () => {
  let server: MockDaemonServer;

  const EVENTS = [
    {
      id: 'e1',
      sessionId: 's1',
      taskId: 'task_1',
      timestamp: '2026-01-01T10:00:00Z',
      kind: 'AgentStarted',
      payload: { agentId: 'codex' },
    },
    {
      id: 'e2',
      sessionId: 's1',
      taskId: 'task_1',
      timestamp: '2026-01-01T10:00:05Z',
      kind: 'ToolFinished',
      payload: { toolName: 'bash' },
    },
  ];

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  /** Connect an app whose mock daemon answers query-events with EVENTS. */
  async function connectedApp(transport: MockIpcTransport): Promise<DesktopApp> {
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'query-events') {
        socket.send(JSON.stringify({ ok: true, taskId: cmd['taskId'], events: EVENTS }));
      } else if (cmd['kind'] === 'list-tasks') {
        socket.send(
          JSON.stringify({
            ok: true,
            tasks: [
              {
                id: 'task_1',
                projectId: 'p1',
                objective: 'do the thing',
                state: 'running',
                agentIds: ['codex'],
                sessionIds: ['s1'],
                createdAt: '2026-01-01T09:00:00Z',
                updatedAt: '2026-01-01T09:30:00Z',
                eventCount: 2,
              },
            ],
          }),
        );
      } else if (cmd['kind'] === 'query-inbox') {
        socket.send(JSON.stringify({ ok: true, items: [] }));
      }
    });
    return app;
  }

  function findAll(node: unknown, tag: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const walk = (n: unknown): void => {
      if (typeof n !== 'object' || n === null) return;
      const r = n as Record<string, unknown>;
      if (r['tag'] === tag) out.push(r);
      for (const c of (r['children'] as unknown[]) ?? []) walk(c);
    };
    walk(node);
    return out;
  }

  it('inspect-task:<id> pulls query-events and pushes the 3-column tree', async () => {
    const transport = new MockIpcTransport();
    const app = await connectedApp(transport);
    let sawQuery = false;
    const socket = await new Promise<WebSocket>((resolve) => {
      // the connected socket is already known; grab it via a fresh listener
      resolve((server as unknown as { client: WebSocket }).client);
    });
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'query-events' && cmd['taskId'] === 'task_1') sawQuery = true;
    });

    await app.handleRendererCommand({ id: 10, cmd: 'inspect-task:task_1' });

    expect(sawQuery).toBe(true);
    expect(transport.toRenderer.some((m) => m.channel === 'view:show' && m.data === 'tasks')).toBe(
      true,
    );
    const push = transport.toRenderer.filter((m) => m.channel === 'inspector:update').pop();
    expect(push).toBeDefined();
    const tree = push!.data as Record<string, unknown>;
    expect(tree['tag']).toBe('Inspector');
    expect(findAll(tree, 'InspectorCol')).toHaveLength(3);
    const timeline = findAll(tree, 'InspRow').filter((r) =>
      String((r['props'] as Record<string, unknown>)['command'] ?? '').startsWith('inspect-event:'),
    );
    expect(timeline).toHaveLength(2);
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 10,
      res: { ok: true },
    });
    await app.disconnect();
  });

  it('inspect-event:<i> selects the row locally and re-pushes detail', async () => {
    const transport = new MockIpcTransport();
    const app = await connectedApp(transport);
    await app.handleRendererCommand({ id: 11, cmd: 'inspect-task:task_1' });
    const before = transport.toRenderer.filter((m) => m.channel === 'inspector:update').length;

    await app.handleRendererCommand({ id: 12, cmd: 'inspect-event:1' });

    const pushes = transport.toRenderer.filter((m) => m.channel === 'inspector:update');
    expect(pushes.length).toBe(before + 1);
    const tree = pushes[pushes.length - 1].data as Record<string, unknown>;
    const rows = findAll(tree, 'InspRow').filter((r) =>
      String((r['props'] as Record<string, unknown>)['command'] ?? '').startsWith('inspect-event:'),
    );
    expect((rows[1]['props'] as Record<string, unknown>)['selected']).toBe(true);
    const cols = findAll(tree, 'InspectorCol');
    expect(String((cols[2]['props'] as Record<string, unknown>)['title'])).toContain(
      'ToolFinished',
    );
    const results = transport.toRenderer.filter((m) => m.channel === 'command:result');
    expect(results.map((m) => m.data)).toContainEqual({ id: 12, res: { ok: true } });
    await app.disconnect();
  });

  it('inspect-event out of range returns an error result', async () => {
    const transport = new MockIpcTransport();
    const app = await connectedApp(transport);
    await app.handleRendererCommand({ id: 13, cmd: 'inspect-task:task_1' });
    await app.handleRendererCommand({ id: 14, cmd: 'inspect-event:9' });
    const results = transport.toRenderer.filter((m) => m.channel === 'command:result');
    expect(results.map((m) => m.data)).toContainEqual(
      expect.objectContaining({ id: 14, res: expect.objectContaining({ ok: false }) }),
    );
    await app.disconnect();
  });

  it('approval:inspect:<cap>:<dest> resolves the matching inbox item', async () => {
    const transport = new MockIpcTransport();
    const app = await connectedApp(transport);
    const socket = (server as unknown as { client: WebSocket }).client;
    socket.send(
      JSON.stringify({
        type: 'inbox:update',
        items: [
          {
            id: 'attn_9',
            taskId: 'task_1',
            kind: 'ApprovalRequest',
            priority: 'High',
            status: 'Pending',
            createdAt: '2026-01-01T10:00:00Z',
            payload: { capability: 'net', destination: 'registry.npmjs.org', approvalId: 'ap_9' },
          },
        ],
      }),
    );
    await waitForState(app, (s) => s.inboxItems.length === 1);

    await app.handleRendererCommand({
      id: 15,
      cmd: 'approval:inspect:net:registry.npmjs.org',
    });

    expect(transport.toRenderer.some((m) => m.channel === 'view:show' && m.data === 'tasks')).toBe(
      true,
    );
    const push = transport.toRenderer.filter((m) => m.channel === 'inspector:update').pop();
    expect(push).toBeDefined();
    const results15 = transport.toRenderer.filter((m) => m.channel === 'command:result');
    expect(results15.map((m) => m.data)).toContainEqual({ id: 15, res: { ok: true } });
    await app.disconnect();
  });

  it('approval:inspect with no matching item returns an error', async () => {
    const transport = new MockIpcTransport();
    const app = await connectedApp(transport);
    await app.handleRendererCommand({ id: 16, cmd: 'approval:inspect:net:nope.example' });
    const result = transport.toRenderer.find((m) => m.channel === 'command:result')?.data as {
      res: { ok: boolean; error?: string };
    };
    expect(result.res.ok).toBe(false);
    await app.disconnect();
  });
});

/* ================================================================== *
 * PTT pill toggle (HUD merged into the main window)
 * ================================================================== */

describe('ptt:toggle command', () => {
  it('invokes the onPttToggle hook and acknowledges', async () => {
    const transport = new MockIpcTransport();
    const onPttToggle = vi.fn();
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: transport,
      onPttToggle,
    });
    app.start();
    await app.handleRendererCommand({ id: 20, cmd: 'ptt:toggle' });
    expect(onPttToggle).toHaveBeenCalledTimes(1);
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 20,
      res: { ok: true },
    });
    await app.stop();
  });
});

/* ================================================================== *
 * Fleet/quota screen (issue #127)
 * ================================================================== */

describe('fleet screen', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it('refreshNow pulls query-fleet and pushes the fleet:update tree', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    let sawFleetQuery = false;
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'query-fleet') {
        sawFleetQuery = true;
        socket.send(
          JSON.stringify({
            ok: true,
            providers: [
              {
                provider: 'codex',
                available: true,
                exhaustedUntil: null,
                usedPct: 0.62,
                resetsAt: '2026-01-01T18:00:00Z',
                lastObservedAt: '2026-01-01T14:00:00Z',
              },
            ],
            parked: [
              {
                taskId: 'task_1',
                objective: 'image-pipeline',
                reason: 'all candidate providers exhausted',
                resumeAt: '2026-01-01T14:32:00Z',
              },
            ],
            routingDecisions: [
              {
                taskId: 'task_1',
                objective: 'image-pipeline',
                kind: 'TaskFailedOver',
                summary: 'image-pipeline → codex: gemini exhausted',
                timestamp: '2026-01-01T13:58:00Z',
              },
            ],
          }),
        );
      } else {
        socket.send(JSON.stringify({ ok: true, items: [], tasks: [] }));
      }
    });

    await app.refreshNow();

    expect(sawFleetQuery).toBe(true);
    const push = transport.toRenderer.filter((m) => m.channel === 'fleet:update').pop();
    expect(push).toBeDefined();
    const tree = push!.data as Record<string, unknown>;
    expect(tree['tag']).toBe('FleetView');
    const findAll = (n: unknown, tag: string, out: unknown[] = []): unknown[] => {
      if (typeof n !== 'object' || n === null) return out;
      const r = n as Record<string, unknown>;
      if (r['tag'] === tag) out.push(r);
      for (const c of (r['children'] as unknown[]) ?? []) findAll(c, tag, out);
      return out;
    };
    expect(findAll(tree, 'FleetCard')).toHaveLength(1);
    // Parked section rendered.
    const titles = findAll(tree, 'InspRowTitle').map((r) =>
      String((r as Record<string, unknown>)['children']?.[0] ?? ''),
    );
    expect(titles).toContain('image-pipeline');
    expect(titles).toContain('image-pipeline → codex: gemini exhausted');
    await app.disconnect();
  });
});
