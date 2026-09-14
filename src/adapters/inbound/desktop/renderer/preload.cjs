/**
 * Electron preload — the only bridge between the sandboxed renderer and the
 * main process. Exposes a whitelisted `window.florina` API via contextBridge:
 *
 *   florina.on(channel, cb)   — subscribe to a pushed RenderTree / status
 *   florina.command(cmd)      — send a typed command to the daemon (routed
 *                               through the main process), resolves with the
 *                               daemon's Response
 *
 * Preload must be CommonJS: sandboxed renderers cannot load ESM preloads.
 * Channel names mirror IPC_CHANNELS in ../ipc-bridge.ts — keep in sync.
 */
const { contextBridge, ipcRenderer } = require('electron');

const PUSH_CHANNELS = new Set([
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
  'secretary:update',
  'chat:update',
  'dictation:capture',
  'dictation:audio-out',
  'dictation:update',
  'voice:update',
  'hud:state',
  'command:result',
]);

let nextId = 1;
const pending = new Map();

ipcRenderer.on('command:result', (_event, data) => {
  const res = pending.get(data && data.id);
  if (res) {
    pending.delete(data.id);
    res(data.res);
  }
});

contextBridge.exposeInMainWorld('florina', {
  on(channel, cb) {
    if (!PUSH_CHANNELS.has(channel)) return () => {};
    const listener = (_event, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
  command(cmd) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ipcRenderer.send('command', { id, cmd });
    });
  },
  /* dictation (issue #161): PCM16 chunks from the renderer mic → main. */
  dictationAudio(pcm) {
    if (typeof pcm === 'string' && pcm.length > 0) {
      ipcRenderer.send('dictation:audio', { pcm });
    }
  },
});
