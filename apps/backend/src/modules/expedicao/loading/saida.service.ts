// DOC-06 §4.7 RF-EXP-062 — Saída e Fim.
//
// "Saída conclui pelo gate-out do DOC-03 (RN-POR-040) — integre os dois
// módulos." INTEGRAÇÃO ESCOLHIDA: leitura direta de `wms.vehicle_visit`
// (tabela do DOC-03, sem RLS restritiva adicional além do tenant já
// aplicado) em vez de injetar GateOutService/PortariaModule aqui — mesmo
// espírito de "reinstanciar serviço stateless" já usado em ExpedicaoModule
// (DocumentNumberingService, StockMovementService), mas mais simples ainda:
// não precisamos de NENHUM efeito do DOC-03, só CONFIRMAR que o gate-out (RN-
// POR-040) já aconteceu. Evita qualquer acoplamento de DI entre os módulos
// portaria/expedicao (que exigiria um hook cruzando duas árvores de módulo
// irmãs) e ZERO risco de regressão no código já testado do DOC-03.
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { OutboundFlowService } from '../order/outbound-flow.service.js';

@Injectable()
export class SaidaService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(OutboundFlowService) private readonly outboundFlowService: OutboundFlowService
  ) {}

  /**
   * RF-EXP-062 — conclui Saída (gate-out RN-POR-040 já confirmado no DOC-03)
   * e, automaticamente, Fim: pedido `COMPLETED`, evento `pedido_concluido`.
   */
  async completeExit(orderId: string, tenantId: string, warehouseId: string, actorUserId: string) {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };

    const orderResult = await this.db.query(ctx, `SELECT * FROM wms.outbound_order WHERE id = $1`, [orderId]);
    const order = orderResult.rows[0];
    if (!order) throw new NotFoundException(`outbound_order ${orderId} not found`);
    if (order.status !== 'LOADED') {
      throw new ConflictException({ error: 'ORDER_NOT_LOADED', detail: `RF-EXP-062: pedido ${orderId} não está LOADED (status atual: ${order.status})` });
    }

    const loadingResult = await this.db.query(
      ctx,
      `SELECT l.vehicle_visit_id FROM wms.loading_order lo JOIN wms.loading l ON l.id = lo.loading_id WHERE lo.outbound_order_id = $1 ORDER BY lo.created_at DESC LIMIT 1`,
      [orderId]
    );
    const vehicleVisitId = loadingResult.rows[0]?.vehicle_visit_id;
    if (!vehicleVisitId) {
      throw new BadRequestException({ error: 'NO_VEHICLE_VISIT', detail: 'RF-EXP-062: pedido sem carga vinculada a uma visita de veículo (DOC-03)' });
    }

    // RN-POR-040: o gate-out em si é do DOC-03 — aqui só se CONFIRMA que já
    // aconteceu (leitura direta, sem reexecutar nenhuma regra do DOC-03).
    // vehicle-visit-state-machine.util.ts: o EVENTO é 'GATE_OUT', mas o
    // ESTADO resultante da transição 'LIBERADO_SAIDA:GATE_OUT' é 'ENCERRADA'
    // — checado pelo nome do estado, não do evento.
    const visitResult = await this.db.query(ctx, `SELECT status FROM wms.vehicle_visit WHERE id = $1`, [vehicleVisitId]);
    const visit = visitResult.rows[0];
    if (!visit || visit.status !== 'ENCERRADA') {
      throw new ConflictException({
        error: 'GATE_OUT_PENDING',
        detail: `RN-POR-040: a visita do veículo (${vehicleVisitId}) ainda não concluiu o gate-out (status atual: ${visit?.status ?? 'desconhecido'})`,
      });
    }

    const result = await this.db.transaction(ctx, async (client) => {
      const saida = await this.outboundFlowService.completeOrderStep(client, { tenantId, warehouseId, orderId, step: 'SAIDA' }, actorUserId);
      // RF-EXP-062: "Fim é automático" — na MESMA chamada, sem passo manual extra.
      const fim = await this.outboundFlowService.completeOrderStep(client, { tenantId, warehouseId, orderId, step: 'FIM' }, actorUserId);

      await this.eventsService.publishInTransaction(client, {
        event_type: 'expedicao.pedido_concluido',
        tenant_id: tenantId,
        warehouse_id: warehouseId,
        actor_user_id: actorUserId,
        payload: { outbound_order_id: orderId, number: order.number, vehicle_visit_id: vehicleVisitId },
      });

      return { saida, fim };
    });

    await this.auditService.record({
      tenantId,
      warehouseId,
      userId: actorUserId,
      origin: 'API',
      entity: 'outbound_order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      requirementId: 'DOC-06 RF-EXP-062',
      before: order,
      after: result.fim.order,
    });

    return result;
  }
}
