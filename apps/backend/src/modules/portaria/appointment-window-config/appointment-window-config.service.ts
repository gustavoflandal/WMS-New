// DOC-03 RD-POR-007 — appointment_window_config (GLOBAL). Configuração de
// janelas por armazém/dia da semana/sentido, com capacidade por janela (ver
// nota de modelagem sobre POR.JANELA_CAPACIDADE na migration 0023).
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapPortariaDbError } from '../shared/db-error.util.js';

export interface CreateAppointmentWindowConfigInput {
  warehouse_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  direction: 'INBOUND' | 'OUTBOUND';
  capacity: number;
}

@Injectable()
export class AppointmentWindowConfigService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async create(input: CreateAppointmentWindowConfigInput, actorUserId: string) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.appointment_window_config (warehouse_id, weekday, start_time, end_time, direction, capacity, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [input.warehouse_id, input.weekday, input.start_time, input.end_time, input.direction, input.capacity, actorUserId]
      );
      return result.rows[0];
    } catch (error) {
      mapPortariaDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.appointment_window_config WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`appointment_window_config ${id} not found`);
    return result.rows[0];
  }

  async listByWarehouse(warehouseId: string) {
    const result = await this.db.queryGlobal(
      'SELECT * FROM wms.appointment_window_config WHERE warehouse_id = $1 AND status = $2 ORDER BY weekday, start_time',
      [warehouseId, 'ACTIVE']
    );
    return result.rows;
  }
}
