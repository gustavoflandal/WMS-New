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
import { NoShowWorkerImpl } from './workers/no-show.worker.impl.js';
import { CrossDockAgingWorkerImpl } from './workers/crossdock-aging.worker.impl.js';
import { ExpirationAlertWorkerImpl } from './workers/expiration-alert.worker.impl.js';
import { ReplenishmentAlertWorkerImpl } from './workers/replenishment-alert.worker.impl.js';
import { ReservationExpiryWorkerImpl } from './workers/reservation-expiry.worker.impl.js';
import { KpiMaterializationWorkerImpl } from './modules/paineis/kpi/kpi-materialization.worker.impl.js';
import { KpiMaterializationService } from './modules/paineis/kpi/kpi-materialization.service.js';
import { KpiSnapshotWorkerImpl } from './modules/paineis/kpi/kpi-snapshot.worker.impl.js';
import { KpiSnapshotService } from './modules/paineis/kpi/kpi-snapshot.service.js';
import { AlertMaterializationWorkerImpl } from './modules/paineis/alertas/alert-materialization.worker.impl.js';
import { AlertMaterializationService } from './modules/paineis/alertas/alert-materialization.service.js';
import { CacheService } from './core/cache/cache.service.js';
import { OperationalExceptionService } from './core/workflow/operational-exception.service.js';
import { AppointmentService } from './modules/portaria/appointment/appointment.service.js';
import { CrossDockService } from './modules/recebimento/crossdock/crossdock.service.js';
import { ExpirationService } from './modules/estoque/expiration/expiration.service.js';
import { SafetyStockService } from './modules/estoque/replenishment/safety-stock.service.js';
import { KanbanService } from './modules/estoque/replenishment/kanban.service.js';
import { ReservationExpiryService } from './modules/expedicao/order/reservation-expiry.service.js';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Sem isto, nenhum fetch do frontend (origem :3001) contra a API (origem
  // :3000) funciona em navegador real — a resposta some sem
  // Access-Control-Allow-Origin e o browser bloqueia antes do app.
  // RealtimeGateway já fazia o equivalente para WebSocket (mesma env var
  // CORS_ORIGIN); a API REST nunca teve o análogo até esta sessão (achado
  // via verificação manual ponta a ponta, Sessão 7B). PRECISA vir antes de
  // app.init() (linha abaixo): Nest registra todas as rotas/middlewares
  // durante init() e chamar enableCors() depois insere o middleware DEPOIS
  // do handler 404 padrão no stack do Express — o preflight OPTIONS nunca
  // alcança o CORS (achado ao reproduzir com um navegador headless real, não
  // só curl: curl não executa preflight, então o bug ficava invisível até
  // aqui). Chamada incondicional: worker/scheduler nunca dão listen(), então
  // é inofensiva para eles.
  app.enableCors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3001', credentials: true });

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
    // DOC-10 RN-PAI-042: consome os MESMOS streams events:* que realtime-fanout,
    // com grupo consumidor próprio (group:kpi-materialization).
    const kpiMaterialization = new KpiMaterializationWorkerImpl(configService, app.get(KpiMaterializationService));
    // DOC-10 RF-PAI-010: idem, grupo consumidor próprio (group:alert-materialization).
    const alertMaterialization = new AlertMaterializationWorkerImpl(configService, app.get(AlertMaterializationService));

    await outboxPublisher.start();
    await realtimeFanout.start();
    await kpiMaterialization.start();
    await alertMaterialization.start();

    const shutdown = async (): Promise<void> => {
      logger.log('Shutting down worker service...');
      await outboxPublisher.stop();
      await realtimeFanout.stop();
      await kpiMaterialization.stop();
      await alertMaterialization.stop();
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.log('✓ Worker service started (outbox-publisher + realtime-fanout + kpi-materialization + alert-materialization)');
  } else if (appRole === 'scheduler') {
    // RNF-ARQ-090 (LAC-S1.5-003): partition-manager job — keeps its own
    // poll loop alive (24h cycle in production), same lifecycle pattern as
    // the worker role above.
    const databaseService = app.get(DatabaseService);
    const cacheService = app.get(CacheService);
    const operationalExceptionService = app.get(OperationalExceptionService);
    const appointmentService = app.get(AppointmentService);
    const crossDockService = app.get(CrossDockService);
    const expirationService = app.get(ExpirationService);
    const safetyStockService = app.get(SafetyStockService);
    const kanbanService = app.get(KanbanService);
    const reservationExpiryService = app.get(ReservationExpiryService);
    const kpiSnapshotService = app.get(KpiSnapshotService);
    const alertMaterializationService = app.get(AlertMaterializationService);

    const partitionManager = new PartitionManagerWorkerImpl(databaseService, cacheService);
    // DOC-12 RN-SEG-042: expira exceções vencidas (auto_expire_hours).
    const exceptionExpiry = new ExceptionExpiryWorkerImpl(operationalExceptionService, cacheService);
    // DOC-03 RN-POR-004: expira agendamentos sem gate-in (NO_SHOW).
    const noShow = new NoShowWorkerImpl(appointmentService, cacheService);
    // DOC-04 RNF-REC-052: alerta de permanência em zona CROSS_DOCKING.
    const crossDockAging = new CrossDockAgingWorkerImpl(crossDockService, cacheService);
    // DOC-05 RN-EST-014: alerta de vencimento (90/60/30/15/0 dias) + bloqueio automático de saldo VENCIDO.
    const expirationAlert = new ExpirationAlertWorkerImpl(expirationService, cacheService);
    // DOC-05 RF-EST-040/041: estoque de segurança + kanban (execução horária).
    const replenishmentAlert = new ReplenishmentAlertWorkerImpl(safetyStockService, kanbanService, cacheService);
    // DOC-06 RN-EXP-003: expira reservas de pedido sem picking iniciado.
    const reservationExpiry = new ReservationExpiryWorkerImpl(reservationExpiryService, cacheService);
    // DOC-10 RN-PAI-042: K-13/K-14/K-16 (snapshot, 23:59 do fuso do armazém).
    const kpiSnapshot = new KpiSnapshotWorkerImpl(kpiSnapshotService, cacheService, alertMaterializationService);
    await partitionManager.start();
    await exceptionExpiry.start();
    await noShow.start();
    await crossDockAging.start();
    await expirationAlert.start();
    await replenishmentAlert.start();
    await reservationExpiry.start();
    await kpiSnapshot.start();

    const shutdown = async (): Promise<void> => {
      logger.log('Shutting down scheduler service...');
      await partitionManager.stop();
      await exceptionExpiry.stop();
      await noShow.stop();
      await crossDockAging.stop();
      await expirationAlert.stop();
      await replenishmentAlert.stop();
      await reservationExpiry.stop();
      await kpiSnapshot.stop();
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    logger.log('✓ Scheduler service started (partition-manager + exception-expiry + no-show + crossdock-aging + expiration-alert + replenishment-alert + reservation-expiry + kpi-snapshot)');
  }

  logger.log(`Application role: ${appRole}`);
}

bootstrap().catch((err) => {
  logger.error('Failed to start application:', err);
  process.exit(1);
});
