// DOC-10 §4.5 RN-PAI-041/042 [INVIOLÁVEL] — materialização de KPIs contra
// Postgres real. Exemplo normativo K-06 OTIF (40 concluídos, 32 sem corte,
// 30 no prazo -> 75,0%), idempotência por event_id, recontagem
// determinística, e snapshot no fuso do armazém (K-13).
import { v4 as uuid } from 'uuid';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../../cadastro/product/product.service.js';
import { ZoneService } from '../../../cadastro/zone/zone.service.js';
import { AuditService } from '../../../../core/audit/audit.service.js';
import { EventsService } from '../../../../core/events/events.service.js';
import { DocumentNumberingService } from '../../../cadastro/document-numbering/document-numbering.service.js';
import { StockSelectionService } from '../../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../../estoque/selection/stock-reservation.service.js';
import { RbacService } from '../../../../core/rbac/rbac.service.js';
import { StockMovementService } from '../../../estoque/movement/stock-movement.service.js';
import { OperationFlowService } from '../../../../core/operation-flow/operation-flow.service.js';
import { OutboundOrderService } from '../../../expedicao/order/outbound-order.service.js';
import { OutboundFlowService } from '../../../expedicao/order/outbound-flow.service.js';
import { KpiComputationService } from '../kpi-computation.service.js';
import { KpiMaterializationService } from '../kpi-materialization.service.js';
import { KpiSnapshotService } from '../kpi-snapshot.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../../cadastro/__tests__/test-helpers.js';
import { generateValidCpf, randomMercosulPlate } from '../../../portaria/__tests__/test-helpers.js';

describe('KPI - DOC-10 §4.5 RN-PAI-041/042 (Sessão 7A)', () => {
  let testContext: TestContext;
  let orderService: OutboundOrderService;
  let kpiComputationService: KpiComputationService;
  let kpiMaterializationService: KpiMaterializationService;
  let kpiSnapshotService: KpiSnapshotService;
  let productService: ProductService;

  let warehouseId: string;
  let clientId: string;
  let productId: string;
  let vehicleVisitId: string;

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
    const flowService = new OutboundFlowService(db, eventsService, operationFlowService);
    orderService = new OutboundOrderService(db, eventsService, auditService, documentNumberingService, selectionService, reservationService, flowService);

    kpiComputationService = new KpiComputationService(db);
    kpiMaterializationService = new KpiMaterializationService(db, eventsService, kpiComputationService);
    kpiSnapshotService = new KpiSnapshotService(db, eventsService, kpiComputationService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    void zoneService;

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém KPI', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente KPI', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create({ tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FEFO', blind_checking: true }, SEED_ACTOR_ID);
    productId = (await productService.create({ tenant_id: clientId, sku: randomSku(), description: 'Produto KPI', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FEFO' }, SEED_ACTOR_ID)).id;

    // Veículo/motorista/visita criados via SQL direto — só a FORMA dos dados
    // importa para o KPI (gate_out_at), não o fluxo de negócio do DOC-03
    // (já coberto pelos testes de portaria).
    const driverResult = await db.queryGlobal(
      `INSERT INTO wms.driver (cpf, name, cnh, cnh_validity, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [generateValidCpf(), 'Motorista KPI', 'CNH-KPI', '2030-01-01', SEED_ACTOR_ID]
    );
    const vehicleResult = await db.queryGlobal(`INSERT INTO wms.vehicle (plate, vehicle_type, created_by) VALUES ($1,'TRUCK',$2) RETURNING id`, [
      randomMercosulPlate(),
      SEED_ACTOR_ID,
    ]);
    const visitResult = await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `INSERT INTO wms.vehicle_visit (tenant_id, warehouse_id, direction, vehicle_id, driver_id, gate_in_at, gate_out_at, status, created_by)
       VALUES ($1,$2,'OUTBOUND',$3,$4, now() - interval '2 hours', now(), 'ENCERRADA', $5) RETURNING id`,
      [clientId, warehouseId, vehicleResult.rows[0].id, driverResult.rows[0].id, SEED_ACTOR_ID]
    );
    vehicleVisitId = visitResult.rows[0].id;
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  /** Cria 1 pedido CONCLUÍDO (status direto via SQL) com/sem corte e vinculado à visita comum via loading/loading_order. */
  async function seedCompletedOrder(opts: { hasCut: boolean; onTime: boolean }) {
    const db = testContext.databaseService;
    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    const number = `PED-KPI-${uuid().slice(0, 8)}`;
    const expectedDate = opts.onTime ? '2099-01-01' : '2000-01-01';

    // updated_at não tem DEFAULT (só é setado por UPDATE no fluxo real) — os
    // KPIs usam updated_at como proxy de "data de conclusão" (sem coluna
    // completed_at dedicada, ver kpi-computation.service.ts), então o seed
    // direto por SQL precisa setá-lo explicitamente.
    const orderResult = await db.query(
      ctx,
      `INSERT INTO wms.outbound_order (tenant_id, warehouse_id, number, status, expected_dispatch_date, released_at, updated_at, created_by)
       VALUES ($1,$2,$3,'COMPLETED',$4::date, now() - interval '1 hour', now(), $5) RETURNING id`,
      [clientId, warehouseId, number, expectedDate, SEED_ACTOR_ID]
    );
    const orderId = orderResult.rows[0].id;

    await db.query(
      ctx,
      `INSERT INTO wms.outbound_order_item (tenant_id, outbound_order_id, product_id, line_number, qty_ordered, qty_short, created_by)
       VALUES ($1,$2,$3,1,10,$4,$5)`,
      [clientId, orderId, productId, opts.hasCut ? 2 : 0, SEED_ACTOR_ID]
    );

    const loadingResult = await db.query(
      ctx,
      `INSERT INTO wms.loading (tenant_id, warehouse_id, vehicle_visit_id, status, created_by) VALUES ($1,$2,$3,'COMPLETED',$4) RETURNING id`,
      [clientId, warehouseId, vehicleVisitId, SEED_ACTOR_ID]
    );
    await db.query(ctx, `INSERT INTO wms.loading_order (tenant_id, loading_id, outbound_order_id, created_by) VALUES ($1,$2,$3,$4)`, [
      clientId,
      loadingResult.rows[0].id,
      orderId,
      SEED_ACTOR_ID,
    ]);

    return orderId;
  }

  it('exemplo normativo §4.5 K-06 OTIF — 40 concluídos, 32 sem corte, 30 no prazo -> 75,0%', async () => {
    // 30 sem corte, no prazo.
    for (let i = 0; i < 30; i++) await seedCompletedOrder({ hasCut: false, onTime: true });
    // 2 sem corte, fora do prazo (contam em K-05, não em K-06).
    for (let i = 0; i < 2; i++) await seedCompletedOrder({ hasCut: false, onTime: false });
    // 8 com corte (contam em K-05, nunca em K-06 mesmo se no prazo).
    for (let i = 0; i < 8; i++) await seedCompletedOrder({ hasCut: true, onTime: true });

    const today = new Date().toISOString().slice(0, 10);
    await kpiMaterializationService.recomputeDay(warehouseId, today);

    const k05 = await queryKpi('K-05', null);
    const k06 = await queryKpi('K-06', null);
    expect(k05).toBe(40);
    expect(k06).toBe(75.0);
  });

  it('RN-PAI-042: recontagem administrativa reproduz exatamente os mesmos valores (determinismo)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await kpiMaterializationService.recomputeDay(warehouseId, today);
    const first = await queryKpi('K-06', null);

    await kpiMaterializationService.recomputeDay(warehouseId, today);
    const second = await queryKpi('K-06', null);

    expect(second).toBe(first);
  });

  it('RN-PAI-042: idempotência por event_id — reprocessar o mesmo evento não duplica nem altera o agregado', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const eventId = uuid();
    const event = { event_id: eventId, event_type: 'expedicao.pedido_concluido', tenant_id: clientId, warehouse_id: warehouseId, occurred_at: new Date().toISOString() };

    const first = await kpiMaterializationService.applyEvent(event);
    expect(first.applied).toBe(true);

    const before = await queryKpi('K-05', null);
    const second = await kpiMaterializationService.applyEvent(event);
    expect(second.applied).toBe(false);
    const after = await queryKpi('K-05', null);

    expect(after).toBe(before);

    // kpi_event_applied só tem GRANT para wms_worker (bookkeeping interno,
    // wms_app não a toca por contrato — grants-contract.integration.spec.ts).
    const appliedRows = await testContext.databaseService.transactionAsWorker((client) =>
      client.query(`SELECT COUNT(*) AS count FROM wms.kpi_event_applied WHERE event_id = $1`, [eventId])
    );
    expect(Number(appliedRows.rows[0].count)).toBe(1);
    void today;
  });

  it('K-13 snapshot é computado para o dia LOCAL do armazém (America/Sao_Paulo, não UTC)', async () => {
    const localDay = '2026-08-15';
    await kpiSnapshotService.runSnapshot(warehouseId, localDay);

    const result = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT value FROM wms.kpi_daily WHERE warehouse_id = $1 AND client_id IS NULL AND day = $2::date AND kpi_code = 'K-13'`,
      [warehouseId, localDay]
    );
    expect(result.rows.length).toBe(1);
    expect(Number(result.rows[0].value)).toBeGreaterThanOrEqual(0);
  });

  async function queryKpi(kpiCode: string, clientIdFilter: string | null): Promise<number | null> {
    const today = new Date().toISOString().slice(0, 10);
    // kpi_daily tem RLS mesmo para linhas client_id NULL (só dispensa
    // app.tenant_ids, não app.warehouse_id — migration 0056) — precisa de
    // contexto de tenant via db.query(ctx,...), não queryGlobal().
    const result = await testContext.databaseService.query<{ value: string }>(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT value FROM wms.kpi_daily WHERE warehouse_id = $1 AND client_id IS NOT DISTINCT FROM $2 AND day = $3::date AND kpi_code = $4`,
      [warehouseId, clientIdFilter, today, kpiCode]
    );
    return result.rows[0] ? Number(result.rows[0].value) : null;
  }
});
