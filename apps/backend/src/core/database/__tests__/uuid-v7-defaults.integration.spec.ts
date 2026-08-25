// DOC-00 RG-011 — "Chaves primárias: UUID v7".
//
// Achado de revisão (2026-08-25): a regra nunca havia sido cumprida — 98
// DEFAULTs de PK usavam gen_random_uuid() (v4). A migration 0077 trocou
// todos de uma vez por wms.uuid_v7(). Este teste é a rede que impede a
// regressão silenciosa: se alguém criar tabela nova com
// `DEFAULT gen_random_uuid()` (o reflexo natural, já que 46 migrations
// antigas fazem assim), o contrato falha aqui — não em produção, meses
// depois, como índice inchado.
import { Pool } from 'pg';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from './test-setup.helper.js';

describe('DOC-00 RG-011 — UUID v7 como DEFAULT de chave primária', () => {
  let testContext: TestContext;
  let pool: Pool;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
    });
  });

  afterAll(async () => {
    await pool.end();
    await teardownIntegrationTest(testContext);
  });

  it('NENHUMA coluna do schema wms ainda usa gen_random_uuid() como DEFAULT', async () => {
    const result = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN pg_class pc ON pc.relname = c.table_name
       JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'wms'
       WHERE c.table_schema = 'wms'
         AND c.column_default LIKE '%gen_random_uuid()%'
         AND pc.relispartition = FALSE
       ORDER BY 1, 2`
    );
    const offenders = result.rows.map((r) => `${r.table_name}.${r.column_name}`);
    expect(offenders).toEqual([]);
  });

  it('há de fato colunas usando wms.uuid_v7() (o teste acima não passa por vacuidade)', async () => {
    const result = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n
       FROM information_schema.columns c
       JOIN pg_class pc ON pc.relname = c.table_name
       JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'wms'
       WHERE c.table_schema = 'wms'
         AND c.column_default LIKE '%uuid_v7()%'
         AND pc.relispartition = FALSE`
    );
    // 46 migrations trocadas de uma vez — o número exato varia a cada
    // tabela nova, mas tem de ser expressivo, não 1 ou 2.
    expect(Number(result.rows[0].n)).toBeGreaterThan(50);
  });

  it('wms.uuid_v7() gera UUID conforme: versão 7 e variante RFC', async () => {
    const result = await pool.query<{ id: string }>(`SELECT wms.uuid_v7()::text AS id FROM generate_series(1, 200)`);
    expect(result.rows).toHaveLength(200);
    for (const row of result.rows) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('wms.uuid_v7() é ordenável por tempo e não colide em lote', async () => {
    const first = await pool.query<{ id: string }>(`SELECT wms.uuid_v7()::text AS id`);
    await new Promise((r) => setTimeout(r, 5));
    const second = await pool.query<{ id: string }>(`SELECT wms.uuid_v7()::text AS id`);
    expect(second.rows[0].id > first.rows[0].id).toBe(true);

    const batch = await pool.query<{ id: string }>(`SELECT wms.uuid_v7()::text AS id FROM generate_series(1, 5000)`);
    expect(new Set(batch.rows.map((r) => r.id)).size).toBe(5000);
  });

  it('o DEFAULT real de uma tabela produz v7 no INSERT (não só a função isolada)', async () => {
    // wms.warehouse: sem RLS, PK com DEFAULT — insere e confere a versão.
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO wms.warehouse (code, name, cnpj, timezone, created_by)
       VALUES ('RG011', 'Armazém RG-011', '11222333000181', 'America/Sao_Paulo', '00000000-0000-0000-0000-000000000001')
       RETURNING id::text`
    );
    expect(inserted.rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await pool.query(`DELETE FROM wms.warehouse WHERE id = $1`, [inserted.rows[0].id]);
  });
});
