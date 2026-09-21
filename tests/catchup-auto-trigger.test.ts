import { describe, it, expect } from 'vitest';
import {
  CatchUpAutoTrigger,
  DEFAULT_IDLE_THRESHOLD_MS,
} from '../src/adapters/inbound/desktop/catchup-auto-trigger.js';

describe('CatchUpAutoTrigger', () => {
  it('uses the default idle threshold when none is configured', () => {
    const trigger = new CatchUpAutoTrigger();
    expect(trigger.idleThresholdMs).toBe(DEFAULT_IDLE_THRESHOLD_MS);
  });

  it('accepts a configurable idle threshold', () => {
    const trigger = new CatchUpAutoTrigger({ idleThresholdMs: 5_000 });
    expect(trigger.idleThresholdMs).toBe(5_000);
  });

  it('fires on the very first view-open', () => {
    const trigger = new CatchUpAutoTrigger({ now: () => 0 });
    expect(trigger.onViewOpened()).toBe(true);
  });

  it('does not fire on every reopen — repeated opens within the threshold stay quiet', () => {
    let clock = 0;
    const trigger = new CatchUpAutoTrigger({ idleThresholdMs: 10_000, now: () => clock });

    expect(trigger.onViewOpened()).toBe(true); // first open: fires

    clock += 1_000;
    expect(trigger.onViewOpened()).toBe(false); // reopened quickly: quiet
    clock += 1_000;
    expect(trigger.onViewOpened()).toBe(false);
    clock += 1_000;
    expect(trigger.onViewOpened()).toBe(false);
  });

  it('fires again once the idle threshold has elapsed since it last fired', () => {
    let clock = 0;
    const trigger = new CatchUpAutoTrigger({ idleThresholdMs: 10_000, now: () => clock });

    expect(trigger.onViewOpened()).toBe(true);

    clock += 9_999;
    expect(trigger.onViewOpened()).toBe(false); // just under the threshold

    clock += 1; // now exactly at 10_000ms since it last fired
    expect(trigger.onViewOpened()).toBe(true);
  });

  it('each fire resets the idle window — the threshold applies from the last fire, not the first', () => {
    let clock = 0;
    const trigger = new CatchUpAutoTrigger({ idleThresholdMs: 10_000, now: () => clock });

    expect(trigger.onViewOpened()).toBe(true); // fires at t=0

    clock = 10_000;
    expect(trigger.onViewOpened()).toBe(true); // fires again at t=10000

    clock = 15_000; // only 5s since the SECOND fire
    expect(trigger.onViewOpened()).toBe(false);

    clock = 20_000; // 10s since the second fire
    expect(trigger.onViewOpened()).toBe(true);
  });

  it('msUntilNextFire reports 0 before any open, and counts down after firing', () => {
    let clock = 0;
    const trigger = new CatchUpAutoTrigger({ idleThresholdMs: 10_000, now: () => clock });

    expect(trigger.msUntilNextFire()).toBe(0);

    trigger.onViewOpened(); // fires at t=0
    expect(trigger.msUntilNextFire()).toBe(10_000);

    clock = 4_000;
    expect(trigger.msUntilNextFire()).toBe(6_000);

    clock = 10_000;
    expect(trigger.msUntilNextFire()).toBe(0);
  });
});
