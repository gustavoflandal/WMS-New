// DOC-10 §4.5 RN-PAI-042 [INVIOLÁVEL] — materialização de kpi_daily por
// incrementos idempotentes (chave event_id, RG-009) + comando de recontagem
// determinística. Roda inteiramente via transactionAsWorker (BYPASSRLS,
// ADR-006): kpi_daily não tem dimensão de tenant fixa por natureza (linhas
// por cliente E consolidadas por armazém, ver migration 0055) e o
// materializador precisa somar através de todos os clientes de um armazém
// numa única passada.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { KPI_CODES, KpiCode, KpiComputationService, UNCOMPUTABLE_KPIS } from './kpi-computation.service.js';

/** KPIs com dimensão de cliente — materializados 2x (fatia do cliente + total consolidado do armazém, client_id NULL). Os demais só têm a fatia NULL (nunca tiveram cliente). */
const PER_CLIENT_KPIS: ReadonlySet<KpiCode> = new Set(['K-01', 'K-04', 'K-05', 'K-06', 'K-07', 'K-08', 'K-12', 'K-16']);

/** RN-PAI-042: evento -> KPIs que ele afeta. K-13/K-14/K-16 são snapshot (scheduler, ver kpi-snapshot.worker.impl.ts), não entram aqui. K-02 é [LACUNA] (ver UNCOMPUTABLE_KPIS), não recebe gatilho. */
export const EVENT_KPI_MAP: Record<string, KpiCode[]> = {
  'recebimento.concluido': ['K-01', 'K-03', 'K-04'],
  'expedicao.pedido_concluido': ['K-05', 'K-06', 'K-07', 'K-08'],
  'estoque.inventario_concluido': ['K-12'],
  'portaria.gate_out_concluido': ['K-09', 'K-10'],
  'portaria.agendamento_no_show': ['K-11'],
  'portaria.chamada_doca': ['K-17'],
  'expedicao.tarefa_picking_concluida': ['K-15'],
};

export interface KpiDomainEvent {
  event_id: string;
  event_type: string;
  tenant_id: string | null;
  warehouse_id: string;
  occurred_at: string;
}

@Injectable()
export class KpiMaterializationService {
  private readonly logger = new Logger(KpiMaterializationService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(KpiComputationService) private readonly kpiComputationService: KpiComputationService
  ) {}

  /**
   * RN-PAI-042 — idempotência por event_id: se já aplicado, não repete
   * (kpi_event_applied é a chave). Recomputa (não incrementa) os KPIs
   * afetados para o dia LOCAL do armazém em que o evento ocorreu — mesma
   * função usada por recomputeDay(), garantindo que reprocessar produz o
   * mesmo valor.
   */
  async applyEvent(event: KpiDomainEvent): Promise<{ applied: boolean; kpiCodes: KpiCode[] }> {
    const kpiCodes = (EVENT_KPI_MAP[event.event_type] ?? []).filter((k) => !UNCOMPUTABLE_KPIS.has(k));
    if (kpiCodes.length === 0) return { applied: false, kpiCodes: [] };

    return this.db.transactionAsWorker(async (client) => {
      const alreadyApplied = await client.query(`SELECT 1 FROM wms.kpi_event_applied WHERE event_id = $1`, [event.event_id]);
      if (alreadyApplied.rows.length > 0) {
        return { applied: false, kpiCodes: [] };
      }

      const day = await this.resolveWarehouseLocalDate(client, event.warehouse_id, event.occurred_at);
      await this.recomputeKpisForDay(client, event.warehouse_id, day, event.tenant_id, kpiCodes);

      await client.query(`INSERT INTO wms.kpi_event_applied (event_id, kpi_codes) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`, [
        event.event_id,
        kpiCodes,
      ]);

      return { applied: true, kpiCodes };
    });
  }

  /**
   * RN-PAI-042 "comando administrativo de recontagem ... DEVE reproduzir
   * exatamente os mesmos valores a partir das fontes". Recomputa TODOS os
   * KPIs não-snapshot do dia, para TODOS os clientes que tiveram atividade
   * nesse dia/armazém — mesma função de compute que applyEvent() usa.
   */
  async recomputeDay(warehouseId: string, day: string): Promise<{ kpiCodes: KpiCode[] }> {
    const kpiCodes = KPI_CODES.filter((k) => !UNCOMPUTABLE_KPIS.has(k) && !this.isSnapshotKpi(k));
    await this.db.transactionAsWorker(async (client) => {
      const clientIds = await this.resolveActiveClientIds(client, warehouseId, day);
      await this.recomputeKpisForDay(client, warehouseId, day, null, kpiCodes, clientIds);
    });
    return { kpiCodes };
  }

  private isSnapshotKpi(kpi: KpiCode): boolean {
    return kpi === 'K-13' || kpi === 'K-14' || kpi === 'K-16';
  }

  /**
   * Recomputa cada kpiCode para o armazém/dia — client_id específico (se o
   * evento tiver um cliente E o KPI tiver dimensão de cliente) e SEMPRE a
   * fatia consolidada (client_id NULL, PER_CLIENT_KPIS somam todos os
   * clientes; os demais já são NULL por natureza).
   */
  private async recomputeKpisForDay(
    client: PoolClient,
    warehouseId: string,
    day: string,
    eventTenantId: string | null,
    kpiCodes: KpiCode[],
    extraClientIds: string[] = []
  ): Promise<void> {
    for (const kpiCode of kpiCodes) {
      const clientIdsToCompute = PER_CLIENT_KPIS.has(kpiCode)
        ? [...new Set([null, eventTenantId, ...extraClientIds].filter((v, i, arr) => arr.indexOf(v) === i))]
        : [null];

      for (const clientId of clientIdsToCompute) {
        const value = await this.kpiComputationService.compute(client, kpiCode, { warehouseId, day, clientId });
        if (value === null) continue;
        await this.upsertKpiDaily(client, warehouseId, clientId, day, kpiCode, value);
      }
    }

    await this.eventsService.publishInTransaction(client, {
      event_type: 'paineis.kpi_recomputado',
      tenant_id: eventTenantId,
      warehouse_id: warehouseId,
      actor_user_id: '00000000-0000-0000-0000-000000000001',
      payload: { day, kpi_codes: kpiCodes },
    });
  }

  private async upsertKpiDaily(client: PoolClient, warehouseId: string, clientId: string | null, day: string, kpiCode: KpiCode, value: number): Promise<void> {
    await client.query(
      `INSERT INTO wms.kpi_daily (warehouse_id, client_id, day, kpi_code, value, computed_at, created_by)
       VALUES ($1, $2, $3::date, $4, $5, now(), '00000000-0000-0000-0000-000000000001')
       ON CONFLICT (day, warehouse_id, client_id, kpi_code)
       DO UPDATE SET value = EXCLUDED.value, computed_at = now(), updated_at = now()`,
      [warehouseId, clientId, day, kpiCode, value]
    );
  }

  /** RN-PAI-042 "23:59 do fuso do armazém, não UTC" — mesmo princípio aplicado aqui: cada evento é atribuído ao dia CALENDÁRIO local do armazém, não ao dia UTC do timestamp. */
  private async resolveWarehouseLocalDate(client: PoolClient, warehouseId: string, occurredAt: string): Promise<string> {
    const result = await client.query<{ local_date: string }>(
      `SELECT (($1::timestamptz) AT TIME ZONE COALESCE((SELECT timezone FROM wms.warehouse WHERE id = $2), 'UTC'))::date AS local_date`,
      [occurredAt, warehouseId]
    );
    return result.rows[0].local_date;
  }

  private async resolveActiveClientIds(client: PoolClient, warehouseId: string, day: string): Promise<string[]> {
    const result = await client.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM wms.inbound_order WHERE warehouse_id = $1 AND updated_at::date = $2::date
       UNION
       SELECT DISTINCT tenant_id FROM wms.outbound_order WHERE warehouse_id = $1 AND updated_at::date = $2::date`,
      [warehouseId, day]
    );
    return result.rows.map((r) => r.tenant_id);
  }
}
