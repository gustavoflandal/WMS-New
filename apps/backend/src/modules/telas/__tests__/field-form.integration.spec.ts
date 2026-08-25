// DOC-17 §7/§10 (Sessão 10B) — Formulário de Campo, operação Putaway (T-P1).
// Cenários Gherkin cobertos: "Emissão de formulário reserva as tarefas" e
// "Cancelamento devolve as tarefas". Fluxo de origem (Ordem -> Conferência
// -> Etiquetagem -> tarefa CREATED) montado com os services REAIS, mesmo
// padrão de putaway-task.integration.spec.ts.
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
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { InboundOrderService } from '../../recebimento/inbound-order/inbound-order.service.js';
import { CheckingService } from '../../recebimento/checking/checking.service.js';
import { LabelingService } from '../../recebimento/labeling/labeling.service.js';
import { PutawayEngineService } from '../../recebimento/putaway/putaway-engine.service.js';
import { PutawayTaskService } from '../../recebimento/putaway/putaway-task.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { FieldFormService } from '../field-form/field-form.service.js';
import { FieldFormPdfService } from '../field-form/field-form-pdf.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';

describe('DOC-17 §7/§10 — Sessão 10B: Formulário de Campo (Putaway)', () => {
  let testContext: TestContext;
  let inboundOrderService: InboundOrderService;
  let checkingService: CheckingService;
  let labelingService: LabelingService;
  let taskService: PutawayTaskService;
  let fieldFormService: FieldFormService;
  let fileStorageService: FileStorageService;
  let operationFlowService: OperationFlowService;
  let productService: ProductService;
  let zoneService: ZoneService;

  let clientId: string;
  let warehouseId: string;
  let dockId: string;
  let storageZoneId: string;

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const operationalExceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    operationFlowService = new OperationFlowService(db);
    const documentNumberingService = new DocumentNumberingService(db);
    fileStorageService = new FileStorageService(testContext.configService as ConfigService);
    fileStorageService.onModuleInit();
    const lpnService = new LpnService(documentNumberingService);
    const palletService = new PalletService(db, lpnService);
    const batchService = new BatchService(db, auditService);
    const engine = new PutawayEngineService(db);
    const stockMovementService = new StockMovementService(db);
    const rbacService = new RbacService(db);

    inboundOrderService = new InboundOrderService(db, eventsService, auditService, operationalExceptionService, operationFlowService, fileStorageService, documentNumberingService);
    checkingService = new CheckingService(db, eventsService, auditService, operationalExceptionService, operationFlowService);
    labelingService = new LabelingService(db, eventsService, auditService, palletService, batchService);
    taskService = new PutawayTaskService(db, eventsService, auditService, rbacService, operationFlowService, engine, stockMovementService, operationalExceptionService);
    const fieldFormPdfService = new FieldFormPdfService(fileStorageService);
    fieldFormService = new FieldFormService(db, auditService, documentNumberingService, taskService, engine, fieldFormPdfService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    zoneService = new ZoneService(db, auditService);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém formulário campo', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente formulário campo', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create({ tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'EMISSAO_PROPRIA', default_giro_policy: 'FIFO', blind_checking: true }, SEED_ACTOR_ID);

    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await db.query(ctx, `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'REC.CRITERIOS_PUTAWAY', '["MENOR_NIVEL"]')`);
    // GS1_PREFIX próprio: sem isso, LpnService usa o mesmo DEFAULT_GS1_PREFIX
    // ('2900000') de QUALQUER outro teste sem prefixo configurado, e dois
    // armazéns de teste diferentes gerando LPN sequencial=1/2/3... com o
    // mesmo prefixo colidem no UNIQUE(lpn) global — mesmo cuidado já tomado
    // em crossdock/labeling/putaway-engine/putaway-task.integration.spec.ts
    // (débito DOC-02 documentado nesses arquivos: produção real precisaria
    // exigir GS1_PREFIX por armazém).
    await db.query(ctx, `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'GS1_PREFIX', '7420003', $1)`, [warehouseId]);

    const zone = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    storageZoneId = zone.id;
    await createLocation('A1', '001', '00', '01');
    await createLocation('A1', '001', '01', '01');
    await createLocation('A1', '001', '02', '01');
    await createLocation('A1', '001', '03', '01');
    await createLocation('A1', '001', '04', '01');

    const dockResult = await db.queryGlobal(`INSERT INTO wms.dock (warehouse_id, code, dock_type, has_leveler, status, created_by) VALUES ($1,'D1','BOTH',TRUE,'OCCUPIED',$2) RETURNING *`, [
      warehouseId,
      SEED_ACTOR_ID,
    ]);
    dockId = dockResult.rows[0].id;
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

  /** Ordem manual -> conferência -> etiquetagem -> 1 tarefa CREATED. */
  async function createPutawayTask(qty = 10) {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto formulário campo', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
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
    return { order: created.order, product, pallet, task };
  }

  it('Cenário: Emissão de formulário reserva as tarefas', async () => {
    const { task, pallet } = await createPutawayTask(10);

    const form = await fieldFormService.emitPutawayForm(
      { tenantId: clientId, warehouseId, taskIds: [task.id], declaredExecutorName: 'João Silva', declaredExecutorRegistration: 'MAT-001' },
      SEED_ACTOR_ID
    );

    expect(form.status).toBe('EMITIDO');
    expect(form.number).toMatch(/^FRM-/);
    expect(form.pdf_storage_key).toBeTruthy();

    // A tarefa fica EM_FORMULARIO (field_form_id setado) — some da fila.
    const queue = await taskService.listQueue(clientId, warehouseId, SEED_ACTOR_ID);
    expect(queue.find((t: any) => t.id === task.id)).toBeUndefined();

    // E não pode ser atribuída por outro canal (RN-TEL-021).
    await expect(taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID)).rejects.toMatchObject({ response: { error: 'TASK_RESERVED_BY_FIELD_FORM' } });

    // Conteúdo da linha (RF-TEL-022 Putaway): LPN, produto, endereço sugerido e alternativas.
    const lines = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, `SELECT * FROM wms.field_form_line WHERE field_form_id = $1`, [
      form.id,
    ]);
    expect(lines.rows).toHaveLength(1);
    expect(lines.rows[0].previsto.lpn).toBe(pallet.lpn);
    expect(lines.rows[0].previsto.endereco_sugerido).toBeTruthy();
    expect(Array.isArray(lines.rows[0].previsto.alternativas)).toBe(true);

    // PDF real gerado no storage (%PDF no início dos bytes).
    const pdfBytes = await fileStorageService.download(form.pdf_storage_key!);
    expect(pdfBytes.subarray(0, 4).toString('utf-8')).toBe('%PDF');
  });

  it('Cenário: Cancelamento devolve as tarefas à fila', async () => {
    const { task } = await createPutawayTask(5);
    const form = await fieldFormService.emitPutawayForm({ tenantId: clientId, warehouseId, taskIds: [task.id], declaredExecutorName: 'Maria Souza' }, SEED_ACTOR_ID);

    const cancelled = await fieldFormService.cancel({ tenantId: clientId, warehouseId, formId: form.id, reason: 'Formulário rasgado antes de sair para o campo' }, SEED_ACTOR_ID);
    expect(cancelled.status).toBe('CANCELADO');

    const queue = await taskService.listQueue(clientId, warehouseId, SEED_ACTOR_ID);
    expect(queue.find((t: any) => t.id === task.id)).toBeDefined();

    // Agora atribuível de novo por outro canal.
    const assigned = await taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID);
    expect(assigned.task.status).toBe('ASSIGNED');
  });

  it('cancelamento sem motivo é rejeitado (RF-TEL-024)', async () => {
    const { task } = await createPutawayTask(5);
    const form = await fieldFormService.emitPutawayForm({ tenantId: clientId, warehouseId, taskIds: [task.id], declaredExecutorName: 'Pedro' }, SEED_ACTOR_ID);
    await expect(fieldFormService.cancel({ tenantId: clientId, warehouseId, formId: form.id, reason: '' }, SEED_ACTOR_ID)).rejects.toMatchObject({ response: { error: 'REASON_REQUIRED' } });
  });

  it('Reemissão (RF-TEL-024): original vira SUBSTITUIDO, novo carrega marca RE1 e mantém a reserva da tarefa', async () => {
    const { task } = await createPutawayTask(8);
    const original = await fieldFormService.emitPutawayForm({ tenantId: clientId, warehouseId, taskIds: [task.id], declaredExecutorName: 'Ana' }, SEED_ACTOR_ID);

    const reissued = await fieldFormService.reissue({ tenantId: clientId, warehouseId, formId: original.id, reason: 'Formulário molhado na chuva' }, SEED_ACTOR_ID);
    expect(reissued.number).toBe(`${original.number}-RE1`);
    expect(reissued.reissue_seq).toBe(1);
    expect(reissued.replaces_form_id).toBe(original.id);

    const originalAfter = await fieldFormService.getForm(clientId, warehouseId, original.id, SEED_ACTOR_ID);
    expect(originalAfter.status).toBe('SUBSTITUIDO');

    // A tarefa segue reservada — agora para o novo formulário.
    const taskRow = await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, `SELECT field_form_id FROM wms.putaway_task WHERE id = $1`, [
      task.id,
    ]);
    expect(taskRow.rows[0].field_form_id).toBe(reissued.id);
  });

  it('Expiração (RN-TEL-021): formulário vencido é lido como EXPIRADO e libera a tarefa (verificação lazy)', async () => {
    const { task } = await createPutawayTask(3);
    const form = await fieldFormService.emitPutawayForm({ tenantId: clientId, warehouseId, taskIds: [task.id], declaredExecutorName: 'Carlos' }, SEED_ACTOR_ID);

    // Força o vencimento (sem esperar 12h de verdade).
    await testContext.databaseService.query({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, `UPDATE wms.field_form SET valid_until = now() - interval '1 hour' WHERE id = $1`, [
      form.id,
    ]);

    const reloaded = await fieldFormService.getForm(clientId, warehouseId, form.id, SEED_ACTOR_ID);
    expect(reloaded.status).toBe('EXPIRADO');

    const queue = await taskService.listQueue(clientId, warehouseId, SEED_ACTOR_ID);
    expect(queue.find((t: any) => t.id === task.id)).toBeDefined();
  });

  it('emissão sem tarefas é rejeitada', async () => {
    await expect(fieldFormService.emitPutawayForm({ tenantId: clientId, warehouseId, taskIds: [], declaredExecutorName: 'X' }, SEED_ACTOR_ID)).rejects.toMatchObject({ response: { error: 'NO_TASKS' } });
  });

  it('emissão de tarefa já reservada por outro formulário é rejeitada (RN-TEL-021)', async () => {
    const { task } = await createPutawayTask(4);
    await fieldFormService.emitPutawayForm({ tenantId: clientId, warehouseId, taskIds: [task.id], declaredExecutorName: 'Primeiro' }, SEED_ACTOR_ID);

    await expect(fieldFormService.emitPutawayForm({ tenantId: clientId, warehouseId, taskIds: [task.id], declaredExecutorName: 'Segundo' }, SEED_ACTOR_ID)).rejects.toMatchObject({
      response: { error: 'TASK_NOT_LOCKABLE' },
    });
  });
});
