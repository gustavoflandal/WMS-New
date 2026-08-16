// Scenario ENTREGÁVEL 8/9 — RNF-ARQ-090: stock_movement é particionada
// mensalmente; a partição do mês corrente (e a do mês seguinte, bootstrap
// da migration 0014) precisa existir para o primeiro INSERT do mês não
// falhar (LAC-S1.5-003).
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';

describe('Cadastro - RNF-ARQ-090 particao mensal de stock_movement', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('particao do mes corrente existe (criada no bootstrap da migration 0014)', async () => {
    const now = new Date();
    const partitionName = `stock_movement_y${now.getUTCFullYear()}_m${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const result = await testContext.databaseService.queryGlobal(
      `SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = 'wms'::regnamespace`,
      [partitionName]
    );
    expect(result.rows.length).toBe(1);
  });

  it('particao do mes seguinte tambem existe (bootstrap cobre 2 meses)', async () => {
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 1);
    const partitionName = `stock_movement_y${next.getUTCFullYear()}_m${String(next.getUTCMonth() + 1).padStart(2, '0')}`;

    const result = await testContext.databaseService.queryGlobal(
      `SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = 'wms'::regnamespace`,
      [partitionName]
    );
    expect(result.rows.length).toBe(1);
  });

  it('wms.ensure_stock_movement_partition e idempotente e revoga UPDATE/DELETE na particao criada', async () => {
    const farFuture = new Date();
    farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 5);
    const year = farFuture.getUTCFullYear();
    const month = farFuture.getUTCMonth() + 1;
    const partitionName = `stock_movement_y${year}_m${String(month).padStart(2, '0')}`;

    const first = await testContext.databaseService.queryGlobal('SELECT wms.ensure_stock_movement_partition($1, $2) AS name', [year, month]);
    const second = await testContext.databaseService.queryGlobal('SELECT wms.ensure_stock_movement_partition($1, $2) AS name', [year, month]);
    expect(first.rows[0].name).toBe(partitionName);
    expect(second.rows[0].name).toBe(partitionName);

    const grants = await testContext.databaseService.queryGlobal(
      `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee = 'wms_app'`,
      [partitionName]
    );
    const privileges = grants.rows.map((r) => r.privilege_type).sort();
    expect(privileges).toEqual(['INSERT', 'SELECT']);
  });
});
