// mail.worker.ts
import { JobHost, Worker, type JobOf } from '@noctcore/jobs';

import { mail, type MailJobs } from './mail.queue';
import { Mailer } from './support';

@Worker(mail)
export class MailWorker extends JobHost<typeof mail> {
  constructor(private readonly mailer: Mailer) {
    super();
  }

  async handle(job: JobOf<MailJobs>): Promise<void> {
    switch (job.name) {
      case 'welcome':
        return this.mailer.sendWelcome(job.data.userId); // job.data is typed per name
      case 'receipt':
        return this.mailer.sendReceipt(job.data.orderId);
    }
  }

  override onFinalFailure(job: JobOf<MailJobs>, error: unknown): void {
    this.logger.error({ message: 'Mail gave up', job: job.name, id: job.id, error });
  }
}
