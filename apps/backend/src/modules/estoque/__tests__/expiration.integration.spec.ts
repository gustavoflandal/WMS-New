// DOC-05 §4.2 RN-EST-014 — alerta de lotes a vencer (90/60/30/15/0 dias) +
// bloqueio automático de saldo VENCIDO.
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { BatchService } from '../../cadastro/batch/batch.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';
import { ExpirationService } from '../expiration/expiration.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';

describe('Estoque - DOC-05 §4.2 RN-EST-014 alerta de vencimento + bloqueio automático', () => {
  let testContext: TestContext;
  let expirationService: ExpirationService;
  let productService: ProductService;
  let batchService: BatchService;

  let clientId: string;
  let warehouseId: string;
  let locationId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const stockMovementService = new StockMovementService(db);
    expirationService = new ExpirationService(db, eventsService, stockMovementService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    batchService = new BatchService(db, auditService);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém vencimento', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente vencimento', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    const zone = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    const locationResult = await db.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type,
                                 max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1','001','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING id`,
      [warehouseId, zone.id, SEED_ACTOR_ID]
    );
    locationId = locationResult.rows[0].id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function seedBatchWithBalance(expirationDate: string, qtyAvailable: number) {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto vencimento', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
      SEED_ACTOR_ID
    );
    const batch = await batchService.create({ tenant_id: clientId, product_id: product.id, batch_code: `L-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, expiration_date: expirationDate }, SEED_ACTOR_ID);
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await rawAuthorizedQuery(
      testContext.databaseService,
      ctx,
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, batch_id, location_id, qty_available, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [clientId, warehouseId, product.id, batch.id, locationId, qtyAvailable, SEED_ACTOR_ID]
    );
    return { product, batch };
  }

  function daysFromToday(offset: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  it('alerta lote a 0 dias de vencer e bloqueia automaticamente lote já vencido, sem afetar saldo saudável', async () => {
    const dueToday = await seedBatchWithBalance(daysFromToday(0), 10);
    const overdue = await seedBatchWithBalance(daysFromToday(-3), 25);
    const healthy = await seedBatchWithBalance(daysFromToday(180), 40);

    const result = await expirationService.checkExpirations();

    expect(result.alertedBatchIds).toContain(dueToday.batch.id);
    expect(result.alertedBatchIds).not.toContain(overdue.batch.id); // -3 não está em [90,60,30,15,0]
    expect(result.alertedBatchIds).not.toContain(healthy.batch.id);

    expect(result.blockedBatchIds).toContain(overdue.batch.id);
    expect(result.blockedBatchIds).not.toContain(dueToday.batch.id);
    expect(result.blockedBatchIds).not.toContain(healthy.batch.id);

    const overdueBalance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_blocked FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [overdue.product.id, locationId]
    );
    expect(Number(overdueBalance.rows[0].qty_available)).toBe(0);
    expect(Number(overdueBalance.rows[0].qty_blocked)).toBe(25);

    const movementResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT movement_type, block_reason_code FROM wms.stock_movement WHERE product_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [overdue.product.id]
    );
    expect(movementResult.rows[0].movement_type).toBe('BLOQUEIO');
    expect(movementResult.rows[0].block_reason_code).toBe('VENCIDO');

    const healthyBalance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [healthy.product.id, locationId]
    );
    expect(Number(healthyBalance.rows[0].qty_available)).toBe(40);

    // Idempotência: 2ª execução não re-bloqueia (já não há mais qty_available vencido).
    const second = await expirationService.checkExpirations();
    expect(second.blockedBatchIds).not.toContain(overdue.batch.id);
  });
});
