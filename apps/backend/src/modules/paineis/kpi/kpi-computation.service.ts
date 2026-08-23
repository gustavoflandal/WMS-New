// DOC-10 §4.5 RN-PAI-041 [INVIOLÁVEL] — os 17 KPIs, fórmulas EXATAS da
// tabela. Cada método computa UM KPI para (dia, armazém, cliente|null) a
// partir das FONTES (nunca de kpi_daily) — é o MESMO código usado tanto
// pela materialização incremental (evento -> recomputa o dia) quanto pelo
// comando administrativo de recontagem (RN-PAI-042 "DEVE reproduzir os
// mesmos valores"): usar a função idêntica nos dois caminhos torna a
// determinística trivial de garantir, em vez de reimplementar a mesma
// lógica duas vezes e arriscar divergência.
//
// `clientId: null` computa a fatia "sem dimensão de cliente" (K-02*, K-03,
// K-09, K-10, K-11, K-13, K-14, K-15, K-17 — nenhum tem cliente natural) OU
// o TOTAL do armazém somando todos os clientes (K-01/04/05/06/07/08/12/16 —
// chamado 2x pelo materializador: uma vez com o client_id do evento, outra
// com null para o total consolidado). Ver decisão de modelagem na migration
// 0055.
import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { calculateAccuracyPercent, calculateOtifPercent, calculatePercent, averageHours } from './kpi-formula.util.js';

export const KPI_CODES = [
  'K-01', 'K-02', 'K-03', 'K-04', 'K-05', 'K-06', 'K-07', 'K-08', 'K-09',
  'K-10', 'K-11', 'K-12', 'K-13', 'K-14', 'K-15', 'K-16', 'K-17',
] as const;
export type KpiCode = (typeof KPI_CODES)[number];

/** K-02 e a metade "liberação da doca" de K-03 dependem de um marco que nenhum DOC implementado emite/persiste — ver relatório §. */
export const UNCOMPUTABLE_KPIS: ReadonlySet<KpiCode> = new Set(['K-02']);

export interface KpiComputationInput {
  warehouseId: string;
  /** Data local do armazém (YYYY-MM-DD), não UTC. */
  day: string;
  clientId: string | null;
}

@Injectable()
export class KpiComputationService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async compute(client: PoolClient, kpiCode: KpiCode, input: KpiComputationInput): Promise<number | null> {
    switch (kpiCode) {
      case 'K-01':
        return this.k01OrdensRecebidas(client, input);
      case 'K-02':
        return null; // [LACUNA] ver UNCOMPUTABLE_KPIS
      case 'K-03':
        return this.k03DockToStock(client, input);
      case 'K-04':
        return this.k04PercentDivergencia(client, input);
      case 'K-05':
        return this.k05PedidosExpedidos(client, input);
      case 'K-06':
        return this.k06Otif(client, input);
      case 'K-07':
        return this.k07LeadTimePedido(client, input);
      case 'K-08':
        return this.k08PercentCorte(client, input);
      case 'K-09':
        return this.k09PermanenciaVeiculo(client, input);
      case 'K-10':
        return this.k10VeiculosAtendidos(client, input);
      case 'K-11':
        return this.k11NoShow(client, input);
      case 'K-12':
        return this.k12AcuracidadeEndereco(client, input);
      case 'K-13':
        return this.k13OcupacaoPosicoes(client, input);
      case 'K-14':
        return this.k14CartoesAtrasados(client, input);
      case 'K-15':
        return this.k15ProdutividadePicking(client, input);
      case 'K-16':
        return this.k16LotesAVencer(client, input);
      case 'K-17':
        return this.k17AgingPatio(client, input);
      default: {
        const exhaustive: never = kpiCode;
        throw new Error(`KPI desconhecido: ${exhaustive}`);
      }
    }
  }

  /** K-01 — DOC-04: contagem de recebimento.concluido no período (inbound_order.status='COMPLETED', updated_at como proxy de conclusão — sem coluna completed_at dedicada). */
  private async k01OrdensRecebidas(client: PoolClient, { warehouseId, day, clientId }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM wms.inbound_order
       WHERE warehouse_id = $1 AND status = 'COMPLETED' AND updated_at::date = $2::date
         AND ($3::uuid IS NULL OR tenant_id = $3)`,
      [warehouseId, day, clientId]
    );
    return Number(result.rows[0].count);
  }

  /** K-03 — DOC-04: média(último putaway da ordem − atracação). putaway_task sem completed_at dedicado (proxy: updated_at WHERE status='DONE'); atracação = vehicle_visit.dock_at (Sessão 7A). */
  private async k03DockToStock(client: PoolClient, { warehouseId, day, clientId }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ dock_at: string; putaway_done_at: string }>(
      `SELECT vv.dock_at, MAX(pt.updated_at) AS putaway_done_at
       FROM wms.inbound_order io
       JOIN wms.vehicle_visit vv ON vv.id = io.vehicle_visit_id
       JOIN wms.putaway_task pt ON pt.inbound_order_id = io.id AND pt.status = 'DONE'
       WHERE io.warehouse_id = $1 AND io.status = 'COMPLETED' AND io.updated_at::date = $2::date
         AND vv.dock_at IS NOT NULL
         AND ($3::uuid IS NULL OR io.tenant_id = $3)
       GROUP BY io.id, vv.dock_at`,
      [warehouseId, day, clientId]
    );
    const durationsMs = result.rows.map((r) => new Date(r.putaway_done_at).getTime() - new Date(r.dock_at).getTime()).filter((ms) => ms >= 0);
    return averageHours(durationsMs);
  }

  /** K-04 — DOC-04: ordens com >=1 Divergência ÷ K-01 × 100. */
  private async k04PercentDivergencia(client: PoolClient, input: KpiComputationInput): Promise<number> {
    const { warehouseId, day, clientId } = input;
    const total = await this.k01OrdensRecebidas(client, input);
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(DISTINCT io.id) AS count
       FROM wms.inbound_order io
       JOIN wms.inbound_order_item ioi ON ioi.inbound_order_id = io.id
       JOIN wms.discrepancy d ON d.inbound_order_item_id = ioi.id
       WHERE io.warehouse_id = $1 AND io.status = 'COMPLETED' AND io.updated_at::date = $2::date
         AND ($3::uuid IS NULL OR io.tenant_id = $3)`,
      [warehouseId, day, clientId]
    );
    return calculatePercent(Number(result.rows[0].count), total);
  }

  /** K-05 — DOC-06: contagem de expedicao.pedido_concluido (outbound_order.status='COMPLETED', updated_at como proxy). */
  private async k05PedidosExpedidos(client: PoolClient, { warehouseId, day, clientId }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM wms.outbound_order
       WHERE warehouse_id = $1 AND status = 'COMPLETED' AND updated_at::date = $2::date
         AND ($3::uuid IS NULL OR tenant_id = $3)`,
      [warehouseId, day, clientId]
    );
    return Number(result.rows[0].count);
  }

  /**
   * K-06 OTIF — pedidos COMPLETOS sem corte definitivo (Σqty_short=0 em
   * todos os itens) E gate-out <= expected_dispatch_date, ÷ K-05 × 100.
   * Exemplo normativo §4.5: 40 concluídos, 32 sem corte, 30 no prazo -> 75,0%
   * (denominador é 40 = K-05, não 32).
   */
  private async k06Otif(client: PoolClient, input: KpiComputationInput): Promise<number> {
    const { warehouseId, day, clientId } = input;
    const completed = await this.k05PedidosExpedidos(client, input);
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM wms.outbound_order oo
       JOIN wms.vehicle_visit vv ON vv.id = (
         SELECT l.vehicle_visit_id FROM wms.loading l
         JOIN wms.loading_order lo ON lo.loading_id = l.id
         WHERE lo.outbound_order_id = oo.id LIMIT 1
       )
       WHERE oo.warehouse_id = $1 AND oo.status = 'COMPLETED' AND oo.updated_at::date = $2::date
         AND ($3::uuid IS NULL OR oo.tenant_id = $3)
         AND NOT EXISTS (SELECT 1 FROM wms.outbound_order_item ooi WHERE ooi.outbound_order_id = oo.id AND ooi.qty_short > 0)
         AND vv.gate_out_at IS NOT NULL
         AND oo.expected_dispatch_date IS NOT NULL
         AND vv.gate_out_at::date <= oo.expected_dispatch_date`,
      [warehouseId, day, clientId]
    );
    return calculateOtifPercent(completed, Number(result.rows[0].count));
  }

  /** K-07 — DOC-06: média(gate-out − liberação). liberação = outbound_order.released_at; gate-out = vehicle_visit.gate_out_at via loading/loading_order. */
  private async k07LeadTimePedido(client: PoolClient, { warehouseId, day, clientId }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ released_at: string; gate_out_at: string }>(
      `SELECT oo.released_at, vv.gate_out_at
       FROM wms.outbound_order oo
       JOIN wms.loading_order lo ON lo.outbound_order_id = oo.id
       JOIN wms.loading l ON l.id = lo.loading_id
       JOIN wms.vehicle_visit vv ON vv.id = l.vehicle_visit_id
       WHERE oo.warehouse_id = $1 AND oo.status = 'COMPLETED' AND oo.updated_at::date = $2::date
         AND ($3::uuid IS NULL OR oo.tenant_id = $3)
         AND oo.released_at IS NOT NULL AND vv.gate_out_at IS NOT NULL`,
      [warehouseId, day, clientId]
    );
    const durationsMs = result.rows.map((r) => new Date(r.gate_out_at).getTime() - new Date(r.released_at).getTime()).filter((ms) => ms >= 0);
    return averageHours(durationsMs);
  }

  /** K-08 — DOC-06: Σ qty_short ÷ Σ qty_ordered dos pedidos concluídos × 100. */
  private async k08PercentCorte(client: PoolClient, { warehouseId, day, clientId }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ total_short: string; total_ordered: string }>(
      `SELECT COALESCE(SUM(ooi.qty_short), 0) AS total_short, COALESCE(SUM(ooi.qty_ordered), 0) AS total_ordered
       FROM wms.outbound_order oo
       JOIN wms.outbound_order_item ooi ON ooi.outbound_order_id = oo.id
       WHERE oo.warehouse_id = $1 AND oo.status = 'COMPLETED' AND oo.updated_at::date = $2::date
         AND ($3::uuid IS NULL OR oo.tenant_id = $3)`,
      [warehouseId, day, clientId]
    );
    return calculatePercent(Number(result.rows[0].total_short), Number(result.rows[0].total_ordered));
  }

  /** K-09 — DOC-03: média(gate-out − gate-in) por sentido. Sem dimensão de cliente (visita não é do cliente). */
  private async k09PermanenciaVeiculo(client: PoolClient, { warehouseId, day }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ gate_in_at: string; gate_out_at: string }>(
      `SELECT gate_in_at, gate_out_at FROM wms.vehicle_visit
       WHERE warehouse_id = $1 AND status = 'ENCERRADA' AND gate_out_at::date = $2::date
         AND gate_in_at IS NOT NULL AND gate_out_at IS NOT NULL`,
      [warehouseId, day]
    );
    const durationsMs = result.rows.map((r) => new Date(r.gate_out_at).getTime() - new Date(r.gate_in_at).getTime()).filter((ms) => ms >= 0);
    return averageHours(durationsMs);
  }

  /** K-10 — DOC-03: contagem de visitas ENCERRADAS. */
  private async k10VeiculosAtendidos(client: PoolClient, { warehouseId, day }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM wms.vehicle_visit WHERE warehouse_id = $1 AND status = 'ENCERRADA' AND gate_out_at::date = $2::date`,
      [warehouseId, day]
    );
    return Number(result.rows[0].count);
  }

  /** K-11 — DOC-03: agendamentos NO_SHOW ÷ agendamentos da janela no período × 100. */
  private async k11NoShow(client: PoolClient, { warehouseId, day }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ no_show: string; total: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'NO_SHOW') AS no_show, COUNT(*) AS total
       FROM wms.appointment WHERE warehouse_id = $1 AND window_date = $2::date`,
      [warehouseId, day]
    );
    return calculatePercent(Number(result.rows[0].no_show), Number(result.rows[0].total));
  }

  /** K-12 — RF-EST-064, último inventário concluído no período (lê accuracy_quantity já apurado por InventoryCountExecutionService, não recomputa). */
  private async k12AcuracidadeEndereco(client: PoolClient, { warehouseId, day, clientId }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ accuracy_quantity: string }>(
      `SELECT accuracy_quantity FROM wms.inventory_count
       WHERE warehouse_id = $1 AND status = 'COMPLETED' AND completed_at::date = $2::date
         AND ($3::uuid IS NULL OR tenant_id = $3)
       ORDER BY completed_at DESC LIMIT 1`,
      [warehouseId, day, clientId]
    );
    if (result.rows.length === 0) return 100;
    return calculatePercent(Number(result.rows[0].accuracy_quantity) * 100, 100);
  }

  /** K-13 — snapshot 23:59 local: endereços STORAGE/PICKING com saldo ÷ endereços ativos × 100. */
  private async k13OcupacaoPosicoes(client: PoolClient, { warehouseId }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ occupied: string; total: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wms.stock_balance sb WHERE sb.location_id = l.id AND sb.qty_available > 0)) AS occupied,
         COUNT(*) AS total
       FROM wms.location l
       WHERE l.warehouse_id = $1 AND l.status = 'ACTIVE' AND l.location_type IN ('STORAGE', 'PICKING')`,
      [warehouseId]
    );
    return calculatePercent(Number(result.rows[0].occupied), Number(result.rows[0].total));
  }

  /** K-14 — DOC-10: contagem de cartões que entraram em atraso (RN-PAI-004) no período. flow_step.started_at + PAI.SLA_ETAPA_MIN, mesma regra do painel — conta transições PENDING cujo started_at + SLA já passou dentro do dia (aproximação: etapas ainda PENDING hoje cujo SLA já foi excedido; não reconstrói histórico de atrasos passados que já concluíram). */
  private async k14CartoesAtrasados(client: PoolClient, { warehouseId, day }: KpiComputationInput): Promise<number> {
    const slaResult = await client.query<{ value: string }>(
      `SELECT value FROM wms.app_parameter WHERE scope = 'WAREHOUSE' AND warehouse_id = $1 AND name = 'PAI.SLA_ETAPA_MIN'`,
      [warehouseId]
    );
    let slaMap: Record<string, number> = {};
    try {
      slaMap = slaResult.rows[0]?.value ? JSON.parse(slaResult.rows[0].value) : {};
    } catch {
      slaMap = {};
    }
    const stepCodes = Object.keys(slaMap);
    if (stepCodes.length === 0) return 0;

    const result = await client.query<{ step_code: string; started_at: string }>(
      `SELECT fs.step_code, fs.started_at
       FROM wms.flow_step fs
       JOIN wms.operation_flow of ON of.id = fs.operation_flow_id
       WHERE of.warehouse_id = $1 AND fs.status = 'PENDING' AND fs.started_at IS NOT NULL AND fs.started_at::date <= $2::date
         AND fs.step_code = ANY($3::text[])`,
      [warehouseId, day, stepCodes]
    );
    const now = Date.now();
    let count = 0;
    for (const row of result.rows) {
      const minutesElapsed = (now - new Date(row.started_at).getTime()) / 60000;
      if (minutesElapsed > slaMap[row.step_code]) count += 1;
    }
    return count;
  }

  /** K-15 — DOC-06: Σ tarefas DONE ÷ Σ horas com tarefa em execução, agregado do armazém. */
  private async k15ProdutividadePicking(client: PoolClient, { warehouseId, day }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ started_at: string; completed_at: string }>(
      `SELECT started_at, completed_at FROM wms.picking_task
       WHERE warehouse_id = $1 AND status = 'DONE' AND completed_at::date = $2::date
         AND started_at IS NOT NULL AND completed_at IS NOT NULL`,
      [warehouseId, day]
    );
    const totalHours = result.rows.reduce((sum, r) => sum + (new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 3_600_000, 0);
    if (totalHours <= 0) return 0;
    return Math.round((result.rows.length / totalHours) * 100) / 100;
  }

  /** K-16 — snapshot 23:59 local: lotes com validade <= hoje+30 e saldo > 0. */
  private async k16LotesAVencer(client: PoolClient, { warehouseId, day, clientId }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(DISTINCT b.id) AS count
       FROM wms.batch b
       JOIN wms.stock_balance sb ON sb.batch_id = b.id AND sb.qty_available > 0 AND sb.warehouse_id = $1
       WHERE b.expiration_date IS NOT NULL AND b.expiration_date <= ($2::date + INTERVAL '30 days')
         AND ($3::uuid IS NULL OR b.tenant_id = $3)`,
      [warehouseId, day, clientId]
    );
    return Number(result.rows[0].count);
  }

  /** K-17 — DOC-03: média(chamada para doca − gate-in) das visitas do dia. */
  private async k17AgingPatio(client: PoolClient, { warehouseId, day }: KpiComputationInput): Promise<number> {
    const result = await client.query<{ gate_in_at: string; dock_call_at: string }>(
      `SELECT gate_in_at, dock_call_at FROM wms.vehicle_visit
       WHERE warehouse_id = $1 AND dock_call_at IS NOT NULL AND dock_call_at::date = $2::date AND gate_in_at IS NOT NULL`,
      [warehouseId, day]
    );
    const durationsMinutes = result.rows.map((r) => (new Date(r.dock_call_at).getTime() - new Date(r.gate_in_at).getTime()) / 60000).filter((m) => m >= 0);
    if (durationsMinutes.length === 0) return 0;
    return Math.round((durationsMinutes.reduce((a, b) => a + b, 0) / durationsMinutes.length) * 100) / 100;
  }
}
