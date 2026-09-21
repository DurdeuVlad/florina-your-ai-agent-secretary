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
import type {
  DesktopSettingsShape,
  DesktopSettingsStore,
  IpcChannel,
  WindowOptions,
} from '../src/desktop/index.js';
import { DictationService } from '../src/core/application/use-cases/voice/dictation-service.js';

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
      'prefs:update',
      'ideas:update',
      'history:update',
      'history:search-results',
      'memory:update',
      'repos:update',
      'secretary:update',
      'chat:update',
      'chat:activity',
      'dictation:capture',
      'dictation:audio',
      'dictation:audio-out',
      'dictation:update',
      'voice:update',
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
      processing: false,
      mode: 'wake-word',
      transcript: undefined,
      responsePreview: undefined,
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
  it('acknowledges and pushes an honest error when no voice engine exists', async () => {
    const transport = new MockIpcTransport();
    const onPttToggle = vi.fn();
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: transport,
      onPttToggle,
    });
    app.start();
    await app.handleRendererCommand({ id: 20, cmd: 'ptt:toggle' });
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 20,
      res: { ok: true },
    });
    // No engine → the HUD hook never fires; the renderer sees the error.
    expect(onPttToggle).not.toHaveBeenCalled();
    const err = transport.toRenderer.find((m) => m.channel === 'dictation:update');
    expect((err?.data as { state: string }).state).toBe('error');
    await app.stop();
  });

  it('drives a real dictation round and reports the listening state to the HUD', async () => {
    const transport = new MockIpcTransport();
    const onPttToggle = vi.fn();
    const dictation = new DictationService({
      transport: {
        startCapture: () => undefined,
        stopCapture: () => undefined,
        play: () => undefined,
        stopPlayback: () => undefined,
        close: () => undefined,
      },
      session: {
        isConnected: false,
        currentState: 'idle' as const,
        connect: async () => undefined,
        disconnect: async () => undefined,
        startListening: () => undefined,
        stopListening: () => undefined,
        sendToolCallOutput: () => undefined,
        sendUserMessage: () => undefined,
        onToolCall: () => () => undefined,
        onTranscript: () => () => undefined,
        onStateChange: () => () => undefined,
      },
      apiKey: 'sk-test',
      finalTimeoutMs: 50,
      onUpdate: () => undefined,
      onTranscript: () => undefined,
    });
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: transport,
      dictation,
      onPttToggle,
    });
    app.start();
    await app.handleRendererCommand({ id: 21, cmd: 'ptt:toggle' });
    // pttToggle is async — the dictation start resolves on a microtask.
    await vi.waitFor(() => expect(onPttToggle).toHaveBeenCalledWith(true));
    expect(dictation.currentState).toBe('listening');
    await app.handleRendererCommand({ id: 22, cmd: 'ptt:toggle' });
    await vi.waitFor(() => expect(onPttToggle).toHaveBeenLastCalledWith(false));
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

/* ================================================================== *
 * Preferences screen (issue #128)
 * ================================================================== */

describe('preferences screen', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  const PREF_PROFILE = {
    rules: [
      { provider: 'codex', note: 'prefer Codex for heavy lifting' },
      {
        provider: 'devin',
        workTypes: ['migration'],
        projectId: 'agent-secretary',
        note: 'use Devin for migrations in this repo',
      },
    ],
    denied: [{ provider: 'gemini', note: 'too flaky' }],
  };

  function findAll(node: unknown, tag: string, out: unknown[] = []): unknown[] {
    if (typeof node !== 'object' || node === null) return out;
    const r = node as Record<string, unknown>;
    if (r['tag'] === tag) out.push(r);
    for (const c of (r['children'] as unknown[]) ?? []) findAll(c, tag, out);
    return out;
  }

  it('refreshNow pulls query-preferences and pushes the prefs:update tree', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    let sawPrefsQuery = false;
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'query-preferences') {
        sawPrefsQuery = true;
        socket.send(JSON.stringify({ ok: true, profile: PREF_PROFILE }));
      } else {
        socket.send(JSON.stringify({ ok: true, items: [], tasks: [] }));
      }
    });

    await app.refreshNow();

    expect(sawPrefsQuery).toBe(true);
    const push = transport.toRenderer.filter((m) => m.channel === 'prefs:update').pop();
    expect(push).toBeDefined();
    const tree = push!.data as Record<string, unknown>;
    expect(tree['tag']).toBe('PrefsView');
    expect(findAll(tree, 'PrefCard')).toHaveLength(3);
    await app.disconnect();
  });

  it('routes a prefcmd: revoke through the daemon as update-preference', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    const seen: Record<string, unknown>[] = [];
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      seen.push(cmd);
      socket.send(JSON.stringify({ ok: true, items: [], tasks: [], profile: PREF_PROFILE }));
    });

    const payload = {
      kind: 'update-preference',
      action: 'remove-rule',
      provider: 'devin',
      projectId: 'agent-secretary',
    };
    await app.handleRendererCommand({
      id: 'rev1',
      cmd: `prefcmd:${encodeURIComponent(JSON.stringify(payload))}`,
    });

    const result = transport.toRenderer.find(
      (m) => m.channel === 'command:result' && (m.data as { id?: unknown }).id === 'rev1',
    );
    expect(result).toBeDefined();
    expect((result!.data as { res: { ok: boolean } }).res.ok).toBe(true);
    const update = seen.find((c) => c['kind'] === 'update-preference');
    expect(update).toEqual(payload);
    await app.disconnect();
  });

  it('rejects malformed and non-preference prefcmd payloads without hitting the daemon', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    const seen: Record<string, unknown>[] = [];
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      seen.push(cmd);
      socket.send(JSON.stringify({ ok: true }));
    });

    await app.handleRendererCommand({ id: 'bad1', cmd: 'prefcmd:not-json%25' });
    await app.handleRendererCommand({
      id: 'bad2',
      cmd: `prefcmd:${encodeURIComponent(JSON.stringify({ kind: 'shutdown' }))}`,
    });

    const results = transport.toRenderer.filter(
      (m) =>
        m.channel === 'command:result' &&
        ['bad1', 'bad2'].includes(String((m.data as { id?: unknown }).id)),
    );
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect((r.data as { res: { ok: boolean } }).res.ok).toBe(false);
    }
    // Neither payload reached the daemon — only connect-time traffic did.
    expect(seen.filter((c) => c['kind'] !== 'subscribe')).toHaveLength(0);
    await app.disconnect();
  });

  it('re-pulls the profile after a committed update-preference mutation', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    let prefQueries = 0;
    const updated = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const cmd = JSON.parse(String(data)) as Record<string, unknown>;
        if (cmd['kind'] === 'query-preferences') {
          prefQueries += 1;
          if (prefQueries >= 2) resolve();
        }
        socket.send(
          JSON.stringify(
            cmd['kind'] === 'query-preferences'
              ? { ok: true, profile: PREF_PROFILE }
              : { ok: true, items: [], tasks: [] },
          ),
        );
      });
    });

    await app.refreshNow(); // first query-preferences
    const payload = { kind: 'update-preference', action: 'remove-deny', provider: 'gemini' };
    await app.handleRendererCommand({
      id: 'mut1',
      cmd: `prefcmd:${encodeURIComponent(JSON.stringify(payload))}`,
    });
    await updated; // mutation triggered a second pull
    expect(prefQueries).toBeGreaterThanOrEqual(2);
    await app.disconnect();
  });
});

/* ================================================================== *
 * Ideas screen (issue #129)
 * ================================================================== */

describe('ideas screen', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  const IDEA_LIST = {
    ok: true,
    ideas: [
      {
        id: 'idea-1',
        title: 'Multi-repo context sync',
        status: 'open',
        path: '/ideas/idea-1.md',
        createdAt: '2026-09-10T10:00:00Z',
        updatedAt: '2026-09-15T10:00:00Z',
        entryCount: 6,
        preview: 'capsule interface summary',
      },
    ],
  };
  const BRIEF_LIST = {
    ok: true,
    briefs: [
      {
        id: 'brief-1',
        ideaId: 'idea-1',
        title: 'Tray notification center',
        spec: 'frozen',
        plan: { projectId: 'agent-secretary', tasks: [{ objective: 'add tray badge' }] },
        status: 'draft',
        createdAt: '2026-09-15T09:00:00Z',
      },
    ],
  };

  function wireIdeasResponder(socket: import('ws').WebSocket): {
    seen: Record<string, unknown>[];
    ideaReads: number;
  } {
    const seen: Record<string, unknown>[] = [];
    const state = { seen, ideaReads: 0 };
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      seen.push(cmd);
      if (cmd['kind'] === 'idea-list') {
        socket.send(JSON.stringify(IDEA_LIST));
      } else if (cmd['kind'] === 'brief-list') {
        socket.send(JSON.stringify(BRIEF_LIST));
      } else if (cmd['kind'] === 'idea-read') {
        state.ideaReads += 1;
        socket.send(
          JSON.stringify({
            ok: true,
            idea: IDEA_LIST.ideas[0],
            body: '## Research\nnotes here',
          }),
        );
      } else {
        socket.send(
          JSON.stringify({ ok: true, items: [], tasks: [], profile: { rules: [], denied: [] } }),
        );
      }
    });
    return state;
  }

  function findAll(node: unknown, tag: string, out: unknown[] = []): unknown[] {
    if (typeof node !== 'object' || node === null) return out;
    const r = node as Record<string, unknown>;
    if (r['tag'] === tag) out.push(r);
    for (const c of (r['children'] as unknown[]) ?? []) findAll(c, tag, out);
    return out;
  }

  it('refreshNow pulls idea-list + brief-list and pushes the ideas:update tree', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    wireIdeasResponder(socket);

    await app.refreshNow();

    const push = transport.toRenderer.filter((m) => m.channel === 'ideas:update').pop();
    expect(push).toBeDefined();
    const tree = push!.data as Record<string, unknown>;
    const cards = findAll(tree, 'PrefCard');
    expect(cards).toHaveLength(2); // 1 open ledger + 1 draft brief
    await app.disconnect();
  });

  it('routes ideacmd: brief-confirm to the daemon and rejects other kinds', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    const { seen } = wireIdeasResponder(socket);

    const confirm = { kind: 'brief-confirm', briefId: 'brief-1', confirmedBy: 'desktop' };
    await app.handleRendererCommand({
      id: 'bc1',
      cmd: `ideacmd:${encodeURIComponent(JSON.stringify(confirm))}`,
    });
    const okRes = transport.toRenderer.find(
      (m) => m.channel === 'command:result' && (m.data as { id?: unknown }).id === 'bc1',
    );
    expect((okRes!.data as { res: { ok: boolean } }).res.ok).toBe(true);
    expect(seen.some((c) => c['kind'] === 'brief-confirm')).toBe(true);

    // A non-whitelisted kind never reaches the daemon.
    const before = seen.length;
    await app.handleRendererCommand({
      id: 'bc2',
      cmd: `ideacmd:${encodeURIComponent(JSON.stringify({ kind: 'shutdown' }))}`,
    });
    const badRes = transport.toRenderer.find(
      (m) => m.channel === 'command:result' && (m.data as { id?: unknown }).id === 'bc2',
    );
    expect((badRes!.data as { res: { ok: boolean } }).res.ok).toBe(false);
    expect(seen.length).toBe(before);
    await app.disconnect();
  });

  it('idearead opens the ledger reader and ideaclose clears it', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    const { ideaReads } = wireIdeasResponder(socket);
    void ideaReads;

    await app.refreshNow();
    transport.toRenderer.length = 0;

    await app.handleRendererCommand({ id: 'r1', cmd: 'idearead:idea-1' });
    // refreshViews is async — wait for the ideas:update carrying the body.
    await new Promise((r) => setTimeout(r, 100));
    const withReader = transport.toRenderer.filter((m) => m.channel === 'ideas:update').pop();
    const tree = withReader!.data as Record<string, unknown>;
    const flat = JSON.stringify(tree);
    expect(flat).toContain('notes here');
    expect(flat).toContain('Ledger — Multi-repo context sync');

    transport.toRenderer.length = 0;
    await app.handleRendererCommand({ id: 'r2', cmd: 'ideaclose' });
    await new Promise((r) => setTimeout(r, 100));
    const cleared = transport.toRenderer.filter((m) => m.channel === 'ideas:update').pop();
    expect(JSON.stringify(cleared!.data)).not.toContain('notes here');
    await app.disconnect();
  });
});

/* ================================================================== *
 * Voice session → HUD/inbox wiring (issue #131)
 * ================================================================== */

describe('voice session events → HUD state (issue #131)', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it('mirrors the daemon voice:state report into renderer voiceState', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await conn;
    server.autoRespond();

    server.push({
      type: 'voice:state',
      state: 'processing',
      transcript: 'ship the branch',
      responsePreview: 'On it.',
      mode: 'whisper',
    });
    await waitFor(() => app.getState().voiceState.processing === true);
    expect(app.getState().voiceState).toEqual({
      listening: false,
      speaking: false,
      processing: true,
      muted: false,
      mode: 'whisper',
      transcript: 'ship the branch',
      responsePreview: 'On it.',
    });
    // Forwarded verbatim to the renderer for any UI consumers.
    const fwd = transport.toRenderer.filter((m) => m.channel === 'voice:state').pop();
    expect(fwd?.data).toMatchObject({ state: 'processing', mode: 'whisper' });
    await app.disconnect();
  });

  it('maps listening/responding/idle reported states onto the flags', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await conn;
    server.autoRespond();

    server.push({ type: 'voice:state', state: 'listening' });
    await waitFor(() => app.getState().voiceState.listening === true);

    server.push({ type: 'voice:state', state: 'responding' });
    await waitFor(() => app.getState().voiceState.speaking === true);
    expect(app.getState().voiceState.listening).toBe(false);

    server.push({ type: 'voice:state', state: 'idle' });
    await waitFor(
      () =>
        app.getState().voiceState.speaking === false &&
        app.getState().voiceState.listening === false,
    );
    await app.disconnect();
  });

  it('voice-staged approvals arrive via the event stream and surface in the inbox', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;

    const approvalItem = {
      id: 'att-voice-1',
      taskId: 'task_voice',
      kind: 'ApprovalRequest',
      priority: 'High',
      status: 'Pending',
      createdAt: '2026-01-01T12:00:00Z',
      payload: {
        summary: 'Voice-staged: delete build output',
        capability: 'fs.delete',
        destination: 'dist/**',
        approvalId: 'appr-v1',
      },
    };
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'query-inbox') {
        socket.send(JSON.stringify({ ok: true, items: [approvalItem] }));
      } else {
        socket.send(JSON.stringify({ ok: true, items: [], tasks: [] }));
      }
    });

    // A voice tool call above low-risk scope stages an approval — the
    // daemon journals + publishes it as a SupervisorEvent, which the
    // desktop receives as an {type:'event'} push that triggers a refresh.
    server.push({
      type: 'event',
      event: {
        type: 'ApprovalRequested',
        timestamp: '2026-01-01T12:00:00Z',
        taskId: 'task_voice',
        sessionId: 'sess_v1',
        agentId: 'voice',
        adapterFidelityTier: 'A',
        approvalId: 'appr-v1',
        capability: 'fs.delete',
        destination: 'dist/**',
        reason: 'voice: delete build output',
      },
      seq: 42,
    });

    await waitFor(() =>
      transport.toRenderer.some(
        (m) => m.channel === 'inbox:update' && JSON.stringify(m.data).includes('att-voice-1'),
      ),
    );
    expect(app.getState().inboxItems.map((i) => i.id)).toContain('att-voice-1');
    await app.disconnect();
  });
});

/* ================================================================== *
 * Daemon lifecycle (issue #132)
 * ================================================================== */

describe('daemon lifecycle (issue #132)', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  function fastApp(transport: MockIpcTransport, onDaemonMissing?: () => void): DesktopApp {
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: transport,
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 80,
      ...(onDaemonMissing !== undefined ? { onDaemonMissing } : {}),
    });
    app.start();
    return app;
  }

  async function deadUrl(): Promise<string> {
    const dead = new MockDaemonServer();
    await dead.start();
    const url = dead.url;
    await dead.close();
    return url;
  }

  it('fires onDaemonMissing once when the daemon is absent at launch', async () => {
    const transport = new MockIpcTransport();
    const onMissing = vi.fn();
    const app = fastApp(transport, onMissing);
    const url = await deadUrl();

    await expect(app.connectToDaemon(url)).rejects.toThrow(DesktopConnectionError);
    expect(onMissing).toHaveBeenCalledTimes(1);
    await app.disconnect();
  });

  it('does not re-fire on subsequent failed retries — the spawn is once per intent', async () => {
    const transport = new MockIpcTransport();
    const onMissing = vi.fn();
    const app = fastApp(transport, onMissing);
    const url = await deadUrl();

    await expect(app.connectToDaemon(url)).rejects.toThrow(DesktopConnectionError);
    // Let several backoff retries run against the still-dead port.
    await new Promise((r) => setTimeout(r, 200));
    expect(onMissing).toHaveBeenCalledTimes(1);
    await app.disconnect();
  });

  it('does not fire on a successful connect', async () => {
    const transport = new MockIpcTransport();
    const onMissing = vi.fn();
    const app = fastApp(transport, onMissing);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    await conn;
    expect(onMissing).not.toHaveBeenCalled();
    await app.disconnect();
  });

  it('does not fire on a mid-session drop — a crash is not "missing"', async () => {
    const transport = new MockIpcTransport();
    const onMissing = vi.fn();
    const app = fastApp(transport, onMissing);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    socket.on('message', () => {});
    server.dropClient();
    await waitForState(app, (s) => s.daemonStatus === 'reconnecting');
    expect(onMissing).not.toHaveBeenCalled();
    await app.disconnect();
  });

  it('a new connectToDaemon intent re-arms the hook', async () => {
    const transport = new MockIpcTransport();
    const onMissing = vi.fn();
    const app = fastApp(transport, onMissing);
    const url = await deadUrl();

    await expect(app.connectToDaemon(url)).rejects.toThrow(DesktopConnectionError);
    await expect(app.connectToDaemon(url)).rejects.toThrow(DesktopConnectionError);
    expect(onMissing).toHaveBeenCalledTimes(2);
    await app.disconnect();
  });
});

/* ================================================================== *
 * Chat screen (issue #160) — chat:message/chat:event pushes, chatcmd:
 * verbs, and chat-read hydration on refresh.
 * ================================================================== */

describe('chat screen wiring', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  function chatApp(transport: MockIpcTransport): DesktopApp {
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    return app;
  }

  const userMsg = (id: string, content: string) => ({
    id,
    role: 'user',
    content,
    createdAt: '2026-01-01T00:00:00Z',
  });

  function lastChatTree(transport: MockIpcTransport): string {
    const pushes = transport.toRenderer.filter((m) => m.channel === 'chat:update');
    return JSON.stringify(pushes[pushes.length - 1]?.data ?? {});
  }

  it('chat:message pushes append to the mirrored history and push a tree', async () => {
    const transport = new MockIpcTransport();
    const app = chatApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;

    socket.send(
      JSON.stringify({ type: 'chat:message', message: userMsg('m1', 'hello secretary') }),
    );
    socket.send(
      JSON.stringify({
        type: 'chat:message',
        message: {
          id: 'm2',
          role: 'assistant',
          content: 'hi there',
          createdAt: '2026-01-01T00:00:01Z',
        },
      }),
    );
    // The same message pushed twice must not double-render.
    socket.send(
      JSON.stringify({ type: 'chat:message', message: userMsg('m1', 'hello secretary') }),
    );

    await waitFor(
      () => transport.toRenderer.filter((m) => m.channel === 'chat:update').length >= 3,
    );
    const text = lastChatTree(transport);
    expect(text.match(/hello secretary/g)).toHaveLength(1);
    expect(text).toContain('hi there');
    await app.disconnect();
  });

  it('chat:event tool_call sets the working row; completed clears it', async () => {
    const transport = new MockIpcTransport();
    const app = chatApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;

    socket.send(
      JSON.stringify({ type: 'chat:message', message: userMsg('m1', 'check the fleet') }),
    );
    socket.send(
      JSON.stringify({
        type: 'chat:event',
        event: {
          kind: 'tool_call',
          iteration: 1,
          name: 'query_fleet',
          callId: 'c1',
          arguments: {},
        },
      }),
    );
    await waitFor(() => lastChatTree(transport).includes('query_fleet'));
    expect(lastChatTree(transport)).toContain('Secretary is working');

    socket.send(
      JSON.stringify({ type: 'chat:event', event: { kind: 'completed', iterations: 2 } }),
    );
    socket.send(
      JSON.stringify({
        type: 'chat:message',
        message: {
          id: 'm2',
          role: 'assistant',
          content: 'codex has headroom',
          createdAt: '2026-01-01T00:00:01Z',
        },
      }),
    );
    await waitFor(() => lastChatTree(transport).includes('codex has headroom'));
    expect(lastChatTree(transport)).not.toContain('Secretary is working');
    await app.disconnect();
  });

  it('a journaled assistant error message clears the working row (no completed event)', async () => {
    const transport = new MockIpcTransport();
    const app = chatApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;

    socket.send(JSON.stringify({ type: 'chat:event', event: { kind: 'iteration', iteration: 1 } }));
    await waitFor(() => lastChatTree(transport).includes('working'));
    socket.send(
      JSON.stringify({
        type: 'chat:message',
        message: {
          id: 'm9',
          role: 'assistant',
          content: "I couldn't complete that turn — model unreachable",
          createdAt: '2026-01-01T00:00:02Z',
        },
      }),
    );
    await waitFor(() => !lastChatTree(transport).includes('Secretary is working'));
    await app.disconnect();
  });

  it('chatcmd:chat-send forwards a typed command and arms the working row', async () => {
    const transport = new MockIpcTransport();
    const app = chatApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;

    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'chat-send') {
        expect(cmd['text']).toBe('ship it');
        socket.send(
          JSON.stringify({
            ok: true,
            message: userMsg('m1', 'ship it'),
            turn: 'started',
          }),
        );
      }
    });

    const verb =
      'chatcmd:' + encodeURIComponent(JSON.stringify({ kind: 'chat-send', text: 'ship it' }));
    await app.handleRendererCommand({ id: 10, cmd: verb });
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 10,
      res: { ok: true, message: userMsg('m1', 'ship it'), turn: 'started' },
    });
    // Working row armed immediately — before any chat:event arrives.
    expect(lastChatTree(transport)).toContain('Secretary is working');
    await app.disconnect();
  });

  it('chatcmd rejects non-chat command kinds', async () => {
    const transport = new MockIpcTransport();
    const app = chatApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    let sawCommand = false;
    socket.on('message', () => {
      sawCommand = true;
    });
    const verb = 'chatcmd:' + encodeURIComponent(JSON.stringify({ kind: 'shutdown' }));
    await app.handleRendererCommand({ id: 11, cmd: verb });
    const result = transport.toRenderer.find((m) => m.channel === 'command:result');
    expect((result?.data as { res: { ok: boolean } }).res.ok).toBe(false);
    expect(sawCommand).toBe(false);
    await app.disconnect();
  });

  it('chatcmd:chat-clear empties the mirrored history', async () => {
    const transport = new MockIpcTransport();
    const app = chatApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;

    socket.send(JSON.stringify({ type: 'chat:message', message: userMsg('m1', 'old thread') }));
    await waitFor(() => lastChatTree(transport).includes('old thread'));

    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'chat-clear') {
        socket.send(JSON.stringify({ ok: true }));
      }
    });
    await app.handleRendererCommand({
      id: 12,
      cmd: 'chatcmd:' + encodeURIComponent(JSON.stringify({ kind: 'chat-clear' })),
    });
    const text = lastChatTree(transport);
    expect(text).not.toContain('old thread');
    expect(text).toContain('history cleared');
    await app.disconnect();
  });

  it('refresh seeds the conversation from chat-read (resume on reconnect)', async () => {
    const transport = new MockIpcTransport();
    const app = chatApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;

    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'chat-read') {
        socket.send(
          JSON.stringify({
            ok: true,
            messages: [
              userMsg('m1', 'earlier context'),
              {
                id: 'm2',
                role: 'assistant',
                content: 'still here',
                createdAt: '2026-01-01T00:00:01Z',
              },
            ],
          }),
        );
      } else {
        socket.send(JSON.stringify({ ok: true, items: [], tasks: [] }));
      }
    });

    await app.refreshNow();
    await waitFor(() => transport.toRenderer.some((m) => m.channel === 'chat:update'));
    const text = lastChatTree(transport);
    expect(text).toContain('earlier context');
    expect(text).toContain('still here');
    await app.disconnect();
  });
});

/* ================================================================== *
 * Dictation verbs (issue #161)
 * ================================================================== */

describe('dictation verbs', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  class StubDictationSession {
    isConnected = false;
    currentState = 'idle' as const;
    connected: Array<{ apiKey: string; options?: { transcriptionOnly?: boolean } }> = [];
    listening = false;
    private cbs = new Set<(e: { partial: boolean; text: string }) => void>();
    async connect(apiKey: string, options?: { transcriptionOnly?: boolean }): Promise<void> {
      this.connected.push({ apiKey, options });
      this.isConnected = true;
    }
    async disconnect(): Promise<void> {
      this.isConnected = false;
    }
    startListening(): void {
      this.listening = true;
    }
    stopListening(): void {
      this.listening = false;
    }
    sendToolCallOutput(): void {}
    sendUserMessage(): void {}
    onToolCall(): () => void {
      return () => undefined;
    }
    onTranscript(cb: (e: { partial: boolean; text: string }) => void): () => void {
      this.cbs.add(cb);
      return () => this.cbs.delete(cb);
    }
    onStateChange(): () => void {
      return () => undefined;
    }
    emitTranscript(e: { partial: boolean; text: string }): void {
      for (const cb of this.cbs) cb(e);
    }
  }

  class StubAudioTransport {
    private cb: ((c: { pcm: string; sampleRate: number; channels: number }) => void) | null = null;
    startCapture(cb: (c: { pcm: string; sampleRate: number; channels: number }) => void): void {
      this.cb = cb;
    }
    stopCapture(): void {
      this.cb = null;
    }
    play(): void {}
    stopPlayback(): void {}
    close(): void {}
  }

  function dictationApp(transport: MockIpcTransport): {
    app: DesktopApp;
    session: StubDictationSession;
  } {
    const session = new StubDictationSession();
    const dictation = new DictationService({
      transport: new StubAudioTransport(),
      session,
      apiKey: 'sk-test',
      finalTimeoutMs: 50,
      onUpdate: (u) =>
        transport.sendToRenderer('dictation:update', {
          state: u.state,
          ...(u.error ? { error: u.error } : {}),
        }),
      onTranscript: (t) =>
        transport.sendToRenderer(
          'dictation:update',
          t.partial
            ? { state: 'listening', partial: t.text }
            : { state: 'listening', final: t.text },
        ),
    });
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: transport,
      dictation,
    });
    app.start();
    return { app, session };
  }

  it('dictation:start drives the realtime session in transcriptionOnly mode', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = dictationApp(transport);
    await app.handleRendererCommand({ id: 'd1', cmd: 'dictation:start' });
    expect(session.connected[0]?.options?.transcriptionOnly).toBe(true);
    expect(session.listening).toBe(true);
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 'd1',
      res: { ok: true },
    });
    // State pushes reach the renderer on dictation:update.
    const states = transport.toRenderer
      .filter((m) => m.channel === 'dictation:update')
      .map((m) => (m.data as { state: string }).state);
    expect(states).toEqual(['connecting', 'listening']);
    await app.disconnect();
  });

  it('dictation:stop emits the final transcript as editable text (never a chat-send)', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = dictationApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    let sentToDaemon = false;
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] === 'chat-send') sentToDaemon = true;
      socket.send(JSON.stringify({ ok: true, items: [], tasks: [], messages: [] }));
    });

    await app.handleRendererCommand({ id: 'd2', cmd: 'dictation:start' });
    const stopping = app.handleRendererCommand({ id: 'd3', cmd: 'dictation:stop' });
    session.emitTranscript({ partial: false, text: 'ship the fix' });
    await stopping;

    const final = transport.toRenderer.find(
      (m) => m.channel === 'dictation:update' && (m.data as { final?: string }).final !== undefined,
    );
    expect((final?.data as { final: string }).final).toBe('ship the fix');
    expect(sentToDaemon).toBe(false); // dictated text is never auto-sent
    await app.disconnect();
  });

  it('dictation verbs fail honestly when no service is wired', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    await app.handleRendererCommand({ id: 'd4', cmd: 'dictation:start' });
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 'd4',
      res: { ok: false, error: 'dictation is not configured' },
    });
    await app.disconnect();
  });

  it('dictation:cancel acks without a final transcript', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = dictationApp(transport);
    await app.handleRendererCommand({ id: 'd5', cmd: 'dictation:start' });
    await app.handleRendererCommand({ id: 'd6', cmd: 'dictation:cancel' });
    session.emitTranscript({ partial: false, text: 'late words' });
    expect(
      transport.toRenderer.some(
        (m) =>
          m.channel === 'dictation:update' && (m.data as { final?: string }).final !== undefined,
      ),
    ).toBe(false);
    await app.disconnect();
  });
});

/* ================================================================== *
 * Voice-mode verbs (issue #162): two-way turns via an injected
 * DesktopVoiceSession, mutual exclusion with dictation, daemon-loss
 * suspension, and preference replay.
 * ================================================================== */

describe('voice-mode verbs (issue #162)', () => {
  let server: MockDaemonServer;

  beforeEach(async () => {
    server = new MockDaemonServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  class StubVoiceSession {
    started = 0;
    stopped = 0;
    listening = false;
    failStart: Error | null = null;
    private stateCbs = new Set<(s: string) => void>();
    private transcriptCbs = new Set<(t: string, p: boolean) => void>();
    async start(): Promise<void> {
      if (this.failStart !== null) throw this.failStart;
      this.started += 1;
    }
    async stop(): Promise<void> {
      this.stopped += 1;
    }
    startListening(): void {
      this.listening = true;
    }
    stopListening(): void {
      this.listening = false;
    }
    onStateChange(cb: (s: never) => void): () => void {
      this.stateCbs.add(cb as (s: string) => void);
      return () => this.stateCbs.delete(cb as (s: string) => void);
    }
    onTranscript(cb: (t: string, p: boolean) => void): () => void {
      this.transcriptCbs.add(cb);
      return () => this.transcriptCbs.delete(cb);
    }
    emitState(s: 'idle' | 'listening' | 'processing' | 'responding' | 'error'): void {
      for (const cb of this.stateCbs) cb(s);
    }
    emitTranscript(text: string, partial: boolean): void {
      for (const cb of this.transcriptCbs) cb(text, partial);
    }
  }

  function voiceApp(
    transport: MockIpcTransport,
    options?: {
      dictation?: DictationService;
      voiceConfig?: { micDeviceId?: string; voiceModeDefault?: boolean };
    },
  ): { app: DesktopApp; session: StubVoiceSession } {
    const session = new StubVoiceSession();
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: transport,
      voiceSession: session,
      ...(options?.dictation !== undefined ? { dictation: options.dictation } : {}),
      ...(options?.voiceConfig !== undefined ? { voiceConfig: options.voiceConfig } : {}),
    });
    app.start();
    return { app, session };
  }

  function voiceUpdates(transport: MockIpcTransport): Array<Record<string, unknown>> {
    return transport.toRenderer
      .filter((m) => m.channel === 'voice:update')
      .map((m) => m.data as Record<string, unknown>);
  }

  function noopTransport(): {
    startCapture: () => void;
    stopCapture: () => void;
    play: () => void;
    stopPlayback: () => void;
    close: () => void;
  } {
    return {
      startCapture: () => undefined,
      stopCapture: () => undefined,
      play: () => undefined,
      stopPlayback: () => undefined,
      close: () => undefined,
    };
  }

  it('voicemode:start opens the session and reports active', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = voiceApp(transport);
    await app.handleRendererCommand({ id: 'v1', cmd: 'voicemode:start' });
    expect(session.started).toBe(1);
    expect(voiceUpdates(transport)).toContainEqual({ active: true });
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 'v1',
      res: { ok: true },
    });
    await app.disconnect();
  });

  it('voice:talk toggles a talk turn only while voice mode is on', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = voiceApp(transport);

    await app.handleRendererCommand({ id: 'v2', cmd: 'voice:talk' });
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 'v2',
      res: { ok: false, error: 'voice mode is off' },
    });

    await app.handleRendererCommand({ id: 'v3', cmd: 'voicemode:start' });
    await app.handleRendererCommand({ id: 'v4', cmd: 'voice:talk' });
    expect(session.listening).toBe(true);
    expect(voiceUpdates(transport)).toContainEqual({ listening: true });

    await app.handleRendererCommand({ id: 'v5', cmd: 'voice:talk' });
    expect(session.listening).toBe(false);
    expect(voiceUpdates(transport)).toContainEqual({ listening: false });
    await app.disconnect();
  });

  it('voicemode:stop closes the session and reports inactive', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = voiceApp(transport);
    await app.handleRendererCommand({ id: 'v6', cmd: 'voicemode:start' });
    await app.handleRendererCommand({ id: 'v7', cmd: 'voicemode:stop' });
    expect(session.stopped).toBe(1);
    expect(voiceUpdates(transport)).toContainEqual({ active: false });
    await app.disconnect();
  });

  it('starting voice mode cancels an in-flight dictation round', async () => {
    const transport = new MockIpcTransport();
    const dictation = new DictationService({
      transport: noopTransport(),
      session: {
        isConnected: true,
        currentState: 'idle' as const,
        connect: async () => undefined,
        disconnect: async () => undefined,
        startListening: () => undefined,
        stopListening: () => undefined,
        sendToolCallOutput: () => undefined,
        sendUserMessage: () => undefined,
        onToolCall: () => () => undefined,
        onTranscript: () => () => undefined,
        onStateChange: () => () => undefined,
      },
      apiKey: 'sk-test',
      onUpdate: (u) => transport.sendToRenderer('dictation:update', { state: u.state }),
      onTranscript: () => undefined,
    });
    const { app } = voiceApp(transport, { dictation });
    await app.handleRendererCommand({ id: 'd1', cmd: 'dictation:start' });
    expect(dictation.currentState).toBe('listening');

    await app.handleRendererCommand({ id: 'v8', cmd: 'voicemode:start' });
    expect(dictation.currentState).toBe('idle');
    await app.disconnect();
  });

  it('dictation:start is refused while voice mode is active', async () => {
    const transport = new MockIpcTransport();
    const { app } = voiceApp(transport, {
      dictation: new DictationService({
        transport: noopTransport(),
        apiKey: 'sk-test',
        onUpdate: () => undefined,
        onTranscript: () => undefined,
      }),
    });
    await app.handleRendererCommand({ id: 'v9', cmd: 'voicemode:start' });
    await app.handleRendererCommand({ id: 'd2', cmd: 'dictation:start' });
    const refused = transport.toRenderer
      .filter((m) => m.channel === 'command:result')
      .map((m) => m.data as { id: string; res: { ok: boolean; error?: string } })
      .find((r) => r.id === 'd2');
    expect(refused?.res.ok).toBe(false);
    expect(refused?.res.error).toContain('voice mode');
    await app.disconnect();
  });

  it('forwards engine state and transcripts as voice:update pushes', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = voiceApp(transport);
    await app.handleRendererCommand({ id: 'v10', cmd: 'voicemode:start' });

    session.emitState('responding');
    session.emitTranscript('checking the fleet', true);
    session.emitTranscript('checking the fleet now', false);

    const updates = voiceUpdates(transport);
    expect(updates).toContainEqual({ state: 'responding' });
    expect(updates).toContainEqual({ partial: 'checking the fleet' });
    expect(updates).toContainEqual({ final: 'checking the fleet now' });
    await app.disconnect();
  });

  it('a daemon drop suspends an in-flight talk turn', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = voiceApp(transport);
    const conn = server.waitForConnection();
    await app.connectToDaemon(server.url);
    const socket = await conn;
    socket.on('message', (data) => {
      const cmd = JSON.parse(String(data)) as Record<string, unknown>;
      if (cmd['kind'] !== undefined) socket.send(JSON.stringify({ ok: true }));
    });

    await app.handleRendererCommand({ id: 'v11', cmd: 'voicemode:start' });
    await app.handleRendererCommand({ id: 'v12', cmd: 'voice:talk' });
    expect(session.listening).toBe(true);

    server.dropClient();
    await waitFor(() => voiceUpdates(transport).some((u) => u['suspended'] === true));
    expect(session.listening).toBe(false);
    expect(voiceUpdates(transport)).toContainEqual({ listening: false, suspended: true });
    await app.disconnect();
  });

  it('voice verbs fail honestly when no session is wired', async () => {
    const transport = new MockIpcTransport();
    const app = new DesktopApp({ window: new MockWindowBackend(), ipcTransport: transport });
    app.start();
    await app.handleRendererCommand({ id: 'v13', cmd: 'voicemode:start' });
    expect(transport.toRenderer.find((m) => m.channel === 'command:result')?.data).toEqual({
      id: 'v13',
      res: { ok: false, error: 'voice mode is not configured' },
    });
    await app.disconnect();
  });

  it('a failed start does not leave voice mode active', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = voiceApp(transport);
    session.failStart = new Error('realtime refused');
    await app.handleRendererCommand({ id: 'v14', cmd: 'voicemode:start' });
    const res = transport.toRenderer
      .filter((m) => m.channel === 'command:result')
      .map((m) => m.data as { id: string; res: { ok: boolean; error?: string } })
      .find((r) => r.id === 'v14');
    expect(res?.res.ok).toBe(false);
    expect(res?.res.error).toContain('realtime refused');

    await app.handleRendererCommand({ id: 'v15', cmd: 'voice:talk' });
    const talk = transport.toRenderer
      .filter((m) => m.channel === 'command:result')
      .map((m) => m.data as { id: string; res: { ok: boolean; error?: string } })
      .find((r) => r.id === 'v15');
    expect(talk?.res.ok).toBe(false);
    await app.disconnect();
  });

  it('replayVoiceConfig pushes mic + default preferences to the renderer', async () => {
    const transport = new MockIpcTransport();
    const { app } = voiceApp(transport, {
      voiceConfig: { micDeviceId: 'usb-mic-1', voiceModeDefault: true },
    });
    app.replayVoiceConfig();
    expect(voiceUpdates(transport)).toContainEqual({
      config: { micDeviceId: 'usb-mic-1', voiceModeDefault: true },
    });
    await app.disconnect();
  });

  it('ptt:toggle inside voice mode toggles the talk turn (hotkey parity)', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = voiceApp(transport);
    await app.handleRendererCommand({ id: 'v20', cmd: 'voicemode:start' });
    expect(voiceUpdates(transport)).toContainEqual({ active: true });

    await app.handleRendererCommand({ id: 'v21', cmd: 'ptt:toggle' });
    await vi.waitFor(() => expect(session.listening).toBe(true));
    expect(voiceUpdates(transport)).toContainEqual({ listening: true });

    await app.handleRendererCommand({ id: 'v22', cmd: 'ptt:toggle' });
    await vi.waitFor(() => expect(session.listening).toBe(false));
    expect(voiceUpdates(transport)).toContainEqual({ listening: false });
    await app.disconnect();
  });

  it('voicemode:start pushes a connecting state and ignores a second start', async () => {
    const transport = new MockIpcTransport();
    const { app, session } = voiceApp(transport);
    // Hold the connect open so the second verb lands mid-flight.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const realStart = session.start.bind(session);
    session.start = async () => {
      await gate;
      return realStart();
    };
    const first = app.handleRendererCommand({ id: 'v30', cmd: 'voicemode:start' });
    await vi.waitFor(() => expect(voiceUpdates(transport)).toContainEqual({ connecting: true }));
    await app.handleRendererCommand({ id: 'v31', cmd: 'voicemode:start' });
    const res31 = transport.toRenderer
      .filter((m) => m.channel === 'command:result')
      .map((m) => m.data as { id: string; res: { ok: boolean } })
      .find((r) => r.id === 'v31');
    expect(res31?.res.ok).toBe(true); // idempotent — not an error
    release();
    await first;
    expect(voiceUpdates(transport)).toContainEqual({ active: true });
    await app.disconnect();
  });
});

describe('deskset: desktop settings command (issue #163)', () => {
  function memStore(initial?: Partial<DesktopSettingsShape>): {
    store: DesktopSettingsStore;
    written: DesktopSettingsShape[];
    current: () => DesktopSettingsShape;
  } {
    let current: DesktopSettingsShape = {
      stopDaemonOnQuit: false,
      voiceModeDefault: false,
      ...initial,
    };
    const written: DesktopSettingsShape[] = [];
    return {
      store: {
        read: () => current,
        write: (s) => {
          current = s;
          written.push(s);
        },
      },
      written,
      current: () => current,
    };
  }

  function settingsApp(
    transport: MockIpcTransport,
    options?: { desktopSettings?: DesktopSettingsStore; dictation?: DictationService },
  ): DesktopApp {
    const app = new DesktopApp({
      window: new MockWindowBackend(),
      ipcTransport: transport,
      ...(options?.desktopSettings !== undefined
        ? { desktopSettings: options.desktopSettings }
        : {}),
      ...(options?.dictation !== undefined ? { dictation: options.dictation } : {}),
    });
    app.start();
    return app;
  }

  function resultFor(
    transport: MockIpcTransport,
    id: string,
  ): { ok: boolean; error?: string } | undefined {
    return transport.toRenderer
      .filter((m) => m.channel === 'command:result')
      .map((m) => m.data as { id: string; res: { ok: boolean; error?: string } })
      .find((r) => r.id === id)?.res;
  }

  function deskset(patch: Record<string, unknown>): string {
    return `deskset:${encodeURIComponent(JSON.stringify(patch))}`;
  }

  it('persists a valid patch locally and repushes the merged config', async () => {
    const transport = new MockIpcTransport();
    const { store, written } = memStore({ stopDaemonOnQuit: true });
    const app = settingsApp(transport, { desktopSettings: store });
    await app.handleRendererCommand({
      id: 's1',
      cmd: deskset({ micDeviceId: 'usb-1', dictationLanguage: 'ro', voiceModeDefault: true }),
    });
    expect(written).toEqual([
      {
        stopDaemonOnQuit: true,
        micDeviceId: 'usb-1',
        voiceModeDefault: true,
        dictationLanguage: 'ro',
      },
    ]);
    expect(resultFor(transport, 's1')?.ok).toBe(true);
    // The renderer sees what actually landed on disk.
    const configs = transport.toRenderer
      .filter((m) => m.channel === 'voice:update')
      .map((m) => m.data as Record<string, unknown>);
    expect(configs).toContainEqual({
      config: {
        stopDaemonOnQuit: true,
        micDeviceId: 'usb-1',
        voiceModeDefault: true,
        dictationLanguage: 'ro',
      },
    });
    await app.disconnect();
  });

  it('null clears mic/language; wrong types preserve the current value', async () => {
    const transport = new MockIpcTransport();
    const { store, current } = memStore({
      micDeviceId: 'usb-1',
      dictationLanguage: 'en',
      voiceModeDefault: true,
    });
    const app = settingsApp(transport, { desktopSettings: store });
    await app.handleRendererCommand({
      id: 's2',
      cmd: deskset({ micDeviceId: null, dictationLanguage: null, voiceModeDefault: 'yes' }),
    });
    expect(resultFor(transport, 's2')?.ok).toBe(true);
    expect(current()).toEqual({ stopDaemonOnQuit: false, voiceModeDefault: true });
    await app.disconnect();
  });

  it('rejects malformed and non-object payloads without writing', async () => {
    const transport = new MockIpcTransport();
    const { store, written } = memStore();
    const app = settingsApp(transport, { desktopSettings: store });
    await app.handleRendererCommand({ id: 'b1', cmd: 'deskset:not-json%25' });
    await app.handleRendererCommand({ id: 'b2', cmd: deskset([1, 2] as never) });
    expect(resultFor(transport, 'b1')?.ok).toBe(false);
    expect(resultFor(transport, 'b2')?.ok).toBe(false);
    expect(written).toHaveLength(0);
    await app.disconnect();
  });

  it('fails honestly when no settings store is wired', async () => {
    const transport = new MockIpcTransport();
    const app = settingsApp(transport);
    await app.handleRendererCommand({ id: 's3', cmd: deskset({ voiceModeDefault: true }) });
    const res = resultFor(transport, 's3');
    expect(res?.ok).toBe(false);
    expect(res?.error).toContain('not wired');
    await app.disconnect();
  });

  it('works fully offline — local settings never round-trip the daemon', async () => {
    const transport = new MockIpcTransport();
    const { store, written } = memStore();
    const app = settingsApp(transport, { desktopSettings: store });
    // Deliberately no connectToDaemon: deskset must still succeed.
    await app.handleRendererCommand({ id: 's4', cmd: deskset({ dictationLanguage: 'fr' }) });
    expect(resultFor(transport, 's4')?.ok).toBe(true);
    expect(written[0]?.dictationLanguage).toBe('fr');
    await app.disconnect();
  });

  it('applies a saved language to the dictation service immediately', async () => {
    const transport = new MockIpcTransport();
    const dictation = new DictationService({
      transport: {
        startCapture: () => undefined,
        stopCapture: () => undefined,
        play: () => undefined,
        stopPlayback: () => undefined,
        close: () => undefined,
      },
      apiKey: 'sk-test',
      onUpdate: () => undefined,
      onTranscript: () => undefined,
    });
    const spy = vi.spyOn(dictation, 'setSessionLanguage');
    const { store } = memStore({ dictationLanguage: 'en' });
    const app = settingsApp(transport, { desktopSettings: store, dictation });
    await app.handleRendererCommand({ id: 's5', cmd: deskset({ dictationLanguage: 'ro' }) });
    expect(resultFor(transport, 's5')?.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith('ro');
    await app.disconnect();
  });
});
