import { describe, expect, it } from 'vitest';

import { toMilliseconds, toSeconds } from '../src/duration';

describe('durations', () => {
  it('reads every unit', () => {
    expect(toMilliseconds('500ms', 'x')).toBe(500);
    expect(toMilliseconds('2s', 'x')).toBe(2_000);
    expect(toMilliseconds('1.5m', 'x')).toBe(90_000);
    expect(toMilliseconds('1h', 'x')).toBe(3_600_000);
    expect(toMilliseconds('7d', 'x')).toBe(604_800_000);
    expect(toMilliseconds(250, 'x')).toBe(250);
  });

  it('converts to seconds rounding up, so a retention window never shrinks', () => {
    expect(toSeconds('7d', 'x')).toBe(604_800);
    expect(toSeconds('1500ms', 'x')).toBe(2);
  });

  it('refuses zero, negatives and garbage with the field name', () => {
    expect(() => toMilliseconds(0, 'keep.completed')).toThrow(/keep\.completed/u);
    expect(() => toMilliseconds(-5, 'x')).toThrow(RangeError);
    expect(() => toMilliseconds('5 minutes' as never, 'x')).toThrow(/not a duration/u);
    expect(() => toMilliseconds(Number.NaN, 'x')).toThrow(RangeError);
  });
});
