// DOC-08 §4.1-§4.6, §4.8 (Sessão 8A) — ciclo do Estoque Fiscal (RG-014)
// contra Postgres real. Cobre os cenários Gherkin do prompt §3: consumo
// FIFO_EMISSAO (exemplo normativo), rejeição por saldo fiscal insuficiente,
// cobertura da Nota de Armazenagem, prazo expirado bloqueando liberação,
// descarte/ajuste negativo travando qty_pending_writeoff, e
// reverseConsumption() isolado (RN-FIS-041).
import { v4 as uuid } from 'uuid';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { StockSelectionService } from '../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../estoque/selection/stock-reservation.service.js';
import { StockReclassificationService } from '../../estoque/blocking/stock-reclassification.service.js';
import { InventoryPlanningService } from '../../estoque/inventory/inventory-planning.service.js';
import { InventoryCountExecutionService } from '../../estoque/inventory/inventory-count-execution.service.js';
import { OutboundOrderService } from '../../expedicao/order/outbound-order.service.js';
import { OutboundFlowService } from '../../expedicao/order/outbound-flow.service.js';
import { AlertService } from '../../paineis/alertas/alert.service.js';
import { FiscalModeService } from '../fiscal-mode/fiscal-mode.service.js';
import { StorageInvoiceService } from '../storage-invoice/storage-invoice.service.js';
import { FiscalConsumptionService } from '../consumption/fiscal-consumption.service.js';
import { StorageReturnInvoiceService } from '../storage-return-invoice/storage-return-invoice.service.js';
import { WriteOffPendingService } from '../write-off/write-off-pending.service.js';
import { InboundInvoiceFiscalService } from '../inbound-invoice/inbound-invoice-fiscal.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole, grantApprovalAuthority } from '../../../core/__tests__/security-test-helpers.js';

describe('Fiscal - DOC-08 SS4.1-SS4.6/SS4.8 ciclo do Estoque Fiscal (Sessão 8A, RG-014)', () => {
  let testContext: TestContext;

  let productService: ProductService;
  let storageInvoiceService: StorageInvoiceService;
  let fiscalConsumptionService: FiscalConsumptionService;
  let storageReturnInvoiceService: StorageReturnInvoiceService;
  let writeOffPendingService: WriteOffPendingService;
  let fiscalModeService: FiscalModeService;
  let inboundInvoiceFiscalService: InboundInvoiceFiscalService;
  let outboundOrderService: OutboundOrderService;
  let stockReclassificationService: StockReclassificationService;
  let inventoryPlanningService: InventoryPlanningService;
  let inventoryCountExecutionService: InventoryCountExecutionService;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;
  let locationId: string;
  let gestor: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    const operationFlowService = new OperationFlowService(db);
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const documentNumberingService = new DocumentNumberingService(db);
    const stockMovementService = new StockMovementService(db);
    const selectionService = new StockSelectionService(db);
    const reservationService = new StockReservationService(db, eventsService, auditService, rbacService, selectionService, stockMovementService);
    const outboundFlowService = new OutboundFlowService(db, eventsService, operationFlowService);
    const alertService = new AlertService(db, eventsService);
    const passwordService = new PasswordService(db);

    fiscalConsumptionService = new FiscalConsumptionService(db);
    fiscalModeService = new FiscalModeService(db, auditService);
    storageInvoiceService = new StorageInvoiceService(db, eventsService, auditService, documentNumberingService);
    storageReturnInvoiceService = new StorageReturnInvoiceService(db, eventsService, auditService, documentNumberingService, fiscalConsumptionService);
    writeOffPendingService = new WriteOffPendingService(eventsService, fiscalConsumptionService);
    inboundInvoiceFiscalService = new InboundInvoiceFiscalService(db, alertService);
    outboundOrderService = new OutboundOrderService(
      db, eventsService, auditService, documentNumberingService, selectionService, reservationService, outboundFlowService, inboundInvoiceFiscalService
    );
    stockReclassificationService = new StockReclassificationService(db, eventsService, auditService, operationalExceptionService, stockMovementService, writeOffPendingService);
    inventoryPlanningService = new InventoryPlanningService(db, eventsService, documentNumberingService);
    inventoryCountExecutionService = new InventoryCountExecutionService(db, eventsService, auditService, operationalExceptionService, stockMovementService, writeOffPendingService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);

    // Mesma UF em cliente e armazém -> operation_nature INTERNO (5905/5906,
    // padrão de instalação seedado na migration 0069).
    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém Fiscal 8A', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo', address_state: 'SP' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create(
      { code: randomClientCode(), legal_name: 'Cliente Fiscal 8A', cnpj: generateValidCnpj(), address_state: 'SP' },
      SEED_ACTOR_ID
    );
    clientId = client.id;
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    storageZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID)).id;
    const locationResult = await db.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1','001','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING id`,
      [warehouseId, storageZoneId, SEED_ACTOR_ID]
    );
    locationId = locationResult.rows[0].id;

    gestor = await createTestUser(db, passwordService);
    await assignRole(db, { userId: gestor.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    // EST.DESCARTE_SALDO (2 passos) — usado pelos testes de RN-FIS-070/descarte.
    await grantApprovalAuthority(db, { roleCode: 'GESTOR_ARMAZEM', exceptionType: 'EST.DESCARTE_SALDO', warehouseId, maxQty: 1000 });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function createProduct() {
    return productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto Fiscal 8A', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FIFO' },
      SEED_ACTOR_ID
    );
  }

  function randomAccessKey(): string {
    let key = '';
    for (let i = 0; i < 44; i++) key += Math.floor(Math.random() * 10);
    return key;
  }

  /** DOC-04 (fora do escopo desta sessão): fixture MÍNIMA de inbound_order/item/inbound_invoice via SQL direto — o gatilho real é DOC-04/InboundOrderService.createFromXml, não reimplementado aqui. */
  async function seedInboundInvoice(productId: string, qtyReceived: number, deadlineDaysFromToday: number) {
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    const orderResult = await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.inbound_order (tenant_id, warehouse_id, number, origin, blind_checking, status, created_by)
       VALUES ($1,$2,$3,'XML_NFE',TRUE,'COMPLETED',$4) RETURNING id`,
      [clientId, warehouseId, `REC-TEST-${uuid()}`, SEED_ACTOR_ID]
    );
    const orderId = orderResult.rows[0].id;
    await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.inbound_order_item (tenant_id, inbound_order_id, product_id, qty_expected, qty_counted, qty_received, status, created_by)
       VALUES ($1,$2,$3,$4,$4,$4,'CHECKED',$5)`,
      [clientId, orderId, productId, qtyReceived, SEED_ACTOR_ID]
    );
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + deadlineDaysFromToday);
    const invoiceResult = await testContext.databaseService.query(
      ctx,
      `INSERT INTO wms.inbound_invoice (tenant_id, warehouse_id, inbound_order_id, access_key, issuer_cnpj, issuer_name, total_value, xml_storage_key, regularization_deadline, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [clientId, warehouseId, orderId, randomAccessKey(), '12345678000199', 'Fornecedor Teste', 1000, 's3://test/nf.xml', deadline.toISOString().slice(0, 10), SEED_ACTOR_ID]
    );
    return invoiceResult.rows[0];
  }

  async function readFiscalBalance(productId: string, storageFiscalDocumentId: string) {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_credited, qty_consumed, qty_pending_writeoff FROM wms.fiscal_stock_balance WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND storage_remittance_invoice_id = $4`,
      [clientId, warehouseId, productId, storageFiscalDocumentId]
    );
    return result.rows[0];
  }

  // ───────────────────────────────────────────────────────────────────────
  // RN-FIS-030 — Ordem de consumo (exemplo normativo) + RG-014 item 4
  // ───────────────────────────────────────────────────────────────────────
  describe('RN-FIS-030 — consumo FIFO_EMISSAO (exemplo normativo)', () => {
    it('notas 1000234(500)/2356899(100)/3216544(400), demanda 700 -> 500+100+100, saldos finais 0/0/300', async () => {
      const product = await createProduct();
      const invoice = await seedInboundInvoice(product.id, 1000, 10);

      const doc1 = await storageInvoiceService.register({
        tenantId: clientId, warehouseId, issuerCnpj: (await getClientCnpj()), recipientCnpj: (await getWarehouseCnpj()),
        issuedAt: '2026-05-01T12:00:00.000Z', items: [{ productId: product.id, qty: 500, referenceInboundInvoiceId: invoice.id }], actorUserId: SEED_ACTOR_ID,
      });
      const doc2 = await storageInvoiceService.register({
        tenantId: clientId, warehouseId, issuerCnpj: (await getClientCnpj()), recipientCnpj: (await getWarehouseCnpj()),
        issuedAt: '2026-06-10T12:00:00.000Z', items: [{ productId: product.id, qty: 100, referenceInboundInvoiceId: invoice.id }], actorUserId: SEED_ACTOR_ID,
      });
      const doc3 = await storageInvoiceService.register({
        tenantId: clientId, warehouseId, issuerCnpj: (await getClientCnpj()), recipientCnpj: (await getWarehouseCnpj()),
        issuedAt: '2026-07-02T12:00:00.000Z', items: [{ productId: product.id, qty: 400, referenceInboundInvoiceId: invoice.id }], actorUserId: SEED_ACTOR_ID,
      });

      const assembled = await storageReturnInvoiceService.assemble({
        tenantId: clientId, warehouseId, items: [{ productId: product.id, qty: 700 }], actorUserId: SEED_ACTOR_ID,
      });
      expect(assembled.status).toBe('DRAFT');

      const itemsResult = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT qty, reference_fiscal_document_id FROM wms.fiscal_document_item WHERE fiscal_document_id = $1 ORDER BY line_number`,
        [assembled.id]
      );
      expect(itemsResult.rows).toHaveLength(3);
      expect(itemsResult.rows[0]).toMatchObject({ qty: '500.000000', reference_fiscal_document_id: doc1.id });
      expect(itemsResult.rows[1]).toMatchObject({ qty: '100.000000', reference_fiscal_document_id: doc2.id });
      expect(itemsResult.rows[2]).toMatchObject({ qty: '100.000000', reference_fiscal_document_id: doc3.id });

      // Antes da autorização: RN-FIS-040 "consumo efetiva-se SOMENTE na autorização".
      const preAuth1 = await readFiscalBalance(product.id, doc1.id);
      expect(Number(preAuth1.qty_consumed)).toBe(0);

      const authorized = await storageReturnInvoiceService.authorize(assembled.id, clientId, warehouseId, SEED_ACTOR_ID);
      expect(authorized.status).toBe('AUTHORIZED');

      const bal1 = await readFiscalBalance(product.id, doc1.id);
      const bal2 = await readFiscalBalance(product.id, doc2.id);
      const bal3 = await readFiscalBalance(product.id, doc3.id);
      expect(Number(bal1.qty_credited) - Number(bal1.qty_consumed)).toBe(0);
      expect(Number(bal2.qty_credited) - Number(bal2.qty_consumed)).toBe(0);
      expect(Number(bal3.qty_credited) - Number(bal3.qty_consumed)).toBe(300);
    });

    it('emissão acima do saldo fiscal (1001 sobre 1000) é rejeitada com "saldo fiscal disponível: 1.000" e não consome', async () => {
      const product = await createProduct();
      const invoice = await seedInboundInvoice(product.id, 1000, 10);
      const doc = await storageInvoiceService.register({
        tenantId: clientId, warehouseId, issuerCnpj: (await getClientCnpj()), recipientCnpj: (await getWarehouseCnpj()),
        issuedAt: '2026-05-01T12:00:00.000Z', items: [{ productId: product.id, qty: 1000, referenceInboundInvoiceId: invoice.id }], actorUserId: SEED_ACTOR_ID,
      });

      await expect(
        storageReturnInvoiceService.assemble({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qty: 1001 }], actorUserId: SEED_ACTOR_ID })
      ).rejects.toMatchObject({ response: { detail: 'saldo fiscal disponível: 1.000' } });

      const balance = await readFiscalBalance(product.id, doc.id);
      expect(Number(balance.qty_consumed)).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // RF-FIS-020 — Nota de Armazenagem não excede o recebido
  // ───────────────────────────────────────────────────────────────────────
  describe('RF-FIS-020 — cobertura da Nota de Armazenagem', () => {
    it('800 recebidas, 500 já cobertas; registrar 400 é rejeitado informando cobertura restante de 300', async () => {
      const product = await createProduct();
      const invoice = await seedInboundInvoice(product.id, 800, 10);
      const clientCnpj = await getClientCnpj();
      const warehouseCnpj = await getWarehouseCnpj();

      await storageInvoiceService.register({
        tenantId: clientId, warehouseId, issuerCnpj: clientCnpj, recipientCnpj: warehouseCnpj,
        issuedAt: '2026-05-01T12:00:00.000Z', items: [{ productId: product.id, qty: 500, referenceInboundInvoiceId: invoice.id }], actorUserId: SEED_ACTOR_ID,
      });

      await expect(
        storageInvoiceService.register({
          tenantId: clientId, warehouseId, issuerCnpj: clientCnpj, recipientCnpj: warehouseCnpj,
          issuedAt: '2026-05-02T12:00:00.000Z', items: [{ productId: product.id, qty: 400, referenceInboundInvoiceId: invoice.id }], actorUserId: SEED_ACTOR_ID,
        })
      ).rejects.toMatchObject({ response: { detail: expect.stringContaining('cobertura restante de 300') } });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-FIS-010 — Prazo expirado bloqueia liberação
  // ───────────────────────────────────────────────────────────────────────
  describe('RN-FIS-010 — prazo de regularização fiscal expirado', () => {
    it('NF de entrada com prazo expirado sem Nota de Armazenagem bloqueia a liberação do pedido com mensagem de prazo expirado', async () => {
      const product = await createProduct();
      // Prazo de -5 dias (já expirado), sem nenhuma Nota de Armazenagem cobrindo.
      await seedInboundInvoice(product.id, 200, -5);
      await rawAuthorizedQuery(
        testContext.databaseService,
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [clientId, warehouseId, product.id, locationId, 200, SEED_ACTOR_ID]
      );

      const created = await outboundOrderService.create({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qty: 50 }], actorUserId: SEED_ACTOR_ID });

      await expect(outboundOrderService.release(created.order.id, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
        response: {
          pendencies: [expect.objectContaining({ reason: 'FISCAL_STOCK', detail: expect.stringContaining('RN-FIS-010') })],
        },
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-FIS-070 — Pendências documentais (descarte / ajuste negativo)
  // ───────────────────────────────────────────────────────────────────────
  describe('RN-FIS-070 — descarte e ajuste negativo travam qty_pending_writeoff', () => {
    it('descarte aprovado trava qty_pending_writeoff e cria pendência documental', async () => {
      const product = await createProduct();
      const invoice = await seedInboundInvoice(product.id, 100, 10);
      const doc = await storageInvoiceService.register({
        tenantId: clientId, warehouseId, issuerCnpj: (await getClientCnpj()), recipientCnpj: (await getWarehouseCnpj()),
        issuedAt: '2026-05-01T12:00:00.000Z', items: [{ productId: product.id, qty: 100, referenceInboundInvoiceId: invoice.id }], actorUserId: SEED_ACTOR_ID,
      });
      await rawAuthorizedQuery(
        testContext.databaseService,
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_damaged, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [clientId, warehouseId, product.id, locationId, 50, SEED_ACTOR_ID]
      );

      const aprovador1 = gestor;
      const passwordService = new PasswordService(testContext.databaseService);
      const aprovador2 = await createTestUser(testContext.databaseService, passwordService);
      await assignRole(testContext.databaseService, { userId: aprovador2.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });

      const request = await stockReclassificationService.requestDiscard({
        tenantId: clientId, warehouseId, productId: product.id, locationId, sourceBucket: 'DAMAGED', qty: 50,
        reasonRequest: 'Avaria sem recuperação — reflexo fiscal', actorUserId: SEED_ACTOR_ID,
      });
      await stockReclassificationService.decideDiscard(request.id, clientId, warehouseId, aprovador1.id, 'APPROVE', 'Passo 1');
      const step2 = await stockReclassificationService.decideDiscard(request.id, clientId, warehouseId, aprovador2.id, 'APPROVE', 'Passo 2');
      expect(step2.applied).toBe(true);

      const balance = await readFiscalBalance(product.id, doc.id);
      expect(Number(balance.qty_pending_writeoff)).toBe(50);
      expect(Number(balance.qty_credited) - Number(balance.qty_consumed) - Number(balance.qty_pending_writeoff)).toBe(50);

      const pending = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.fiscal_pending_document WHERE tenant_id = $1 AND product_id = $2 AND origin = 'DESCARTE'`,
        [clientId, product.id]
      );
      expect(pending.rows).toHaveLength(1);
      expect(Number(pending.rows[0].qty)).toBe(50);
      expect(pending.rows[0].status).toBe('PENDING');
    });

    it('ajuste negativo de inventário aprovado trava qty_pending_writeoff', async () => {
      const product = await createProduct();
      const invoice = await seedInboundInvoice(product.id, 100, 10);
      const doc = await storageInvoiceService.register({
        tenantId: clientId, warehouseId, issuerCnpj: (await getClientCnpj()), recipientCnpj: (await getWarehouseCnpj()),
        issuedAt: '2026-05-01T12:00:00.000Z', items: [{ productId: product.id, qty: 100, referenceInboundInvoiceId: invoice.id }], actorUserId: SEED_ACTOR_ID,
      });
      const invLocationResult = await testContext.databaseService.queryGlobal(
        `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
         VALUES ($1,$2,'A1','002','00','01','STORAGE',5000,100,5,5,'ACTIVE',$3) RETURNING id`,
        [warehouseId, storageZoneId, SEED_ACTOR_ID]
      );
      const invLocationId = invLocationResult.rows[0].id;
      await rawAuthorizedQuery(
        testContext.databaseService,
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [clientId, warehouseId, product.id, invLocationId, 20, SEED_ACTOR_ID]
      );

      const passwordService = new PasswordService(testContext.databaseService);
      const inv1 = await createTestUser(testContext.databaseService, passwordService);
      const inv2 = await createTestUser(testContext.databaseService, passwordService);
      await assignRole(testContext.databaseService, { userId: inv1.id, roleCode: 'INVENTARIANTE', warehouseId, clientId });
      await assignRole(testContext.databaseService, { userId: inv2.id, roleCode: 'INVENTARIANTE', warehouseId, clientId });

      const planned = await inventoryPlanningService.plan({ tenantId: clientId, warehouseId, countType: 'POR_ENDERECO', locationIds: [invLocationId], actorUserId: gestor.id });
      await inventoryPlanningService.start(clientId, warehouseId, planned.headerId, gestor.id);
      const cellResult = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.inventory_count_location WHERE header_id = $1`,
        [planned.headerId]
      );
      const cellId = cellResult.rows[0].id;

      await inventoryCountExecutionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 15, actorUserId: inv1.id });
      const round2 = await inventoryCountExecutionService.submitRound({ tenantId: clientId, warehouseId, countLocationId: cellId, countedQty: 15, actorUserId: inv2.id });
      expect((round2 as any).status).toBe('ADJUSTMENT_PENDING');

      const decision = await inventoryCountExecutionService.decideAdjustment({
        tenantId: clientId, warehouseId, exceptionId: (round2 as any).exceptionId, decision: 'APPROVE', reason: 'Confirmado', actorUserId: gestor.id,
      });
      expect((decision as any).movementType).toBe('AJUSTE_INVENTARIO_NEG');

      const balance = await readFiscalBalance(product.id, doc.id);
      expect(Number(balance.qty_pending_writeoff)).toBe(5);

      const pending = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.fiscal_pending_document WHERE tenant_id = $1 AND product_id = $2 AND origin = 'AJUSTE_INVENTARIO_NEG'`,
        [clientId, product.id]
      );
      expect(pending.rows).toHaveLength(1);
      expect(Number(pending.rows[0].qty)).toBe(5);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-FIS-041 — Recomposição por reversa (método isolado, sem gatilho — DOC-07 não existe)
  // ───────────────────────────────────────────────────────────────────────
  describe('RN-FIS-041 — reverseConsumption() isolado', () => {
    it('estorno PARCIAL de 40 sobre uma alocação de 100 reduz qty_consumed em 40 e libera saldo disponível', async () => {
      const product = await createProduct();
      const invoice = await seedInboundInvoice(product.id, 400, 10);
      const doc = await storageInvoiceService.register({
        tenantId: clientId, warehouseId, issuerCnpj: (await getClientCnpj()), recipientCnpj: (await getWarehouseCnpj()),
        issuedAt: '2026-05-01T12:00:00.000Z', items: [{ productId: product.id, qty: 400, referenceInboundInvoiceId: invoice.id }], actorUserId: SEED_ACTOR_ID,
      });
      const assembled = await storageReturnInvoiceService.assemble({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qty: 100 }], actorUserId: SEED_ACTOR_ID });
      await storageReturnInvoiceService.authorize(assembled.id, clientId, warehouseId, SEED_ACTOR_ID);

      const balanceBefore = await readFiscalBalance(product.id, doc.id);
      expect(Number(balanceBefore.qty_credited) - Number(balanceBefore.qty_consumed)).toBe(300);

      const allocationResult = await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `SELECT * FROM wms.fiscal_allocation WHERE return_fiscal_document_id = $1`,
        [assembled.id]
      );
      const allocation = allocationResult.rows[0];
      expect(allocation.status).toBe('CONSUMIDA');

      const reversal = await storageReturnInvoiceService.reverseConsumption({
        tenantId: clientId, warehouseId, fiscalAllocationId: allocation.id, qtyToReverse: 40, actorUserId: SEED_ACTOR_ID,
      });
      expect(reversal.status).toBe('CONSUMIDA'); // estorno parcial: não atinge o total da alocação (100)
      expect(reversal.availableAfter).toBe(340);

      const balanceAfter = await readFiscalBalance(product.id, doc.id);
      expect(Number(balanceAfter.qty_credited) - Number(balanceAfter.qty_consumed)).toBe(340);
    });
  });

  // wms.client TEM RLS (id próprio = tenant_id, migration 0009) — ao
  // contrário de wms.warehouse (GLOBAL, sem RLS) — queryGlobal() aqui
  // mascararia silenciosamente (achado documentado em CLAUDE.md, "Acesso a
  // dados: RLS e queryGlobal()"): usa contexto de tenant.
  async function getClientCnpj(): Promise<string> {
    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT cnpj FROM wms.client WHERE id = $1`,
      [clientId]
    );
    return result.rows[0].cnpj;
  }
  async function getWarehouseCnpj(): Promise<string> {
    const result = await testContext.databaseService.queryGlobal(`SELECT cnpj FROM wms.warehouse WHERE id = $1`, [warehouseId]);
    return result.rows[0].cnpj;
  }
});
