// DOC-04 §4.3/§6 — CheckingService: RF-REC-020/021, RN-REC-022/023
// [INVIOLÁVEL], RF-REC-024. Cenários Gherkin cobertos (§6): "Conferência
// cega com divergência de falta", "Falta aprovada ajusta a ordem", "Sobra
// recebida como bloqueada", "Avaria exige foto".
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { ConfigService } from '@nestjs/config';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { InboundOrderService } from '../inbound-order/inbound-order.service.js';
import { CheckingService } from '../checking/checking.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole, grantApprovalAuthority } from '../../../core/__tests__/security-test-helpers.js';

describe('Recebimento - DOC-04 §4.3/§6 CheckingService', () => {
  let testContext: TestContext;
  let checkingService: CheckingService;
  let inboundOrderService: InboundOrderService;
  let operationFlowService: OperationFlowService;
  let productService: ProductService;
  let clientId: string;
  let warehouseId: string;
  let conferente1: { id: string };
  let conferente2: { id: string };
  let decisor: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    operationFlowService = new OperationFlowService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    const fileStorageService = new FileStorageService(testContext.configService as ConfigService);
    fileStorageService.onModuleInit();
    const passwordService = new PasswordService(db);

    inboundOrderService = new InboundOrderService(
      db,
      eventsService,
      auditService,
      operationalExceptionService,
      operationFlowService,
      fileStorageService,
      documentNumberingService
    );
    checkingService = new CheckingService(db, eventsService, auditService, operationalExceptionService, operationFlowService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);

    const warehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém checking', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente checking', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;

    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );

    conferente1 = await createTestUser(db, passwordService);
    conferente2 = await createTestUser(db, passwordService);
    decisor = await createTestUser(db, passwordService);
    await assignRole(db, { userId: conferente1.id, roleCode: 'CONFERENTE', warehouseId, clientId });
    await assignRole(db, { userId: conferente2.id, roleCode: 'CONFERENTE', warehouseId, clientId });
    await assignRole(db, { userId: decisor.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    for (const exceptionType of ['REC.DIVERGENCIA_FALTA', 'REC.DIVERGENCIA_SOBRA', 'REC.DIVERGENCIA_AVARIA', 'REC.DIVERGENCIA_TROCA']) {
      await grantApprovalAuthority(db, { roleCode: 'GESTOR_ARMAZEM', exceptionType, warehouseId, maxQty: 100000 });
    }
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  /**
   * Cria uma Ordem manual com os itens dados e a leva até CHECKING via
   * startUnloading/startChecking. `AT_DOCK` é obtido diretamente por SQL +
   * conclusão manual da etapa "DOCA" do Fluxo Operacional — em vez de
   * `DockService.dockVehicle()` real (que exigiria a cadeia completa de
   * chamada de doca do DOC-03) — porque este arquivo testa `CheckingService`
   * isoladamente; `DockService` tem sua própria suíte de testes futura.
   */
  async function bringOrderToChecking(items: { sku: string; qty: number; description?: string }[]) {
    const productIds: string[] = [];
    for (const it of items) {
      const product = await productService.create(
        { tenant_id: clientId, sku: it.sku, description: it.description ?? `Produto ${it.sku}`, species_code: 'GERAL', base_uom: 'UN' },
        SEED_ACTOR_ID
      );
      productIds.push(product.id);
    }

    const created = await inboundOrderService.createManual(
      { tenantId: clientId, warehouseId, items: items.map((it, idx) => ({ productId: productIds[idx], qtyExpected: it.qty })) },
      SEED_ACTOR_ID
    );

    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK' WHERE id = $1`, [created.order.id]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });

    await checkingService.startUnloading(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const checking = await checkingService.startChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);

    return { order: created.order, items: created.items, checking };
  }

  it('item sem divergência: 1ª contagem bate com o esperado -> CHECKED direto, sem recontagem', async () => {
    const { items, checking } = await bringOrderToChecking([{ sku: randomSku(), qty: 30 }]);

    const { item, divergence } = await checkingService.countFirstRound(checking.id, items[0].id, 30, conferente1.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(item.status).toBe('CHECKED');
    expect(Number(item.qty_received)).toBe(30);
    expect(divergence).toBeNull();
  });

  it('Conferência cega com divergência de FALTA: recontagem confirma, exceção bloqueia só o item + Falta aprovada ajusta a ordem (RF-REC-021/RN-REC-022/023)', async () => {
    const { items, checking } = await bringOrderToChecking([
      { sku: randomSku(), qty: 100, description: 'Item com falta' },
      { sku: randomSku(), qty: 5, description: 'Item sem divergência' },
    ]);
    const [faltaItem, okItem] = items;

    const orderIdResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT inbound_order_id FROM wms.inbound_order_item WHERE id = $1`,
      [faltaItem.id]
    );
    const orderId = orderIdResult.rows[0].inbound_order_id;

    const round1 = await checkingService.countFirstRound(checking.id, faltaItem.id, 90, conferente1.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(round1.item.status).toBe('RECOUNT_PENDING');
    expect(round1.divergence).toBeNull();

    // RN-REC-022: recontagem com o MESMO conferente é rejeitada (há outro elegível: conferente2).
    await expect(
      checkingService.recount(checking.id, faltaItem.id, 90, conferente1.id, clientId, warehouseId, SEED_ACTOR_ID)
    ).rejects.toMatchObject({ response: { error: 'RECOUNT_REQUIRES_DIFFERENT_CONFERENTE' } });

    const round2 = await checkingService.recount(checking.id, faltaItem.id, 90, conferente2.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(round2.item.status).toBe('RECOUNT_PENDING');
    expect(round2.divergence).not.toBeNull();
    expect(round2.divergence.discrepancy_type).toBe('FALTA');
    expect(Number(round2.divergence.qty)).toBe(10);

    // Exceção bloqueia só o item — o outro item da mesma Ordem segue livre para conferência.
    const okRound1 = await checkingService.countFirstRound(checking.id, okItem.id, 5, conferente1.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(okRound1.item.status).toBe('CHECKED');

    const orderResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT status FROM wms.inbound_order WHERE id = $1`,
      [orderId]
    );
    expect(orderResult.rows[0].status).toBe('DISCREPANCY_PENDING');

    // Falta aprovada ajusta a ordem: quantidade recebida = contado (90), resolution = ADJUSTED.
    const decided = await checkingService.decideDiscrepancy(round2.divergence.id, clientId, warehouseId, decisor.id, 'APPROVE', 'Falta confirmada, aprovado');
    expect(decided.discrepancy.status).toBe('RESOLVED');
    expect(decided.discrepancy.resolution).toBe('ADJUSTED');

    const finalItemResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.inbound_order_item WHERE id = $1`,
      [faltaItem.id]
    );
    expect(finalItemResult.rows[0].status).toBe('CHECKED');
    expect(Number(finalItemResult.rows[0].qty_received)).toBe(90);
  });

  it('Sobra recebida como bloqueada (RN-REC-023): destino RECEIVED_BLOCKED credita o total contado', async () => {
    const { items, checking } = await bringOrderToChecking([{ sku: randomSku(), qty: 50, description: 'Item com sobra' }]);
    const item = items[0];

    await checkingService.countFirstRound(checking.id, item.id, 60, conferente1.id, clientId, warehouseId, SEED_ACTOR_ID);
    const round2 = await checkingService.recount(checking.id, item.id, 60, conferente2.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(round2.divergence.discrepancy_type).toBe('SOBRA');
    expect(Number(round2.divergence.qty)).toBe(10);

    const decided = await checkingService.decideDiscrepancy(
      round2.divergence.id,
      clientId,
      warehouseId,
      decisor.id,
      'APPROVE',
      'Sobra aceita, bloqueada até regularização',
      'RECEIVED_BLOCKED'
    );
    expect(decided.discrepancy.resolution).toBe('RECEIVED_BLOCKED');

    const finalItemResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.inbound_order_item WHERE id = $1`,
      [item.id]
    );
    expect(finalItemResult.rows[0].status).toBe('CHECKED');
    expect(Number(finalItemResult.rows[0].qty_received)).toBe(60);
  });

  it('Avaria exige foto (RN-REC-022 [INVIOLÁVEL]): rejeita sem foto, aceita com foto', async () => {
    const { items, checking } = await bringOrderToChecking([{ sku: randomSku(), qty: 20, description: 'Item avariado' }]);
    const item = items[0];

    await expect(checkingService.registerAvaria(checking.id, item.id, 5, [], clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'CONSTRAINT_VIOLATION' },
    });

    const discrepancy = await checkingService.registerAvaria(checking.id, item.id, 5, ['discrepancy/foto1.jpg'], clientId, warehouseId, SEED_ACTOR_ID);
    expect(discrepancy.discrepancy_type).toBe('AVARIA');
    expect(discrepancy.photo_keys).toEqual(['discrepancy/foto1.jpg']);

    const decided = await checkingService.decideDiscrepancy(discrepancy.id, clientId, warehouseId, decisor.id, 'APPROVE', 'Avaria confirmada', 'RECEIVED_DAMAGED');
    expect(decided.discrepancy.resolution).toBe('RECEIVED_DAMAGED');
  });

  it('RF-REC-024: encerra a conferência quando todos os itens estão CHECKED e sem exceções pendentes', async () => {
    const { order, items, checking } = await bringOrderToChecking([{ sku: randomSku(), qty: 15 }]);
    await checkingService.countFirstRound(checking.id, items[0].id, 15, conferente1.id, clientId, warehouseId, SEED_ACTOR_ID);

    const closed = await checkingService.closeChecking(order.id, clientId, warehouseId, SEED_ACTOR_ID);
    expect(closed.status).toBe('CHECKED');

    const checkingResult = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID },
      `SELECT status FROM wms.checking WHERE id = $1`,
      [checking.id]
    );
    expect(checkingResult.rows[0].status).toBe('CLOSED');
  });

  it('RF-REC-024: rejeita encerramento com item ainda não contado', async () => {
    const { order } = await bringOrderToChecking([{ sku: randomSku(), qty: 10 }]);
    await expect(checkingService.closeChecking(order.id, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'ITEMS_NOT_ALL_CHECKED' },
    });
  });

  it('recontagem com único conferente elegível permite o mesmo, marcando forced_same_conferente', async () => {
    // Armazém/cliente dedicados com só 1 conferente elegível.
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const passwordService = new PasswordService(db);
    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);

    const soloWarehouse = await warehouseService.create(
      { code: randomWarehouseCode(), name: 'Armazém 1 conferente', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' },
      SEED_ACTOR_ID
    );
    const soloClient = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente 1 conferente', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    await settingsService.create(
      { tenant_id: soloClient.id, warehouse_id: soloWarehouse.id, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true },
      SEED_ACTOR_ID
    );
    const soloConferente = await createTestUser(db, passwordService);
    await assignRole(db, { userId: soloConferente.id, roleCode: 'CONFERENTE', warehouseId: soloWarehouse.id, clientId: soloClient.id });

    const product = await productService.create(
      { tenant_id: soloClient.id, sku: randomSku(), description: 'Item conferente único', species_code: 'GERAL', base_uom: 'UN' },
      SEED_ACTOR_ID
    );
    const created = await inboundOrderService.createManual(
      { tenantId: soloClient.id, warehouseId: soloWarehouse.id, items: [{ productId: product.id, qtyExpected: 40 }] },
      SEED_ACTOR_ID
    );
    await db.transaction({ tenant_id: soloClient.id, user_id: SEED_ACTOR_ID, warehouse_id: soloWarehouse.id }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK' WHERE id = $1`, [created.order.id]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });
    await checkingService.startUnloading(created.order.id, soloClient.id, soloWarehouse.id, SEED_ACTOR_ID);
    const checking = await checkingService.startChecking(created.order.id, soloClient.id, soloWarehouse.id, SEED_ACTOR_ID);

    await checkingService.countFirstRound(checking.id, created.items[0].id, 35, soloConferente.id, soloClient.id, soloWarehouse.id, SEED_ACTOR_ID);
    const round2 = await checkingService.recount(checking.id, created.items[0].id, 35, soloConferente.id, soloClient.id, soloWarehouse.id, SEED_ACTOR_ID);
    expect(round2.divergence).not.toBeNull();

    const checkingItemResult = await db.query(
      { tenant_id: soloClient.id, user_id: SEED_ACTOR_ID },
      `SELECT * FROM wms.checking_item WHERE checking_id = $1 AND round = 2`,
      [checking.id]
    );
    expect(checkingItemResult.rows[0].forced_same_conferente).toBe(true);
  });
});
