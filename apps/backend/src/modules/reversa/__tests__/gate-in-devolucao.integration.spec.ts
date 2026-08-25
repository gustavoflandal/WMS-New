// DOC-07 §4/§6 — Sessão 9B: integração real do gate-in com RN-REV-002
// (devolução autorizada) e RF-REV-001 (RECUSA_ENTREGA automática). Cenário
// Gherkin coberto: "Retorno sem autorização aguarda fora".
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { setupPortariaServices, PortariaServices, generateValidCpf, randomMercosulPlate } from '../../portaria/__tests__/test-helpers.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';

describe('DOC-07 §4/§6 — Sessão 9B: gate-in de devolução (RN-REV-002/RF-REV-001)', () => {
  let testContext: TestContext;
  let services: PortariaServices;
  let productService: ProductService;
  let warehouseId: string;
  let clientId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    productService = new ProductService(db, auditService);
    services = setupPortariaServices(db);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém devolução', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente devolução', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    // 2 vagas: teste 1 não ocupa nenhuma (bloqueado antes da alocação), testes 2 e 3 completam o gate-in e ocupam 1 cada.
    await db.queryGlobal(`INSERT INTO wms.yard_slot (warehouse_id, code, slot_type, created_by) VALUES ($1,'Y01','WAITING',$2), ($1,'Y02','WAITING',$2)`, [
      warehouseId,
      SEED_ACTOR_ID,
    ]);
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function createProduct() {
    return productService.create({ tenant_id: clientId, sku: randomSku(), description: 'Produto devolução', species_code: 'GERAL', base_uom: 'UN' }, SEED_ACTOR_ID);
  }

  /** Pedido COMPLETED + item + volume expedido — mesmo padrão de SESSAO-9A, sem o encadeamento fiscal (não testado aqui). */
  async function createShippedOrder(productId: string, qty: number) {
    const db = testContext.databaseService;
    return db.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      const order = await client.query(`INSERT INTO wms.outbound_order (tenant_id, warehouse_id, number, status, created_by) VALUES ($1,$2,$3,'COMPLETED',$4) RETURNING id`, [
        clientId,
        warehouseId,
        `PED-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        SEED_ACTOR_ID,
      ]);
      const outboundOrderId = order.rows[0].id;
      const item = await client.query(
        `INSERT INTO wms.outbound_order_item (tenant_id, outbound_order_id, product_id, line_number, qty_ordered, created_by) VALUES ($1,$2,$3,1,$4,$5) RETURNING id`,
        [clientId, outboundOrderId, productId, qty, SEED_ACTOR_ID]
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
        qty,
        SEED_ACTOR_ID,
      ]);
      return { outboundOrderId, outboundOrderItemId };
    });
  }

  it('Cenário: Retorno sem autorização aguarda fora — gate-in referencia Ordem NÃO autorizada (REQUESTED)', async () => {
    const product = await createProduct();
    const { outboundOrderId, outboundOrderItemId } = await createShippedOrder(product.id, 10);
    const returnOrder = await services.returnOrderService.createReturnOrder(
      {
        tenantId: clientId,
        warehouseId,
        type: 'DEVOLUCAO_CLIENTE_FINAL',
        sourceOutboundOrderId: outboundOrderId,
        items: [{ productId: product.id, qty: 10, sourceOutboundOrderItemId: outboundOrderItemId }],
      },
      SEED_ACTOR_ID
    );
    expect(returnOrder.status).toBe('REQUESTED');

    const visit = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista devolução', cnh: 'CNH000222', cnh_validity: '2030-01-01' },
        return_order_id: returnOrder.id,
      },
      SEED_ACTOR_ID
    );

    expect(visit.status).toBe('AGUARDANDO_AUTORIZACAO');
    expect(visit.blocking_reason).toBe('SEM_AUTORIZACAO_REVERSA');
    expect(visit.yard_slot_id).toBeNull();

    const exceptionResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.operational_exception WHERE entity = 'vehicle_visit' AND entity_id = $1`,
      [visit.id]
    );
    expect(exceptionResult.rows).toHaveLength(1);
    expect(exceptionResult.rows[0].exception_type).toBe('REV.SEM_AUTORIZACAO');

    // Ordem de Devolução em si não muda de estado — quem ficou bloqueado foi o gate-in.
    const unchanged = await services.returnOrderService.findById(returnOrder.id, clientId, SEED_ACTOR_ID);
    expect(unchanged.status).toBe('REQUESTED');
  });

  it('gate-in com Ordem AUTHORIZED completa normalmente e vincula a chegada (IN_RECEIPT + Fluxo Operacional)', async () => {
    const product = await createProduct();
    const { outboundOrderId, outboundOrderItemId } = await createShippedOrder(product.id, 5);
    const returnOrder = await services.returnOrderService.createReturnOrder(
      {
        tenantId: clientId,
        warehouseId,
        type: 'DEVOLUCAO_CLIENTE_FINAL',
        sourceOutboundOrderId: outboundOrderId,
        items: [{ productId: product.id, qty: 5, sourceOutboundOrderItemId: outboundOrderItemId }],
      },
      SEED_ACTOR_ID
    );
    await services.returnOrderService.authorize(returnOrder.id, clientId, warehouseId, SEED_ACTOR_ID);

    const visit = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate: randomMercosulPlate(),
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista devolução autorizada', cnh: 'CNH000333', cnh_validity: '2030-01-01' },
        return_order_id: returnOrder.id,
      },
      SEED_ACTOR_ID
    );

    expect(visit.blocking_reason).toBeNull();
    expect(visit.yard_slot_id).not.toBeNull();

    const linked = await services.returnOrderService.findById(returnOrder.id, clientId, SEED_ACTOR_ID);
    expect(linked.status).toBe('IN_RECEIPT');
    expect(linked.vehicle_visit_id).toBe(visit.id);

    const flow = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT fs.step_code, fs.status FROM wms.operation_flow f JOIN wms.flow_step fs ON fs.operation_flow_id = f.id WHERE f.entity = 'return_order' AND f.entity_id = $1 AND fs.step_code = 'CHEGADA'`,
      [returnOrder.id]
    );
    expect(flow.rows).toHaveLength(1);
    expect(flow.rows[0].status).toBe('DONE');
  });

  it('RF-REV-001: RECUSA_ENTREGA automática — veículo da expedição volta, Ordem é criada e autorizada sozinha', async () => {
    const product = await createProduct();
    const { outboundOrderId, outboundOrderItemId } = await createShippedOrder(product.id, 7);
    const plate = randomMercosulPlate();

    // Simula o retorno físico: visita OUTBOUND ENCERRADA da mesma placa, com loading/loading_order vinculando o pedido expedido.
    const outboundVisitId = await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      const vehicle = await services.vehicleService.upsertByPlate({ plate, vehicle_type: 'TRUCK' }, SEED_ACTOR_ID);
      const driver = await services.driverService.upsertByCpf({ cpf: generateValidCpf(), name: 'Motorista recusa', cnh: 'CNH000444', cnh_validity: '2030-01-01' }, SEED_ACTOR_ID);
      const visit = await services.vehicleVisitService.createWithClient(
        client,
        { tenant_id: clientId, warehouse_id: warehouseId, direction: 'OUTBOUND', vehicle_id: vehicle.id, driver_id: driver.id },
        SEED_ACTOR_ID
      );
      await client.query(`UPDATE wms.vehicle_visit SET status = 'ENCERRADA', gate_out_at = now() WHERE id = $1`, [visit.id]);
      const loading = await client.query(`INSERT INTO wms.loading (tenant_id, warehouse_id, vehicle_visit_id, status, created_by) VALUES ($1,$2,$3,'COMPLETED',$4) RETURNING id`, [
        clientId,
        warehouseId,
        visit.id,
        SEED_ACTOR_ID,
      ]);
      await client.query(`INSERT INTO wms.loading_order (tenant_id, loading_id, outbound_order_id, created_by) VALUES ($1,$2,$3,$4)`, [
        clientId,
        loading.rows[0].id,
        outboundOrderId,
        SEED_ACTOR_ID,
      ]);
      return visit.id;
    });
    void outboundVisitId;
    void outboundOrderItemId;

    const gateInVisit = await services.gateInService.registerGateIn(
      {
        tenant_id: clientId,
        warehouse_id: warehouseId,
        direction: 'INBOUND',
        plate,
        vehicle_type: 'TRUCK',
        driver: { cpf: generateValidCpf(), name: 'Motorista recusa retorno', cnh: 'CNH000555', cnh_validity: '2030-01-01' },
        recusa_entrega: true,
      },
      SEED_ACTOR_ID
    );

    expect(gateInVisit.blocking_reason).toBeNull();
    expect(gateInVisit.yard_slot_id).not.toBeNull();

    const createdOrders = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT * FROM wms.return_order WHERE type = 'RECUSA_ENTREGA' AND source_outbound_order_id = $1`,
      [outboundOrderId]
    );
    expect(createdOrders.rows).toHaveLength(1);
    const recusaOrder = createdOrders.rows[0];
    expect(recusaOrder.status).toBe('IN_RECEIPT');
    expect(recusaOrder.vehicle_visit_id).toBe(gateInVisit.id);
    expect(recusaOrder.authorized_by).toBe(SEED_ACTOR_ID);

    const items = await services.returnOrderService.listItems(recusaOrder.id, clientId, SEED_ACTOR_ID);
    expect(items).toHaveLength(1);
    expect(Number(items[0].qty_authorized)).toBe(7);
  });
});
