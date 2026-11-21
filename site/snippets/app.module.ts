// app.module.ts
import { Module } from '@nestjs/common';
import { JobsModule } from '@noctcore/jobs';

import { mail } from './mail.queue';
import { MailWorker } from './mail.worker';
import { MaintenanceSweeps } from './maintenance.sweeps';
import { SignupService } from './signup.service';
import { AppConfig, Mailer, TokenStore } from './support';

@Module({
  imports: [
    JobsModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ redisUrl: config.get('REDIS_URL') }),
    }),
    JobsModule.forFeature([mail]),
  ],
  providers: [AppConfig, Mailer, TokenStore, SignupService, MailWorker, MaintenanceSweeps],
})
export class AppModule {}
