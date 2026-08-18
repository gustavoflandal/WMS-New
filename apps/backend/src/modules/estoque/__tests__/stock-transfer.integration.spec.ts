// DOC-05 §4.6 — RF-EST-050 (transferência interna, Fase 1 no destino),
// RF-EST-051 (transferência entre armazéns, §5.2 completo) e RN-EST-052
// (RG-015 no destino, via Fase 1 reaproveitada).
import { ForbiddenException } from '@nestjs/common';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { PutawayEngineService } from '../../recebimento/putaway/putaway-engine.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';
import { StockTransferService } from '../transfer/stock-transfer.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';

describe('Estoque - DOC-05 §4.6 RF-EST-050/051/RN-EST-052 transferências', () => {
  let testContext: TestContext;
  let stockTransferService: StockTransferService;
  let productService: ProductService;

  let clientId: string;
  let warehouseOriginId: string;
  let warehouseDestinationId: string;
  let originLocation: any;
  let originLocation2: any;
  let destinationLocation: any;
  let blockedLocation: any;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    const putawayEngineService = new PutawayEngineService(db);
    const stockMovementService = new StockMovementService(db);
    stockTransferService = new StockTransferService(db, eventsService, auditService, rbacService, documentNumberingService, putawayEngineService, stockMovementService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);

    const warehouseOrigin = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém origem', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseOriginId = warehouseOrigin.id;
    const warehouseDestination = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém destino', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseDestinationId = warehouseDestination.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente transferência', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    const zoneOrigin = await zoneService.create({ warehouse_id: warehouseOriginId, code: 'STO', name: 'Armazenagem origem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    const zoneDestination = await zoneService.create({ warehouse_id: warehouseDestinationId, code: 'STO', name: 'Armazenagem destino', zone_type: 'STORAGE' }, SEED_ACTOR_ID);

    originLocation = (
      await db.queryGlobal(
        `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
         VALUES ($1,$2,'A1','001','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING *`,
        [warehouseOriginId, zoneOrigin.id, SEED_ACTOR_ID]
      )
    ).rows[0];
    originLocation2 = (
      await db.queryGlobal(
        `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
         VALUES ($1,$2,'A1','002','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING *`,
        [warehouseOriginId, zoneOrigin.id, SEED_ACTOR_ID]
      )
    ).rows[0];
    blockedLocation = (
      await db.queryGlobal(
        `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
         VALUES ($1,$2,'A1','003','00','01','STORAGE',5000,100,5,5,'BLOCKED',$3) RETURNING *`,
        [warehouseOriginId, zoneOrigin.id, SEED_ACTOR_ID]
      )
    ).rows[0];
    destinationLocation = (
      await db.queryGlobal(
        `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
         VALUES ($1,$2,'A1','001','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING *`,
        [warehouseDestinationId, zoneDestination.id, SEED_ACTOR_ID]
      )
    ).rows[0];
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function seedProductWithBalance(warehouseId: string, locationId: string, qty: number) {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto transferência', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
      SEED_ACTOR_ID
    );
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await rawAuthorizedQuery(
      testContext.databaseService,
      ctx,
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, warehouseId, product.id, locationId, qty, SEED_ACTOR_ID]
    );
    return product;
  }

  async function readBalance(warehouseId: string, productId: string, locationId: string) {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_in_transit FROM wms.stock_balance WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND location_id = $4`,
      [clientId, warehouseId, productId, locationId]
    );
    return result.rows[0] ?? { qty_available: 0, qty_in_transit: 0 };
  }

  it('RF-EST-050: transferência interna imediata move saldo e passa pela Fase 1 no destino', async () => {
    const product = await seedProductWithBalance(warehouseOriginId, originLocation.id, 50);

    const transfer = await stockTransferService.transferInternal({
      tenantId: clientId,
      warehouseId: warehouseOriginId,
      productId: product.id,
      qty: 20,
      locationIdOrigin: originLocation.id,
      locationIdDestination: originLocation2.id,
      actorUserId: SEED_ACTOR_ID,
    });
    expect(transfer.status).toBe('COMPLETED');

    const origin = await readBalance(warehouseOriginId, product.id, originLocation.id);
    expect(Number(origin.qty_available)).toBe(30);
    const destination = await readBalance(warehouseOriginId, product.id, originLocation2.id);
    expect(Number(destination.qty_available)).toBe(20);
  });

  it('RF-EST-050: destino reprovado na Fase 1 (endereço BLOCKED) rejeita sem override possível', async () => {
    const product = await seedProductWithBalance(warehouseOriginId, originLocation.id, 30);

    await expect(
      stockTransferService.transferInternal({
        tenantId: clientId,
        warehouseId: warehouseOriginId,
        productId: product.id,
        qty: 10,
        locationIdOrigin: originLocation.id,
        locationIdDestination: blockedLocation.id,
        actorUserId: SEED_ACTOR_ID,
      })
    ).rejects.toBeInstanceOf(ForbiddenException);

    const origin = await readBalance(warehouseOriginId, product.id, originLocation.id);
    expect(Number(origin.qty_available)).toBe(30); // saldo intocado
  });

  it('RF-EST-051/RN-EST-052: ciclo completo CREATED->PICKING->IN_TRANSIT->RECEIVING->COMPLETED entre armazéns', async () => {
    const product = await seedProductWithBalance(warehouseOriginId, originLocation.id, 100);

    const created = await stockTransferService.createInterwarehouse({
      tenantId: clientId,
      warehouseIdOrigin: warehouseOriginId,
      warehouseIdDestination: warehouseDestinationId,
      items: [{ productId: product.id, qty: 40, locationIdOrigin: originLocation.id }],
      actorUserId: SEED_ACTOR_ID,
    });
    expect(created.status).toBe('CREATED');
    expect(created.document_number).toMatch(/^TRF-/);

    await stockTransferService.startPicking(created.id, clientId, warehouseOriginId, SEED_ACTOR_ID);
    const afterPicking = await stockTransferService.completePicking(created.id, clientId, warehouseOriginId, SEED_ACTOR_ID);
    expect(afterPicking.status).toBe('IN_TRANSIT');

    let origin = await readBalance(warehouseOriginId, product.id, originLocation.id);
    expect(Number(origin.qty_available)).toBe(60); // 100 - 40
    expect(Number(origin.qty_in_transit)).toBe(40);

    await stockTransferService.startReceiving(created.id, clientId, warehouseOriginId, SEED_ACTOR_ID);

    const itemsResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseOriginId },
      `SELECT id FROM wms.stock_transfer_item WHERE stock_transfer_id = $1`,
      [created.id]
    );
    const itemId = itemsResult.rows[0].id;

    const completed = await stockTransferService.completeReceiving(
      created.id,
      [{ itemId, locationIdDestination: destinationLocation.id }],
      clientId,
      warehouseOriginId,
      SEED_ACTOR_ID
    );
    expect(completed.status).toBe('COMPLETED');

    origin = await readBalance(warehouseOriginId, product.id, originLocation.id);
    expect(Number(origin.qty_in_transit)).toBe(0);
    const destination = await readBalance(warehouseDestinationId, product.id, destinationLocation.id);
    expect(Number(destination.qty_available)).toBe(40);
  });

  it('§5.2: cancelamento só é permitido antes do picking (ramo CANCELLED)', async () => {
    const product = await seedProductWithBalance(warehouseOriginId, originLocation.id, 15);
    const created = await stockTransferService.createInterwarehouse({
      tenantId: clientId,
      warehouseIdOrigin: warehouseOriginId,
      warehouseIdDestination: warehouseDestinationId,
      items: [{ productId: product.id, qty: 5, locationIdOrigin: originLocation.id }],
      actorUserId: SEED_ACTOR_ID,
    });

    const cancelled = await stockTransferService.cancel(created.id, clientId, warehouseOriginId, SEED_ACTOR_ID);
    expect(cancelled.status).toBe('CANCELLED');

    await expect(stockTransferService.startPicking(created.id, clientId, warehouseOriginId, SEED_ACTOR_ID)).rejects.toThrow();
  });
});
