// DOC-06 §4.2 — RG-002 / RN-EXP-011 [INVIOLÁVEL]: navegação do Fluxo
// Operacional sem salto de etapas. É o requisito que originou o projeto.
// Inclui os cenários Gherkin do §6 sobre navegação e violação via API, os
// estornos (RN-EXP-070) e o cancelamento (RN-EXP-071).
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
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
import { OutboundOrderService } from '../order/outbound-order.service.js';
import { OutboundFlowService } from '../order/outbound-flow.service.js';
import { OutboundReversalService } from '../order/outbound-reversal.service.js';
import { generateValidCnpj, randomWarehouseCode, randomClientCode, randomSku, rawAuthorizedQuery, SEED_ACTOR_ID } from '../../cadastro/__tests__/test-helpers.js';
import { createTestUser, assignRole, grantApprovalAuthority } from '../../../core/__tests__/security-test-helpers.js';

describe('Expedição - DOC-06 §4.2/§4.8 RG-002 navegação do fluxo, estornos e cancelamento', () => {
  let testContext: TestContext;
  let orderService: OutboundOrderService;
  let flowService: OutboundFlowService;
  let reversalService: OutboundReversalService;
  let exceptionService: OperationalExceptionService;
  let operationFlowService: OperationFlowService;
  let productService: ProductService;

  let clientId: string;
  let warehouseId: string;
  let storageZoneId: string;
  /** LIDER_TURNO — detém EXP.ESTORNO e EXP.PEDIDO_CANCELAR (migration 0050). */
  let lider: { id: string };
  /** OPERADOR_PICKING — NÃO detém EXP.ESTORNO. */
  let operador: { id: string };
  let aprovador: { id: string };
  /** RN-SEG-043: 2º aprovador, DISTINTO, para as exceções de 2 passos (§3). */
  let segundoAprovador: { id: string };

  beforeAll(async () => {
    testContext = await setupIntegrationTest();
    const db = testContext.databaseService;
    const auditService = new AuditService(db);
    const eventsService = new EventsService();
    const rbacService = new RbacService(db);
    operationFlowService = new OperationFlowService(db);
    const approvalAuthorityService = new ApprovalAuthorityService(db);
    exceptionService = new OperationalExceptionService(db, approvalAuthorityService, eventsService, auditService);
    const stockMovementService = new StockMovementService(db);
    const selectionService = new StockSelectionService(db);
    const reservationService = new StockReservationService(db, eventsService, auditService, rbacService, selectionService, stockMovementService);
    const documentNumberingService = new DocumentNumberingService(db);

    flowService = new OutboundFlowService(db, eventsService, operationFlowService);
    orderService = new OutboundOrderService(db, eventsService, auditService, documentNumberingService, selectionService, reservationService, flowService);
    reversalService = new OutboundReversalService(db, eventsService, auditService, rbacService, stockMovementService, flowService);

    const warehouseService = new WarehouseService(db, auditService);
    const clientService = new ClientService(db, auditService);
    const settingsService = new ClientWarehouseSettingsService(db, auditService);
    productService = new ProductService(db, auditService);
    const zoneService = new ZoneService(db, auditService);
    const passwordService = new PasswordService(db);

    const warehouse = await warehouseService.create({ code: randomWarehouseCode(), name: 'Armazém fluxo', cnpj: generateValidCnpj(), timezone: 'America/Sao_Paulo' }, SEED_ACTOR_ID);
    warehouseId = warehouse.id;
    const client = await clientService.create({ code: randomClientCode(), legal_name: 'Cliente fluxo', cnpj: generateValidCnpj() }, SEED_ACTOR_ID);
    clientId = client.id;
    await settingsService.create(
      { tenant_id: clientId, warehouse_id: warehouseId, fiscal_mode: 'INTEGRADO_ERP', default_giro_policy: 'FEFO', blind_checking: true },
      SEED_ACTOR_ID
    );
    storageZoneId = (await zoneService.create({ warehouse_id: warehouseId, code: 'STO', name: 'Armazenagem', zone_type: 'STORAGE' }, SEED_ACTOR_ID)).id;

    lider = await createTestUser(db, passwordService);
    operador = await createTestUser(db, passwordService);
    aprovador = await createTestUser(db, passwordService);
    segundoAprovador = await createTestUser(db, passwordService);
    await assignRole(db, { userId: lider.id, roleCode: 'LIDER_TURNO', warehouseId, clientId });
    await assignRole(db, { userId: operador.id, roleCode: 'OPERADOR_PICKING', warehouseId, clientId });
    await assignRole(db, { userId: aprovador.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    await assignRole(db, { userId: segundoAprovador.id, roleCode: 'GESTOR_ARMAZEM', warehouseId, clientId });
    await grantApprovalAuthority(db, { roleCode: 'GESTOR_ARMAZEM', exceptionType: 'EXP.ESTORNO_PICKING', warehouseId, maxQty: 100000 });
    await grantApprovalAuthority(db, { roleCode: 'GESTOR_ARMAZEM', exceptionType: 'EXP.CANCELAMENTO_TARDIO', warehouseId, maxQty: 100000 });
  });

  afterAll(async () => {
    await teardownIntegrationTest(testContext);
  });

  let locationSeq = 0;
  async function createReleasedOrder(qty = 40) {
    locationSeq += 1;
    const product = await productService.create(
      { tenant_id: clientId, sku: randomSku(), description: 'Produto fluxo', species_code: 'GERAL', base_uom: 'UN', gross_weight_kg: 1, length_m: 0.1, width_m: 0.1, height_m: 0.1, giro_policy: 'FEFO' },
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
      [clientId, warehouseId, product.id, location.rows[0].id, qty * 3, SEED_ACTOR_ID]
    );

    const created = await orderService.create({ tenantId: clientId, warehouseId, items: [{ productId: product.id, qty }], actorUserId: SEED_ACTOR_ID });
    await orderService.release(created.order.id, clientId, warehouseId, SEED_ACTOR_ID);
    return { orderId: created.order.id, productId: product.id, locationId: location.rows[0].id, itemId: created.items[0].id };
  }

  /**
   * Aprova a exceção até o estado terminal. EXP.ESTORNO_POS_FISCAL e
   * EXP.CANCELAMENTO_TARDIO são de 2 PASSOS (§3), e RN-SEG-043 exige
   * aprovadores DISTINTOS entre si — por isso o segundo passo usa outro
   * usuário.
   */
  async function approvedException(type: string, qty = 10) {
    const exception = await exceptionService.create({
      tenantId: clientId,
      exceptionType: type,
      warehouseId,
      entity: 'outbound_order',
      entityId: '00000000-0000-0000-0000-0000000000aa',
      qty,
      reasonRequest: 'Necessidade operacional',
      requestedBy: lider.id,
    });
    const first = await exceptionService.decide(exception.id, clientId, warehouseId, aprovador.id, 'APPROVE', 'Passo 1');
    if (first.status !== 'APPROVED') {
      await exceptionService.decide(exception.id, clientId, warehouseId, segundoAprovador.id, 'APPROVE', 'Passo 2');
    }
    return exception;
  }

  // ───────────────────────────────────────────────────────────────────────
  // §6 — "Navegação do fluxo sem salto" e "Violação de ordem via API"
  // ───────────────────────────────────────────────────────────────────────
  it('§6 RN-EXP-011: só a primeira etapa PENDING é acionável; as posteriores não', async () => {
    const { orderId } = await createReleasedOrder();

    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    const byCode = Object.fromEntries(state.steps.map((s: any) => [s.step_code, s]));

    // Pedido=verde (DONE), Picking=vermelha e ACIONÁVEL, as demais vermelhas e NÃO acionáveis.
    expect(byCode.PEDIDO.status).toBe('DONE');
    expect(byCode.PEDIDO.opens_read_only).toBe(true); // regra 4: DONE abre em consulta
    expect(byCode.PICKING.status).toBe('PENDING');
    expect(byCode.PICKING.is_actionable).toBe(true);
    expect(byCode.EMBALAGEM.is_actionable).toBe(false);
    expect(byCode.PESAGEM.is_actionable).toBe(false);
    // Exatamente UMA etapa acionável em todo o fluxo.
    expect(state.steps.filter((s: any) => s.is_actionable)).toHaveLength(1);
  });

  it('§6 RN-EXP-011 regra 3: chamada de API para etapa posterior devolve FLOW_STEP_ORDER_VIOLATION', async () => {
    const { orderId } = await createReleasedOrder();

    // Picking é a próxima; tentar PESAGEM (duas à frente) é violação de ordem.
    await expect(
      flowService.completeOrderStepStandalone({ tenantId: clientId, warehouseId, orderId, step: 'PESAGEM' }, SEED_ACTOR_ID)
    ).rejects.toMatchObject({ response: { error: 'FLOW_STEP_ORDER_VIOLATION' } });

    // Nem a imediatamente posterior à acionável passa.
    await expect(
      flowService.completeOrderStepStandalone({ tenantId: clientId, warehouseId, orderId, step: 'EMBALAGEM' }, SEED_ACTOR_ID)
    ).rejects.toMatchObject({ response: { error: 'FLOW_STEP_ORDER_VIOLATION' } });

    // A etapa correta conclui e o pedido assume o estado da tabela RN-EXP-010.
    const result = await flowService.completeOrderStepStandalone({ tenantId: clientId, warehouseId, orderId, step: 'PICKING' }, SEED_ACTOR_ID);
    expect(result.order.status).toBe('PICKED');

    // E agora EMBALAGEM é a acionável.
    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(state.steps.filter((s: any) => s.is_actionable).map((s: any) => s.step_code)).toEqual(['EMBALAGEM']);
  });

  it('RN-EXP-011 regra 5: exceção PENDENTE mantém a etapa vermelha, bloqueada, e impede concluir a seguinte', async () => {
    const { orderId } = await createReleasedOrder();

    // Exceção PENDENTE (não decidida) vinculada à etapa Picking.
    const pending = await exceptionService.create({
      tenantId: clientId,
      exceptionType: 'EXP.CORTE_PICKING',
      warehouseId,
      entity: 'outbound_order',
      entityId: orderId,
      qty: 5,
      reasonRequest: 'Corte durante o picking',
      requestedBy: lider.id,
    });

    const flowRow = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT id FROM wms.operation_flow WHERE entity = 'outbound_order' AND entity_id = $1`,
      [orderId]
    );
    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await operationFlowService.linkBlockingException(client, flowRow.rows[0].id, 'PICKING', pending.id, SEED_ACTOR_ID);
    });

    // Etapa segue PENDING, marcada como bloqueada e NÃO acionável.
    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    const picking = state.steps.find((s: any) => s.step_code === 'PICKING');
    expect(picking.status).toBe('PENDING');
    expect(picking.is_blocked).toBe(true);
    expect(picking.blocking_exception).toMatchObject({ id: pending.id, type: 'EXP.CORTE_PICKING' });
    // RN-EXP-011 regra 5 trata PENDING **e** ESCALATED igualmente. Sem alçada
    // configurada para EXP.CORTE_PICKING, RN-SEG-021 faz a exceção nascer
    // ESCALATED — e ela precisa bloquear do mesmo jeito.
    expect(['PENDING', 'ESCALATED']).toContain(picking.blocking_exception.status);
    expect(picking.is_actionable).toBe(false);
    // Nenhuma outra etapa "assume o lugar" — o fluxo trava aqui (RN-SEG-042).
    expect(state.steps.filter((s: any) => s.is_actionable)).toHaveLength(0);

    // E a etapa não conclui enquanto a exceção estiver pendente.
    await expect(
      flowService.completeOrderStepStandalone({ tenantId: clientId, warehouseId, orderId, step: 'PICKING' }, SEED_ACTOR_ID)
    ).rejects.toMatchObject({ response: { error: 'STEP_BLOCKED_BY_EXCEPTION' } });

    // Decidida a exceção e removido o vínculo, a etapa volta a ser acionável.
    await exceptionService.decide(pending.id, clientId, warehouseId, aprovador.id, 'APPROVE', 'Corte aprovado');
    await testContext.databaseService.transaction({ tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId }, async (client) => {
      await operationFlowService.clearBlockingException(client, flowRow.rows[0].id, 'PICKING', SEED_ACTOR_ID);
    });
    const after = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(after.steps.find((s: any) => s.step_code === 'PICKING').is_actionable).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-EXP-070 — estornos
  // ───────────────────────────────────────────────────────────────────────
  it('RN-EXP-070: estorno da liberação desfaz a reserva INTEGRALMENTE e devolve o pedido a DRAFT', async () => {
    const { orderId, productId, locationId } = await createReleasedOrder(40);

    const before = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_reserved FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId]
    );
    expect(Number(before.rows[0].qty_reserved)).toBe(40);

    const result = await reversalService.reverseStep({
      orderId,
      tenantId: clientId,
      warehouseId,
      step: 'PEDIDO',
      reason: 'Cliente desistiu',
      actorUserId: lider.id,
    });

    expect(result.returnedTo).toBeNull;
    expect(result.order.status).toBe('DRAFT');
    expect(result.reservations_cancelled).toBe(1);
    expect(result.qty_released).toBe(40);

    // Saldo integralmente devolvido a available (LIBERACAO_RESERVA).
    const after = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_available, qty_reserved FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId]
    );
    expect(Number(after.rows[0].qty_reserved)).toBe(0);
    expect(Number(after.rows[0].qty_available)).toBe(Number(before.rows[0].qty_available) + 40);

    // A etapa Pedido volta a PENDING e a ser a acionável.
    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(state.steps.find((s: any) => s.step_code === 'PEDIDO').status).toBe('PENDING');
    expect(state.steps.filter((s: any) => s.is_actionable).map((s: any) => s.step_code)).toEqual(['PEDIDO']);
  });

  it('RN-EXP-070: estorno exige a permissão EXP.ESTORNO', async () => {
    const { orderId } = await createReleasedOrder();
    await expect(
      reversalService.reverseStep({ orderId, tenantId: clientId, warehouseId, step: 'PEDIDO', reason: 'tentativa', actorUserId: operador.id })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('RN-EXP-070: etapa que exige exceção só estorna com ela APROVADA', async () => {
    const { orderId } = await createReleasedOrder();
    await flowService.completeOrderStepStandalone({ tenantId: clientId, warehouseId, orderId, step: 'PICKING' }, SEED_ACTOR_ID);

    // Sem exceção → recusado.
    await expect(
      reversalService.reverseStep({ orderId, tenantId: clientId, warehouseId, step: 'PICKING', reason: 'refazer', actorUserId: lider.id })
    ).rejects.toMatchObject({ response: { error: 'REVERSAL_EXCEPTION_REQUIRED' } });

    // Exceção PENDENTE → recusado.
    const pending = await exceptionService.create({
      tenantId: clientId,
      exceptionType: 'EXP.ESTORNO_PICKING',
      warehouseId,
      entity: 'outbound_order',
      entityId: orderId,
      qty: 1,
      reasonRequest: 'Estorno',
      requestedBy: lider.id,
    });
    await expect(
      reversalService.reverseStep({ orderId, tenantId: clientId, warehouseId, step: 'PICKING', reason: 'refazer', reversalExceptionId: pending.id, actorUserId: lider.id })
    ).rejects.toBeInstanceOf(ConflictException);

    // APROVADA → o handler da 6B desfaz de fato (sem tarefas reais criadas
    // por este teste — que nunca passou pela geração da 6B — o retorno é
    // zero tarefas revertidas, mas a etapa volta a PENDING normalmente).
    const approved = await approvedException('EXP.ESTORNO_PICKING');
    const reverted = await reversalService.reverseStep({
      orderId,
      tenantId: clientId,
      warehouseId,
      step: 'PICKING',
      reason: 'refazer',
      reversalExceptionId: approved.id,
      actorUserId: lider.id,
    });
    expect(reverted.order.status).toBe('RELEASED');
    expect(reverted.tasks_reversed).toBe(0);
  });

  it('§6 RN-EXP-070: estorno após GATE_OUT é PROIBIDO, orientando a Logística Reversa', async () => {
    const { orderId } = await createReleasedOrder();
    // Leva o pedido até GATE_OUT concluindo as etapas na ordem.
    for (const step of ['PICKING', 'EMBALAGEM', 'PESAGEM', 'EXPEDICAO', 'CARREGAMENTO', 'SAIDA'] as const) {
      await flowService.completeOrderStepStandalone({ tenantId: clientId, warehouseId, orderId, step }, SEED_ACTOR_ID);
    }

    const state = await flowService.getOrderFlowState(orderId, clientId, SEED_ACTOR_ID);
    expect(state.order.persisted_status).toBe('GATE_OUT');

    await expect(
      reversalService.reverseStep({ orderId, tenantId: clientId, warehouseId, step: 'CARREGAMENTO', reason: 'tentativa', actorUserId: lider.id })
    ).rejects.toMatchObject({ response: { error: 'REVERSAL_FORBIDDEN_AFTER_GATE_OUT' } });
  });

  // ───────────────────────────────────────────────────────────────────────
  // RN-EXP-071 — cancelamento
  // ───────────────────────────────────────────────────────────────────────
  it('RN-EXP-071: cancelamento direto em RELEASED libera as reservas', async () => {
    const { orderId, productId, locationId } = await createReleasedOrder(25);

    const result = await reversalService.cancel({ orderId, tenantId: clientId, warehouseId, reason: 'Cliente cancelou', actorUserId: lider.id });
    expect(result.order.status).toBe('CANCELLED');
    expect(result.qty_released).toBe(25);

    const balance = await testContext.databaseService.query(
      { tenant_id: clientId, user_id: SEED_ACTOR_ID, warehouse_id: warehouseId },
      `SELECT qty_reserved FROM wms.stock_balance WHERE product_id = $1 AND location_id = $2`,
      [productId, locationId]
    );
    expect(Number(balance.rows[0].qty_reserved)).toBe(0);
  });

  it('RN-EXP-071: cancelamento tardio (picking iniciado) exige EXP.CANCELAMENTO_TARDIO aprovada', async () => {
    const { orderId } = await createReleasedOrder();
    await flowService.completeOrderStepStandalone({ tenantId: clientId, warehouseId, orderId, step: 'PICKING' }, SEED_ACTOR_ID);

    // Sem a exceção → recusado (janela LATE_REQUIRES_EXCEPTION).
    await expect(
      reversalService.cancel({ orderId, tenantId: clientId, warehouseId, reason: 'tardio', actorUserId: lider.id })
    ).rejects.toMatchObject({ response: { error: 'REVERSAL_EXCEPTION_REQUIRED' } });

    // Com a exceção de 2 passos aprovada, a cascata da 6B executa de fato —
    // devolve reservas (nenhuma tarefa real neste teste, mas a reserva da
    // liberação existe e é desfeita integralmente).
    const approved = await approvedException('EXP.CANCELAMENTO_TARDIO');
    const result = await reversalService.cancel({
      orderId,
      tenantId: clientId,
      warehouseId,
      reason: 'tardio',
      lateCancellationExceptionId: approved.id,
      actorUserId: lider.id,
    });
    expect(result.order.status).toBe('CANCELLED');
    expect((result as any).release.qty_released).toBeGreaterThan(0);
  });

  it('RN-EXP-071: cancelamento após GATE_OUT é PROIBIDO', async () => {
    const { orderId } = await createReleasedOrder();
    for (const step of ['PICKING', 'EMBALAGEM', 'PESAGEM', 'EXPEDICAO', 'CARREGAMENTO', 'SAIDA'] as const) {
      await flowService.completeOrderStepStandalone({ tenantId: clientId, warehouseId, orderId, step }, SEED_ACTOR_ID);
    }

    await expect(
      reversalService.cancel({ orderId, tenantId: clientId, warehouseId, reason: 'tentativa', actorUserId: lider.id })
    ).rejects.toMatchObject({ response: { error: 'CANCEL_FORBIDDEN' } });
  });
});
