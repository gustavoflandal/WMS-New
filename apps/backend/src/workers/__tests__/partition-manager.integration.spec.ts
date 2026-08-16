// Scenario ENTREGÁVEL 9 — RNF-ARQ-090 (débito LAC-S1.5-003): job de
// particionamento de wms.stock_movement, com eleição de líder por lock
// Redis (RNF-ARQ-021) e alerta de partição ausente.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../core/database/__tests__/test-setup.helper.js';
import { CacheModule } from '../../core/cache/cache.module.js';
import { CacheService } from '../../core/cache/cache.service.js';
import { PartitionManagerWorkerImpl } from '../partition-manager.worker.impl.js';

describe('PartitionManagerWorkerImpl - RNF-ARQ-090 particionamento de stock_movement', () => {
  let testContext: TestContext;
  let cacheService: CacheService;

  beforeAll(async () => {
    testContext = await setupIntegrationTest([CacheModule]);
    cacheService = testContext.module.get<CacheService>(CacheService);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function partitionExists(year: number, month: number): Promise<boolean> {
    const name = `stock_movement_y${year}_m${String(month).padStart(2, '0')}`;
    const result = await testContext.databaseService.queryGlobal(
      `SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = 'wms'::regnamespace`,
      [name]
    );
    return result.rows.length > 0;
  }

  it('antes do dia 20: nao cria particao do mes seguinte se ela ainda nao existir', async () => {
    const worker = new PartitionManagerWorkerImpl(testContext.databaseService, cacheService);
    // Ano bem distante para nao colidir com o bootstrap da migration 0014
    // (mes corrente/seguinte reais) nem com outros testes deste arquivo.
    const referenceDate = new Date(Date.UTC(2031, 2, 10)); // 2031-03-10 (dia 10, ainda nao e 20)

    const result = await worker.runOnce(referenceDate);

    expect(result.ranAsLeader).toBe(true);
    // Mes corrente (2031-03) foi criado pq nao existia (alerta) -- mes
    // seguinte (2031-04) NAO deveria ter sido criado, pois ainda nao e dia 20.
    expect(await partitionExists(2031, 3)).toBe(true);
    expect(await partitionExists(2031, 4)).toBe(false);
    expect(result.missingPartitionAlerts).toHaveLength(1);
  });

  it('a partir do dia 20: cria a particao do mes seguinte com antecedencia', async () => {
    const worker = new PartitionManagerWorkerImpl(testContext.databaseService, cacheService);
    const referenceDate = new Date(Date.UTC(2032, 5, 20)); // 2032-06-20

    const result = await worker.runOnce(referenceDate);

    expect(result.ranAsLeader).toBe(true);
    expect(await partitionExists(2032, 6)).toBe(true); // mes corrente
    expect(await partitionExists(2032, 7)).toBe(true); // mes seguinte, com antecedencia
    expect(result.createdPartitions).toContain('stock_movement_y2032_m07');
  });

  it('idempotente: rodar de novo no mesmo dia nao falha nem duplica', async () => {
    const worker = new PartitionManagerWorkerImpl(testContext.databaseService, cacheService);
    const referenceDate = new Date(Date.UTC(2032, 5, 21)); // 2032-06-21

    const result = await worker.runOnce(referenceDate);

    expect(result.ranAsLeader).toBe(true);
    expect(result.createdPartitions).toHaveLength(0); // ja existiam do teste anterior
    expect(result.missingPartitionAlerts).toHaveLength(0);
  });

  it('eleicao de lider: duas "replicas" concorrentes -- so uma executa por ciclo', async () => {
    // Simula 2 réplicas do scheduler = 2 conexões CacheService independentes,
    // não a mesma instância reaproveitada (senão o lock nunca colidiria).
    const cacheServiceReplicaA = new CacheService(testContext.configService);
    const cacheServiceReplicaB = new CacheService(testContext.configService);
    await cacheServiceReplicaA.onModuleInit();
    await cacheServiceReplicaB.onModuleInit();

    try {
      const workerA = new PartitionManagerWorkerImpl(testContext.databaseService, cacheServiceReplicaA);
      const workerB = new PartitionManagerWorkerImpl(testContext.databaseService, cacheServiceReplicaB);
      const referenceDate = new Date(Date.UTC(2033, 8, 20)); // 2033-09-20

      const [resultA, resultB] = await Promise.all([workerA.runOnce(referenceDate), workerB.runOnce(referenceDate)]);

      const leaders = [resultA, resultB].filter((r) => r.ranAsLeader);
      expect(leaders).toHaveLength(1); // exatamente uma das duas venceu a eleicao

      expect(await partitionExists(2033, 9)).toBe(true);
      expect(await partitionExists(2033, 10)).toBe(true);
    } finally {
      await cacheServiceReplicaA.onApplicationShutdown();
      await cacheServiceReplicaB.onApplicationShutdown();
    }
  });
});
