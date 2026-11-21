// sms.worker.ts
import { JobHost, Worker, defineQueue, fatal, fixed, type FailureKind, type JobOf } from '@noctcore/jobs';

import { RateLimitedError } from './support';

type SmsJobs = { send: { to: string; body: string } };

export const sms = defineQueue<SmsJobs>('sms', {
  attempts: 8,
  backoff: fixed('30s'),
  keep: { completed: '1d', failed: { age: '7d', count: 5_000 } },
  concurrency: 4,
});

declare function sendSms(to: string, body: string): Promise<void>;

@Worker(sms)
export class SmsWorker extends JobHost<typeof sms> {
  async handle(job: JobOf<SmsJobs>): Promise<void> {
    if (!job.data.to.startsWith('+')) throw fatal(`not an E.164 number: ${job.data.to}`);

    // A job its provider always refuses would pause the queue for good: bound the hand-backs.
    if (job.raw.attemptsStarted > 20) throw new Error('rate limited 20 times, giving up');

    try {
      await sendSms(job.data.to, job.data.body);
    } catch (error) {
      // The provider said "not now": pause the whole queue, hand the job back, spend no attempt.
      if (error instanceof RateLimitedError) throw await this.pauseQueue(error.retryAfterMs);

      throw error;
    }
  }

  override classify(error: unknown): FailureKind {
    return error instanceof TypeError ? 'fatal' : 'retry';
  }
}
