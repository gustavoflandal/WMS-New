// DOC-04 §4.1 — Docas. RN-REC-001: FREE->RESERVED já é feito pelo DOC-03
// (DockCallService.confirmCall, RF-POR-022) — este service cobre o restante
// da máquina de estados: RESERVED->OCCUPIED (atracação, RF-REC-002) e
// OCCUPIED->FREE (liberação, RF-REC-043/REC.LIBERAR_DOCA). "É PROIBIDO
// atracar em doca não reservada para a visita" (RN-REC-001) — validado
// comparando vehicle_visit.dock_id (setado pelo DOC-03 na chamada) com o
// dockId informado aqui.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OperationalExceptionService } from '../../../core/workflow/operational-exception.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { mapRecebimentoDbError } from '../shared/db-error.util.js';

@Injectable()
export class DockService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OperationalExceptionService) private readonly operationalExceptionService: OperationalExceptionService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService
  ) {}

  /**
   * RF-REC-002: atracação. Doca precisa estar RESERVED especificamente para
   * a visita da ordem (RN-REC-001); valida compatibilidade doca x sentido x
   * tipo de veículo (DOC-02); confere lacres de entrada quando informados —
   * divergência abre POR.DIVERGENCIA_LACRE (DOC-03, mesmo exception_type já
   * usado no gate-out, aqui reaproveitado para o check na doca).
   */
  async dockVehicle(inboundOrderId: string, tenantId: string, warehouseId: string, checkedSealIn: string | null, actorUserId: string) {
    const orderResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.inbound_order WHERE id = $1`,
      [inboundOrderId]
    );
    if (orderResult.rows.length === 0) throw new NotFoundException(`inbound_order ${inboundOrderId} not found`);
    const order = orderResult.rows[0];
    if (order.status !== 'CREATED') {
      throw new BadRequestException({ error: 'ORDER_NOT_CREATED', detail: `RF-REC-002: ordem ${order.number} não está CREATED (status atual: ${order.status})` });
    }
    if (!order.vehicle_visit_id) {
      throw new BadRequestException({ error: 'NO_VEHICLE_VISIT', detail: 'RF-REC-002: ordem sem visita de veículo vinculada (DOC-03)' });
    }

    const visitResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId },
      `SELECT * FROM wms.vehicle_visit WHERE id = $1`,
      [order.vehicle_visit_id]
    );
    if (visitResult.rows.length === 0) throw new NotFoundException(`vehicle_visit ${order.vehicle_visit_id} not found`);
    const visit = visitResult.rows[0];

    // RN-REC-001: "É PROIBIDO atracar em doca não reservada para a visita" —
    // a doca reservada é a que já está setada em vehicle_visit.dock_id pela
    // chamada do DOC-03 (DockCallService.confirmCall).
    if (!visit.dock_id) {
      throw new BadRequestException({ error: 'NO_DOCK_RESERVED', detail: 'RN-REC-001: nenhuma doca reservada para esta visita (chamada de doca do DOC-03 ainda não confirmada)' });
    }
    const dockId = visit.dock_id;

    const dockResult = await this.db.queryGlobal('SELECT * FROM wms.dock WHERE id = $1 AND warehouse_id = $2', [dockId, warehouseId]);
    const dock = dockResult.rows[0];
    if (!dock) throw new NotFoundException(`dock ${dockId} not found`);
    if (dock.status !== 'RESERVED') {
      throw new BadRequestException({ error: 'DOCK_NOT_RESERVED', detail: `RN-REC-001: doca ${dock.code} não está RESERVED (status atual: ${dock.status})` });
    }

    // Compatibilidade doca x sentido x tipo de veículo (DOC-02).
    if (dock.dock_type !== 'BOTH' && dock.dock_type !== 'INBOUND') {
      throw new BadRequestException({ error: 'DOCK_DIRECTION_INCOMPATIBLE', detail: `RF-REC-002: doca ${dock.code} não aceita sentido INBOUND (dock_type=${dock.dock_type})` });
    }
    const vehicleResult = await this.db.queryGlobal('SELECT * FROM wms.vehicle WHERE id = $1', [visit.vehicle_id]);
    const vehicle = vehicleResult.rows[0];
    if (dock.allowed_vehicle_types && dock.allowed_vehicle_types.length > 0 && vehicle && !dock.allowed_vehicle_types.includes(vehicle.vehicle_type)) {
      throw new BadRequestException({
        error: 'DOCK_VEHICLE_TYPE_INCOMPATIBLE',
        detail: `RF-REC-002: doca ${dock.code} não aceita tipo de veículo "${vehicle.vehicle_type}"`,
      });
    }

    // RF-REC-002: conferência de lacres de entrada (checkedSealIn opcional —
    // só há divergência a checar se o gate-in registrou algum lacre).
    let sealException: any = null;
    if (checkedSealIn && visit.seals_in?.length > 0 && !visit.seals_in.includes(checkedSealIn)) {
      sealException = await this.operationalExceptionService.create({
        tenantId,
        warehouseId,
        exceptionType: 'POR.DIVERGENCIA_LACRE',
        entity: 'vehicle_visit',
        entityId: visit.id,
        reasonRequest: `RF-REC-002: lacre conferido na doca ("${checkedSealIn}") não confere com lacre(s) de entrada registrados no gate-in (${visit.seals_in.join(', ')})`,
        requestedBy: actorUserId,
      });
    }

    try {
      const result = await this.db.transaction({ tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
        await client.query(`UPDATE wms.dock SET status = 'OCCUPIED', updated_at = now(), updated_by = $2 WHERE id = $1`, [dockId, actorUserId]);
        // DOC-10 K-02/K-03 (RN-PAI-041): dock_at existe desde a migration
        // 0028 ("timestamps de marco para KPIs de permanência") mas nunca
        // era escrito por nenhum serviço — populado aqui, mesmo achado/
        // padrão de flow_step.started_at (Sessão 7).
        await client.query(`UPDATE wms.vehicle_visit SET status = 'EM_DOCA', dock_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1`, [visit.id, actorUserId]);

        const updatedOrder = await client.query(
          `UPDATE wms.inbound_order SET status = 'AT_DOCK', dock_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
          [inboundOrderId, dockId, actorUserId]
        );

        const { flow } = await this.operationFlowService.getFlowByEntity(tenantId, actorUserId, 'inbound_order', inboundOrderId).then(
          (f) => f,
          () => ({ flow: null })
        );
        if (flow) {
          await this.operationFlowService.completeStep(client, flow.id, 'DOCA', actorUserId);
        }

        await this.eventsService.publishInTransaction(client, {
          event_type: 'recebimento.atracado',
          tenant_id: tenantId,
          warehouse_id: warehouseId,
          actor_user_id: actorUserId,
          payload: { inbound_order_id: inboundOrderId, dock_id: dockId, dock_code: dock.code, seal_discrepancy: !!sealException },
        });

        return updatedOrder.rows[0];
      });

      await this.auditService.record({
        tenantId,
        warehouseId,
        userId: actorUserId,
        origin: 'WEB',
        entity: 'inbound_order',
        entityId: inboundOrderId,
        action: 'STATUS_CHANGE',
        requirementId: 'DOC-04 RF-REC-002',
        before: order,
        after: result,
      });

      return { order: result, sealException };
    } catch (error) {
      mapRecebimentoDbError(error);
    }
  }

  /** RF-REC-043: liberação de doca ao fim da operação (manual ou automática na saída do veículo). */
  async releaseDock(dockId: string, warehouseId: string, actorUserId: string) {
    const dockResult = await this.db.queryGlobal('SELECT * FROM wms.dock WHERE id = $1 AND warehouse_id = $2', [dockId, warehouseId]);
    const dock = dockResult.rows[0];
    if (!dock) throw new NotFoundException(`dock ${dockId} not found`);
    if (dock.status !== 'OCCUPIED') {
      throw new BadRequestException({ error: 'DOCK_NOT_OCCUPIED', detail: `RF-REC-043: doca ${dock.code} não está OCCUPIED (status atual: ${dock.status})` });
    }

    await this.db.queryGlobal(`UPDATE wms.dock SET status = 'FREE', updated_at = now(), updated_by = $2 WHERE id = $1`, [dockId, actorUserId]);

    await this.auditService.record({
      tenantId: null,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'dock',
      entityId: dockId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-04 RF-REC-043',
      before: dock,
      after: { ...dock, status: 'FREE' },
    });

    return { ...dock, status: 'FREE' };
  }

  /**
   * RF-REC-003: sugestão de doca para a chamada (RF-POR-022). Ordem:
   * sentido compatível, tipo de veículo, menor distância média até as
   * zonas preferenciais dos produtos do ASN (REC.MAPA_DISTANCIA_DOCA_ZONA).
   * Empate: menor código de doca.
   */
  async suggestDock(warehouseId: string, direction: 'INBOUND' | 'OUTBOUND', vehicleType: string, preferredZoneIds: string[]) {
    const docksResult = await this.db.queryGlobal(
      `SELECT * FROM wms.dock
       WHERE warehouse_id = $1 AND status = 'FREE'
         AND (dock_type = 'BOTH' OR dock_type = $2)
         AND (allowed_vehicle_types IS NULL OR array_length(allowed_vehicle_types, 1) IS NULL OR $3 = ANY(allowed_vehicle_types))
       ORDER BY code ASC`,
      [warehouseId, direction, vehicleType]
    );
    const candidates = docksResult.rows;
    if (candidates.length === 0) return null;

    if (preferredZoneIds.length === 0) {
      return candidates[0];
    }

    const distancesResult = await this.db.queryGlobal(
      `SELECT dock_id, AVG(distance_m) AS avg_distance
       FROM wms.dock_zone_distance
       WHERE warehouse_id = $1 AND zone_id = ANY($2) AND dock_id = ANY($3)
       GROUP BY dock_id`,
      [warehouseId, preferredZoneIds, candidates.map((c: any) => c.id)]
    );
    const distanceByDock = new Map(distancesResult.rows.map((r: any) => [r.dock_id, Number(r.avg_distance)]));

    const ranked = [...candidates].sort((a: any, b: any) => {
      const distA = distanceByDock.has(a.id) ? (distanceByDock.get(a.id) as number) : Number.POSITIVE_INFINITY;
      const distB = distanceByDock.has(b.id) ? (distanceByDock.get(b.id) as number) : Number.POSITIVE_INFINITY;
      if (distA !== distB) return distA - distB;
      return a.code.localeCompare(b.code);
    });

    return ranked[0];
  }
}
