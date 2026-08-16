// RNF-ARQ-003: Multi-role bootstrap (api|worker|scheduler)
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { DatabaseService } from './core/database/database.service.js';
import { OutboxPublisherWorkerImpl } from './workers/outbox-publisher.worker.impl.js';
import { RealtimeFanoutWorkerImpl } from './workers/realtime-fanout.worker.impl.js';
import { PartitionManagerWorkerImpl } from './workers/partition-manager.worker.impl.js';
import { ExceptionExpiryWorkerImpl } from './workers/exception-expiry.worker.impl.js';
import { CacheService } from './core/cache/cache.service.js';
import { OperationalExceptionService } from './core/workflow/operational-exception.service.js';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // DOC-12 RG-003 [INVIOLÁVEL]: o middleware de rejeição de actor_user_id/
  // user_id forjados é registrado via AppModule.configure() (NestModule),
  // não aqui — ver o comentário em app.module.ts para o porquê.

  // RNF-ARQ-003: onModuleInit() (DatabaseModule's pool setup, migrations,
  // etc.) only runs once the app is initialized. app.listen() (api role)
  // triggers this internally, but worker/scheduler never call listen(), so
  // it must be triggered explicitly here — otherwise DatabaseService's pools
  // are still undefined when the worker starts polling.
  await app.init();

  const appRole = process.env.APP_ROLE || 'api';
  const apiPort = configService.get<number>('API_PORT', 3000);

  // RNF-ARQ-003: Conditional HTTP server based on APP_ROLE
  if (appRole === 'api') {
    await app.listen(apiPort, '0.0.0.0');
    logger.log(`✓ API server listening on port ${apiPort}`);
  } else if (appRole === 'worker') {
    // RNF-ARQ-031/032: outbox-publisher; RNF-ARQ-033: realtime-fanout.
    // Both keep their own poll loop alive, which keeps this process alive
    // (no HTTP listener needed for APP_ROLE=worker).
    const databaseService = app.get(DatabaseService);

    const outboxPublisher = new OutboxPublisherWorkerImpl(databaseService, configService);
    const realtimeFanout = new RealtimeFanoutWorkerImpl(configService);

    await outboxPublisher.start();
    await realtimeFanout.start();

    const shutdown = async (): Promise<void> => {
      logger.log('Shutting down worker service...');
      await outboxPublisher.stop();
      await realtimeFanout.stop();
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.log('✓ Worker service started (outbox-publisher + realtime-fanout)');
  } else if (appRole === 'scheduler') {
    // RNF-ARQ-090 (LAC-S1.5-003): partition-manager job — keeps its own
    // poll loop alive (24h cycle in production), same lifecycle pattern as
    // the worker role above.
    const databaseService = app.get(DatabaseService);
    const cacheService = app.get(CacheService);
    const operationalExceptionService = app.get(OperationalExceptionService);

    const partitionManager = new PartitionManagerWorkerImpl(databaseService, cacheService);
    // DOC-12 RN-SEG-042: expira exceções vencidas (auto_expire_hours).
    const exceptionExpiry = new ExceptionExpiryWorkerImpl(operationalExceptionService, cacheService);
    await partitionManager.start();
    await exceptionExpiry.start();

    const shutdown = async (): Promise<void> => {
      logger.log('Shutting down scheduler service...');
      await partitionManager.stop();
      await exceptionExpiry.stop();
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.log('✓ Scheduler service started (partition-manager + exception-expiry)');
  }

  logger.log(`Application role: ${appRole}`);
}

bootstrap().catch((err) => {
  logger.error('Failed to start application:', err);
  process.exit(1);
});
