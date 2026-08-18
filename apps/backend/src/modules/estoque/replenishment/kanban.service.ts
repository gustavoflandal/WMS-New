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
// [DÉBITO FECHADO na Sessão 5B] "selecionando origem pela política de giro do
// produto" (RF-EST-041) é RN-EST-011, que a 5A não tinha. A heurística
// provisória da 5A (maior saldo em endereço STORAGE, sem respeitar
// FEFO/FIFO/LIFO/JIT) foi SUBSTITUÍDA pela Seleção de Saldo real, consumida
// pela porta StockSelectionPort (selection/stock-selection.port.ts) com
// finalidade `INTERNAL_REPLENISHMENT`.
//
// A finalidade importa: RN-EST-012 (shelf life) só incide sobre expedição a
// cliente, e reposição de picking é movimentação interna — o contrato da
// porta obriga a declarar isso explicitamente, em vez de deixar implícito.
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
import { StockSelectionService } from '../selection/stock-selection.service.js';

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
    @Inject(ReplenishmentTaskService) private readonly replenishmentTaskService: ReplenishmentTaskService,
    @Inject(StockSelectionService) private readonly stockSelectionService: StockSelectionService
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

        // RF-EST-041: "selecionando origem pela política de giro do produto"
        // — Seleção de Saldo real (RN-EST-010/011), pela porta. Substitui a
        // heurística provisória da 5A (ver cabeçalho).
        const replenishQty = Number(row.kanban_replenish_qty);
        const selection = await this.stockSelectionService.selectInTransaction(client, {
          tenantId: row.tenant_id,
          warehouseId: row.warehouse_id,
          productId: row.product_id,
          demandQty: replenishQty,
          purpose: 'INTERNAL_REPLENISHMENT',
          actorUserId: SYSTEM_ACTOR,
        });

        // O endereço de picking de DESTINO é candidato legítimo da seleção
        // (tem saldo disponível), mas repor de si mesmo é no-op — descartado
        // aqui, não no motor de seleção, que não conhece o destino.
        const originAllocation = selection.allocations.find((a) => a.candidate.locationId !== row.default_picking_location_id);
        if (!originAllocation) {
          // Nenhuma origem elegível pela política de giro.
          // [DÉBITO: fracionamento da reposição em MÚLTIPLAS origens — a
          // seleção já devolve a lista completa de alocações, mas
          // wms.replenishment_task (RD-EST-002, migration 0047) modela UMA
          // origem por tarefa. Gerar N tarefas para uma reposição exigiria
          // decidir como o kanban dedupe (RF-EST-041 proíbe segunda tarefa do
          // mesmo produto×endereço enquanto houver uma aberta) trata o
          // conjunto — regra que o DOC-05 não define. Sessão-alvo: DOC-06,
          // quando o picking exercitar reposições fracionadas de verdade.]
          skipped.push(row.product_id);
          continue;
        }

        const { task, skipped: dedupSkipped } = await this.replenishmentTaskService.generateIfNeeded(client, {
          tenantId: row.tenant_id,
          warehouseId: row.warehouse_id,
          productId: row.product_id,
          batchId: originAllocation.candidate.batchId,
          triggerType: 'KANBAN',
          locationIdOrigin: originAllocation.candidate.locationId,
          locationIdDestination: row.default_picking_location_id,
          qty: replenishQty,
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
