// Scenario: RLS bloqueia acesso entre tenants [INVIOLÁVEL]
// RNF-ARQ-010..013: Tenant context isolation via PostgreSQL RLS
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from './test-setup.helper.js';
import { DatabaseService } from '../database.service.js';
import { v4 as uuid } from 'uuid';

describe('RLS - Tenant Isolation [INVIOLÁVEL]', () => {
  let testContext: TestContext;
  let databaseService: DatabaseService;

  const tenant1 = uuid();
  const tenant2 = uuid();
  const user1 = uuid();
  const user2 = uuid();

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    databaseService = testContext.databaseService;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('Tenant1 cannot see Tenant2 data via RLS', async () => {
    // Setup: Insert test data for tenant1 within tenant1 context
    await databaseService.transaction(
      { tenant_id: tenant1, user_id: user1 },
      async (client) => {
        await client.query(
          `INSERT INTO wms.rls_probe (id, tenant_id, data)
           VALUES ($1, $2, 'tenant1_secret_data')`,
          [uuid(), tenant1]
        );
      }
    );

    // Setup: Insert test data for tenant2 within tenant2 context
    await databaseService.transaction(
      { tenant_id: tenant2, user_id: user2 },
      async (client) => {
        await client.query(
          `INSERT INTO wms.rls_probe (id, tenant_id, data)
           VALUES ($1, $2, 'tenant2_secret_data')`,
          [uuid(), tenant2]
        );
      }
    );

    // Test: Query as tenant1, should only see tenant1 data
    const result = await databaseService.query(
      { tenant_id: tenant1, user_id: user1 },
      'SELECT data FROM wms.rls_probe'
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].data).toBe('tenant1_secret_data');
  });

  it('Tenant2 sees different data from Tenant1', async () => {
    // Test: Query as tenant2, should only see tenant2 data
    const result = await databaseService.query(
      { tenant_id: tenant2, user_id: user2 },
      'SELECT data FROM wms.rls_probe'
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].data).toBe('tenant2_secret_data');
  });

  it('Query without tenant context returns no rows', async () => {
    const client = await testContext.pool.connect();

    try {
      // Query WITHOUT setting tenant context
      const result = await client.query('SELECT * FROM wms.rls_probe');

      // RLS should prevent access
      expect(result.rows.length).toBe(0);
    } finally {
      client.release();
    }
  });

  it('Transaction enforces tenant context throughout', async () => {
    const tenant3 = uuid();
    const user3 = uuid();

    await databaseService.transaction(
      { tenant_id: tenant3, user_id: user3 },
      async (client) => {
        // Insert row for tenant3
        await client.query(
          `INSERT INTO wms.rls_probe (id, tenant_id, data)
           VALUES ($1, $2, 'tenant3_data')`,
          [uuid(), tenant3]
        );

        // Query should show the row we just inserted
        const result = await client.query('SELECT * FROM wms.rls_probe');
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].tenant_id.toString()).toBe(tenant3);
      }
    );
  });

  it('Different user in same tenant sees same data', async () => {
    // Both users from tenant1 should see tenant1 data
    const result1 = await databaseService.query(
      { tenant_id: tenant1, user_id: user1 },
      'SELECT data FROM wms.rls_probe'
    );

    const result2 = await databaseService.query(
      { tenant_id: tenant1, user_id: uuid() }, // Different user, same tenant
      'SELECT data FROM wms.rls_probe'
    );

    expect(result1.rows.length).toBe(result2.rows.length);
    expect(result1.rows[0].data).toBe(result2.rows[0].data);
  });
});
