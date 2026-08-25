// DOC-00 RG-015 item 3 [INVIOLÁVEL] — transbordo do Armazém Lógico.
//
// Achado de revisão (2026-08-25): o tipo de exceção
// EST.TRANSBORDO_ARMAZEM_LOGICO (migration 0044) e a permissão
// EST.LOGICAL_WAREHOUSE_OVERFLOW (0016) existiam desde sempre, mas NENHUM
// código jamais abria a exceção — quando o Armazém Lógico do cliente lotava,
// o putaway reprovava todo endereço e a operação ficava SEM SAÍDA (palete
// parado, nenhuma exceção para alguém decidir). Estes testes travam o ciclo
// completo da regra e, principalmente, garantem que a abertura do transbordo
// NÃO enfraqueceu o item 2 (exclusividade sem override).
import { ConfigService } from '@nestjs/config';
import { setupIntegrationTest, teardownIntegrationTest, TestContext } from '../../../core/database/__tests__/test-setup.helper.js';
import { WarehouseService } from '../../cadastro/warehouse/warehouse.service.js';
import { ClientService } from '../../cadastro/client/client.service.js';
import { ClientWarehouseSettingsService } from '../../cadastro/client-warehouse-settings/client-warehouse-settings.service.js';
import { ProductService } from '../../cadastro/product/product.service.js';
import { ZoneService } from '../../cadastro/zone/zone.service.js';
import { BatchService } from '../../cadastro/batch/batch.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { LpnService } from '../../cadastro/lpn/lpn.service.js';
import { PalletService } from '../../cadastro/pallet/pallet.service.js';
import { LogicalWarehouseService } from '../../cadastro/logical-warehouse/logical-warehouse.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { InboundOrderService } from '../inbound-order/inbound-order.service.js';
import { CheckingService } from '../checking/checking.service.js';
import { LabelingService } from '../labeling/labeling.service.js';
import { PutawayEngineService } from '../putaway/putaway-engine.service.js';
import { PutawayTaskService } from '../putaway/putaway-task.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole } from '../../../core/__tests__/security-test-helpers.js';

describe('DOC-00 RG-015 item 3 — transbordo do Armazém Lógico', () => {
  let testContext: TestContext;
  let inboundOrderService: InboundOrderService;
  let checkingService: CheckingService;
  let labelingService: LabelingService;
  let taskService: PutawayTaskService;
  let exceptionService: OperationalExceptionService;
  let logicalWarehouseService: LogicalWarehouseService;
  let operationFlowService: OperationFlowService;
  let productService: ProductService;

  let clientId: string;
  let warehouseId: string;
  let dockId: string;
  let storageZoneId: string;
  /** Endereço DENTRO do armazém lógico do cliente. */
  let insideLocation: any;
  /** Endereço FORA de qualquer armazém lógico — só alcançável via transbordo. */
  let outsideLocation: any;
  /** RG-015 item 3: quem aprova o transbordo precisa de EST.LOGICAL_WAREHOUSE_OVERFLOW — só GESTOR_ARMAZEM tem (migration 0016). E exceção ESCALATED exige GESTOR_ARMAZEM por RN-SEG-021. */
  let gestor: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    exceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    operationFlowService = new OperationFlowService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    const fileStorageService = new FileStorageService(testContext.configService as ConfigService);
    fileStorageService.onModuleInit();
    const lpnService = new LpnService(documentNumberingService);
    const palletService = new PalletService(db, lpnService);
    const batchService = new BatchService(db, auditService);
    const engine = new PutawayEngineService(db);
    const stockMovementService = new StockMovementService(db);

    inboundOrderService = new InboundOrderService(db, eventsService, auditService, exceptionService, operationFlowService, fileStorageService, documentNumberingService);
    checkingService = new CheckingService(db, eventsService, auditService, exceptionService, operationFlowService);
    labelingService = new LabelingService(db, eventsService, auditService, palletService, batchService);
    taskService = new PutawayTaskService(db, eventsService, auditService, rbacService, operationFlowService, engine, stockMovementService, exceptionService);
    logicalWarehouseService = new LogicalWarehouseService(db, auditService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    const passwordService = new PasswordService(db);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém transbordo', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente com armazém lógico', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create({ tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FIFO', blind_checking: true }, SEED_ACTOR_ID);

    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await db.query(ctx, `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'REC.CRITERIOS_PUTAWAY', '["MENOR_NIVEL"]')`);
    // GS1_PREFIX próprio — ver nota em putaway-task.integration.spec.ts.
    await db.query(ctx, `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'GS1_PREFIX', '7420004', $1)`, [warehouseId]);

    const zone = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    storageZoneId = zone.id;
    insideLocation = await createLocation('A1', '001', '00', '01');
    outsideLocation = await createLocation('A1', '001', '01', '01');

    // Armazém Lógico do cliente com UM endereço vinculado (o "inside").
    const logical = await logicalWarehouseService.create({ tenant_id: clientId, warehouse_id: warehouseId, code: 'LW1', name: 'Área dedicada' }, SEED_ACTOR_ID);
    await logicalWarehouseService.link(logical.id, insideLocation.id, clientId, SEED_ACTOR_ID);

    const dockResult = await db.queryGlobal(`INSERT INTO wms.dock (warehouse_id, code, dock_type, has_leveler, status, created_by) VALUES ($1,'D1','BOTH',TRUE,'OCCUPIED',$2) RETURNING *`, [
      warehouseId,
      SEED_ACTOR_ID,
    ]);
    dockId = dockResult.rows[0].id;

    gestor = await createTestUser(db, passwordService);
    await assignRole(db, { userId: gestor.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  async function createLocation(aisle: string, module: string, level: string, slot: string) {
    const result = await testContext.databaseService.queryGlobal(
      `INSERT INTO wms.location (warehouse_id, zone_id, aisle, module, level, slot, location_type,
                                 max_weight_kg, max_volume_m3, max_pallets, max_height_m, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'STORAGE',5000,100,5,5,'ACTIVE',$7) RETURNING *`,
      [warehouseId, storageZoneId, aisle, module, level, slot, SEED_ACTOR_ID]
    );
    return result.rows[0];
  }

  /** Ordem manual -> conferência -> etiquetagem -> 1 tarefa de putaway CREATED. */
  async function createPutawayTask(qty = 10) {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto transbordo', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
      SEED_ACTOR_ID
    );
    const created = await inboundOrderService.createManual({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qtyExpected: qty }] }, SEED_ACTOR_ID);

    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.inbound_order SET status = 'AT_DOCK', dock_id = $2 WHERE id = $1`, [created.order.id, dockId]);
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [created.order.id]);
      await operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', SEED_ACTOR_ID);
    });
    await checkingService.startUnloading(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const checking = await checkingService.startChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await checkingService.countFirstRound(checking.id, created.items[0].id, qty, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID);
    await checkingService.closeChecking(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    await labelingService.startLabeling(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    const pallet = await labelingService.formPallet(created.order.id, clientId, warehouseId, 'PBR', [{ inboundOrderItemId: created.items[0].id, qty }], SEED_ACTOR_ID);

    const [task] = await taskService.generateTasksForOrder(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    return { task, pallet, product };
  }

  /** Desativa o endereço de dentro do armazém lógico = "sem capacidade disponível dentro" (RG-015 item 3). */
  async function fillLogicalWarehouse() {
    await testContext.databaseService.queryGlobal(`UPDATE wms.location SET status = 'INACTIVE' WHERE id = $1`, [insideLocation.id]);
  }
  async function freeLogicalWarehouse() {
    await testContext.databaseService.queryGlobal(`UPDATE wms.location SET status = 'ACTIVE' WHERE id = $1`, [insideLocation.id]);
  }

  it('caminho normal: havendo endereço DENTRO do armazém lógico, o motor usa ele e NÃO abre transbordo', async () => {
    await freeLogicalWarehouse();
    const { task } = await createPutawayTask(5);

    const assigned = await taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID);

    expect(assigned.suggestion.locationId).toBe(insideLocation.id);
    expect(assigned.isOverflow).toBe(false);
    expect(assigned.task.is_overflow).toBe(false);

    const exceptions = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT id FROM wms.operational_exception WHERE exception_type = 'EST.TRANSBORDO_ARMAZEM_LOGICO' AND entity_id = $1`,
      [task.id]
    );
    expect(exceptions.rows).toHaveLength(0);
  });

  it('RG-015 item 3: sem capacidade DENTRO do armazém lógico, a operação é bloqueada E a exceção de transbordo é ABERTA (não fica sem saída)', async () => {
    await fillLogicalWarehouse();
    const { task } = await createPutawayTask(5);

    await expect(taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'LOGICAL_WAREHOUSE_OVERFLOW' },
    });

    // A exceção precisa EXISTIR e estar aguardando decisão — este é o ponto
    // exato que faltava: antes, a operação morria sem nada para aprovar.
    const exceptions = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT id, status, entity, entity_id FROM wms.operational_exception WHERE exception_type = 'EST.TRANSBORDO_ARMAZEM_LOGICO' AND entity_id = $1`,
      [task.id]
    );
    expect(exceptions.rows).toHaveLength(1);
    expect(['PENDING', 'ESCALATED']).toContain(exceptions.rows[0].status);
    expect(exceptions.rows[0].entity).toBe('putaway_task');

    await freeLogicalWarehouse();
  });

  it('reenvio antes da aprovação NÃO empilha exceções duplicadas', async () => {
    await fillLogicalWarehouse();
    const { task } = await createPutawayTask(5);

    await expect(taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({ response: { error: 'LOGICAL_WAREHOUSE_OVERFLOW' } });
    await expect(taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({ response: { error: 'LOGICAL_WAREHOUSE_OVERFLOW' } });

    const exceptions = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT id FROM wms.operational_exception WHERE exception_type = 'EST.TRANSBORDO_ARMAZEM_LOGICO' AND entity_id = $1`,
      [task.id]
    );
    expect(exceptions.rows).toHaveLength(1);

    await freeLogicalWarehouse();
  });

  it('exceção NÃO aprovada não autoriza a alocação fora (RG-015 item 3)', async () => {
    await fillLogicalWarehouse();
    const { task } = await createPutawayTask(5);

    let exceptionId = '';
    await taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID).catch((e) => {
      exceptionId = e.response.exception_id;
    });
    expect(exceptionId).toBeTruthy();

    // Ainda PENDING — tentar usar já é rejeitado, ANTES de qualquer efeito.
    await expect(taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID, exceptionId)).rejects.toMatchObject({
      response: { error: 'OVERFLOW_NOT_APPROVED' },
    });

    const after = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT status, is_overflow, location_id_designated FROM wms.putaway_task WHERE id = $1`,
      [task.id]
    );
    expect(after.rows[0].status).toBe('CREATED');
    expect(after.rows[0].is_overflow).toBe(false);
    expect(after.rows[0].location_id_designated).toBeNull();

    await freeLogicalWarehouse();
  });

  it('exceção APROVADA autoriza a alocação temporária FORA do armazém lógico, marcada como TRANSBORDO', async () => {
    await fillLogicalWarehouse();
    const { task } = await createPutawayTask(5);

    let exceptionId = '';
    await taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID).catch((e) => {
      exceptionId = e.response.exception_id;
    });

    await exceptionService.decide(exceptionId, clientId, warehouseId, gestor.id, 'APPROVE', 'Armazém lógico lotado; transbordo autorizado com retorno assim que houver capacidade');

    const assigned = await taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID, exceptionId);

    // O endereço designado agora é o de FORA do armazém lógico.
    expect(assigned.suggestion.locationId).toBe(outsideLocation.id);
    expect(assigned.isOverflow).toBe(true);
    expect(assigned.task.is_overflow).toBe(true);
    expect(assigned.task.overflow_exception_id).toBe(exceptionId);

    // RG-003: transbordo é decisão autorizada — auditada como OVERRIDE com motivo.
    const audit = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT action, requirement_id, reason FROM wms.audit_log WHERE entity = 'putaway_task' AND entity_id = $1 AND action = 'OVERRIDE'`,
      [task.id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].requirement_id).toBe('DOC-00 RG-015 item 3');

    await freeLogicalWarehouse();
  });

  it('RG-015 item 2 [INVIOLÁVEL] permanece intacto: nem com transbordo aprovado o endereço vai para armazém lógico de OUTRO cliente', async () => {
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const clientService = new ClientService(db, auditService);

    // Segundo cliente, dono do armazém lógico que cobre o endereço "outside".
    const other = await clientService.create({ code: randomClientCode(), legal_name: 'Outro cliente', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    const otherLogical = await logicalWarehouseService.create({ tenant_id: other.id, warehouse_id: warehouseId, code: 'LW2', name: 'Área do outro' }, SEED_ACTOR_ID);
    await logicalWarehouseService.link(otherLogical.id, outsideLocation.id, other.id, SEED_ACTOR_ID);

    await fillLogicalWarehouse();
    const { task } = await createPutawayTask(5);

    // Agora NÃO há transbordo possível: o único endereço de fora pertence ao
    // armazém lógico de outro cliente, e essa exclusividade não admite
    // override nenhum. Logo, NÃO é caso de transbordo — é falta de endereço.
    await expect(taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'NO_LOCATION_APPROVED' },
    });

    const exceptions = await db.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT id FROM wms.operational_exception WHERE exception_type = 'EST.TRANSBORDO_ARMAZEM_LOGICO' AND entity_id = $1`,
      [task.id]
    );
    expect(exceptions.rows).toHaveLength(0);

    // Limpeza: devolve o endereço de fora ao armazém físico.
    await db.queryGlobal(`DELETE FROM wms.logical_warehouse_location WHERE location_id = $1`, [outsideLocation.id]);
    await freeLogicalWarehouse();
  });
});
