// mail.queue.ts
import { defineQueue, expo } from '@noctcore/jobs';

export type MailJobs = {
  welcome: { userId: string };
  receipt: { orderId: string };
};

export const mail = defineQueue<MailJobs>('mail', {
  attempts: 5,
  backoff: expo('2s'), // 2s, 4s, 8s, 16s, jittered
  keep: { completed: '1d', failed: '14d' },
  concurrency: 10,
  pace: { max: 50, per: '1s' }, // all replicas
});
