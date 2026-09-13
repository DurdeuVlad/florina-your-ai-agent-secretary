import { describe, it, expect } from 'vitest';
import {
  CodexQuotaReader,
  ClaudeQuotaReader,
  QuotaReaderError,
  isQuotaExhaustion,
  reportExhaustion,
  normalizeReset,
  normalizeUsedPct,
  statusFromUsage,
} from '../src/adapters/quota-readers.js';
import { QuotaLedger } from '../src/daemon/quota-ledger.js';

const NOW = new Date('2026-08-19T12:00:00.000Z');

describe('normalization helpers', () => {
  it('normalizeReset handles ISO strings, epoch seconds, epoch ms, null', () => {
    expect(normalizeReset('2026-08-19T17:00:00Z')).toBe('2026-08-19T17:00:00Z');
    const epochMs = Date.parse('2026-08-19T17:00:00.000Z');
    expect(normalizeReset(epochMs / 1000)).toBe('2026-08-19T17:00:00.000Z');
    expect(normalizeReset(epochMs)).toBe('2026-08-19T17:00:00.000Z');
    expect(normalizeReset(null)).toBeNull();
    expect(normalizeReset(undefined)).toBeNull();
  });

  it('normalizeUsedPct accepts fractions and percentages', () => {
    expect(normalizeUsedPct(0.5)).toBe(0.5);
    expect(normalizeUsedPct(92)).toBe(0.92);
    expect(normalizeUsedPct('x')).toBeNull();
  });

  it('statusFromUsage buckets allowed/warning/exhausted', () => {
    expect(statusFromUsage(0.5)).toBe('allowed');
    expect(statusFromUsage(0.95)).toBe('warning');
    expect(statusFromUsage(1)).toBe('exhausted');
  });
});

describe('CodexQuotaReader', () => {
  it('maps rateLimits.primary/secondary to five_hour/seven_day windows', async () => {
    const request = async (method: string) => {
      expect(method).toBe('account/rateLimits/read');
      return {
        rateLimits: {
          primary: { usedPercent: 92, resetsAt: '2026-08-19T17:00:00Z' },
          secondary: { usedPercent: 30, resetsAt: 1787702400 },
        },
      };
    };
    const reader = new CodexQuotaReader({ request });
    const windows = await reader.read(NOW);

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      provider: 'codex',
      window: 'five_hour',
      usedPct: 0.92,
      status: 'warning',
      source: 'polled',
      observedAt: NOW.toISOString(),
    });
    expect(windows[1]).toMatchObject({
      provider: 'codex',
      window: 'seven_day',
      usedPct: 0.3,
      status: 'allowed',
    });
  });

  it('throws QuotaReaderError when no usable windows are returned', async () => {
    const reader = new CodexQuotaReader({ request: async () => ({}) });
    await expect(reader.read(NOW)).rejects.toBeInstanceOf(QuotaReaderError);
  });
});

describe('ClaudeQuotaReader', () => {
  it('parses rate_limits from statusline JSON', async () => {
    const statusline = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 45, resets_at: '2026-08-19T17:00:00Z' },
        seven_day: { used_percentage: 10 },
      },
    });
    const reader = new ClaudeQuotaReader({ readStatusline: async () => statusline });
    const windows = await reader.read(NOW);

    expect(windows.map((w) => w.window)).toEqual(['five_hour', 'seven_day']);
    expect(windows[0]).toMatchObject({
      provider: 'claude-code',
      usedPct: 0.45,
      status: 'allowed',
      source: 'polled',
    });
    expect(windows[1].resetsAt).toBeNull();
  });

  it('accepts pre-parsed objects', async () => {
    const reader = new ClaudeQuotaReader({
      readStatusline: async () => ({
        rate_limits: { five_hour: { used_percentage: 100 } },
      }),
    });
    const windows = await reader.read(NOW);
    expect(windows[0].status).toBe('exhausted');
  });

  it('throws QuotaReaderError on missing rate_limits or bad JSON', async () => {
    await expect(
      new ClaudeQuotaReader({ readStatusline: async () => '{}' }).read(NOW),
    ).rejects.toBeInstanceOf(QuotaReaderError);
    await expect(
      new ClaudeQuotaReader({ readStatusline: async () => 'not json' }).read(NOW),
    ).rejects.toBeInstanceOf(QuotaReaderError);
  });
});

describe('reactive detector', () => {
  it('recognizes common exhaustion signals', () => {
    expect(isQuotaExhaustion(new Error('HTTP 429 too many requests'))).toBe(true);
    expect(isQuotaExhaustion('rate limit exceeded')).toBe(true);
    expect(isQuotaExhaustion('quota exceeded for this billing period')).toBe(true);
    expect(isQuotaExhaustion('usage limit reached')).toBe(true);
    expect(isQuotaExhaustion('insufficient credits')).toBe(true);
  });

  it('does not misfire on ordinary errors', () => {
    expect(isQuotaExhaustion(new Error('ENOENT: no such file'))).toBe(false);
    expect(isQuotaExhaustion('syntax error at line 3')).toBe(false);
  });

  it('reportExhaustion records into the ledger only for exhaustion errors', () => {
    const ledger = new QuotaLedger({ now: () => NOW });
    expect(reportExhaustion(ledger, 'devin', new Error('ENOENT'))).toBe(false);
    expect(ledger.hasCapacity('devin')).toBe(true);

    expect(
      reportExhaustion(ledger, 'devin', new Error('429 quota exceeded'), {
        resetsAt: '2026-08-19T18:00:00Z',
      }),
    ).toBe(true);
    expect(ledger.hasCapacity('devin')).toBe(false);
    expect(ledger.nextResetFor('devin')).toBe('2026-08-19T18:00:00Z');
  });
});
