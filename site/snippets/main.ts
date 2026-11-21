// main.ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { installGracefulShutdown } from '@noctcore/jobs';

import { AppModule } from './app.module';
import { flushTelemetry } from './telemetry';

const app = await NestFactory.createApplicationContext(AppModule);

// Instead of app.enableShutdownHooks(), never together with it.
installGracefulShutdown(app, { flush: flushTelemetry });
