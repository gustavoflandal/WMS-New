// DOC-10 RN-PAI-042 [INVIOLÁVEL] — K-13 (ocupação), K-14 (cartões
// atrasados) e K-16 (lotes a vencer) são condições "agora", não deriváveis
// de um evento discreto (nenhum evento marca "este endereço passou a estar
// ocupado às 23:59"). DOC-10 nomeia K-13/K-16 como snapshot; K-14 tem a
// mesma natureza (decisão desta sessão, ver relatório) — as 3 entram juntas
// no fechamento diário.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { KpiComputationService } from './kpi-computation.service.js';

const SNAPSHOT_KPIS = ['K-13', 'K-14', 'K-16'] as const;

@Injectable()
export class KpiSnapshotService {
  private readonly logger = new Logger(KpiSnapshotService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(KpiComputationService) private readonly kpiComputationService: KpiComputationService
  ) {}

  /** Todos os armazéns ativos com timezone cadastrado — o worker chama isPastLocalSnapshotTime() para cada um. */
  async listWarehousesForSnapshot(): Promise<Array<{ id: string; timezone: string }>> {
    const result = await this.db.transactionAsWorker((client) => client.query<{ id: string; timezone: string }>(`SELECT id, timezone FROM wms.warehouse`));
    return result.rows;
  }

  /** Já rodou o snapshot deste armazém/dia? (idempotência — evita recomputar a cada poll dentro da janela 23:59-23:59:59). */
  async alreadySnapshotted(warehouseId: string, day: string): Promise<boolean> {
    const result = await this.db.transactionAsWorker((client) =>
      client.query(`SELECT 1 FROM wms.kpi_daily WHERE warehouse_id = $1 AND client_id IS NULL AND day = $2::date AND kpi_code = 'K-13'`, [warehouseId, day])
    );
    return result.rows.length > 0;
  }

  async runSnapshot(warehouseId: string, day: string): Promise<void> {
    await this.db.transactionAsWorker(async (client) => {
      for (const kpiCode of SNAPSHOT_KPIS) {
        const value = await this.kpiComputationService.compute(client, kpiCode, { warehouseId, day, clientId: null });
        if (value === null) continue;
        await client.query(
          `INSERT INTO wms.kpi_daily (warehouse_id, client_id, day, kpi_code, value, computed_at, created_by)
           VALUES ($1, NULL, $2::date, $3, $4, now(), '00000000-0000-0000-0000-000000000001')
           ON CONFLICT (day, warehouse_id, client_id, kpi_code) DO UPDATE SET value = EXCLUDED.value, computed_at = now(), updated_at = now()`,
          [warehouseId, day, kpiCode, value]
        );
      }
      await this.eventsService.publishInTransaction(client, {
        event_type: 'paineis.kpi_recomputado',
        tenant_id: null,
        warehouse_id: warehouseId,
        actor_user_id: '00000000-0000-0000-0000-000000000001',
        payload: { day, kpi_codes: SNAPSHOT_KPIS },
      });
    });
    this.logger.log(`KPI snapshot computed for warehouse ${warehouseId} day ${day}`);
  }
}
