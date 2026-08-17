// DOC-03 RF-POR-030/031 — gate-in/gate-out de pessoas (visitantes) e painel
// de permanência. person_visit é GLOBAL (RD-POR-004) — sem tenant_id.
//
// portaria.pessoa_entrou/portaria.pessoa_saiu (§4.6) são publicados com
// tenant_id NULL — migration 0031 relaxou wms.event_outbox.tenant_id para
// aceitar NULL exatamente para eventos de domínio verdadeiramente GLOBAIS
// como este (RD-POR-004: person_visit/visitor não têm client associável;
// inventar um tenant_id falso corromperia o dado do evento).
// RealtimeFanoutWorkerImpl roteia esses eventos para o canal Pub/Sub
// `rt:global:{warehouse_id}:{topic}` (ver realtime-fanout.worker.impl.ts).
import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { EventsService } from '../../../core/events/events.service.js';

export interface RegisterPersonGateInInput {
  visitorId: string;
  warehouseId: string;
  hostReason: string;
  authorizedAreas: string[];
  validUntil: string;
  photoUrl?: string;
}

@Injectable()
export class PersonVisitService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(EventsService) private readonly eventsService: EventsService
  ) {}

  /** RF-POR-030: gate-in de visitante — áreas autorizadas devem existir e pertencer ao armazém. */
  async gateIn(input: RegisterPersonGateInInput, actorUserId: string) {
    if (input.authorizedAreas.length > 0) {
      const zonesResult = await this.db.queryGlobal('SELECT id FROM wms.zone WHERE id = ANY($1) AND warehouse_id = $2', [
        input.authorizedAreas,
        input.warehouseId,
      ]);
      if (zonesResult.rows.length !== input.authorizedAreas.length) {
        throw new BadRequestException({
          error: 'INVALID_AUTHORIZED_AREAS',
          detail: 'RF-POR-030: uma ou mais áreas autorizadas não existem ou não pertencem a este armazém',
        });
      }
    }

    // person_visit + event_outbox na MESMA transação (padrão outbox
    // transacional, RNF-ARQ-030) — tenant_id NULL (migration 0031), evento
    // GLOBAL sem client associável (RD-POR-004).
    const row = await this.db.transactionGlobal(async (client) => {
      const result = await client.query(
        `INSERT INTO wms.person_visit (visitor_id, warehouse_id, host_reason, authorized_areas, valid_until, photo_url, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [input.visitorId, input.warehouseId, input.hostReason, input.authorizedAreas, input.validUntil, input.photoUrl ?? null, actorUserId]
      );
      const inserted = result.rows[0];

      await this.eventsService.publishInTransaction(client, {
        event_type: 'portaria.pessoa_entrou',
        tenant_id: null,
        warehouse_id: input.warehouseId,
        actor_user_id: actorUserId,
        payload: { person_visit_id: inserted.id, visitor_id: input.visitorId, warehouse_id: input.warehouseId },
        requirement_ids: ['DOC-03 RF-POR-031', 'DOC-03 §4.6'],
      });

      return inserted;
    });

    await this.auditService.record({
      tenantId: null,
      warehouseId: input.warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'person_visit',
      entityId: row.id,
      action: 'CREATE',
      requirementId: 'DOC-03 RF-POR-030',
      after: row,
    });

    return row;
  }

  /** RF-POR-030: gate-out de visitante. */
  async gateOut(personVisitId: string, actorUserId: string) {
    const before = await this.findById(personVisitId);
    if (before.status !== 'ON_SITE') {
      throw new BadRequestException({ error: 'NOT_ON_SITE', detail: `RF-POR-030: visita ${personVisitId} não está ON_SITE (status atual: ${before.status})` });
    }

    const after = await this.db.transactionGlobal(async (client) => {
      const result = await client.query(
        `UPDATE wms.person_visit SET status = 'DEPARTED', gate_out_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
        [personVisitId, actorUserId]
      );
      const updated = result.rows[0];

      await this.eventsService.publishInTransaction(client, {
        event_type: 'portaria.pessoa_saiu',
        tenant_id: null,
        warehouse_id: updated.warehouse_id,
        actor_user_id: actorUserId,
        payload: { person_visit_id: updated.id, visitor_id: updated.visitor_id, warehouse_id: updated.warehouse_id },
        requirement_ids: ['DOC-03 RF-POR-031', 'DOC-03 §4.6'],
      });

      return updated;
    });

    await this.auditService.record({
      tenantId: null,
      warehouseId: after.warehouse_id,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'person_visit',
      entityId: personVisitId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-03 RF-POR-030',
      before,
      after,
    });

    return after;
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal('SELECT * FROM wms.person_visit WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`person_visit ${id} not found`);
    return result.rows[0];
  }

  /**
   * RF-POR-031: painel — pessoas presentes (ON_SITE), com tempo de
   * permanência e alerta de validade excedida, calculados na consulta.
   */
  async listOnSite(warehouseId: string) {
    const result = await this.db.queryGlobal(
      `SELECT pv.*, v.name AS visitor_name, v.document AS visitor_document, v.company AS visitor_company,
              EXTRACT(EPOCH FROM (now() - pv.gate_in_at)) AS seconds_on_site,
              (now() > pv.valid_until) AS validity_exceeded
       FROM wms.person_visit pv
       JOIN wms.visitor v ON v.id = pv.visitor_id
       WHERE pv.warehouse_id = $1 AND pv.status = 'ON_SITE'
       ORDER BY pv.gate_in_at ASC`,
      [warehouseId]
    );
    return result.rows;
  }
}
