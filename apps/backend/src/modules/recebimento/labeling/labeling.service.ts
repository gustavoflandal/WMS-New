// DOC-04 §4.4 — Etiquetagem e paletização. RF-REC-030 (formação de paletes
// e LPN, RG-007), RN-REC-031 (quarentena por espécie).
//
// [LACUNA: DOC-11 não implementado nesta sessão] — RF-REC-030 pede "envia o
// job de impressão da etiqueta (DOC-11)"; o evento `recebimento.lpn_gerado`
// é publicado como único sinal disponível para um pipeline de impressão
// futuro.
// [DÉBITO: Sessão 4B] — RN-REC-031 pede que a liberação de quarentena
// "gere tarefas de transferência para armazenagem definitiva (DOC-05)";
// isso depende do motor de putaway (RN-REC-040/041/042), fora de escopo
// desta sessão — `releaseQuarantine()` muda o lote para RELEASED e publica
// o evento, mas não gera nenhuma tarefa.
// [DÉBITO: Sessão 4B] — §5.1 diz "LABELING -> PUTAWAY_IN_PROGRESS: tarefas
// geradas" — como a geração de tarefas é o motor de putaway (fora de
// escopo), este service NÃO transiciona `inbound_order.status` para
// PUTAWAY_IN_PROGRESS; a Ordem permanece LABELING até a Sessão 4B poder
// gerar as tarefas de fato. `getLabelingProgress()` permite à UI saber
// quando todos os itens já foram paletizados, mesmo sem a transição.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PalletService } from '../../cadastro/pallet/pallet.service.js';
import { BatchService } from '../../cadastro/batch/batch.service.js';
import { mapRecebimentoDbError } from '../shared/db-error.util.js';

export interface PalletContentInput {
  inboundOrderItemId: string;
  qty: number;
  batchCode?: string;
  manufactureDate?: string;
  expirationDate?: string;
}

@Injectable()
export class LabelingService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(PalletService) private readonly palletService: PalletService,
    @Inject(BatchService) private readonly batchService: BatchService
  ) {}

  /** §5.1: CHECKED -> LABELING ("etiquetagem/paletização"). */
  async startLabeling(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const order = await this.loadOrder(orderId, tenantId, warehouseId, actorUserId);
    if (order.status !== 'CHECKED') {
      throw new BadRequestException({ error: 'ORDER_NOT_CHECKED', detail: `§5.1: ordem ${order.number} não está CHECKED (status atual: ${order.status})` });
    }

    const updated = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `UPDATE wms.inbound_order SET status = 'LABELING', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [orderId, actorUserId]
    );

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
      after: updated.rows[0],
    });

    return updated.rows[0];
  }

  /**
   * RF-REC-030 — forma um palete com o conteúdo declarado (produto/lote/
   * quantidade por linha, herdado de cada `inbound_order_item`). Palete
   * misto (múltiplos produtos) exige `REC.PERMITE_PALETE_MISTO` (padrão
   * true). RN-REC-031: lote de espécie em `REC.QUARENTENA_ESPECIES` nasce
   * `QUARANTINE`.
   */
  async formPallet(orderId: string, tenantId: string, warehouseId: string, palletType: string, contents: PalletContentInput[], actorUserId: string) {
    if (!contents || contents.length === 0) {
      throw new BadRequestException({ error: 'NO_CONTENT', detail: 'RF-REC-030: o palete precisa de ao menos 1 linha de conteúdo' });
    }

    const order = await this.loadOrder(orderId, tenantId, warehouseId, actorUserId);
    if (order.status !== 'LABELING') {
      throw new BadRequestException({ error: 'ORDER_NOT_LABELING', detail: `RF-REC-030: ordem ${order.number} não está LABELING (status atual: ${order.status})` });
    }

    const items = new Map<string, any>();
    for (const line of contents) {
      const itemResult = await this.db.query(
        { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
        `SELECT * FROM wms.inbound_order_item WHERE id = $1 AND inbound_order_id = $2`,
        [line.inboundOrderItemId, orderId]
      );
      const item = itemResult.rows[0];
      if (!item) throw new NotFoundException(`inbound_order_item ${line.inboundOrderItemId} not found in order ${orderId}`);
      if (item.status !== 'CHECKED') {
        throw new BadRequestException({ error: 'ITEM_NOT_CHECKED', detail: `RF-REC-030: item ${item.id} ainda não tem contagem final apurada (status atual: ${item.status})` });
      }
      items.set(item.id, item);
    }

    // RF-REC-030: palete misto (>1 produto distinto) exige REC.PERMITE_PALETE_MISTO.
    const distinctProductIds = new Set([...items.values()].map((i) => i.product_id));
    if (distinctProductIds.size > 1) {
      const allowMixed = await this.getBooleanParameter('REC.PERMITE_PALETE_MISTO', true, tenantId, warehouseId, actorUserId);
      if (!allowMixed) {
        throw new BadRequestException({ error: 'MIXED_PALLET_NOT_ALLOWED', detail: 'RF-REC-030: REC.PERMITE_PALETE_MISTO=false — palete misto não permitido' });
      }
    }

    // "Conteúdo do palete = quantidades conferidas restantes" (§5.1): cada
    // linha não pode exceder o que ainda falta paletizar do item.
    for (const line of contents) {
      const remaining = await this.getRemainingQty(items.get(line.inboundOrderItemId), tenantId, warehouseId, actorUserId);
      if (line.qty <= 0 || line.qty > remaining) {
        throw new BadRequestException({
          error: 'QTY_EXCEEDS_REMAINING',
          detail: `RF-REC-020 §5.1: quantidade ${line.qty} excede o restante a paletizar do item ${line.inboundOrderItemId} (${remaining})`,
        });
      }
    }

    const quarantineSpecies = await this.getQuarantineSpecies(tenantId, warehouseId, actorUserId);

    try {
      const pallet = await this.palletService.create({ tenant_id: tenantId, warehouse_id: warehouseId, pallet_type: palletType }, actorUserId);
      await this.db.query(
        { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
        `UPDATE wms.pallet SET inbound_order_id = $2 WHERE id = $1`,
        [pallet.id, orderId]
      );

      for (const line of contents) {
        const item = items.get(line.inboundOrderItemId);
        let batchId: string | null = null;

        if (line.batchCode) {
          // wms.product tem RLS (TENANT) — precisa de this.db.query() com
          // contexto, não queryGlobal(): sem app.tenant_ids setado a
          // policy nega TODAS as linhas, então o JOIN sempre voltava vazio
          // e a quarentena nunca era aplicada (bug real encontrado ao
          // testar RN-REC-031 pela 1ª vez — o lote saía RELEASED em vez de
          // QUARANTINE). product_species em si é GLOBAL (sem RLS), mas o
          // JOIN inteiro herda a restrição da tabela TENANT.
          const speciesResult = await this.db.query(
            { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
            `SELECT ps.requires_batch, ps.code FROM wms.product p JOIN wms.product_species ps ON ps.code = p.species_code WHERE p.id = $1`,
            [item.product_id]
          );
          const species = speciesResult.rows[0];

          let batch;
          try {
            batch = await this.batchService.findByCode(tenantId, actorUserId, item.product_id, line.batchCode);
          } catch {
            batch = await this.batchService.create(
              { tenant_id: tenantId, product_id: item.product_id, batch_code: line.batchCode, manufacture_date: line.manufactureDate, expiration_date: line.expirationDate },
              actorUserId
            );
            // RN-REC-031: lote NOVO de espécie em quarentena nasce QUARANTINE (não reabre um lote já existente diferente disso).
            if (species && quarantineSpecies.includes(species.code)) {
              batch = await this.batchService.update(batch.id, tenantId, warehouseId, { status: 'QUARANTINE' }, actorUserId);
            }
          }
          batchId = batch.id;
        }

        await this.db.query(
          { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
          `INSERT INTO wms.pallet_content (tenant_id, pallet_id, product_id, batch_id, qty, inbound_order_item_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, pallet.id, item.product_id, batchId, line.qty, item.id, actorUserId]
        );
      }

      await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
        await this.eventsService.publishInTransaction(client, {
          event_type: 'recebimento.lpn_gerado',
          tenant_id: tenantId,
          warehouse_id: warehouseId,
          actor_user_id: actorUserId,
          payload: { inbound_order_id: orderId, pallet_id: pallet.id, lpn: pallet.lpn, pallet_type: palletType },
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
        requirementId: 'DOC-04 RF-REC-030',
        after: pallet,
      });

      return pallet;
    } catch (error) {
      mapRecebimentoDbError(error);
    }
  }

  /** RN-REC-031: liberação de quarentena (permissão sensível REC.LIBERAR_QUARENTENA, laudo/motivo obrigatório). */
  async releaseQuarantine(batchId: string, tenantId: string, warehouseId: string, reason: string, actorUserId: string) {
    const batch = await this.batchService.findById(batchId, tenantId, actorUserId);
    if (batch.status !== 'QUARANTINE') {
      throw new BadRequestException({ error: 'BATCH_NOT_IN_QUARANTINE', detail: `RN-REC-031: lote ${batch.batch_code} não está QUARANTINE (status atual: ${batch.status})` });
    }

    const updated = await this.batchService.update(batchId, tenantId, warehouseId, { status: 'RELEASED' }, actorUserId);

    await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      await this.eventsService.publishInTransaction(client, {
        event_type: 'recebimento.quarentena_liberada',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { batch_id: batchId, batch_code: batch.batch_code, reason },
      });
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'batch',
      entityId: batchId,
      action: 'OVERRIDE',
      requirementId: 'DOC-04 RN-REC-031',
      reason,
      before: batch,
      after: updated,
    });

    return updated;
  }

  /** Progresso de paletização por item — quanto já foi formado em paletes vs. quanto ainda falta (§5.1). */
  async getLabelingProgress(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const itemsResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT i.*, COALESCE(SUM(pc.qty), 0) AS qty_palletized
       FROM wms.inbound_order_item i
       LEFT JOIN wms.pallet_content pc ON pc.inbound_order_item_id = i.id
       WHERE i.inbound_order_id = $1 AND i.status = 'CHECKED'
       GROUP BY i.id`,
      [orderId]
    );
    return itemsResult.rows.map((row: any) => ({
      inboundOrderItemId: row.id,
      qtyReceived: Number(row.qty_received),
      qtyPalletized: Number(row.qty_palletized),
      qtyRemaining: Number(row.qty_received) - Number(row.qty_palletized),
    }));
  }

  // ---------------------------------------------------------------------

  private async getRemainingQty(item: any, tenantId: string, warehouseId: string, actorUserId: string): Promise<number> {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT COALESCE(SUM(qty), 0) AS palletized FROM wms.pallet_content WHERE inbound_order_item_id = $1`,
      [item.id]
    );
    return Number(item.qty_received) - Number(result.rows[0].palletized);
  }

  private async getBooleanParameter(name: string, defaultValue: boolean, tenantId: string, warehouseId: string, actorUserId: string): Promise<boolean> {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = $1`,
      [name]
    );
    if (result.rows.length === 0) return defaultValue;
    return result.rows[0].value === 'true';
  }

  /**
   * DOC-04 §4.4/§7: default documentado inclui MEDICAMENTO — usado como
   * fallback quando a linha não existe, mesmo padrão defensivo já usado
   * alhures neste codebase (ex.: GateInService.getToleranceMinutes()) para
   * o caso real de `wms.app_parameter` ser limpo entre arquivos de teste
   * (cleanTestData() do test-setup.helper.ts) sem re-seed das migrations.
   */
  private async getQuarantineSpecies(tenantId: string, warehouseId: string, actorUserId: string): Promise<string[]> {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'REC.QUARENTENA_ESPECIES'`
    );
    if (result.rows.length === 0) return ['MEDICAMENTO'];
    try {
      const parsed = JSON.parse(result.rows[0].value);
      return Array.isArray(parsed) ? parsed : ['MEDICAMENTO'];
    } catch {
      return ['MEDICAMENTO'];
    }
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
}
