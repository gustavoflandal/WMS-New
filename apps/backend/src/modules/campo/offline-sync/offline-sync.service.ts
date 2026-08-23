// DOC-01 §4.6 RF-ARQ-052/RN-ARQ-053 [INVIOLÁVEL] — recepção da fila offline
// (ordem FIFO por dispositivo) e resolução determinística de conflitos.
// Dispatch por tipo de tarefa: cada operação é roteada para o service que já
// existe (PutawayTaskService/ReplenishmentTaskService/PickingTaskService já
// eram idempotentes por operationId antes desta sessão — RNF-ARQ-050;
// CheckingService/StockTransferService/InventoryCountExecutionService
// ganharam o mesmo padrão nesta sessão). Nenhuma regra de negócio é
// reimplementada aqui — este service só CLASSIFICA a situação e aplica
// exatamente uma das 4 decisões (RN-ARQ-053), nunca aplicação parcial.
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { FieldDeviceService } from '../field-device/field-device.service.js';
import { PutawayTaskService } from '../../recebimento/putaway/putaway-task.service.js';
import { CheckingService } from '../../recebimento/checking/checking.service.js';
import { ReplenishmentTaskService } from '../../estoque/replenishment/replenishment-task.service.js';
import { StockTransferService } from '../../estoque/transfer/stock-transfer.service.js';
import { InventoryCountExecutionService } from '../../estoque/inventory/inventory-count-execution.service.js';
import { PickingTaskService } from '../../expedicao/picking/picking-task.service.js';

export type OfflineTaskType = 'PUTAWAY' | 'REPOSICAO' | 'PICKING' | 'CONFERENCIA' | 'CONTAGEM_INVENTARIO' | 'TRANSFERENCIA';
export type SyncDecision = 'APLICADA' | 'DESCARTADA_DUPLICIDADE' | 'REJEITADA_TAREFA_INVALIDA' | 'REJEITADA_REGRA';

export interface OfflineOperationInput {
  operationId: string;
  tenantId: string;
  taskType: OfflineTaskType;
  /** Ausente apenas para TRANSFERENCIA (RF-EST-050 é ad-hoc — "imediata em tela", sem tarefa dirigida pré-aprovisionada). */
  taskId?: string;
  payload: Record<string, any>;
}

export interface SyncBatchInput {
  deviceId: string;
  warehouseId: string;
  appVersion?: string;
  batteryPct?: number;
  queueSize?: number;
  readFailuresPhysical?: number;
  readFailuresCamera?: number;
  operations: OfflineOperationInput[];
  actorUserId: string;
}

export interface SyncOperationResult {
  operationId: string;
  taskType: OfflineTaskType;
  decision: SyncDecision;
  result?: unknown;
  reason?: string;
}

export interface SyncBatchResult {
  versionBlocked: boolean;
  results: SyncOperationResult[];
}

// RN-ARQ-053: status "concluído" e "cancelado/reatribuído" por tipo de
// tarefa, usado para classificar decisão 2 (DESCARTADA_DUPLICIDADE) vs
// decisão 3 (REJEITADA_TAREFA_INVALIDA) A PARTIR do status observado ANTES
// da chamada ao service de execução — mesmo status que o service usaria
// internamente para decidir se a tarefa é executável.
const DONE_STATUSES: Partial<Record<OfflineTaskType, string[]>> = {
  PUTAWAY: ['DONE'],
  REPOSICAO: ['DONE'],
  PICKING: ['DONE', 'SHORT_REPORTED', 'REVERSED'],
  CONFERENCIA: ['CHECKED'],
  CONTAGEM_INVENTARIO: ['COMPLETED'],
};
const CANCELLED_STATUSES: Partial<Record<OfflineTaskType, string[]>> = {
  PUTAWAY: ['CANCELLED'],
  REPOSICAO: ['CANCELLED'],
  PICKING: ['CANCELLED'],
  CONFERENCIA: ['REFUSED'],
  CONTAGEM_INVENTARIO: [],
};
const PEEK_QUERY: Partial<Record<OfflineTaskType, string>> = {
  PUTAWAY: `SELECT status FROM wms.putaway_task WHERE id = $1`,
  REPOSICAO: `SELECT status FROM wms.replenishment_task WHERE id = $1`,
  PICKING: `SELECT status FROM wms.picking_task WHERE id = $1`,
  CONFERENCIA: `SELECT status FROM wms.inbound_order_item WHERE id = $1`,
  CONTAGEM_INVENTARIO: `SELECT status FROM wms.inventory_count_location WHERE id = $1`,
};
const SYNC_ENTITY: Record<OfflineTaskType, string> = {
  PUTAWAY: 'putaway_task',
  REPOSICAO: 'replenishment_task',
  PICKING: 'picking_task',
  CONFERENCIA: 'inbound_order_item',
  CONTAGEM_INVENTARIO: 'inventory_count_location',
  TRANSFERENCIA: 'stock_transfer',
};

const EVENT_BY_DECISION: Record<SyncDecision, string> = {
  APLICADA: 'campo.sincronizacao_aplicada',
  DESCARTADA_DUPLICIDADE: 'campo.sincronizacao_descartada',
  REJEITADA_TAREFA_INVALIDA: 'campo.sincronizacao_rejeitada',
  REJEITADA_REGRA: 'campo.sincronizacao_rejeitada',
};

@Injectable()
export class OfflineSyncService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(FieldDeviceService) private readonly fieldDeviceService: FieldDeviceService,
    @Inject(PutawayTaskService) private readonly putawayTaskService: PutawayTaskService,
    @Inject(CheckingService) private readonly checkingService: CheckingService,
    @Inject(ReplenishmentTaskService) private readonly replenishmentTaskService: ReplenishmentTaskService,
    @Inject(StockTransferService) private readonly stockTransferService: StockTransferService,
    @Inject(InventoryCountExecutionService) private readonly inventoryCountExecutionService: InventoryCountExecutionService,
    @Inject(PickingTaskService) private readonly pickingTaskService: PickingTaskService
  ) {}

  /**
   * RF-ARQ-052/RN-ARQ-053 — processa o lote em ORDEM FIFO (a ordem do array
   * é a ordem de gravação no dispositivo, RG-007). RNF-ARQ-054: NUNCA recusa
   * a sincronização pelo tamanho da fila — o bloqueio de novas execuções é
   * client-side (COL-2B); aqui o servidor sempre processa a fila inteira.
   */
  async sincronizar(input: SyncBatchInput): Promise<SyncBatchResult> {
    // RNF-COL-051 — telemetria a cada sincronização.
    await this.fieldDeviceService.recordTelemetry(input.deviceId, input.batteryPct, input.queueSize, input.readFailuresPhysical, input.readFailuresCamera);
    const versionBlocked = await this.fieldDeviceService.isVersionBlocked(input.appVersion ?? null);

    const results: SyncOperationResult[] = [];
    for (const op of input.operations) {
      results.push(await this.processOne(op, input.deviceId, input.warehouseId, input.actorUserId));
    }

    return { versionBlocked, results };
  }

  private async processOne(op: OfflineOperationInput, deviceId: string, warehouseId: string, actorUserId: string): Promise<SyncOperationResult> {
    const ctx: TenantContext = { tenant_id: op.tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    await this.upsertSyncOperation(ctx, op, deviceId, warehouseId);

    const { decision, result, reason } = await this.classifyAndDispatch(op, ctx, actorUserId);

    await this.db.query(
      ctx,
      `UPDATE wms.sync_operation SET status = $2, synced_at = now(), conflict_resolution = $3 WHERE idempotency_key = $1`,
      [op.operationId, decision, JSON.stringify({ decision, reason: reason ?? null })]
    );

    await this.auditService.record({
      tenantId: op.tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'PWA',
      entity: 'sync_operation',
      entityId: op.operationId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-01 RN-ARQ-053',
      reason: reason ?? decision,
      after: { operation_id: op.operationId, task_type: op.taskType, task_id: op.taskId ?? null, decision },
    });

    await this.db.transaction(ctx, (client) =>
      this.eventsService.publishInTransaction(client, {
        event_type: EVENT_BY_DECISION[decision],
        tenant_id: op.tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { operation_id: op.operationId, task_type: op.taskType, task_id: op.taskId ?? null, decision, device_id: deviceId },
      })
    );

    if (decision === 'REJEITADA_REGRA') {
      await this.operationalExceptionService.create({
        tenantId: op.tenantId,
        warehouseId,
        exceptionType: 'COL.SINCRONIZACAO_REJEITADA',
        entity: SYNC_ENTITY[op.taskType],
        entityId: op.taskId ?? op.operationId,
        reasonRequest: reason ?? 'RN-ARQ-053 decisão 4: efeito violaria regra de negócio',
        requestedBy: actorUserId,
      });
    }

    return { operationId: op.operationId, taskType: op.taskType, decision, result, reason };
  }

  private async upsertSyncOperation(ctx: TenantContext, op: OfflineOperationInput, deviceId: string, warehouseId: string): Promise<void> {
    await this.db.query(
      ctx,
      `INSERT INTO wms.sync_operation (tenant_id, warehouse_id, device_id, operation_type, entity_type, entity_id, entity_data, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ENVIANDO',$8)
       ON CONFLICT (idempotency_key) DO UPDATE SET status = 'ENVIANDO'`,
      [op.tenantId, warehouseId, deviceId, op.taskType === 'TRANSFERENCIA' ? 'CREATE' : 'UPDATE', op.taskType, op.taskId ?? op.operationId, JSON.stringify(op.payload), op.operationId]
    );
  }

  private async classifyAndDispatch(
    op: OfflineOperationInput,
    ctx: TenantContext,
    actorUserId: string
  ): Promise<{ decision: SyncDecision; result?: unknown; reason?: string }> {
    if (op.taskType === 'TRANSFERENCIA') {
      try {
        const result = await this.stockTransferService.transferInternal({
          tenantId: op.tenantId,
          warehouseId: ctx.warehouse_id!,
          productId: op.payload.productId,
          batchId: op.payload.batchId ?? null,
          qty: op.payload.qty,
          locationIdOrigin: op.payload.locationIdOrigin,
          palletIdOrigin: op.payload.palletIdOrigin ?? null,
          locationIdDestination: op.payload.locationIdDestination,
          palletIdDestination: op.payload.palletIdDestination ?? null,
          overrideReason: op.payload.overrideReason,
          actorUserId,
          operationId: op.operationId,
        });
        return { decision: 'APLICADA', result };
      } catch (error) {
        return { decision: 'REJEITADA_REGRA', reason: errorMessage(error) };
      }
    }

    if (!op.taskId) {
      return { decision: 'REJEITADA_TAREFA_INVALIDA', reason: `taskId ausente para taskType ${op.taskType}` };
    }

    const peek = await this.db.query<{ status: string }>(ctx, PEEK_QUERY[op.taskType]!, [op.taskId]);
    if (peek.rows.length === 0) {
      return { decision: 'REJEITADA_TAREFA_INVALIDA', reason: `${SYNC_ENTITY[op.taskType]} ${op.taskId} não encontrada` };
    }
    const status = peek.rows[0].status;
    if (CANCELLED_STATUSES[op.taskType]?.includes(status)) {
      return { decision: 'REJEITADA_TAREFA_INVALIDA', reason: `tarefa cancelada/reatribuída após o aprovisionamento (status ${status})` };
    }

    try {
      const result = await this.executeTask(op, ctx, actorUserId);
      return { decision: 'APLICADA', result };
    } catch (error) {
      // Status observado ANTES da chamada já era terminal ("concluído") —
      // outro ator terminou entre o aprovisionamento e esta sincronização
      // (decisão 2). Caso contrário, a exceção é violação de regra de
      // negócio descoberta pelo próprio service (decisão 4).
      if (DONE_STATUSES[op.taskType]?.includes(status)) {
        return { decision: 'DESCARTADA_DUPLICIDADE', reason: `tarefa já concluída (status ${status} antes desta sincronização)` };
      }
      return { decision: 'REJEITADA_REGRA', reason: errorMessage(error) };
    }
  }

  private async executeTask(op: OfflineOperationInput, ctx: TenantContext, actorUserId: string): Promise<unknown> {
    const warehouseId = ctx.warehouse_id!;
    switch (op.taskType) {
      case 'PUTAWAY':
        return this.putawayTaskService.executeTask(
          op.taskId!,
          { operationId: op.operationId, scannedLpn: op.payload.scannedLpn, scannedLocationCode: op.payload.scannedLocationCode, overrideReason: op.payload.overrideReason },
          op.tenantId,
          warehouseId,
          actorUserId
        );
      case 'REPOSICAO':
        return this.replenishmentTaskService.executeTask(
          op.taskId!,
          { operationId: op.operationId, scannedLocationCodeFrom: op.payload.scannedLocationCodeFrom, scannedLocationCodeTo: op.payload.scannedLocationCodeTo },
          op.tenantId,
          warehouseId,
          actorUserId
        );
      case 'PICKING':
        return this.pickingTaskService.executeTask(
          op.taskId!,
          op.tenantId,
          warehouseId,
          {
            operationId: op.operationId,
            scannedLocationCode: op.payload.scannedLocationCode,
            scannedProductCode: op.payload.scannedProductCode,
            qtyConfirmed: op.payload.qtyConfirmed,
            reasonCode: op.payload.reasonCode ?? null,
            reasonText: op.payload.reasonText ?? null,
            weightKg: op.payload.weightKg ?? null,
            weightSource: op.payload.weightSource ?? null,
          },
          actorUserId
        );
      case 'CONFERENCIA':
        return op.payload.round === 'RECOUNT'
          ? this.checkingService.recount(op.payload.checkingId, op.taskId!, op.payload.qtyCounted, op.payload.conferenteUserId, op.tenantId, warehouseId, actorUserId, op.operationId)
          : this.checkingService.countFirstRound(op.payload.checkingId, op.taskId!, op.payload.qtyCounted, op.payload.conferenteUserId, op.tenantId, warehouseId, actorUserId, op.operationId);
      case 'CONTAGEM_INVENTARIO':
        return this.inventoryCountExecutionService.submitRound({
          tenantId: op.tenantId,
          warehouseId,
          countLocationId: op.taskId!,
          countedQty: op.payload.countedQty,
          unitCostBrl: op.payload.unitCostBrl,
          reasonRequest: op.payload.reasonRequest,
          actorUserId,
          operationId: op.operationId,
        });
      default:
        throw new Error(`taskType desconhecido: ${op.taskType}`);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as { response?: unknown; message?: unknown }).response ?? (error as { message?: unknown }).message;
    if (response && typeof response === 'object' && 'detail' in response) return String((response as { detail: unknown }).detail);
    if (typeof response === 'string') return response;
  }
  return error instanceof Error ? error.message : String(error);
}
