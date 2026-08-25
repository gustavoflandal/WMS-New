// DOC-07 §4.1/§4.2 — Ordem de Devolução: criação (RF-REV-001, RN-REV-003),
// autorização/negação (RN-REV-002), vínculo de chegada e doca/descarga
// mínimos (ver docs/PROMPT-SESSAO-9A-doc07-reversa-nucleo.md §3/4 para a
// justificativa de não reaproveitar GateInService/DockService diretamente).
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { resolveReturnOrderTransition } from './return-order-state-machine.util.js';

// RF-REV-010: "Chegada -> Doca -> Descarga -> Triagem -> Destinação -> Fim"
// (Chegada/Doca/Descarga reutilizam a MECÂNICA do DOC-03/04 — não o código
// de DockService, hardcoded para inbound_order; ver decisão 4 do prompt).
const RETURN_FLOW_STEPS = ['CHEGADA', 'DOCA', 'DESCARGA', 'TRIAGEM', 'DESTINACAO', 'FIM'];

export type ReturnOrderType = 'DEVOLUCAO_CLIENTE_FINAL' | 'AVARIA_TRANSPORTE' | 'REVERSA_AVULSA';

export interface CreateReturnOrderItemInput {
  productId: string;
  qty: number;
  /** RN-REV-003: item do Pedido de origem que esta linha devolve. Obrigatório para tipos com pedido de origem, salvo aprovação prévia via `approvedExceptionId`. */
  sourceOutboundOrderItemId?: string | null;
  /** RN-REV-003 (item fora do pedido de origem): id de uma REV.ITEM_NAO_EXPEDIDO já APPROVED para este produto/ordem. */
  approvedExceptionId?: string | null;
}

export interface CreateReturnOrderInput {
  tenantId: string;
  warehouseId: string;
  type: ReturnOrderType;
  sourceOutboundOrderId?: string | null;
  items: CreateReturnOrderItemInput[];
}

@Injectable()
export class ReturnOrderService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService,
    @Inject(DocumentNumberingService) private readonly documentNumberingService: DocumentNumberingService
  ) {}

  /**
   * RF-REV-001/RN-REV-003. Item cuja quantidade excede o restante expedido é
   * REJEITADO informando o limite (cenário Gherkin §6 — não é workflow de
   * exceção, é validação direta). Item sem `sourceOutboundOrderItemId` (fora
   * do pedido de origem) exige `approvedExceptionId` de uma
   * REV.ITEM_NAO_EXPEDIDO já `APPROVED` para o mesmo produto — do contrário
   * abre a exceção e rejeita a criação, pedindo nova tentativa após decisão
   * (mesmo padrão de `outbound-reversal.service.ts::assertApprovedException`).
   */
  async createReturnOrder(input: CreateReturnOrderInput, actorUserId: string) {
    if (input.type !== 'REVERSA_AVULSA' && !input.sourceOutboundOrderId) {
      throw new BadRequestException({ error: 'SOURCE_ORDER_REQUIRED', detail: `RF-REV-001: tipo ${input.type} exige sourceOutboundOrderId` });
    }
    if (input.items.length === 0) {
      throw new BadRequestException({ error: 'NO_ITEMS', detail: 'RD-REV-001: a Ordem de Devolução precisa de ao menos um item' });
    }

    const ctx = { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId };

    let sourceOrder: { id: string; status: string } | null = null;
    if (input.sourceOutboundOrderId) {
      const sourceResult = await this.db.query<{ id: string; status: string }>(
        ctx,
        `SELECT id, status FROM wms.outbound_order WHERE id = $1`,
        [input.sourceOutboundOrderId]
      );
      sourceOrder = sourceResult.rows[0] ?? null;
      if (!sourceOrder) throw new NotFoundException(`outbound_order ${input.sourceOutboundOrderId} not found`);
      if (sourceOrder.status !== 'COMPLETED') {
        throw new BadRequestException({
          error: 'SOURCE_ORDER_NOT_COMPLETED',
          detail: `RF-REV-001: pedido de origem deve estar COMPLETED (atual: ${sourceOrder.status})`,
        });
      }
    }

    const result = await this.db.transaction(ctx, async (client) => {
      const number = await this.documentNumberingService.generateDocumentNumber(
        client,
        'RETURN_ORDER',
        input.warehouseId,
        await this.loadWarehouseCode(client, input.warehouseId),
        actorUserId
      );

      const orderResult = await client.query(
        `INSERT INTO wms.return_order (tenant_id, warehouse_id, number, type, status, source_outbound_order_id, requested_by, created_by)
         VALUES ($1,$2,$3,$4,'REQUESTED',$5,$6,$6) RETURNING *`,
        [input.tenantId, input.warehouseId, number, input.type, input.sourceOutboundOrderId ?? null, actorUserId]
      );
      const order = orderResult.rows[0];

      let lineNumber = 1;
      for (const item of input.items) {
        await this.validateAndInsertItem(client, order.id, input, item, lineNumber, actorUserId);
        lineNumber += 1;
      }

      await this.eventsService.publishInTransaction(client, {
        event_type: 'reversa.ordem_criada',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: actorUserId,
        payload: { return_order_id: order.id, number, type: input.type },
      });

      return order;
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'return_order',
      entityId: result.id,
      action: 'CREATE',
      requirementId: 'DOC-07 RF-REV-001',
      after: result,
    });

    return result;
  }

  private async validateAndInsertItem(
    client: PoolClient,
    returnOrderId: string,
    order: CreateReturnOrderInput,
    item: CreateReturnOrderItemInput,
    lineNumber: number,
    actorUserId: string
  ) {
    let sourceItemId: string | null = null;

    if (order.type !== 'REVERSA_AVULSA') {
      let sourceItem: { id: string; product_id: string } | null = null;

      if (item.sourceOutboundOrderItemId) {
        const r = await client.query(`SELECT id, product_id FROM wms.outbound_order_item WHERE id = $1 AND outbound_order_id = $2`, [
          item.sourceOutboundOrderItemId,
          order.sourceOutboundOrderId,
        ]);
        sourceItem = r.rows[0] ?? null;
        if (!sourceItem || sourceItem.product_id !== item.productId) {
          throw new BadRequestException({
            error: 'SOURCE_ITEM_MISMATCH',
            detail: `RN-REV-003: item ${item.sourceOutboundOrderItemId} não pertence ao pedido de origem ou produto não confere`,
          });
        }
      } else {
        const r = await client.query(`SELECT id, product_id FROM wms.outbound_order_item WHERE outbound_order_id = $1 AND product_id = $2 LIMIT 1`, [
          order.sourceOutboundOrderId,
          item.productId,
        ]);
        sourceItem = r.rows[0] ?? null;
      }

      if (!sourceItem) {
        // RN-REV-003: item fora do pedido de origem — exige exceção aprovada.
        if (item.approvedExceptionId) {
          await this.assertApprovedException(client, order.tenantId, order.warehouseId, item.approvedExceptionId, 'REV.ITEM_NAO_EXPEDIDO');
        } else {
          const exception = await this.operationalExceptionService.create({
            tenantId: order.tenantId,
            warehouseId: order.warehouseId,
            exceptionType: 'REV.ITEM_NAO_EXPEDIDO',
            entity: 'return_order',
            entityId: returnOrderId,
            qty: item.qty,
            reasonRequest: `DOC-07 RN-REV-003: produto ${item.productId} não consta do pedido de origem ${order.sourceOutboundOrderId}`,
            requestedBy: actorUserId,
          });
          throw new ConflictException({
            error: 'ITEM_NOT_IN_SOURCE_ORDER',
            detail: `RN-REV-003: item fora do pedido de origem — exceção REV.ITEM_NAO_EXPEDIDO ${exception.id} aberta, aguarde decisão e reenvie com approvedExceptionId`,
            exceptionId: exception.id,
          });
        }
      } else {
        sourceItemId = sourceItem.id;

        const shippedResult = await client.query<{ shipped: string }>(
          `SELECT COALESCE(SUM(pc.qty), 0) AS shipped FROM wms.package_content pc WHERE pc.outbound_order_item_id = $1`,
          [sourceItem.id]
        );
        const shippedQty = Number(shippedResult.rows[0].shipped);

        const alreadyReturnedResult = await client.query<{ returned: string }>(
          `SELECT COALESCE(SUM(roi.qty_authorized), 0) AS returned
           FROM wms.return_order_item roi
           JOIN wms.return_order ro ON ro.id = roi.return_order_id
           WHERE roi.source_outbound_order_item_id = $1 AND ro.status NOT IN ('DENIED', 'CANCELLED')`,
          [sourceItem.id]
        );
        const alreadyReturned = Number(alreadyReturnedResult.rows[0].returned);
        const remaining = shippedQty - alreadyReturned;

        if (item.qty > remaining) {
          throw new BadRequestException({
            error: 'RETURN_QTY_EXCEEDS_SHIPPED',
            detail: `RN-REV-003: quantidade devolvida (${item.qty}) excede o limite restante de ${remaining} (expedido ${shippedQty}, já devolvido ${alreadyReturned})`,
          });
        }
      }
    }

    await client.query(
      `INSERT INTO wms.return_order_item (tenant_id, return_order_id, line_number, product_id, source_outbound_order_item_id, qty_authorized, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [order.tenantId, returnOrderId, lineNumber, item.productId, sourceItemId, item.qty, actorUserId]
    );
  }

  /** Mesmo padrão de outbound-reversal.service.ts::assertApprovedException. */
  private async assertApprovedException(client: PoolClient, tenantId: string, warehouseId: string, exceptionId: string, expectedType: string) {
    const result = await client.query(`SELECT * FROM wms.operational_exception WHERE id = $1`, [exceptionId]);
    const exception = result.rows[0];
    if (!exception || exception.tenant_id !== tenantId || exception.warehouse_id !== warehouseId) {
      throw new NotFoundException(`operational_exception ${exceptionId} not found`);
    }
    if (exception.exception_type !== expectedType) {
      throw new BadRequestException({ error: 'EXCEPTION_TYPE_MISMATCH', detail: `esperado ${expectedType}, encontrado ${exception.exception_type}` });
    }
    if (exception.status !== 'APPROVED') {
      throw new BadRequestException({ error: 'EXCEPTION_NOT_APPROVED', detail: `exceção ${exceptionId} não está APPROVED (status: ${exception.status})` });
    }
    return exception;
  }

  /** RN-REV-002 — Cliente (REV.AUTORIZAR) ou interno com a permissão. */
  async authorize(returnOrderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    return this.transitionSimple(returnOrderId, tenantId, warehouseId, 'REQUESTED', 'AUTORIZAR', actorUserId, (client) =>
      client.query(`UPDATE wms.return_order SET status = 'AUTHORIZED', authorized_by = $2, authorized_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`, [
        returnOrderId,
        actorUserId,
      ])
    );
  }

  async deny(returnOrderId: string, tenantId: string, warehouseId: string, reason: string, actorUserId: string) {
    return this.transitionSimple(returnOrderId, tenantId, warehouseId, 'REQUESTED', 'NEGAR', actorUserId, (client) =>
      client.query(
        `UPDATE wms.return_order SET status = 'DENIED', denied_by = $2, denied_at = now(), denied_reason = $3, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [returnOrderId, actorUserId, reason]
      )
    );
  }

  async cancel(returnOrderId: string, tenantId: string, warehouseId: string, reason: string, actorUserId: string) {
    return this.transitionSimple(returnOrderId, tenantId, warehouseId, 'AUTHORIZED', 'CANCELAR', actorUserId, (client) =>
      client.query(
        `UPDATE wms.return_order SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [returnOrderId, actorUserId, reason]
      )
    );
  }

  /**
   * Vínculo MANUAL de chegada (decisão 3 do prompt): chamado depois de um
   * gate-in comum do DOC-03 já ter ocorrido para a visita informada. Cria o
   * Fluxo Operacional com "CHEGADA" já concluída (mesmo padrão de
   * inbound-order.service.ts::createReceivingFlow).
   */
  async linkArrival(returnOrderId: string, vehicleVisitId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const before = await this.findById(returnOrderId, tenantId, actorUserId);
    resolveReturnOrderTransition(before.status, 'CHEGADA_VINCULADA');

    const visitResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT id, warehouse_id FROM wms.vehicle_visit WHERE id = $1`,
      [vehicleVisitId]
    );
    const visit = visitResult.rows[0];
    if (!visit) throw new NotFoundException(`vehicle_visit ${vehicleVisitId} not found`);
    if (visit.warehouse_id !== warehouseId) {
      throw new BadRequestException({ error: 'VISIT_WAREHOUSE_MISMATCH', detail: 'vehicle_visit pertence a outro armazém' });
    }

    const result = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const updated = await client.query(
        `UPDATE wms.return_order SET status = 'IN_RECEIPT', vehicle_visit_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
        [returnOrderId, vehicleVisitId, actorUserId]
      );

      const { flow } = await this.operationFlowService.createFlow(
        client,
        { tenantId, warehouseId, entity: 'return_order', entityId: returnOrderId, flowType: 'REVERSA', stepCodes: RETURN_FLOW_STEPS },
        actorUserId
      );
      await this.operationFlowService.completeStep(client, flow.id, 'CHEGADA', actorUserId);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'reversa.chegada_vinculada',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { return_order_id: returnOrderId, vehicle_visit_id: vehicleVisitId },
      });

      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'return_order',
      entityId: returnOrderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-07 RF-REV-010',
      before,
      after: result,
    });

    return result;
  }

  /** Doca (decisão 4 do prompt) — mesma mecânica de DockService, escrevendo em return_order. */
  async assignDock(returnOrderId: string, dockId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const order = await this.findById(returnOrderId, tenantId, actorUserId);
    if (order.status !== 'IN_RECEIPT') {
      throw new BadRequestException({ error: 'ORDER_NOT_IN_RECEIPT', detail: `return_order ${returnOrderId} não está IN_RECEIPT (atual: ${order.status})` });
    }

    await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const dockResult = await client.query(`SELECT status, dock_type FROM wms.dock WHERE id = $1 AND warehouse_id = $2`, [dockId, warehouseId]);
      const dock = dockResult.rows[0];
      if (!dock) throw new NotFoundException(`dock ${dockId} not found`);
      if (dock.status !== 'RESERVED' && dock.status !== 'FREE') {
        throw new BadRequestException({ error: 'DOCK_NOT_AVAILABLE', detail: `RN-REC-001: doca não disponível (status atual: ${dock.status})` });
      }

      await client.query(`UPDATE wms.dock SET status = 'OCCUPIED', updated_at = now(), updated_by = $2 WHERE id = $1`, [dockId, actorUserId]);
      await client.query(`UPDATE wms.return_order SET dock_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [returnOrderId, dockId, actorUserId]);
      if (order.vehicle_visit_id) {
        await client.query(`UPDATE wms.vehicle_visit SET status = 'EM_DOCA', dock_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1`, [
          order.vehicle_visit_id,
          actorUserId,
        ]);
      }

      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'return_order' AND entity_id = $1`, [returnOrderId]);
      await this.operationFlowService.completeStep(client, flow.rows[0].id, 'DOCA', actorUserId);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'reversa.atracado',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { return_order_id: returnOrderId, dock_id: dockId },
      });
    });

    return this.findById(returnOrderId, tenantId, actorUserId);
  }

  /** Descarga (decisão 4 do prompt) — conclui a etapa e avança IN_RECEIPT -> IN_TRIAGE. */
  async completeUnloading(returnOrderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const before = await this.findById(returnOrderId, tenantId, actorUserId);
    resolveReturnOrderTransition(before.status, 'DESCARGA_CONCLUIDA');

    if (before.dock_id) {
      await this.db.query({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, `UPDATE wms.dock SET status = 'FREE', updated_at = now(), updated_by = $2 WHERE id = $1`, [
        before.dock_id,
        actorUserId,
      ]);
    }

    const result = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const updated = await client.query(
        `UPDATE wms.return_order SET status = 'IN_TRIAGE', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [returnOrderId, actorUserId]
      );
      const flow = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'return_order' AND entity_id = $1`, [returnOrderId]);
      await this.operationFlowService.completeStep(client, flow.rows[0].id, 'DESCARGA', actorUserId);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'reversa.descarga_concluida',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { return_order_id: returnOrderId },
      });
      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'return_order',
      entityId: returnOrderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-07 RF-REV-010',
      before,
      after: result,
    });

    return result;
  }

  async findById(id: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query({ tenant_id: tenantId, user_id: actorUserId }, `SELECT * FROM wms.return_order WHERE id = $1`, [id]);
    if (result.rows.length === 0) throw new NotFoundException(`return_order ${id} not found`);
    return result.rows[0];
  }

  async listItems(returnOrderId: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId },
      `SELECT * FROM wms.return_order_item WHERE return_order_id = $1 ORDER BY line_number`,
      [returnOrderId]
    );
    return result.rows;
  }

  private async transitionSimple(
    returnOrderId: string,
    tenantId: string,
    warehouseId: string,
    expectedFrom: Parameters<typeof resolveReturnOrderTransition>[0],
    event: Parameters<typeof resolveReturnOrderTransition>[1],
    actorUserId: string,
    updateFn: (client: PoolClient) => Promise<{ rows: any[] }>
  ) {
    const before = await this.findById(returnOrderId, tenantId, actorUserId);
    if (before.status !== expectedFrom) {
      resolveReturnOrderTransition(before.status, event); // lança InvalidReturnOrderTransitionError com a mensagem padrão
    }

    const result = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const updated = await updateFn(client);
      await this.eventsService.publishInTransaction(client, {
        event_type: event === 'AUTORIZAR' ? 'reversa.ordem_autorizada' : 'reversa.ordem_status_alterado',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { return_order_id: returnOrderId, event },
      });
      return updated.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'return_order',
      entityId: returnOrderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-07 RN-REV-002',
      before,
      after: result,
    });

    return result;
  }

  private async loadWarehouseCode(client: PoolClient, warehouseId: string): Promise<string> {
    const result = await client.query(`SELECT code FROM wms.warehouse WHERE id = $1`, [warehouseId]);
    if (!result.rows[0]) throw new NotFoundException(`warehouse ${warehouseId} not found`);
    return result.rows[0].code;
  }
}
