// DOC-15 §4.5 T1 (Minhas Tarefas) — fila do operador, cross-módulo.
// [LACUNA: DOC-15 não define uma tabela/consulta "minhas tarefas"; agrega as
// tarefas já existentes com assigned_to_user_id (putaway_task,
// replenishment_task). picking_task NÃO tem coluna de operador atribuído
// nem consulta cross-order — [LACUNA: exigiria mudança em
// PickingTaskService/expedição, fora do escopo desta sessão (COL-1);
// registrado como débito, não inventado.]
//
// Cross-tenant por natureza (RN-SEG-011, mesmo raciocínio de
// OperationsBoardService/DOC-10): um operador de campo pode ter tarefas
// atribuídas de vários clientes no MESMO armazém — roda como wms_worker
// (transactionAsWorker, ADR-006). putaway_task/replenishment_task/product já
// concedem SELECT a wms_worker (migrations 0057/0047); location é GLOBAL.
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';

const ACTIONABLE_STATUSES = ['CREATED', 'ASSIGNED', 'IN_EXECUTION', 'REJECTED_SCAN'];

export interface MyTask {
  id: string;
  type: 'PUTAWAY' | 'REPOSICAO';
  status: string;
  lpn: string | null;
  productSku: string | null;
  productDescription: string | null;
  locationCode: string | null;
  qty: number | null;
  createdAt: string;
}

@Injectable()
export class MyTasksService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async listMyTasks(warehouseId: string, userId: string): Promise<MyTask[]> {
    return this.db.transactionAsWorker(async (client) => {
      // putaway_task não referencia product_id diretamente (um palete pode
      // ser misto — pallet_content) — para "Minhas Tarefas" mostramos o LPN
      // do palete (identificador realmente lido pelo operador no passo 1 da
      // tarefa, RF-REC-042), não o produto.
      const putawayResult = await client.query(
        `SELECT pt.id, pt.status, pt.created_at, pl.lpn, l.code AS location_code
         FROM wms.putaway_task pt
         LEFT JOIN wms.pallet pl ON pl.id = pt.pallet_id
         LEFT JOIN wms.location l ON l.id = pt.location_id_designated
         WHERE pt.warehouse_id = $1 AND pt.assigned_to_user_id = $2 AND pt.status = ANY($3)
         ORDER BY pt.created_at ASC`,
        [warehouseId, userId, ACTIONABLE_STATUSES]
      );

      const replenishmentResult = await client.query(
        `SELECT rt.id, rt.status, rt.created_at, rt.product_id, rt.qty, l.code AS location_code
         FROM wms.replenishment_task rt
         LEFT JOIN wms.location l ON l.id = rt.location_id_destination
         WHERE rt.warehouse_id = $1 AND rt.assigned_to_user_id = $2 AND rt.status = ANY($3)
         ORDER BY rt.created_at ASC`,
        [warehouseId, userId, ACTIONABLE_STATUSES]
      );

      const productIds = replenishmentResult.rows.map((r) => r.product_id).filter((id): id is string => !!id);

      const productsById = new Map<string, { sku: string; description: string }>();
      if (productIds.length > 0) {
        const productResult = await client.query(`SELECT id, sku, description FROM wms.product WHERE id = ANY($1)`, [productIds]);
        for (const row of productResult.rows) {
          productsById.set(row.id, { sku: row.sku, description: row.description });
        }
      }

      const putawayTasks: MyTask[] = putawayResult.rows.map((row) => ({
        id: row.id,
        type: 'PUTAWAY',
        status: row.status,
        lpn: row.lpn,
        productSku: null,
        productDescription: null,
        locationCode: row.location_code,
        qty: null,
        createdAt: row.created_at,
      }));

      const replenishmentTasks: MyTask[] = replenishmentResult.rows.map((row) => ({
        id: row.id,
        type: 'REPOSICAO',
        status: row.status,
        lpn: null,
        productSku: productsById.get(row.product_id)?.sku ?? null,
        productDescription: productsById.get(row.product_id)?.description ?? null,
        locationCode: row.location_code,
        qty: row.qty !== null ? Number(row.qty) : null,
        createdAt: row.created_at,
      }));

      return [...putawayTasks, ...replenishmentTasks].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });
  }
}
