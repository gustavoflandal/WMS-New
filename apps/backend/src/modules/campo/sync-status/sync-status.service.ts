// DOC-15 §4.5 T8 (Sincronização). RF-ARQ-052/wms.sync_operation existe
// desde a migration 0006 mas SEM produtor real (a fila offline de verdade é
// da Sessão COL-2) — esta tela reflete a realidade (hoje sempre vazia), não
// simula uma fila que ainda não existe. Cross-tenant por dispositivo (mesmo
// raciocínio de MyTasksService): um device_id não pertence a um único
// tenant.
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
        pending: (counts['PENDING'] ?? 0) + (counts['IN_PROGRESS'] ?? 0),
        synced: counts['SYNCED'] ?? 0,
        conflict: counts['CONFLICT'] ?? 0,
        failed: (counts['FAILED'] ?? 0) + (counts['EXPIRED'] ?? 0),
      };
    });
  }
}
