// DOC-06 §4.3 RF-EXP-020 (ondas) e §4.1 RN-EXP-003 (expiração de reserva,
// devolvendo o pedido a RELEASED_EXPIRED e liberando o saldo).
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
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { StockSelectionService } from '../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../estoque/selection/stock-reservation.service.js';
import { OutboundOrderService } from '../order/outbound-order.service.js';
import { OutboundFlowService } from '../order/outbound-flow.service.js';
import { ReservationExpiryService } from '../order/reservation-expiry.service.js';
import { WaveService } from '../wave/wave.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';

describe('Expedição - DOC-06 §4.3 ondas e §4.1 RN-EXP-003 expiração de reserva', () => {
  let testContext: TestContext;
  let orderService: OutboundOrderService;
  let flowService: OutboundFlowService;
  let waveService: WaveService;
  let reservationExpiryService: ReservationExpiryService;
  let productService: ProductService;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    const operationFlowService = new OperationFlowService(db);
    const stockMovementService = new StockMovementService(db);
    const selectionService = new StockSelectionService(db);
    const reservationService = new StockReservationService(db, eventsService, auditService, rbacService, selectionService, stockMovementService);
    const documentNumberingService = new DocumentNumberingService(db);

    flowService = new OutboundFlowService(db, eventsService, operationFlowService);
    orderService = new OutboundOrderService(db, eventsService, auditService, documentNumberingService, selectionService, reservationService, flowService);
    waveService = new WaveService(db, eventsService, auditService);
    reservationExpiryService = new ReservationExpiryService(db, eventsService, stockMovementService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém ondas', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente ondas', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
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
  async function createOrder(qty = 10, release = true) {
    locationSeq += 1;
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto onda', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FEFO' },
      SEED_ACTOR_ID
    );
    const location = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,'A1',$3,'00','01','STORAGE',5000,100,5,5,'ACTIVE',$4) RETURNING *`,
      [warehouseId, storageZoneId, String(locationSeq).padStart(3, '0'), SEED_ACTOR_ID]
    );
    await rawAuthorizedQuery(
      testContext.databaseService,
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.stock_balance (tenant_id, warehouse_id, product_id, location_id, qty_available, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [clientId, warehouseId, product.id, location.rows[0].id, qty * 5, SEED_ACTOR_ID]
    );
    const created = await orderService.create({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qty }], actorUserId: SEED_ACTOR_ID });
    if (release) await orderService.release(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    return { orderId: created.order.id, productId: product.id, locationId: location.rows[0].id };
  }

  // ───────────────────────────────────────────────────────────────────────
  // RF-EXP-020 — ondas
  // ───────────────────────────────────────────────────────────────────────
  it('RF-EXP-020: agrupa pedidos RELEASED, vincula e libera publicando o gatilho para a 6B', async () => {
    const a = await createOrder();
    const b = await createOrder();

    const wave = await waveService.create({
      tenantId: clientId,
      warehouseId,
      outboundOrderIds: [a.orderId, b.orderId],
      filters: { carrier_name: 'Transportadora X' },
      actorUserId: SEED_ACTOR_ID,
    });
    expect(wave.wave.status).toBe('CREATED');
    expect(wave.orderCount).toBe(2);

    // Os pedidos passam a apontar para a onda, com ordem de entrada preservada
    // (é dela que o sequenciamento do picking da 6B vai partir).
    const linked = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT outbound_order_id, sequence_order FROM wms.wave_order WHERE wave_id = $1 ORDER BY sequence_order`,
      [wave.wave.id]
    );
    expect(linked.rows.map((r: any) => r.outbound_order_id)).toEqual([a.orderId, b.orderId]);

    const released = await waveService.release(wave.wave.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(released.status).toBe('RELEASED');

    // O evento que a 6B consumirá para gerar as tarefas (RF-EXP-030).
    // db.query com contexto: wms.event_outbox tem RLS por tenant.
    const events = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT payload FROM wms.event_outbox WHERE event_type = 'expedicao.onda_liberada' ORDER BY created_at DESC LIMIT 1`,
      []
    );
    expect(events.rows[0].payload.wave_id).toBe(wave.wave.id);
    expect(events.rows[0].payload.outbound_order_ids).toEqual([a.orderId, b.orderId]);
  });

  it('RF-EXP-020: só pedidos RELEASED entram em onda, e um pedido não entra em duas', async () => {
    const draft = await createOrder(10, false); // fica em DRAFT
    await expect(
      waveService.create({ tenantId: clientId, warehouseId, outboundOrderIds: [draft.orderId], actorUserId: SEED_ACTOR_ID })
    ).rejects.toBeInstanceOf(BadRequestException);

    const released = await createOrder();
    await waveService.create({ tenantId: clientId, warehouseId, outboundOrderIds: [released.orderId], actorUserId: SEED_ACTOR_ID });
    // Segunda onda com o mesmo pedido → conflito.
    await expect(
      waveService.create({ tenantId: clientId, warehouseId, outboundOrderIds: [released.orderId], actorUserId: SEED_ACTOR_ID })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('RF-EXP-020: respeita EXP.ONDA_MAX_PEDIDOS', async () => {
    // INSERT, não UPDATE: cleanTestData() limpa wms.app_parameter entre
    // arquivos de teste, então o valor semeado pela migration 0050 não existe
    // aqui — um UPDATE afetaria 0 linhas em silêncio e o serviço cairia no
    // default 200, fazendo o teste passar sem testar nada.
    // Além disso, db.query COM contexto de tenant (app_parameter tem RLS).
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await testContext.databaseService.query(ctx, `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'EXP.ONDA_MAX_PEDIDOS', '1')`, []);
    try {
      const a = await createOrder();
      const b = await createOrder();
      await expect(
        waveService.create({ tenantId: clientId, warehouseId, outboundOrderIds: [a.orderId, b.orderId], actorUserId: SEED_ACTOR_ID })
      ).rejects.toMatchObject({ response: { error: 'WAVE_MAX_ORDERS_EXCEEDED' } });
    } finally {
      await testContext.databaseService.query(ctx, `DELETE FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EXP.ONDA_MAX_PEDIDOS'`, []);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-EXP-003 — expiração de reserva
  // ───────────────────────────────────────────────────────────────────────
  it('RN-EXP-003: reserva vencida devolve o pedido a RELEASED_EXPIRED e libera o saldo', async () => {
    const { orderId, productId, locationId } = await createOrder(30);

    const before = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_reserved FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId]
    );
    expect(Number(before.rows[0].qty_reserved)).toBe(30);

    // Envelhece a reserva além de EXP.RESERVA_VALIDADE_H (72h padrão).
    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `UPDATE wms.outbound_order SET reserved_at = now() - INTERVAL '80 hours' WHERE id = $1`,
      [orderId]
    );

    const result = await reservationExpiryService.expireOverdueReservations();
    expect(result.expiredOrderIds).toContain(orderId);
    expect(result.qtyReleased).toBeGreaterThanOrEqual(30);

    // Saldo devolvido ao disponível.
    const after = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_reserved FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId]
    );
    expect(Number(after.rows[0].qty_reserved)).toBe(0);
    expect(Number(after.rows[0].qty_available)).toBe(Number(before.rows[0].qty_available) + 30);

    // §5.1: o pedido PERMANECE em RELEASED (estado canônico) e o substado
    // RELEASED_EXPIRED aparece só na leitura derivada.
    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(state.order.persisted_status).toBe('RELEASED');
    expect(state.order.status).toBe('RELEASED_EXPIRED');

    // E o pedido pode ser liberado de novo (RN-EXP-003: "para nova liberação").
    const rereleased = await orderService.release(orderId, clientId, warehouseId, SEED_ACTOR_ID);
    expect(rereleased.qtyReservedTotal).toBe(30);
    const reread = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(reread.order.status).toBe('RELEASED'); // substado limpo
  });

  it('RN-EXP-003: reserva dentro da validade não expira', async () => {
    const { orderId } = await createOrder(5);
    const result = await reservationExpiryService.expireOverdueReservations();
    expect(result.expiredOrderIds).not.toContain(orderId);
  });
});
