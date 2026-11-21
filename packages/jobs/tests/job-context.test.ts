import { describe, expect, it } from 'vitest';

import {
  ENVELOPE_KEY,
  captureEnvelope,
  openJobData,
  type JobContextHook,
} from '../src/job-context';
import type { JobsTracing } from '../src/telemetry';

const tracing: JobsTracing = {
  inject: (carrier) => {
    carrier['traceparent'] = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    carrier['x-other'] = 'dropped';
  },
  runInSpan: (_name, _attributes, _carrier, fn) =>
    fn({ recordException: () => undefined, setError: () => undefined, addEvent: () => undefined }),
};

describe('job context envelope', () => {
  it('captures the hook fields and the W3C trace headers only', () => {
    const envelope = captureEnvelope(
      { capture: () => ({ requestId: 'r-1', tenant: 't-9' }), run: (_c, fn) => fn() },
      tracing,
    );

    expect(envelope).toEqual({
      v: 1,
      ctx: { requestId: 'r-1', tenant: 't-9' },
      trace: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
  });

  it('adds nothing when there is nothing to carry', () => {
    expect(captureEnvelope(undefined, undefined)).toBeUndefined();

    expect(captureEnvelope({ capture: () => undefined, run: (_c, fn) => fn() }, undefined)).toBe(
      undefined,
    );
  });

  it('refuses a capture that is not a small map of strings', () => {
    const hook: JobContextHook = {
      capture: () => ({ user: { id: 1 } }) as never,
      run: (_context, fn) => fn(),
    };

    expect(() => captureEnvelope(hook, undefined)).toThrow(/string fields/u);
  });

  it('strips the envelope from the payload in the worker', () => {
    const opened = openJobData({ a: 1, [ENVELOPE_KEY]: { v: 1, ctx: { requestId: 'r-1' } } });

    expect(opened).toEqual({
      data: { a: 1 },
      ctx: { requestId: 'r-1' },
      trace: {},
      dropped: false,
    });
  });

  it('drops a tampered envelope whole instead of trusting part of it', () => {
    const tampered = [
      { v: 2, ctx: { requestId: 'r' } },
      { v: 1, ctx: { tenantId: { $ne: null } } },
      { v: 1, ctx: {}, extra: 'field' },
      'not an object',
    ];

    for (const envelope of tampered) {
      expect(openJobData({ a: 1, [ENVELOPE_KEY]: envelope })).toEqual({
        data: { a: 1 },
        ctx: {},
        trace: {},
        dropped: true,
      });
    }
  });

  it('passes through data without an envelope', () => {
    expect(openJobData({ a: 1 })).toEqual({ data: { a: 1 }, ctx: {}, trace: {}, dropped: false });
    expect(openJobData(null).data).toBeNull();
  });
});
