// DOC-04 §4.5 / RN-REC-040 (AD-006) — Motor de Putaway.
// Carrega o estado real do armazém e orquestra as duas fases: os filtros
// invioláveis (putaway-filters.util.ts) e o ranqueamento configurável
// (putaway-ranking.util.ts). Toda a REGRA vive nos utils puros; aqui só
// entra I/O e montagem dos insumos.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import {
  CandidateLocationInput,
  PalletToStoreInput,
  PutawayFilterOutcome,
  evaluatePutawayFilters,
} from './putaway-filters.util.js';
import {
  PutawayCriterion,
  RankableLocation,
  isPutawayCriterion,
  rankPutawayLocations,
  splitSuggestionAndAlternatives,
} from './putaway-ranking.util.js';

export interface PutawaySuggestion {
  locationId: string;
  code: string;
  zoneId: string;
}

export interface RejectedLocation {
  locationId: string;
  code: string;
  verdict: 'REJECTED_LEGAL' | 'REJECTED_OPERATIONAL';
  failedFilter: number;
  reason: string;
}

export interface PutawayEngineResult {
  palletId: string;
  /** 1º colocado da Fase 2 (RN-REC-040); null quando NENHUM endereço passou na Fase 1. */
  suggestion: PutawaySuggestion | null;
  /** Os 4 seguintes (RN-REC-040). */
  alternatives: PutawaySuggestion[];
  /** Ordem configurada efetivamente aplicada (REC.CRITERIOS_PUTAWAY). */
  criteriaApplied: PutawayCriterion[];
  /** Motivo EXATO por endereço reprovado (filtro + endereço) — exigido para diagnóstico. */
  rejected: RejectedLocation[];
}

@Injectable()
export class PutawayEngineService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /**
   * RN-REC-040 — executa Fase 1 + Fase 2 para um palete e devolve sugestão,
   * alternativas e o diagnóstico completo das reprovações.
   */
  async suggestLocations(palletId: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<PutawayEngineResult> {
    const pallet = await this.loadPalletContext(palletId, tenantId, warehouseId, actorUserId);
    const candidates = await this.loadCandidateLocations(palletId, tenantId, warehouseId, actorUserId);
    const criteria = await this.loadCriteria(tenantId, warehouseId, actorUserId);

    const tenantLogicalWarehouseOwnerId = await this.loadTenantLogicalWarehouseOwner(tenantId, warehouseId, actorUserId);

    const approved: CandidateLocationInput[] = [];
    const rejected: RejectedLocation[] = [];

    for (const candidate of candidates.locations) {
      const outcome: PutawayFilterOutcome = evaluatePutawayFilters(candidate, pallet, { tenantLogicalWarehouseOwnerId });
      if (outcome.verdict === 'APPROVED') {
        approved.push(candidate);
      } else {
        rejected.push({
          locationId: candidate.locationId,
          code: candidate.code,
          verdict: outcome.verdict,
          failedFilter: outcome.failedFilter as number,
          reason: outcome.reason as string,
        });
      }
    }

    const rankable: RankableLocation[] = approved.map((c) => ({
      locationId: c.locationId,
      code: c.code,
      isPreferredZone: candidates.preferredZoneIds.has(c.zoneId),
      hasSameProductBatch: candidates.consolidationLocationIds.has(c.locationId),
      abcClass: candidates.abcClassByLocation.get(c.locationId) ?? null,
      level: candidates.levelByLocation.get(c.locationId) ?? '00',
      dockDistanceM: candidates.dockDistanceByZone.get(c.zoneId) ?? null,
      zoneOccupancyRatio: candidates.zoneOccupancyRatio.get(c.zoneId) ?? 0,
    }));

    const ranked = rankPutawayLocations(rankable, criteria);
    const { suggestion, alternatives } = splitSuggestionAndAlternatives(ranked);
    const zoneByLocation = candidates.zoneByLocation;

    return {
      palletId,
      suggestion: suggestion ? { locationId: suggestion.locationId, code: suggestion.code, zoneId: zoneByLocation.get(suggestion.locationId) as string } : null,
      alternatives: alternatives.map((a) => ({ locationId: a.locationId, code: a.code, zoneId: zoneByLocation.get(a.locationId) as string })),
      criteriaApplied: criteria,
      rejected,
    };
  }

  /**
   * RN-REC-040 [INVIOLÁVEL] + RN-REC-041 — valida UM endereço escolhido
   * explicitamente (execução ou override). Devolve o veredito da Fase 1 sem
   * ranquear. É este método que garante que "endereço reprovado em qualquer
   * filtro não pode ser aceito por override": quem chama só pode prosseguir
   * com APPROVED, ou com REJECTED_OPERATIONAL + permissão + motivo.
   */
  async evaluateSingleLocation(
    palletId: string,
    locationId: string,
    tenantId: string,
    warehouseId: string,
    actorUserId: string
  ): Promise<PutawayFilterOutcome & { code: string }> {
    const pallet = await this.loadPalletContext(palletId, tenantId, warehouseId, actorUserId);
    const candidates = await this.loadCandidateLocations(palletId, tenantId, warehouseId, actorUserId);
    const candidate = candidates.locations.find((c) => c.locationId === locationId);
    if (!candidate) {
      throw new NotFoundException(`location ${locationId} não encontrada no armazém ${warehouseId}`);
    }
    const tenantLogicalWarehouseOwnerId = await this.loadTenantLogicalWarehouseOwner(tenantId, warehouseId, actorUserId);
    return { ...evaluatePutawayFilters(candidate, pallet, { tenantLogicalWarehouseOwnerId }), code: candidate.code };
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Insumos do palete. `heightM`:
   * [LACUNA: nem DOC-04 nem DOC-02 definem como calcular a altura FÍSICA de
   * um palete MONTADO — a altura empilhada dependeria do padrão
   * ballast × layers da embalagem (RF-REC-030), que o documento trata como
   * SUGESTÃO de paletização, não como conteúdo obrigatório do palete. Usada
   * a maior altura unitária entre os produtos do palete como proxy
   * conservador e determinístico.]
   */
  private async loadPalletContext(palletId: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<PalletToStoreInput> {
    const ctx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const contentResult = await this.db.query(
      ctx,
      `SELECT pc.qty, pc.batch_id, p.species_code, p.giro_policy,
              COALESCE(p.gross_weight_kg, 0) AS gross_weight_kg,
              COALESCE(p.length_m, 0) * COALESCE(p.width_m, 0) * COALESCE(p.height_m, 0) AS unit_volume_m3,
              COALESCE(p.height_m, 0) AS unit_height_m,
              ps.segregation_class, ps.default_giro_policy,
              b.status AS batch_status
       FROM wms.pallet_content pc
       JOIN wms.product p ON p.id = pc.product_id
       JOIN wms.product_species ps ON ps.code = p.species_code
       LEFT JOIN wms.batch b ON b.id = pc.batch_id
       WHERE pc.pallet_id = $1`,
      [palletId]
    );
    if (contentResult.rows.length === 0) {
      throw new BadRequestException({
        error: 'EMPTY_PALLET',
        detail: `RN-REC-040: palete ${palletId} não tem conteúdo declarado — não há o que endereçar`,
      });
    }

    const speciesCodes = new Set<string>();
    const segregationClasses = new Set<string>();
    const batchIds = new Set<string>();
    const giroPolicies = new Set<string>();
    let totalWeightKg = 0;
    let totalVolumeM3 = 0;
    let heightM = 0;
    let hasQuarantineBatch = false;

    for (const row of contentResult.rows) {
      const qty = Number(row.qty);
      speciesCodes.add(row.species_code);
      segregationClasses.add(row.segregation_class);
      if (row.batch_id) batchIds.add(row.batch_id);
      // RG-006: política do PRODUTO quando definida; senão a padrão da espécie.
      giroPolicies.add(row.giro_policy ?? row.default_giro_policy);
      totalWeightKg += qty * Number(row.gross_weight_kg);
      totalVolumeM3 += qty * Number(row.unit_volume_m3);
      heightM = Math.max(heightM, Number(row.unit_height_m));
      if (row.batch_status === 'QUARANTINE') hasQuarantineBatch = true;
    }

    return {
      tenantId,
      speciesCodes: [...speciesCodes],
      segregationClasses: [...segregationClasses],
      batchIds: [...batchIds],
      hasQuarantineBatch,
      giroPolicies: [...giroPolicies],
      totalWeightKg,
      totalVolumeM3,
      heightM,
    };
  }

  private async loadCandidateLocations(palletId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    // location/zone/storage_equipment são GLOBAIS (RN-DAD-004, sem RLS).
    const locResult = await this.db.queryGlobal(
      `SELECT l.id, l.code, l.status, l.zone_id, l.abc_class, l.level, l.aisle, l.module,
              l.storage_equipment_id, l.max_weight_kg, l.max_volume_m3, l.max_pallets, l.max_height_m,
              z.zone_type, z.status AS zone_status, z.allowed_species, z.temperature_min_c, z.temperature_max_c,
              se.access_policy
       FROM wms.location l
       JOIN wms.zone z ON z.id = l.zone_id
       LEFT JOIN wms.storage_equipment se ON se.id = l.storage_equipment_id
       WHERE l.warehouse_id = $1`,
      [warehouseId]
    );

    // Ocupação FÍSICA cross-tenant (SECURITY DEFINER, migration 0043) — ver
    // justificativa na própria migration: RN-EST-022 e o filtro 5 falam do
    // endereço FÍSICO, que num 3PL pode ter saldo de mais de um cliente.
    const occResult = await this.db.queryGlobal(
      `SELECT location_id, total_weight_kg, total_volume_m3, distinct_pallets, segregation_classes, batch_ids
       FROM wms.location_physical_occupancy($1)`,
      [warehouseId]
    );
    const occupancyByLocation = new Map<string, any>(occResult.rows.map((r: any) => [r.location_id, r]));

    // RG-015 — dono do Armazém Lógico de cada endereço (cross-tenant).
    const locationIds = locResult.rows.map((r: any) => r.id);
    const ownerResult = locationIds.length
      ? await this.db.queryGlobal(`SELECT location_id, owner_tenant_id FROM wms.logical_warehouse_location_owners($1::uuid[])`, [locationIds])
      : { rows: [] as any[] };
    const ownerByLocation = new Map<string, string>(ownerResult.rows.map((r: any) => [r.location_id, r.owner_tenant_id]));

    // Agregações derivadas ----------------------------------------------------
    const zonePresentClasses = new Map<string, Set<string>>();
    const channelBatches = new Map<string, Set<string>>();
    const zoneCapacity = new Map<string, { used: number; total: number }>();

    const channelKey = (r: any) => `${r.storage_equipment_id ?? 'NO_EQUIP'}|${r.aisle}|${r.module}|${r.level}`;

    for (const row of locResult.rows) {
      const occ = occupancyByLocation.get(row.id);
      const classes: string[] = occ?.segregation_classes ?? [];
      const batches: string[] = occ?.batch_ids ?? [];

      if (!zonePresentClasses.has(row.zone_id)) zonePresentClasses.set(row.zone_id, new Set());
      classes.forEach((c) => zonePresentClasses.get(row.zone_id)!.add(c));

      const key = channelKey(row);
      if (!channelBatches.has(key)) channelBatches.set(key, new Set());
      batches.forEach((b) => channelBatches.get(key)!.add(b));

      const cap = zoneCapacity.get(row.zone_id) ?? { used: 0, total: 0 };
      cap.used += Number(occ?.distinct_pallets ?? 0);
      cap.total += Number(row.max_pallets);
      zoneCapacity.set(row.zone_id, cap);
    }

    const locations: CandidateLocationInput[] = locResult.rows.map((row: any) => {
      const occ = occupancyByLocation.get(row.id);
      return {
        locationId: row.id,
        code: row.code,
        status: row.status,
        zoneId: row.zone_id,
        zoneType: row.zone_type,
        zoneStatus: row.zone_status,
        allowedSpecies: row.allowed_species ?? [],
        temperatureMinC: row.temperature_min_c === null ? null : Number(row.temperature_min_c),
        temperatureMaxC: row.temperature_max_c === null ? null : Number(row.temperature_max_c),
        accessPolicy: row.access_policy ?? null,
        maxWeightKg: Number(row.max_weight_kg),
        maxVolumeM3: Number(row.max_volume_m3),
        maxPallets: Number(row.max_pallets),
        maxHeightM: Number(row.max_height_m),
        occupiedWeightKg: Number(occ?.total_weight_kg ?? 0),
        occupiedVolumeM3: Number(occ?.total_volume_m3 ?? 0),
        occupiedPallets: Number(occ?.distinct_pallets ?? 0),
        presentSegregationClasses: occ?.segregation_classes ?? [],
        channelBatchIds: [...(channelBatches.get(channelKey(row)) ?? [])],
        zonePresentSegregationClasses: [...(zonePresentClasses.get(row.zone_id) ?? [])],
        logicalWarehouseOwnerTenantId: ownerByLocation.get(row.id) ?? null,
      };
    });

    // Fase 2 — insumos de ranqueamento ---------------------------------------
    // ZONA_PREFERENCIAL_PRODUTO (product_warehouse_parameter.putaway_zone_preference).
    const prefResult = await this.db.query(
      ctx,
      `SELECT DISTINCT unnest(pwp.putaway_zone_preference) AS zone_id
       FROM wms.product_warehouse_parameter pwp
       WHERE pwp.warehouse_id = $1
         AND pwp.product_id IN (SELECT product_id FROM wms.pallet_content WHERE pallet_id = $2)
         AND pwp.putaway_zone_preference IS NOT NULL`,
      [warehouseId, palletId]
    );
    const preferredZoneIds = new Set<string>(prefResult.rows.map((r: any) => r.zone_id));

    // CONSOLIDACAO_PRODUTO_LOTE — "proximidade de saldo igual". Escopo do
    // PRÓPRIO tenant (RLS): consolidar é agrupar o MEU produto+lote.
    const consolidationResult = await this.db.query(
      ctx,
      `SELECT DISTINCT sb.location_id
       FROM wms.stock_balance sb
       JOIN wms.pallet_content pc
         ON pc.product_id = sb.product_id
        AND (pc.batch_id = sb.batch_id OR (pc.batch_id IS NULL AND sb.batch_id IS NULL))
       WHERE sb.warehouse_id = $1 AND pc.pallet_id = $2`,
      [warehouseId, palletId]
    );
    const consolidationLocationIds = new Set<string>(consolidationResult.rows.map((r: any) => r.location_id));

    // MENOR_DISTANCIA_DOCA — matriz REC.MAPA_DISTANCIA_DOCA_ZONA (RF-REC-003),
    // medida a partir da doca da Ordem que originou o palete.
    const dockResult = await this.db.queryGlobal(
      `SELECT dzd.zone_id, dzd.distance_m
       FROM wms.dock_zone_distance dzd
       WHERE dzd.warehouse_id = $1
         AND dzd.dock_id = (
           SELECT io.dock_id FROM wms.pallet pl
           JOIN wms.inbound_order io ON io.id = pl.inbound_order_id
           WHERE pl.id = $2
         )`,
      [warehouseId, palletId]
    );
    const dockDistanceByZone = new Map<string, number>(dockResult.rows.map((r: any) => [r.zone_id, Number(r.distance_m)]));

    const zoneOccupancyRatio = new Map<string, number>();
    for (const [zoneId, cap] of zoneCapacity) {
      zoneOccupancyRatio.set(zoneId, cap.total > 0 ? cap.used / cap.total : 0);
    }

    return {
      locations,
      preferredZoneIds,
      consolidationLocationIds,
      dockDistanceByZone,
      zoneOccupancyRatio,
      abcClassByLocation: new Map<string, string | null>(locResult.rows.map((r: any) => [r.id, r.abc_class])),
      levelByLocation: new Map<string, string>(locResult.rows.map((r: any) => [r.id, r.level])),
      zoneByLocation: new Map<string, string>(locResult.rows.map((r: any) => [r.id, r.zone_id])),
    };
  }

  /** RG-015: armazém lógico ATIVO do próprio tenant neste armazém (null = não usa armazém lógico). */
  private async loadTenantLogicalWarehouseOwner(tenantId: string, warehouseId: string, actorUserId: string): Promise<string | null> {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT tenant_id FROM wms.logical_warehouse WHERE warehouse_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [warehouseId]
    );
    return result.rows[0]?.tenant_id ?? null;
  }

  /**
   * REC.CRITERIOS_PUTAWAY — lista ORDENADA por armazém (RN-REC-040 Fase 2).
   * Catálogo FECHADO: valor fora dos 6 códigos é erro determinístico, não
   * ignorado em silêncio (um critério com typo mudaria o endereçamento sem
   * ninguém perceber).
   */
  private async loadCriteria(tenantId: string, warehouseId: string, actorUserId: string): Promise<PutawayCriterion[]> {
    const ctx = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const result = await this.db.query(
      ctx,
      `SELECT value FROM wms.app_parameter
       WHERE name = 'REC.CRITERIOS_PUTAWAY'
         AND (scope = 'GLOBAL' OR (scope = 'WAREHOUSE' AND warehouse_id = $1))
       ORDER BY CASE scope WHEN 'WAREHOUSE' THEN 0 ELSE 1 END
       LIMIT 1`,
      [warehouseId]
    );
    if (result.rows.length === 0) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.rows[0].value);
    } catch {
      throw new BadRequestException({
        error: 'INVALID_PUTAWAY_CRITERIA',
        detail: `RN-REC-040: REC.CRITERIOS_PUTAWAY não é um JSON válido ("${result.rows[0].value}")`,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new BadRequestException({ error: 'INVALID_PUTAWAY_CRITERIA', detail: 'RN-REC-040: REC.CRITERIOS_PUTAWAY deve ser uma lista ordenada' });
    }
    const invalid = parsed.filter((c) => typeof c !== 'string' || !isPutawayCriterion(c));
    if (invalid.length > 0) {
      throw new BadRequestException({
        error: 'INVALID_PUTAWAY_CRITERIA',
        detail: `RN-REC-040 Fase 2: critério(s) fora do catálogo fechado: ${invalid.join(', ')}`,
      });
    }
    return parsed as PutawayCriterion[];
  }
}
