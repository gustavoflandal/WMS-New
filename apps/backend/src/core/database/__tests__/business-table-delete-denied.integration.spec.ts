// Scenario (SESSAO 2B, Entregável 1): RN-DAD-003 — DELETE físico é proibido
// em entidades de negócio referenciadas por movimentações. Migration 0010
// corrigiu o default privilege (que concedia DELETE a wms_app em todo o
// schema, herdado da migration 0001) e revogou DELETE das tabelas de
// negócio já criadas. Este teste prova, contra o Postgres real, que o pool
// de aplicação (wms_app) NÃO consegue fisicamente deletar de uma tabela de
// negócio — a proteção não depende apenas da omissão de `.delete()` nos
// services.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from './test-setup.helper.js';
import { v4 as uuid } from 'uuid';

describe('RN-DAD-003 - DELETE fisico negado pelo banco em tabela de negocio', () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('wms_app nao consegue DELETE de wms.warehouse (42501 insufficient_privilege)', async () => {
    await expect(testContext.databaseService.queryGlobal('DELETE FROM wms.warehouse WHERE id = $1', [uuid()])).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('wms_app nao consegue DELETE de wms.client (tabela de tenant)', async () => {
    const client = await testContext.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_ids', uuid()]);
      await expect(client.query('DELETE FROM wms.client WHERE id = $1', [uuid()])).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('wms_app CONTINUA conseguindo DELETE de wms.logical_warehouse_location (vinculo N:N de configuracao, RN-DAD-003 permite)', async () => {
    // Não insere linha real (não há FK válida disponível aqui) — só prova que
    // o DELETE não é barrado por permissão (chega a rodar e afeta 0 linhas,
    // em vez de lançar 42501 como nos casos acima).
    const result = await testContext.databaseService.queryGlobal('DELETE FROM wms.logical_warehouse_location WHERE id = $1', [uuid()]);
    expect(result.rowCount).toBe(0);
  });
});
