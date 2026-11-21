// Stand-ins for the app's own services, so the samples typecheck on their own.
import { Injectable } from '@nestjs/common';

@Injectable()
export class AppConfig {
  get(name: 'REDIS_URL'): string {
    const value = process.env[name];

    if (value === undefined) throw new Error(`${name} is not set`);

    return value;
  }
}

@Injectable()
export class Mailer {
  async sendWelcome(userId: string): Promise<void> {
    void userId;
  }

  async sendReceipt(orderId: string): Promise<void> {
    void orderId;
  }
}

@Injectable()
export class TokenStore {
  async deleteExpiredBefore(at: Date): Promise<number> {
    void at;

    return 0;
  }
}

/** What a provider's client throws when it is rate limited. */
export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('rate limited');
  }
}
