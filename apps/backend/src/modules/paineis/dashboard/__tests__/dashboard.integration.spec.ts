// DOC-10 §4.5 RF-PAI-040/043 — dashboards contra Postgres real. Prova que a
// fonte é EXCLUSIVAMENTE kpi_daily (RF-PAI-040 "é PROIBIDO consultar tabela
// transacional quente") por inspeção do código-fonte (método explicitamente
// aceito pelo DoD desta sessão) — nenhum `FROM wms.<tabela transacional>`
// aparece em dashboard.service.ts.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { DashboardService } from '../dashboard.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Dashboard - DOC-10 §4.5 RF-PAI-040/043 (Sessão 7A)', () => {
  let testContext: TestContext;
  let dashboardService: DashboardService;
  let warehouseId: string;
  let clientId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    dashboardService = new DashboardService(db, auditService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém Dashboard', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente Dashboard', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    // Seed direto de kpi_daily — DashboardService só LÊ esta tabela; não há
    // necessidade de materializar via eventos reais para testar a camada de
    // leitura/agregação isoladamente (a materialização já é coberta por
    // kpi-materialization.integration.spec.ts).
    await db.transactionAsWorker(async (dbClient) => {
      const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'];
      for (const day of days) {
        const value = day === '2026-08-08' ? 100 : 10; // último dia bem acima da média dos 7 anteriores -> tendência UP
        await dbClient.query(
          `INSERT INTO wms.kpi_daily (warehouse_id, client_id, day, kpi_code, value, created_by) VALUES ($1,$2,$3::date,'K-05',$4,$5)`,
          [warehouseId, clientId, day, value, SEED_ACTOR_ID]
        );
      }
    });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  it('RF-PAI-040: fonte exclusivamente kpi_daily — nenhuma tabela transacional referenciada no código do service', () => {
    const source = readFileSync(join(__dirname, '..', 'dashboard.service.ts'), 'utf-8');
    const fromMatches = [...source.matchAll(/FROM\s+wms\.(\w+)/gi), ...source.matchAll(/JOIN\s+wms\.(\w+)/gi)];
    const tablesTouched = new Set(fromMatches.map((m) => m[1]));
    expect(tablesTouched.size).toBeGreaterThan(0); // sanity: a regex encontrou algo
    expect([...tablesTouched].every((t) => t === 'kpi_daily' || t === 'client')).toBe(true);
  });

  it('RF-PAI-043: cartão de valor com comparativo de 7 dias e tendência UP', async () => {
    const result = await dashboardService.getGroupDashboard('EXPEDICAO', warehouseId, clientId, { from: '2026-08-08', to: '2026-08-08' });
    const k05 = result.cards.find((c) => c.kpiCode === 'K-05');

    expect(k05?.value).toBe(100);
    expect(k05?.sevenDayAverage).toBe(10);
    expect(k05?.trend).toBe('UP');
  });

  it('RF-PAI-043: série temporal cobre o período', async () => {
    const result = await dashboardService.getGroupDashboard('EXPEDICAO', warehouseId, clientId, { from: '2026-08-01', to: '2026-08-08' });
    const k05 = result.cards.find((c) => c.kpiCode === 'K-05');
    expect(k05?.timeseries).toHaveLength(8);
  });

  it('RF-PAI-043: ranking top-5 clientes por volume (K-05)', async () => {
    const result = await dashboardService.getGroupDashboard('EXPEDICAO', warehouseId, null, { from: '2026-08-01', to: '2026-08-08' });
    expect(result.topClientsByVolume.length).toBeGreaterThan(0);
    expect(result.topClientsByVolume[0].clientId).toBe(clientId);
  });

  it('RN-SEG-032: exportação CSV é auditada', async () => {
    const csv = await dashboardService.exportGroupCsv('EXPEDICAO', warehouseId, clientId, { from: '2026-08-08', to: '2026-08-08' }, SEED_ACTOR_ID);
    expect(csv).toContain('K-05,2026-08-08,100');

    const auditRows = await testContext.databaseService.queryGlobal(
      `SELECT * FROM wms.audit_log WHERE entity = 'dashboard_export' AND action = 'EXPORT' AND user_id = $1`,
      [SEED_ACTOR_ID]
    );
    expect(auditRows.rows.length).toBeGreaterThan(0);
  });
});
