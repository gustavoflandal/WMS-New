// RNF-ARQ-003: Multi-role bootstrap (api|worker|scheduler)
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  const appRole = process.env.APP_ROLE || 'api';
  const apiPort = configService.get<number>('API_PORT', 3000);

  // RNF-ARQ-003: Conditional HTTP server based on APP_ROLE
  if (appRole === 'api') {
    await app.listen(apiPort, '0.0.0.0');
    logger.log(`✓ API server listening on port ${apiPort}`);
  } else if (appRole === 'worker') {
    logger.log('✓ Worker service started (no HTTP)');
    // Worker-specific initialization will be in worker module
  } else if (appRole === 'scheduler') {
    logger.log('✓ Scheduler service started (no HTTP)');
    // Scheduler-specific initialization will be in scheduler module
  }

  logger.log(`Application role: ${appRole}`);
}

bootstrap().catch((err) => {
  logger.error('Failed to start application:', err);
  process.exit(1);
});
