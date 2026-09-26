/**
 * Focused tests for the core control-plane request parser (issue #93).
 *
 * `parseApiRequest` is platform-neutral: it accepts a JSON string or an
 * already-parsed value. Raw byte decoding (Buffer/Uint8Array) is the inbound
 * transport's job — the WebSocket adapter decodes before calling.
 */
import { describe, it, expect } from 'vitest';

import { parseApiRequest } from '../src/daemon/api.js';

describe('parseApiRequest', () => {
  it('accepts a JSON request string', () => {
    const req = parseApiRequest(JSON.stringify({ id: 'r1', method: 'get_status', params: {} }));
    expect(req).not.toBeNull();
    expect(req?.id).toBe('r1');
    expect(req?.method).toBe('get_status');
  });

  it('accepts an already-parsed object', () => {
    const req = parseApiRequest({ id: 'r2', method: 'show_task', params: { taskId: 't1' } });
    expect(req).not.toBeNull();
    expect(req?.id).toBe('r2');
    expect(req?.method).toBe('show_task');
  });

  it('rejects a Buffer-like byte array — decoding belongs to the transport', () => {
    const payload = new TextEncoder().encode('{"id":"r3","method":"get_status"}');
    expect(parseApiRequest(payload)).toBeNull();
    expect(parseApiRequest(Buffer.from('{"id":"r3","method":"get_status"}'))).toBeNull();
  });

  it('rejects malformed JSON strings and non-envelope values', () => {
    expect(parseApiRequest('not json')).toBeNull();
    expect(parseApiRequest(42)).toBeNull();
    expect(parseApiRequest(null)).toBeNull();
    expect(parseApiRequest({ method: 'get_status' })).toBeNull(); // no id
    expect(parseApiRequest({ id: 'r4' })).toBeNull(); // no method
  });
});
