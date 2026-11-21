// maintenance.sweeps.ts
import { Injectable } from '@nestjs/common';
import { Sweep, type SweepContext } from '@noctcore/jobs';

import { TokenStore } from './support';

@Injectable()
export class MaintenanceSweeps {
  constructor(private readonly tokens: TokenStore) {}

  @Sweep('expired-tokens', { cron: '15 * * * *', tz: 'UTC' })
  async purgeExpiredTokens(ctx: SweepContext): Promise<void> {
    await this.tokens.deleteExpiredBefore(ctx.scheduledAt);
  }

  @Sweep('heartbeat', { every: '1m' })
  async heartbeat(): Promise<void> {
    // A sweep that does nothing still proves the scheduler is alive:
    // alert on jobs_sweep_last_success_timestamp_seconds going stale.
  }
}
