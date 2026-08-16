// DOC-03 RD-POR-004 — visitor (GLOBAL). RF-POR-030: pessoa reaproveitada por
// documento entre visitas — create() é upsert por documento (natural key).
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { mapPortariaDbError } from '../shared/db-error.util.js';

export interface UpsertVisitorInput {
  document: string;
  name: string;
  company?: string;
}

@Injectable()
export class VisitorService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async upsertByDocument(input: UpsertVisitorInput, actorUserId: string) {
    try {
      const result = await this.db.queryGlobal(
        `INSERT INTO wms.visitor (document, name, company, created_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (document) DO UPDATE SET
           name = EXCLUDED.name, company = EXCLUDED.company, updated_at = now(), updated_by = $4
         RETURNING *`,
        [input.document, input.name, input.company ?? null, actorUserId]
      );
      return result.rows[0];
    } catch (error) {
      mapPortariaDbError(error);
    }
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.visitor WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`visitor ${id} not found`);
    return result.rows[0];
  }

  async findByDocument(document: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.visitor WHERE document = $1', [document]);
    return result.rows[0] ?? null;
  }
}
