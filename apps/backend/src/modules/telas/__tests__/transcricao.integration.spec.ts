// DOC-17 §8/§10 (Sessão 10D) — Transcrição de Formulário de Campo.
// Cenários Gherkin cobertos: "Transcrição é idempotente", "Linha de tarefa
// já concluída por outro canal é descartada" e "Segregação na transcrição".
//
// O ponto central destes testes é a PARIDADE (RN-TEL-011): a transcrição não
// tem caminho de efeito próprio — ela chama o mesmo executeTask do coletor.
// Por isso os testes conferem o efeito REAL (saldo creditado, movimentação
// única), não apenas o status da linha.
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
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { ApprovalAuthorityService } from '../../../core/workflow/approval-authority.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { InboundOrderService } from '../../recebimento/inbound-order/inbound-order.service.js';
import { CheckingService } from '../../recebimento/checking/checking.service.js';
import { LabelingService } from '../../recebimento/labeling/labeling.service.js';
import { PutawayEngineService } from '../../recebimento/putaway/putaway-engine.service.js';
import { PutawayTaskService } from '../../recebimento/putaway/putaway-task.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { FieldFormService } from '../field-form/field-form.service.js';
import { FieldFormPdfService } from '../field-form/field-form-pdf.service.js';
import { TranscriptionService } from '../transcription/transcription.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole } from '../../../core/__tests__/security-test-helpers.js';
import { v4 as uuid } from 'uuid';

describe('DOC-17 §8/§10 — Sessão 10D: Transcrição de Formulário de Campo', () => {
  let testContext: TestContext;
  let inboundOrderService: InboundOrderService;
  let checkingService: CheckingService;
  let labelingService: LabelingService;
  let taskService: PutawayTaskService;
  let fieldFormService: FieldFormService;
  let transcriptionService: TranscriptionService;
  let operationFlowService: OperationFlowService;
  let productService: ProductService;

  let clientId: string;
  let warehouseId: string;
  let dockId: string;
  let storageZoneId: string;
  let locationA: any;
  /** Digitador — tem TEL.TRANSCREVER (LIDER_TURNO), não é o executante. */
  let digitador: { id: string };
  /** Gestor — único com TEL.TRANSCREVER_PROPRIO (migration 0078). */
  let gestor: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    const exceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
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
    fieldFormService = new FieldFormService(db, auditService, documentNumberingService, taskService, engine, new FieldFormPdfService(fileStorageService));
    transcriptionService = new TranscriptionService(db, auditService, rbacService, exceptionService, taskService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    const passwordService = new PasswordService(db);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém transcrição', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente transcrição', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create({ tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FIFO', blind_checking: true }, SEED_ACTOR_ID);

    const ctx = { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId };
    await db.query(ctx, `INSERT INTO wms.app_parameter (scope, name, value) VALUES ('GLOBAL', 'REC.CRITERIOS_PUTAWAY', '["MENOR_NIVEL"]')`);
    // GS1_PREFIX próprio — ver nota em putaway-task.integration.spec.ts.
    await db.query(ctx, `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id) VALUES ('WAREHOUSE', 'GS1_PREFIX', '7420005', $1)`, [warehouseId]);

    const zone = await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID);
    storageZoneId = zone.id;
    locationA = await createLocation('A1', '001', '00', '01');
    await createLocation('A1', '001', '01', '01');
    await createLocation('A1', '001', '02', '01');

    const dockResult = await db.queryGlobal(`INSERT INTO wms.dock (warehouse_id, code, dock_type, has_leveler, status, created_by) VALUES ($1,'D1','BOTH',TRUE,'OCCUPIED',$2) RETURNING *`, [
      warehouseId,
      SEED_ACTOR_ID,
    ]);
    dockId = dockResult.rows[0].id;

    digitador = await createTestUser(db, passwordService);
    gestor = await createTestUser(db, passwordService);
    await assignRole(db, { userId: digitador.id, roleCode: 'LIDER_TURNO', warehouseId, clientId });
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

  async function createPutawayTask(qty = 10) {
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto transcrição', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1 },
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

  /** Emite um formulário de putaway para a tarefa e devolve o formulário. */
  async function emitForm(taskId: string, executorUserId?: string) {
    const form = await fieldFormService.emitPutawayForm(
      { tenantId: clientId, warehouseId, taskIds: [taskId], declaredExecutorName: 'Operador de Campo', declaredExecutorRegistration: 'MAT-77' },
      SEED_ACTOR_ID
    );
    if (executorUserId) {
      await testContext.databaseService.query(
        { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
        `UPDATE wms.field_form SET declared_executor_user_id = $2 WHERE id = $1`,
        [form.id, executorUserId]
      );
    }
    return form;
  }

  it('caminho feliz: transcrição aplica a linha pelo MESMO serviço de domínio do coletor (RN-TEL-011) e credita saldo', async () => {
    const { task, pallet, product } = await createPutawayTask(10);
    const form = await emitForm(task.id);

    const result = await transcriptionService.transcribe(
      { tenantId: clientId, warehouseId, fieldFormId: form.id, lines: [{ lineNumber: 1, scannedLpn: pallet.lpn, scannedLocationCode: locationA.code }] },
      digitador.id
    );

    expect(result.idempotentReplay).toBe(false);
    expect(result.formStatus).toBe('TRANSCRITO');
    expect(result.lines).toEqual([{ lineNumber: 1, status: 'APLICADA' }]);

    // Efeito REAL: saldo creditado pelo serviço único de movimentação.
    const balance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available FROM wms.stock_balance WHERE location_id = $1 AND product_id = $2`,
      [locationA.id, product.id]
    );
    expect(Number(balance.rows[0].qty_available)).toBe(10);

    // RN-TEL-012 item 3: a movimentação nasceu com origem PAPEL.
    const audit = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT origin FROM wms.audit_log WHERE entity = 'putaway_task' AND entity_id = $1 AND action = 'MOVE'`,
      [task.id]
    );
    expect(audit.rows[0].origin).toBe('PAPEL');
  });

  it('Cenário §10: Transcrição é idempotente — reenvio devolve o resultado original, sem efeito adicional', async () => {
    const { task, pallet, product } = await createPutawayTask(7);
    const form = await emitForm(task.id);
    const lines = [{ lineNumber: 1, scannedLpn: pallet.lpn, scannedLocationCode: locationA.code }];

    const first = await transcriptionService.transcribe({ tenantId: clientId, warehouseId, fieldFormId: form.id, lines }, digitador.id);
    const replay = await transcriptionService.transcribe({ tenantId: clientId, warehouseId, fieldFormId: form.id, lines }, digitador.id);

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transcriptionId).toBe(first.transcriptionId);
    // "exibindo quando e por quem foi transcrito"
    expect(replay.transcribedBy).toBe(digitador.id);
    expect(replay.transcribedAt).toBeTruthy();
    expect(replay.lines).toEqual(first.lines);

    // "nenhuma movimentação adicional deve ocorrer"
    const movements = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT COUNT(*) AS n FROM wms.stock_movement WHERE task_id = $1`,
      [task.id]
    );
    expect(Number(movements.rows[0].n)).toBe(1);

    const balance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available FROM wms.stock_balance WHERE location_id = $1 AND product_id = $2`,
      [locationA.id, product.id]
    );
    expect(Number(balance.rows[0].qty_available)).toBe(7);
  });

  it('Cenário §10: linha de tarefa já concluída por outro canal é DESCARTADA_DUPLICIDADE, sem segundo efeito', async () => {
    const { task, pallet, product } = await createPutawayTask(4);
    const form = await emitForm(task.id);

    // O operador conclui a MESMA tarefa pelo coletor antes de o papel voltar.
    await taskService.assignTask(task.id, SEED_ACTOR_ID, clientId, warehouseId, SEED_ACTOR_ID, null, form.id);
    await taskService.executeTask(task.id, { operationId: uuid(), scannedLpn: pallet.lpn, scannedLocationCode: locationA.code }, clientId, warehouseId, SEED_ACTOR_ID);

    const balanceBefore = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available FROM wms.stock_balance WHERE location_id = $1 AND product_id = $2`,
      [locationA.id, product.id]
    );

    const result = await transcriptionService.transcribe(
      { tenantId: clientId, warehouseId, fieldFormId: form.id, lines: [{ lineNumber: 1, scannedLpn: pallet.lpn, scannedLocationCode: locationA.code }] },
      digitador.id
    );

    expect(result.lines[0].status).toBe('DESCARTADA_DUPLICIDADE');

    // "o saldo não deve sofrer segundo efeito"
    const balanceAfter = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available FROM wms.stock_balance WHERE location_id = $1 AND product_id = $2`,
      [locationA.id, product.id]
    );
    expect(Number(balanceAfter.rows[0].qty_available)).toBe(Number(balanceBefore.rows[0].qty_available));
  });

  it('Cenário §10: Segregação — o executante NÃO pode transcrever a si mesmo sem TEL.TRANSCREVER_PROPRIO', async () => {
    const { task } = await createPutawayTask(5);
    // O formulário declara o DIGITADOR como executante; ele tem
    // TEL.TRANSCREVER (LIDER_TURNO) mas NÃO tem TRANSCREVER_PROPRIO.
    const form = await emitForm(task.id, digitador.id);

    await expect(
      transcriptionService.transcribe({ tenantId: clientId, warehouseId, fieldFormId: form.id, lines: [{ lineNumber: 1, notFilled: true }] }, digitador.id)
    ).rejects.toMatchObject({ response: { error: 'SEGREGATION_VIOLATION' } });

    // Nada foi gravado.
    const transcriptions = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT id FROM wms.form_transcription WHERE field_form_id = $1`,
      [form.id]
    );
    expect(transcriptions.rows).toHaveLength(0);
  });

  it('Segregação: COM TEL.TRANSCREVER_PROPRIO ainda exige a exceção TEL.SEGREGACAO_TRANSCRICAO registrada', async () => {
    const { task } = await createPutawayTask(5);
    // Formulário executado pelo GESTOR, que tem TRANSCREVER_PROPRIO.
    const form = await emitForm(task.id, gestor.id);

    await expect(
      transcriptionService.transcribe({ tenantId: clientId, warehouseId, fieldFormId: form.id, lines: [{ lineNumber: 1, notFilled: true }] }, gestor.id)
    ).rejects.toMatchObject({ response: { error: 'SEGREGATION_EXCEPTION_REQUIRED' } });
  });

  it('transcrição por OUTRA pessoa que não o executante passa direto pela segregação', async () => {
    const { task, pallet } = await createPutawayTask(6);
    const form = await emitForm(task.id, gestor.id); // executante = gestor

    // Digitador != executante -> sem segregação a aferir.
    const result = await transcriptionService.transcribe(
      { tenantId: clientId, warehouseId, fieldFormId: form.id, lines: [{ lineNumber: 1, scannedLpn: pallet.lpn, scannedLocationCode: locationA.code }] },
      digitador.id
    );
    expect(result.lines[0].status).toBe('APLICADA');
  });

  it('RN-TEL-031 item 4: linha não preenchida fica NAO_PREENCHIDA e o formulário fica PARCIALMENTE_TRANSCRITO', async () => {
    const { task } = await createPutawayTask(5);
    const form = await emitForm(task.id);

    const result = await transcriptionService.transcribe({ tenantId: clientId, warehouseId, fieldFormId: form.id, lines: [{ lineNumber: 1, notFilled: true }] }, digitador.id);

    expect(result.lines[0].status).toBe('NAO_PREENCHIDA');
    expect(result.formStatus).toBe('PARCIALMENTE_TRANSCRITO');

    // A tarefa continua pendente — nada foi executado.
    const taskRow = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT status FROM wms.putaway_task WHERE id = $1`,
      [task.id]
    );
    expect(taskRow.rows[0].status).toBe('CREATED');
  });

  it('RN-TEL-033: divergência reprovada pelo módulo de origem vira REJEITADA_REGRA — nunca aplicada pela metade', async () => {
    const { task, pallet, product } = await createPutawayTask(5);
    const form = await emitForm(task.id);

    // Endereço diferente do sugerido, SEM motivo de override: o domínio
    // (RN-REC-041) rejeita, e a transcrição não afrouxa nada.
    const outro = await createLocation('B9', '001', '00', '01');
    const result = await transcriptionService.transcribe(
      { tenantId: clientId, warehouseId, fieldFormId: form.id, lines: [{ lineNumber: 1, scannedLpn: pallet.lpn, scannedLocationCode: outro.code }] },
      digitador.id
    );

    expect(result.lines[0].status).toBe('REJEITADA_REGRA');
    // O motivo vem do domínio, não é reinterpretado aqui.
    expect(result.lines[0].detail).toBeTruthy();

    const movements = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT COUNT(*) AS n FROM wms.stock_movement WHERE task_id = $1`,
      [task.id]
    );
    expect(Number(movements.rows[0].n)).toBe(0);
  });

  it('RN-TEL-033: formulário fora da validade abre TEL.FORMULARIO_EXPIRADO e bloqueia até aprovação', async () => {
    const { task, pallet } = await createPutawayTask(5);
    const form = await emitForm(task.id);

    await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `UPDATE wms.field_form SET valid_until = now() - interval '1 hour' WHERE id = $1`,
      [form.id]
    );

    let exceptionId = '';
    await transcriptionService
      .transcribe({ tenantId: clientId, warehouseId, fieldFormId: form.id, lines: [{ lineNumber: 1, scannedLpn: pallet.lpn, scannedLocationCode: locationA.code }] }, digitador.id)
      .catch((e) => {
        expect(e.response.error).toBe('FORM_EXPIRED');
        exceptionId = e.response.exception_id;
      });

    expect(exceptionId).toBeTruthy();
    const exception = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT exception_type, status FROM wms.operational_exception WHERE id = $1`,
      [exceptionId]
    );
    expect(exception.rows[0].exception_type).toBe('TEL.FORMULARIO_EXPIRADO');
    expect(['PENDING', 'ESCALATED']).toContain(exception.rows[0].status);
  });

  it('RF-TEL-030: localiza o formulário pelo número impresso (é o que o digitador tem em mãos)', async () => {
    const { task } = await createPutawayTask(5);
    const form = await emitForm(task.id);

    const found = await transcriptionService.findByNumber(form.number, clientId, warehouseId, digitador.id);
    expect(found.form.id).toBe(form.id);
    expect(found.lines).toHaveLength(1);
    expect(found.lines[0].previsto.lpn).toBeTruthy();
  });
});
