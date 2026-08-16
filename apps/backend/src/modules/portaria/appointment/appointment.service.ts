// DOC-03 §4.1 — Agendamento. RF-POR-001 (criação, máscara AGD), RN-POR-002
// (capacidade sem overbooking — reserva atômica via trigger, migration
// 0030), RF-POR-003 (remarcação/cancelamento), RN-POR-004 (no-show, worker).
import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { DocumentNumberingService } from '../../cadastro/document-numbering/document-numbering.service.js';
import { mapPortariaDbError } from '../shared/db-error.util.js';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

export interface CreateAppointmentInput {
  tenant_id: string;
  warehouse_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  window_config_id: string;
  window_date: string;
  vehicle_type: string;
  asn_reference?: string;
  order_reference?: string;
  contains_hazmat?: boolean;
  contains_perishable?: boolean;
}

@Injectable()
export class AppointmentService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService,
    @Inject(DocumentNumberingService) private readonly documentNumbering: DocumentNumberingService
  ) {}

  /** RF-POR-001 + RN-POR-002. Número gerado pela máscara AGD (RN-DAD-040). */
  async create(input: CreateAppointmentInput, actorUserId: string, origin: 'NORMAL' | 'SEM_AGENDA' = 'NORMAL', initialStatus: 'SCHEDULED' | 'CONFIRMED_ARRIVAL' = 'SCHEDULED') {
    try {
      const appointment = await this.db.transaction(
        { tenant_id: input.tenant_id, user_id: actorUserId, warehouse_id: input.warehouse_id },
        async (client) => {
          const warehouseResult = await client.query('SELECT code FROM wms.warehouse WHERE id = $1', [input.warehouse_id]);
          if (warehouseResult.rows.length === 0) throw new NotFoundException(`warehouse ${input.warehouse_id} not found`);
          const warehouseCode = warehouseResult.rows[0].code;

          const number = await this.documentNumbering.generateDocumentNumber(client, 'APPOINTMENT', input.warehouse_id, warehouseCode, actorUserId);

          const result = await client.query(
            `INSERT INTO wms.appointment (
              number, tenant_id, warehouse_id, window_config_id, direction, window_date, vehicle_type,
              asn_reference, order_reference, contains_hazmat, contains_perishable, origin, status, created_by
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [
              number,
              input.tenant_id,
              input.warehouse_id,
              input.window_config_id,
              input.direction,
              input.window_date,
              input.vehicle_type,
              input.asn_reference ?? null,
              input.order_reference ?? null,
              input.contains_hazmat ?? false,
              input.contains_perishable ?? false,
              origin,
              initialStatus,
              actorUserId,
            ]
          );
          const row = result.rows[0];

          await this.eventsService.publishInTransaction(client, {
            event_type: 'portaria.agendamento_criado',
            tenant_id: input.tenant_id,
            warehouse_id: input.warehouse_id,
            actor_user_id: actorUserId,
            payload: { appointment_id: row.id, number: row.number, direction: row.direction, origin },
          });

          return row;
        }
      );

      await this.auditService.record({
        tenantId: input.tenant_id,
        warehouseId: input.warehouse_id,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'appointment',
        entityId: appointment.id,
        action: 'CREATE',
        requirementId: 'DOC-03 RF-POR-001',
        after: appointment,
      });

      return appointment;
    } catch (error) {
      // RN-POR-002: capacidade esgotada — sugere as 5 próximas janelas com vaga.
      const pgError = error as { code?: string; message?: string };
      if (pgError?.code === '23514' && pgError.message?.includes('RN-POR-002')) {
        const suggestions = await this.findNextAvailableWindows(input.warehouse_id, input.direction, 5);
        throw new BadRequestException({
          error: 'WINDOW_FULL',
          detail: 'RN-POR-002: janela sem capacidade disponível — é proibido overbooking',
          suggested_windows: suggestions,
        });
      }
      mapPortariaDbError(error);
    }
  }

  /** RN-POR-002: as 5 próximas janelas (até 30 dias à frente) com vaga disponível. */
  async findNextAvailableWindows(warehouseId: string, direction: 'INBOUND' | 'OUTBOUND', limit = 5) {
    const result = await this.db.queryGlobal(
      `WITH candidate_dates AS (
         SELECT generate_series(CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', INTERVAL '1 day')::date AS d
       ),
       candidates AS (
         SELECT awc.id AS window_config_id, cd.d AS window_date, awc.start_time, awc.end_time, awc.capacity,
                COALESCE(o.occupied_count, 0) AS occupied_count
         FROM candidate_dates cd
         JOIN wms.appointment_window_config awc
           ON awc.warehouse_id = $1 AND awc.direction = $2 AND awc.status = 'ACTIVE'
           AND EXTRACT(DOW FROM cd.d)::int = awc.weekday
         LEFT JOIN wms.appointment_window_occupancy o
           ON o.window_config_id = awc.id AND o.window_date = cd.d
         WHERE (cd.d > CURRENT_DATE OR (cd.d = CURRENT_DATE AND awc.end_time > CURRENT_TIME))
       )
       SELECT window_config_id, window_date, start_time, end_time, capacity, occupied_count,
              (capacity - occupied_count) AS available
       FROM candidates
       WHERE capacity - occupied_count > 0
       ORDER BY window_date, start_time
       LIMIT $3`,
      [warehouseId, direction, limit]
    );
    return result.rows;
  }

  async findById(id: string, tenantId: string, actorUserId: string) {
    const result = await this.db.query({ tenant_id: tenantId, user_id: actorUserId }, 'SELECT * FROM wms.appointment WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new NotFoundException(`appointment ${id} not found`);
    return result.rows[0];
  }

  /**
   * RF-POR-003: cancelamento — criador OU POR.AGENDAMENTO_GERIR antes do
   * início da janela; apenas POR.AGENDAMENTO_GERIR após o início.
   */
  async cancel(id: string, tenantId: string, warehouseId: string, reason: string, actorUserId: string) {
    const before = await this.findById(id, tenantId, actorUserId);
    if (!['SCHEDULED', 'CONFIRMED_ARRIVAL'].includes(before.status)) {
      throw new BadRequestException({ error: 'APPOINTMENT_NOT_CANCELLABLE', detail: `RF-POR-003: status atual ${before.status} não permite cancelamento` });
    }
    await this.assertCancelAuthorization(before, actorUserId, warehouseId);

    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `UPDATE wms.appointment SET status = 'CANCELLED', cancel_reason = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
      [id, reason, actorUserId]
    );
    const after = result.rows[0];

    await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      await this.eventsService.publishInTransaction(client, {
        event_type: 'portaria.agendamento_cancelado',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { appointment_id: id, number: after.number, reason },
      });
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'appointment',
      entityId: id,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-03 RF-POR-003',
      reason,
      before,
      after,
    });

    return after;
  }

  /** RF-POR-003: remarcação = cancela o agendamento atual e cria um novo na janela destino (mesma autorização do cancelamento). */
  async reschedule(
    id: string,
    tenantId: string,
    warehouseId: string,
    newWindowConfigId: string,
    newWindowDate: string,
    reason: string,
    actorUserId: string
  ) {
    const original = await this.findById(id, tenantId, actorUserId);
    if (!['SCHEDULED', 'CONFIRMED_ARRIVAL'].includes(original.status)) {
      throw new BadRequestException({ error: 'APPOINTMENT_NOT_RESCHEDULABLE', detail: `RF-POR-003: status atual ${original.status} não permite remarcação` });
    }
    await this.assertCancelAuthorization(original, actorUserId, warehouseId);

    await this.cancel(id, tenantId, warehouseId, `RF-POR-003 remarcação: ${reason}`, actorUserId);

    return this.create(
      {
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        direction: original.direction,
        window_config_id: newWindowConfigId,
        window_date: newWindowDate,
        vehicle_type: original.vehicle_type,
        asn_reference: original.asn_reference,
        order_reference: original.order_reference,
        contains_hazmat: original.contains_hazmat,
        contains_perishable: original.contains_perishable,
      },
      actorUserId
    );
  }

  private async assertCancelAuthorization(appointment: { created_by: string; window_date: string }, actorUserId: string, warehouseId: string): Promise<void> {
    const isCreator = appointment.created_by === actorUserId;
    const canManage = await this.rbacService.hasPermission(actorUserId, 'POR.AGENDAMENTO_GERIR', { warehouseId });

    const windowStarted = new Date(appointment.window_date) <= new Date();
    if (windowStarted) {
      if (!canManage) {
        throw new ForbiddenException({ error: 'MANAGE_REQUIRED_AFTER_WINDOW_START', detail: 'RF-POR-003: após o início da janela, apenas POR.AGENDAMENTO_GERIR pode alterar' });
      }
      return;
    }

    if (!isCreator && !canManage) {
      throw new ForbiddenException({ error: 'NOT_CREATOR_OR_MANAGER', detail: 'RF-POR-003: apenas o criador ou POR.AGENDAMENTO_GERIR podem alterar este agendamento' });
    }
  }

  /**
   * RN-POR-004: scheduler expira agendamentos vencidos (janela + tolerância
   * sem gate-in) para NO_SHOW, cross-tenant via transactionAsWorker
   * (ADR-006, BYPASSRLS) — mesmo padrão de OperationalExceptionService.expireOverdue().
   */
  async expireNoShows(): Promise<{ noShowIds: string[] }> {
    const noShow: Array<{ id: string; tenant_id: string; warehouse_id: string; number: string }> = [];

    await this.db.transactionAsWorker(async (client) => {
      const toleranceResult = await client.query(`SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'POR.TOLERANCIA_ATRASO_MIN'`);
      const toleranceMin = Number(toleranceResult.rows[0]?.value ?? 60);

      const candidates = await client.query(
        `SELECT a.id, a.tenant_id, a.warehouse_id, a.number
         FROM wms.appointment a
         JOIN wms.appointment_window_config awc ON awc.id = a.window_config_id
         WHERE a.status = 'SCHEDULED'
           AND (a.window_date + awc.end_time + ($1 || ' minutes')::interval) < now()
         FOR UPDATE OF a SKIP LOCKED`,
        [toleranceMin]
      );

      for (const row of candidates.rows) {
        await client.query(`UPDATE wms.appointment SET status = 'NO_SHOW', updated_at = now() WHERE id = $1`, [row.id]);
        await this.eventsService.publishInTransaction(client, {
          event_type: 'portaria.agendamento_no_show',
          tenant_id: row.tenant_id,
          warehouse_id: row.warehouse_id,
          actor_user_id: SYSTEM_ACTOR,
          payload: { appointment_id: row.id, number: row.number },
        });
        noShow.push(row);
      }
    });

    for (const row of noShow) {
      await this.auditService.record({
        tenantId: row.tenant_id,
        warehouseId: row.warehouse_id,
        userId: SYSTEM_ACTOR,
        origin: 'SCHEDULER',
        entity: 'appointment',
        entityId: row.id,
        action: 'STATUS_CHANGE',
        requirementId: 'DOC-03 RN-POR-004',
        reason: 'NO_SHOW',
      });
    }

    return { noShowIds: noShow.map((r) => r.id) };
  }
}
