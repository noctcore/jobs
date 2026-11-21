// mail.worker.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Job } from 'bullmq';
import type { JobOf } from '@noctcore/jobs';

import type { MailJobs } from './mail.queue';
import { MailWorker } from './mail.worker';
import { Mailer } from './support';

class FakeMailer extends Mailer {
  readonly sent: string[] = [];

  override async sendWelcome(userId: string): Promise<void> {
    this.sent.push(userId);
  }
}

test('a welcome job sends one welcome mail', async () => {
  const mailer = new FakeMailer();
  const worker = new MailWorker(mailer);

  const job: JobOf<MailJobs> = {
    name: 'welcome',
    data: { userId: 'u_1' },
    id: '1',
    queue: 'mail',
    attempt: 1,
    maxAttempts: 5,
    context: {},
    raw: {} as Job,
  };

  await worker.handle(job);

  assert.deepEqual(mailer.sent, ['u_1']);
});
