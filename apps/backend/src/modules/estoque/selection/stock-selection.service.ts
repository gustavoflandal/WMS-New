// DOC-05 §4.2 — Implementação da Seleção de Saldo (StockSelectionPort).
//
// Camada de I/O APENAS: carrega os candidatos do banco, deriva os insumos que
// só o banco conhece (a "data de entrada do saldo") e delega TODA a regra de
// ordenação/exclusão para as funções puras de stock-selection.util.ts. Mesmo
// desenho do motor de putaway da 4B (engine service + utils puros), pelo mesmo
// motivo: a regra [INVIOLÁVEL] precisa ser auditável sem banco.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { physicalChannelKey } from './physical-channel.util.js';
import {
  GiroPolicy,
  SelectionCandidate,
  allocateDemand,
  isGiroPolicy,
  meetsMinimumShelfLife,
  orderCandidatesByPolicy,
  restrictToAccessiblePallets,
} from './stock-selection.util.js';
import { StockSelectionOutcome, StockSelectionPort, StockSelectionRequest, purposeAppliesShelfLife } from './stock-selection.port.js';

interface CandidateRow {
  id: string;
  product_id: string;
  batch_id: string | null;
  location_id: string;
  pallet_id: string | null;
  qty_available: string;
  expiration_date: Date | string | null;
  location_code: string;
  location_type: string;
  storage_equipment_id: string | null;
  aisle: string;
  module: string;
  level: string;
  zone_type: string;
  access_policy: string | null;
  first_entry_at: Date | string | null;
  balance_created_at: Date | string;
}

export interface SelectionLoadOptions {
  /**
   * `SELECT ... FOR UPDATE` nas linhas de wms.stock_balance candidatas.
   * Usado por StockReservationService: sem o lock, duas demandas concorrentes
   * leriam o mesmo `qty_available` e reservariam a mesma quantidade duas vezes.
   */
  lockForUpdate?: boolean;
}

/** Converte DATE/TIMESTAMPTZ do pg para as strings ISO que a regra pura consome. */
function toIsoDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function toIsoTimestamp(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}

@Injectable()
export class StockSelectionService implements StockSelectionPort {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (padrão de todo o módulo).
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** Conveniência para chamadores sem transação aberta (contrato da porta). */
  async select(request: StockSelectionRequest): Promise<StockSelectionOutcome> {
    return this.db.transaction(
      { tenant_id: request.tenantId, user_id: request.actorUserId, warehouse_id: request.warehouseId },
      (client) => this.selectInTransaction(client, request)
    );
  }

  /**
   * RN-EST-010/011/012 — seleção dentro de uma transação já aberta pelo
   * chamador (mesmo contrato de StockMovementService.apply). Necessário para
   * (a) o kanban, que roda cross-tenant no client do worker, e (b) a reserva,
   * que precisa do lock e do efeito no MESMO bloco atômico.
   */
  async selectInTransaction(client: PoolClient, request: StockSelectionRequest, options: SelectionLoadOptions = {}): Promise<StockSelectionOutcome> {
    if (request.demandQty <= 0) {
      throw new BadRequestException({ error: 'INVALID_DEMAND_QTY', detail: `RG-010: demandQty deve ser positivo (recebido ${request.demandQty})` });
    }

    const policy = await this.resolveGiroPolicy(client, request);
    const today = request.today ?? new Date().toISOString().slice(0, 10);

    const rows = await this.loadCandidateRows(client, request, options);
    const shelfLife = await this.loadShelfLifeParameters(client, request);

    // ── RN-EST-012 [INVIOLÁVEL] — Shelf Life Mínimo ───────────────────────
    // Só incide sobre expedição a cliente (purposeAppliesShelfLife). O que é
    // excluído aqui NUNCA volta por ordenação: a exclusão é do UNIVERSO.
    //
    // `overrideShelfLife` (RN-EST-013) NÃO desliga a avaliação — só desliga a
    // EXCLUSÃO. Os reprovados continuam reportados em excludedByShelfLife
    // para que a reserva exija o anexo de autorização do cliente. Manter a
    // avaliação sempre viva é o que impede a quebra de passar despercebida.
    const excludedByShelfLife: StockSelectionOutcome['excludedByShelfLife'] = [];
    const evaluateShelfLife = purposeAppliesShelfLife(request.purpose);
    const overrideShelfLife = Boolean(request.overrideShelfLife);

    const candidates: SelectionCandidate[] = [];
    for (const row of rows) {
      const expirationDate = toIsoDate(row.expiration_date);

      if (evaluateShelfLife) {
        const approved = meetsMinimumShelfLife({
          expirationDate,
          shelfLifeDays: shelfLife.shelfLifeDays,
          minShelfLifePct: shelfLife.minShelfLifePct,
          today,
        });
        if (!approved) {
          excludedByShelfLife.push({ stockBalanceId: row.id, batchId: row.batch_id, expirationDate });
          if (!overrideShelfLife) continue;
        }
      }

      candidates.push({
        stockBalanceId: row.id,
        productId: row.product_id,
        batchId: row.batch_id,
        locationId: row.location_id,
        palletId: row.pallet_id,
        qtyAvailable: Number(row.qty_available),
        expirationDate,
        // ── DERIVAÇÃO DA "DATA DE ENTRADA DO SALDO" (RN-EST-011) ──────────
        // Definida na query (loadCandidateRows) como MIN(occurred_at) dos
        // stock_movement que CREDITARAM este saldo. `balance_created_at` é o
        // fallback determinístico quando não há movimento de entrada —
        // ver comentário completo em loadCandidateRows.
        entryDate: toIsoTimestamp(row.first_entry_at ?? row.balance_created_at),
        locationType: row.location_type,
        locationCode: row.location_code,
        zoneType: row.zone_type,
        accessPolicy: row.access_policy,
        channelKey: physicalChannelKey({
          storageEquipmentId: row.storage_equipment_id,
          aisle: row.aisle,
          module: row.module,
          level: row.level,
        }),
      });
    }

    // ── RN-EST-011 (RN-DAD-010) — LIFO_PHYSICAL: só o palete acessível ────
    const accessible = restrictToAccessiblePallets(candidates);

    // ── RN-EST-013 — seleção fora da ordem (lote específico) ──────────────
    // A restrição ao lote exigido é aplicada AQUI, sobre o universo já
    // legítimo (RN-EST-010/012) — a quebra dispensa a ORDEM (RN-EST-011),
    // nunca o universo. A autorização (permissão + exceção aprovada) é
    // validada em StockReservationService, antes de qualquer efeito.
    const scoped = request.forcedBatchId ? accessible.filter((c) => c.batchId === request.forcedBatchId) : accessible;

    const ordered = orderCandidatesByPolicy(scoped, policy);
    const { allocations, shortfall } = allocateDemand(ordered, request.demandQty);

    return {
      policy,
      allocations,
      shortfall,
      excludedByShelfLife,
      policyBreak: Boolean(request.forcedBatchId),
      shelfLifeOverridden: overrideShelfLife && excludedByShelfLife.length > 0,
    };
  }

  /**
   * RG-006 / RN-EST-011 — "A política do produto resolve por:
   * `product.giro_policy` → `client_warehouse_settings.default_giro_policy`".
   */
  private async resolveGiroPolicy(client: PoolClient, request: StockSelectionRequest): Promise<GiroPolicy> {
    const result = await client.query<{ giro_policy: string | null; default_giro_policy: string | null }>(
      `SELECT p.giro_policy, cws.default_giro_policy
       FROM wms.product p
       LEFT JOIN wms.client_warehouse_settings cws
              ON cws.tenant_id = p.tenant_id AND cws.warehouse_id = $2
       WHERE p.id = $1 AND p.tenant_id = $3`,
      [request.productId, request.warehouseId, request.tenantId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException(`product ${request.productId} not found for tenant ${request.tenantId}`);

    const resolved = row.giro_policy ?? row.default_giro_policy;
    if (!resolved || !isGiroPolicy(resolved)) {
      throw new BadRequestException({
        error: 'GIRO_POLICY_UNRESOLVED',
        detail: `RG-006/RN-EST-011: política de giro não resolvida para o produto ${request.productId} (product.giro_policy e client_warehouse_settings.default_giro_policy ausentes ou inválidos)`,
      });
    }
    return resolved;
  }

  /** RN-EST-012 — `min_shelf_life_pct` RESOLVIDO (produto → cliente) + `shelf_life_days` do produto. */
  private async loadShelfLifeParameters(
    client: PoolClient,
    request: StockSelectionRequest
  ): Promise<{ shelfLifeDays: number | null; minShelfLifePct: string | null }> {
    const result = await client.query<{ shelf_life_days: number | null; min_shelf_life_pct: string | null; client_default_pct: string | null }>(
      `SELECT p.shelf_life_days, p.min_shelf_life_pct,
              cws.min_shelf_life_default_pct AS client_default_pct
       FROM wms.product p
       LEFT JOIN wms.client_warehouse_settings cws
              ON cws.tenant_id = p.tenant_id AND cws.warehouse_id = $2
       WHERE p.id = $1 AND p.tenant_id = $3`,
      [request.productId, request.warehouseId, request.tenantId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException(`product ${request.productId} not found for tenant ${request.tenantId}`);

    // RN-EST-012: "min_shelf_life_pct resolvido (produto → cliente)" — o
    // percentual do PRODUTO prevalece; na ausência, o padrão do CLIENTE, que
    // nesta base é `client_warehouse_settings.min_shelf_life_default_pct`
    // (DOC-02, migration 0009): o cadastro cliente×armazém é onde o "padrão
    // do cliente" existe — wms.client não tem essa coluna. Mesma cadeia de
    // precedência (específico → padrão) já usada por RG-006 para a política
    // de giro logo acima.
    return {
      shelfLifeDays: row.shelf_life_days === null ? null : Number(row.shelf_life_days),
      minShelfLifePct: row.min_shelf_life_pct ?? row.client_default_pct,
    };
  }

  /**
   * RN-EST-010 [INVIOLÁVEL] — universo de candidatos.
   *
   * Filtros aplicados NA QUERY (não em memória: o que não é candidato não
   * deve nem trafegar):
   *  - `sb.qty_available > 0` — a ÚNICA parcela elegível. `blocked`,
   *    `damaged`, `quarantine`, `reserved` e `in_transit` nunca entram, por
   *    construção: a query só lê a coluna qty_available.
   *  - lote `RELEASED` — saldo SEM lote (`batch_id IS NULL`, espécie que não
   *    exige lote) é candidato: não há lote para estar em outro estado.
   *  - `l.status = 'ACTIVE'` — exclui BLOCKED, INACTIVE e, por consequência,
   *    `INVENTORY` (RN-EST-061: endereço congelado em contagem sai do
   *    universo enquanto durar a contagem).
   *
   * [LACUNA: RN-EST-010 diz "endereço `ACTIVE` (ou `PICKING`)". Lido como
   * restrição de STATUS (`ACTIVE`), com o parêntese esclarecendo que
   * endereços de PICKING também são candidatos — e NÃO como um "ou" literal
   * sobre `location_type`. Três razões: (1) `PICKING` não existe no enum de
   * `location.status` (DOC-02: ACTIVE/BLOCKED/INVENTORY/INACTIVE), só em
   * `location_type`; (2) o "ou" literal admitiria endereço BLOCKED/INVENTORY
   * desde que fosse do tipo PICKING, contradizendo RN-EST-061; (3) restringir
   * o TIPO a (STORAGE, PICKING) tornaria a política `JIT` inalcançável, pois
   * ela ordena "saldo em zona CROSS_DOCKING primeiro" e esses endereços não
   * são de nenhum dos dois tipos. Nenhum tipo é filtrado: conteúdo impróprio
   * já é barrado pela PARCELA (quarentena/avaria vivem em qty_quarantine/
   * qty_damaged, nunca em qty_available).]
   */
  private async loadCandidateRows(client: PoolClient, request: StockSelectionRequest, options: SelectionLoadOptions): Promise<CandidateRow[]> {
    // ── Derivação da "data de entrada do saldo" (RN-EST-011) ──────────────
    // "primeiro `stock_movement` de entrada" = MIN(occurred_at) entre os
    // movimentos que CREDITARAM exatamente esta combinação de saldo
    // (produto + lote + endereço + palete), identificados por
    // `balance_bucket_to IS NOT NULL` (houve crédito) e `location_id_to` =
    // endereço do saldo. Comparações de lote/palete usam IS NOT DISTINCT FROM
    // porque ambos são NULLable e NULL = NULL é NULL em SQL (mesma classe de
    // problema do bug de UPSERT corrigido na migration 0046).
    //
    // Fallback `sb.created_at` quando não há movimento de entrada: saldo
    // criado antes do motor de movimentação existir (fixtures da 2B/4A) ou
    // por carga inicial. É determinístico e monotônico com a entrada real —
    // nunca `now()`, que tornaria a ordenação FIFO/LIFO instável entre duas
    // execuções da mesma seleção.
    const lockClause = options.lockForUpdate ? 'FOR UPDATE OF sb' : '';

    const result = await client.query<CandidateRow>(
      `SELECT sb.id, sb.product_id, sb.batch_id, sb.location_id, sb.pallet_id, sb.qty_available,
              sb.created_at AS balance_created_at,
              b.expiration_date,
              l.code AS location_code, l.location_type, l.storage_equipment_id, l.aisle, l.module, l.level,
              z.zone_type,
              se.access_policy,
              (SELECT MIN(sm.occurred_at)
                 FROM wms.stock_movement sm
                WHERE sm.tenant_id = sb.tenant_id
                  AND sm.warehouse_id = sb.warehouse_id
                  AND sm.product_id = sb.product_id
                  AND sm.batch_id IS NOT DISTINCT FROM sb.batch_id
                  AND sm.location_id_to = sb.location_id
                  AND sm.pallet_id_to IS NOT DISTINCT FROM sb.pallet_id
                  AND sm.balance_bucket_to IS NOT NULL) AS first_entry_at
         FROM wms.stock_balance sb
         JOIN wms.location l ON l.id = sb.location_id
         JOIN wms.zone z ON z.id = l.zone_id
         LEFT JOIN wms.storage_equipment se ON se.id = l.storage_equipment_id
         LEFT JOIN wms.batch b ON b.id = sb.batch_id
        WHERE sb.tenant_id = $1
          AND sb.warehouse_id = $2
          AND sb.product_id = $3
          AND sb.qty_available > 0
          AND (sb.batch_id IS NULL OR b.status = 'RELEASED')
          AND l.status = 'ACTIVE'
        ${lockClause}`,
      [request.tenantId, request.warehouseId, request.productId]
    );

    return this.applyLogicalWarehouseContainment(client, result.rows, request);
  }

  /**
   * RN-EST-010 — "respeitando contenção RG-015".
   *
   * RG-015 item 2 [INVIOLÁVEL]: endereço vinculado ao Armazém Lógico de OUTRO
   * cliente é sempre excluído (não admite override por nenhum papel).
   * RG-015 item 1: cliente COM Armazém Lógico ativo neste armazém só
   * movimenta dentro dos endereços vinculados a ele.
   *
   * Leitura cross-tenant obrigatória via a função SECURITY DEFINER de
   * exposição mínima da migration 0043 (`logical_warehouse_location_owners`):
   * a RLS de `logical_warehouse_location` esconde do cliente A justamente o
   * vínculo do cliente B — sem ela, a contenção seria um no-op silencioso
   * (mesmo raciocínio já registrado no filtro 2 do motor de putaway, 4B).
   */
  private async applyLogicalWarehouseContainment(client: PoolClient, rows: CandidateRow[], request: StockSelectionRequest): Promise<CandidateRow[]> {
    if (rows.length === 0) return rows;

    const locationIds = [...new Set(rows.map((r) => r.location_id))];
    const ownersResult = await client.query<{ location_id: string; owner_tenant_id: string }>(
      `SELECT location_id, owner_tenant_id FROM wms.logical_warehouse_location_owners($1::uuid[])`,
      [locationIds]
    );
    const ownerByLocation = new Map<string, string>(ownersResult.rows.map((r) => [r.location_id, r.owner_tenant_id]));

    // tenant_id explícito (não só RLS): a seleção também roda no pool do
    // worker (BYPASSRLS) para o kanban — filtrar em SQL mantém a contenção
    // válida nos dois modos.
    const ownLogicalResult = await client.query<{ id: string }>(
      `SELECT id FROM wms.logical_warehouse WHERE warehouse_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' LIMIT 1`,
      [request.warehouseId, request.tenantId]
    );
    const tenantHasLogicalWarehouse = ownLogicalResult.rows.length > 0;

    return rows.filter((row) => {
      const owner = ownerByLocation.get(row.location_id) ?? null;
      // Item 2: endereço de armazém lógico alheio — fora, sempre.
      if (owner !== null && owner !== request.tenantId) return false;
      // Item 1: tenant com armazém lógico ativo só usa endereços dele.
      if (tenantHasLogicalWarehouse && owner !== request.tenantId) return false;
      return true;
    });
  }
}
