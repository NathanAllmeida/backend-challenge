import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { appConfig } from './config/app.config';
import { JsonLogger } from './infrastructure/observability/json-logger';

const logger = new JsonLogger();
const app = await NestFactory.create(AppModule, { logger, bufferLogs: true });

app.enableShutdownHooks();
await app.listen(appConfig.port);

logger.log({ message: 'wagering processor listening', port: appConfig.port, workers: appConfig.workersEnabled }, 'Bootstrap');
