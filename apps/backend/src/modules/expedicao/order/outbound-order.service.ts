// DOC-06 §4.1 — Pedido: criação (RF-EXP-001), liberação com validação
// [INVIOLÁVEL] item a item (RN-EXP-002) e reserva (RN-EXP-003).
//
// A liberação é o ponto em que o pedido deixa de ser intenção e passa a
// comprometer saldo real. Por isso as três validações do RN-EXP-002 rodam
// TODAS antes de qualquer efeito, e a lista de pendências devolvida é
// DETERMINÍSTICA (mesma ordem dos itens, mesmo texto) — quem recebe a
// rejeição precisa saber exatamente o que corrigir, item a item.
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { StockSelectionService } from '../../estoque/selection/stock-selection.service.js';
import { StockReservationService } from '../../estoque/selection/stock-reservation.service.js';
import { OutboundFlowService } from './outbound-flow.service.js';
import { InboundInvoiceFiscalService } from '../../fiscal/inbound-invoice/inbound-invoice-fiscal.service.js';

export interface CreateOutboundOrderItemInput {
  productId: string;
  /** Quantidade na unidade BASE, ou em embalagem quando `packagingId` é informado (RN-DAD-021). */
  qty: number;
  packagingId?: string | null;
}

export interface CreateOutboundOrderInput {
  tenantId: string;
  warehouseId: string;
  items: CreateOutboundOrderItemInput[];
  recipientName?: string | null;
  recipientDocument?: string | null;
  expectedDispatchDate?: string | null;
  carrierName?: string | null;
  appointmentId?: string | null;
  actorUserId: string;
}

/** RN-EXP-002 — uma pendência de liberação, por item. */
export interface ReleasePendency {
  lineNumber: number;
  productId: string;
  /** Catálogo FECHADO: os três motivos que RN-EXP-002 enumera. */
  reason: 'PHYSICAL_STOCK' | 'FISCAL_STOCK' | 'BLOCKED';
  detail: string;
}

export interface ReleaseOutboundOrderResult {
  order: any;
  releasedItems: number;
  pendencies: ReleasePendency[];
  /** RN-EXP-002: pedido remanescente vinculado, quando houve liberação parcial. */
  remainderOrderId: string | null;
  qtyReservedTotal: number;
}

@Injectable()
export class OutboundOrderService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(DocumentNumberingService) private readonly documentNumberingService: DocumentNumberingService,
    @Inject(StockSelectionService) private readonly stockSelectionService: StockSelectionService,
    @Inject(StockReservationService) private readonly stockReservationService: StockReservationService,
    @Inject(OutboundFlowService) private readonly outboundFlowService: OutboundFlowService,
    @Inject(InboundInvoiceFiscalService) private readonly inboundInvoiceFiscalService: InboundInvoiceFiscalService
  ) {}

  /**
   * RF-EXP-001 — criação. Numeração `PED` (RN-DAD-040, Sessão 2B) e itens na
   * unidade BASE: quando o pedido chega em embalagem, a conversão RN-DAD-021
   * é aplicada AQUI (`qty × qty_in_base_uom`), e o par informado fica
   * registrado em `source_packaging_id`/`source_qty` para rastreabilidade —
   * o resto do sistema só lida com unidade base.
   */
  async create(input: CreateOutboundOrderInput) {
    if (input.items.length === 0) {
      throw new BadRequestException({ error: 'EMPTY_ORDER', detail: 'RF-EXP-001: pedido exige ao menos 1 item' });
    }
    for (const item of input.items) {
      if (item.qty <= 0) {
        throw new BadRequestException({ error: 'INVALID_QTY', detail: `RF-EXP-001: quantidade deve ser > 0 (produto ${item.productId})` });
      }
    }

    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    const created = await this.db.transaction(ctx, async (client) => {
      const warehouseResult = await client.query(`SELECT code FROM wms.warehouse WHERE id = $1`, [input.warehouseId]);
      if (warehouseResult.rows.length === 0) throw new NotFoundException(`warehouse ${input.warehouseId} not found`);
      const number = await this.documentNumberingService.generateDocumentNumber(client, 'OUTBOUND_ORDER', input.warehouseId, warehouseResult.rows[0].code, input.actorUserId);

      const orderResult = await client.query(
        `INSERT INTO wms.outbound_order (
           tenant_id, warehouse_id, number, status, recipient_name, recipient_document,
           expected_dispatch_date, carrier_name, appointment_id, created_by
         ) VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          input.tenantId,
          input.warehouseId,
          number,
          input.recipientName ?? null,
          input.recipientDocument ?? null,
          input.expectedDispatchDate ?? null,
          input.carrierName ?? null,
          input.appointmentId ?? null,
          input.actorUserId,
        ]
      );
      const order = orderResult.rows[0];

      const items = [];
      let lineNumber = 1;
      for (const item of input.items) {
        const qtyBase = await this.convertToBaseUom(client, item);
        const itemResult = await client.query(
          `INSERT INTO wms.outbound_order_item (
             tenant_id, outbound_order_id, product_id, line_number, qty_ordered,
             source_packaging_id, source_qty, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [input.tenantId, order.id, item.productId, lineNumber, qtyBase, item.packagingId ?? null, item.packagingId ? item.qty : null, input.actorUserId]
        );
        items.push(itemResult.rows[0]);
        lineNumber += 1;
      }

      // RN-EXP-010: o pedido instancia o Fluxo Operacional já na criação —
      // as 8 etapas nascem PENDING e a etapa "Pedido" só conclui na liberação.
      await this.outboundFlowService.createFlowForOrder(client, { tenantId: input.tenantId, warehouseId: input.warehouseId, orderId: order.id }, input.actorUserId);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.pedido_criado',
        tenant_id: input.tenantId,
        warehouse_id: input.warehouseId,
        actor_user_id: input.actorUserId,
        payload: { outbound_order_id: order.id, number: order.number, item_count: items.length },
      });

      return { order, items };
    });

    await this.auditService.record({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'API',
      entity: 'outbound_order',
      entityId: created.order.id,
      action: 'CREATE',
      requirementId: 'DOC-06 RF-EXP-001',
      after: created.order,
    });

    return created;
  }

  /** RN-DAD-021: conversão ÚNICA pela `qty_in_base_uom` da embalagem. */
  private async convertToBaseUom(client: PoolClient, item: CreateOutboundOrderItemInput): Promise<number> {
    if (!item.packagingId) return item.qty;
    const result = await client.query<{ qty_in_base_uom: string; product_id: string }>(
      `SELECT qty_in_base_uom, product_id FROM wms.product_packaging WHERE id = $1`,
      [item.packagingId]
    );
    const packaging = result.rows[0];
    if (!packaging) throw new NotFoundException(`product_packaging ${item.packagingId} not found`);
    if (packaging.product_id !== item.productId) {
      throw new BadRequestException({
        error: 'PACKAGING_PRODUCT_MISMATCH',
        detail: `RN-DAD-021: a embalagem ${item.packagingId} não pertence ao produto ${item.productId}`,
      });
    }
    return item.qty * Number(packaging.qty_in_base_uom);
  }

  /**
   * RN-EXP-002 [INVIOLÁVEL] + RN-EXP-003 — liberação.
   *
   * Ordem de execução, deliberada: TODAS as validações de TODOS os itens
   * primeiro (juntando as pendências), e só então os efeitos. Validar-e-
   * efetivar item a item deixaria efeito parcial ao encontrar a primeira
   * pendência — e RN-EXP-002 exige a lista COMPLETA de pendências.
   */
  async release(orderId: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<ReleaseOutboundOrderResult> {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    const order = await this.loadOrder(orderId, ctx);
    if (order.status !== 'RELEASED' && order.status !== 'DRAFT') {
      throw new ConflictException({ error: 'ORDER_NOT_RELEASABLE', detail: `§5.1: liberação exige pedido em DRAFT (status atual: ${order.status})` });
    }
    // RN-EXP-003: RELEASED_EXPIRED (substado) volta a ser liberável.
    if (order.status === 'RELEASED' && !order.reservation_expired) {
      throw new ConflictException({ error: 'ORDER_ALREADY_RELEASED', detail: 'O pedido já está liberado com reserva vigente' });
    }

    const allowPartial = await this.resolvePartialReleaseParameter(ctx);

    const result = await this.db.transaction(ctx, async (client) => {
      // `moved_to_order_id IS NULL`: itens que já migraram para um pedido
      // remanescente numa liberação anterior não fazem mais parte deste pedido.
      const itemsResult = await client.query(
        `SELECT * FROM wms.outbound_order_item WHERE outbound_order_id = $1 AND moved_to_order_id IS NULL ORDER BY line_number ASC`,
        [orderId]
      );
      const items = itemsResult.rows;

      const blocked = await this.loadBlockingStatus(client, tenantId, items);
      const controlsFiscalStock = await this.clientControlsFiscalStock(client, tenantId, warehouseId);

      const pendencies: ReleasePendency[] = [];
      const releasable: any[] = [];

      for (const item of items) {
        const qtyPending = Number(item.qty_ordered) - Number(item.qty_reserved);
        if (qtyPending <= 0) continue; // já reservado (re-liberação após expiração)

        // ── Validação 3: bloqueios (RF-DAD-052) ─────────────────────────
        const blockReason = blocked.get(item.product_id);
        if (blockReason) {
          pendencies.push({ lineNumber: item.line_number, productId: item.product_id, reason: 'BLOCKED', detail: blockReason });
          continue;
        }

        // ── Validação 1: saldo FÍSICO pela Seleção de Saldo (5B) ─────────
        // purpose CLIENT_DISPATCH: é expedição a cliente, então RN-EST-012
        // (shelf life mínimo) incide — exatamente o que RN-EXP-002 item 1 pede.
        const selection = await this.stockSelectionService.selectInTransaction(client, {
          tenantId,
          warehouseId,
          productId: item.product_id,
          demandQty: qtyPending,
          purpose: 'CLIENT_DISPATCH',
          actorUserId,
        });
        if (selection.shortfall > 0) {
          pendencies.push({
            lineNumber: item.line_number,
            productId: item.product_id,
            reason: 'PHYSICAL_STOCK',
            detail: `saldo físico insuficiente: faltam ${selection.shortfall} de ${qtyPending}`,
          });
          continue;
        }

        // ── Validação 2: saldo FISCAL (RG-014) ──────────────────────────
        if (controlsFiscalStock) {
          // DOC-08 RN-FIS-010 item 2: prazo de regularização expirado sem
          // Nota de Armazenagem cobrindo bloqueia a liberação com mensagem
          // ESPECÍFICA de prazo (distinta da genérica de saldo insuficiente
          // abaixo, mesmo quando teoricamente ainda houvesse crédito fiscal
          // de OUTRA NF de entrada do mesmo produto).
          const today = new Date().toISOString().slice(0, 10);
          const expiredUncovered = await this.inboundInvoiceFiscalService.hasExpiredUncoveredDeadline(client, tenantId, warehouseId, item.product_id, today);
          if (expiredUncovered) {
            pendencies.push({
              lineNumber: item.line_number,
              productId: item.product_id,
              reason: 'FISCAL_STOCK',
              detail: `RN-FIS-010: prazo de regularização fiscal expirado sem Nota de Armazenagem cobrindo o produto ${item.product_id}`,
            });
            continue;
          }

          const availableFiscal = await this.loadAvailableFiscalStock(client, tenantId, warehouseId, item.product_id);
          if (availableFiscal < qtyPending) {
            pendencies.push({
              lineNumber: item.line_number,
              productId: item.product_id,
              reason: 'FISCAL_STOCK',
              // Texto EXATO do cenário Gherkin do §6.
              detail: `saldo fiscal insuficiente: disponível ${availableFiscal}`,
            });
            continue;
          }
        }

        releasable.push({ item, qtyPending });
      }

      // Nenhum item liberável, ou liberação parcial desabilitada com
      // pendências: rejeição determinística, sem efeito nenhum.
      if (releasable.length === 0 || (pendencies.length > 0 && !allowPartial)) {
        throw new BadRequestException({
          error: 'ORDER_RELEASE_REJECTED',
          detail: `RN-EXP-002: liberação rejeitada com ${pendencies.length} pendência(s)`,
          pendencies,
        });
      }

      // ── RN-EXP-003 — reserva dos itens liberáveis ────────────────────
      let qtyReservedTotal = 0;
      for (const { item, qtyPending } of releasable) {
        const reservation = await this.stockReservationService.reserveInTransaction(client, {
          tenantId,
          warehouseId,
          productId: item.product_id,
          demandQty: qtyPending,
          purpose: 'CLIENT_DISPATCH',
          // O detalhamento saldo→item exigido por RN-EXP-003: a reserva
          // aponta para a LINHA do pedido, não para o pedido — é por linha
          // que o picking (6B) vai consumir.
          demandRefType: 'OUTBOUND_ORDER_ITEM',
          demandRefId: item.id,
          actorUserId,
        });
        await client.query(
          `UPDATE wms.outbound_order_item SET qty_reserved = qty_reserved + $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
          [item.id, reservation.qtyReserved, actorUserId]
        );
        qtyReservedTotal += reservation.qtyReserved;
      }

      // ── Liberação parcial: pedido remanescente VINCULADO ─────────────
      let remainderOrderId: string | null = null;
      if (pendencies.length > 0) {
        remainderOrderId = await this.createRemainderOrder(client, { order, tenantId, warehouseId, pendencies, items }, actorUserId);
      }

      // Etapa 1 "Pedido" conclui: liberação efetivada (RN-EXP-010) → RELEASED.
      //
      // Só na PRIMEIRA liberação. Numa RE-liberação após expiração de reserva
      // (RN-EXP-003), a etapa já está DONE e o pedido já é RELEASED: a
      // expiração devolve o pedido a `RELEASED_EXPIRED` "para nova liberação",
      // mas NÃO desfaz a etapa — a liberação original de fato aconteceu.
      // Desfazer a etapa é privilégio do ESTORNO (RN-EXP-070), não da
      // expiração. Sem esta guarda, a re-liberação bateria em
      // FLOW_STEP_ORDER_VIOLATION contra a própria etapa já concluída.
      const stepResult = await client.query(
        `SELECT fs.status FROM wms.flow_step fs
         JOIN wms.operation_flow of ON of.id = fs.operation_flow_id
         WHERE of.entity = 'outbound_order' AND of.entity_id = $1 AND fs.step_code = 'PEDIDO'`,
        [orderId]
      );
      if (stepResult.rows[0]?.status === 'PENDING') {
        await this.outboundFlowService.completeOrderStep(client, { tenantId, warehouseId, orderId, step: 'PEDIDO' }, actorUserId);
      }

      const updated = await client.query(
        `UPDATE wms.outbound_order SET released_at = now(), reservation_expired = FALSE, reserved_at = now(), updated_at = now(), updated_by = $2
         WHERE id = $1 RETURNING *`,
        [orderId, actorUserId]
      );

      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.pedido_liberado',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: {
          outbound_order_id: orderId,
          number: order.number,
          released_items: releasable.length,
          pendencies: pendencies.length,
          remainder_order_id: remainderOrderId,
        },
      });
      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.reserva_efetivada',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { outbound_order_id: orderId, qty_reserved: qtyReservedTotal },
      });

      return { order: updated.rows[0], releasedItems: releasable.length, pendencies, remainderOrderId, qtyReservedTotal };
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'outbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-06 RN-EXP-002/003',
      before: order,
      after: result.order,
    });

    return result;
  }

  /**
   * RN-EXP-002 — "gerando pedido remanescente vinculado": os itens que NÃO
   * puderam ser liberados viram um novo pedido em DRAFT, apontando para o
   * original por `remainder_of_order_id`.
   */
  private async createRemainderOrder(
    client: PoolClient,
    args: { order: any; tenantId: string; warehouseId: string; pendencies: ReleasePendency[]; items: any[] },
    actorUserId: string
  ): Promise<string> {
    const warehouseResult = await client.query(`SELECT code FROM wms.warehouse WHERE id = $1`, [args.warehouseId]);
    const number = await this.documentNumberingService.generateDocumentNumber(client, 'OUTBOUND_ORDER', args.warehouseId, warehouseResult.rows[0].code, actorUserId);

    const remainderResult = await client.query(
      `INSERT INTO wms.outbound_order (
         tenant_id, warehouse_id, number, status, recipient_name, recipient_document,
         expected_dispatch_date, carrier_name, appointment_id, remainder_of_order_id, created_by
       ) VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        args.tenantId,
        args.warehouseId,
        number,
        args.order.recipient_name,
        args.order.recipient_document,
        args.order.expected_dispatch_date,
        args.order.carrier_name,
        args.order.appointment_id,
        args.order.id,
        actorUserId,
      ]
    );
    const remainderId = remainderResult.rows[0].id;

    const pendingLines = new Set(args.pendencies.map((p) => p.lineNumber));
    let lineNumber = 1;
    for (const item of args.items) {
      if (!pendingLines.has(item.line_number)) continue;
      await client.query(
        `INSERT INTO wms.outbound_order_item (tenant_id, outbound_order_id, product_id, line_number, qty_ordered, source_packaging_id, source_qty, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [args.tenantId, remainderId, item.product_id, lineNumber, Number(item.qty_ordered) - Number(item.qty_reserved), item.source_packaging_id, item.source_qty, actorUserId]
      );
      lineNumber += 1;
    }

    // O remanescente também instancia seu próprio fluxo (RN-EXP-010).
    await this.outboundFlowService.createFlowForOrder(client, { tenantId: args.tenantId, warehouseId: args.warehouseId, orderId: remainderId }, actorUserId);

    // Os itens pendentes saem do pedido original: ele foi liberado só com o
    // que era liberável, e o que faltou vive no remanescente. Marcados como
    // MIGRADOS, nunca apagados — DELETE é proibido em tabela de negócio
    // (RG-003), e manter a linha original preserva o que foi de fato pedido.
    for (const item of args.items) {
      if (!pendingLines.has(item.line_number)) continue;
      await client.query(`UPDATE wms.outbound_order_item SET moved_to_order_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1`, [
        item.id,
        remainderId,
        actorUserId,
      ]);
    }

    return remainderId;
  }

  /**
   * RN-EXP-002 item 2 — "ONDE o cliente controlar Estoque Fiscal (RG-014)".
   *
   * [LACUNA: nem DOC-06 nem DOC-02 definem a FLAG que diz se o cliente
   * controla Estoque Fiscal. Adotado `client_warehouse_settings.fiscal_mode`
   * em ('EMISSAO_PROPRIA','HIBRIDO'), por eliminação: o DOC-00 §3.1 (v1.4.0,
   * RG-016) associa `INTEGRADO_ERP` ao caso em que "o ERP da empresa responde
   * pelo fiscal" e o Estoque Fiscal é "não aplicável".]
   */
  private async clientControlsFiscalStock(client: PoolClient, tenantId: string, warehouseId: string): Promise<boolean> {
    const result = await client.query<{ fiscal_mode: string }>(
      `SELECT fiscal_mode FROM wms.client_warehouse_settings WHERE tenant_id = $1 AND warehouse_id = $2`,
      [tenantId, warehouseId]
    );
    const fiscalMode = result.rows[0]?.fiscal_mode;
    return fiscalMode === 'EMISSAO_PROPRIA' || fiscalMode === 'HIBRIDO';
  }

  /**
   * RG-014 — saldo fiscal DISPONÍVEL total do produto.
   *
   * A migration 0014 fixou que o disponível é "SEMPRE calculado (nunca coluna
   * persistida)": `qty_credited − qty_consumed`. A migration 0069 (Sessão
   * 8A, DOC-08 RN-FIS-070) acrescentou `qty_pending_writeoff` — baixa
   * preventiva por descarte/ajuste negativo antes do documento de baixa do
   * cliente — que também reduz o disponível para consumo.
   * [LACUNA: DOC-08 detalha a alocação POR NOTA (RN-FIS-030, ordem de
   * consumo); aqui valida-se apenas SUFICIÊNCIA total, que é o que
   * RN-EXP-002 item 2 pede — a alocação por nota real é feita por
   * FiscalConsumptionService na montagem da Nota de Devolução.]
   */
  private async loadAvailableFiscalStock(client: PoolClient, tenantId: string, warehouseId: string, productId: string): Promise<number> {
    const result = await client.query<{ available: string }>(
      `SELECT COALESCE(SUM(qty_credited - qty_consumed - qty_pending_writeoff), 0) AS available
       FROM wms.fiscal_stock_balance
       WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3`,
      [tenantId, warehouseId, productId]
    );
    return Number(result.rows[0].available);
  }

  /** RN-EXP-002 item 3 — bloqueios de produto/cliente (RF-DAD-052). */
  private async loadBlockingStatus(client: PoolClient, tenantId: string, items: any[]): Promise<Map<string, string>> {
    const blocked = new Map<string, string>();

    const clientResult = await client.query<{ status: string }>(`SELECT status FROM wms.client WHERE id = $1`, [tenantId]);
    const clientStatus = clientResult.rows[0]?.status;
    if (clientStatus && clientStatus !== 'ACTIVE') {
      for (const item of items) blocked.set(item.product_id, `cliente bloqueado (status ${clientStatus})`);
      return blocked;
    }

    const productIds = [...new Set(items.map((i) => i.product_id))];
    if (productIds.length === 0) return blocked;
    const productsResult = await client.query<{ id: string; status: string }>(`SELECT id, status FROM wms.product WHERE id = ANY($1::uuid[])`, [productIds]);
    for (const product of productsResult.rows) {
      if (product.status !== 'ACTIVE') blocked.set(product.id, `produto bloqueado (status ${product.status})`);
    }
    return blocked;
  }

  /** `EXP.PERMITE_LIBERACAO_PARCIAL` (§4.1, padrão true). */
  private async resolvePartialReleaseParameter(ctx: TenantContext): Promise<boolean> {
    const result = await this.db.query(ctx, `SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EXP.PERMITE_LIBERACAO_PARCIAL'`, []);
    const value = result.rows[0]?.value;
    return value === undefined ? true : value === 'true';
  }

  private async loadOrder(orderId: string, ctx: TenantContext) {
    const result = await this.db.query(ctx, `SELECT * FROM wms.outbound_order WHERE id = $1`, [orderId]);
    const order = result.rows[0];
    if (!order) throw new NotFoundException(`outbound_order ${orderId} not found`);
    return order;
  }
}
