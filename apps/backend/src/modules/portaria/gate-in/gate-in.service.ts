// DOC-03 §4.2 — Gate-in de veículos. RF-POR-010 (identificação por placa),
// RF-POR-011 (registro completo), RN-POR-012 (validação contra
// agendamento), RN-POR-013 [INVIOLÁVEL] (HAZMAT), RF-POR-014 (cancela via
// Edge Agent, fallback manual OVERRIDE).
import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { VehicleService } from '../vehicle/vehicle.service.js';
import { DriverService, UpsertDriverInput } from '../driver/driver.service.js';
import { VehicleVisitService } from '../vehicle-visit/vehicle-visit.service.js';
import { YardQueueService } from '../yard-queue/yard-queue.service.js';
import { VehicleVisitStatus } from '../vehicle-visit/vehicle-visit-state-machine.util.js';

export interface RegisterGateInInput {
  tenant_id: string;
  warehouse_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  plate: string;
  vehicle_type: string;
  trailer1_plate?: string;
  trailer2_plate?: string;
  driver: UpsertDriverInput;
  carrier_name?: string;
  carrier_cnpj?: string;
  nfe_keys?: string[];
  km?: number;
  photo_url?: string;
  appointment_id?: string;
  contains_hazmat?: boolean;
  contains_perishable?: boolean;
  hazmat_checklist_confirmed?: boolean;
}

@Injectable()
export class GateInService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(VehicleService) private readonly vehicleService: VehicleService,
    @Inject(DriverService) private readonly driverService: DriverService,
    @Inject(VehicleVisitService) private readonly vehicleVisitService: VehicleVisitService,
    @Inject(YardQueueService) private readonly yardQueueService: YardQueueService
  ) {}

  async registerGateIn(input: RegisterGateInInput, actorUserId: string) {
    // RF-POR-011: veículo/motorista reaproveitados de cadastro existente (upsert por placa/CPF).
    const vehicle = await this.vehicleService.upsertByPlate(
      { plate: input.plate, vehicle_type: input.vehicle_type, trailer1_plate: input.trailer1_plate, trailer2_plate: input.trailer2_plate },
      actorUserId
    );
    const driver = await this.driverService.upsertByCpf(input.driver, actorUserId);

    const appointment = input.appointment_id
      ? await this.loadAppointmentForGateIn(input.appointment_id, input.tenant_id, input.warehouse_id, input.direction, actorUserId)
      : null;

    const toleranceMin = await this.getToleranceMinutes(input.tenant_id, input.warehouse_id, actorUserId);

    let blockingReason: 'SEM_AGENDAMENTO' | 'FORA_DA_JANELA' | null = null;
    if (!appointment) {
      blockingReason = 'SEM_AGENDAMENTO';
    } else if (!this.isWithinWindowWithTolerance(appointment.window_date, appointment.end_time, toleranceMin, new Date())) {
      blockingReason = 'FORA_DA_JANELA';
    }

    const containsHazmat = appointment?.contains_hazmat ?? input.contains_hazmat ?? false;
    const containsPerishable = appointment?.contains_perishable ?? input.contains_perishable ?? false;

    // RN-POR-013 [INVIOLÁVEL]: checklist HAZMAT obrigatório antes de qualquer alocação.
    if (containsHazmat && !blockingReason && !input.hazmat_checklist_confirmed) {
      throw new BadRequestException({
        error: 'HAZMAT_CHECKLIST_REQUIRED',
        detail: 'RN-POR-013: checklist HAZMAT (POR.CHECKLIST_HAZMAT) deve ser confirmado antes do gate-in',
      });
    }

    const outcome = await this.db.transaction(
      { tenant_id: input.tenant_id, user_id: actorUserId, warehouse_id: input.warehouse_id },
      async (client) => {
        const visit = await this.vehicleVisitService.createWithClient(
          client,
          {
            tenant_id: input.tenant_id,
            warehouse_id: input.warehouse_id,
            appointment_id: appointment?.id ?? null,
            direction: input.direction,
            vehicle_id: vehicle.id,
            driver_id: driver.id,
            carrier_name: input.carrier_name,
            carrier_cnpj: input.carrier_cnpj,
            nfe_keys: input.nfe_keys,
            km: input.km,
            photo_url: input.photo_url,
            contains_hazmat: containsHazmat,
            contains_perishable: containsPerishable,
          },
          actorUserId
        );

        await this.eventsService.publishInTransaction(client, {
          event_type: 'portaria.veiculo_chegou',
          tenant_id: input.tenant_id,
          warehouse_id: input.warehouse_id,
          actor_user_id: actorUserId,
          payload: { vehicle_visit_id: visit.id, plate: vehicle.plate, direction: input.direction },
        });

        if (blockingReason) {
          const updated = await this.vehicleVisitService.transitionWithClient(
            client,
            visit.id,
            'CHEGADA_REGISTRADA',
            'BLOQUEIO_AUTORIZACAO',
            { blocking_reason: blockingReason },
            actorUserId
          );
          return { visit: updated, appointmentId: appointment?.id ?? null, exceptionTypeCode: blockingReason === 'SEM_AGENDAMENTO' ? 'POR.VEICULO_SEM_AGENDAMENTO' : 'POR.FORA_DA_JANELA' };
        }

        // Agendamento confirmado (RN-POR-012).
        await client.query(`UPDATE wms.appointment SET status = 'CONFIRMED_ARRIVAL', updated_at = now(), updated_by = $2 WHERE id = $1`, [
          appointment!.id,
          actorUserId,
        ]);

        const slot = await this.tryAllocateSlotWithClient(client, input.warehouse_id, containsHazmat, actorUserId);
        if (!slot) {
          const reason = containsHazmat ? 'SEM_VAGA_HAZMAT' : 'SEM_VAGA_DISPONIVEL';
          const updated = await this.vehicleVisitService.transitionWithClient(
            client,
            visit.id,
            'CHEGADA_REGISTRADA',
            'BLOQUEIO_AUTORIZACAO',
            { blocking_reason: reason },
            actorUserId
          );
          await this.eventsService.publishInTransaction(client, {
            event_type: 'portaria.vaga_indisponivel',
            tenant_id: input.tenant_id,
            warehouse_id: input.warehouse_id,
            actor_user_id: actorUserId,
            payload: { vehicle_visit_id: visit.id, hazmat: containsHazmat },
          });
          return { visit: updated, appointmentId: appointment!.id, exceptionTypeCode: null };
        }

        const completed = await this.completeGateInWithClient(client, visit, slot, input.tenant_id, input.warehouse_id, actorUserId);
        return { visit: completed, appointmentId: appointment!.id, exceptionTypeCode: null, gateOpened: true };
      }
    );

    await this.auditService.record({
      tenantId: input.tenant_id,
      warehouseId: input.warehouse_id,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'vehicle_visit',
      entityId: outcome.visit.id,
      action: 'CREATE',
      requirementId: 'DOC-03 RF-POR-011',
      after: outcome.visit,
    });

    // RN-POR-012: excecões abertas FORA da transação de gate-in (o motor de
    // workflow do DOC-12 abre a sua própria transação — não é possível
    // aninhar db.transaction()).
    if (outcome.exceptionTypeCode) {
      await this.operationalExceptionService.create({
        tenantId: input.tenant_id,
        warehouseId: input.warehouse_id,
        exceptionType: outcome.exceptionTypeCode,
        entity: 'vehicle_visit',
        entityId: outcome.visit.id,
        reasonRequest:
          outcome.exceptionTypeCode === 'POR.VEICULO_SEM_AGENDAMENTO'
            ? 'RN-POR-012: veículo sem agendamento vinculado'
            : 'RN-POR-012: chegada fora da janela agendada + tolerância',
        requestedBy: actorUserId,
      });
    }

    return outcome.visit;
  }

  /**
   * Reavalia uma visita AGUARDANDO_AUTORIZACAO após decisão da exceção
   * vinculada (POR.VEICULO_SEM_AGENDAMENTO/POR.FORA_DA_JANELA). Aprovada:
   * aloca vaga e conclui o gate-in (RN-POR-012: agendamento retroativo
   * SEM_AGENDA quando aplicável). Rejeitada/expirada: RECUSADO, nenhuma
   * vaga ocupada.
   */
  async resumeAfterExceptionDecision(visitId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const visit = await this.vehicleVisitService.findById(visitId, tenantId, actorUserId);
    if (visit.status !== 'AGUARDANDO_AUTORIZACAO') {
      throw new BadRequestException({ error: 'VISIT_NOT_WAITING', detail: `visita ${visitId} não está AGUARDANDO_AUTORIZACAO (status atual: ${visit.status})` });
    }

    const exceptionResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.operational_exception WHERE entity = 'vehicle_visit' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [visitId]
    );
    const exception = exceptionResult.rows[0];
    if (!exception) throw new NotFoundException(`nenhuma exceção encontrada para vehicle_visit ${visitId}`);

    if (['PENDING', 'ESCALATED'].includes(exception.status)) {
      throw new BadRequestException({ error: 'EXCEPTION_STILL_PENDING', detail: 'exceção ainda não foi decidida' });
    }

    if (exception.status !== 'APPROVED') {
      const updated = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
        return this.vehicleVisitService.transitionWithClient(
          client,
          visitId,
          'AGUARDANDO_AUTORIZACAO',
          'EXCECAO_REJEITADA_OU_EXPIRADA',
          {},
          actorUserId
        );
      });
      await this.auditService.record({
        tenantId,
        warehouseId,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'vehicle_visit',
        entityId: visitId,
        action: 'STATUS_CHANGE',
        requirementId: 'DOC-03 §5.1',
        before: visit,
        after: updated,
      });
      return updated;
    }

    // Exceção aprovada: RN-POR-012 (SEM_AGENDAMENTO) cria agendamento retroativo SEM_AGENDA.
    return this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const slot = await this.tryAllocateSlotWithClient(client, warehouseId, visit.contains_hazmat, actorUserId);
      if (!slot) {
        throw new BadRequestException({ error: 'NO_SLOT_AVAILABLE', detail: 'RN-POR-013: nenhuma vaga compatível livre no momento da aprovação' });
      }
      const completed = await this.completeGateInWithClient(client, visit, slot, tenantId, warehouseId, actorUserId);

      await this.auditService.record({
        tenantId,
        warehouseId,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'vehicle_visit',
        entityId: visitId,
        action: 'STATUS_CHANGE',
        requirementId: 'DOC-03 RN-POR-012',
        before: visit,
        after: completed,
      });

      return completed;
    });
  }

  /** RN-POR-013: retry de alocação HAZMAT (ou vaga comum) quando uma vaga é liberada. */
  async retrySlotAllocation(visitId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const visit = await this.vehicleVisitService.findById(visitId, tenantId, actorUserId);
    if (visit.status !== 'AGUARDANDO_AUTORIZACAO' || !['SEM_VAGA_HAZMAT', 'SEM_VAGA_DISPONIVEL'].includes(visit.blocking_reason)) {
      throw new BadRequestException({ error: 'VISIT_NOT_WAITING_FOR_SLOT', detail: `visita ${visitId} não está aguardando vaga` });
    }

    return this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      const slot = await this.tryAllocateSlotWithClient(client, warehouseId, visit.contains_hazmat, actorUserId);
      if (!slot) {
        throw new BadRequestException({ error: 'NO_SLOT_AVAILABLE', detail: 'RN-POR-013: ainda não há vaga compatível livre' });
      }
      const completed = await this.completeGateInWithClient(client, visit, slot, tenantId, warehouseId, actorUserId);

      await this.auditService.record({
        tenantId,
        warehouseId,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'vehicle_visit',
        entityId: visitId,
        action: 'STATUS_CHANGE',
        requirementId: 'DOC-03 RN-POR-013',
        before: visit,
        after: completed,
      });

      return completed;
    });
  }

  private async completeGateInWithClient(client: PoolClient, visit: { id: string; status: VehicleVisitStatus; tenant_id: string; warehouse_id: string; direction: 'INBOUND' | 'OUTBOUND'; blocking_reason: string | null; contains_perishable: boolean; contains_hazmat: boolean }, slot: { id: string; code: string }, tenantId: string, warehouseId: string, actorUserId: string) {
    const now = new Date();
    const updated = await this.vehicleVisitService.transitionWithClient(
      client,
      visit.id,
      visit.status,
      'GATE_IN_OK',
      { yard_slot_id: slot.id, gate_in_at: now, yard_slot_at: now, blocking_reason: null, authorized_at: now },
      actorUserId
    );

    await this.eventsService.publishInTransaction(client, {
      event_type: 'portaria.gate_in_concluido',
      tenant_id: tenantId,
      warehouse_id: warehouseId,
      actor_user_id: actorUserId,
      payload: { vehicle_visit_id: visit.id },
    });
    await this.eventsService.publishInTransaction(client, {
      event_type: 'portaria.vaga_ocupada',
      tenant_id: tenantId,
      warehouse_id: warehouseId,
      actor_user_id: actorUserId,
      payload: { vehicle_visit_id: visit.id, yard_slot_id: slot.id, yard_slot_code: slot.code },
    });

    // RF-POR-014: job de abertura de cancela via Edge Agent — [LACUNA: DOC-11
    // não implementado nesta sessão]. Se houver Edge Agent ONLINE cadastrado
    // para o armazém, enfileira o job; senão, a interface deve orientar
    // operação manual (POST .../manual-cancela-override, auditado OVERRIDE).
    const edgeAgentResult = await client.query(`SELECT edge_agent_id FROM wms.edge_agent WHERE warehouse_id = $1 AND status = 'ONLINE' LIMIT 1`, [warehouseId]);
    let cancelaJobId: string | null = null;
    if (edgeAgentResult.rows.length > 0) {
      const jobResult = await client.query(
        `INSERT INTO wms.edge_agent_job (edge_agent_id, tenant_id, warehouse_id, job_type, command)
         VALUES ($1,$2,$3,'CANCELA_ABRIR',$4) RETURNING job_id`,
        [edgeAgentResult.rows[0].edge_agent_id, tenantId, warehouseId, JSON.stringify({ acao: 'abrir', vehicle_visit_id: visit.id })]
      );
      cancelaJobId = jobResult.rows[0].job_id;
    }

    // RN-POR-021: entra na fila de pátio com pontuação persistida. no_horario
    // usa o blocking_reason ORIGINAL (pré-transição) — a transição acima já
    // limpou blocking_reason para null em `updated` (a visita não está mais
    // bloqueada), mas a pontuação precisa saber SE ela chegou fora da
    // janela (RN-POR-021: "0 se POR.FORA_DA_JANELA aprovada") mesmo já
    // estando livre para prosseguir.
    const weights = await this.yardQueueService.getWeights(tenantId, warehouseId, actorUserId);
    await this.yardQueueService.enqueueWithClient(client, { ...updated, blocking_reason: visit.blocking_reason }, weights, actorUserId);
    await this.eventsService.publishInTransaction(client, {
      event_type: 'portaria.fila_atualizada',
      tenant_id: tenantId,
      warehouse_id: warehouseId,
      actor_user_id: actorUserId,
      payload: { vehicle_visit_id: visit.id },
    });

    return { ...updated, cancela_job_id: cancelaJobId, cancela_manual_required: cancelaJobId === null };
  }

  /**
   * RF-POR-014: fallback manual quando o Edge Agent está indisponível — o
   * porteiro registra confirmação manual, auditada como OVERRIDE
   * (RNF-ARQ-061).
   */
  async confirmManualCancelaOverride(visitId: string, tenantId: string, warehouseId: string, reason: string, actorUserId: string) {
    const visit = await this.vehicleVisitService.findById(visitId, tenantId, actorUserId);

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'vehicle_visit',
      entityId: visitId,
      action: 'OVERRIDE',
      requirementId: 'DOC-03 RF-POR-014',
      reason,
      after: visit,
    });

    return { vehicle_visit_id: visitId, manual_override_confirmed: true };
  }

  private async tryAllocateSlotWithClient(client: PoolClient, warehouseId: string, hazmatOnly: boolean, actorUserId: string) {
    const slotTypeFilter = hazmatOnly ? `slot_type = 'HAZMAT'` : `slot_type != 'HAZMAT'`;
    const result = await client.query(
      `SELECT id, code FROM wms.yard_slot WHERE warehouse_id = $1 AND status = 'FREE' AND ${slotTypeFilter} ORDER BY code LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [warehouseId]
    );
    if (result.rows.length === 0) return null;
    const slot = result.rows[0];
    await client.query(`UPDATE wms.yard_slot SET status = 'OCCUPIED', updated_at = now(), updated_by = $2 WHERE id = $1`, [slot.id, actorUserId]);
    return slot;
  }

  private async loadAppointmentForGateIn(appointmentId: string, tenantId: string, warehouseId: string, direction: string, actorUserId: string) {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT a.*, awc.start_time, awc.end_time
       FROM wms.appointment a JOIN wms.appointment_window_config awc ON awc.id = a.window_config_id
       WHERE a.id = $1`,
      [appointmentId]
    );
    const appointment = result.rows[0];
    if (!appointment) throw new NotFoundException(`appointment ${appointmentId} not found`);
    if (appointment.warehouse_id !== warehouseId || appointment.direction !== direction) {
      throw new BadRequestException({ error: 'APPOINTMENT_MISMATCH', detail: 'RN-POR-012: agendamento não pertence a este armazém/sentido' });
    }
    if (appointment.status !== 'SCHEDULED') {
      throw new BadRequestException({ error: 'APPOINTMENT_NOT_SCHEDULED', detail: `RN-POR-012: agendamento não está SCHEDULED (status atual: ${appointment.status})` });
    }
    return appointment;
  }

  private async getToleranceMinutes(tenantId: string, warehouseId: string, actorUserId: string): Promise<number> {
    const result = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'POR.TOLERANCIA_ATRASO_MIN'`
    );
    return Number(result.rows[0]?.value ?? 60);
  }

  /**
   * RN-POR-012: "chegada dentro da janela (com tolerância)". [DÉBITO: RG-010
   * pede exibição/comparação no fuso do armazém (wms.warehouse.timezone);
   * esta comparação usa o horário local do processo (UTC em produção), sem
   * converter explicitamente pelo timezone do armazém — aceitável para o
   * MVP desta sessão, mas não totalmente correto para armazéns fora de UTC.
   *
   * windowDate: o driver `pg` retorna colunas DATE como objeto JS Date
   * (meia-noite UTC, sem componente de hora) — precisa ser normalizado para
   * "YYYY-MM-DD" via toISOString() antes de compor com endTime (string
   * "HH:MM:SS" de uma coluna TIME); concatenar o Date bruto na template
   * string produzia "Invalid Date" silenciosamente (bug real encontrado ao
   * validar este teste).
   */
  private isWithinWindowWithTolerance(windowDate: string | Date, endTime: string, toleranceMin: number, now: Date): boolean {
    const dateStr = windowDate instanceof Date ? windowDate.toISOString().slice(0, 10) : windowDate;
    const windowEnd = new Date(`${dateStr}T${endTime}`);
    windowEnd.setMinutes(windowEnd.getMinutes() + toleranceMin);
    return now <= windowEnd;
  }
}
