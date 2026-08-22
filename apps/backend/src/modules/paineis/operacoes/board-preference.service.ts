// DOC-10 RD-PAI-005/RF-PAI-002 — "Preferências de filtro persistem por
// usuário". GLOBAL (sem RLS, mesmo padrão de wms.user) — o service sempre
// filtra por user_id = principal autenticado; nenhuma rota expõe a
// preferência de outro usuário.
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';

@Injectable()
export class BoardPreferenceService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async get(userId: string): Promise<Record<string, unknown>> {
    const result = await this.db.queryGlobal<{ filters: Record<string, unknown>; warehouse_id: string | null }>(
      `SELECT filters, warehouse_id FROM wms.user_board_preference WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ?? { filters: {}, warehouse_id: null };
  }

  async save(userId: string, warehouseId: string | null, filters: Record<string, unknown>): Promise<void> {
    await this.db.queryGlobal(
      `INSERT INTO wms.user_board_preference (user_id, warehouse_id, filters, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET warehouse_id = $2, filters = $3, updated_at = now()`,
      [userId, warehouseId, JSON.stringify(filters)]
    );
  }
}
