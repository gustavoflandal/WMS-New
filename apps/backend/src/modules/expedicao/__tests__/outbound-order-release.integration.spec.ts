// DOC-06 §4.1 — Pedido: criação (RF-EXP-001) e liberação (RN-EXP-002/003)
// contra Postgres real. Inclui os cenários Gherkin do §6 sobre liberação.
import { BadRequestException } from '@nestjs/common';
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
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { StockSelectionService } from '../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../estoque/selection/stock-reservation.service.js';
import { OutboundOrderService } from '../order/outbound-order.service.js';
import { OutboundFlowService } from '../order/outbound-flow.service.js';
import { InboundInvoiceFiscalService } from '../../fiscal/inbound-invoice/inbound-invoice-fiscal.service.js';
import { AlertService } from '../../paineis/alertas/alert.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';

describe('Expedição - DOC-06 §4.1 RN-EXP-002/003 liberação de pedido', () => {
  let testContext: TestContext;
  let orderService: OutboundOrderService;
  let flowService: OutboundFlowService;
  let productService: ProductService;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const operationFlowService = new OperationFlowService(db);
    const stockMovementService = new StockMovementService(db);
    const selectionService = new StockSelectionService(db);
    const rbacService = new RbacService(db);
    const reservationService = new StockReservationService(db, eventsService, auditService, rbacService, selectionService, stockMovementService);
    const documentNumberingService = new DocumentNumberingService(db);

    const alertService = new AlertService(db, eventsService);
    const inboundInvoiceFiscalService = new InboundInvoiceFiscalService(db, alertService);

    flowService = new OutboundFlowService(db, eventsService, operationFlowService);
    orderService = new OutboundOrderService(db, eventsService, auditService, documentNumberingService, selectionService, reservationService, flowService, inboundInvoiceFiscalService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém expedição', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente expedição', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    // INTEGRADO_ERP: o ERP responde pelo fiscal (DOC-00 §3.1) — o controle de
    // Estoque Fiscal fica DESLIGADO por padrão nesta suíte; o teste fiscal
    // troca para EMISSAO_PROPRIA.
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FEFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    storageZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID)).id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  let locationSeq = 0;
  async function createLocation() {
    locationSeq += 1;
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1',$3,'00','01','STORAGE',5000,100,5,5,'ACTIVE',$4) RETURNING *`,
      [warehouseId, storageZoneId, String(locationSeq).padStart(3, '0'), SEED_ACTOR_ID]
    );
    return result.rows[0];
  }

  async function createProduct(status = 'ACTIVE') {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto expedição', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FEFO' },
      SEED_ACTOR_ID
    );
    if (status !== 'ACTIVE') {
      await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, `UPDATE wms.product SET status = $2 WHERE id = $1`, [
        product.id,
        status,
      ]);
    }
    return product;
  }

  async function seedBalance(productId: string, locationId: string, qty: number) {
    await rawAuthorizedQuery(
      testContext.databaseService,
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, warehouseId, productId, locationId, qty, SEED_ACTOR_ID]
    );
  }

  async function setFiscalMode(mode: string) {
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `UPDATE wms.client_warehouse_settings SET fiscal_mode = $2 WHERE tenant_id = $1`,
      [clientId, mode]
    );
  }

  let fiscalDocSeq = 0;
  async function seedFiscalStock(productId: string, credited: number, consumed = 0) {
    // DOC-08 migration 0069: storage_remittance_invoice_id agora tem FK real
    // para wms.fiscal_document(id) — precisa de uma linha real (stub mínimo
    // de Nota de Armazenagem), não mais um UUID solto.
    fiscalDocSeq += 1;
    const docResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.fiscal_document (tenant_id, warehouse_id, document_type, status, internal_number, created_by)
       VALUES ($1,$2,'NOTA_ARMAZENAGEM','REGISTRADA',$3,$4) RETURNING id`,
      [clientId, warehouseId, `FIS-TEST-${fiscalDocSeq}-${Date.now()}`, SEED_ACTOR_ID]
    );
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.fiscal_stock_balance (tenant_id, warehouse_id, product_id, storage_remittance_invoice_id, qty_credited, qty_consumed, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [clientId, warehouseId, productId, docResult.rows[0].id, credited, consumed, SEED_ACTOR_ID]
    );
  }

  it('RF-EXP-001: criação numera com máscara PED, converte embalagem (RN-DAD-021) e instancia as 8 etapas', async () => {
    const product = await createProduct();
    // Embalagem de 12 UN — o pedido pede 5 caixas => 60 UN na unidade base.
    const packagingResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.product_packaging (tenant_id, product_id, code, description, qty_in_base_uom, created_by) VALUES ($1,$2,'CX12','Caixa 12 UN',12,$3) RETURNING id`,
      [clientId, product.id, SEED_ACTOR_ID]
    );

    const created = await orderService.create({
      tenantId: clientId,
      warehouseId,
      items: [{ productId: product.id, qty: 5, packagingId: packagingResult.rows[0].id }],
      actorUserId: SEED_ACTOR_ID,
    });

    expect(created.order.number).toMatch(/^PED-/);
    expect(created.order.status).toBe('DRAFT');
    expect(Number(created.items[0].qty_ordered)).toBe(60); // 5 × 12 (RN-DAD-021)
    expect(Number(created.items[0].source_qty)).toBe(5);

    // RN-EXP-010: 8 etapas, na ordem, todas PENDING.
    const state = await flowService.getOrderFlowState(created.order.id, clientId, SEED_ACTOR_ID);
    expect(state.steps.map((s: any) => s.step_code)).toEqual(['PEDIDO', 'PICKING', 'EMBALAGEM', 'PESAGEM', 'EXPEDICAO', 'CARREGAMENTO', 'SAIDA', 'FIM']);
    expect(state.steps.every((s: any) => s.status === 'PENDING')).toBe(true);
    // Regra 2: só a primeira é acionável.
    expect(state.steps.filter((s: any) => s.is_actionable).map((s: any) => s.step_code)).toEqual(['PEDIDO']);
  });

  it('RN-EXP-002/003: liberação valida saldo, reserva e conclui a etapa Pedido → RELEASED', async () => {
    const product = await createProduct();
    const location = await createLocation();
    await seedBalance(product.id, location.id, 100);

    const created = await orderService.create({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qty: 40 }], actorUserId: SEED_ACTOR_ID });
    const result = await orderService.release(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);

    expect(result.pendencies).toEqual([]);
    expect(result.releasedItems).toBe(1);
    expect(result.qtyReservedTotal).toBe(40);
    expect(result.order.status).toBe('RELEASED');

    // RN-EXP-003: reserva real — saldo migrou de available para reserved.
    const balance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_reserved FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [product.id, location.id]
    );
    expect(Number(balance.rows[0].qty_available)).toBe(60);
    expect(Number(balance.rows[0].qty_reserved)).toBe(40);

    // Detalhamento saldo→ITEM persistido (RN-EXP-003).
    const reservations = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT demand_ref_type, qty FROM wms.stock_reservation WHERE demand_ref_id = $1`,
      [created.items[0].id]
    );
    expect(reservations.rows).toHaveLength(1);
    expect(reservations.rows[0].demand_ref_type).toBe('OUTBOUND_ORDER_ITEM');

    // Etapa Pedido concluída; Picking passa a ser a acionável.
    const state = await flowService.getOrderFlowState(created.order.id, clientId, SEED_ACTOR_ID);
    expect(state.steps.find((s: any) => s.step_code === 'PEDIDO').status).toBe('DONE');
    expect(state.steps.filter((s: any) => s.is_actionable).map((s: any) => s.step_code)).toEqual(['PICKING']);
  });

  // ───────────────────────────────────────────────────────────────────────
  // §6 — "Liberação bloqueada por saldo fiscal insuficiente"
  // ───────────────────────────────────────────────────────────────────────
  it('§6: item com 700 demandadas e saldo fiscal 600 é rejeitado com "saldo fiscal insuficiente: disponível 600"', async () => {
    await setFiscalMode('EMISSAO_PROPRIA'); // cliente controla Estoque Fiscal (RG-014)
    try {
      const fiscalProduct = await createProduct();
      const okProduct = await createProduct();
      const location = await createLocation();
      // Saldo FÍSICO sobra nos dois: a rejeição tem de ser fiscal, não física.
      await seedBalance(fiscalProduct.id, location.id, 1000);
      await seedBalance(okProduct.id, (await createLocation()).id, 1000);
      await seedFiscalStock(fiscalProduct.id, 600);
      await seedFiscalStock(okProduct.id, 1000);

      const created = await orderService.create({
        tenantId: clientId,
        warehouseId,
        items: [
          { productId: fiscalProduct.id, qty: 700 },
          { productId: okProduct.id, qty: 10 },
        ],
        actorUserId: SEED_ACTOR_ID,
      });

      const result = await orderService.release(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);

      expect(result.pendencies).toHaveLength(1);
      expect(result.pendencies[0].reason).toBe('FISCAL_STOCK');
      expect(result.pendencies[0].detail).toBe('saldo fiscal insuficiente: disponível 600');

      // "com EXP.PERMITE_LIBERACAO_PARCIAL ativo os demais itens devem poder liberar"
      expect(result.releasedItems).toBe(1);
      expect(result.order.status).toBe('RELEASED');
    } finally {
      await setFiscalMode('INTEGRADO_ERP');
    }
  });

  it('RN-EXP-002: liberação parcial gera pedido remanescente vinculado com os itens pendentes', async () => {
    const okProduct = await createProduct();
    const shortProduct = await createProduct();
    await seedBalance(okProduct.id, (await createLocation()).id, 100);
    await seedBalance(shortProduct.id, (await createLocation()).id, 5); // insuficiente para 50

    const created = await orderService.create({
      tenantId: clientId,
      warehouseId,
      items: [
        { productId: okProduct.id, qty: 20 },
        { productId: shortProduct.id, qty: 50 },
      ],
      actorUserId: SEED_ACTOR_ID,
    });

    const result = await orderService.release(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);

    expect(result.pendencies).toHaveLength(1);
    expect(result.pendencies[0].reason).toBe('PHYSICAL_STOCK');
    expect(result.remainderOrderId).not.toBeNull();

    // O remanescente é VINCULADO e contém só o item pendente.
    const remainder = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT o.status, o.remainder_of_order_id, i.product_id, i.qty_ordered
       FROM wms.outbound_order o JOIN wms.outbound_order_item i ON i.outbound_order_id = o.id
       WHERE o.id = $1`,
      [result.remainderOrderId]
    );
    expect(remainder.rows).toHaveLength(1);
    expect(remainder.rows[0].status).toBe('DRAFT');
    expect(remainder.rows[0].remainder_of_order_id).toBe(created.order.id);
    expect(remainder.rows[0].product_id).toBe(shortProduct.id);
    expect(Number(remainder.rows[0].qty_ordered)).toBe(50);
  });

  it('RN-EXP-002: produto bloqueado é pendência BLOCKED e, sendo o único item, a liberação é rejeitada sem efeito', async () => {
    const blockedProduct = await createProduct('BLOCKED');
    await seedBalance(blockedProduct.id, (await createLocation()).id, 100);

    const created = await orderService.create({ tenantId: clientId, warehouseId, items: [{ productId: blockedProduct.id, qty: 10 }], actorUserId: SEED_ACTOR_ID });

    await expect(orderService.release(created.order.id, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toBeInstanceOf(BadRequestException);

    // Nada mudou: sem reserva, sem etapa concluída.
    const state = await flowService.getOrderFlowState(created.order.id, clientId, SEED_ACTOR_ID);
    expect(state.order.persisted_status).toBe('DRAFT');
    expect(state.steps.find((s: any) => s.step_code === 'PEDIDO').status).toBe('PENDING');
  });

  it('concorrência: dois pedidos disputando o mesmo saldo — a soma reservada nunca excede o disponível', async () => {
    const product = await createProduct();
    const location = await createLocation();
    await seedBalance(product.id, location.id, 100);

    const orderA = await orderService.create({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qty: 60 }], actorUserId: SEED_ACTOR_ID });
    const orderB = await orderService.create({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qty: 60 }], actorUserId: SEED_ACTOR_ID });

    // Reuso da serialização da 5B (SELECT ... FOR UPDATE dentro da reserva).
    const results = await Promise.allSettled([
      orderService.release(orderA.order.id, clientId, warehouseId, SEED_ACTOR_ID),
      orderService.release(orderB.order.id, clientId, warehouseId, SEED_ACTOR_ID),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // Um libera 60; o outro não tem 60 e é rejeitado (liberação parcial só
    // vale ENTRE itens, não fraciona a quantidade de um item).
    expect(fulfilled).toHaveLength(1);

    const balance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_reserved FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [product.id, location.id]
    );
    expect(Number(balance.rows[0].qty_reserved)).toBe(60);
    expect(Number(balance.rows[0].qty_available)).toBe(40);
  });
});
