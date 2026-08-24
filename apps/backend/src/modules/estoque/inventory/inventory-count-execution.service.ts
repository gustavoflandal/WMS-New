// DOC-05 §4.7 — RN-EST-062 [INVIOLÁVEL] (rodadas de contagem), RN-EST-063
// (ajuste com alçada via o motor de exceção do DOC-12) e RF-EST-064
// (acuracidade). A árvore de decisão das rodadas é PURA
// (inventory-round-decision.util.ts) — este service só cuida de I/O:
// carregar a célula/rodadas, validar o papel LIDER_TURNO da 3ª rodada
// (mesmo padrão inline de GESTUAL_ARMAZEM em operational-exception.service.ts,
// não existe helper de papel no RbacService), gravar e propagar o efeito.
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';
import { CountRound, evaluateCountRounds } from './inventory-round-decision.util.js';
import { WriteOffPendingService } from '../../fiscal/write-off/write-off-pending.service.js';

export interface SubmitRoundInput {
  tenantId: string;
  warehouseId: string;
  countLocationId: string;
  countedQty: number;
  actorUserId: string;
  /** RN-EST-063 — "custo informado pelo cliente quando disponível" (não existe coluna de custo em product/batch, ver relatório). */
  unitCostBrl?: number;
  reasonRequest?: string;
  /** RNF-ARQ-050/RG-009: opcional — presente quando a chamada vem da fila offline do coletor (DOC-15 T5). */
  operationId?: string;
}

export type SubmitRoundResult =
  | { status: 'AWAITING_ROUND'; nextRound: 1 | 2 | 3; idempotentReplay?: boolean }
  | { status: 'COMPLETED'; idempotentReplay?: boolean }
  | { status: 'ADJUSTMENT_PENDING'; exceptionId: string; divergence: number; idempotentReplay?: boolean };

export interface DecideAdjustmentInput {
  tenantId: string;
  warehouseId: string;
  exceptionId: string;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
  actorUserId: string;
}

@Injectable()
export class InventoryCountExecutionService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (padrão de todo o módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService,
    @Inject(WriteOffPendingService) private readonly writeOffPendingService: WriteOffPendingService
  ) {}

  /** RN-EST-062 [INVIOLÁVEL] — registra uma rodada de contagem e decide o desfecho. */
  async submitRound(input: SubmitRoundInput): Promise<SubmitRoundResult> {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    // RNF-ARQ-050 — idempotência ANTES de qualquer efeito colateral (mesmo
    // contrato de PutawayTaskService.executeTask()).
    if (input.operationId) {
      const existing = await this.db.query(ctx, `SELECT result FROM wms.inventory_count_operation WHERE operation_id = $1`, [input.operationId]);
      if (existing.rows.length > 0) {
        return { ...existing.rows[0].result, idempotentReplay: true };
      }
    }

    const result = await this.db.transaction(ctx, async (client) => {
      const recordOperation = async (opResult: SubmitRoundResult) => {
        if (!input.operationId) return;
        await client.query(
          `INSERT INTO wms.inventory_count_operation (operation_id, tenant_id, warehouse_id, count_location_id, result, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [input.operationId, input.tenantId, input.warehouseId, input.countLocationId, JSON.stringify(opResult), input.actorUserId]
        );
      };

      const cellResult = await client.query(`SELECT * FROM wms.inventory_count_location WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
        input.countLocationId,
        input.tenantId,
      ]);
      const cell = cellResult.rows[0];
      if (!cell) throw new NotFoundException(`inventory_count_location ${input.countLocationId} not found`);
      if (cell.warehouse_id !== input.warehouseId) {
        throw new BadRequestException({ error: 'WAREHOUSE_MISMATCH', detail: 'a célula pertence a outro armazém' });
      }
      if (cell.status !== 'PENDING' && cell.status !== 'COUNTING') {
        throw new ConflictException({ error: 'CELL_NOT_COUNTABLE', detail: `RN-EST-062: célula não está aguardando contagem (status atual: ${cell.status})` });
      }

      const roundsResult = await client.query(
        `SELECT round_number, counted_qty, counted_by FROM wms.inventory_count_round WHERE count_location_id = $1 AND cycle = $2 ORDER BY round_number ASC`,
        [input.countLocationId, cell.cycle]
      );
      const priorRounds: CountRound[] = roundsResult.rows.map((r: { round_number: number; counted_qty: string; counted_by: string }) => ({
        roundNumber: r.round_number as 1 | 2 | 3,
        countedQty: Number(r.counted_qty),
        countedBy: r.counted_by,
      }));

      const systemQty = Number(cell.system_qty);
      const preOutcome = evaluateCountRounds(systemQty, priorRounds);
      if (preOutcome.status !== 'AWAITING_ROUND') {
        throw new ConflictException({ error: 'CELL_ALREADY_RESOLVED', detail: 'RN-EST-062: todas as rodadas necessárias já foram registradas' });
      }
      const roundNumber = preOutcome.nextRound;

      // RN-EST-062: "2ª contagem cega POR OPERADOR DIFERENTE".
      if (preOutcome.requiresDifferentOperatorThan && preOutcome.requiresDifferentOperatorThan === input.actorUserId) {
        throw new ForbiddenException({ error: 'SAME_OPERATOR_ROUND2', detail: 'RN-EST-062: a 2ª rodada exige operador diferente do que fez a 1ª' });
      }

      // RN-EST-062: "3ª contagem por LIDER_TURNO". Mesmo padrão inline de
      // GESTOR_ARMAZEM em operational-exception.service.ts — não existe
      // helper de papel no RbacService (RbacService só resolve PERMISSÃO).
      if (preOutcome.requiresRole === 'LIDER_TURNO') {
        const roleCheck = await client.query(
          `SELECT 1 FROM wms.user_role_assignment ura
           JOIN wms.role r ON r.id = ura.role_id AND r.status = 'ACTIVE' AND r.code = 'LIDER_TURNO'
           WHERE ura.user_id = $1 AND ura.warehouse_id = $2`,
          [input.actorUserId, input.warehouseId]
        );
        if (roleCheck.rows.length === 0) {
          throw new ForbiddenException({ error: 'LIDER_TURNO_REQUIRED', detail: 'RN-EST-062: a 3ª rodada exige o papel LIDER_TURNO no armazém' });
        }
      }

      await client.query(
        `INSERT INTO wms.inventory_count_round (tenant_id, count_location_id, round_number, cycle, counted_qty, counted_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [input.tenantId, input.countLocationId, roundNumber, cell.cycle, input.countedQty, input.actorUserId]
      );

      const finalOutcome = evaluateCountRounds(systemQty, [...priorRounds, { roundNumber, countedQty: input.countedQty, countedBy: input.actorUserId }]);

      if (finalOutcome.status === 'AWAITING_ROUND') {
        await client.query(`UPDATE wms.inventory_count_location SET status = 'COUNTING', updated_at = now(), updated_by = $2 WHERE id = $1`, [
          input.countLocationId,
          input.actorUserId,
        ]);
        const opResult = { status: 'AWAITING_ROUND' as const, nextRound: finalOutcome.nextRound };
        await recordOperation(opResult);
        return opResult;
      }

      if (finalOutcome.status === 'COMPLETED') {
        await client.query(`UPDATE wms.inventory_count_location SET status = 'COMPLETED', updated_at = now(), updated_by = $2 WHERE id = $1`, [
          input.countLocationId,
          input.actorUserId,
        ]);
        await this.eventsService.publishInTransaction(client, {
          event_type: 'estoque.endereco_contado',
          tenant_id: input.tenantId,
          warehouse_id: input.warehouseId,
          actor_user_id: input.actorUserId,
          payload: { count_location_id: input.countLocationId, location_id: cell.location_id, divergence: 0 },
        });
        await this.releaseLocationIfDone(client, input.tenantId, cell.header_id, cell.location_id, input.actorUserId);
        await this.completeHeaderIfDone(client, input.tenantId, input.warehouseId, cell.header_id, input.actorUserId);
        const opResult = { status: 'COMPLETED' as const };
        await recordOperation(opResult);
        return opResult;
      }

      // DIVERGENCE_CONFIRMED — RN-EST-063: abre EST.AJUSTE_INVENTARIO ANTES
      // de qualquer efeito de saldo (mesmo princípio de RN-EST-013 em
      // stock-reservation.service.ts: exceção primeiro, efeito só depois de
      // decidida). operationalExceptionService.create() abre sua PRÓPRIA
      // transação (mesmo precedente já aceito em picking-task.service.ts
      // handleShort — não atômico com esta, risco aceito pelo mesmo motivo).
      const divergence = finalOutcome.divergence;
      const qtyAbs = Math.abs(divergence);
      const exception = await this.operationalExceptionService.create({
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        exceptionType: 'EST.AJUSTE_INVENTARIO',
        entity: 'inventory_count_location',
        entityId: input.countLocationId,
        qty: qtyAbs,
        valueBrl: input.unitCostBrl ? qtyAbs * input.unitCostBrl : undefined,
        reasonRequest: input.reasonRequest ?? `RN-EST-063: divergência de ${divergence} confirmada na célula ${input.countLocationId}`,
        requestedBy: input.actorUserId,
      });

      await client.query(
        `UPDATE wms.inventory_count_location SET status = 'ADJUSTMENT_PENDING', exception_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
        [input.countLocationId, exception.id, input.actorUserId]
      );
      await client.query(
        `UPDATE wms.inventory_count SET status = 'ADJUSTMENT_PENDING', updated_at = now(), updated_by = $2 WHERE id = $1 AND status = 'IN_PROGRESS'`,
        [cell.header_id, input.actorUserId]
      );

      await this.eventsService.publishInTransaction(client, {
        event_type: 'estoque.endereco_contado',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { count_location_id: input.countLocationId, location_id: cell.location_id, divergence, exception_id: exception.id },
      });

      const opResult = { status: 'ADJUSTMENT_PENDING' as const, exceptionId: exception.id, divergence };
      await recordOperation(opResult);
      return opResult;
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'inventory_count_location',
      entityId: input.countLocationId,
      action: 'UPDATE',
      requirementId: 'DOC-05 RN-EST-062',
      after: result,
    });

    return result;
  }

  /**
   * RN-EST-063 — decide a exceção EST.AJUSTE_INVENTARIO já aberta.
   * APROVADO: posta AJUSTE_INVENTARIO_POS/NEG (sinal pela divergência) via o
   * serviço único da 5A e fecha a célula. REJEITADO: "exige nova contagem
   * (volta à 1ª rodada)" — incrementa o ciclo, célula volta a PENDING.
   */
  async decideAdjustment(input: DecideAdjustmentInput): Promise<Record<string, unknown>> {
    const decided = await this.operationalExceptionService.decide(
      input.exceptionId,
      input.tenantId,
      input.warehouseId,
      input.actorUserId,
      input.decision,
      input.reason
    );

    if (decided.exception_type && decided.exception_type !== 'EST.AJUSTE_INVENTARIO') {
      throw new BadRequestException({ error: 'WRONG_EXCEPTION_TYPE', detail: `RN-EST-063: esperado EST.AJUSTE_INVENTARIO (recebido ${decided.exception_type})` });
    }
    if (decided.status !== 'APPROVED' && decided.status !== 'REJECTED') {
      // Fluxo de 1 passo (default_steps=1): decide() já retorna terminal aqui.
      return decided;
    }

    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    return this.db.transaction(ctx, async (client) => {
      const cellResult = await client.query(`SELECT * FROM wms.inventory_count_location WHERE exception_id = $1 AND tenant_id = $2 FOR UPDATE`, [
        input.exceptionId,
        input.tenantId,
      ]);
      const cell = cellResult.rows[0];
      if (!cell) throw new NotFoundException(`inventory_count_location com exception_id ${input.exceptionId} não encontrada`);

      if (decided.status === 'REJECTED') {
        // RN-EST-063: "rejeição exige nova contagem (volta à 1ª rodada)".
        await client.query(
          `UPDATE wms.inventory_count_location SET status = 'PENDING', cycle = cycle + 1, exception_id = NULL, updated_at = now(), updated_by = $2 WHERE id = $1`,
          [cell.id, input.actorUserId]
        );
        return { cellId: cell.id, status: 'PENDING', cycle: cell.cycle + 1 };
      }

      // APROVADO — a divergência já foi confirmada em submitRound; reconstrói
      // o valor a partir da última rodada do ciclo corrente (mesmo cálculo,
      // sem duplicar estado).
      const lastRoundResult = await client.query(
        `SELECT counted_qty FROM wms.inventory_count_round WHERE count_location_id = $1 AND cycle = $2 ORDER BY round_number DESC LIMIT 1`,
        [cell.id, cell.cycle]
      );
      const countedQty = Number(lastRoundResult.rows[0].counted_qty);
      const systemQty = Number(cell.system_qty);
      const divergence = countedQty - systemQty;

      const movementType = divergence > 0 ? 'AJUSTE_INVENTARIO_POS' : 'AJUSTE_INVENTARIO_NEG';
      await this.stockMovementService.apply(client, {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        movementType,
        productId: cell.product_id,
        batchId: cell.batch_id,
        qty: Math.abs(divergence),
        locationIdFrom: movementType === 'AJUSTE_INVENTARIO_NEG' ? cell.location_id : null,
        locationIdTo: movementType === 'AJUSTE_INVENTARIO_POS' ? cell.location_id : null,
        documentRefType: 'INVENTORY_COUNT_LOCATION',
        documentRefId: cell.id,
        requirementId: input.exceptionId,
        actorUserId: input.actorUserId,
      });

      // DOC-08 RN-FIS-070: ajuste NEGATIVO aprovado em produto com Estoque
      // Fiscal trava qty_pending_writeoff (mesma transação do efeito
      // físico) — POS não gera pendência (é entrada, não perda).
      if (movementType === 'AJUSTE_INVENTARIO_NEG') {
        await this.writeOffPendingService.applyPendingWriteoffInTransaction(client, {
          tenantId: input.tenantId,
          warehouseId: input.warehouseId,
          productId: cell.product_id,
          qty: Math.abs(divergence),
          origin: 'AJUSTE_INVENTARIO_NEG',
          originEntity: 'inventory_count_location',
          originEntityId: cell.id,
          actorUserId: input.actorUserId,
        });
      }

      await client.query(`UPDATE wms.inventory_count_location SET status = 'COMPLETED', updated_at = now(), updated_by = $2 WHERE id = $1`, [
        cell.id,
        input.actorUserId,
      ]);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'estoque.ajuste_aplicado',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { count_location_id: cell.id, location_id: cell.location_id, movement_type: movementType, qty: Math.abs(divergence), exception_id: input.exceptionId },
      });

      await this.releaseLocationIfDone(client, input.tenantId, cell.header_id, cell.location_id, input.actorUserId);
      await this.completeHeaderIfDone(client, input.tenantId, input.warehouseId, cell.header_id, input.actorUserId);

      return { cellId: cell.id, status: 'COMPLETED', movementType, qty: Math.abs(divergence) };
    });
  }

  /** RN-EST-061 — "conclusão de cada endereço libera seu status individualmente". */
  private async releaseLocationIfDone(client: PoolClient, tenantId: string, headerId: string, locationId: string, actorUserId: string): Promise<void> {
    const remaining = await client.query(
      `SELECT 1 FROM wms.inventory_count_location WHERE header_id = $1 AND location_id = $2 AND status != 'COMPLETED' LIMIT 1`,
      [headerId, locationId]
    );
    if (remaining.rows.length === 0) {
      await client.query(`UPDATE wms.location SET status = 'ACTIVE', updated_at = now(), updated_by = $2 WHERE id = $1`, [locationId, actorUserId]);
      await client.query(
        `UPDATE wms.inventory_count_location SET released_at = now() WHERE header_id = $1 AND location_id = $2 AND released_at IS NULL`,
        [headerId, locationId]
      );
    }
  }

  /** RF-EST-064 — ao concluir a ÚLTIMA célula, fecha o cabeçalho e apura acuracidade. */
  private async completeHeaderIfDone(client: PoolClient, tenantId: string, warehouseId: string, headerId: string, actorUserId: string): Promise<void> {
    const pending = await client.query(`SELECT 1 FROM wms.inventory_count_location WHERE header_id = $1 AND status != 'COMPLETED' LIMIT 1`, [headerId]);
    if (pending.rows.length > 0) return;

    // RF-EST-064: acuracidade por endereço (endereços SEM nenhuma divergência
    // ÷ endereços contados) e por quantidade (1 − Σ|divergência| ÷ Σsaldo
    // contado); "por cliente" = por quantidade, já que o cabeçalho é de um
    // único tenant_id (ver decisão de modelagem).
    const accuracyResult = await client.query(
      `WITH final AS (
         SELECT icl.location_id, icl.system_qty,
           COALESCE((
             SELECT r.counted_qty FROM wms.inventory_count_round r
             WHERE r.count_location_id = icl.id AND r.cycle = icl.cycle
             ORDER BY r.round_number DESC LIMIT 1
           ), icl.system_qty) AS final_qty
         FROM wms.inventory_count_location icl WHERE icl.header_id = $1
       ),
       per_location AS (
         SELECT location_id, bool_and(final_qty = system_qty) AS all_match
         FROM final GROUP BY location_id
       )
       SELECT
         (SELECT COUNT(*) FROM per_location WHERE all_match) AS correct_locations,
         (SELECT COUNT(*) FROM per_location) AS total_locations,
         (SELECT COALESCE(SUM(ABS(final_qty - system_qty)), 0) FROM final) AS total_divergence,
         (SELECT COALESCE(SUM(system_qty), 0) FROM final) AS total_system`,
      [headerId]
    );
    const row = accuracyResult.rows[0];
    const totalLocations = Number(row.total_locations);
    const totalSystem = Number(row.total_system);
    const accuracyLocation = totalLocations > 0 ? Number(row.correct_locations) / totalLocations : 1;
    const accuracyQuantity = totalSystem > 0 ? 1 - Number(row.total_divergence) / totalSystem : 1;

    await client.query(
      `UPDATE wms.inventory_count SET status = 'COMPLETED', completed_at = now(), accuracy_location = $2, accuracy_quantity = $3, updated_at = now(), updated_by = $4 WHERE id = $1`,
      [headerId, accuracyLocation, accuracyQuantity, actorUserId]
    );

    await this.eventsService.publishInTransaction(client, {
      event_type: 'estoque.inventario_concluido',
      tenant_id: tenantId,
      warehouse_id: warehouseId,
      actor_user_id: actorUserId,
      payload: { header_id: headerId, accuracy_location: accuracyLocation, accuracy_quantity: accuracyQuantity, accuracy_client: accuracyQuantity },
    });
  }
}
