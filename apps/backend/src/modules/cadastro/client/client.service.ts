// DOC-02 §5.1 — client (DE TENANT — RN-DAD-004: tenant_id = client.id).
// Bootstrap: client.id É o tenant_id (DOC-00 §4.2), então criar um client novo
// exige gerar o UUID no app ANTES do INSERT e usá-lo como app.tenant_ids na
// mesma transação (DatabaseService.transaction() já seta isso a partir de
// context.tenant_id) — senão o WITH CHECK da policy RLS rejeita a linha.
import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { mapCadastroDbError } from '../shared/db-error.util.js';

export interface CreateClientInput {
  code: string;
  legal_name: string;
  trade_name?: string;
  cnpj: string;
  state_registration?: string;
  address_street?: string;
  address_number?: string;
  address_complement?: string;
  address_district?: string;
  address_city?: string;
  address_city_ibge_code?: string;
  address_state?: string;
  address_zip_code?: string;
  contact_email?: string;
  contact_phone?: string;
}

export interface UpdateClientInput {
  legal_name?: string;
  trade_name?: string;
  cnpj?: string;
  state_registration?: string;
  address_street?: string;
  address_number?: string;
  address_complement?: string;
  address_district?: string;
  address_city?: string;
  address_city_ibge_code?: string;
  address_state?: string;
  address_zip_code?: string;
  contact_email?: string;
  contact_phone?: string;
}

@Injectable()
export class ClientService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável, e a resolução de DI do Nest
  // baseada só no tipo TS falha silenciosamente sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  async create(input: CreateClientInput, actorUserId: string) {
    const newId = uuid();
    try {
      const client = await this.db.transaction(
        { tenant_id: newId, user_id: actorUserId },
        async (dbClient) => {
          const result = await dbClient.query(
            `INSERT INTO wms.client (
              id, code, legal_name, trade_name, cnpj, state_registration,
              address_street, address_number, address_complement, address_district,
              address_city, address_city_ibge_code, address_state, address_zip_code,
              contact_email, contact_phone, created_by
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            RETURNING *`,
            [
              newId,
              input.code,
              input.legal_name,
              input.trade_name ?? null,
              input.cnpj,
              input.state_registration ?? null,
              input.address_street ?? null,
              input.address_number ?? null,
              input.address_complement ?? null,
              input.address_district ?? null,
              input.address_city ?? null,
              input.address_city_ibge_code ?? null,
              input.address_state ?? null,
              input.address_zip_code ?? null,
              input.contact_email ?? null,
              input.contact_phone ?? null,
              actorUserId,
            ]
          );
          return result.rows[0];
        }
      );
      return client;
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  /** client.id == tenant_id (RN-DAD-004), então o contexto de tenant para ler/gravar é o próprio id. */
  async findById(id: string, actorUserId: string) {
    const result = await this.db.query({ tenant_id: id, user_id: actorUserId }, 'SELECT * FROM wms.client WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`client ${id} not found`);
    return result.rows[0];
  }

  async update(id: string, input: UpdateClientInput, actorUserId: string) {
    const before = await this.findById(id, actorUserId);
    try {
      const result = await this.db.query(
        { tenant_id: id, user_id: actorUserId },
        `UPDATE wms.client SET
          legal_name = COALESCE($2, legal_name),
          trade_name = COALESCE($3, trade_name),
          cnpj = COALESCE($4, cnpj),
          state_registration = COALESCE($5, state_registration),
          address_street = COALESCE($6, address_street),
          address_number = COALESCE($7, address_number),
          address_complement = COALESCE($8, address_complement),
          address_district = COALESCE($9, address_district),
          address_city = COALESCE($10, address_city),
          address_city_ibge_code = COALESCE($11, address_city_ibge_code),
          address_state = COALESCE($12, address_state),
          address_zip_code = COALESCE($13, address_zip_code),
          contact_email = COALESCE($14, contact_email),
          contact_phone = COALESCE($15, contact_phone),
          updated_at = now(), updated_by = $16
         WHERE id = $1 RETURNING *`,
        [
          id,
          input.legal_name ?? null,
          input.trade_name ?? null,
          input.cnpj ?? null,
          input.state_registration ?? null,
          input.address_street ?? null,
          input.address_number ?? null,
          input.address_complement ?? null,
          input.address_district ?? null,
          input.address_city ?? null,
          input.address_city_ibge_code ?? null,
          input.address_state ?? null,
          input.address_zip_code ?? null,
          input.contact_email ?? null,
          input.contact_phone ?? null,
          actorUserId,
        ]
      );
      const after = result.rows[0];
      await this.auditService.record({
        tenantId: id,
        warehouseId: null,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'client',
        entityId: id,
        action: 'UPDATE',
        requirementId: 'DOC-02 §5.1',
        before,
        after,
      });
      return after;
    } catch (error) {
      mapCadastroDbError(error);
    }
  }

  /**
   * RF-DAD-051: client está na lista de entidades com validação de
   * desativação segura. Vínculo verificado nesta sessão: logical_warehouse
   * ACTIVE para o tenant. [DEBITO: validar saldo/documentos abertos quando
   * essas tabelas existirem, Sessão 2B+].
   */
  async deactivate(id: string, actorUserId: string) {
    const before = await this.findById(id, actorUserId);

    const context = { tenant_id: id, user_id: actorUserId };
    const pending = await this.db.query(
      context,
      `SELECT code FROM wms.logical_warehouse WHERE tenant_id = $1 AND status != 'INACTIVE'`,
      [id]
    );
    if (pending.rows.length > 0) {
      throw new ConflictException({
        error: 'CLIENT_HAS_ACTIVE_LOGICAL_WAREHOUSES',
        detail: 'RF-DAD-051: cannot deactivate client with active logical warehouses',
        pending_logical_warehouses: pending.rows.map((r) => r.code),
      });
    }

    const result = await this.db.query(
      context,
      `UPDATE wms.client SET status = 'INACTIVE', updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [id, actorUserId]
    );
    const after = result.rows[0];
    await this.auditService.record({
      tenantId: id,
      warehouseId: null,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'client',
      entityId: id,
      action: 'STATUS_CHANGE',
      requirementId: 'RF-DAD-051',
      before,
      after,
    });
    return after;
  }
}
