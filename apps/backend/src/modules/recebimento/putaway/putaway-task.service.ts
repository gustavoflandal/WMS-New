// DOC-04 RF-REC-042 (execução do putaway) + RF-REC-043 (conclusão da ordem).
// §5.2: CREATED -> ASSIGNED -> IN_EXECUTION -> DONE; ramos CANCELLED e
// REJECTED_SCAN (leitura divergente, volta a ASSIGNED).
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { PutawayEngineService } from './putaway-engine.service.js';
import { mapRecebimentoDbError } from '../shared/db-error.util.js';
import { StockMovementService } from '../../estoque/movement/stock-movement.service.js';
import { StockBucket } from '../../estoque/movement/stock-movement-effects.util.js';

export interface ExecutePutawayInput {
  /** RNF-ARQ-050: id gerado no coletor; repetir a MESMA operação devolve o MESMO resultado. */
  operationId: string;
  /** RG-007/RN-DAD-011: leitura 1 — LPN do palete. */
  scannedLpn: string;
  /** RN-DAD-011: leitura 2 — código do endereço de destino. */
  scannedLocationCode: string;
  /** RN-REC-041: obrigatório quando o endereço lido difere do designado. */
  overrideReason?: string;
  /**
   * DOC-17 RN-TEL-012 item 3 — origem da execução, para auditar e comparar
   * acuracidade entre modos. `PWA` (padrão) = coletor; `PAPEL` = transcrição
   * de Formulário de Campo (DOC-17 §8); `WEB` = execução por tela (§6).
   * A REGRA não muda com a origem (RN-TEL-011): muda só o registro.
   */
  origin?: 'PWA' | 'WEB' | 'PAPEL';
}

// RF-REC-042: "Confirmação credita stock_balance no endereço (parcela
// conforme estado do lote)".
// [LACUNA: DOC-04 não tabela o mapeamento batch.status -> parcela do saldo, e
// a seção de bloqueios/reclassificações do DOC-05 (§4.4) não está no contexto
// autorizado desta sessão. Mapeamento adotado, derivado dos nomes das
// próprias parcelas de wms.stock_balance (DOC-02 §5.5): QUARANTINE ->
// qty_quarantine (coerente com RN-REC-031), BLOCKED/RECALLED -> qty_blocked,
// RELEASED ou palete sem lote -> qty_available.]
// DOC-17 RD-TEL-004 — a origem da execução (RN-TEL-012 item 3) determina o
// canal gravado na movimentação. Mapa explícito para que acrescentar uma
// origem nova obrigue a decidir o canal, em vez de cair num default calado.
const EXECUTION_CHANNEL_BY_ORIGIN: Record<'PWA' | 'WEB' | 'PAPEL', 'COLETOR' | 'TELA' | 'FORMULARIO'> = {
  PWA: 'COLETOR',
  WEB: 'TELA',
  PAPEL: 'FORMULARIO',
};

const BUCKET_BY_BATCH_STATUS: Record<string, StockBucket> = {
  QUARANTINE: 'QUARANTINE',
  BLOCKED: 'BLOCKED',
  RECALLED: 'BLOCKED',
  RELEASED: 'AVAILABLE',
};

@Injectable()
export class PutawayTaskService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService,
    @Inject(PutawayEngineService) private readonly putawayEngineService: PutawayEngineService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService,
    // RG-015 item 3 — abertura da exceção de transbordo do Armazém Lógico.
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService
  ) {}

  /**
   * RF-REC-042 — "Cada palete gera uma Tarefa de putaway atribuível".
   * §5.1: LABELING -> PUTAWAY_IN_PROGRESS ("tarefas geradas"). Paletes de
   * cross-docking (RF-REC-051, "sem putaway de armazenagem") são excluídos.
   */
  async generateTasksForOrder(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const orderResult = await this.db.query(ctx, `SELECT * FROM wms.inbound_order WHERE id = $1`, [orderId]);
    const order = orderResult.rows[0];
    if (!order) throw new NotFoundException(`inbound_order ${orderId} not found`);
    if (order.status !== 'LABELING') {
      throw new BadRequestException({
        error: 'ORDER_NOT_LABELING',
        detail: `§5.1: geração de tarefas exige ordem em LABELING (status atual: ${order.status})`,
      });
    }

    // Paletes da ordem que NÃO são de cross-docking e ainda não têm tarefa.
    const palletsResult = await this.db.query(
      ctx,
      `SELECT pl.id, pl.lpn
       FROM wms.pallet pl
       WHERE pl.inbound_order_id = $1
         AND NOT EXISTS (SELECT 1 FROM wms.crossdock_link cl WHERE cl.pallet_id = pl.id AND cl.status = 'CONSUMED')
         AND NOT EXISTS (SELECT 1 FROM wms.putaway_task pt WHERE pt.pallet_id = pl.id AND pt.status <> 'CANCELLED')`,
      [orderId]
    );

    const created = await this.db.transaction(ctx, async (client) => {
      const tasks = [];
      for (const pallet of palletsResult.rows) {
        tasks.push(await this.createTaskWithClient(client, { tenantId, warehouseId, palletId: pallet.id, inboundOrderId: orderId }, actorUserId));
      }

      if (tasks.length > 0) {
        await client.query(`UPDATE wms.inbound_order SET status = 'PUTAWAY_IN_PROGRESS', updated_at = now(), updated_by = $2 WHERE id = $1`, [orderId, actorUserId]);
        const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [orderId]);
        if (flowResult.rows.length > 0) {
          await this.operationFlowService.completeStep(client, flowResult.rows[0].id, 'ETIQUETAGEM', actorUserId);
        }
      }
      return tasks;
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'inbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 RF-REC-042',
      before: order,
      after: { ...order, status: created.length > 0 ? 'PUTAWAY_IN_PROGRESS' : order.status, putaway_tasks_created: created.length },
    });

    return created;
  }

  /** Insere UMA tarefa dentro da transação do chamador (reusado por RF-REC-051, cancelamento de cross-docking). */
  async createTaskWithClient(
    client: PoolClient,
    input: { tenantId: string; warehouseId: string; palletId: string; inboundOrderId: string | null; crossdockLinkId?: string | null; priority?: number },
    actorUserId: string
  ) {
    const result = await client.query(
      `INSERT INTO wms.putaway_task (tenant_id, warehouse_id, pallet_id, inbound_order_id, crossdock_link_id, priority, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'CREATED',$7) RETURNING *`,
      [input.tenantId, input.warehouseId, input.palletId, input.inboundOrderId, input.crossdockLinkId ?? null, input.priority ?? 100, actorUserId]
    );
    return result.rows[0];
  }

  /**
   * RF-REC-042 — "fila por prioridade e proximidade". Proximidade medida pela
   * matriz REC.MAPA_DISTANCIA_DOCA_ZONA (RF-REC-003) entre a doca da ordem e
   * a zona do endereço designado; tarefa sem endereço designado ainda não tem
   * proximidade conhecida e vai para o fim do desempate.
   */
  async listQueue(tenantId: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT pt.*, pl.lpn, l.code AS designated_location_code,
              dzd.distance_m
       FROM wms.putaway_task pt
       JOIN wms.pallet pl ON pl.id = pt.pallet_id
       LEFT JOIN wms.location l ON l.id = pt.location_id_designated
       LEFT JOIN wms.inbound_order io ON io.id = pt.inbound_order_id
       LEFT JOIN wms.dock_zone_distance dzd
              ON dzd.warehouse_id = pt.warehouse_id AND dzd.dock_id = io.dock_id AND dzd.zone_id = l.zone_id
       WHERE pt.warehouse_id = $1 AND pt.status IN ('CREATED', 'ASSIGNED', 'IN_EXECUTION', 'REJECTED_SCAN')
         AND pt.field_form_id IS NULL
       ORDER BY pt.priority ASC, dzd.distance_m ASC NULLS LAST, pt.created_at ASC`,
      [warehouseId]
    );
    return result.rows;
  }

  /**
   * §5.2: CREATED -> ASSIGNED. Já calcula e grava a sugestão do motor
   * (RN-REC-040) para que o operador receba o endereço designado junto da
   * atribuição.
   */
  async assignTask(
    taskId: string,
    assignedToUserId: string,
    tenantId: string,
    warehouseId: string,
    actorUserId: string,
    overflowExceptionId?: string | null,
    /** DOC-17 §8 — id do Formulário de Campo cuja transcrição está atribuindo esta tarefa (ver guarda de RN-TEL-021 abaixo). */
    viaFieldFormId?: string | null
  ) {
    const task = await this.loadTask(taskId, tenantId, warehouseId, actorUserId);
    if (!['CREATED', 'REJECTED_SCAN'].includes(task.status)) {
      throw new BadRequestException({
        error: 'TASK_NOT_ASSIGNABLE',
        detail: `§5.2: tarefa ${taskId} não está CREATED nem REJECTED_SCAN (status atual: ${task.status})`,
      });
    }
    // DOC-17 RN-TEL-021: tarefa reservada por um Formulário de Campo não pode
    // ser atribuída por OUTRO canal — evita execução duplicada (papel +
    // coletor/tela). A transcrição daquele MESMO formulário (§8) não é outro
    // canal: é o canal dele, e passa `viaFieldFormId` para atravessar a
    // guarda. Qualquer outro id (ou nenhum) continua barrado.
    if (task.field_form_id && task.field_form_id !== viaFieldFormId) {
      throw new BadRequestException({ error: 'TASK_RESERVED_BY_FIELD_FORM', detail: `DOC-17 RN-TEL-021: tarefa ${taskId} está reservada pelo Formulário de Campo ${task.field_form_id}` });
    }

    // RG-015 item 3 — autorização ANTES de qualquer efeito, mesmo padrão da
    // RN-EST-013 (StockReservationService.assertPolicyBreakAuthorized).
    if (overflowExceptionId) {
      await this.assertOverflowApproved(overflowExceptionId, taskId, tenantId, warehouseId, actorUserId);
    }

    const engineResult = await this.putawayEngineService.suggestLocations(task.pallet_id, tenantId, warehouseId, actorUserId, {
      allowLogicalWarehouseOverflow: Boolean(overflowExceptionId),
    });

    if (!engineResult.suggestion) {
      // RG-015 item 3 [INVIOLÁVEL]: "SE não houver endereço com capacidade
      // disponível dentro do Armazém Lógico (transbordo), ENTÃO o sistema
      // DEVE bloquear a operação E ABRIR EXCEÇÃO no Workflow de Aprovação".
      // Sem isto a operação ficava sem saída nenhuma — palete parado e
      // nenhuma exceção para alguém decidir.
      if (engineResult.logicalWarehouseOverflow) {
        const exception = await this.openOverflowException(task, tenantId, warehouseId, actorUserId);
        throw new ConflictException({
          error: 'LOGICAL_WAREHOUSE_OVERFLOW',
          detail:
            `RG-015 item 3: não há endereço com capacidade dentro do Armazém Lógico do cliente. ` +
            `Exceção ${exception.id} (EST.TRANSBORDO_ARMAZEM_LOGICO) aberta — a alocação temporária fora do Armazém Lógico ` +
            `exige aprovação com EST.LOGICAL_WAREHOUSE_OVERFLOW; reenvie a atribuição informando overflow_exception_id.`,
          exception_id: exception.id,
        });
      }
      throw new BadRequestException({
        error: 'NO_LOCATION_APPROVED',
        detail:
          `RN-REC-040: nenhum endereço passou na Fase 1 para o palete ${task.pallet_id} — ` +
          `${engineResult.rejected.length} endereço(s) reprovado(s). Motivos: ` +
          engineResult.rejected.slice(0, 5).map((r) => r.reason).join(' | '),
      });
    }

    const updated = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `UPDATE wms.putaway_task
       SET status = 'ASSIGNED', assigned_to_user_id = $2, location_id_designated = $3, assigned_at = now(),
           is_overflow = $5, overflow_exception_id = $6, updated_at = now(), updated_by = $4
       WHERE id = $1 RETURNING *`,
      [taskId, assignedToUserId, engineResult.suggestion.locationId, actorUserId, Boolean(overflowExceptionId), overflowExceptionId ?? null]
    );

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'putaway_task',
      entityId: taskId,
      // RG-003: transbordo é decisão autorizada por exceção, não atribuição
      // de rotina — registra como OVERRIDE, com o motivo aprovado.
      action: overflowExceptionId ? 'OVERRIDE' : 'STATUS_CHANGE',
      requirementId: overflowExceptionId ? 'DOC-00 RG-015 item 3' : 'DOC-04 RF-REC-042',
      before: task,
      after: updated.rows[0],
      reason: overflowExceptionId ? `Transbordo do Armazém Lógico autorizado pela exceção ${overflowExceptionId}` : undefined,
    });

    return { task: updated.rows[0], suggestion: engineResult.suggestion, alternatives: engineResult.alternatives, isOverflow: Boolean(overflowExceptionId) };
  }

  /**
   * RG-015 item 3 — abre a exceção que destrava o transbordo. Reaproveita
   * uma exceção ainda PENDING/ESCALATED/APPROVED da mesma tarefa em vez de
   * empilhar duplicatas a cada tentativa de atribuição.
   */
  private async openOverflowException(task: { id: string; pallet_id: string }, tenantId: string, warehouseId: string, actorUserId: string): Promise<{ id: string }> {
    const existing = await this.db.query<{ id: string }>(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT id FROM wms.operational_exception
       WHERE exception_type = 'EST.TRANSBORDO_ARMAZEM_LOGICO' AND entity = 'putaway_task' AND entity_id = $1
         AND status IN ('PENDING', 'ESCALATED', 'APPROVED')
       ORDER BY created_at DESC LIMIT 1`,
      [task.id]
    );
    if (existing.rows[0]) return existing.rows[0];

    const created = await this.operationalExceptionService.create({
      tenantId,
      exceptionType: 'EST.TRANSBORDO_ARMAZEM_LOGICO',
      warehouseId,
      entity: 'putaway_task',
      entityId: task.id,
      reasonRequest: `RG-015 item 3: Armazém Lógico do cliente sem endereço com capacidade para o palete ${task.pallet_id}`,
      requestedBy: actorUserId,
    });
    return created as { id: string };
  }

  /** RG-015 item 3 — a alocação fora do Armazém Lógico só vale com a exceção APROVADA, da própria tarefa. */
  private async assertOverflowApproved(exceptionId: string, taskId: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<void> {
    const result = await this.db.query<{ status: string; entity: string; entity_id: string; warehouse_id: string; exception_type: string }>(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT status, entity, entity_id, warehouse_id, exception_type FROM wms.operational_exception WHERE id = $1`,
      [exceptionId]
    );
    const exception = result.rows[0];
    if (!exception) throw new NotFoundException(`operational_exception ${exceptionId} not found`);
    if (exception.exception_type !== 'EST.TRANSBORDO_ARMAZEM_LOGICO') {
      throw new BadRequestException({ error: 'WRONG_EXCEPTION_TYPE', detail: `RG-015 item 3: esperado EST.TRANSBORDO_ARMAZEM_LOGICO, recebido ${exception.exception_type}` });
    }
    if (exception.entity !== 'putaway_task' || exception.entity_id !== taskId) {
      throw new BadRequestException({ error: 'EXCEPTION_ENTITY_MISMATCH', detail: `RG-015 item 3: a exceção ${exceptionId} não pertence à tarefa ${taskId}` });
    }
    if (exception.warehouse_id !== warehouseId) {
      throw new BadRequestException({ error: 'EXCEPTION_WAREHOUSE_MISMATCH', detail: 'RG-015 item 3: a exceção de transbordo pertence a outro armazém' });
    }
    if (exception.status !== 'APPROVED') {
      throw new ConflictException({
        error: 'OVERFLOW_NOT_APPROVED',
        detail: `RG-015 item 3: a exceção EST.TRANSBORDO_ARMAZEM_LOGICO precisa estar APROVADA ANTES da alocação fora do Armazém Lógico (status atual: ${exception.status})`,
      });
    }
  }

  /**
   * RF-REC-042 [INVIOLÁVEL na parte de filtros] — execução com DUPLA LEITURA:
   * LPN -> deslocamento -> etiqueta do endereço destino (RN-DAD-011).
   * "Divergência de leitura (endereço ≠ designado) sem permissão de override
   * DEVE ser rejeitada no ato."
   *
   * Idempotente por `operationId` (RNF-ARQ-050): a mesma operação reenviada
   * pelo coletor após reconexão devolve o resultado original, sem creditar
   * saldo duas vezes.
   */
  async executeTask(taskId: string, input: ExecutePutawayInput, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    // RNF-ARQ-050 — idempotência ANTES de qualquer efeito colateral.
    const existing = await this.db.query(ctx, `SELECT result FROM wms.putaway_operation WHERE operation_id = $1`, [input.operationId]);
    if (existing.rows.length > 0) {
      return { ...existing.rows[0].result, idempotent_replay: true };
    }

    const task = await this.loadTask(taskId, tenantId, warehouseId, actorUserId);
    if (!['ASSIGNED', 'IN_EXECUTION', 'REJECTED_SCAN'].includes(task.status)) {
      throw new BadRequestException({ error: 'TASK_NOT_EXECUTABLE', detail: `§5.2: tarefa ${taskId} não está em execução (status atual: ${task.status})` });
    }

    // ── Leitura 1: LPN (RG-007) ────────────────────────────────────────────
    const palletResult = await this.db.query(ctx, `SELECT * FROM wms.pallet WHERE id = $1`, [task.pallet_id]);
    const pallet = palletResult.rows[0];
    if (!pallet) throw new NotFoundException(`pallet ${task.pallet_id} not found`);
    if (pallet.lpn !== input.scannedLpn) {
      throw new BadRequestException({
        error: 'LPN_MISMATCH',
        detail: `RG-007/RF-REC-042: LPN lido (${input.scannedLpn}) não é o da tarefa ${taskId} (${pallet.lpn})`,
      });
    }

    // ── Leitura 2: endereço destino (RN-DAD-011) ───────────────────────────
    const scannedResult = await this.db.queryGlobal(`SELECT id, code, zone_id FROM wms.location WHERE warehouse_id = $1 AND code = $2`, [
      warehouseId,
      input.scannedLocationCode,
    ]);
    const scanned = scannedResult.rows[0];
    if (!scanned) {
      throw new BadRequestException({ error: 'LOCATION_NOT_FOUND', detail: `RN-DAD-011: endereço ${input.scannedLocationCode} não existe no armazém` });
    }

    const isDivergent = scanned.id !== task.location_id_designated;
    let overrideApplied = false;

    if (isDivergent) {
      // "Divergência de leitura sem permissão de override DEVE ser rejeitada
      // NO ATO" — a tarefa permanece pendente NO ENDEREÇO DESIGNADO (§5.2:
      // REJECTED_SCAN volta a ASSIGNED).
      const hasOverride = await this.rbacService.hasPermission(actorUserId, 'EST.PUTAWAY_OVERRIDE', { warehouseId, clientId: tenantId });
      if (!hasOverride) {
        await this.db.query(
          ctx,
          `UPDATE wms.putaway_task SET status = 'ASSIGNED', updated_at = now(), updated_by = $2 WHERE id = $1`,
          [taskId, actorUserId]
        );
        await this.auditService.record({
          tenantId,
          warehouseId,
          userId: actorUserId,
          origin: input.origin ?? 'PWA', // DOC-17 RN-TEL-012 item 3
          entity: 'putaway_task',
          entityId: taskId,
          action: 'STATUS_CHANGE',
          requirementId: 'DOC-04 RF-REC-042',
          reason: `Leitura divergente rejeitada: lido ${input.scannedLocationCode}, designado outro endereço`,
          before: task,
          after: { ...task, status: 'ASSIGNED', rejected_scan: true },
        });
        throw new ForbiddenException({
          error: 'SCAN_LOCATION_MISMATCH',
          detail:
            `RF-REC-042: endereço lido (${input.scannedLocationCode}) difere do designado e o operador não possui EST.PUTAWAY_OVERRIDE — ` +
            `rejeitado no ato; a tarefa permanece pendente no endereço designado`,
        });
      }

      // RN-REC-041: override exige motivo...
      if (!input.overrideReason || input.overrideReason.trim().length === 0) {
        throw new BadRequestException({ error: 'OVERRIDE_REASON_REQUIRED', detail: 'RN-REC-041: a escolha de endereço diferente da sugestão exige motivo' });
      }

      // ...e SÓ vale se o endereço estiver aprovado na Fase 1. Este é o ponto
      // que materializa "endereço reprovado em qualquer filtro NÃO PODE ser
      // aceito por override" (RN-REC-040 [INVIOLÁVEL]).
      const verdict = await this.putawayEngineService.evaluateSingleLocation(task.pallet_id, scanned.id, tenantId, warehouseId, actorUserId);
      if (verdict.verdict === 'REJECTED_LEGAL') {
        throw new ForbiddenException({
          error: 'PHASE1_VIOLATION_NO_OVERRIDE',
          detail: `RN-REC-040/RN-REC-041: ${verdict.reason} — reprovação da Fase 1 não admite override por nenhum papel`,
        });
      }
      // REJECTED_OPERATIONAL é superável (RG-005 + RN-EST-021) com a permissão
      // e o motivo já validados acima.
      overrideApplied = true;
    }

    const result = await this.db.transaction(ctx, async (client) => {
      const contents = await client.query(
        `SELECT pc.product_id, pc.batch_id, pc.qty, b.status AS batch_status
         FROM wms.pallet_content pc LEFT JOIN wms.batch b ON b.id = pc.batch_id
         WHERE pc.pallet_id = $1`,
        [task.pallet_id]
      );

      for (const content of contents.rows) {
        const bucket = BUCKET_BY_BATCH_STATUS[content.batch_status ?? 'RELEASED'] ?? BUCKET_BY_BATCH_STATUS.RELEASED;

        // RN-EST-001 [INVIOLÁVEL] (DOC-05 §4.1): StockMovementService é o
        // ÚNICO caminho para alterar stock_balance — sem locationIdFrom (não
        // há staging creditado antes do putaway, DOC-04 RF-REC-042), o
        // serviço trata como crédito puro no destino (ver comentário em
        // stock-movement.service.ts), registrando ainda assim o
        // movement_type PUTAWAY do catálogo fechado.
        await this.stockMovementService.apply(client, {
          tenantId,
          warehouseId,
          movementType: 'PUTAWAY',
          productId: content.product_id,
          batchId: content.batch_id,
          qty: Number(content.qty),
          locationIdTo: scanned.id,
          palletIdTo: task.pallet_id,
          bucketFromOverride: bucket,
          taskId,
          // DOC-17 RD-TEL-004 — o canal da movimentação decorre da origem da
          // execução: coletor (PWA), tela (WEB) ou papel (PAPEL/transcrição).
          executionChannel: EXECUTION_CHANNEL_BY_ORIGIN[input.origin ?? 'PWA'],
          actorUserId,
        });
      }

      await client.query(`UPDATE wms.pallet SET current_location_id = $2, status = 'STORED', updated_at = now(), updated_by = $3 WHERE id = $1`, [
        task.pallet_id,
        scanned.id,
        actorUserId,
      ]);

      const updatedTask = await client.query(
        `UPDATE wms.putaway_task
         SET status = 'DONE', location_id_executed = $2, override_reason = $3, completed_at = now(), updated_at = now(), updated_by = $4
         WHERE id = $1 RETURNING *`,
        [taskId, scanned.id, overrideApplied ? input.overrideReason : null, actorUserId]
      );

      const payload = {
        putaway_task_id: taskId,
        pallet_id: task.pallet_id,
        lpn: pallet.lpn,
        location_id: scanned.id,
        location_code: scanned.code,
        override_applied: overrideApplied,
      };
      await this.eventsService.publishInTransaction(client, {
        event_type: 'recebimento.putaway_concluido',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload,
      });

      // RNF-ARQ-050: grava o resultado NA MESMA transação do efeito — se a
      // transação falhar, a operação não fica marcada como executada.
      const response = { ...payload, task: updatedTask.rows[0], idempotent_replay: false };
      await client.query(
        `INSERT INTO wms.putaway_operation (operation_id, tenant_id, warehouse_id, putaway_task_id, result, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.operationId, tenantId, warehouseId, taskId, JSON.stringify(response), actorUserId]
      );

      return response;
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: input.origin ?? 'PWA', // DOC-17 RN-TEL-012 item 3
      entity: 'putaway_task',
      entityId: taskId,
      // RN-REC-041/AD-006: "gera auditoria OVERRIDE".
      action: overrideApplied ? 'OVERRIDE' : 'MOVE',
      requirementId: overrideApplied ? 'DOC-04 RN-REC-041' : 'DOC-04 RF-REC-042',
      reason: overrideApplied ? input.overrideReason : null,
      before: task,
      after: result.task,
    });

    if (task.inbound_order_id) {
      await this.completeOrderIfAllStored(task.inbound_order_id, tenantId, warehouseId, actorUserId);
    }

    return result;
  }

  /**
   * RF-REC-043 — "QUANDO todos os paletes estiverem armazenados (ou
   * destinados a cross-docking), o Fluxo Operacional conclui (Fim), a doca é
   * liberada e o evento recebimento.concluido é publicado".
   */
  async completeOrderIfAllStored(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const orderResult = await this.db.query(ctx, `SELECT * FROM wms.inbound_order WHERE id = $1`, [orderId]);
    const order = orderResult.rows[0];
    if (!order || order.status !== 'PUTAWAY_IN_PROGRESS') return null;

    const pendingResult = await this.db.query(
      ctx,
      `SELECT COUNT(*) AS count FROM wms.putaway_task WHERE inbound_order_id = $1 AND status NOT IN ('DONE', 'CANCELLED')`,
      [orderId]
    );
    if (Number(pendingResult.rows[0].count) > 0) return null;

    const completed = await this.db.transaction(ctx, async (client) => {
      const updated = await client.query(
        `UPDATE wms.inbound_order SET status = 'COMPLETED', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [orderId, actorUserId]
      );

      const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [orderId]);
      if (flowResult.rows.length > 0) {
        await this.operationFlowService.completeStep(client, flowResult.rows[0].id, 'PUTAWAY', actorUserId);
        await this.operationFlowService.completeStep(client, flowResult.rows[0].id, 'FIM', actorUserId);
      }

      // RF-REC-043: "a doca é liberada". Feito por SQL direto e não via
      // DockService.releaseDock() porque aquele método exige a doca em
      // OCCUPIED e é a rota MANUAL (REC.LIBERAR_DOCA); aqui é a liberação
      // AUTOMÁTICA na conclusão, que não deve falhar se a doca já tiver sido
      // liberada antes (ex.: veículo já saiu).
      if (order.dock_id) {
        await client.query(`UPDATE wms.dock SET status = 'FREE', updated_at = now(), updated_by = $2 WHERE id = $1 AND status = 'OCCUPIED'`, [
          order.dock_id,
          actorUserId,
        ]);
      }

      await this.eventsService.publishInTransaction(client, {
        event_type: 'recebimento.concluido',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { inbound_order_id: orderId, number: order.number },
      });

      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'inbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 RF-REC-043',
      before: order,
      after: completed,
    });

    return completed;
  }

  /**
   * DOC-17 RN-TEL-021 — candidatas a reserva por Formulário de Campo: mesma
   * elegibilidade de `assignTask` (CREATED/REJECTED_SCAN), ainda sem forma
   * alguma vinculada. Usado pelo FieldFormService antes de travar as tarefas
   * na transação de emissão.
   */
  async loadLockableTasks(taskIds: string[], tenantId: string, warehouseId: string, actorUserId: string) {
    if (taskIds.length === 0) return [];
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT pt.*, pl.lpn
       FROM wms.putaway_task pt
       JOIN wms.pallet pl ON pl.id = pt.pallet_id
       WHERE pt.id = ANY($1::uuid[]) AND pt.warehouse_id = $2
         AND pt.status IN ('CREATED', 'REJECTED_SCAN') AND pt.field_form_id IS NULL`,
      [taskIds, warehouseId]
    );
    return result.rows;
  }

  /** DOC-17 RN-TEL-021 — vincula a tarefa ao formulário (marca "EM_FORMULARIO"). Roda na transação de FieldFormService. */
  async lockForFieldForm(client: PoolClient, taskId: string, fieldFormId: string, actorUserId: string): Promise<void> {
    const result = await client.query(
      `UPDATE wms.putaway_task SET field_form_id = $2, updated_at = now(), updated_by = $3
       WHERE id = $1 AND status IN ('CREATED', 'REJECTED_SCAN') AND field_form_id IS NULL`,
      [taskId, fieldFormId, actorUserId]
    );
    if (result.rowCount === 0) {
      throw new BadRequestException({ error: 'TASK_NOT_LOCKABLE', detail: `DOC-17 RN-TEL-021: tarefa ${taskId} não está mais disponível para reserva (atribuída ou já em outro formulário)` });
    }
  }

  /** DOC-17 RN-TEL-021 — "cancelamento ou expiração do formulário devolve as tarefas à fila". */
  async releaseFieldFormLock(client: PoolClient, fieldFormId: string, actorUserId: string): Promise<void> {
    await client.query(`UPDATE wms.putaway_task SET field_form_id = NULL, updated_at = now(), updated_by = $2 WHERE field_form_id = $1`, [fieldFormId, actorUserId]);
  }

  private async loadTask(taskId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.putaway_task WHERE id = $1`,
      [taskId]
    );
    const task = result.rows[0];
    if (!task) throw new NotFoundException(`putaway_task ${taskId} not found`);
    return task;
  }
}
