import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('scaffold smoke test', () => {
  it('exposes a VERSION constant', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('runs basic assertions', () => {
    expect(1 + 1).toBe(2);
  });
});
