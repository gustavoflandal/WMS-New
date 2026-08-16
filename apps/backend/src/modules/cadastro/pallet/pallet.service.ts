// DOC-02 §5.4 — pallet (DE TENANT). RG-007: todo palete criado recebe LPN
// único global (RN-DAD-030, via LpnService) — geração dentro da MESMA
// transação do INSERT do palete.
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { LpnService } from '../lpn/lpn.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreatePalletInput {
  tenant_id: string;
  warehouse_id: string;
  pallet_type: string;
  actor_user_id: string; // [LACUNA: RBAC DOC-12]
}

@Injectable()
export class PalletService {
  constructor(
    private readonly db: DatabaseService,
    private readonly lpnService: LpnService
  ) {}

  async create(input: CreatePalletInput) {
    try {
      // warehouse_id no contexto é necessário para que LpnService consiga
      // ler app_parameter (scope WAREHOUSE) dentro desta mesma transação —
      // a policy RLS de app_parameter (migration 0004) exige app.warehouse_id.
      return await this.db.transaction(
        { tenant_id: input.tenant_id, user_id: input.actor_user_id, warehouse_id: input.warehouse_id },
        async (client) => {
          const lpn = await this.lpnService.generate(client, input.warehouse_id, input.actor_user_id);
          const result = await client.query(
            `INSERT INTO wms.pallet (tenant_id, lpn, pallet_type, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
            [input.tenant_id, lpn, input.pallet_type, input.actor_user_id]
          );
          return result.rows[0];
        }
      );
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  async findByLpn(tenantId: string, actorUserId: string, lpn: string) {
    const result = await this.db.query({ tenant_id: tenantId, user_id: actorUserId }, 'SELECT * FROM wms.pallet WHERE lpn = $1', [lpn]);
    if (result.rows.length === 0) throw new NotFoundException(`pallet with lpn ${lpn} not found`);
    return result.rows[0];
  }
}
