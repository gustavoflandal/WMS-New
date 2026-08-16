// DOC-03 RD-POR-005 — vehicle_visit, documento raiz da portaria. Este
// service centraliza APENAS a mecânica da máquina de estados (§5.1) — a
// orquestração de negócio (eventos, auditoria, efeitos colaterais como
// alocação de vaga) fica nos services que a chamam (GateInService,
// DockCallService, GateOutService), dentro da MESMA transação, porque cada
// fluxo publica eventos e grava auditoria com semântica própria.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { resolveVehicleVisitTransition, VehicleVisitEvent, VehicleVisitStatus } from './vehicle-visit-state-machine.util.js';

export interface CreateVehicleVisitInput {
  tenant_id: string;
  warehouse_id: string;
  appointment_id?: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  vehicle_id: string;
  driver_id: string;
  carrier_name?: string | null;
  carrier_cnpj?: string | null;
  nfe_keys?: string[];
  km?: number | null;
  photo_url?: string | null;
  contains_hazmat?: boolean;
  contains_perishable?: boolean;
}

@Injectable()
export class VehicleVisitService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** Cria a visita já em CHEGADA_REGISTRADA (§5.1: "[*] --> CHEGADA_REGISTRADA: placa identificada"). */
  async createWithClient(client: PoolClient, input: CreateVehicleVisitInput, actorUserId: string) {
    const result = await client.query(
      `INSERT INTO wms.vehicle_visit (
        tenant_id, warehouse_id, appointment_id, direction, vehicle_id, driver_id,
        carrier_name, carrier_cnpj, nfe_keys, km, photo_url, contains_hazmat, contains_perishable,
        status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CHEGADA_REGISTRADA',$14) RETURNING *`,
      [
        input.tenant_id,
        input.warehouse_id,
        input.appointment_id ?? null,
        input.direction,
        input.vehicle_id,
        input.driver_id,
        input.carrier_name ?? null,
        input.carrier_cnpj ?? null,
        input.nfe_keys ?? [],
        input.km ?? null,
        input.photo_url ?? null,
        input.contains_hazmat ?? false,
        input.contains_perishable ?? false,
        actorUserId,
      ]
    );
    return result.rows[0];
  }

  /**
   * DOC-03 §5.1 [regra fixa] — única forma de alterar vehicle_visit.status.
   * Rejeita com erro determinístico (InvalidVehicleVisitTransitionError,
   * mapeado para 409 pelo chamador) qualquer (origem, evento) fora da
   * tabela de transições — não existe setStatus() livre.
   */
  async transitionWithClient(
    client: PoolClient,
    visitId: string,
    currentStatus: VehicleVisitStatus,
    event: VehicleVisitEvent,
    updates: Record<string, unknown>,
    actorUserId: string
  ) {
    const newStatus = resolveVehicleVisitTransition(currentStatus, event);

    const setClauses = ['status = $2', 'updated_at = now()', 'updated_by = $3'];
    const values: unknown[] = [visitId, newStatus, actorUserId];
    let i = 4;
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = $${i}`);
      values.push(value);
      i++;
    }

    const result = await client.query(`UPDATE wms.vehicle_visit SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`, values);
    return result.rows[0];
  }

  async findById(id: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query({ tenant_id: tenantId, user_id: actorUserId }, 'SELECT * FROM wms.vehicle_visit WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`vehicle_visit ${id} not found`);
    return result.rows[0];
  }
}
