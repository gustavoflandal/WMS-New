// DOC-05 §4.7 — RF-EST-060 (geração de escopo, 7 tipos), RN-EST-061
// [INVIOLÁVEL] (congelamento de endereço). A execução da contagem em si
// (RN-EST-062/063/064) é InventoryCountExecutionService — este arquivo só
// cuida do documento (cabeçalho + escopo) e da máquina de estados PLANNED->
// IN_PROGRESS->CANCELLED do §5.1 (ADJUSTMENT_PENDING/COMPLETED nascem da
// execução, não daqui).
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';

export const COUNT_TYPES = ['GERAL', 'ROTATIVO_PRODUTO', 'ROTATIVO_DIA', 'POR_SORTEIO', 'POR_ZONA', 'POR_ESPECIE', 'POR_ENDERECO'] as const;
export type CountType = (typeof COUNT_TYPES)[number];

const DEFAULT_ROTATIVO_DIA_QTY = 20;

export interface PlanInventoryInput {
  tenantId: string;
  warehouseId: string;
  countType: CountType;
  /** ROTATIVO_PRODUTO */
  productIds?: string[];
  /** POR_ZONA */
  zoneIds?: string[];
  /** POR_ESPECIE (wms.product_species.code) */
  species?: string[];
  /** POR_ENDERECO */
  locationIds?: string[];
  /** ROTATIVO_DIA (default EST.INV_ROTATIVO_QTD_DIA) / POR_SORTEIO (obrigatório) */
  sampleSize?: number;
  /** POR_SORTEIO [INVIOLÁVEL §6 "sorteio reprodutível"] — mesma semente = mesma lista. */
  randomSeed?: string;
  /** GERAL — EST.INV_INCLUI_VAZIOS: também inclui endereços ACTIVE sem saldo. */
  includeEmpty?: boolean;
  actorUserId: string;
}

export interface PlanInventoryResult {
  headerId: string;
  documentNumber: string;
  cellCount: number;
  locationCount: number;
}

export interface StartInventoryResult {
  header: Record<string, unknown>;
  /** RN-EST-061: "o planejamento DEVE exibir conflitos com pedidos liberados antes de iniciar" — reservas ATIVAS nos endereços do escopo. Não bloqueia. */
  conflictingLocationIds: string[];
}

interface CandidateCell {
  locationId: string;
  productId: string | null;
  batchId: string | null;
  systemQty: number;
}

function mapCandidateRow(row: { location_id: string; product_id: string; batch_id: string | null; system_qty: string }): CandidateCell {
  return { locationId: row.location_id, productId: row.product_id, batchId: row.batch_id, systemQty: Number(row.system_qty) };
}

@Injectable()
export class InventoryPlanningService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (padrão de todo o módulo).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(DocumentNumberingService) private readonly documentNumberingService: DocumentNumberingService
  ) {}

  /** RF-EST-060 — gera o escopo e cria o cabeçalho + células, status PLANNED (nenhum endereço é tocado ainda). */
  async plan(input: PlanInventoryInput): Promise<PlanInventoryResult> {
    const ctx: TenantContext = { tenant_id: input.tenantId, user_id: input.actorUserId, warehouse_id: input.warehouseId };

    return this.db.transaction(ctx, async (client) => {
      const warehouseResult = await client.query(`SELECT code FROM wms.warehouse WHERE id = $1`, [input.warehouseId]);
      if (warehouseResult.rows.length === 0) throw new NotFoundException(`warehouse ${input.warehouseId} not found`);

      const documentNumber = await this.documentNumberingService.generateDocumentNumber(client, 'INVENTORY', input.warehouseId, warehouseResult.rows[0].code, input.actorUserId);

      const cells = await this.resolveCandidates(client, ctx, input);
      if (cells.length === 0) {
        throw new BadRequestException({ error: 'EMPTY_SCOPE', detail: 'RF-EST-060: nenhum candidato encontrado para o escopo informado' });
      }

      const headerResult = await client.query(
        `INSERT INTO wms.inventory_count (
           tenant_id, warehouse_id, document_number, count_type, status,
           scope_product_ids, scope_zone_ids, scope_species, random_seed, include_empty, created_by
         ) VALUES ($1,$2,$3,$4,'PLANNED',$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          input.tenantId,
          input.warehouseId,
          documentNumber,
          input.countType,
          input.productIds ?? null,
          input.zoneIds ?? null,
          input.species ?? null,
          input.randomSeed ?? null,
          input.includeEmpty ?? false,
          input.actorUserId,
        ]
      );
      const headerId = headerResult.rows[0].id;

      for (const cell of cells) {
        await client.query(
          `INSERT INTO wms.inventory_count_location (
             tenant_id, warehouse_id, header_id, count_type, location_id, product_id, batch_id, system_qty, status, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9)`,
          [input.tenantId, input.warehouseId, headerId, input.countType, cell.locationId, cell.productId, cell.batchId, cell.systemQty, input.actorUserId]
        );
      }

      return { headerId, documentNumber, cellCount: cells.length, locationCount: new Set(cells.map((c) => c.locationId)).size };
    });
  }

  /** RN-EST-061 [INVIOLÁVEL] — PLANNED -> IN_PROGRESS: congela TODOS os endereços do escopo. */
  async start(tenantId: string, warehouseId: string, headerId: string, actorUserId: string): Promise<StartInventoryResult> {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    return this.db.transaction(ctx, async (client) => {
      const headerResult = await client.query(`SELECT * FROM wms.inventory_count WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [headerId, tenantId]);
      const header = headerResult.rows[0];
      if (!header) throw new NotFoundException(`inventory_count ${headerId} not found`);
      if (header.status !== 'PLANNED') {
        throw new ConflictException({ error: 'INVENTORY_NOT_PLANNED', detail: `DOC-05 §5.1: só PLANNED pode iniciar (status atual: ${header.status})` });
      }

      const locationsResult = await client.query(`SELECT DISTINCT location_id FROM wms.inventory_count_location WHERE header_id = $1`, [headerId]);
      const locationIds: string[] = locationsResult.rows.map((r: { location_id: string }) => r.location_id);

      // RN-EST-061: "planejamento DEVE exibir conflitos com pedidos liberados
      // antes de iniciar" — reservas ATIVAS nos endereços do escopo, exibido,
      // não bloqueante.
      const conflictResult = await client.query(
        `SELECT DISTINCT location_id FROM wms.stock_reservation WHERE tenant_id = $1 AND status = 'ACTIVE' AND location_id = ANY($2::uuid[])`,
        [tenantId, locationIds]
      );
      const conflictingLocationIds: string[] = conflictResult.rows.map((r: { location_id: string }) => r.location_id);

      const freezeResult = await client.query(
        `UPDATE wms.location SET status = 'INVENTORY', updated_at = now(), updated_by = $2 WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE' RETURNING id`,
        [locationIds, actorUserId]
      );
      if (freezeResult.rowCount !== locationIds.length) {
        throw new ConflictException({
          error: 'LOCATION_NOT_AVAILABLE',
          detail: 'RN-EST-061 [INVIOLÁVEL]: um ou mais endereços do escopo não estão mais ACTIVE (bloqueado ou já em outra contagem)',
        });
      }

      await client.query(
        `UPDATE wms.inventory_count_location SET status = 'COUNTING', frozen_at = now(), updated_at = now(), updated_by = $2 WHERE header_id = $1`,
        [headerId, actorUserId]
      );

      const updatedHeader = await client.query(
        `UPDATE wms.inventory_count SET status = 'IN_PROGRESS', started_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [headerId, actorUserId]
      );

      await this.eventsService.publishInTransaction(client, {
        event_type: 'estoque.inventario_iniciado',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { header_id: headerId, count_type: header.count_type, location_count: locationIds.length, conflicting_location_ids: conflictingLocationIds },
      });

      return { header: updatedHeader.rows[0], conflictingLocationIds };
    });
  }

  /** §5.1 — PLANNED -> CANCELLED: só antes de iniciar (nenhum endereço congelado ainda). */
  async cancel(tenantId: string, warehouseId: string, headerId: string, actorUserId: string): Promise<Record<string, unknown>> {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const result = await this.db.transaction(ctx, (client) =>
      client.query(
        `UPDATE wms.inventory_count SET status = 'CANCELLED', cancelled_at = now(), updated_at = now(), updated_by = $2
         WHERE id = $1 AND tenant_id = $3 AND status = 'PLANNED' RETURNING *`,
        [headerId, actorUserId, tenantId]
      )
    );
    if (result.rowCount === 0) {
      throw new ConflictException({ error: 'INVENTORY_NOT_CANCELLABLE', detail: 'DOC-05 §5.1: só PLANNED pode ser cancelado (antes de iniciar)' });
    }
    return result.rows[0];
  }

  /**
   * RN-EXP-032(b) — cria (documento + célula) e congela em UM único passo,
   * dentro da transação de quem chama (picking-task.service.ts, corte de
   * picking). Contrato igual a StockMovementService.apply(): recebe um
   * PoolClient já aberto, nenhuma transação própria.
   */
  async createAndFreezeSingleLocation(
    client: PoolClient,
    params: {
      tenantId: string;
      warehouseId: string;
      locationId: string;
      productId: string;
      batchId: string | null;
      triggerRefType: string;
      triggerRefId: string;
      actorUserId: string;
    }
  ): Promise<{ headerId: string; cellId: string }> {
    const warehouseResult = await client.query(`SELECT code FROM wms.warehouse WHERE id = $1`, [params.warehouseId]);
    const documentNumber = await this.documentNumberingService.generateDocumentNumber(
      client,
      'INVENTORY',
      params.warehouseId,
      warehouseResult.rows[0].code,
      params.actorUserId
    );

    const systemQtyResult = await client.query(
      `SELECT COALESCE(qty_available, 0) AS qty FROM wms.stock_balance
       WHERE tenant_id = $1 AND warehouse_id = $2 AND location_id = $3 AND product_id = $4 AND batch_id IS NOT DISTINCT FROM $5`,
      [params.tenantId, params.warehouseId, params.locationId, params.productId, params.batchId]
    );
    const systemQty = Number(systemQtyResult.rows[0]?.qty ?? 0);

    const headerResult = await client.query(
      `INSERT INTO wms.inventory_count (tenant_id, warehouse_id, document_number, count_type, status, started_at, created_by)
       VALUES ($1,$2,$3,'POR_ENDERECO','IN_PROGRESS', now(), $4) RETURNING id`,
      [params.tenantId, params.warehouseId, documentNumber, params.actorUserId]
    );
    const headerId = headerResult.rows[0].id;

    const cellResult = await client.query(
      `INSERT INTO wms.inventory_count_location (
         tenant_id, warehouse_id, header_id, count_type, location_id, product_id, batch_id, system_qty,
         status, trigger_ref_type, trigger_ref_id, frozen_at, created_by
       ) VALUES ($1,$2,$3,'POR_ENDERECO',$4,$5,$6,$7,'COUNTING',$8,$9, now(), $10) RETURNING id`,
      [params.tenantId, params.warehouseId, headerId, params.locationId, params.productId, params.batchId, systemQty, params.triggerRefType, params.triggerRefId, params.actorUserId]
    );
    const cellId = cellResult.rows[0].id;

    // RN-EST-061 [INVIOLÁVEL]: endereço congelado enquanto durar a contagem.
    await client.query(`UPDATE wms.location SET status = 'INVENTORY', updated_at = now(), updated_by = $2 WHERE id = $1`, [params.locationId, params.actorUserId]);

    await this.eventsService.publishInTransaction(client, {
      event_type: 'estoque.inventario_iniciado',
      tenant_id: params.tenantId,
      warehouse_id: params.warehouseId,
      actor_user_id: params.actorUserId,
      payload: { header_id: headerId, count_type: 'POR_ENDERECO', location_id: params.locationId, trigger_ref_type: params.triggerRefType, trigger_ref_id: params.triggerRefId },
    });

    return { headerId, cellId };
  }

  /** RF-EST-060 — resolve os candidatos (endereço × produto × lote) para cada um dos 7 tipos. Só qty_available (ver decisão de modelagem no relatório da sessão). */
  private async resolveCandidates(client: PoolClient, ctx: TenantContext, input: PlanInventoryInput): Promise<CandidateCell[]> {
    const base = `
      SELECT sb.location_id, sb.product_id, sb.batch_id, sb.qty_available AS system_qty
      FROM wms.stock_balance sb
      JOIN wms.location l ON l.id = sb.location_id
      JOIN wms.product p ON p.id = sb.product_id
      WHERE sb.tenant_id = $1 AND sb.warehouse_id = $2 AND sb.qty_available > 0 AND l.status = 'ACTIVE'
    `;

    switch (input.countType) {
      case 'GERAL': {
        const result = await client.query(base, [ctx.tenant_id, ctx.warehouse_id]);
        const cells = result.rows.map(mapCandidateRow);
        if (input.includeEmpty) {
          const covered = new Set(cells.map((c) => c.locationId));
          const emptyResult = await client.query(
            `SELECT l.id AS location_id FROM wms.location l
             WHERE l.warehouse_id = $1 AND l.status = 'ACTIVE'
               AND NOT EXISTS (SELECT 1 FROM wms.stock_balance sb WHERE sb.location_id = l.id AND sb.tenant_id = $2 AND sb.qty_available > 0)`,
            [ctx.warehouse_id, ctx.tenant_id]
          );
          for (const row of emptyResult.rows as Array<{ location_id: string }>) {
            if (!covered.has(row.location_id)) cells.push({ locationId: row.location_id, productId: null, batchId: null, systemQty: 0 });
          }
        }
        return cells;
      }

      case 'ROTATIVO_PRODUTO': {
        if (!input.productIds?.length) {
          throw new BadRequestException({ error: 'PRODUCT_IDS_REQUIRED', detail: 'RF-EST-060: ROTATIVO_PRODUTO exige productIds' });
        }
        const result = await client.query(`${base} AND sb.product_id = ANY($3::uuid[])`, [ctx.tenant_id, ctx.warehouse_id, input.productIds]);
        return result.rows.map(mapCandidateRow);
      }

      case 'POR_ZONA': {
        if (!input.zoneIds?.length) {
          throw new BadRequestException({ error: 'ZONE_IDS_REQUIRED', detail: 'RF-EST-060: POR_ZONA exige zoneIds' });
        }
        const result = await client.query(`${base} AND l.zone_id = ANY($3::uuid[])`, [ctx.tenant_id, ctx.warehouse_id, input.zoneIds]);
        return result.rows.map(mapCandidateRow);
      }

      case 'POR_ESPECIE': {
        if (!input.species?.length) {
          throw new BadRequestException({ error: 'SPECIES_REQUIRED', detail: 'RF-EST-060: POR_ESPECIE exige species (product_species.code)' });
        }
        const result = await client.query(`${base} AND p.species_code = ANY($3::text[])`, [ctx.tenant_id, ctx.warehouse_id, input.species]);
        return result.rows.map(mapCandidateRow);
      }

      case 'POR_ENDERECO': {
        if (!input.locationIds?.length) {
          throw new BadRequestException({ error: 'LOCATION_IDS_REQUIRED', detail: 'RF-EST-060: POR_ENDERECO exige locationIds' });
        }
        const result = await client.query(`${base} AND sb.location_id = ANY($3::uuid[])`, [ctx.tenant_id, ctx.warehouse_id, input.locationIds]);
        return result.rows.map(mapCandidateRow);
      }

      case 'ROTATIVO_DIA': {
        const qty = input.sampleSize ?? (await this.resolveRotativoDiaQty(client));
        const locResult = await client.query(
          `SELECT l.id FROM wms.location l
           LEFT JOIN LATERAL (
             SELECT MAX(icl.released_at) AS last_counted
             FROM wms.inventory_count_location icl
             WHERE icl.location_id = l.id AND icl.status = 'COMPLETED'
           ) lc ON true
           WHERE l.warehouse_id = $1 AND l.status = 'ACTIVE'
             AND EXISTS (SELECT 1 FROM wms.stock_balance sb WHERE sb.location_id = l.id AND sb.tenant_id = $2 AND sb.qty_available > 0)
           ORDER BY lc.last_counted ASC NULLS FIRST,
                    CASE l.abc_class WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END ASC,
                    l.code ASC
           LIMIT $3`,
          [ctx.warehouse_id, ctx.tenant_id, qty]
        );
        const locationIds = (locResult.rows as Array<{ id: string }>).map((r) => r.id);
        if (locationIds.length === 0) return [];
        const result = await client.query(`${base} AND sb.location_id = ANY($3::uuid[])`, [ctx.tenant_id, ctx.warehouse_id, locationIds]);
        return result.rows.map(mapCandidateRow);
      }

      case 'POR_SORTEIO': {
        if (!input.randomSeed) {
          throw new BadRequestException({ error: 'RANDOM_SEED_REQUIRED', detail: 'RF-EST-060/§6: POR_SORTEIO exige randomSeed (reprodutibilidade)' });
        }
        if (!input.sampleSize) {
          throw new BadRequestException({ error: 'SAMPLE_SIZE_REQUIRED', detail: 'RF-EST-060: POR_SORTEIO exige sampleSize' });
        }
        // Determinístico: ORDER BY md5(seed || id) — mesma seed produz sempre
        // a mesma ordenação (§6 "sorteio reprodutível"), sem depender de
        // setseed()/random() (não reprodutível entre sessões/conexões).
        const locResult = await client.query(
          `SELECT l.id FROM wms.location l
           WHERE l.warehouse_id = $1 AND l.status = 'ACTIVE'
             AND EXISTS (SELECT 1 FROM wms.stock_balance sb WHERE sb.location_id = l.id AND sb.tenant_id = $2 AND sb.qty_available > 0)
           ORDER BY md5($3 || l.id::text)
           LIMIT $4`,
          [ctx.warehouse_id, ctx.tenant_id, input.randomSeed, input.sampleSize]
        );
        const locationIds = (locResult.rows as Array<{ id: string }>).map((r) => r.id);
        if (locationIds.length === 0) return [];
        const result = await client.query(`${base} AND sb.location_id = ANY($3::uuid[])`, [ctx.tenant_id, ctx.warehouse_id, locationIds]);
        return result.rows.map(mapCandidateRow);
      }

      default: {
        const exhaustive: never = input.countType;
        throw new BadRequestException({ error: 'UNKNOWN_COUNT_TYPE', detail: `RF-EST-060: count_type desconhecido: ${exhaustive}` });
      }
    }
  }

  /**
   * RD-EST-003 §7 — parâmetro EST.INV_ROTATIVO_QTD_DIA. Lê via o `client` da
   * transação corrente (já tem app.tenant_ids setado), NÃO db.queryGlobal():
   * wms.app_parameter tem RLS mesmo para linhas GLOBAL (migration 0004, USING
   * exige tenant_ids configurado) — queryGlobal() usa o pool wms_app sem
   * nenhum contexto de sessão e sempre erra 0 linhas, mascarando-se atrás do
   * fallback default (achado desta sessão; mesmo padrão problemático em
   * expiration.service.ts.resolveAlertDays(), fora do escopo daqui — ver
   * relatório da 5C).
   */
  private async resolveRotativoDiaQty(client: PoolClient): Promise<number> {
    const result = await client.query<{ value: string }>(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'EST.INV_ROTATIVO_QTD_DIA'`);
    const raw = result.rows[0]?.value;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROTATIVO_DIA_QTY;
  }
}
