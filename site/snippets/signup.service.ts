// signup.service.ts
import { Injectable } from '@nestjs/common';
import { InjectQueue, JobQueue, dedupe } from '@noctcore/jobs';

import { mail, type MailJobs } from './mail.queue';

@Injectable()
export class SignupService {
  constructor(@InjectQueue(mail) private readonly mail: JobQueue<MailJobs>) {}

  async onSignedUp(userId: string): Promise<void> {
    await this.mail.add('welcome', { userId }, { dedupe: dedupe.window(['welcome', userId], '1d') });
  }
}
