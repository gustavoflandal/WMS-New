// DOC-03 §4.6/RF-POR-031 — portaria.pessoa_entrou/portaria.pessoa_saiu devem
// ser publicados de verdade (outbox → worker real → Pub/Sub) para que o
// painel de presentes atualize em tempo real. tenant_id NULL (migration
// 0031): person_visit/visitor são GLOBAL (RD-POR-004), sem client
// associável — o fanout roteia para o canal sentinela `rt:global:...`
// (realtime-fanout.worker.impl.ts), não para um tenant real.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { generateValidCnpj, randomWarehouseCode } from '../../cadastro/__tests__/test-helpers.js';
import { setupPortariaServices, PortariaServices, randomVisitorDocument } from './test-helpers.js';
import { SEED_ACTOR_ID } from '../../../core/__tests__/security-test-helpers.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OutboxPublisherWorkerImpl } from '../../../workers/outbox-publisher.worker.impl.js';
import { RealtimeFanoutWorkerImpl } from '../../../workers/realtime-fanout.worker.impl.js';
import { createClient, RedisClientType } from 'redis';
import { STANDARD_TOPICS } from '@wms/contracts';

describe('Portaria - DOC-03 §4.6 eventos de presença de pessoas em tempo real (RF-POR-031)', () => {
  let testContext: TestContext;
  let services: PortariaServices;
  let warehouseId: string;
  let outboxWorker: OutboxPublisherWorkerImpl;
  let fanoutWorker: RealtimeFanoutWorkerImpl;
  let redisClient: RedisClientType;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const auditService = new AuditService(testContext.databaseService);
    const warehouseService = new WarehouseService(testContext.databaseService, auditService);
    services = setupPortariaServices(testContext.databaseService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém eventos de pessoa', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;

    redisClient = createClient({ url: testContext.configService.get('REDIS_URL', 'redis://localhost:6379/0') });
    await redisClient.connect();

    outboxWorker = new OutboxPublisherWorkerImpl(testContext.databaseService, testContext.configService);
    await outboxWorker.init();

    fanoutWorker = new RealtimeFanoutWorkerImpl(testContext.configService);
    await fanoutWorker.init();

    // Aquecimento: a PRIMEIRA chamada de pollStreams() no processo precisa
    // criar (XGROUP CREATE) o consumer group em CADA stream events:* já
    // existente no Redis compartilhado — vários round-trips sequenciais.
    // Sem isso, apenas o primeiro teste do arquivo paga esse custo (medido:
    // ~2-5s+ em vez de <300ms), tornando-o flaky sob o timeout fixo. Um
    // pollStreams() aqui, antes de qualquer `it()`, paga esse custo uma vez
    // de forma determinística em vez de deixá-lo cair aleatoriamente sobre
    // o primeiro teste.
    await fanoutWorker.pollStreams();
  });

  afterAll(async () => {
    await outboxWorker.stop();
    await fanoutWorker.stop();
    try {
      await redisClient.quit();
    } catch {
      // ignore
    }
    await teardownIntegrationTest(testContext);
  });

  // Subscreve e RETORNA já inscrito (awaited) — só depois disso o chamador
  // deve executar a ação que gera o evento, e só então drenar outbox→stream
  // via pollAndAwait(). Combinar subscribe+poll+action num único helper
  // (como numa primeira versão deste teste) cria uma corrida real: pollBatch()
  // podia rodar ANTES da escrita que ele deveria drenar, já que a função
  // async só bloqueia o chamador no primeiro `await` interno.
  async function subscribeToTopic(pubsubKey: string): Promise<{
    subscriber: RedisClientType;
    received: Promise<Record<string, any>>;
  }> {
    const subscriber = createClient({ url: testContext.configService.get('REDIS_URL', 'redis://localhost:6379/0') });
    await subscriber.connect();
    let resolve!: (v: Record<string, any>) => void;
    const received = new Promise<Record<string, any>>((r) => (resolve = r));
    await subscriber.subscribe(pubsubKey, (message) => resolve(JSON.parse(message)));
    return { subscriber, received };
  }

  async function pollAndAwait(
    pubsubKey: string,
    subscriber: RedisClientType,
    received: Promise<Record<string, any>>
  ): Promise<Record<string, any>> {
    await outboxWorker.pollBatch();
    await fanoutWorker.pollStreams();

    const message = await Promise.race([
      received,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout waiting on ${pubsubKey}`)), 2000)),
    ]);

    await subscriber.unsubscribe(pubsubKey);
    await subscriber.quit();
    return message;
  }

  it('gate-in de visitante publica portaria.pessoa_entrou em rt:global:{warehouse}:patio', async () => {
    const visitor = await services.visitorService.upsertByDocument(
      { document: randomVisitorDocument(), name: 'Visitante Evento' },
      SEED_ACTOR_ID
    );

    const outboxCountBefore = await testContext.databaseService.queryGlobal(
      `SELECT COUNT(*) AS count FROM wms.event_outbox WHERE event_type = 'portaria.pessoa_entrou' AND tenant_id IS NULL`
    );

    const pubsubKey = `rt:global:${warehouseId}:${STANDARD_TOPICS.PATIO}`;
    const { subscriber, received } = await subscribeToTopic(pubsubKey);

    const visit = await services.personVisitService.gateIn(
      {
        visitorId: visitor.id,
        warehouseId,
        hostReason: 'Reunião comercial',
        authorizedAreas: [],
        validUntil: new Date(Date.now() + 4 * 3600_000).toISOString(),
      },
      SEED_ACTOR_ID
    );

    const message = await pollAndAwait(pubsubKey, subscriber, received);
    expect(message.event_type).toBe('portaria.pessoa_entrou');

    const outboxCountAfter = await testContext.databaseService.queryGlobal(
      `SELECT COUNT(*) AS count FROM wms.event_outbox WHERE event_type = 'portaria.pessoa_entrou' AND tenant_id IS NULL`
    );
    expect(Number(outboxCountAfter.rows[0].count)).toBe(Number(outboxCountBefore.rows[0].count) + 1);

    // RF-POR-031: o painel de presentes continua servido por consulta direta também.
    const onSite = await services.personVisitService.listOnSite(warehouseId);
    expect(onSite.some((p: any) => p.id === visit.id)).toBe(true);
  });

  it('gate-out de visitante publica portaria.pessoa_saiu em rt:global:{warehouse}:patio', async () => {
    const visitor = await services.visitorService.upsertByDocument(
      { document: randomVisitorDocument(), name: 'Visitante Saída' },
      SEED_ACTOR_ID
    );
    const visit = await services.personVisitService.gateIn(
      {
        visitorId: visitor.id,
        warehouseId,
        hostReason: 'Entrega',
        authorizedAreas: [],
        validUntil: new Date(Date.now() + 4 * 3600_000).toISOString(),
      },
      SEED_ACTOR_ID
    );
    // Drena o pessoa_entrou desta visita para isolar a asserção no pessoa_saiu.
    await outboxWorker.pollBatch();
    await fanoutWorker.pollStreams();

    const pubsubKey = `rt:global:${warehouseId}:${STANDARD_TOPICS.PATIO}`;
    const { subscriber, received } = await subscribeToTopic(pubsubKey);

    await services.personVisitService.gateOut(visit.id, SEED_ACTOR_ID);

    const message = await pollAndAwait(pubsubKey, subscriber, received);
    expect(message.event_type).toBe('portaria.pessoa_saiu');

    const onSiteAfter = await services.personVisitService.listOnSite(warehouseId);
    expect(onSiteAfter.some((p: any) => p.id === visit.id)).toBe(false);
  });
});
