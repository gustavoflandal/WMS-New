// DOC-04 §4.6 — Cross-docking. RN-REC-050 (elegibilidade), RF-REC-051
// (fluxo), RNF-REC-052 (tempo máximo em cross-docking).
//
// [LACUNA: DOC-06 não implementado nesta sessão] — `outbound_order` não
// existe; o vínculo é por referência textual (`crossdock_link.
// outbound_order_reference`, já decidido na migration 0040) e "o Pedido
// correspondente pula a etapa de Picking" não é aplicado a nenhum Pedido
// real (não há Pedido real para aplicar).
// [LACUNA: DOC-05 não implementado nesta sessão] — "gerando saldo com
// Reserva imediata ao Pedido vinculado" não credita `stock_balance`/
// reserva real (tabela inexistente para este fluxo); o palete é apenas
// movido para uma location de zona CROSS_DOCKING e o crossdock_link marca
// CONSUMED, sinalizando a reserva conceitualmente.
// [DÉBITO: Sessão 4B] — "SE o Pedido vinculado for cancelado... o sistema
// gera tarefas de putaway normal (motor RN-REC-040)": `cancelLink()`
// desfaz a reserva (status CANCELLED) mas não gera nenhuma putaway_task —
// depende do motor de putaway, fora de escopo desta sessão.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PalletService } from '../../cadastro/pallet/pallet.service.js';
import { mapRecebimentoDbError } from '../shared/db-error.util.js';

const DEFAULT_CROSSDOCK_MAX_HOURS = 24;

@Injectable()
export class CrossDockService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(PalletService) private readonly palletService: PalletService
  ) {}

  /**
   * RN-REC-050 — vínculo ANTES da conferência (item ainda PENDING/
   * CHECKING_PENDING, nunca CHECKED). Quantidade parcial permitida; a soma
   * dos vínculos RESERVED/CONSUMED de um item não pode exceder qty_expected.
   */
  async linkToOutboundOrder(
    itemId: string,
    tenantId: string,
    warehouseId: string,
    outboundOrderReference: string,
    qty: number,
    actorUserId: string
  ) {
    const item = await this.loadItem(itemId, tenantId, warehouseId, actorUserId);
    if (!['PENDING', 'CHECKING_PENDING'].includes(item.status)) {
      throw new BadRequestException({
        error: 'ITEM_ALREADY_CHECKED',
        detail: `RN-REC-050: vínculo de cross-docking só é permitido ANTES da conferência (status atual do item: ${item.status})`,
      });
    }

    const linkedResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT COALESCE(SUM(qty_linked), 0) AS linked FROM wms.crossdock_link WHERE inbound_order_item_id = $1 AND status IN ('RESERVED', 'CONSUMED')`,
      [itemId]
    );
    const alreadyLinked = Number(linkedResult.rows[0].linked);
    if (qty <= 0 || alreadyLinked + qty > Number(item.qty_expected)) {
      throw new BadRequestException({
        error: 'QTY_EXCEEDS_EXPECTED',
        detail: `RN-REC-050: quantidade vinculada (${alreadyLinked + qty}) excederia qty_expected (${item.qty_expected}) do item ${itemId}`,
      });
    }

    try {
      const result = await this.db.query(
        { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
        `INSERT INTO wms.crossdock_link (tenant_id, warehouse_id, inbound_order_item_id, outbound_order_reference, qty_linked, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'RESERVED',$6) RETURNING *`,
        [tenantId, warehouseId, itemId, outboundOrderReference, qty, actorUserId]
      );
      const link = result.rows[0];

      await this.auditService.record({
        tenantId,
        warehouseId,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'crossdock_link',
        entityId: link.id,
        action: 'CREATE',
        requirementId: 'DOC-04 RN-REC-050',
        after: link,
      });

      return link;
    } catch (error) {
      mapRecebimentoDbError(error);
    }
  }

  /**
   * RF-REC-051 — após a conferência: paletiza SEPARADAMENTE as quantidades
   * vinculadas (RESERVED) de um mesmo item, move para uma location de zona
   * CROSS_DOCKING e marca os vínculos CONSUMED. "Sem putaway de
   * armazenagem": o palete resultante fica FORA do universo de paletes que
   * o futuro motor de putaway (4B) deveria considerar (não há, nesta
   * sessão, nenhuma estrutura de onde ele leria candidatos — é só uma
   * garantia de que nada aqui cria uma putaway_task para ele).
   */
  async formCrossDockPallet(tenantId: string, warehouseId: string, palletType: string, linkIds: string[], actorUserId: string) {
    if (!linkIds || linkIds.length === 0) {
      throw new BadRequestException({ error: 'NO_LINKS', detail: 'RF-REC-051: informe ao menos 1 crossdock_link para paletizar' });
    }

    const links: any[] = [];
    let inboundOrderId: string | null = null;
    for (const linkId of linkIds) {
      const linkResult = await this.db.query(
        { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
        `SELECT cl.*, i.inbound_order_id, i.product_id, i.batch_id, i.status AS item_status, i.qty_received
         FROM wms.crossdock_link cl JOIN wms.inbound_order_item i ON i.id = cl.inbound_order_item_id
         WHERE cl.id = $1`,
        [linkId]
      );
      const link = linkResult.rows[0];
      if (!link) throw new NotFoundException(`crossdock_link ${linkId} not found`);
      if (link.status !== 'RESERVED') {
        throw new BadRequestException({ error: 'LINK_NOT_RESERVED', detail: `RF-REC-051: crossdock_link ${linkId} não está RESERVED (status atual: ${link.status})` });
      }
      if (link.item_status !== 'CHECKED') {
        throw new BadRequestException({
          error: 'ITEM_NOT_CHECKED',
          detail: `RF-REC-051: conferência ainda não concluída para o item do crossdock_link ${linkId} (status: ${link.item_status})`,
        });
      }
      if (Number(link.qty_linked) > Number(link.qty_received)) {
        // [LACUNA: DOC-04 não define o desfecho quando uma divergência
        // (RN-REC-022/023) reduz qty_received abaixo do que foi reservado
        // para cross-docking antes da conferência — rejeitado aqui de
        // forma determinística em vez de paletizar quantidade indisponível.
        throw new BadRequestException({
          error: 'LINKED_QTY_EXCEEDS_RECEIVED',
          detail: `RF-REC-051: crossdock_link ${linkId} reservou ${link.qty_linked} mas o item só recebeu ${link.qty_received} (divergência na conferência)`,
        });
      }
      inboundOrderId = link.inbound_order_id;
      links.push(link);
    }

    const crossDockLocationResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT l.id FROM wms.location l JOIN wms.zone z ON z.id = l.zone_id
       WHERE z.warehouse_id = $1 AND z.zone_type = 'CROSS_DOCKING' AND l.status = 'ACTIVE' LIMIT 1`,
      [warehouseId]
    );
    const crossDockLocation = crossDockLocationResult.rows[0];
    if (!crossDockLocation) {
      throw new BadRequestException({ error: 'NO_CROSS_DOCKING_LOCATION', detail: 'RF-REC-051: nenhuma location ACTIVE de zona CROSS_DOCKING configurada para este armazém' });
    }

    try {
      const pallet = await this.palletService.create({ tenant_id: tenantId, warehouse_id: warehouseId, pallet_type: palletType }, actorUserId);
      await this.db.query(
        { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
        `UPDATE wms.pallet SET inbound_order_id = $2, current_location_id = $3, status = 'STORED' WHERE id = $1`,
        [pallet.id, inboundOrderId, crossDockLocation.id]
      );

      for (const link of links) {
        await this.db.query(
          { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
          `INSERT INTO wms.pallet_content (tenant_id, pallet_id, product_id, batch_id, qty, inbound_order_item_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, pallet.id, link.product_id, link.batch_id, link.qty_linked, link.inbound_order_item_id, actorUserId]
        );
        await this.db.query(
          { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
          `UPDATE wms.crossdock_link SET status = 'CONSUMED', pallet_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
          [link.id, pallet.id, actorUserId]
        );
      }

      await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
        await this.eventsService.publishInTransaction(client, {
          event_type: 'recebimento.crossdock_reservado',
          tenant_id: tenantId,
          warehouse_id: warehouseId,
          actor_user_id: actorUserId,
          payload: {
            pallet_id: pallet.id,
            lpn: pallet.lpn,
            crossdock_link_ids: links.map((l) => l.id),
            outbound_order_references: [...new Set(links.map((l) => l.outbound_order_reference))],
          },
        });
      });

      await this.auditService.record({
        tenantId,
        warehouseId,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'pallet',
        entityId: pallet.id,
        action: 'CREATE',
        requirementId: 'DOC-04 RF-REC-051',
        after: pallet,
      });

      return pallet;
    } catch (error) {
      mapRecebimentoDbError(error);
    }
  }

  /** RF-REC-051 "SE o Pedido vinculado for cancelado, a reserva é desfeita". */
  async cancelLink(linkId: string, tenantId: string, warehouseId: string, reason: string, actorUserId: string) {
    const linkResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.crossdock_link WHERE id = $1`,
      [linkId]
    );
    const link = linkResult.rows[0];
    if (!link) throw new NotFoundException(`crossdock_link ${linkId} not found`);
    if (link.status === 'CANCELLED') {
      throw new BadRequestException({ error: 'LINK_ALREADY_CANCELLED', detail: `crossdock_link ${linkId} já está CANCELLED` });
    }

    const updated = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `UPDATE wms.crossdock_link SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [linkId, actorUserId]
    );

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'crossdock_link',
      entityId: linkId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 RF-REC-051',
      reason,
      before: link,
      after: updated.rows[0],
    });

    return updated.rows[0];
  }

  /**
   * RNF-REC-052 — saldo em zona CROSS_DOCKING além de REC.CROSSDOCK_TEMPO_
   * MAX_H (padrão 24h) gera alerta. Roda cross-tenant via
   * transactionAsWorker (ADR-006), mesmo padrão de outros workers desta
   * base. Chamado pelo worker (`CrossDockAgingWorkerImpl`), não pela API.
   */
  async checkAging(): Promise<{ alertedLinkIds: string[] }> {
    const alerted: Array<{ id: string; tenant_id: string; warehouse_id: string; outbound_order_reference: string; updated_at: Date }> = [];

    await this.db.transactionAsWorker(async (client) => {
      const paramResult = await client.query(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'REC.CROSSDOCK_TEMPO_MAX_H'`);
      const maxHours = paramResult.rows[0]?.value ? Number(paramResult.rows[0].value) : DEFAULT_CROSSDOCK_MAX_HOURS;

      const candidates = await client.query(
        `SELECT id, tenant_id, warehouse_id, outbound_order_reference, updated_at
         FROM wms.crossdock_link
         WHERE status = 'CONSUMED' AND updated_at < now() - ($1 || ' hours')::interval`,
        [maxHours]
      );

      for (const row of candidates.rows) {
        // RNF-REC-052 exige "alerta no painel e no tópico alertas" mas não
        // há evento correspondente nos 11 listados em §4.7 — mesmo
        // precedente já usado em `portaria.vaga_indisponivel` (RN-POR-013
        // §6, DOC-03): evento novo citando a fonte EXATA (RNF-REC-052), não
        // o catálogo de 11. Mapeado em packages/contracts/realtime-topics.ts.
        await this.eventsService.publishInTransaction(client, {
          event_type: 'recebimento.crossdock_tempo_excedido',
          tenant_id: row.tenant_id,
          warehouse_id: row.warehouse_id,
          payload: { crossdock_link_id: row.id, outbound_order_reference: row.outbound_order_reference, consumed_at: row.updated_at },
        });
        alerted.push(row);
      }
    });

    return { alertedLinkIds: alerted.map((a) => a.id) };
  }

  private async loadItem(itemId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.inbound_order_item WHERE id = $1`,
      [itemId]
    );
    const item = result.rows[0];
    if (!item) throw new NotFoundException(`inbound_order_item ${itemId} not found`);
    return item;
  }
}
