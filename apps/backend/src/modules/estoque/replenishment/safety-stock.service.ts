// DOC-05 §4.5 RF-EST-040 — Estoque de segurança. "ONDE safety_stock_qty
// estiver definido... SE disponível_total < safety_stock_qty, ENTÃO gerar/
// atualizar alerta ESTOQUE_SEGURANCA... uma notificação por cruzamento de
// limiar, não por movimentação".
//
// [LACUNA/DÉBITO]: RF-EST-040 pede avaliação em DOIS gatilhos — "o scheduler
// (execução horária) E todo evento de baixa". Esta sessão implementa só o
// primeiro: acoplar a checagem a "todo evento de baixa" exigiria que
// StockMovementService.apply() (um primitivo genérico de movimentação, hoje
// sem conhecimento de nenhuma regra de negócio de módulos específicos)
// chamasse este service a cada débito, ou que RESERVA/PICKING (DOC-06,
// inexistente nesta base) o fizessem — nenhum dos dois existe ainda. O job
// horário do scheduler é o mecanismo funcional disponível agora; quando o
// motor de picking/reserva existir, ele deve chamar checkSafetyStock() (ou
// uma variante por produto) diretamente no mesmo ponto de extensão.
//
// Roda cross-tenant via transactionAsWorker (ADR-006), mesmo padrão de
// ExpirationService (RN-EST-014).
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';

export interface SafetyStockCheckResult {
  violatedProductIds: string[];
  recoveredProductIds: string[];
}

@Injectable()
export class SafetyStockService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService
  ) {}

  async checkSafetyStock(): Promise<SafetyStockCheckResult> {
    return this.db.transactionAsWorker(async (client) => {
      const rows = await client.query<{
        id: string;
        tenant_id: string;
        warehouse_id: string;
        product_id: string;
        safety_stock_qty: string;
        safety_stock_alert_active: boolean;
        available_total: string;
      }>(
        `SELECT pwp.id, pwp.tenant_id, pwp.warehouse_id, pwp.product_id, pwp.safety_stock_qty, pwp.safety_stock_alert_active,
                COALESCE((
                  SELECT SUM(sb.qty_available) FROM wms.stock_balance sb
                  WHERE sb.tenant_id = pwp.tenant_id AND sb.warehouse_id = pwp.warehouse_id AND sb.product_id = pwp.product_id
                ), 0) AS available_total
         FROM wms.product_warehouse_parameter pwp
         WHERE pwp.safety_stock_qty IS NOT NULL`
      );

      const violated: string[] = [];
      const recovered: string[] = [];

      for (const row of rows.rows) {
        const isBelow = Number(row.available_total) < Number(row.safety_stock_qty);

        if (isBelow && !row.safety_stock_alert_active) {
          await client.query(`UPDATE wms.product_warehouse_parameter SET safety_stock_alert_active = TRUE, updated_at = now() WHERE id = $1`, [row.id]);
          await this.eventsService.publishInTransaction(client, {
            event_type: 'estoque.estoque_seguranca_violado',
            tenant_id: row.tenant_id,
            warehouse_id: row.warehouse_id,
            payload: { product_id: row.product_id, available_total: Number(row.available_total), safety_stock_qty: Number(row.safety_stock_qty) },
          });
          violated.push(row.product_id);
        } else if (!isBelow && row.safety_stock_alert_active) {
          // RF-EST-040 só descreve a notificação de violação — o reset
          // silencioso ao recuperar é o que TORNA a próxima queda abaixo do
          // limiar um novo "cruzamento" (sem isso, o alerta nunca mais
          // dispararia depois da 1ª vez).
          await client.query(`UPDATE wms.product_warehouse_parameter SET safety_stock_alert_active = FALSE, updated_at = now() WHERE id = $1`, [row.id]);
          recovered.push(row.product_id);
        }
      }

      return { violatedProductIds: violated, recoveredProductIds: recovered };
    });
  }
}
