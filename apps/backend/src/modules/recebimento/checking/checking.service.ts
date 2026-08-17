// DOC-04 §4.3 — Descarga e conferência. RF-REC-020 (Fluxo Operacional),
// RF-REC-021 (modo cego/informado), RN-REC-022 [INVIOLÁVEL] (apuração e
// recontagem), RN-REC-023 [INVIOLÁVEL] (efeitos das divergências),
// RF-REC-024 (encerramento).
//
// [LACUNA/DÉBITO cross-cutting, documentado uma vez aqui em vez de repetir
// em cada método]: DOC-04 §1 diz explicitamente "As regras de saldo... são
// do DOC-05" — nenhum método deste service credita `wms.stock_balance`
// (inexistente para recebimento nesta sessão; RF-REC-042/motor de putaway é
// 4B). Os efeitos de RN-REC-023 que mencionam crédito de saldo (`qty_
// available`, parcela `qty_blocked`, zona DAMAGED) são aplicados apenas ao
// nível de `inbound_order_item` (qty_received/status) — o crédito real de
// estoque fica para quando o motor de putaway (4B) processar o palete. A
// "carta de divergência em PDF" e a notificação formal ao cliente (RN-REC-
// 023, RF-REC-024) também não são geradas — `[LACUNA: DOC-08/DOC-11 não
// implementados nesta sessão]` — o evento `recebimento.divergencia_
// registrada` é o único sinal de notificação existente (pipeline de
// e-mail/PDF é trabalho futuro).
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { mapRecebimentoDbError } from '../shared/db-error.util.js';

type SobraDestination = 'RECEIVED_BLOCKED' | 'REFUSED_ITEM';
type AvariaDestination = 'RECEIVED_DAMAGED' | 'REFUSED_ITEM';

const EXCEPTION_TYPE_BY_DISCREPANCY: Record<string, string> = {
  FALTA: 'REC.DIVERGENCIA_FALTA',
  SOBRA: 'REC.DIVERGENCIA_SOBRA',
  AVARIA: 'REC.DIVERGENCIA_AVARIA',
  TROCA: 'REC.DIVERGENCIA_TROCA',
};

@Injectable()
export class CheckingService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService
  ) {}

  /** §5.1: AT_DOCK -> UNLOADING ("descarga iniciada"). */
  async startUnloading(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const order = await this.loadOrder(orderId, tenantId, warehouseId, actorUserId);
    if (order.status !== 'AT_DOCK') {
      throw new BadRequestException({ error: 'ORDER_NOT_AT_DOCK', detail: `§5.1: ordem ${order.number} não está AT_DOCK (status atual: ${order.status})` });
    }

    const updated = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const result = await client.query(
        `UPDATE wms.inbound_order SET status = 'UNLOADING', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [orderId, actorUserId]
      );
      await this.eventsService.publishInTransaction(client, {
        event_type: 'recebimento.descarga_iniciada',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { inbound_order_id: orderId },
      });
      return result.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'inbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 §5.1',
      before: order,
      after: updated,
    });

    return updated;
  }

  /**
   * §5.1: UNLOADING -> CHECKING ("descarga concluída"). Abre a sessão de
   * `checking` (modo = snapshot `inbound_order.blind_checking`, RF-REC-021),
   * conclui a etapa de Fluxo "DESCARGA" e libera os itens (exceto
   * SEM_CADASTRO, RN-REC-012) para contagem (PENDING -> CHECKING_PENDING).
   */
  async startChecking(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const order = await this.loadOrder(orderId, tenantId, warehouseId, actorUserId);
    if (order.status !== 'UNLOADING') {
      throw new BadRequestException({ error: 'ORDER_NOT_UNLOADING', detail: `§5.1: ordem ${order.number} não está UNLOADING (status atual: ${order.status})` });
    }

    const checking = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const checkingResult = await client.query(
        `INSERT INTO wms.checking (tenant_id, warehouse_id, inbound_order_id, mode, status, created_by)
         VALUES ($1,$2,$3,$4,'IN_PROGRESS',$5) RETURNING *`,
        [tenantId, warehouseId, orderId, order.blind_checking ? 'BLIND' : 'INFORMED', actorUserId]
      );

      await client.query(
        `UPDATE wms.inbound_order_item SET status = 'CHECKING_PENDING', updated_at = now(), updated_by = $2
         WHERE inbound_order_id = $1 AND status = 'PENDING'`,
        [orderId, actorUserId]
      );

      await client.query(`UPDATE wms.inbound_order SET status = 'CHECKING', updated_at = now(), updated_by = $2 WHERE id = $1`, [orderId, actorUserId]);

      const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [orderId]);
      if (flowResult.rows.length > 0) {
        await this.operationFlowService.completeStep(client, flowResult.rows[0].id, 'DESCARGA', actorUserId);
      }

      return checkingResult.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'checking',
      entityId: checking.id,
      action: 'CREATE',
      requirementId: 'DOC-04 RF-REC-021',
      after: checking,
    });

    return checking;
  }

  /** RF-REC-021/RN-REC-022 — 1ª contagem (permissão REC.CONFERIR). */
  async countFirstRound(checkingId: string, itemId: string, qtyCounted: number, conferenteUserId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const { checking, item } = await this.loadCheckingAndItem(checkingId, itemId, tenantId, warehouseId, actorUserId);
    if (item.status !== 'CHECKING_PENDING') {
      throw new BadRequestException({
        error: 'ITEM_NOT_AWAITING_FIRST_COUNT',
        detail: `RF-REC-021: item ${itemId} não está aguardando 1ª contagem (status atual: ${item.status})`,
      });
    }

    return this.applyCount(checking, item, 1, qtyCounted, conferenteUserId, false, tenantId, warehouseId, actorUserId);
  }

  /**
   * RN-REC-022 [INVIOLÁVEL] — Recontagem (permissão REC.RECONTAR). Exige
   * conferente DIFERENTE do round anterior quando houver mais de um
   * conferente elegível disponível no armazém×cliente; senão, permite o
   * mesmo, marcando `forced_same_conferente`.
   */
  async recount(checkingId: string, itemId: string, qtyCounted: number, conferenteUserId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const { checking, item } = await this.loadCheckingAndItem(checkingId, itemId, tenantId, warehouseId, actorUserId);
    if (item.status !== 'RECOUNT_PENDING') {
      throw new BadRequestException({
        error: 'ITEM_NOT_AWAITING_RECOUNT',
        detail: `RN-REC-022: item ${itemId} não está aguardando recontagem (status atual: ${item.status})`,
      });
    }

    const previousRoundResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.checking_item WHERE checking_id = $1 AND inbound_order_item_id = $2 ORDER BY round DESC LIMIT 1`,
      [checkingId, itemId]
    );
    const previousRound = previousRoundResult.rows[0];
    if (!previousRound) {
      throw new ConflictException({ error: 'NO_PREVIOUS_COUNT', detail: 'RN-REC-022: não há contagem anterior para recontar' });
    }

    let forcedSameConferente = false;
    if (conferenteUserId === previousRound.conferente_user_id) {
      const hasOther = await this.hasOtherEligibleConferente(tenantId, warehouseId, conferenteUserId, actorUserId);
      if (hasOther) {
        throw new ForbiddenException({
          error: 'RECOUNT_REQUIRES_DIFFERENT_CONFERENTE',
          detail: 'RN-REC-022: recontagem exige conferente diferente do round anterior (há outro conferente elegível disponível)',
        });
      }
      forcedSameConferente = true;
    }

    return this.applyCount(checking, item, previousRound.round + 1, qtyCounted, conferenteUserId, forcedSameConferente, tenantId, warehouseId, actorUserId);
  }

  /** RN-REC-022 [INVIOLÁVEL] — unidades danificadas identificadas na contagem, fotos obrigatórias (>=1, CHECK do banco). */
  async registerAvaria(checkingId: string, itemId: string, qtyDamaged: number, photoKeys: string[], tenantId: string, warehouseId: string, actorUserId: string) {
    const { item } = await this.loadCheckingAndItem(checkingId, itemId, tenantId, warehouseId, actorUserId);
    if (!['CHECKING_PENDING', 'RECOUNT_PENDING'].includes(item.status)) {
      throw new BadRequestException({ error: 'ITEM_NOT_IN_CHECKING', detail: `RN-REC-022: item ${itemId} não está em conferência (status atual: ${item.status})` });
    }

    try {
      const discrepancy = await this.createDiscrepancyWithException(
        'AVARIA',
        [{ itemId, qty: qtyDamaged, photoKeys }],
        tenantId,
        warehouseId,
        actorUserId
      );
      return discrepancy[0];
    } catch (error) {
      mapRecebimentoDbError(error);
    }
  }

  /**
   * RN-REC-022 — TROCA: produto recebido ≠ documento. Par item faltante +
   * item excedente, ambos já cadastrados como `inbound_order_item` da MESMA
   * Ordem. `[LACUNA: DOC-04 não detalha como um item recebido mas NÃO
   * listado na Ordem original entra no fluxo de TROCA — implementado apenas
   * para o caso em que ambos os lados (faltante e excedente) já existem
   * como inbound_order_item da mesma Ordem.]`
   */
  async registerTroca(checkingId: string, missingItemId: string, excessItemId: string, qty: number, tenantId: string, warehouseId: string, actorUserId: string) {
    const { item: missingItem } = await this.loadCheckingAndItem(checkingId, missingItemId, tenantId, warehouseId, actorUserId);
    const { item: excessItem } = await this.loadCheckingAndItem(checkingId, excessItemId, tenantId, warehouseId, actorUserId);
    for (const item of [missingItem, excessItem]) {
      if (!['CHECKING_PENDING', 'RECOUNT_PENDING'].includes(item.status)) {
        throw new BadRequestException({ error: 'ITEM_NOT_IN_CHECKING', detail: `RN-REC-022: item ${item.id} não está em conferência (status atual: ${item.status})` });
      }
    }

    const [missingDiscrepancy, excessDiscrepancy] = await this.createDiscrepancyWithException(
      'TROCA',
      [
        { itemId: missingItemId, qty, photoKeys: [] },
        { itemId: excessItemId, qty, photoKeys: [] },
      ],
      tenantId,
      warehouseId,
      actorUserId
    );

    await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `UPDATE wms.discrepancy SET paired_discrepancy_id = $2 WHERE id = $1`,
      [missingDiscrepancy.id, excessDiscrepancy.id]
    );
    await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `UPDATE wms.discrepancy SET paired_discrepancy_id = $2 WHERE id = $1`,
      [excessDiscrepancy.id, missingDiscrepancy.id]
    );

    return { missing: missingDiscrepancy, excess: excessDiscrepancy };
  }

  /**
   * RN-REC-023 [INVIOLÁVEL] — decide a exceção vinculada à Divergência
   * (via motor genérico do DOC-12, `OperationalExceptionService.decide()`)
   * e aplica os efeitos no `inbound_order_item` (§4.3 tabela). `destination`
   * é obrigatório para SOBRA/AVARIA aprovadas (a tabela do DOC-04 dá DUAS
   * opções nesses casos — "decisão do aprovador").
   */
  async decideDiscrepancy(
    discrepancyId: string,
    tenantId: string,
    warehouseId: string,
    decidedBy: string,
    decision: 'APPROVE' | 'REJECT',
    reason: string,
    destination?: SobraDestination | AvariaDestination
  ) {
    const discrepancyResult = await this.db.query(
      { tenant_id: tenantId, user_id: decidedBy, warehouse_id: warehouseId },
      `SELECT * FROM wms.discrepancy WHERE id = $1`,
      [discrepancyId]
    );
    const discrepancy = discrepancyResult.rows[0];
    if (!discrepancy) throw new NotFoundException(`discrepancy ${discrepancyId} not found`);
    if (discrepancy.status !== 'PENDING') {
      throw new ConflictException({ error: 'DISCREPANCY_ALREADY_RESOLVED', detail: `status atual: ${discrepancy.status}` });
    }
    if (!discrepancy.operational_exception_id) {
      throw new ConflictException({ error: 'NO_EXCEPTION_LINKED', detail: 'discrepancy sem operational_exception_id — estado inconsistente' });
    }

    const exception = await this.operationalExceptionService.decide(discrepancy.operational_exception_id, tenantId, warehouseId, decidedBy, decision, reason);
    if (!['APPROVED', 'REJECTED'].includes(exception.status)) {
      // RD-SEG (DOC-12): fluxo de 2 passos ainda não concluído — REC.* são
      // todas default_steps=1 (§3), então isto não deveria acontecer, mas
      // não aplicamos efeito nenhum enquanto a decisão não for final.
      return { discrepancy, exception, applied: false };
    }

    const resolution = await this.db.transaction({ tenant_id: tenantId, user_id: decidedBy, warehouse_id: warehouseId }, async (client) => {
      const applied = await this.applyDiscrepancyDecision(client, discrepancy, exception.status === 'APPROVED', destination, decidedBy);
      await client.query(`UPDATE wms.discrepancy SET status = 'RESOLVED', resolution = $2, resolved_at = now(), resolved_by = $3 WHERE id = $1`, [
        discrepancyId,
        applied.resolution,
        decidedBy,
      ]);
      await this.maybeClearOrderDiscrepancyPending(client, discrepancy.warehouse_id, applied.orderId, tenantId, decidedBy);
      return applied;
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: decidedBy,
      origin: 'WEB',
      entity: 'discrepancy',
      entityId: discrepancyId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 RN-REC-023',
      reason,
      before: discrepancy,
      after: { ...discrepancy, status: 'RESOLVED', resolution: resolution.resolution },
    });

    return { discrepancy: { ...discrepancy, status: 'RESOLVED', resolution: resolution.resolution }, exception, applied: true };
  }

  /**
   * RF-REC-024 — encerramento: todos os itens contados (exceto SEM_CADASTRO,
   * RN-REC-012, que seguem bloqueados até vínculo de produto) e ZERO
   * discrepancies PENDING. Congela as quantidades (nenhum método deste
   * service permite alterar qty_received depois de CHECKED) e habilita a
   * Etiquetagem.
   */
  async closeChecking(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const order = await this.loadOrder(orderId, tenantId, warehouseId, actorUserId);
    if (order.status !== 'CHECKING') {
      throw new BadRequestException({
        error: 'ORDER_NOT_READY_TO_CLOSE',
        detail: `RF-REC-024: ordem ${order.number} não está CHECKING (status atual: ${order.status}) — precisa estar sem exceções pendentes`,
      });
    }

    const pendingItemsResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT COUNT(*) AS count FROM wms.inbound_order_item WHERE inbound_order_id = $1 AND status NOT IN ('CHECKED', 'SEM_CADASTRO', 'REFUSED')`,
      [orderId]
    );
    if (Number(pendingItemsResult.rows[0].count) > 0) {
      throw new BadRequestException({ error: 'ITEMS_NOT_ALL_CHECKED', detail: `RF-REC-024: ainda há itens sem contagem final apurada` });
    }

    const checkingResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.checking WHERE inbound_order_id = $1`,
      [orderId]
    );
    const checking = checkingResult.rows[0];
    if (!checking) throw new NotFoundException(`checking session for inbound_order ${orderId} not found`);

    const result = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.checking SET status = 'CLOSED', closed_at = now(), closed_by = $2 WHERE id = $1`, [checking.id, actorUserId]);
      const orderResult = await client.query(
        `UPDATE wms.inbound_order SET status = 'CHECKED', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [orderId, actorUserId]
      );

      const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = 'inbound_order' AND entity_id = $1`, [orderId]);
      if (flowResult.rows.length > 0) {
        await this.operationFlowService.completeStep(client, flowResult.rows[0].id, 'CONFERENCIA', actorUserId);
      }

      await this.eventsService.publishInTransaction(client, {
        event_type: 'recebimento.conferencia_encerrada',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { inbound_order_id: orderId, checking_id: checking.id },
      });

      return orderResult.rows[0];
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'inbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 RF-REC-024',
      before: order,
      after: result,
    });

    return result;
  }

  // ---------------------------------------------------------------------

  private async applyCount(
    checking: any,
    item: any,
    round: number,
    qtyCounted: number,
    conferenteUserId: string,
    forcedSameConferente: boolean,
    tenantId: string,
    warehouseId: string,
    actorUserId: string
  ) {
    const matches = Number(qtyCounted) === Number(item.qty_expected);

    const updatedItem = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      await client.query(
        `INSERT INTO wms.checking_item (tenant_id, checking_id, inbound_order_item_id, round, conferente_user_id, qty_counted, forced_same_conferente, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, checking.id, item.id, round, conferenteUserId, qtyCounted, forcedSameConferente, actorUserId]
      );

      const newStatus = matches ? 'CHECKED' : 'RECOUNT_PENDING';
      const result = await client.query(
        `UPDATE wms.inbound_order_item SET status = $2, qty_counted = $3, qty_received = CASE WHEN $4 THEN $3 ELSE qty_received END, updated_at = now(), updated_by = $5
         WHERE id = $1 RETURNING *`,
        [item.id, newStatus, qtyCounted, matches, actorUserId]
      );

      await this.eventsService.publishInTransaction(client, {
        event_type: 'recebimento.item_conferido',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { inbound_order_item_id: item.id, round, qty_counted: qtyCounted, matches_expected: matches },
      });

      return result.rows[0];
    });

    if (matches) {
      return { item: updatedItem, divergence: null };
    }

    if (round === 1) {
      // RN-REC-022: 1ª contagem divergiu — aguarda recontagem, ainda não é
      // uma Divergência formal (só a recontagem CONFIRMA ou desfaz).
      return { item: updatedItem, divergence: null };
    }

    // round >= 2 e ainda diverge: RN-REC-022 confirma a Divergência.
    const discrepancyType = Number(qtyCounted) < Number(item.qty_expected) ? 'FALTA' : 'SOBRA';
    const qtyDiff = Math.abs(Number(qtyCounted) - Number(item.qty_expected));
    const [discrepancy] = await this.createDiscrepancyWithException(discrepancyType, [{ itemId: item.id, qty: qtyDiff, photoKeys: [] }], tenantId, warehouseId, actorUserId);

    return { item: updatedItem, divergence: discrepancy };
  }

  private async createDiscrepancyWithException(
    discrepancyType: string,
    items: { itemId: string; qty: number; photoKeys: string[] }[],
    tenantId: string,
    warehouseId: string,
    actorUserId: string
  ) {
    const created = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const rows = [];
      for (const it of items) {
        const result = await client.query(
          `INSERT INTO wms.discrepancy (tenant_id, warehouse_id, inbound_order_item_id, discrepancy_type, qty, photo_keys, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [tenantId, warehouseId, it.itemId, discrepancyType, it.qty, it.photoKeys, actorUserId]
        );
        rows.push(result.rows[0]);
      }

      const orderIdResult = await client.query(`SELECT inbound_order_id FROM wms.inbound_order_item WHERE id = $1`, [items[0].itemId]);
      const orderId = orderIdResult.rows[0].inbound_order_id;
      await client.query(`UPDATE wms.inbound_order SET status = 'DISCREPANCY_PENDING', updated_at = now(), updated_by = $2 WHERE id = $1 AND status = 'CHECKING'`, [
        orderId,
        actorUserId,
      ]);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'recebimento.divergencia_registrada',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { inbound_order_id: orderId, discrepancy_type: discrepancyType, discrepancy_ids: rows.map((r) => r.id) },
      });

      return { rows, orderId };
    });

    // RN-SEG-021 (DOC-12): exceção aberta FORA da transação acima — o motor
    // de workflow abre a própria (não é possível aninhar db.transaction()).
    const exceptionType = EXCEPTION_TYPE_BY_DISCREPANCY[discrepancyType];
    const exception = await this.operationalExceptionService.create({
      tenantId,
      warehouseId,
      exceptionType,
      entity: 'discrepancy',
      entityId: created.rows[0].id,
      qty: items.reduce((sum, it) => sum + it.qty, 0),
      reasonRequest: `DOC-04 RN-REC-022: divergência ${discrepancyType} registrada na conferência`,
      requestedBy: actorUserId,
    });

    for (const row of created.rows) {
      await this.db.query({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, `UPDATE wms.discrepancy SET operational_exception_id = $2 WHERE id = $1`, [
        row.id,
        exception.id,
      ]);
      row.operational_exception_id = exception.id;
    }

    return created.rows;
  }

  private async applyDiscrepancyDecision(
    client: PoolClient,
    discrepancy: any,
    approved: boolean,
    destination: SobraDestination | AvariaDestination | undefined,
    actorUserId: string
  ): Promise<{ resolution: string; orderId: string }> {
    const itemResult = await client.query(`SELECT * FROM wms.inbound_order_item WHERE id = $1`, [discrepancy.inbound_order_item_id]);
    const item = itemResult.rows[0];

    switch (discrepancy.discrepancy_type) {
      case 'FALTA': {
        if (approved) {
          await client.query(
            `UPDATE wms.inbound_order_item SET status = 'CHECKED', qty_received = qty_counted, updated_at = now(), updated_by = $2 WHERE id = $1`,
            [item.id, actorUserId]
          );
          return { resolution: 'ADJUSTED', orderId: item.inbound_order_id };
        }
        await client.query(`UPDATE wms.inbound_order_item SET status = 'RECOUNT_PENDING', updated_at = now(), updated_by = $2 WHERE id = $1`, [item.id, actorUserId]);
        return { resolution: 'RECOUNT', orderId: item.inbound_order_id };
      }
      case 'SOBRA': {
        if (approved) {
          if (!destination) {
            throw new BadRequestException({ error: 'DESTINATION_REQUIRED', detail: 'RN-REC-023: SOBRA aprovada exige destination (RECEIVED_BLOCKED ou REFUSED_ITEM)' });
          }
          const qtyReceived = destination === 'RECEIVED_BLOCKED' ? item.qty_counted : item.qty_expected;
          await client.query(
            `UPDATE wms.inbound_order_item SET status = 'CHECKED', qty_received = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
            [item.id, qtyReceived, actorUserId]
          );
          return { resolution: destination, orderId: item.inbound_order_id };
        }
        // RN-REC-023: SOBRA rejeitada -> excedente sempre recusado (não volta pra recontagem).
        await client.query(
          `UPDATE wms.inbound_order_item SET status = 'CHECKED', qty_received = qty_expected, updated_at = now(), updated_by = $2 WHERE id = $1`,
          [item.id, actorUserId]
        );
        return { resolution: 'REFUSED_ITEM', orderId: item.inbound_order_id };
      }
      case 'AVARIA': {
        if (approved) {
          const chosen: AvariaDestination = destination === 'REFUSED_ITEM' ? 'REFUSED_ITEM' : 'RECEIVED_DAMAGED';
          if (chosen === 'REFUSED_ITEM' && item.status === 'CHECKED') {
            const adjustedQty = Math.max(Number(item.qty_received) - Number(discrepancy.qty), 0);
            await client.query(`UPDATE wms.inbound_order_item SET qty_received = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [
              item.id,
              adjustedQty,
              actorUserId,
            ]);
          }
          // RECEIVED_DAMAGED: quantidade permanece como já apurada pela
          // contagem — a parcela danificada é rastreada só pelo próprio
          // registro de discrepancy (zona DAMAGED é DOC-05, fora de escopo).
          return { resolution: chosen, orderId: item.inbound_order_id };
        }
        await client.query(`UPDATE wms.inbound_order_item SET status = 'RECOUNT_PENDING', updated_at = now(), updated_by = $2 WHERE id = $1`, [item.id, actorUserId]);
        return { resolution: 'RECOUNT', orderId: item.inbound_order_id };
      }
      case 'TROCA': {
        // RN-REC-023: "item excedente tratado como SOBRA e faltante como
        // FALTA" — este discrepancy é UM dos dois lados do par; o outro
        // lado é decidido em uma chamada SEPARADA de decideDiscrepancy()
        // (cada linha de wms.discrepancy tem sua própria decisão/exceção),
        // aplicando a MESMA lógica de FALTA/SOBRA acima conforme o sinal de
        // discrepancy.qty em relação ao item vinculado. Para simplificar,
        // tratamos qty > 0 sempre como o efeito "ADJUSTED"/"RECOUNT" (lado
        // faltante) quando `destination` não é informado, e como SOBRA
        // quando `destination` é informado (lado excedente) — mesmo
        // contrato de FALTA/SOBRA acima, reaproveitado.
        if (approved) {
          if (destination) {
            const qtyReceived = destination === 'RECEIVED_BLOCKED' ? item.qty_counted : item.qty_expected;
            await client.query(`UPDATE wms.inbound_order_item SET status = 'CHECKED', qty_received = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [
              item.id,
              qtyReceived,
              actorUserId,
            ]);
            return { resolution: destination, orderId: item.inbound_order_id };
          }
          await client.query(`UPDATE wms.inbound_order_item SET status = 'CHECKED', qty_received = qty_counted, updated_at = now(), updated_by = $2 WHERE id = $1`, [
            item.id,
            actorUserId,
          ]);
          return { resolution: 'ADJUSTED', orderId: item.inbound_order_id };
        }
        await client.query(`UPDATE wms.inbound_order_item SET status = 'RECOUNT_PENDING', updated_at = now(), updated_by = $2 WHERE id = $1`, [item.id, actorUserId]);
        return { resolution: 'RECOUNT', orderId: item.inbound_order_id };
      }
      default:
        throw new BadRequestException(`unknown discrepancy_type ${discrepancy.discrepancy_type}`);
    }
  }

  private async maybeClearOrderDiscrepancyPending(client: PoolClient, warehouseId: string, orderId: string, tenantId: string, actorUserId: string) {
    const pendingResult = await client.query(
      `SELECT COUNT(*) AS count FROM wms.discrepancy d
       JOIN wms.inbound_order_item i ON i.id = d.inbound_order_item_id
       WHERE i.inbound_order_id = $1 AND d.status = 'PENDING'`,
      [orderId]
    );
    if (Number(pendingResult.rows[0].count) === 0) {
      await client.query(`UPDATE wms.inbound_order SET status = 'CHECKING', updated_at = now(), updated_by = $2 WHERE id = $1 AND status = 'DISCREPANCY_PENDING'`, [
        orderId,
        actorUserId,
      ]);
    }
  }

  private async hasOtherEligibleConferente(tenantId: string, warehouseId: string, excludeUserId: string, actorUserId: string): Promise<boolean> {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT DISTINCT ura.user_id
       FROM wms.user_role_assignment ura
       JOIN wms.role r ON r.id = ura.role_id AND r.status = 'ACTIVE'
       JOIN wms.role_permission rp ON rp.role_id = ura.role_id
       JOIN wms.permission p ON p.code = rp.permission_code
       WHERE p.code = 'REC.RECONTAR'
         AND ura.user_id != $1
         AND (ura.valid_from IS NULL OR ura.valid_from <= CURRENT_DATE)
         AND (ura.valid_until IS NULL OR ura.valid_until >= CURRENT_DATE)
         AND (
           p.scope = 'GLOBAL'
           OR (p.scope = 'WAREHOUSE' AND ura.warehouse_id = $2::uuid)
           OR (p.scope = 'CLIENT_WAREHOUSE' AND ura.warehouse_id = $2::uuid AND ura.client_id = $3::uuid)
         )
       LIMIT 1`,
      [excludeUserId, warehouseId, tenantId]
    );
    return result.rows.length > 0;
  }

  private async loadOrder(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.inbound_order WHERE id = $1`,
      [orderId]
    );
    const order = result.rows[0];
    if (!order) throw new NotFoundException(`inbound_order ${orderId} not found`);
    return order;
  }

  private async loadCheckingAndItem(checkingId: string, itemId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const checkingResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.checking WHERE id = $1`,
      [checkingId]
    );
    const checking = checkingResult.rows[0];
    if (!checking) throw new NotFoundException(`checking ${checkingId} not found`);
    if (checking.status !== 'IN_PROGRESS') {
      throw new BadRequestException({ error: 'CHECKING_NOT_IN_PROGRESS', detail: `checking ${checkingId} não está IN_PROGRESS (status atual: ${checking.status})` });
    }

    const itemResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.inbound_order_item WHERE id = $1 AND inbound_order_id = $2`,
      [itemId, checking.inbound_order_id]
    );
    const item = itemResult.rows[0];
    if (!item) throw new NotFoundException(`inbound_order_item ${itemId} not found in checking ${checkingId}`);
    if (item.status === 'SEM_CADASTRO') {
      throw new BadRequestException({ error: 'ITEM_SEM_CADASTRO', detail: `RN-REC-012: item ${itemId} está SEM_CADASTRO — não pode ser conferido até vínculo de produto` });
    }

    return { checking, item };
  }
}
