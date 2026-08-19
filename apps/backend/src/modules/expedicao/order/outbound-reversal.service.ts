// DOC-06 §4.8 — Estornos (RN-EXP-070 [INVIOLÁVEL]) e cancelamento (RN-EXP-071).
//
// RN-EXP-070 exige ATOMICIDADE: "desfazendo TODOS os efeitos da etapa
// estornada — nunca parcial". Por isso todo estorno roda numa única
// transação e o desfazer dos efeitos é delegado a um handler por etapa; se
// um handler falhar, a transação inteira volta atrás e o fluxo permanece
// exatamente como estava.
//
// Nesta sessão (6A) os handlers implementados são os das etapas cujos efeitos
// já EXISTEM no sistema: PEDIDO (liberação/reserva). Picking, embalagem,
// pesagem e carregamento têm o gancho pronto e recusam com [DEBITO: 6B]
// explícito em vez de fingir sucesso — um estorno que "passa" sem desfazer
// nada seria pior que a recusa.
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { OutboundFlowService } from './outbound-flow.service.js';
import {
  OutboundFlowStep,
  STEP_COMPLETION_STATUS,
  STEP_REVERSAL_EXCEPTION,
  cancellationWindow,
  isReversalForbidden,
  previousStep,
} from './outbound-flow.util.js';

export interface ReverseStepInput {
  orderId: string;
  tenantId: string;
  warehouseId: string;
  step: OutboundFlowStep;
  reason: string;
  /** Exceção EXIGIDA pela etapa (tabela §4.8), já APROVADA. */
  reversalExceptionId?: string | null;
  actorUserId: string;
}

export interface CancelOrderInput {
  orderId: string;
  tenantId: string;
  warehouseId: string;
  reason: string;
  /** RN-EXP-071: exceção EXP.CANCELAMENTO_TARDIO (2 passos) aprovada, no cancelamento tardio. */
  lateCancellationExceptionId?: string | null;
  actorUserId: string;
}

@Injectable()
export class OutboundReversalService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService,
    @Inject(OutboundFlowService) private readonly outboundFlowService: OutboundFlowService
  ) {}

  /** RN-EXP-070 [INVIOLÁVEL] — estorno de etapa, atômico. */
  async reverseStep(input: ReverseStepInput) {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };
    const order = await this.loadOrder(input.orderId, ctx);

    // "Estorno após gate-out é PROIBIDO — o retorno de mercadoria expedida é
    // Logística Reversa (DOC-07)". Verificado ANTES de qualquer outra coisa.
    if (isReversalForbidden(input.step, order.status)) {
      throw new ForbiddenException({
        error: 'REVERSAL_FORBIDDEN_AFTER_GATE_OUT',
        detail:
          `RN-EXP-070: estorno é PROIBIDO após a saída do veículo (etapa ${input.step}, pedido em ${order.status}) — ` +
          `o retorno de mercadoria expedida é tratado como Logística Reversa (DOC-07)`,
      });
    }

    const hasPermission = await this.rbacService.hasPermission(input.actorUserId, 'EXP.ESTORNO', { warehouseId: input.warehouseId, clientId: input.tenantId });
    if (!hasPermission) {
      throw new ForbiddenException({ error: 'REVERSAL_PERMISSION_REQUIRED', detail: 'RN-EXP-070: estorno exige a permissão EXP.ESTORNO' });
    }

    // Exceção exigida pela etapa (tabela §4.8) — quando exigida, precisa
    // estar APROVADA antes; aprovar depois não regulariza um estorno feito.
    const requiredException = STEP_REVERSAL_EXCEPTION[input.step];
    if (requiredException) {
      await this.assertApprovedException(ctx, input.reversalExceptionId, requiredException, input.warehouseId);
    }

    // A etapa PEDIDO não tem etapa anterior, mas TEM estado anterior: o
    // estorno da liberação devolve o pedido a DRAFT (a reserva é desfeita e
    // ele volta a ser liberável). É o caso mais comum de estorno e o único
    // integralmente reversível sem movimento físico.
    const target = previousStep(input.step);

    const result = await this.db.transaction(ctx, async (client) => {
      // Efeitos da etapa desfeitos ANTES de mexer no fluxo: se o handler
      // recusar (6B), nada do fluxo foi tocado.
      const undone = await this.undoStepEffects(client, input, order);

      // O pedido volta ao estado da etapa ANTERIOR (RN-EXP-070); na primeira
      // etapa, ao estado inicial do documento.
      const previousStatus = target === null ? 'DRAFT' : STEP_COMPLETION_STATUS[target];
      const updatedOrder = await this.outboundFlowService.revertStep(
        client,
        { tenantId: input.tenantId, warehouseId: input.warehouseId, orderId: input.orderId, step: input.step, previousStatus },
        input.actorUserId
      );

      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.estorno_executado',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { outbound_order_id: input.orderId, etapa: input.step, returned_to: target, order_status: previousStatus, ...undone },
      });

      return { order: updatedOrder, revertedStep: input.step, returnedTo: target, ...undone };
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'outbound_order',
      entityId: input.orderId,
      action: 'OVERRIDE',
      requirementId: 'DOC-06 RN-EXP-070',
      reason: input.reason,
      before: order,
      after: result.order,
    });

    return result;
  }

  /**
   * Handler por etapa. Cada um desfaz TODOS os efeitos da sua etapa ou
   * recusa — nunca desfaz pela metade (RN-EXP-070, atomicidade).
   */
  private async undoStepEffects(client: PoolClient, input: ReverseStepInput, order: any): Promise<Record<string, unknown>> {
    switch (input.step) {
      case 'PEDIDO':
        return this.undoRelease(client, input);
      case 'PICKING':
        return this.undoPicking(client, input);
      case 'EMBALAGEM':
        return this.undoEmbalagem(client, input);
      case 'PESAGEM':
        return this.undoPesagem(client, input);
      case 'EXPEDICAO':
        return this.undoExpedicao(client, input);
      case 'CARREGAMENTO':
        return this.undoCarregamento(client, input);

      default:
        throw new BadRequestException({ error: 'REVERSAL_NOT_SUPPORTED', detail: `RN-EXP-070: etapa ${input.step} não é estornável` });
    }
  }

  /**
   * RN-EXP-070 (tabela §4.8) — estorno de Picking: "retorno físico dirigido
   * dos itens aos endereços de origem (tarefas de devolução com dupla
   * leitura), reservas recompostas".
   *
   * [LACUNA: "tarefas de devolução com dupla leitura" implica um fluxo de
   * confirmação física em DOIS passos (like RF-EXP-031) antes do sistema
   * considerar o retorno efetivado — não modelado nesta sessão por escopo;
   * o estorno aqui é IMEDIATO e ATÔMICO (RN-EXP-070 exige a atomicidade, não
   * a confirmação física em si), com a mesma auditoria/exceção do restante
   * do motor. A confirmação física por leitura fica como débito de UX.]
   *
   * Reservas recompostas: tarefas DONE devolvem a reserva integral
   * (RESERVED, sem tocar saldo — nada foi debitado no picking, ver
   * cabeçalho de picking-task.service.ts); tarefas SHORT_REPORTED também
   * revertem o bloqueio do corte (DESBLOQUEIO + RESERVA, inverso EXATO de
   * LIBERACAO_RESERVA + BLOQUEIO usado no corte).
   */
  private async undoPicking(client: PoolClient, input: ReverseStepInput): Promise<Record<string, unknown>> {
    const tasksResult = await client.query(
      `SELECT * FROM wms.picking_task WHERE outbound_order_id = $1 AND status IN ('DONE', 'SHORT_REPORTED')`,
      [input.orderId]
    );

    let tasksReversed = 0;
    for (const task of tasksResult.rows) {
      if (Number(task.qty_short) > 0) {
        await this.stockMovementService.apply(client, {
          tenantId: input.tenantId,
          warehouseId: input.warehouseId,
          movementType: 'DESBLOQUEIO',
          productId: task.product_id,
          batchId: task.batch_id,
          qty: Number(task.qty_short),
          locationIdFrom: task.location_id_from,
          palletIdFrom: task.pallet_id_from,
          locationIdTo: task.location_id_from,
          palletIdTo: task.pallet_id_from,
          documentRefType: 'PICKING_TASK',
          documentRefId: task.id,
          actorUserId: input.actorUserId,
        });
        await this.stockMovementService.apply(client, {
          tenantId: input.tenantId,
          warehouseId: input.warehouseId,
          movementType: 'RESERVA',
          productId: task.product_id,
          batchId: task.batch_id,
          qty: Number(task.qty_short),
          locationIdFrom: task.location_id_from,
          palletIdFrom: task.pallet_id_from,
          locationIdTo: task.location_id_from,
          palletIdTo: task.pallet_id_from,
          documentRefType: 'PICKING_TASK',
          documentRefId: task.id,
          actorUserId: input.actorUserId,
        });
      }

      await client.query(
        `UPDATE wms.stock_reservation SET qty = $2, status = 'ACTIVE', updated_at = now(), updated_by = $3 WHERE id = $1`,
        [task.stock_reservation_id, task.qty_suggested, input.actorUserId]
      );
      await client.query(`UPDATE wms.picking_task SET status = 'REVERSED', updated_at = now(), updated_by = $2 WHERE id = $1`, [task.id, input.actorUserId]);
      tasksReversed += 1;
    }

    await client.query(
      `UPDATE wms.outbound_order_item SET qty_picked = 0, qty_short = 0, updated_at = now(), updated_by = $2 WHERE outbound_order_id = $1`,
      [input.orderId, input.actorUserId]
    );

    return { tasks_reversed: tasksReversed };
  }

  /** RN-EXP-070 — estorno de Embalagem: "volumes desfeitos (LPNs cancelados), conteúdo volta à consolidação". */
  private async undoEmbalagem(client: PoolClient, input: ReverseStepInput): Promise<Record<string, unknown>> {
    const result = await client.query(
      `UPDATE wms.package SET status = 'CANCELLED', updated_at = now(), updated_by = $2
       WHERE outbound_order_id = $1 AND status IN ('OPEN', 'CLOSED', 'WEIGHED')
       RETURNING id`,
      [input.orderId, input.actorUserId]
    );
    return { packages_cancelled: result.rows.length };
  }

  /** RN-EXP-070 — estorno de Pesagem (não exige exceção): "pesos invalidados, volumes voltam a pendente de pesagem". */
  private async undoPesagem(client: PoolClient, input: ReverseStepInput): Promise<Record<string, unknown>> {
    const result = await client.query(
      `UPDATE wms.package SET status = 'CLOSED', actual_weight_kg = NULL, weight_source = NULL, weight_reason_text = NULL,
              weighed_at = NULL, weight_exception_id = NULL, updated_at = now(), updated_by = $2
       WHERE outbound_order_id = $1 AND status IN ('WEIGHED', 'WEIGHT_DIVERGENT')
       RETURNING id`,
      [input.orderId, input.actorUserId]
    );
    return { packages_reset_to_closed: result.rows.length };
  }

  /**
   * RN-EXP-070 — estorno de Expedição: "aciona cancelamento fiscal no DOC-08
   * (dentro do prazo legal); volumes voltam ao staging". [LACUNA: DOC-08] o
   * cancelamento fiscal em si não existe nesta base — desfeito aqui apenas o
   * que o sistema realmente gravou (autorização/staging).
   */
  private async undoExpedicao(client: PoolClient, input: ReverseStepInput): Promise<Record<string, unknown>> {
    await client.query(
      `UPDATE wms.outbound_order SET fiscal_documents_authorized_at = NULL, updated_at = now(), updated_by = $2 WHERE id = $1`,
      [input.orderId, input.actorUserId]
    );
    const result = await client.query(
      `UPDATE wms.package SET staged_at = NULL, updated_at = now(), updated_by = $2 WHERE outbound_order_id = $1 AND staged_at IS NOT NULL RETURNING id`,
      [input.orderId, input.actorUserId]
    );
    return { packages_unstaged: result.rows.length, fiscal_cancellation: '[LACUNA: DOC-08]' };
  }

  /**
   * RN-EXP-070 — estorno de Carregamento: "volumes descarregados por
   * leitura, SAIDA_EXPEDICAO revertida". A reversão do débito puro
   * (RESERVED -> null) usa `AJUSTE_INVENTARIO_POS` com override para
   * RESERVED — é o ÚNICO tipo do catálogo fechado (RN-EST-001) com
   * `bucketFrom = null` e `bucketTo` livre por override, portanto o único
   * apto a CREDITAR de volta uma parcela sem uma origem (o débito original
   * não tinha destino, logo o estorno não tem origem).
   */
  private async undoCarregamento(client: PoolClient, input: ReverseStepInput): Promise<Record<string, unknown>> {
    const packagesResult = await client.query(`UPDATE wms.package SET status = 'WEIGHED', loaded_at = NULL, updated_at = now(), updated_by = $2 WHERE outbound_order_id = $1 AND status = 'LOADED' RETURNING id`, [
      input.orderId,
      input.actorUserId,
    ]);

    const reservationsResult = await client.query(
      `SELECT r.* FROM wms.stock_reservation r
       JOIN wms.outbound_order_item i ON i.id = r.demand_ref_id
       WHERE r.demand_ref_type = 'OUTBOUND_ORDER_ITEM' AND i.outbound_order_id = $1 AND r.status = 'CONSUMED'`,
      [input.orderId]
    );
    for (const reservation of reservationsResult.rows) {
      await this.stockMovementService.apply(client, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        movementType: 'AJUSTE_INVENTARIO_POS',
        productId: reservation.product_id,
        batchId: reservation.batch_id,
        qty: Number(reservation.qty),
        locationIdTo: reservation.location_id,
        palletIdTo: reservation.pallet_id,
        bucketToOverride: 'RESERVED',
        documentRefType: 'OUTBOUND_ORDER',
        documentRefId: input.orderId,
        actorUserId: input.actorUserId,
      });
      await client.query(`UPDATE wms.stock_reservation SET status = 'ACTIVE', updated_at = now(), updated_by = $2 WHERE id = $1`, [reservation.id, input.actorUserId]);
    }

    return { packages_unloaded: packagesResult.rows.length, shipment_reversed: reservationsResult.rows.length };
  }

  /**
   * Estorno da etapa "Pedido" — desfaz a LIBERAÇÃO: devolve todo o saldo
   * reservado (`LIBERACAO_RESERVA`, reserved → available, pelo serviço único
   * da 5A), encerra as reservas e zera o reservado dos itens.
   */
  private async undoRelease(client: PoolClient, input: ReverseStepInput): Promise<Record<string, unknown>> {
    const reservations = await client.query(
      `SELECT r.* FROM wms.stock_reservation r
       JOIN wms.outbound_order_item i ON i.id = r.demand_ref_id
       WHERE r.demand_ref_type = 'OUTBOUND_ORDER_ITEM' AND i.outbound_order_id = $1 AND r.status = 'ACTIVE'`,
      [input.orderId]
    );

    let qtyReleased = 0;
    for (const reservation of reservations.rows) {
      await this.stockMovementService.apply(client, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        movementType: 'LIBERACAO_RESERVA',
        productId: reservation.product_id,
        batchId: reservation.batch_id,
        qty: Number(reservation.qty),
        locationIdFrom: reservation.location_id,
        palletIdFrom: reservation.pallet_id,
        locationIdTo: reservation.location_id,
        palletIdTo: reservation.pallet_id,
        documentRefType: 'OUTBOUND_ORDER',
        documentRefId: input.orderId,
        actorUserId: input.actorUserId,
      });
      await client.query(`UPDATE wms.stock_reservation SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1`, [
        reservation.id,
        input.actorUserId,
      ]);
      qtyReleased += Number(reservation.qty);
    }

    await client.query(
      `UPDATE wms.outbound_order_item SET qty_reserved = 0, updated_at = now(), updated_by = $2 WHERE outbound_order_id = $1`,
      [input.orderId, input.actorUserId]
    );
    await client.query(
      `UPDATE wms.outbound_order SET reserved_at = NULL, released_at = NULL, reservation_expired = FALSE, updated_at = now(), updated_by = $2 WHERE id = $1`,
      [input.orderId, input.actorUserId]
    );

    return { reservations_cancelled: reservations.rows.length, qty_released: qtyReleased };
  }

  /**
   * RN-EXP-071 — cascata do cancelamento tardio: desfaz TODOS os efeitos já
   * aplicados (pesagem, embalagem, picking, reserva/liberação), na ordem
   * INVERSA à execução, sob a MESMA exceção EXP.CANCELAMENTO_TARDIO (não
   * exige uma EXP.ESTORNO_PICKING por etapa — a 2-passos já autoriza a
   * cascata inteira). Cada handler é um no-op seguro quando não há nada
   * daquela etapa a desfazer (ex.: pedido só em IN_PICKING não tem volume
   * algum, undoPesagem/undoEmbalagem só encontram 0 linhas).
   */
  private async undoCascade(client: PoolClient, input: ReverseStepInput): Promise<Record<string, unknown>> {
    const pesagem = await this.undoPesagem(client, input);
    const embalagem = await this.undoEmbalagem(client, input);
    const picking = await this.undoPicking(client, input);
    const release = await this.undoRelease(client, input);
    return { cascade: true, pesagem, embalagem, picking, release };
  }

  /** RN-EXP-071 — cancelamento, com a janela definida pelo estado do pedido. */
  async cancel(input: CancelOrderInput) {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };
    const order = await this.loadOrder(input.orderId, ctx);

    const hasPermission = await this.rbacService.hasPermission(input.actorUserId, 'EXP.PEDIDO_CANCELAR', { warehouseId: input.warehouseId, clientId: input.tenantId });
    if (!hasPermission) {
      throw new ForbiddenException({ error: 'CANCEL_PERMISSION_REQUIRED', detail: 'RN-EXP-071: cancelamento exige a permissão EXP.PEDIDO_CANCELAR' });
    }

    const window = cancellationWindow(order.status);
    if (window === 'FORBIDDEN') {
      throw new ForbiddenException({
        error: 'CANCEL_FORBIDDEN',
        detail:
          `RN-EXP-071: cancelamento é PROIBIDO com o pedido em ${order.status} — ` +
          `após a saída do veículo o caminho é a Logística Reversa (DOC-07)`,
      });
    }
    if (window === 'POST_FISCAL_REQUIRES_REVERSAL') {
      throw new ConflictException({
        error: 'CANCEL_REQUIRES_POST_FISCAL_REVERSAL',
        detail: `RN-EXP-071: com o pedido em ${order.status} (pós-emissão fiscal), o cancelamento exige antes o estorno pós-fiscal (EXP.ESTORNO_POS_FISCAL)`,
      });
    }
    if (window === 'LATE_REQUIRES_EXCEPTION') {
      // "Do picking iniciado até antes da emissão fiscal: exige
      // EXP.CANCELAMENTO_TARDIO (2 passos) e executa os estornos em cascata."
      await this.assertApprovedException(ctx, input.lateCancellationExceptionId, 'EXP.CANCELAMENTO_TARDIO', input.warehouseId);
    }

    // window === 'DIRECT' (DRAFT/RELEASED) ou 'LATE_REQUIRES_EXCEPTION'
    // (cascata, já autorizada acima pela EXP.CANCELAMENTO_TARDIO 2 passos).
    const result = await this.db.transaction(ctx, async (client) => {
      const undone =
        window === 'LATE_REQUIRES_EXCEPTION'
          ? await this.undoCascade(
              client,
              { orderId: input.orderId, tenantId: input.tenantId, warehouseId: input.warehouseId, step: 'PEDIDO', reason: input.reason, actorUserId: input.actorUserId }
            )
          : order.status === 'RELEASED'
            ? await this.undoRelease(
                client,
                { orderId: input.orderId, tenantId: input.tenantId, warehouseId: input.warehouseId, step: 'PEDIDO', reason: input.reason, actorUserId: input.actorUserId }
              )
            : { reservations_cancelled: 0, qty_released: 0 };

      const updated = await client.query(
        `UPDATE wms.outbound_order SET status = 'CANCELLED', cancelled_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [input.orderId, input.actorUserId]
      );

      const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'outbound_order' AND entity_id = $1`, [input.orderId]);
      if (flowResult.rows.length > 0) {
        await client.query(`UPDATE wms.operation_flow SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1`, [
          flowResult.rows[0].id,
          input.actorUserId,
        ]);
      }

      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.pedido_cancelado',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { outbound_order_id: input.orderId, number: order.number, previous_status: order.status, ...undone },
      });

      return { order: updated.rows[0], ...undone };
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'outbound_order',
      entityId: input.orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-06 RN-EXP-071',
      reason: input.reason,
      before: order,
      after: result.order,
    });

    return result;
  }

  /** A exceção exigida precisa existir, ser do tipo certo, do mesmo armazém e estar APROVADA. */
  private async assertApprovedException(ctx: TenantContext, exceptionId: string | null | undefined, expectedType: string, warehouseId: string): Promise<void> {
    if (!exceptionId) {
      throw new BadRequestException({
        error: 'REVERSAL_EXCEPTION_REQUIRED',
        detail: `RN-EXP-070/071: esta operação exige a exceção ${expectedType} APROVADA antes da execução`,
      });
    }
    const result = await this.db.query(ctx, `SELECT exception_type, status, warehouse_id FROM wms.operational_exception WHERE id = $1 AND tenant_id = $2`, [
      exceptionId,
      ctx.tenant_id,
    ]);
    const exception = result.rows[0];
    if (!exception) throw new NotFoundException(`operational_exception ${exceptionId} not found`);
    if (exception.exception_type !== expectedType) {
      throw new BadRequestException({
        error: 'WRONG_EXCEPTION_TYPE',
        detail: `RN-EXP-070/071: esperada exceção ${expectedType}, recebida ${exception.exception_type}`,
      });
    }
    if (exception.warehouse_id !== warehouseId) {
      throw new BadRequestException({ error: 'EXCEPTION_WAREHOUSE_MISMATCH', detail: 'A exceção pertence a outro armazém' });
    }
    if (exception.status !== 'APPROVED') {
      throw new ConflictException({
        error: 'EXCEPTION_NOT_APPROVED',
        detail: `RN-EXP-070/071: a exceção ${expectedType} precisa estar APROVADA ANTES da execução (status atual: ${exception.status})`,
      });
    }
  }

  private async loadOrder(orderId: string, ctx: TenantContext) {
    const result = await this.db.query(ctx, `SELECT * FROM wms.outbound_order WHERE id = $1`, [orderId]);
    const order = result.rows[0];
    if (!order) throw new NotFoundException(`outbound_order ${orderId} not found`);
    return order;
  }
}
