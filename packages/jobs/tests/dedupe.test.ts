import { describe, expect, it } from 'vitest';

import { dedupe, dedupeId, dedupeJobOptions } from '../src/dedupe';

describe('dedupe', () => {
  it('hashes the key, so the stored id never shows the value', () => {
    const id = dedupeId('reset|someone@example.com');

    expect(id).toMatch(/^[0-9a-f]{64}$/u);
    expect(id).not.toContain('example');
    expect(dedupeId('reset|someone@example.com')).toBe(id);
  });

  it('joins array parts unambiguously', () => {
    expect(dedupeId(['a', 'bc'])).not.toBe(dedupeId(['ab', 'c']));
  });

  it('refuses a colon, an empty part, NUL and an oversized key', () => {
    expect(() => dedupeId('user:42')).toThrow(/must not contain ":"/u);
    expect(() => dedupeId(['ok', ''])).toThrow(/non-empty/u);
    expect(() => dedupeId([])).toThrow(/at least one part/u);
    expect(() => dedupeId('a\u0000b')).toThrow(/NUL/u);
    expect(() => dedupeId('x'.repeat(1_025))).toThrow(/at most/u);
  });

  it('maps each mode to BullMQ deduplication options', () => {
    expect(dedupeJobOptions(dedupe.none())).toEqual({});
    expect(dedupeJobOptions(dedupe.until('k'))).toEqual({ deduplication: { id: dedupeId('k') } });

    expect(dedupeJobOptions(dedupe.window('k', '60s'))).toEqual({
      deduplication: { id: dedupeId('k'), ttl: 60_000 },
    });

    expect(dedupeJobOptions(dedupe.debounce('k', '5s'))).toEqual({
      deduplication: { id: dedupeId('k'), ttl: 5_000, extend: true, replace: true },
      delay: 5_000,
    });
  });
});
