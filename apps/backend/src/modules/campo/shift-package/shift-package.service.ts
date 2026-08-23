// DOC-01 §4.6 RF-ARQ-051 (Pacote de Turno) — pré-carregamento em IndexedDB
// (COL-2B consome esta API): tarefas de todos os tipos executáveis offline
// (T2-T6: putaway, picking, conferência, contagem, transferência/reposição)
// + dados de produto/endereço/LPN necessários para executá-las sem rede,
// respeitando o teto COL.PACOTE_TURNO_MAX.
//
// Reaproveita as queries de MyTasksService (T1, COL-1) em vez de duplicá-las
// — mesmo raciocínio cross-tenant (RN-SEG-011, transactionAsWorker): um
// operador de campo pode ter tarefas atribuídas de vários clientes no mesmo
// armazém. Conferência (T4) e Contagem de Inventário (T5) NÃO têm coluna de
// atribuição por operador (checking_item/inventory_count_location, ver
// migrations 0037/0052) — DOC-15 §4.7 fala em "endereços atribuídos ao
// operador", mas a tabela é um POOL do armazém, não atribuído a um usuário
// específico; herdado tal como está (mesma disciplina de picking_task em
// COL-1) — o Pacote de Turno lista o pool inteiro do armazém para essas duas
// telas, não um subconjunto "meu". [LACUNA: DOC-05/DOC-15 não modelam
// atribuição de célula de inventário/item de conferência por operador.]
//
// picking_task (T3) TEM assigned_to_user_id (nullable até a primeira
// execução, ver picking-task.service.ts) — decisão desta sessão: resolver o
// débito citado pela Sessão COL-1 incluindo picking_task no pacote,
// filtrado por "minhas OU ainda sem operador" (mesmo padrão de pool com
// atribuição lazy já usado pelo próprio serviço de execução).
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';

const ACTIONABLE_STATUSES = ['CREATED', 'ASSIGNED', 'IN_EXECUTION', 'REJECTED_SCAN'];
const DEFAULT_MAX_TASKS = 2000;

export interface ShiftPackageTask {
  taskType: 'PUTAWAY' | 'REPOSICAO' | 'PICKING' | 'CONFERENCIA' | 'CONTAGEM_INVENTARIO';
  taskId: string;
  tenantId: string;
  status: string;
  lpn: string | null;
  productSku: string | null;
  productDescription: string | null;
  locationCode: string | null;
  qty: number | null;
  createdAt: string;
}

export interface ShiftPackage {
  warehouseId: string;
  userId: string;
  packageVersion: string;
  maxTasks: number;
  truncated: boolean;
  taskCount: number;
  tasks: ShiftPackageTask[];
}

@Injectable()
export class ShiftPackageService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async build(warehouseId: string, userId: string): Promise<ShiftPackage> {
    const maxTasks = await this.loadMaxTasks();

    const tasks = await this.db.transactionAsWorker(async (client) => {
      const putawayResult = await client.query(
        `SELECT pt.id, pt.tenant_id, pt.status, pt.created_at, pl.lpn, l.code AS location_code
         FROM wms.putaway_task pt
         LEFT JOIN wms.pallet pl ON pl.id = pt.pallet_id
         LEFT JOIN wms.location l ON l.id = pt.location_id_designated
         WHERE pt.warehouse_id = $1 AND pt.assigned_to_user_id = $2 AND pt.status = ANY($3)
         ORDER BY pt.created_at ASC`,
        [warehouseId, userId, ACTIONABLE_STATUSES]
      );

      const replenishmentResult = await client.query(
        `SELECT rt.id, rt.tenant_id, rt.status, rt.created_at, rt.product_id, rt.qty, l.code AS location_code
         FROM wms.replenishment_task rt
         LEFT JOIN wms.location l ON l.id = rt.location_id_destination
         WHERE rt.warehouse_id = $1 AND rt.assigned_to_user_id = $2 AND rt.status = ANY($3)
         ORDER BY rt.created_at ASC`,
        [warehouseId, userId, ACTIONABLE_STATUSES]
      );

      const pickingResult = await client.query(
        `SELECT pk.id, pk.tenant_id, pk.status, pk.created_at, pk.product_id, pk.qty_suggested AS qty, l.code AS location_code
         FROM wms.picking_task pk
         LEFT JOIN wms.location l ON l.id = pk.location_id_from
         WHERE pk.warehouse_id = $1 AND (pk.assigned_to_user_id = $2 OR pk.assigned_to_user_id IS NULL)
           AND pk.status IN ('CREATED', 'ASSIGNED', 'IN_EXECUTION')
         ORDER BY pk.created_at ASC`,
        [warehouseId, userId]
      );

      const checkingResult = await client.query(
        `SELECT ioi.id, ioi.tenant_id, ioi.status, ioi.created_at, ioi.product_id, ioi.qty_expected AS qty
         FROM wms.inbound_order_item ioi
         JOIN wms.checking c ON c.inbound_order_id = ioi.inbound_order_id
         WHERE c.warehouse_id = $1 AND c.status = 'IN_PROGRESS' AND ioi.status IN ('CHECKING_PENDING', 'RECOUNT_PENDING')
         ORDER BY ioi.created_at ASC`,
        [warehouseId]
      );

      const inventoryResult = await client.query(
        `SELECT icl.id, icl.tenant_id, icl.status, icl.created_at, icl.product_id, icl.system_qty AS qty, l.code AS location_code
         FROM wms.inventory_count_location icl
         JOIN wms.inventory_count ic ON ic.id = icl.header_id
         LEFT JOIN wms.location l ON l.id = icl.location_id
         WHERE icl.warehouse_id = $1 AND ic.status = 'IN_PROGRESS' AND icl.status IN ('PENDING', 'COUNTING')
         ORDER BY icl.created_at ASC`,
        [warehouseId]
      );

      const productIds = new Set<string>();
      for (const row of [...replenishmentResult.rows, ...pickingResult.rows, ...checkingResult.rows, ...inventoryResult.rows]) {
        if (row.product_id) productIds.add(row.product_id);
      }
      const productsById = new Map<string, { sku: string; description: string }>();
      if (productIds.size > 0) {
        const productResult = await client.query(`SELECT id, sku, description FROM wms.product WHERE id = ANY($1)`, [Array.from(productIds)]);
        for (const row of productResult.rows) productsById.set(row.id, { sku: row.sku, description: row.description });
      }

      const toTask = (taskType: ShiftPackageTask['taskType'], row: any): ShiftPackageTask => ({
        taskType,
        taskId: row.id,
        tenantId: row.tenant_id,
        status: row.status,
        lpn: row.lpn ?? null,
        productSku: row.product_id ? productsById.get(row.product_id)?.sku ?? null : null,
        productDescription: row.product_id ? productsById.get(row.product_id)?.description ?? null : null,
        locationCode: row.location_code ?? null,
        qty: row.qty !== undefined && row.qty !== null ? Number(row.qty) : null,
        createdAt: row.created_at,
      });

      return [
        ...putawayResult.rows.map((r) => toTask('PUTAWAY', r)),
        ...replenishmentResult.rows.map((r) => toTask('REPOSICAO', r)),
        ...pickingResult.rows.map((r) => toTask('PICKING', r)),
        ...checkingResult.rows.map((r) => toTask('CONFERENCIA', r)),
        ...inventoryResult.rows.map((r) => toTask('CONTAGEM_INVENTARIO', r)),
      ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });

    const truncated = tasks.length > maxTasks;
    const bounded = truncated ? tasks.slice(0, maxTasks) : tasks;

    return {
      warehouseId,
      userId,
      // RF-ARQ-051: "marca d'água de versão" — timestamp de montagem do
      // pacote; o dispositivo compara na próxima sincronização para saber se
      // precisa recarregar dados de referência (produto/endereço).
      packageVersion: new Date().toISOString(),
      maxTasks,
      truncated,
      taskCount: bounded.length,
      tasks: bounded,
    };
  }

  private async loadMaxTasks(): Promise<number> {
    // wms.app_parameter TEM RLS mesmo em linhas GLOBAL (ver CLAUDE.md) — lê
    // via wms_worker, mesmo padrão de CrossDockService.checkAging().
    const value = await this.db.transactionAsWorker(async (client) => {
      const result = await client.query(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'COL.PACOTE_TURNO_MAX'`);
      return result.rows[0]?.value as string | undefined;
    });
    return value ? Number(value) : DEFAULT_MAX_TASKS;
  }
}
