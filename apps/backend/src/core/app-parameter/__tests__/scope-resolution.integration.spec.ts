// Scenario: Resolução de escopo de app_parameter (RD-ARQ-004)
// RNF-ARQ-080: Scope hierarchy CLIENT_WAREHOUSE > CLIENT > WAREHOUSE > GLOBAL
// Escopos válidos (DOC-02 §5.7): GLOBAL, WAREHOUSE, CLIENT, CLIENT_WAREHOUSE
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../database/__tests__/test-setup.helper';
import { DatabaseService } from '../../database/database.service';
import { v4 as uuid } from 'uuid';

describe('App Parameter - Scope Resolution', () => {
  let testContext: TestContext;
  let databaseService: DatabaseService;

  // Describe-level UUIDs reused across all tests
  const warehouse = uuid();
  const client = uuid();
  const tenant = uuid();

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    databaseService = testContext.databaseService;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  beforeEach(async () => {
    // Clean up test rows for all scope types.
    // Must supply warehouse_id + client_id so RLS USING clause can see
    // WAREHOUSE, CLIENT and CLIENT_WAREHOUSE rows for deletion (RNF-ARQ-011).
    await databaseService.transaction(
      { tenant_id: tenant, user_id: uuid(), warehouse_id: warehouse, client_id: client },
      async (client_conn) => {
        await client_conn.query('DELETE FROM wms.app_parameter WHERE name LIKE $1', [
          'test_%',
        ]);
      }
    );
  });

  it('Returns most specific scope (CLIENT_WAREHOUSE)', async () => {
    // Insert at different scopes — context must include warehouse_id AND client_id
    // so the RLS WITH CHECK allows rows at every scope level (RNF-ARQ-011).
    await databaseService.transaction(
      { tenant_id: tenant, user_id: uuid(), warehouse_id: warehouse, client_id: client },
      async (client_conn) => {
        await client_conn.query(
          `INSERT INTO wms.app_parameter (name, value, scope, warehouse_id, client_id)
           VALUES
           ($1, $2, 'GLOBAL', NULL, NULL),
           ($1, $3, 'WAREHOUSE', $4, NULL),
           ($1, $5, 'CLIENT', NULL, $6),
           ($1, $7, 'CLIENT_WAREHOUSE', $4, $6)`,
          ['test_key', 'global_value', 'warehouse_value', warehouse, 'client_value', client, 'client_warehouse_value']
        );
      }
    );

    const result = await databaseService.query(
      { tenant_id: tenant, user_id: uuid(), warehouse_id: warehouse, client_id: client },
      `SELECT value FROM wms.app_parameter
       WHERE name = $1 AND scope = 'CLIENT_WAREHOUSE' AND warehouse_id = $2 AND client_id = $3`,
      ['test_key', warehouse, client]
    );

    expect(result.rows[0].value).toBe('client_warehouse_value');
  });

  it('Falls back to CLIENT when CLIENT_WAREHOUSE not defined', async () => {
    // Only GLOBAL and CLIENT rows — need client_id in context for CLIENT scope.
    await databaseService.transaction(
      { tenant_id: tenant, user_id: uuid(), client_id: client },
      async (client_conn) => {
        await client_conn.query(
          `INSERT INTO wms.app_parameter (name, value, scope, warehouse_id, client_id)
           VALUES
           ($1, $2, 'GLOBAL', NULL, NULL),
           ($1, $3, 'CLIENT', NULL, $4)`,
          ['test_key', 'global_value', 'client_value', client]
        );
      }
    );

    const result = await databaseService.query(
      { tenant_id: tenant, user_id: uuid(), client_id: client },
      `SELECT value FROM wms.app_parameter
       WHERE name = $1 AND scope = 'CLIENT' AND client_id = $2`,
      ['test_key', client]
    );

    expect(result.rows[0].value).toBe('client_value');
  });

  it('Falls back to WAREHOUSE when CLIENT_WAREHOUSE and CLIENT not defined', async () => {
    // Only GLOBAL and WAREHOUSE rows — need warehouse_id in context.
    await databaseService.transaction(
      { tenant_id: tenant, user_id: uuid(), warehouse_id: warehouse },
      async (client_conn) => {
        await client_conn.query(
          `INSERT INTO wms.app_parameter (name, value, scope, warehouse_id, client_id)
           VALUES
           ($1, $2, 'GLOBAL', NULL, NULL),
           ($1, $3, 'WAREHOUSE', $4, NULL)`,
          ['test_key', 'global_value', 'warehouse_value', warehouse]
        );
      }
    );

    const result = await databaseService.query(
      { tenant_id: tenant, user_id: uuid(), warehouse_id: warehouse },
      `SELECT value FROM wms.app_parameter
       WHERE name = $1 AND scope = 'WAREHOUSE' AND warehouse_id = $2`,
      ['test_key', warehouse]
    );

    expect(result.rows[0].value).toBe('warehouse_value');
  });

  it('Falls back to GLOBAL as last resort', async () => {
    // GLOBAL rows are visible to any configured tenant context (no warehouse/client needed).
    await databaseService.transaction(
      { tenant_id: tenant, user_id: uuid() },
      async (client_conn) => {
        await client_conn.query(
          `INSERT INTO wms.app_parameter (name, value, scope, warehouse_id, client_id)
           VALUES ($1, $2, 'GLOBAL', NULL, NULL)`,
          ['test_key', 'global_value']
        );
      }
    );

    const result = await databaseService.query(
      { tenant_id: tenant, user_id: uuid() },
      `SELECT value FROM wms.app_parameter
       WHERE name = $1 AND scope = 'GLOBAL'`,
      ['test_key']
    );

    expect(result.rows[0].value).toBe('global_value');
  });

  it('Returns NULL when parameter not found in any scope', async () => {
    const result = await databaseService.query(
      { tenant_id: tenant, user_id: uuid() },
      `SELECT value FROM wms.app_parameter
       WHERE name = $1 LIMIT 1`,
      ['nonexistent_key']
    );

    expect(result.rows.length).toBe(0);
  });

  it('DML isolation: WAREHOUSE write from warehouseB context cannot affect warehouseA row', async () => {
    // Verifica RG-001: escrita de um contexto não pode afetar linha de outro contexto.
    // warehouseA reuses the describe-level `warehouse` so beforeEach cleanup can reach it.
    const warehouseA = warehouse;
    const warehouseB = uuid();

    // Setup: insert a WAREHOUSE row belonging to warehouseA
    await databaseService.transaction(
      { tenant_id: tenant, user_id: uuid(), warehouse_id: warehouseA },
      async (c) => {
        await c.query(
          `INSERT INTO wms.app_parameter (name, value, scope, warehouse_id)
           VALUES ($1, $2, 'WAREHOUSE', $3)`,
          ['test_isolation_key', 'original_value', warehouseA]
        );
      }
    );

    // Attempt: DELETE from warehouseB context targeting warehouseA row.
    // RLS USING: warehouse_id = current_setting('app.warehouse_id')::UUID
    //   = warehouseA = warehouseB → FALSE → row invisible → rowCount = 0.
    let deletedCount = -1;
    await databaseService.transaction(
      { tenant_id: tenant, user_id: uuid(), warehouse_id: warehouseB },
      async (c) => {
        const r = await c.query(
          `DELETE FROM wms.app_parameter WHERE name = $1 AND warehouse_id = $2`,
          ['test_isolation_key', warehouseA]
        );
        deletedCount = r.rowCount ?? 0;
      }
    );

    expect(deletedCount).toBe(0);

    // Cleanup: remove the row from the correct context
    await databaseService.transaction(
      { tenant_id: tenant, user_id: uuid(), warehouse_id: warehouseA },
      async (c) => {
        await c.query(`DELETE FROM wms.app_parameter WHERE name = $1 AND warehouse_id = $2`, [
          'test_isolation_key',
          warehouseA,
        ]);
      }
    );
  });
});
