// DOC-07 §4/§6 — Logística Reversa (Sessão 9A, núcleo). Cenários Gherkin
// cobertos: "Quantidade devolvida não excede a expedida", "Vencido jamais
// reintegra", "Medicamento reintegra somente via quarentena", "Destinação só
// conclui com fiscal registrado".
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { BatchService } from '../../cadastro/batch/batch.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { FiscalModeService } from '../../fiscal/fiscal-mode/fiscal-mode.service.js';
import { StorageReturnInvoiceService } from '../../fiscal/storage-return-invoice/storage-return-invoice.service.js';
import { FiscalConsumptionService } from '../../fiscal/consumption/fiscal-consumption.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { ConfigService } from '@nestjs/config';
import { VehicleService } from '../../portaria/vehicle/vehicle.service.js';
import { DriverService } from '../../portaria/driver/driver.service.js';
import { VehicleVisitService } from '../../portaria/vehicle-visit/vehicle-visit.service.js';
import { ReturnOrderService } from '../return-order/return-order.service.js';
import { ReturnTriageService } from '../triage/return-triage.service.js';
import { ReintegrationOfExpiredItemDeniedError } from '../triage/disposition-matrix.util.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { generateValidCpf, randomMercosulPlate } from '../../portaria/__tests__/test-helpers.js';

describe('DOC-07 §4/§6 — Logística Reversa (Sessão 9A núcleo)', () => {
  let testContext: TestContext;
  let db: TestContext['databaseService'];
  let returnOrderService: ReturnOrderService;
  let returnTriageService: ReturnTriageService;
  let productService: ProductService;
  let batchService: BatchService;
  let vehicleService: VehicleService;
  let driverService: DriverService;
  let vehicleVisitService: VehicleVisitService;
  let clientId: string;
  let warehouseId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const operationFlowService = new OperationFlowService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    batchService = new BatchService(db, auditService);
    const stockMovementService = new StockMovementService(db);
    const fiscalModeService = new FiscalModeService(db, auditService);
    const fileStorageService = new FileStorageService(testContext.configService as ConfigService);
    fileStorageService.onModuleInit();
    const fiscalConsumptionService = new FiscalConsumptionService(db);
    const storageReturnInvoiceService = new StorageReturnInvoiceService(
      db,
      eventsService,
      auditService,
      documentNumberingService,
      fiscalConsumptionService,
      fileStorageService
    );

    returnOrderService = new ReturnOrderService(db, eventsService, auditService, operationalExceptionService, operationFlowService, documentNumberingService);
    returnTriageService = new ReturnTriageService(
      db,
      eventsService,
      auditService,
      operationFlowService,
      stockMovementService,
      fiscalModeService,
      storageReturnInvoiceService,
      batchService
    );

    productService = new ProductService(db, auditService);
    vehicleService = new VehicleService(db);
    driverService = new DriverService(db);
    vehicleVisitService = new VehicleVisitService(db);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém reversa', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente reversa', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', min_shelf_life_default_pct: 30 },
      SEED_ACTOR_ID
    );

    // Zonas RETURNS/QUARANTINE/DAMAGED com ao menos 1 location cada — RN-REV-022 credita nelas.
    // location.code é GERADA (aisle-module-level-slot, RN-DAD-011) — não é insertável direto.
    const zoneFixtures: Array<{ zoneType: string; locationType: string; aisle: string }> = [
      { zoneType: 'RETURNS', locationType: 'STAGING_IN', aisle: 'R1' },
      { zoneType: 'QUARANTINE', locationType: 'QUARANTINE', aisle: 'R2' },
      { zoneType: 'DAMAGED', locationType: 'DAMAGED', aisle: 'R3' },
    ];
    await db.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      for (const fixture of zoneFixtures) {
        const zone = await client.query(
          `INSERT INTO wms.zone (warehouse_id, code, name, zone_type, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [warehouseId, `Z-${fixture.zoneType}`, `Zona ${fixture.zoneType}`, fixture.zoneType, SEED_ACTOR_ID]
        );
        await client.query(
          `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, created_by)
           VALUES ($1,$2,$3,'001','00','01',$4,1000,10,1,2,$5)`,
          [warehouseId, zone.rows[0].id, fixture.aisle, fixture.locationType, SEED_ACTOR_ID]
        );
      }
    });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  /** Produto GERAL com shelf_life_days=100 (min 30% => 30 dias restantes é o corte). */
  async function createProduct(speciesCode: 'GERAL' | 'MEDICAMENTO' = 'GERAL') {
    return productService.create(
      { tenant_id: clientId, sku: randomSku(), description: `Produto ${speciesCode}`, species_code: speciesCode, base_uom: 'UN', shelf_life_days: 100 },
      SEED_ACTOR_ID
    );
  }

  function daysFromNow(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Simula um pedido de saída JÁ EXPEDIDO (COMPLETED), com o volume
   * (package/package_content) e o consumo fiscal (fiscal_allocation
   * CONSUMIDA) correspondentes — via SQL direto, mesmo padrão de
   * checking.integration.spec.ts::bringOrderToChecking (o ciclo real de
   * DOC-06/DOC-08 tem suíte própria; aqui só o estado final importa).
   */
  async function createShippedFixture(productId: string, qtyShipped: number) {
    return db.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      const order = await client.query(
        `INSERT INTO wms.outbound_order (tenant_id, warehouse_id, number, status, created_by)
         VALUES ($1,$2,$3,'COMPLETED',$4) RETURNING id`,
        [clientId, warehouseId, `PED-${Date.now()}-${Math.floor(Math.random() * 100000)}`, SEED_ACTOR_ID]
      );
      const outboundOrderId = order.rows[0].id;

      const item = await client.query(
        `INSERT INTO wms.outbound_order_item (tenant_id, outbound_order_id, product_id, line_number, qty_ordered, created_by)
         VALUES ($1,$2,$3,1,$4,$5) RETURNING id`,
        [clientId, outboundOrderId, productId, qtyShipped, SEED_ACTOR_ID]
      );
      const outboundOrderItemId = item.rows[0].id;

      const pkg = await client.query(
        `INSERT INTO wms.package (tenant_id, warehouse_id, outbound_order_id, lpn, package_type_code, tare_kg, sequence_number, status, created_by)
         VALUES ($1,$2,$3,$4,'CAIXA_PADRAO',0.35,1,'LOADED',$5) RETURNING id`,
        [clientId, warehouseId, outboundOrderId, String(Math.floor(Math.random() * 1e17)).padStart(18, '0'), SEED_ACTOR_ID]
      );
      await client.query(`INSERT INTO wms.package_content (tenant_id, package_id, outbound_order_item_id, product_id, qty, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [
        clientId,
        pkg.rows[0].id,
        outboundOrderItemId,
        productId,
        qtyShipped,
        SEED_ACTOR_ID,
      ]);

      const storageDoc = await client.query(
        `INSERT INTO wms.fiscal_document (tenant_id, warehouse_id, document_type, status, internal_number, created_by)
         VALUES ($1,$2,'NOTA_ARMAZENAGEM','AUTHORIZED',$3,$4) RETURNING id`,
        [clientId, warehouseId, `ARM-${Date.now()}-${Math.floor(Math.random() * 100000)}`, SEED_ACTOR_ID]
      );
      const returnDoc = await client.query(
        `INSERT INTO wms.fiscal_document (tenant_id, warehouse_id, document_type, status, internal_number, created_by)
         VALUES ($1,$2,'NOTA_DEVOLUCAO_ARMAZENAGEM','AUTHORIZED',$3,$4) RETURNING id`,
        [clientId, warehouseId, `DEVARM-${Date.now()}-${Math.floor(Math.random() * 100000)}`, SEED_ACTOR_ID]
      );
      await client.query(
        `INSERT INTO wms.fiscal_allocation (tenant_id, warehouse_id, product_id, storage_fiscal_document_id, return_fiscal_document_id, outbound_order_id, qty, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'CONSUMIDA',$8)`,
        [clientId, warehouseId, productId, storageDoc.rows[0].id, returnDoc.rows[0].id, outboundOrderId, qtyShipped, SEED_ACTOR_ID]
      );
      // RN-FIS-041 (reverseConsumption) exige o saldo de Estoque Fiscal de origem — simula o
      // crédito da Nota de Armazenagem já totalmente CONSUMIDO pela expedição original.
      await client.query(
        `INSERT INTO wms.fiscal_stock_balance (tenant_id, warehouse_id, product_id, storage_remittance_invoice_id, qty_credited, qty_consumed, created_by)
         VALUES ($1,$2,$3,$4,$5,$5,$6)`,
        [clientId, warehouseId, productId, storageDoc.rows[0].id, qtyShipped, SEED_ACTOR_ID]
      );

      return { outboundOrderId, outboundOrderItemId };
    });
  }

  async function createVehicleVisit() {
    const vehicle = await vehicleService.upsertByPlate({ plate: randomMercosulPlate(), vehicle_type: 'TRUCK' }, SEED_ACTOR_ID);
    const driver = await driverService.upsertByCpf(
      { cpf: generateValidCpf(), name: 'Motorista reversa', cnh: String(Math.floor(Math.random() * 1e11)).padStart(11, '0'), cnh_validity: daysFromNow(365) },
      SEED_ACTOR_ID
    );
    return db.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      const visit = await vehicleVisitService.createWithClient(
        client,
        { tenant_id: clientId, warehouse_id: warehouseId, direction: 'INBOUND', vehicle_id: vehicle.id, driver_id: driver.id },
        SEED_ACTOR_ID
      );
      return visit.id;
    });
  }

  async function createDock(code: string) {
    const result = await db.queryGlobal<{ id: string }>(
      `INSERT INTO wms.dock (warehouse_id, code, dock_type, has_leveler, created_by) VALUES ($1,$2,'INBOUND',TRUE,$3) RETURNING id`,
      [warehouseId, code, SEED_ACTOR_ID]
    );
    return result.rows[0].id;
  }

  /** Leva a Ordem até IN_TRIAGE (AUTHORIZED -> chegada -> doca -> descarga). */
  async function bringToTriage(returnOrderId: string) {
    const visitId = await createVehicleVisit();
    await returnOrderService.authorize(returnOrderId, clientId, warehouseId, SEED_ACTOR_ID);
    await returnOrderService.linkArrival(returnOrderId, visitId, clientId, warehouseId, SEED_ACTOR_ID);
    const dockId = await createDock(`D-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
    await returnOrderService.assignDock(returnOrderId, dockId, clientId, warehouseId, SEED_ACTOR_ID);
    return returnOrderService.completeUnloading(returnOrderId, clientId, warehouseId, SEED_ACTOR_ID);
  }

  it('Cenário: Quantidade devolvida não excede a expedida', async () => {
    const product = await createProduct();
    const { outboundOrderId, outboundOrderItemId } = await createShippedFixture(product.id, 100);

    await returnOrderService.createReturnOrder(
      {
        tenantId: clientId,
        warehouseId,
        type: 'DEVOLUCAO_CLIENTE_FINAL',
        sourceOutboundOrderId: outboundOrderId,
        items: [{ productId: product.id, qty: 30, sourceOutboundOrderItemId: outboundOrderItemId }],
      },
      SEED_ACTOR_ID
    );

    await expect(
      returnOrderService.createReturnOrder(
        {
          tenantId: clientId,
          warehouseId,
          type: 'DEVOLUCAO_CLIENTE_FINAL',
          sourceOutboundOrderId: outboundOrderId,
          items: [{ productId: product.id, qty: 80, sourceOutboundOrderItemId: outboundOrderItemId }],
        },
        SEED_ACTOR_ID
      )
    ).rejects.toMatchObject({ response: { detail: expect.stringContaining('70') } });
  });

  it('Cenário: Vencido jamais reintegra (nem por decisão do cliente)', async () => {
    const product = await createProduct();
    const { outboundOrderId, outboundOrderItemId } = await createShippedFixture(product.id, 10);
    const order = await returnOrderService.createReturnOrder(
      {
        tenantId: clientId,
        warehouseId,
        type: 'DEVOLUCAO_CLIENTE_FINAL',
        sourceOutboundOrderId: outboundOrderId,
        items: [{ productId: product.id, qty: 10, sourceOutboundOrderItemId: outboundOrderItemId }],
      },
      SEED_ACTOR_ID
    );
    await bringToTriage(order.id);
    const items = await returnOrderService.listItems(order.id, clientId, SEED_ACTOR_ID);

    const triage = await returnTriageService.registerTriage(
      {
        tenantId: clientId,
        warehouseId,
        returnOrderId: order.id,
        returnOrderItemId: items[0].id,
        productId: product.id,
        qty: 10,
        physicalState: 'VENCIDO',
        photoKeys: ['fake/key.jpg'],
      },
      SEED_ACTOR_ID
    );
    expect(triage.disposition_suggested).toBe('DESCARTE');

    await returnTriageService.completeTriage(order.id, clientId, warehouseId, SEED_ACTOR_ID);

    await expect(
      returnTriageService.confirmDisposition(
        { tenantId: clientId, warehouseId, triageRecordId: triage.id, confirmedDisposition: 'REINTEGRAR', clientDecision: true },
        SEED_ACTOR_ID
      )
    ).rejects.toThrow(ReintegrationOfExpiredItemDeniedError);
  });

  it('Cenário: Medicamento reintegra somente via quarentena', async () => {
    const product = await createProduct('MEDICAMENTO');
    const { outboundOrderId, outboundOrderItemId } = await createShippedFixture(product.id, 5);
    const order = await returnOrderService.createReturnOrder(
      {
        tenantId: clientId,
        warehouseId,
        type: 'DEVOLUCAO_CLIENTE_FINAL',
        sourceOutboundOrderId: outboundOrderId,
        items: [{ productId: product.id, qty: 5, sourceOutboundOrderItemId: outboundOrderItemId }],
      },
      SEED_ACTOR_ID
    );
    await bringToTriage(order.id);
    const items = await returnOrderService.listItems(order.id, clientId, SEED_ACTOR_ID);

    const batch = await batchService.create({ tenant_id: clientId, product_id: product.id, batch_code: `LOTE-MED-${Date.now()}`, expiration_date: daysFromNow(300) }, SEED_ACTOR_ID);

    const triage = await returnTriageService.registerTriage(
      {
        tenantId: clientId,
        warehouseId,
        returnOrderId: order.id,
        returnOrderItemId: items[0].id,
        productId: product.id,
        qty: 5,
        physicalState: 'INTEGRO',
        batchCode: batch.batch_code,
      },
      SEED_ACTOR_ID
    );
    // RN-REV-021: espécie MEDICAMENTO íntegra e dentro do shelf life sugere QUARENTENA, nunca REINTEGRAR direto.
    expect(triage.disposition_suggested).toBe('QUARENTENA');

    await returnTriageService.completeTriage(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const confirmed = await returnTriageService.confirmDisposition(
      { tenantId: clientId, warehouseId, triageRecordId: triage.id, confirmedDisposition: 'QUARENTENA' },
      SEED_ACTOR_ID
    );
    expect(confirmed.disposition_confirmed).toBe('QUARENTENA');

    const balance = await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_quarantine FROM wms.stock_balance WHERE product_id = $1 AND batch_id = $2`,
      [product.id, batch.id]
    );
    expect(balance.rows.length).toBeGreaterThan(0);
    expect(Number(balance.rows[0].qty_quarantine)).toBe(5);
  });

  it('Cenário: Destinação só conclui com fiscal registrado (RN-REV-023) — reintegração completa reverte o Consumo Fiscal', async () => {
    const product = await createProduct();
    const { outboundOrderId, outboundOrderItemId } = await createShippedFixture(product.id, 8);
    const order = await returnOrderService.createReturnOrder(
      {
        tenantId: clientId,
        warehouseId,
        type: 'DEVOLUCAO_CLIENTE_FINAL',
        sourceOutboundOrderId: outboundOrderId,
        items: [{ productId: product.id, qty: 8, sourceOutboundOrderItemId: outboundOrderItemId }],
      },
      SEED_ACTOR_ID
    );
    await bringToTriage(order.id);
    const items = await returnOrderService.listItems(order.id, clientId, SEED_ACTOR_ID);

    const batch = await batchService.create({ tenant_id: clientId, product_id: product.id, batch_code: `LOTE-REI-${Date.now()}`, expiration_date: daysFromNow(300) }, SEED_ACTOR_ID);
    const triage = await returnTriageService.registerTriage(
      {
        tenantId: clientId,
        warehouseId,
        returnOrderId: order.id,
        returnOrderItemId: items[0].id,
        productId: product.id,
        qty: 8,
        physicalState: 'INTEGRO',
        batchCode: batch.batch_code,
      },
      SEED_ACTOR_ID
    );
    expect(triage.disposition_suggested).toBe('REINTEGRAR');

    await returnTriageService.completeTriage(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await returnTriageService.confirmDisposition(
      { tenantId: clientId, warehouseId, triageRecordId: triage.id, confirmedDisposition: 'REINTEGRAR' },
      SEED_ACTOR_ID
    );

    const finalOrder = await returnOrderService.findById(order.id, clientId, SEED_ACTOR_ID);
    expect(finalOrder.status).toBe('COMPLETED');
    expect(finalOrder.fiscal_treatment_done).toBe(true);

    const allocation = await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT status, qty_reversed FROM wms.fiscal_allocation WHERE outbound_order_id = $1 AND product_id = $2`,
      [outboundOrderId, product.id]
    );
    expect(allocation.rows.length).toBeGreaterThan(0);
    expect(allocation.rows[0].status).toBe('ESTORNADA');
    expect(Number(allocation.rows[0].qty_reversed)).toBe(8);

    const balance = await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available FROM wms.stock_balance WHERE product_id = $1 AND batch_id = $2`,
      [product.id, batch.id]
    );
    expect(balance.rows.length).toBeGreaterThan(0);
    expect(Number(balance.rows[0].qty_available)).toBe(8);
  });
});
