// DOC-06 §4.4 — Picking: geração de tarefas (RF-EXP-030), execução com dupla
// leitura (RF-EXP-031), corte/short (RN-EXP-032 [INVIOLÁVEL]) e conclusão da
// etapa (RN-EXP-033).
//
// DESIGN — nenhuma movimentação de saldo ocorre aqui: a reserva (RN-EST-001
// RESERVA, efetivada na liberação, 6A) permanece intacta até RF-EXP-061
// (carregamento), que é onde RF-EXP-061 diz literalmente que a baixa
// definitiva (SAIDA_EXPEDICAO) acontece. Ver cabeçalho da migration 0051
// para a justificativa completa (o catálogo fechado RN-EST-001 teria a MESMA
// reserva debitada duas vezes se PICKING também movimentasse saldo).
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { StockReservationService } from '../../estoque/selection/stock-reservation.service.js';
import { OutboundFlowService } from '../order/outbound-flow.service.js';
import { isFirstPendingStep } from '../order/flow-step-guard.util.js';
import { assignRouteSequence, sortByPickingRoute, RouteCoordinates } from './picking-route.util.js';

export interface GenerateTasksInput {
  tenantId: string;
  warehouseId: string;
  waveId: string | null;
  orderIds: string[];
}

export interface ExecutePickingTaskInput {
  operationId: string;
  scannedLocationCode: string;
  /** Leitura 2: LPN do palete OU EAN/código de barras do produto. */
  scannedProductCode: string;
  qtyConfirmed: number;
  reasonCode?: string | null;
  reasonText?: string | null;
  weightKg?: number | null;
  weightSource?: 'SCALE' | 'MANUAL' | null;
}

@Injectable()
export class PickingTaskService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (padrão de todo o módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService,
    @Inject(StockReservationService) private readonly stockReservationService: StockReservationService,
    @Inject(OutboundFlowService) private readonly outboundFlowService: OutboundFlowService
  ) {}

  /**
   * RF-EXP-030 — gera as tarefas de picking a partir das reservas ATIVAS dos
   * pedidos informados (na ordem dada — a ordem de entrada da onda, RF-EXP-020),
   * roteirizadas em CONJUNTO (mais eficiente fisicamente que rotear pedido a
   * pedido isoladamente — a regra do §4.4 não distingue). Chamado DENTRO da
   * transação de quem libera (WaveService.release / releaseImplicit).
   */
  async generateForOrders(client: PoolClient, input: GenerateTasksInput, actorUserId: string): Promise<{ tasksCreated: number }> {
    if (input.orderIds.length === 0) return { tasksCreated: 0 };

    const packingLocation = await this.resolvePackingConsolidationLocation(client, input.warehouseId);

    const reservationsResult = await client.query(
      `SELECT r.id AS reservation_id, r.product_id, r.batch_id, r.location_id, r.pallet_id, r.qty,
              i.id AS item_id, i.outbound_order_id,
              l.code AS location_code, l.aisle, l.module AS module_code, l.level, z.code AS zone_code
       FROM wms.stock_reservation r
       JOIN wms.outbound_order_item i ON i.id = r.demand_ref_id
       JOIN wms.location l ON l.id = r.location_id
       JOIN wms.zone z ON z.id = l.zone_id
       WHERE r.demand_ref_type = 'OUTBOUND_ORDER_ITEM'
         AND r.status = 'ACTIVE'
         AND i.outbound_order_id = ANY($1::uuid[])
         AND i.moved_to_order_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM wms.picking_task pt
           WHERE pt.stock_reservation_id = r.id AND pt.status NOT IN ('CANCELLED', 'REVERSED')
         )
       ORDER BY array_position($1::uuid[], i.outbound_order_id), i.line_number`,
      [input.orderIds]
    );

    if (reservationsResult.rows.length === 0) return { tasksCreated: 0 };

    const sorted = sortByPickingRoute(reservationsResult.rows, (row): RouteCoordinates => ({
      zoneCode: row.zone_code,
      aisle: row.aisle,
      moduleCode: row.module_code,
      level: row.level,
    }));
    const withSequence = assignRouteSequence(sorted);

    for (const { item: row, routeSequence } of withSequence) {
      await client.query(
        `INSERT INTO wms.picking_task (
           tenant_id, warehouse_id, outbound_order_id, outbound_order_item_id, stock_reservation_id, wave_id,
           product_id, batch_id, location_id_from, pallet_id_from, location_id_to, route_sequence,
           qty_suggested, status, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CREATED',$14)`,
        [
          input.tenantId,
          input.warehouseId,
          row.outbound_order_id,
          row.item_id,
          row.reservation_id,
          input.waveId,
          row.product_id,
          row.batch_id,
          row.location_id,
          row.pallet_id,
          packingLocation.id,
          routeSequence,
          row.qty,
          actorUserId,
        ]
      );
    }

    return { tasksCreated: withSequence.length };
  }

  /** RF-EXP-031: posição de consolidação em zona PACKING — a MESMA para todo o armazém nesta sessão. */
  private async resolvePackingConsolidationLocation(client: PoolClient, warehouseId: string): Promise<{ id: string; code: string }> {
    const result = await client.query(
      `SELECT l.id, l.code FROM wms.location l
       JOIN wms.zone z ON z.id = l.zone_id
       WHERE z.warehouse_id = $1 AND z.zone_type = 'PACKING' AND l.status = 'ACTIVE'
       ORDER BY l.code ASC LIMIT 1`,
      [warehouseId]
    );
    if (result.rows.length === 0) {
      throw new BadRequestException({
        error: 'NO_PACKING_LOCATION',
        detail: `RF-EXP-031: nenhum endereço ACTIVE em zona PACKING configurado para o armazém ${warehouseId} — cadastre ao menos um antes de liberar a onda`,
      });
    }
    return result.rows[0];
  }

  /**
   * RF-EXP-031 — execução com dupla leitura (endereço -> produto/LPN) +
   * confirmação de quantidade. Idempotente por `operationId` (RNF-ARQ-050,
   * mesmo padrão do putaway 4B): reenvio da MESMA operação devolve o
   * resultado já aplicado, sem reaplicar nada.
   */
  async executeTask(taskId: string, tenantId: string, warehouseId: string, input: ExecutePickingTaskInput, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const task = await this.loadTask(taskId, ctx);

    if (task.last_operation_id !== null && task.last_operation_id === input.operationId) {
      return { task, idempotentReplay: true };
    }
    if (!['CREATED', 'ASSIGNED', 'IN_EXECUTION'].includes(task.status)) {
      throw new ConflictException({ error: 'TASK_NOT_EXECUTABLE', detail: `§5.2: tarefa ${taskId} não está executável (status atual: ${task.status})` });
    }

    // ── Leitura 1: endereço de origem (RF-EXP-031) ─────────────────────────
    const locationResult = await this.db.query(ctx, `SELECT id, code FROM wms.location WHERE id = $1`, [task.location_id_from]);
    const location = locationResult.rows[0];
    if (!location) throw new NotFoundException(`location ${task.location_id_from} not found`);
    if (location.code !== input.scannedLocationCode) {
      throw new BadRequestException({
        error: 'ADDRESS_MISMATCH',
        detail: `RF-EXP-031: endereço lido "${input.scannedLocationCode}" diverge do endereço da tarefa ("${location.code}")`,
      });
    }

    // ── Leitura 2: LPN do palete OU EAN/código do produto ──────────────────
    await this.assertProductScanMatches(ctx, task, input.scannedProductCode);

    if (input.qtyConfirmed < 0) {
      throw new BadRequestException({ error: 'INVALID_QTY', detail: 'RF-EXP-031: quantidade confirmada não pode ser negativa' });
    }
    if (input.qtyConfirmed > Number(task.qty_suggested)) {
      throw new BadRequestException({
        error: 'QTY_EXCEEDS_SUGGESTED',
        detail: `RF-EXP-031: quantidade confirmada (${input.qtyConfirmed}) excede a sugerida/reservada (${task.qty_suggested})`,
      });
    }
    if (input.qtyConfirmed !== Number(task.qty_suggested) && !input.reasonCode) {
      throw new BadRequestException({ error: 'REASON_REQUIRED', detail: 'RF-EXP-031: quantidade != sugerida exige motivo (reasonCode)' });
    }

    // ── RF-EXP-031: produto is_weight_variable exige pesagem ───────────────
    const productResult = await this.db.query(ctx, `SELECT is_weight_variable FROM wms.product WHERE id = $1`, [task.product_id]);
    if (productResult.rows[0]?.is_weight_variable) {
      if (input.weightKg === null || input.weightKg === undefined || input.weightKg <= 0) {
        throw new BadRequestException({ error: 'WEIGHT_REQUIRED', detail: 'RF-EXP-031: produto is_weight_variable exige peso (weightKg) na execução' });
      }
      if (input.weightSource === 'MANUAL') {
        await this.assertManualWeightAuthorized(ctx, input.reasonText);
      }
    }

    const result = await this.db.transaction(ctx, async (client) => {
      const isFirstExecution = task.status === 'CREATED';
      const short = Number(task.qty_suggested) - input.qtyConfirmed;

      const updatedTask = await client.query(
        `UPDATE wms.picking_task SET
           status = $2, qty_confirmed = $3, qty_short = $4, reason_code = $5, reason_text = $6,
           weight_kg = $7, weight_source = $8, last_operation_id = $9,
           assigned_to_user_id = COALESCE(assigned_to_user_id, $10),
           started_at = COALESCE(started_at, now()), completed_at = now(),
           updated_at = now(), updated_by = $10
         WHERE id = $1 RETURNING *`,
        [
          taskId,
          short > 0 ? 'SHORT_REPORTED' : 'DONE',
          input.qtyConfirmed,
          short > 0 ? short : 0,
          input.reasonCode ?? null,
          input.reasonText ?? null,
          input.weightKg ?? null,
          input.weightSource ?? null,
          input.operationId,
          actorUserId,
        ]
      );
      let finalTask = updatedTask.rows[0];

      if (isFirstExecution) {
        await client.query(
          `UPDATE wms.outbound_order SET status = 'IN_PICKING', updated_at = now(), updated_by = $2 WHERE id = $1 AND status = 'RELEASED'`,
          [task.outbound_order_id, actorUserId]
        );
      }

      if (input.qtyConfirmed > 0) {
        await client.query(
          `UPDATE wms.outbound_order_item SET qty_picked = qty_picked + $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
          [task.outbound_order_item_id, input.qtyConfirmed, actorUserId]
        );
      }

      if (short > 0) {
        finalTask = await this.handleShort(client, finalTask, short, ctx, actorUserId);
        await this.eventsService.publishInTransaction(client, {
          event_type: 'expedicao.corte_registrado',
          tenant_id: tenantId,
          warehouse_id: warehouseId,
          actor_user_id: actorUserId,
          payload: { picking_task_id: taskId, outbound_order_id: task.outbound_order_id, product_id: task.product_id, qty_short: short },
        });
      } else {
        await this.eventsService.publishInTransaction(client, {
          event_type: 'expedicao.tarefa_picking_concluida',
          tenant_id: tenantId,
          warehouse_id: warehouseId,
          actor_user_id: actorUserId,
          payload: { picking_task_id: taskId, outbound_order_id: task.outbound_order_id, qty_confirmed: input.qtyConfirmed },
        });
      }

      await this.tryCompletePickingStep(client, task.outbound_order_id, tenantId, warehouseId, actorUserId);

      return finalTask;
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'picking_task',
      entityId: taskId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-06 RF-EXP-031',
      before: task,
      after: result,
    });

    return { task: result, idempotentReplay: false };
  }

  /**
   * RN-EXP-032 [INVIOLÁVEL] — corte: abre EXP.CORTE_PICKING, bloqueia o saldo
   * divergente (LIBERACAO_RESERVA + BLOQUEIO motivo DIVERGENCIA — a reserva
   * "libera" para AVAILABLE e imediatamente "bloqueia" para BLOCKED, únicos
   * dois efeitos do catálogo fechado RN-EST-001 que compõem RESERVED->BLOCKED),
   * agenda contagem (inventory_count POR_ENDERECO) e congela o endereço
   * (location.status = INVENTORY, RN-EST-061).
   */
  private async handleShort(client: PoolClient, task: any, shortQty: number, ctx: TenantContext, actorUserId: string): Promise<any> {
    const reservationResult = await client.query(`SELECT * FROM wms.stock_reservation WHERE id = $1`, [task.stock_reservation_id]);
    const reservation = reservationResult.rows[0];

    // A reserva original cobria qty_suggested; a parte CONFIRMADA continua
    // reservada (será debitada em SAIDA_EXPEDICAO no carregamento) — só o
    // short é liberado+bloqueado. qty_confirmed=0 (corte total) cancela a
    // reserva inteira.
    if (Number(task.qty_confirmed) > 0) {
      await client.query(`UPDATE wms.stock_reservation SET qty = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [
        reservation.id,
        task.qty_confirmed,
        actorUserId,
      ]);
    } else {
      await client.query(`UPDATE wms.stock_reservation SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1`, [
        reservation.id,
        actorUserId,
      ]);
    }

    await this.stockMovementService.apply(client, {
      tenantId: ctx.tenant_id,
      warehouseId: ctx.warehouse_id!,
      movementType: 'LIBERACAO_RESERVA',
      productId: task.product_id,
      batchId: task.batch_id,
      qty: shortQty,
      locationIdFrom: task.location_id_from,
      palletIdFrom: task.pallet_id_from,
      locationIdTo: task.location_id_from,
      palletIdTo: task.pallet_id_from,
      documentRefType: 'PICKING_TASK',
      documentRefId: task.id,
      actorUserId,
    });
    await this.stockMovementService.apply(client, {
      tenantId: ctx.tenant_id,
      warehouseId: ctx.warehouse_id!,
      movementType: 'BLOQUEIO',
      productId: task.product_id,
      batchId: task.batch_id,
      qty: shortQty,
      locationIdFrom: task.location_id_from,
      palletIdFrom: task.pallet_id_from,
      locationIdTo: task.location_id_from,
      palletIdTo: task.pallet_id_from,
      blockReasonCode: 'DIVERGENCIA',
      blockReasonText: `RN-EXP-032: corte de picking (tarefa ${task.id})`,
      documentRefType: 'PICKING_TASK',
      documentRefId: task.id,
      actorUserId,
    });

    const exception = await this.operationalExceptionService.create({
      tenantId: ctx.tenant_id,
      warehouseId: ctx.warehouse_id!,
      exceptionType: 'EXP.CORTE_PICKING',
      entity: 'picking_task',
      entityId: task.id,
      qty: shortQty,
      reasonRequest: task.reason_text ?? `RN-EXP-032: corte de ${shortQty} no endereço ${task.location_id_from}`,
      requestedBy: actorUserId,
    });

    const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'outbound_order' AND entity_id = $1`, [task.outbound_order_id]);
    await this.operationFlowService.linkBlockingException(client, flowResult.rows[0].id, 'PICKING', exception.id, actorUserId);

    await client.query(
      `INSERT INTO wms.inventory_count (tenant_id, warehouse_id, count_type, location_id, status, trigger_ref_type, trigger_ref_id, created_by)
       VALUES ($1,$2,'POR_ENDERECO',$3,'PENDING','PICKING_TASK',$4,$5)`,
      [ctx.tenant_id, ctx.warehouse_id, task.location_id_from, task.id, actorUserId]
    );
    // RN-EST-061: endereço congelado enquanto durar a contagem.
    await client.query(`UPDATE wms.location SET status = 'INVENTORY', updated_at = now(), updated_by = $2 WHERE id = $1`, [task.location_id_from, actorUserId]);

    const updated = await client.query(`UPDATE wms.picking_task SET short_exception_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`, [
      task.id,
      exception.id,
      actorUserId,
    ]);
    return updated.rows[0];
  }

  /**
   * RN-EXP-032(c) — decisão da exceção EXP.CORTE_PICKING (já APROVADA por
   * OperationalExceptionService.decide, 1 passo): re-seleção de saldo
   * alternativo (nova tarefa) OU corte definitivo (item segue parcial).
   */
  async applyShortDecision(taskId: string, decision: 'RESELECT' | 'DEFINITIVE', tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const task = await this.loadTask(taskId, ctx);
    if (task.status !== 'SHORT_REPORTED' || !task.short_exception_id) {
      throw new BadRequestException({ error: 'TASK_NOT_SHORT', detail: `RN-EXP-032: tarefa ${taskId} não tem corte pendente de decisão` });
    }

    const exceptionResult = await this.db.query(ctx, `SELECT * FROM wms.operational_exception WHERE id = $1`, [task.short_exception_id]);
    const exception = exceptionResult.rows[0];
    if (!exception) throw new NotFoundException(`operational_exception ${task.short_exception_id} not found`);
    if (exception.status !== 'APPROVED') {
      throw new ConflictException({ error: 'EXCEPTION_NOT_APPROVED', detail: `RN-EXP-032: EXP.CORTE_PICKING precisa estar APROVADA (status atual: ${exception.status})` });
    }

    const result = await this.db.transaction(ctx, async (client) => {
      let newTasks = 0;

      if (decision === 'RESELECT') {
        const itemResult = await client.query(`SELECT * FROM wms.outbound_order_item WHERE id = $1`, [task.outbound_order_item_id]);
        const item = itemResult.rows[0];
        const shortQty = Number(task.qty_short);

        if (shortQty > 0) {
          const reservation = await this.stockReservationService.reserveInTransaction(client, {
            tenantId,
            warehouseId,
            productId: task.product_id,
            demandQty: shortQty,
            purpose: 'CLIENT_DISPATCH',
            demandRefType: 'OUTBOUND_ORDER_ITEM',
            demandRefId: item.id,
            allowPartial: true,
            actorUserId,
          });

          await client.query(`UPDATE wms.outbound_order_item SET qty_reserved = qty_reserved + $2, qty_short = GREATEST(qty_short - $2, 0), updated_at = now(), updated_by = $3 WHERE id = $1`, [
            item.id,
            reservation.qtyReserved,
            actorUserId,
          ]);

          const generated = await this.generateForOrders(client, { tenantId, warehouseId, waveId: task.wave_id, orderIds: [task.outbound_order_id] }, actorUserId);
          newTasks = generated.tasksCreated;
        }
      }
      // DEFINITIVE: nada a mover — RN-EXP-033 já conta qty_short como
      // "retirado do pedido" na fórmula de conclusão da etapa.

      await this.operationFlowService.clearBlockingException(client, (await this.loadFlowId(client, task.outbound_order_id)), 'PICKING', actorUserId);
      await this.tryCompletePickingStep(client, task.outbound_order_id, tenantId, warehouseId, actorUserId);

      return { newTasks };
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'picking_task',
      entityId: taskId,
      action: 'OVERRIDE',
      requirementId: 'DOC-06 RN-EXP-032',
      reason: `decisão: ${decision}`,
      after: result,
    });

    return result;
  }

  /** RN-EXP-033 — Σ separado + Σ cross-dock + Σ cortes = Σ pedido, sem exceção pendente. */
  private async tryCompletePickingStep(client: PoolClient, orderId: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<void> {
    const totalsResult = await client.query(
      `SELECT COALESCE(SUM(qty_ordered), 0) AS ordered, COALESCE(SUM(qty_picked), 0) AS picked, COALESCE(SUM(qty_short), 0) AS short
       FROM wms.outbound_order_item WHERE outbound_order_id = $1 AND moved_to_order_id IS NULL`,
      [orderId]
    );
    const totals = totalsResult.rows[0];
    // [LACUNA: RN-EXP-033 soma também "cross-docking" (RF-REC-051) — a
    // supressão do pedido por cross-dock é do DOC-04, sem ponto de gravação
    // definido em outbound_order_item nesta base. Fórmula implementada:
    // Σ separado + Σ cortes = Σ pedido, que é o que esta sessão tem dados
    // para calcular; cross-dock fica registrado como débito, não bloqueante
    // dos cenários do §6 (nenhum usa cross-dock).]
    if (Number(totals.picked) + Number(totals.short) < Number(totals.ordered)) return;

    const pendingException = await client.query(
      `SELECT 1 FROM wms.picking_task pt
       JOIN wms.operational_exception oe ON oe.id = pt.short_exception_id
       WHERE pt.outbound_order_id = $1 AND oe.status IN ('PENDING', 'ESCALATED')`,
      [orderId]
    );
    if (pendingException.rows.length > 0) return;

    if (!(await isFirstPendingStep(client, orderId, 'PICKING'))) return;

    await this.outboundFlowService.completeOrderStep(client, { tenantId, warehouseId, orderId, step: 'PICKING' }, actorUserId);
  }

  private async loadFlowId(client: PoolClient, orderId: string): Promise<string> {
    const result = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'outbound_order' AND entity_id = $1`, [orderId]);
    return result.rows[0].id;
  }

  private async assertProductScanMatches(ctx: TenantContext, task: any, scannedCode: string): Promise<void> {
    if (task.pallet_id_from) {
      const palletResult = await this.db.query(ctx, `SELECT lpn FROM wms.pallet WHERE id = $1`, [task.pallet_id_from]);
      if (palletResult.rows[0]?.lpn === scannedCode) return;
    }
    const barcodeResult = await this.db.query(ctx, `SELECT 1 FROM wms.product_barcode WHERE product_id = $1 AND barcode = $2`, [task.product_id, scannedCode]);
    if (barcodeResult.rows.length > 0) return;

    throw new BadRequestException({
      error: 'PRODUCT_MISMATCH',
      detail: `RF-EXP-031: LPN/EAN lido ("${scannedCode}") não confere com o produto/palete da tarefa`,
    });
  }

  private async assertManualWeightAuthorized(ctx: TenantContext, reasonText: string | null | undefined): Promise<void> {
    const hasPermission = await this.rbacService.hasPermission(ctx.user_id, 'EXP.PESO_MANUAL', { warehouseId: ctx.warehouse_id, clientId: ctx.tenant_id });
    if (!hasPermission) {
      throw new ForbiddenException({ error: 'MANUAL_WEIGHT_PERMISSION_REQUIRED', detail: 'RF-EXP-031/050: peso manual exige EXP.PESO_MANUAL' });
    }
    if (!reasonText) {
      throw new BadRequestException({ error: 'MANUAL_WEIGHT_REASON_REQUIRED', detail: 'RF-EXP-031/050: peso manual exige motivo (balança indisponível)' });
    }
  }

  private async loadTask(taskId: string, ctx: TenantContext) {
    const result = await this.db.query(ctx, `SELECT * FROM wms.picking_task WHERE id = $1`, [taskId]);
    const task = result.rows[0];
    if (!task) throw new NotFoundException(`picking_task ${taskId} not found`);
    return task;
  }
}
