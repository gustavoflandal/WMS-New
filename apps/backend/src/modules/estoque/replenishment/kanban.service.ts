// DOC-05 §4.5 RF-EST-041 — Kanban. "QUANDO o saldo disponível no(s)
// endereço(s) de picking do produto atingir kanban_trigger_qty, o sistema
// DEVE gerar automaticamente uma tarefa de Reposição de kanban_replenish_qty
// ... selecionando origem pela política de giro do produto. É PROIBIDO gerar
// nova tarefa kanban enquanto houver reposição aberta do mesmo produto×endereço."
//
// [LACUNA] "endereço(s) de picking do produto" (plural) — modelado usando
// `product_warehouse_parameter.default_picking_location_id` (já existente,
// migration 0011) como o único endereço de picking monitorado; DOC-05 não
// detalha o caso de múltiplos endereços de picking do mesmo produto no mesmo
// armazém. kanban_enabled sem default_picking_location_id definido não tem
// destino determinístico — ignorado (sem alerta), documentado abaixo.
//
// [DÉBITO: 5B substitui] "selecionando origem pela política de giro do
// produto" é RN-EST-011 (Seleção de Saldo), explicitamente fora do escopo
// desta sessão (5A). Heurística PROVISÓRIA usada aqui: maior saldo
// `qty_available` num endereço STORAGE do mesmo produto/armazém que cubra a
// quantidade inteira de `kanban_replenish_qty` — não respeita FEFO/FIFO/LIFO/
// JIT. Quando a Sessão 5B implementar o motor de Seleção de Saldo real, este
// método deve chamá-lo em vez desta heurística.
//
// [LACUNA] "arredondada para cima em embalagens de picking" — não
// implementado; `kanban_replenish_qty` é usado literalmente. Arredondamento
// exigiria resolver `product_packaging` do tipo picking, fora do escopo
// desta passada.
//
// Roda cross-tenant via transactionAsWorker (ADR-006), mesmo padrão de
// SafetyStockService/ExpirationService.
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { ReplenishmentTaskService } from './replenishment-task.service.js';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

export interface KanbanCheckResult {
  generatedTaskIds: string[];
  skippedProductIds: string[];
}

@Injectable()
export class KanbanService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(ReplenishmentTaskService) private readonly replenishmentTaskService: ReplenishmentTaskService
  ) {}

  async checkKanban(): Promise<KanbanCheckResult> {
    return this.db.transactionAsWorker(async (client) => {
      const rows = await client.query<{
        tenant_id: string;
        warehouse_id: string;
        product_id: string;
        kanban_trigger_qty: string;
        kanban_replenish_qty: string;
        default_picking_location_id: string | null;
      }>(
        `SELECT tenant_id, warehouse_id, product_id, kanban_trigger_qty, kanban_replenish_qty, default_picking_location_id
         FROM wms.product_warehouse_parameter
         WHERE kanban_enabled = TRUE AND default_picking_location_id IS NOT NULL`
      );

      const generated: string[] = [];
      const skipped: string[] = [];

      for (const row of rows.rows) {
        const pickingBalance = await client.query<{ qty: string }>(
          `SELECT COALESCE(SUM(qty_available), 0) AS qty FROM wms.stock_balance
           WHERE tenant_id = $1 AND warehouse_id = $2 AND product_id = $3 AND location_id = $4`,
          [row.tenant_id, row.warehouse_id, row.product_id, row.default_picking_location_id]
        );
        const pickingQty = Number(pickingBalance.rows[0].qty);
        if (pickingQty > Number(row.kanban_trigger_qty)) continue; // ainda acima do gatilho — nada a fazer.

        const originResult = await client.query<{ location_id: string; batch_id: string | null }>(
          `SELECT sb.location_id, sb.batch_id
           FROM wms.stock_balance sb
           JOIN wms.location l ON l.id = sb.location_id
           WHERE sb.tenant_id = $1 AND sb.warehouse_id = $2 AND sb.product_id = $3 AND l.location_type = 'STORAGE'
             AND sb.qty_available >= $4 AND sb.location_id != $5
           ORDER BY sb.qty_available DESC
           LIMIT 1`,
          [row.tenant_id, row.warehouse_id, row.product_id, row.kanban_replenish_qty, row.default_picking_location_id]
        );
        if (originResult.rows.length === 0) {
          // Nenhum endereço STORAGE cobre a quantidade inteira — [DÉBITO: 5B]
          // não fraciona por múltiplas origens nesta sessão.
          skipped.push(row.product_id);
          continue;
        }
        const origin = originResult.rows[0];

        const { task, skipped: dedupSkipped } = await this.replenishmentTaskService.generateIfNeeded(client, {
          tenantId: row.tenant_id,
          warehouseId: row.warehouse_id,
          productId: row.product_id,
          batchId: origin.batch_id,
          triggerType: 'KANBAN',
          locationIdOrigin: origin.location_id,
          locationIdDestination: row.default_picking_location_id,
          qty: Number(row.kanban_replenish_qty),
          actorUserId: SYSTEM_ACTOR,
        });

        if (dedupSkipped || !task) {
          skipped.push(row.product_id);
          continue;
        }

        await this.eventsService.publishInTransaction(client, {
          event_type: 'estoque.kanban_disparado',
          tenant_id: row.tenant_id,
          warehouse_id: row.warehouse_id,
          payload: { product_id: row.product_id, replenishment_task_id: task.id, picking_qty: pickingQty, kanban_trigger_qty: Number(row.kanban_trigger_qty) },
        });
        generated.push(task.id);
      }

      return { generatedTaskIds: generated, skippedProductIds: skipped };
    });
  }
}
