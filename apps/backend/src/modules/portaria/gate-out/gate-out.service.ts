// DOC-03 §4.5 — Gate-out de veículos. RN-POR-040 [INVIOLÁVEL] (pré-condições
// de saída), RF-POR-041 (conferência de lacres, acionamento de cancela).
import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { VehicleVisitService } from '../vehicle-visit/vehicle-visit.service.js';
import { VehicleVisitStatus } from '../vehicle-visit/vehicle-visit-state-machine.util.js';

export interface RequestGateOutInput {
  tenant_id: string;
  warehouse_id: string;
  checked_seal?: string; // RF-POR-041: lacre físico conferido pelo porteiro
}

@Injectable()
export class GateOutService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(VehicleVisitService) private readonly vehicleVisitService: VehicleVisitService
  ) {}

  /**
   * RN-POR-040 [INVIOLÁVEL]: valida as 3 pré-condições e, se todas
   * atendidas, conclui o gate-out (RF-POR-041). SE alguma falhar, bloqueia
   * listando as pendências exatas — nunca bloqueia parcialmente/silenciosamente.
   */
  async requestGateOut(visitId: string, input: RequestGateOutInput, actorUserId: string) {
    const visit = await this.vehicleVisitService.findById(visitId, input.tenant_id, actorUserId);
    const pendencies = await this.collectPendencies(visit, input.tenant_id, input.checked_seal);

    if (pendencies.length > 0) {
      // RF-POR-041: divergência de lacre abre exceção própria e bloqueia até decisão.
      if (pendencies.some((p) => p.code === 'SEAL_MISMATCH')) {
        await this.operationalExceptionService.create({
          tenantId: input.tenant_id,
          warehouseId: input.warehouse_id,
          exceptionType: 'POR.DIVERGENCIA_LACRE',
          entity: 'vehicle_visit',
          entityId: visitId,
          reasonRequest: `RF-POR-041: lacre registrado "${visit.seals_out?.[0] ?? ''}" divergente do lacre conferido "${input.checked_seal}"`,
          requestedBy: actorUserId,
        });
      }

      throw new BadRequestException({
        error: 'GATE_OUT_BLOCKED',
        detail: 'RN-POR-040: saída bloqueada — pendências listadas',
        pendencies,
      });
    }

    const updated = await this.db.transaction(
      { tenant_id: input.tenant_id, user_id: actorUserId, warehouse_id: input.warehouse_id },
      async (client) => this.completeGateOutWithClient(client, visit, input.tenant_id, input.warehouse_id, actorUserId)
    );

    await this.auditService.record({
      tenantId: input.tenant_id,
      warehouseId: input.warehouse_id,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'vehicle_visit',
      entityId: visitId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-03 RF-POR-041',
      before: visit,
      after: updated,
    });

    return updated;
  }

  /** RN-POR-040: força a saída com pendência — exige exceção POR.SAIDA_COM_PENDENCIA (2 aprovadores distintos, DOC-12). */
  async requestForcedGateOut(visitId: string, tenantId: string, warehouseId: string, reasonRequest: string, actorUserId: string) {
    return this.operationalExceptionService.create({
      tenantId,
      warehouseId,
      exceptionType: 'POR.SAIDA_COM_PENDENCIA',
      entity: 'vehicle_visit',
      entityId: visitId,
      reasonRequest,
      requestedBy: actorUserId,
    });
  }

  /** Conclui a saída forçada após a exceção POR.SAIDA_COM_PENDENCIA ser aprovada (2 passos). */
  async completeForcedGateOutAfterApproval(visitId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const visit = await this.vehicleVisitService.findById(visitId, tenantId, actorUserId);

    const exceptionResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.operational_exception WHERE entity = 'vehicle_visit' AND entity_id = $1 AND exception_type = 'POR.SAIDA_COM_PENDENCIA' ORDER BY created_at DESC LIMIT 1`,
      [visitId]
    );
    const exception = exceptionResult.rows[0];
    if (!exception || exception.status !== 'APPROVED') {
      throw new BadRequestException({ error: 'FORCED_EXIT_NOT_APPROVED', detail: 'RN-POR-040: POR.SAIDA_COM_PENDENCIA ainda não aprovada (2 passos)' });
    }

    const updated = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) =>
      this.completeGateOutWithClient(client, visit, tenantId, warehouseId, actorUserId)
    );

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'vehicle_visit',
      entityId: visitId,
      action: 'OVERRIDE',
      requirementId: 'DOC-03 RN-POR-040',
      before: visit,
      after: updated,
    });

    return updated;
  }

  private async collectPendencies(
    visit: { status: VehicleVisitStatus; direction: string; operation_flow_completed: boolean; seals_out: string[] | null; id: string; tenant_id: string },
    tenantId: string,
    checkedSeal: string | undefined
  ): Promise<Array<{ code: string; detail: string }>> {
    const pendencies: Array<{ code: string; detail: string }> = [];

    if (!['NO_PATIO', 'EM_DOCA', 'LIBERADO_SAIDA'].includes(visit.status)) {
      pendencies.push({ code: 'INVALID_STATE', detail: `RN-POR-040: visita em estado ${visit.status} não permite solicitar gate-out` });
      return pendencies;
    }

    // 1. Fluxo Operacional (RG-002) sem etapas pendentes.
    if (!visit.operation_flow_completed) {
      pendencies.push({
        code: 'OPERATION_FLOW_PENDING',
        detail: visit.direction === 'OUTBOUND' ? 'Carregamento pendente' : 'Descarga pendente',
      });
    }

    // 2. Lacres de saída (RF-POR-041), quando exigido pelo cliente.
    const requiresSealResult = await this.db.query(
      { tenant_id: tenantId, user_id: '00000000-0000-0000-0000-000000000001' },
      `SELECT value FROM wms.app_parameter WHERE scope = 'GLOBAL' AND name = 'POR.EXIGE_LACRE_SAIDA'`
    );
    const requiresSeal = requiresSealResult.rows[0]?.value === 'true';
    if (requiresSeal) {
      const expectedSeal = visit.seals_out?.[0];
      if (!checkedSeal) {
        pendencies.push({ code: 'SEAL_NOT_CHECKED', detail: 'RF-POR-041: conferência de lacre de saída é obrigatória' });
      } else if (expectedSeal && expectedSeal !== checkedSeal) {
        pendencies.push({ code: 'SEAL_MISMATCH', detail: `RF-POR-041: lacre conferido "${checkedSeal}" diverge do registrado "${expectedSeal}"` });
      }
    }

    // 3. Nenhuma exceção PENDING/ESCALATED vinculada.
    const blocking = await this.operationalExceptionService.isBlocking(tenantId, 'vehicle_visit', visit.id);
    if (blocking) {
      pendencies.push({ code: 'EXCEPTION_PENDING', detail: 'RN-POR-040: existe exceção PENDING/ESCALATED vinculada à visita' });
    }

    return pendencies;
  }

  private async completeGateOutWithClient(
    client: PoolClient,
    visit: { id: string; status: VehicleVisitStatus; yard_slot_id: string | null },
    tenantId: string,
    warehouseId: string,
    actorUserId: string
  ) {
    let currentStatus = visit.status;

    if (currentStatus === 'NO_PATIO') {
      await this.vehicleVisitService.transitionWithClient(client, visit.id, currentStatus, 'LIBERACAO_SEM_DOCA', {}, actorUserId);
      currentStatus = 'LIBERADO_SAIDA';
    } else if (currentStatus === 'EM_DOCA') {
      await this.vehicleVisitService.transitionWithClient(client, visit.id, currentStatus, 'OPERACAO_DOCA_CONCLUIDA', {}, actorUserId);
      currentStatus = 'LIBERADO_SAIDA';
    }

    if (visit.yard_slot_id) {
      await client.query(`UPDATE wms.yard_slot SET status = 'FREE', updated_at = now(), updated_by = $2 WHERE id = $1`, [visit.yard_slot_id, actorUserId]);
    }

    const updated = await this.vehicleVisitService.transitionWithClient(
      client,
      visit.id,
      currentStatus,
      'GATE_OUT',
      { gate_out_at: new Date() },
      actorUserId
    );

    await this.eventsService.publishInTransaction(client, {
      event_type: 'portaria.gate_out_concluido',
      tenant_id: tenantId,
      warehouse_id: warehouseId,
      actor_user_id: actorUserId,
      payload: { vehicle_visit_id: visit.id },
    });

    // RF-POR-014/041: mesmo mecanismo de cancela do gate-in.
    const edgeAgentResult = await client.query(`SELECT edge_agent_id FROM wms.edge_agent WHERE warehouse_id = $1 AND status = 'ONLINE' LIMIT 1`, [warehouseId]);
    if (edgeAgentResult.rows.length > 0) {
      await client.query(
        `INSERT INTO wms.edge_agent_job (edge_agent_id, tenant_id, warehouse_id, job_type, command)
         VALUES ($1,$2,$3,'CANCELA_ABRIR',$4)`,
        [edgeAgentResult.rows[0].edge_agent_id, tenantId, warehouseId, JSON.stringify({ acao: 'abrir', vehicle_visit_id: visit.id })]
      );
    }

    return updated;
  }
}
