// DOC-05 §4.5 RF-EST-041/042 — Reposição de picking. Tarefa dirigida
// (storage -> picking) com dupla leitura "como no putaway" (RF-REC-042,
// apps/backend/src/modules/recebimento/putaway/putaway-task.service.ts) —
// máquina de estados, idempotência por operationId (RNF-ARQ-050) e o padrão
// de execução são replicados aqui; a diferença é que origem E destino já são
// conhecidos na CRIAÇÃO da tarefa (não só no assign), porque quem decide
// origem/destino é RF-EST-041 (kanban) ou uma criação manual/por demanda.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';

export interface GenerateReplenishmentTaskInput {
  tenantId: string;
  warehouseId: string;
  productId: string;
  batchId?: string | null;
  triggerType: 'KANBAN' | 'MANUAL' | 'DEMANDA';
  locationIdOrigin: string;
  locationIdDestination: string;
  qty: number;
  actorUserId: string;
}

export interface ExecuteReplenishmentInput {
  /** RNF-ARQ-050: id gerado no coletor; repetir a MESMA operação devolve o MESMO resultado. */
  operationId: string;
  /** RG-007/RN-DAD-011: leitura 1 — código do endereço de ORIGEM (storage). */
  scannedLocationCodeFrom: string;
  /** RN-DAD-011: leitura 2 — código do endereço de DESTINO (picking). */
  scannedLocationCodeTo: string;
}

@Injectable()
export class ReplenishmentTaskService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (mesmo padrão do resto do módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService
  ) {}

  /**
   * RF-EST-041 [INVIOLÁVEL na parte de dedup]: "PROIBIDO gerar nova tarefa
   * kanban enquanto houver reposição aberta do mesmo produto×endereço".
   * Reusável dentro de QUALQUER transação já aberta pelo chamador (KanbanService
   * roda cross-tenant via transactionAsWorker; uma criação manual futura
   * chamaria com db.transaction() normal) — por isso recebe `client` pronto,
   * mesmo contrato de StockMovementService.apply()/EventsService.publishInTransaction.
   */
  async generateIfNeeded(client: PoolClient, input: GenerateReplenishmentTaskInput): Promise<{ task: any; skipped: boolean }> {
    const openResult = await client.query(
      `SELECT 1 FROM wms.replenishment_task
       WHERE product_id = $1 AND location_id_destination = $2 AND status IN ('CREATED','ASSIGNED','IN_EXECUTION','REJECTED_SCAN')
       LIMIT 1`,
      [input.productId, input.locationIdDestination]
    );
    if (openResult.rows.length > 0) {
      return { task: null, skipped: true };
    }

    const inserted = await client.query(
      `INSERT INTO wms.replenishment_task (
         tenant_id, warehouse_id, product_id, batch_id, trigger_type,
         location_id_origin, location_id_destination, qty, status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CREATED',$9)
       RETURNING *`,
      [input.tenantId, input.warehouseId, input.productId, input.batchId ?? null, input.triggerType, input.locationIdOrigin, input.locationIdDestination, input.qty, input.actorUserId]
    );
    const task = inserted.rows[0];

    await this.eventsService.publishInTransaction(client, {
      event_type: 'estoque.reposicao_gerada',
      tenant_id: input.tenantId,
      warehouse_id: input.warehouseId,
      payload: { replenishment_task_id: task.id, product_id: input.productId, qty: input.qty, trigger_type: input.triggerType },
    });

    return { task, skipped: false };
  }

  /** RF-EST-042: "prioridade sobre putaway... quando houver pedido liberado dependente" — [LACUNA: depende de DOC-06 (Picking/Expedição), inexistente nesta sessão; ordenação atual é só por created_at]. */
  async listQueue(tenantId: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT rt.*, lo.code AS origin_code, ld.code AS destination_code
       FROM wms.replenishment_task rt
       JOIN wms.location lo ON lo.id = rt.location_id_origin
       JOIN wms.location ld ON ld.id = rt.location_id_destination
       WHERE rt.warehouse_id = $1 AND rt.status IN ('CREATED', 'ASSIGNED', 'IN_EXECUTION', 'REJECTED_SCAN')
       ORDER BY rt.created_at ASC`,
      [warehouseId]
    );
    return result.rows;
  }

  /** §5.2 (mesma máquina de estados de putaway_task): CREATED/REJECTED_SCAN -> ASSIGNED. */
  async assignTask(taskId: string, assignedToUserId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const task = await this.loadTask(taskId, tenantId, warehouseId, actorUserId);
    if (!['CREATED', 'REJECTED_SCAN'].includes(task.status)) {
      throw new BadRequestException({ error: 'TASK_NOT_ASSIGNABLE', detail: `§5.2: tarefa ${taskId} não está CREATED nem REJECTED_SCAN (status atual: ${task.status})` });
    }

    const updated = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `UPDATE wms.replenishment_task SET status = 'ASSIGNED', assigned_to_user_id = $2, assigned_at = now(), updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
      [taskId, assignedToUserId, actorUserId]
    );

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'replenishment_task',
      entityId: taskId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-05 RF-EST-042',
      before: task,
      after: updated.rows[0],
    });

    return updated.rows[0];
  }

  /**
   * RF-EST-042 — execução com DUPLA LEITURA (origem, depois destino),
   * idempotente por `operationId` (RNF-ARQ-050) — mesmo contrato de
   * PutawayTaskService.executeTask(). "Disponível offline": o coletor pode
   * reenviar a mesma operação ao reconectar sem duplicar o efeito de saldo.
   */
  async executeTask(taskId: string, input: ExecuteReplenishmentInput, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    const existing = await this.db.query(ctx, `SELECT result FROM wms.replenishment_operation WHERE operation_id = $1`, [input.operationId]);
    if (existing.rows.length > 0) {
      return { ...existing.rows[0].result, idempotent_replay: true };
    }

    const task = await this.loadTask(taskId, tenantId, warehouseId, actorUserId);
    if (!['ASSIGNED', 'IN_EXECUTION', 'REJECTED_SCAN'].includes(task.status)) {
      throw new BadRequestException({ error: 'TASK_NOT_EXECUTABLE', detail: `§5.2: tarefa ${taskId} não está em execução (status atual: ${task.status})` });
    }

    // ── Leitura 1: endereço de ORIGEM (RN-DAD-011) ─────────────────────────
    const originResult = await this.db.queryGlobal(`SELECT id, code FROM wms.location WHERE warehouse_id = $1 AND code = $2`, [warehouseId, input.scannedLocationCodeFrom]);
    const origin = originResult.rows[0];
    if (!origin || origin.id !== task.location_id_origin) {
      await this.db.query(ctx, `UPDATE wms.replenishment_task SET status = 'REJECTED_SCAN', updated_at = now(), updated_by = $2 WHERE id = $1`, [taskId, actorUserId]);
      throw new BadRequestException({
        error: 'ORIGIN_SCAN_MISMATCH',
        detail: `RF-EST-042: endereço de origem lido (${input.scannedLocationCodeFrom}) não é o da tarefa ${taskId}`,
      });
    }

    // ── Leitura 2: endereço de DESTINO (RN-DAD-011) ────────────────────────
    const destinationResult = await this.db.queryGlobal(`SELECT id, code FROM wms.location WHERE warehouse_id = $1 AND code = $2`, [warehouseId, input.scannedLocationCodeTo]);
    const destination = destinationResult.rows[0];
    if (!destination || destination.id !== task.location_id_destination) {
      await this.db.query(ctx, `UPDATE wms.replenishment_task SET status = 'REJECTED_SCAN', updated_at = now(), updated_by = $2 WHERE id = $1`, [taskId, actorUserId]);
      throw new BadRequestException({
        error: 'DESTINATION_SCAN_MISMATCH',
        detail: `RF-EST-042: endereço de destino lido (${input.scannedLocationCodeTo}) não é o da tarefa ${taskId}`,
      });
    }

    const result = await this.db.transaction(ctx, async (client) => {
      await this.stockMovementService.apply(client, {
        tenantId,
        warehouseId,
        movementType: 'REPOSICAO',
        productId: task.product_id,
        batchId: task.batch_id,
        qty: Number(task.qty),
        locationIdFrom: task.location_id_origin,
        locationIdTo: task.location_id_destination,
        bucketFromOverride: 'AVAILABLE',
        taskId,
        actorUserId,
      });

      const updatedTask = await client.query(
        `UPDATE wms.replenishment_task SET status = 'DONE', completed_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [taskId, actorUserId]
      );

      const payload = { replenishment_task_id: taskId, product_id: task.product_id, qty: Number(task.qty), location_id_origin: task.location_id_origin, location_id_destination: task.location_id_destination };
      const response = { ...payload, task: updatedTask.rows[0], idempotent_replay: false };

      // RNF-ARQ-050: grava o resultado NA MESMA transação do efeito.
      await client.query(
        `INSERT INTO wms.replenishment_operation (operation_id, tenant_id, warehouse_id, replenishment_task_id, result, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.operationId, tenantId, warehouseId, taskId, JSON.stringify(response), actorUserId]
      );

      return response;
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'PWA',
      entity: 'replenishment_task',
      entityId: taskId,
      action: 'MOVE',
      requirementId: 'DOC-05 RF-EST-042',
      before: task,
      after: result.task,
    });

    return result;
  }

  private async loadTask(taskId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.query({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, `SELECT * FROM wms.replenishment_task WHERE id = $1`, [taskId]);
    const task = result.rows[0];
    if (!task) throw new NotFoundException(`replenishment_task ${taskId} not found`);
    return task;
  }
}
