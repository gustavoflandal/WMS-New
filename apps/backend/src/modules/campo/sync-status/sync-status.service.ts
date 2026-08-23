// DOC-15 §4.5 T8 (Sincronização). RF-ARQ-052/wms.sync_operation existe
// desde a migration 0006; primeiro produtor real é OfflineSyncService
// (Sessão COL-2A). Cross-tenant por dispositivo (mesmo raciocínio de
// MyTasksService): um device_id não pertence a um único tenant.
//
// DOC-01 §5.2 (Sessão COL-2A, migration 0068) renomeou o enum de status para
// os nomes normativos (LOCAL_PENDENTE/ENVIANDO/APLICADA/DESCARTADA_
// DUPLICIDADE/REJEITADA_TAREFA_INVALIDA/REJEITADA_REGRA) — o contrato
// público desta tela (4 contadores: pending/synced/conflict/failed, herdado
// de COL-1) é mantido, com o mapeamento: pending = LOCAL_PENDENTE+ENVIANDO;
// synced = APLICADA; conflict = DESCARTADA_DUPLICIDADE (mais próximo
// semanticamente de "conflito" entre as 4 decisões); failed =
// REJEITADA_TAREFA_INVALIDA+REJEITADA_REGRA (ambas rejeições).
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';

export interface SyncStatus {
  deviceId: string;
  pending: number;
  synced: number;
  conflict: number;
  failed: number;
}

@Injectable()
export class SyncStatusService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async getStatus(deviceId: string): Promise<SyncStatus> {
    return this.db.transactionAsWorker(async (client) => {
      const result = await client.query(`SELECT status, COUNT(*) AS count FROM wms.sync_operation WHERE device_id = $1 GROUP BY status`, [deviceId]);
      const counts: Record<string, number> = {};
      for (const row of result.rows) counts[row.status] = Number(row.count);
      return {
        deviceId,
        pending: (counts['LOCAL_PENDENTE'] ?? 0) + (counts['ENVIANDO'] ?? 0),
        synced: counts['APLICADA'] ?? 0,
        conflict: counts['DESCARTADA_DUPLICIDADE'] ?? 0,
        failed: (counts['REJEITADA_TAREFA_INVALIDA'] ?? 0) + (counts['REJEITADA_REGRA'] ?? 0),
      };
    });
  }
}
