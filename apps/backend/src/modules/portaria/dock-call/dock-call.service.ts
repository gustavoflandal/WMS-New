// DOC-03 §4.3 — RF-POR-022: chamada para doca. Sugestão automática do
// primeiro da fila, confirmação HUMANA obrigatória — não existe chamada
// automática sem confirmação.
import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { VehicleVisitService } from '../vehicle-visit/vehicle-visit.service.js';
import { YardQueueService } from '../yard-queue/yard-queue.service.js';

@Injectable()
export class DockCallService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(VehicleVisitService) private readonly vehicleVisitService: VehicleVisitService,
    @Inject(YardQueueService) private readonly yardQueueService: YardQueueService
  ) {}

  /** RF-POR-022: sugestão automática — primeiro da fila (score DESC, chegada mais antiga). Não confirma nada. */
  async suggestNext(warehouseId: string, direction: 'INBOUND' | 'OUTBOUND') {
    const queue = await this.yardQueueService.listQueue(warehouseId, direction);
    return queue[0] ?? null;
  }

  /**
   * RF-POR-022: confirmação HUMANA da chamada. doca deve estar FREE
   * (DOC-04). Reserva a doca (RESERVED), NO_PATIO -> EM_DESLOCAMENTO_DOCA.
   */
  async confirmCall(queueEntryId: string, dockId: string, warehouseId: string, actorUserId: string) {
    // A fila é cross-tenant (mesma limitação documentada em YardQueueService.listQueue) —
    // localizar o tenant_id real da entrada antes de abrir a transação com o contexto certo.
    const entryLookup = await this.db.transactionAsWorker(async (client) => {
      const result = await client.query('SELECT * FROM wms.yard_queue_entry WHERE id = $1', [queueEntryId]);
      if (result.rows.length === 0) throw new NotFoundException(`yard_queue_entry ${queueEntryId} not found`);
      return result.rows[0];
    });

    if (entryLookup.status !== 'WAITING') {
      throw new BadRequestException({ error: 'ENTRY_NOT_WAITING', detail: `RF-POR-022: entrada ${queueEntryId} não está WAITING (status atual: ${entryLookup.status})` });
    }

    const dockResult = await this.db.queryGlobal('SELECT * FROM wms.dock WHERE id = $1 AND warehouse_id = $2', [dockId, warehouseId]);
    const dock = dockResult.rows[0];
    if (!dock) throw new NotFoundException(`dock ${dockId} not found in warehouse ${warehouseId}`);
    if (dock.status !== 'FREE') {
      throw new BadRequestException({ error: 'DOCK_NOT_FREE', detail: `RF-POR-022: doca ${dock.code} não está FREE (status atual: ${dock.status})` });
    }

    const visit = await this.vehicleVisitService.findById(entryLookup.vehicle_visit_id, entryLookup.tenant_id, actorUserId);
    if (visit.status !== 'NO_PATIO') {
      throw new BadRequestException({ error: 'VISIT_NOT_ON_YARD', detail: `RF-POR-022: visita ${visit.id} não está NO_PATIO (status atual: ${visit.status})` });
    }

    const updated = await this.db.transaction({ tenant_id: entryLookup.tenant_id, user_id: actorUserId, warehouse_id: warehouseId }, async (client) => {
      await client.query(`UPDATE wms.dock SET status = 'RESERVED', updated_at = now(), updated_by = $2 WHERE id = $1`, [dockId, actorUserId]);

      const updatedVisit = await this.vehicleVisitService.transitionWithClient(
        client,
        visit.id,
        'NO_PATIO',
        'CHAMADA_CONFIRMADA',
        { dock_id: dockId, dock_call_at: new Date() },
        actorUserId
      );

      await this.yardQueueService.markCalledWithClient(client, queueEntryId, actorUserId);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'portaria.chamada_doca',
        tenant_id: entryLookup.tenant_id,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { vehicle_visit_id: visit.id, dock_id: dockId, dock_code: dock.code },
      });

      return updatedVisit;
    });

    await this.auditService.record({
      tenantId: entryLookup.tenant_id,
      warehouseId,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'vehicle_visit',
      entityId: visit.id,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-03 RF-POR-022',
      before: visit,
      after: updated,
    });

    return updated;
  }
}
