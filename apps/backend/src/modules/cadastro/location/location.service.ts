// DOC-02 §5.2 — location (GLOBAL — RN-DAD-004). code é gerado no banco (RN-DAD-011).
import { Inject, Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateLocationInput {
  warehouse_id: string;
  zone_id: string;
  storage_equipment_id?: string;
  aisle: string;
  module: string;
  level: string;
  slot: string;
  location_type: string;
  max_weight_kg: number;
  max_volume_m3: number;
  max_pallets: number;
  max_height_m: number;
  abc_class?: 'A' | 'B' | 'C';
}

/** RF-DAD-054: geração em massa de endereços por intervalo de coordenadas. */
export interface BulkGenerateLocationsInput {
  warehouse_id: string;
  zone_id: string;
  storage_equipment_id?: string;
  location_type: string;
  aisle_from: string;
  aisle_to: string;
  module_from: string;
  module_to: string;
  level_from: string;
  level_to: string;
  slot_from: string;
  slot_to: string;
  max_weight_kg: number;
  max_volume_m3: number;
  max_pallets: number;
  max_height_m: number;
  abc_class?: 'A' | 'B' | 'C';
}

/**
 * Expande um intervalo alfa-numérico tipo "A1".."A4" em ["A1","A2","A3","A4"].
 * DOC-02 só dá exemplos com prefixo de letra fixo + sufixo numérico
 * (RF-DAD-054: "ruas A1–A4"). Prefixos diferentes entre from/to não têm
 * algoritmo definido no documento — rejeitado explicitamente em vez de adivinhar.
 */
function expandAlphaNumericRange(from: string, to: string, label: string): string[] {
  const match = /^([A-Z]*)(\d+)$/;
  const fromMatch = from.match(match);
  const toMatch = to.match(match);
  if (!fromMatch || !toMatch) {
    throw new BadRequestException(`RF-DAD-054: invalid ${label} range format: ${from}..${to}`);
  }
  const [, fromPrefix, fromDigits] = fromMatch;
  const [, toPrefix, toDigits] = toMatch;
  if (fromPrefix !== toPrefix) {
    throw new BadRequestException(
      `[LACUNA: DOC-02 não define algoritmo de intervalo com prefixos de ${label} diferentes] ${from}..${to}`
    );
  }
  const width = fromDigits.length;
  const start = parseInt(fromDigits, 10);
  const end = parseInt(toDigits, 10);
  if (end < start) {
    throw new BadRequestException(`RF-DAD-054: ${label} range end before start: ${from}..${to}`);
  }
  const values: string[] = [];
  for (let n = start; n <= end; n++) {
    values.push(fromPrefix + String(n).padStart(width, '0'));
  }
  return values;
}

/** Intervalo puramente numérico (module, level, slot) preservando zero-padding. */
function expandNumericRange(from: string, to: string, label: string): string[] {
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) {
    throw new BadRequestException(`RF-DAD-054: invalid ${label} range format: ${from}..${to}`);
  }
  const width = from.length;
  const start = parseInt(from, 10);
  const end = parseInt(to, 10);
  if (end < start) {
    throw new BadRequestException(`RF-DAD-054: ${label} range end before start: ${from}..${to}`);
  }
  const values: string[] = [];
  for (let n = start; n <= end; n++) {
    values.push(String(n).padStart(width, '0'));
  }
  return values;
}

@Injectable()
export class LocationService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável, e a resolução de DI do Nest
  // baseada só no tipo TS falha silenciosamente sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  async create(input: CreateLocationInput, actorUserId: string) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.location (
          warehouse_id, zone_id, storage_equipment_id, aisle, module, level, slot,
          location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, abc_class, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING *`,
        [
          input.warehouse_id,
          input.zone_id,
          input.storage_equipment_id ?? null,
          input.aisle,
          input.module,
          input.level,
          input.slot,
          input.location_type,
          input.max_weight_kg,
          input.max_volume_m3,
          input.max_pallets,
          input.max_height_m,
          input.abc_class ?? null,
          actorUserId,
        ]
      );
      return result.rows[0];
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.location WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`location ${id} not found`);
    return result.rows[0];
  }

  async findByCode(warehouseId: string, code: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.location WHERE warehouse_id = $1 AND code = $2', [warehouseId, code]);
    if (result.rows.length === 0) throw new NotFoundException(`location ${code} not found in warehouse ${warehouseId}`);
    return result.rows[0];
  }

  async listByWarehouse(warehouseId: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.location WHERE warehouse_id = $1 ORDER BY code', [warehouseId]);
    return result.rows;
  }

  /**
   * RF-DAD-051: location está na lista de entidades com validação de
   * desativação segura. stock_balance e documentos abertos ainda não existem
   * (Sessão 2B+) — [DEBITO: validar saldo/documentos quando essas tabelas
   * existirem]. Único vínculo já existente nesta sessão:
   * logical_warehouse_location (RG-015) — bloqueia se o endereço ainda
   * estiver vinculado a um armazém lógico.
   */
  async deactivate(id: string, actorUserId: string) {
    const before = await this.findById(id);

    const linked = await this.db.queryGlobal(
      `SELECT id FROM wms.logical_warehouse_location WHERE location_id = $1`,
      [id]
    );
    if (linked.rows.length > 0) {
      throw new ConflictException({
        error: 'LOCATION_LINKED_TO_LOGICAL_WAREHOUSE',
        detail: 'RG-015 item 4: unlink from the logical warehouse before deactivating',
      });
    }

    const result = await this.db.queryGlobal(
      `UPDATE wms.location SET status = 'INACTIVE', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [id, actorUserId]
    );
    const after = result.rows[0];
    await this.auditService.record({
      tenantId: null,
      warehouseId: after.warehouse_id,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'location',
      entityId: id,
      action: 'STATUS_CHANGE',
      requirementId: 'RF-DAD-051',
      before,
      after,
    });
    return after;
  }

  /**
   * RF-DAD-054: geração em massa de endereços por intervalo de coordenadas,
   * evitando duplicidades e reportando o total criado.
   * [LACUNA: DOC-02 não define uma tabela concreta de "capacidades padrão por
   * nível" — implementado como um único conjunto de capacidades aplicado a
   * todos os endereços de uma chamada (o chamador faz uma chamada por nível
   * se quiser capacidades diferentes por nível).]
   */
  async bulkGenerate(input: BulkGenerateLocationsInput, actorUserId: string): Promise<{ total_created: number; total_requested: number; locations: any[] }> {
    const aisles = expandAlphaNumericRange(input.aisle_from, input.aisle_to, 'aisle');
    const modules = expandNumericRange(input.module_from, input.module_to, 'module');
    const levels = expandNumericRange(input.level_from, input.level_to, 'level');
    const slots = expandNumericRange(input.slot_from, input.slot_to, 'slot');

    const combinations: Array<{ aisle: string; module: string; level: string; slot: string }> = [];
    for (const aisle of aisles) {
      for (const mod of modules) {
        for (const level of levels) {
          for (const slot of slots) {
            combinations.push({ aisle, module: mod, level, slot });
          }
        }
      }
    }

    const created = await this.db.transactionGlobal(async (client) => {
      const rows: any[] = [];
      for (const combo of combinations) {
        const result = await client.query(
          `INSERT INTO wms.location (
            warehouse_id, zone_id, storage_equipment_id, aisle, module, level, slot,
            location_type, max_weight_kg, max_volume_m3, max_pallets, max_height_m, abc_class, created_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (warehouse_id, aisle, module, level, slot) DO NOTHING
          RETURNING *`,
          [
            input.warehouse_id,
            input.zone_id,
            input.storage_equipment_id ?? null,
            combo.aisle,
            combo.module,
            combo.level,
            combo.slot,
            input.location_type,
            input.max_weight_kg,
            input.max_volume_m3,
            input.max_pallets,
            input.max_height_m,
            input.abc_class ?? null,
            actorUserId,
          ]
        );
        if (result.rows.length > 0) {
          rows.push(result.rows[0]);
        }
      }
      return rows;
    });

    return {
      total_created: created.length,
      total_requested: combinations.length,
      locations: created,
    };
  }
}
