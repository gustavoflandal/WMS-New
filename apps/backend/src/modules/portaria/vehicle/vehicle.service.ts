// DOC-03 RD-POR-003 — vehicle (GLOBAL). RF-POR-011: veículo reaproveitado de
// cadastro existente por placa — create() é upsert por placa (natural key).
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapPortariaDbError } from '../shared/db-error.util.js';

export interface UpsertVehicleInput {
  plate: string;
  vehicle_type: string;
  trailer1_plate?: string;
  trailer2_plate?: string;
}

@Injectable()
export class VehicleService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async upsertByPlate(input: UpsertVehicleInput, actorUserId: string) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.vehicle (plate, vehicle_type, trailer1_plate, trailer2_plate, created_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (plate) DO UPDATE SET
           vehicle_type = EXCLUDED.vehicle_type, trailer1_plate = EXCLUDED.trailer1_plate,
           trailer2_plate = EXCLUDED.trailer2_plate, updated_at = now(), updated_by = $5
         RETURNING *`,
        [input.plate, input.vehicle_type, input.trailer1_plate ?? null, input.trailer2_plate ?? null, actorUserId]
      );
      return result.rows[0];
    } catch (error) {
      mapPortariaDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.vehicle WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`vehicle ${id} not found`);
    return result.rows[0];
  }

  async findByPlate(plate: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.vehicle WHERE plate = $1', [plate]);
    return result.rows[0] ?? null;
  }
}
