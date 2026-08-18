// DOC-05 §4.2 — Reserva a partir da Seleção de Saldo.
//
// Converte a LISTA de alocações (RN-EST-011) em movimentações `RESERVA` do
// catálogo fechado RN-EST-001, pelo serviço único da Sessão 5A
// (StockMovementService — nenhuma escrita direta em stock_balance), e
// persiste o detalhamento saldo→demanda em wms.stock_reservation para o
// consumo posterior no picking (DOC-06).
//
// Duas garantias estruturais desta classe:
//
// 1. RN-EST-013 é validada ANTES de qualquer efeito. "o sistema DEVE exigir
//    `EST.QUEBRA_POLITICA_GIRO` + exceção `EST.QUEBRA_FEFO` aprovada ANTES de
//    efetivar a reserva" — nunca aprovação posterior. Por isso a checagem
//    acontece fora e antes da transação de efeito.
//
// 2. Concorrência (RG-004): a seleção é recarregada DENTRO da transação com
//    `SELECT ... FOR UPDATE` nas linhas de saldo candidatas. Sem o lock, duas
//    demandas simultâneas leriam o mesmo `qty_available` e reservariam a
//    mesma quantidade duas vezes; com ele, a segunda transação espera, relê o
//    saldo já debitado e aloca sobre o que sobrou (ou falha determinística).
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { StockMovementService } from '../movement/stock-movement.service.js';
import { StockSelectionService } from './stock-selection.service.js';
import { SelectionPurpose, StockSelectionOutcome } from './stock-selection.port.js';

export interface ReserveStockInput {
  tenantId: string;
  warehouseId: string;
  productId: string;
  demandQty: number;
  purpose: SelectionPurpose;
  /** Documento/demanda que origina a reserva (ex.: 'REPLENISHMENT_TASK', 'OUTBOUND_ORDER'). */
  demandRefType: string;
  demandRefId: string;
  /** Data de referência de RN-EST-012; ausente = data corrente (UTC). */
  today?: string;
  /** RN-EST-013 — lote específico fora da ordem. */
  forcedBatchId?: string | null;
  /** RN-EST-013 — dispensa a exclusão por shelf life (exige anexo na exceção). */
  overrideShelfLife?: boolean;
  /** RN-EST-013 — exceção `EST.QUEBRA_FEFO` APROVADA que autoriza a quebra. */
  policyBreakExceptionId?: string | null;
  /** RN-EST-013 / RD-EST-005 — motivo da quebra, gravado na movimentação e na reserva. */
  breakReason?: string | null;
  /**
   * Atendimento parcial (§4.2). false (padrão) = demanda não coberta é erro
   * determinístico; true = reserva o que houver e devolve o shortfall.
   */
  allowPartial?: boolean;
  actorUserId: string;
}

export interface ReserveStockResult {
  reservations: Array<{ id: string; stockBalanceId: string; qty: number; movementId: string }>;
  selection: StockSelectionOutcome;
  qtyReserved: number;
  shortfall: number;
}

@Injectable()
export class StockReservationService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (padrão de todo o módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(StockSelectionService) private readonly stockSelectionService: StockSelectionService,
    @Inject(StockMovementService) private readonly stockMovementService: StockMovementService
  ) {}

  async reserve(input: ReserveStockInput): Promise<ReserveStockResult> {
    const isPolicyBreak = Boolean(input.forcedBatchId) || Boolean(input.overrideShelfLife);

    // ── RN-EST-013 — autorização ANTES de qualquer efeito ─────────────────
    if (isPolicyBreak) {
      await this.assertPolicyBreakAuthorized(input);
    }

    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    const result = await this.db.transaction(ctx, (client) => this.applyReservation(client, input, isPolicyBreak));

    await this.recordReservationAudit(input, isPolicyBreak, result);
    return result;
  }

  /**
   * Variante para chamadores que JÁ têm transação aberta e precisam do mesmo
   * bloco atômico — caso da liberação de pedido (DOC-06 RN-EXP-002/003), em
   * que reserva, mudança de estado do pedido e conclusão da etapa do fluxo
   * não podem se separar. Mesmo contrato de StockMovementService.apply().
   *
   * A autorização de RN-EST-013 continua ANTES de qualquer efeito: é
   * validada aqui, no início, exatamente como em reserve().
   */
  async reserveInTransaction(client: PoolClient, input: ReserveStockInput): Promise<ReserveStockResult> {
    const isPolicyBreak = Boolean(input.forcedBatchId) || Boolean(input.overrideShelfLife);
    if (isPolicyBreak) {
      await this.assertPolicyBreakAuthorized(input);
    }
    const result = await this.applyReservation(client, input, isPolicyBreak);
    await this.recordReservationAudit(input, isPolicyBreak, result);
    return result;
  }

  private async applyReservation(client: PoolClient, input: ReserveStockInput, isPolicyBreak: boolean): Promise<ReserveStockResult> {
    {
      // Seleção RECARREGADA dentro da transação COM lock — ver garantia 2 no
      // cabeçalho. O resultado de uma seleção feita fora da transação seria
      // uma leitura suja para efeito de reserva.
      const selection = await this.stockSelectionService.selectInTransaction(
        client,
        {
          tenantId: input.tenantId,
          warehouseId: input.warehouseId,
          productId: input.productId,
          demandQty: input.demandQty,
          purpose: input.purpose,
          today: input.today,
          forcedBatchId: input.forcedBatchId,
          overrideShelfLife: input.overrideShelfLife,
          actorUserId: input.actorUserId,
        },
        { lockForUpdate: true }
      );

      if (selection.shortfall > 0 && !input.allowPartial) {
        throw new BadRequestException({
          error: 'INSUFFICIENT_AVAILABLE_BALANCE',
          detail:
            `RN-EST-010/RG-004: saldo disponível insuficiente para a demanda de ${input.demandQty} ` +
            `(faltam ${selection.shortfall}; política ${selection.policy}, ${selection.allocations.length} saldo(s) candidato(s))`,
        });
      }

      // ── RN-EST-013 — a quebra por shelf life exige ANEXO do cliente ─────
      // Verificada aqui, e não na pré-validação, porque só depois da seleção
      // se sabe se algum saldo reprovado por RN-EST-012 foi de fato usado.
      if (selection.shelfLifeOverridden) {
        await this.assertShelfLifeBreakHasClientAttachment(client, input);
      }

      const reservations: ReserveStockResult['reservations'] = [];
      let qtyReserved = 0;

      for (const allocation of selection.allocations) {
        const candidate = allocation.candidate;

        // RN-EST-001 (Sessão 5A): `RESERVA` = available -> reserved. Efeito
        // FIXO no catálogo fechado; StockMovementService revalida RG-004 na
        // própria UPDATE (WHERE qty_available >= qty).
        const movement = await this.stockMovementService.apply(client, {
          tenantId: input.tenantId,
          warehouseId: input.warehouseId,
          movementType: 'RESERVA',
          productId: candidate.productId,
          batchId: candidate.batchId,
          qty: allocation.qtyAllocated,
          locationIdFrom: candidate.locationId,
          palletIdFrom: candidate.palletId,
          locationIdTo: candidate.locationId,
          palletIdTo: candidate.palletId,
          documentRefType: input.demandRefType,
          documentRefId: input.demandRefId,
          // RD-EST-005 (RN-EST-013): a movimentação resultante é marcada.
          policyBreak: isPolicyBreak,
          breakReason: isPolicyBreak ? (input.breakReason ?? null) : null,
          actorUserId: input.actorUserId,
        });

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO wms.stock_reservation (
             tenant_id, warehouse_id, stock_balance_id, product_id, batch_id, location_id, pallet_id,
             qty, demand_ref_type, demand_ref_id, purpose, status,
             policy_break, break_reason, policy_break_exception_id, movement_id, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',$12,$13,$14,$15,$16)
           RETURNING id`,
          [
            input.tenantId,
            input.warehouseId,
            candidate.stockBalanceId,
            candidate.productId,
            candidate.batchId,
            candidate.locationId,
            candidate.palletId,
            allocation.qtyAllocated,
            input.demandRefType,
            input.demandRefId,
            input.purpose,
            isPolicyBreak,
            isPolicyBreak ? (input.breakReason ?? null) : null,
            isPolicyBreak ? (input.policyBreakExceptionId ?? null) : null,
            movement.movementIds[0],
            input.actorUserId,
          ]
        );

        reservations.push({
          id: inserted.rows[0].id,
          stockBalanceId: candidate.stockBalanceId,
          qty: allocation.qtyAllocated,
          movementId: movement.movementIds[0],
        });
        qtyReserved += allocation.qtyAllocated;
      }

      if (reservations.length > 0) {
        await this.eventsService.publishInTransaction(client, {
          event_type: 'estoque.saldo_alterado',
          tenant_id: input.tenantId,
          warehouse_id: input.warehouseId,
          actor_user_id: input.actorUserId,
          payload: {
            movement_type: 'RESERVA',
            product_id: input.productId,
            qty: qtyReserved,
            demand_ref_type: input.demandRefType,
            demand_ref_id: input.demandRefId,
            policy: selection.policy,
            policy_break: isPolicyBreak,
          },
        });
      }

      return { reservations, selection, qtyReserved, shortfall: selection.shortfall };
    }
  }

  private async recordReservationAudit(input: ReserveStockInput, isPolicyBreak: boolean, result: ReserveStockResult): Promise<void> {
    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'stock_reservation',
      entityId: input.demandRefId,
      // RN-EST-013/AD-006: quebra de política é auditada como OVERRIDE.
      action: isPolicyBreak ? 'OVERRIDE' : 'CREATE',
      requirementId: isPolicyBreak ? 'DOC-05 RN-EST-013' : 'DOC-05 RN-EST-011',
      reason: isPolicyBreak ? (input.breakReason ?? null) : null,
      after: {
        demand_ref_type: input.demandRefType,
        demand_ref_id: input.demandRefId,
        policy: result.selection.policy,
        qty_reserved: result.qtyReserved,
        shortfall: result.shortfall,
        allocations: result.reservations.map((r) => ({ stock_balance_id: r.stockBalanceId, qty: r.qty })),
      },
    });
  }

  /**
   * RN-EST-013 [ANTES do efeito] — "o sistema DEVE exigir
   * `EST.QUEBRA_POLITICA_GIRO` + exceção `EST.QUEBRA_FEFO` aprovada ANTES de
   * efetivar a reserva". A exceção precisa JÁ estar APPROVED: aprovar depois
   * não regulariza uma reserva já efetivada.
   */
  private async assertPolicyBreakAuthorized(input: ReserveStockInput): Promise<void> {
    const hasPermission = await this.rbacService.hasPermission(input.actorUserId, 'EST.QUEBRA_POLITICA_GIRO', {
      warehouseId: input.warehouseId,
      clientId: input.tenantId,
    });
    if (!hasPermission) {
      throw new ForbiddenException({
        error: 'POLICY_BREAK_PERMISSION_REQUIRED',
        detail: 'RN-EST-013: seleção fora da ordem exige a permissão EST.QUEBRA_POLITICA_GIRO',
      });
    }

    if (!input.breakReason || input.breakReason.trim().length === 0) {
      throw new BadRequestException({ error: 'BREAK_REASON_REQUIRED', detail: 'RN-EST-013/RG-006: a quebra de política exige motivo' });
    }

    if (!input.policyBreakExceptionId) {
      throw new BadRequestException({
        error: 'POLICY_BREAK_EXCEPTION_REQUIRED',
        detail: 'RN-EST-013: a quebra de política exige uma exceção EST.QUEBRA_FEFO aprovada ANTES da reserva',
      });
    }

    const result = await this.db.query(
      { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId },
      `SELECT exception_type, status, warehouse_id FROM wms.operational_exception WHERE id = $1 AND tenant_id = $2`,
      [input.policyBreakExceptionId, input.tenantId]
    );
    const exception = result.rows[0];
    if (!exception) throw new NotFoundException(`operational_exception ${input.policyBreakExceptionId} not found`);

    if (exception.exception_type !== 'EST.QUEBRA_FEFO') {
      throw new BadRequestException({
        error: 'WRONG_EXCEPTION_TYPE',
        detail: `RN-EST-013: a quebra de política exige exceção do tipo EST.QUEBRA_FEFO (recebida: ${exception.exception_type})`,
      });
    }
    if (exception.warehouse_id !== input.warehouseId) {
      throw new BadRequestException({
        error: 'EXCEPTION_WAREHOUSE_MISMATCH',
        detail: 'RN-EST-013: a exceção de quebra pertence a outro armazém',
      });
    }
    if (exception.status !== 'APPROVED') {
      throw new ConflictException({
        error: 'POLICY_BREAK_NOT_APPROVED',
        detail: `RN-EST-013: a exceção EST.QUEBRA_FEFO precisa estar APROVADA ANTES da reserva (status atual: ${exception.status})`,
      });
    }
  }

  /**
   * RN-EST-013 — "Exclusões por shelf life (RN-EST-012) admitem quebra apenas
   * com autorização registrada do cliente (ANEXO OBRIGATÓRIO na exceção)".
   * `attachment_keys` foi adicionada a operational_exception na migration 0049.
   */
  private async assertShelfLifeBreakHasClientAttachment(client: PoolClient, input: ReserveStockInput): Promise<void> {
    const result = await client.query<{ attachment_keys: string[] }>(
      `SELECT attachment_keys FROM wms.operational_exception WHERE id = $1 AND tenant_id = $2`,
      [input.policyBreakExceptionId, input.tenantId]
    );
    const attachments = result.rows[0]?.attachment_keys ?? [];
    if (attachments.length === 0) {
      throw new BadRequestException({
        error: 'SHELF_LIFE_BREAK_REQUIRES_ATTACHMENT',
        detail:
          'RN-EST-013: a quebra por shelf life (RN-EST-012) exige autorização registrada do cliente — ' +
          'anexo obrigatório na exceção EST.QUEBRA_FEFO (operational_exception.attachment_keys)',
      });
    }
  }
}
