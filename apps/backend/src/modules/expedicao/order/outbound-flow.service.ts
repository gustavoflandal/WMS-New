// DOC-06 §4.2 — Fluxo Operacional do pedido (RG-002). É O CORAÇÃO DO SISTEMA:
// o requisito que originou o projeto (fluxo verde/vermelho sem salto).
//
// Este serviço é a camada de EXPEDIÇÃO sobre o Fluxo Operacional genérico
// (core/operation-flow, criado na Sessão 4A e CONSOLIDADO aqui — não há uma
// segunda estrutura). Divisão de responsabilidade:
//   - core/OperationFlowService: as regras GENÉRICAS de RG-002 — ordem das
//     etapas (FLOW_STEP_ORDER_VIOLATION), bloqueio por exceção pendente e o
//     contrato de leitura. Valem para DOC-04, DOC-06 e DOC-07 igualmente.
//   - este serviço: o que é ESPECÍFICO do pedido — as 8 etapas de RN-EXP-010,
//     o estado do pedido correspondente a cada uma e o evento de domínio
//     `expedicao.etapa_concluida` (§4.9), cujo payload ("pedido, etapa, nº
//     ordem") só faz sentido aqui.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import {
  OUTBOUND_FLOW_ENTITY,
  OUTBOUND_FLOW_STEPS,
  OUTBOUND_FLOW_TYPE,
  OutboundFlowStep,
  STEP_COMPLETION_STATUS,
  STEP_DISPLAY_LABEL,
  deriveDisplayStatus,
} from './outbound-flow.util.js';

@Injectable()
export class OutboundFlowService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste (padrão de toda a base).
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService
  ) {}

  /** RN-EXP-010: instancia as 8 etapas fixas, na ordem, todas PENDING. */
  async createFlowForOrder(client: PoolClient, input: { tenantId: string; warehouseId: string; orderId: string }, actorUserId: string) {
    return this.operationFlowService.createFlow(
      client,
      {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        entity: OUTBOUND_FLOW_ENTITY,
        entityId: input.orderId,
        flowType: OUTBOUND_FLOW_TYPE,
        stepCodes: [...OUTBOUND_FLOW_STEPS],
      },
      actorUserId
    );
  }

  /**
   * RN-EXP-011 — contrato ÚNICO que o painel (DOC-10) consumirá, com o
   * estado do pedido junto: as 6 regras de navegação precisam das duas
   * coisas (etapa + pedido) para renderizar, e devolvê-las separadas
   * obrigaria o cliente a correlacionar.
   */
  async getOrderFlowState(orderId: string, tenantId: string, actorUserId: string) {
    const orderResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId },
      `SELECT id, number, status, reservation_expired FROM wms.outbound_order WHERE id = $1`,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) throw new NotFoundException(`outbound_order ${orderId} not found`);

    const state = await this.operationFlowService.getFlowState(tenantId, actorUserId, OUTBOUND_FLOW_ENTITY, orderId);

    return {
      order: {
        id: order.id,
        number: order.number,
        // §5.1: RELEASED_EXPIRED é substado derivado, nunca persistido.
        status: deriveDisplayStatus(order.status, order.reservation_expired),
        persisted_status: order.status,
      },
      flow_status: state.flow.status,
      steps: state.steps.map((step: any) => ({
        ...step,
        // Rótulo de exibição do §4.2 e o estado que o pedido assume ao
        // concluir — o painel mostra ambos sem re-derivar a tabela normativa.
        label: STEP_DISPLAY_LABEL[step.step_code as OutboundFlowStep] ?? step.step_code,
        completion_status: STEP_COMPLETION_STATUS[step.step_code as OutboundFlowStep] ?? null,
      })),
    };
  }

  /**
   * Conclui uma etapa do pedido: delega a GUARDA a RG-002/RN-EXP-011
   * (ordem + exceção bloqueante, no core), aplica o estado correspondente do
   * pedido (RN-EXP-010) e publica `expedicao.etapa_concluida` (§4.9, regra 6).
   *
   * Ponto ÚNICO de conclusão de etapa do pedido: qualquer caminho que conclua
   * etapa passa por aqui, para que o evento nunca dependa de o chamador
   * lembrar de publicá-lo.
   */
  async completeOrderStep(
    client: PoolClient,
    input: { tenantId: string; warehouseId: string; orderId: string; step: OutboundFlowStep },
    actorUserId: string
  ) {
    const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = $1 AND entity_id = $2`, [OUTBOUND_FLOW_ENTITY, input.orderId]);
    const flow = flowResult.rows[0];
    if (!flow) throw new NotFoundException(`operation_flow for outbound_order ${input.orderId} not found`);

    // Guarda de ordem (FLOW_STEP_ORDER_VIOLATION) e de exceção bloqueante
    // (STEP_BLOCKED_BY_EXCEPTION) vivem no core — nenhum caminho as contorna.
    const completedStep = await this.operationFlowService.completeStep(client, flow.id, input.step, actorUserId);

    // RN-EXP-010: estado do pedido ao concluir a etapa.
    const newStatus = STEP_COMPLETION_STATUS[input.step];
    const updatedOrder = await client.query(
      `UPDATE wms.outbound_order SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
      [input.orderId, newStatus, actorUserId]
    );

    // §4.9 / RN-EXP-011 regra 6: "a conclusão de cada etapa publica evento e
    // atualiza o painel em ≤ 2 s" — via outbox -> fanout já existente
    // (RNF-ARQ-088), nunca chamando o gateway direto.
    await this.eventsService.publishInTransaction(client, {
      event_type: 'expedicao.etapa_concluida',
      tenant_id: input.tenantId,
      warehouse_id: input.warehouseId,
      actor_user_id: actorUserId,
      payload: {
        outbound_order_id: input.orderId,
        etapa: input.step,
        sequence_order: completedStep.sequence_order,
        order_status: newStatus,
      },
    });

    return { step: completedStep, order: updatedOrder.rows[0] };
  }

  /** Conveniência para chamadores sem transação aberta (rotas HTTP). */
  async completeOrderStepStandalone(input: { tenantId: string; warehouseId: string; orderId: string; step: OutboundFlowStep }, actorUserId: string) {
    return this.db.transaction(
      { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId },
      (client) => this.completeOrderStep(client, input, actorUserId)
    );
  }

  /**
   * RN-EXP-070 — o estorno devolve o fluxo à etapa anterior: a etapa
   * estornada volta a PENDING e o pedido retorna ao estado da etapa anterior.
   * Os EFEITOS de cada etapa são desfeitos por quem os criou
   * (OutboundReversalService); aqui é só a máquina do fluxo.
   */
  async revertStep(
    client: PoolClient,
    input: { tenantId: string; warehouseId: string; orderId: string; step: OutboundFlowStep; previousStatus: string },
    actorUserId: string
  ) {
    const flowResult = await client.query(`SELECT id FROM wms.operation_flow WHERE entity = $1 AND entity_id = $2`, [OUTBOUND_FLOW_ENTITY, input.orderId]);
    const flow = flowResult.rows[0];
    if (!flow) throw new NotFoundException(`operation_flow for outbound_order ${input.orderId} not found`);

    await client.query(
      `UPDATE wms.flow_step SET status = 'PENDING', completed_at = NULL, updated_at = now(), updated_by = $3
       WHERE operation_flow_id = $1 AND step_code = $2`,
      [flow.id, input.step, actorUserId]
    );

    // O fluxo pode ter sido marcado COMPLETED quando a última etapa concluiu.
    await client.query(`UPDATE wms.operation_flow SET status = 'IN_PROGRESS', updated_at = now(), updated_by = $2 WHERE id = $1 AND status = 'COMPLETED'`, [
      flow.id,
      actorUserId,
    ]);

    const updatedOrder = await client.query(
      `UPDATE wms.outbound_order SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
      [input.orderId, input.previousStatus, actorUserId]
    );

    return updatedOrder.rows[0];
  }
}
