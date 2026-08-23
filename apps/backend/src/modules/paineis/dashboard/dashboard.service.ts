// DOC-10 §4.5 RF-PAI-040/043 — dashboards de performance diária. FONTE
// EXCLUSIVA: wms.kpi_daily (é PROIBIDO consultar tabela transacional quente
// aqui, RF-PAI-040) — todo método deste service só faz SELECT em
// wms.kpi_daily (+ JOIN em wms.client só para o nome no ranking), nunca em
// inbound_order/outbound_order/vehicle_visit/etc. (essas são lidas pelo
// MATERIALIZADOR, kpi-computation.service.ts, uma única vez por dia/evento
// — não a cada visualização de dashboard).
//
// Roda via transactionAsWorker (BYPASSRLS), mesmo raciocínio de
// OperationsBoardService: "sem filtro de cliente" (Gestor/Líder, PAI.DASHBOARD
// WAREHOUSE) precisa agregar através de TODOS os clientes do armazém numa
// única consulta — RLS por tenant único não representa isso. RN-SEG-011 (só
// clientes autorizados) é responsabilidade do CONTROLLER: quando o usuário
// pede um client_id específico, valida contra RbacService.getAuthorizedClientIds
// antes de chamar este service.
import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { KpiCode } from '../kpi/kpi-computation.service.js';
import { DashboardGroup, GROUP_KPIS, aggregationKindFor } from './dashboard-groups.util.js';

export interface DashboardPeriod {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface KpiCardResult {
  kpiCode: KpiCode;
  value: number;
  sevenDayAverage: number;
  trend: 'UP' | 'DOWN' | 'FLAT';
  timeseries: Array<{ day: string; value: number }>;
}

export interface GroupDashboardResult {
  group: DashboardGroup;
  cards: KpiCardResult[];
  topClientsByVolume: Array<{ clientId: string; clientName: string | null; value: number }>;
}

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /** RF-PAI-040 — cartões de valor + comparativo 7 dias + tendência + série temporal, por grupo. */
  async getGroupDashboard(group: DashboardGroup, warehouseId: string, clientId: string | null, period: DashboardPeriod): Promise<GroupDashboardResult> {
    return this.db.transactionAsWorker(async (client) => {
      const kpiCodes = GROUP_KPIS[group];
      const cards: KpiCardResult[] = [];
      for (const kpiCode of kpiCodes) {
        cards.push(await this.computeCard(client, kpiCode, warehouseId, clientId, period));
      }
      const topClientsByVolume = kpiCodes.includes('K-05') ? await this.topClientsByVolume(client, warehouseId, period) : [];
      return { group, cards, topClientsByVolume };
    });
  }

  private async computeCard(client: PoolClient, kpiCode: KpiCode, warehouseId: string, clientId: string | null, period: DashboardPeriod): Promise<KpiCardResult> {
    const kind = aggregationKindFor(kpiCode);
    const aggFn = kind === 'SUM' ? 'COALESCE(SUM(value), 0)' : 'COALESCE(AVG(value), 0)';

    const periodResult = await client.query<{ value: string }>(
      `SELECT ${aggFn} AS value FROM wms.kpi_daily
       WHERE warehouse_id = $1 AND client_id IS NOT DISTINCT FROM $2 AND kpi_code = $3 AND day BETWEEN $4::date AND $5::date`,
      [warehouseId, clientId, kpiCode, period.from, period.to]
    );
    const value = Number(periodResult.rows[0].value);

    // RF-PAI-043 "comparativo com a média dos 7 dias anteriores" — os 7 dias
    // imediatamente antes do FIM do período selecionado (não do início:
    // "do dia" no texto normativo refere-se ao dia mais recente exibido).
    const sevenDayResult = await client.query<{ value: string }>(
      `SELECT COALESCE(AVG(daily.value), 0) AS value FROM (
         SELECT day, ${kind === 'SUM' ? 'SUM(value)' : 'AVG(value)'} AS value
         FROM wms.kpi_daily
         WHERE warehouse_id = $1 AND client_id IS NOT DISTINCT FROM $2 AND kpi_code = $3
           AND day BETWEEN ($4::date - INTERVAL '7 days') AND ($4::date - INTERVAL '1 day')
         GROUP BY day
       ) daily`,
      [warehouseId, clientId, kpiCode, period.to]
    );
    const sevenDayAverage = Number(sevenDayResult.rows[0]?.value ?? 0);

    const timeseriesResult = await client.query<{ day: string; value: string }>(
      `SELECT day::text, ${kind === 'SUM' ? 'SUM(value)' : 'AVG(value)'} AS value FROM wms.kpi_daily
       WHERE warehouse_id = $1 AND client_id IS NOT DISTINCT FROM $2 AND kpi_code = $3 AND day BETWEEN $4::date AND $5::date
       GROUP BY day ORDER BY day ASC`,
      [warehouseId, clientId, kpiCode, period.from, period.to]
    );

    const trend: 'UP' | 'DOWN' | 'FLAT' = value > sevenDayAverage ? 'UP' : value < sevenDayAverage ? 'DOWN' : 'FLAT';

    return {
      kpiCode,
      value,
      sevenDayAverage,
      trend,
      timeseries: timeseriesResult.rows.map((r) => ({ day: r.day, value: Number(r.value) })),
    };
  }

  /**
   * RF-PAI-043 ranking top-5 "clientes por volume" — soma K-05 (pedidos
   * expedidos) por cliente no período, só linhas client_id NOT NULL.
   * [LACUNA: o 2º ranking do texto normativo, "etapas por atraso", exigiria
   * quebra de K-14 por step_code — kpi_daily (grão dia×armazém×cliente×kpi)
   * não guarda essa dimensão; ver dashboard-groups.util.ts para o raciocínio
   * completo. Implementar exigiria alterar RD-PAI-001, fora do escopo desta
   * sessão sem essa decisão de schema.]
   */
  private async topClientsByVolume(client: PoolClient, warehouseId: string, period: DashboardPeriod): Promise<Array<{ clientId: string; clientName: string | null; value: number }>> {
    const result = await client.query<{ client_id: string; client_name: string | null; value: string }>(
      `SELECT kd.client_id, c.legal_name AS client_name, SUM(kd.value) AS value
       FROM wms.kpi_daily kd
       LEFT JOIN wms.client c ON c.id = kd.client_id
       WHERE kd.warehouse_id = $1 AND kd.kpi_code = 'K-05' AND kd.client_id IS NOT NULL AND kd.day BETWEEN $2::date AND $3::date
       GROUP BY kd.client_id, c.legal_name
       ORDER BY value DESC
       LIMIT 5`,
      [warehouseId, period.from, period.to]
    );
    return result.rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, value: Number(r.value) }));
  }

  /** RF-PAI-043 — exportação CSV dos valores exibidos, auditada (RN-SEG-032). */
  async exportGroupCsv(group: DashboardGroup, warehouseId: string, clientId: string | null, period: DashboardPeriod, actorUserId: string): Promise<string> {
    const dashboard = await this.getGroupDashboard(group, warehouseId, clientId, period);

    const lines = ['kpi_code,day,value'];
    for (const card of dashboard.cards) {
      for (const point of card.timeseries) {
        lines.push(`${card.kpiCode},${point.day},${point.value}`);
      }
    }
    const csv = lines.join('\n');

    await this.auditService.record({
      tenantId: clientId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'dashboard_export',
      entityId: `${group}:${period.from}:${period.to}`,
      action: 'EXPORT',
      requirementId: 'DOC-10 RN-SEG-032',
      after: { group, warehouseId, clientId, period, rowCount: lines.length - 1 },
    });

    return csv;
  }
}
