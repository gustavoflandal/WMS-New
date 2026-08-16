// DOC-03 RD-POR-002 — driver (GLOBAL). RF-POR-011: "motorista... reaproveitado
// de cadastro existente por CPF" — create() é um upsert por CPF (natural key),
// não um INSERT puro: um motorista já conhecido é atualizado, não duplicado.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapPortariaDbError } from '../shared/db-error.util.js';

export interface UpsertDriverInput {
  cpf: string;
  name: string;
  cnh: string;
  cnh_validity: string;
  phone?: string;
}

@Injectable()
export class DriverService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** RF-POR-011: upsert por CPF — motorista já cadastrado é atualizado, não duplicado. */
  async upsertByCpf(input: UpsertDriverInput, actorUserId: string) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.driver (cpf, name, cnh, cnh_validity, phone, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (cpf) DO UPDATE SET
           name = EXCLUDED.name, cnh = EXCLUDED.cnh, cnh_validity = EXCLUDED.cnh_validity,
           phone = EXCLUDED.phone, updated_at = now(), updated_by = $6
         RETURNING *`,
        [input.cpf, input.name, input.cnh, input.cnh_validity, input.phone ?? null, actorUserId]
      );
      return result.rows[0];
    } catch (error) {
      mapPortariaDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.driver WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`driver ${id} not found`);
    return result.rows[0];
  }

  async findByCpf(cpf: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.driver WHERE cpf = $1', [cpf]);
    return result.rows[0] ?? null;
  }
}
