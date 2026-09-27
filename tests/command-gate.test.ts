/**
 * Shared confirm gate tests (issue #261): journaled/destructive command
 * elements carry data-confirm — cancel blocks dispatch, confirm sends
 * exactly the encoded command, unflagged commands dispatch untouched.
 */
import { describe, expect, it } from 'vitest';

import { confirmGate } from '../src/adapters/inbound/desktop/renderer/command-gate.js';

/** Minimal element stub — the gate only reads dataset.confirm. */
function el(dataset: Record<string, string> = {}): { dataset: Record<string, string> } {
  return { dataset };
}

describe('confirmGate', () => {
  it('dispatches unflagged commands without prompting', () => {
    const ask = (): boolean => {
      throw new Error('must not prompt');
    };
    expect(confirmGate(el({ command: 'inspect:abc' }), ask)).toBe(true);
    expect(confirmGate(el({ command: 'digest:abc' }), ask)).toBe(true);
  });

  it('prompts flagged commands and dispatches on confirm', () => {
    let seen = '';
    const ask = (p: string): boolean => {
      seen = p;
      return true;
    };
    const btn = el({ command: 'deny:item-1', confirm: 'Deny this request?' });
    expect(confirmGate(btn, ask)).toBe(true);
    expect(seen).toBe('Deny this request?');
  });

  it('blocks dispatch when the prompt is cancelled — nothing reaches the daemon', () => {
    const ask = (): boolean => false;
    const btn = el({ command: 'prune:item-2', confirm: 'Prune this worktree?' });
    expect(confirmGate(btn, ask)).toBe(false);
  });

  it('treats an empty prompt as unflagged', () => {
    const ask = (): boolean => {
      throw new Error('must not prompt');
    };
    expect(confirmGate(el({ command: 'x', confirm: '' }), ask)).toBe(true);
  });

  it('survives elements without dataset (null-safe)', () => {
    const ask = (): boolean => {
      throw new Error('must not prompt');
    };
    expect(confirmGate(null as never, ask)).toBe(true);
    expect(confirmGate(el(), ask)).toBe(true);
  });
});
