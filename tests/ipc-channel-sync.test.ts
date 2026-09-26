import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Regression test for a real bug (issue #221): preload.cjs's PUSH_CHANNELS
 * allowlist is a hand-maintained duplicate of the channels app.js actually
 * subscribes to (`bridge.on(...)`) — its own comment says "keep in sync,"
 * but nothing enforced that. Adding `history:update` to desktop-app.ts and
 * app.js without also adding it to preload.cjs's allowlist made the whole
 * feature silently no-op (`florina.on` returns a no-op unsubscribe for any
 * channel not in the set) with no error, anywhere. This test statically
 * parses both files' source (no Electron runtime needed) and asserts every
 * channel app.js listens for is present in preload's allowlist.
 */

const RENDERER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/adapters/inbound/desktop/renderer',
);

function appJsSubscribedChannels(): string[] {
  const source = readFileSync(path.join(RENDERER_DIR, 'app.js'), 'utf8');
  const matches = [...source.matchAll(/bridge\.on\(\s*'([^']+)'/g)];
  return matches.map((m) => m[1]!);
}

function preloadAllowedChannels(): Set<string> {
  const source = readFileSync(path.join(RENDERER_DIR, 'preload.cjs'), 'utf8');
  const match = /const PUSH_CHANNELS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (!match) throw new Error('could not find PUSH_CHANNELS in preload.cjs');
  const entries = [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  return new Set(entries);
}

describe('preload.cjs PUSH_CHANNELS stays in sync with app.js subscriptions', () => {
  it('every channel app.js subscribes to via bridge.on is allowed in preload.cjs', () => {
    const subscribed = appJsSubscribedChannels();
    expect(subscribed.length).toBeGreaterThan(0); // sanity: the regex actually matched something
    const allowed = preloadAllowedChannels();
    const missing = subscribed.filter((c) => !allowed.has(c));
    expect(missing, `channels used in app.js but missing from preload.cjs PUSH_CHANNELS: ${missing.join(', ')}`).toEqual([]);
  });
});
