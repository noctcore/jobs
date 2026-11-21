import { describe, expect, it } from 'vitest';

import { SWEEP_METADATA, Sweep, queueToken, type SweepSchedule } from '../src/decorators';

describe('Sweep schedules', () => {
  it('needs a time zone beside a cron, and refuses mixing cron with every', () => {
    const hourly: SweepSchedule = { cron: '0 * * * *', tz: 'Europe/Warsaw' };
    const often: SweepSchedule = { every: '5m' };

    // @ts-expect-error a cron read in the host's zone moves with the server
    const zoneless: SweepSchedule = { cron: '0 * * * *' };

    // @ts-expect-error one schedule kind at a time
    const both: SweepSchedule = { cron: '0 * * * *', tz: 'UTC', every: '1m' };

    expect([hourly, often, zoneless, both]).toHaveLength(4);
  });

  it('records the name and schedule on the method', () => {
    class Sweeps {
      @Sweep('purge', { every: '1h' })
      purge(): void {}
    }

    const metadata: unknown = Reflect.getMetadata(SWEEP_METADATA, Sweeps.prototype.purge);

    expect(metadata).toEqual({ name: 'purge', schedule: { every: '1h' } });
  });

  it('derives one injection token per queue name', () => {
    expect(queueToken({ name: 'mail' })).toBe('noctcore.jobs:queue:mail');
  });
});
