// DOC-00 §4.5 (glossário) + RG-002 [INVIOLÁVEL] — Fluxo Operacional
// genérico. Primeira implementação real (DOC-03/vehicle_visit usou uma
// máquina de estados própria e mais simples; aqui o conceito canônico
// operation_flow/flow_step é implementado pela primeira vez, reutilizável
// por outros módulos operacionais quando existirem).
//
// RG-002: "a única etapa clicável é a primeira pendente"; "É PROIBIDO
// pular etapas por qualquer meio (interface, API ou importação)" — todo
// completeStep() valida que o step_code informado é EXATAMENTE a primeira
// etapa PENDING (menor sequence_order); qualquer outro valor rejeita com
// FLOW_STEP_ORDER_VIOLATION, mesmo vindo de uma chamada de API direta.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';

export interface CreateFlowInput {
  tenantId: string;
  warehouseId: string;
  entity: string;
  entityId: string;
  flowType: string;
  stepCodes: string[];
}

const SEQUENCE_STEP_GAP = 100;

@Injectable()
export class OperationFlowService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** Cria o fluxo + as etapas iniciais, todas PENDING, dentro da transação do chamador. */
  async createFlow(client: PoolClient, input: CreateFlowInput, actorUserId: string) {
    const flowResult = await client.query(
      `INSERT INTO wms.operation_flow (tenant_id, warehouse_id, entity, entity_id, flow_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.tenantId, input.warehouseId, input.entity, input.entityId, input.flowType, actorUserId]
    );
    const flow = flowResult.rows[0];

    const steps = [];
    for (let i = 0; i < input.stepCodes.length; i++) {
      const result = await client.query(
        `INSERT INTO wms.flow_step (tenant_id, operation_flow_id, step_code, sequence_order, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [input.tenantId, flow.id, input.stepCodes[i], (i + 1) * SEQUENCE_STEP_GAP, actorUserId]
      );
      steps.push(result.rows[0]);
    }

    return { flow, steps };
  }

  async getFlowByEntity(tenantId: string, actorUserId: string, entity: string, entityId: string) {
    const flowResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId },
      `SELECT * FROM wms.operation_flow WHERE entity = $1 AND entity_id = $2`,
      [entity, entityId]
    );
    if (flowResult.rows.length === 0) throw new NotFoundException(`operation_flow for ${entity}/${entityId} not found`);
    const flow = flowResult.rows[0];

    const stepsResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId },
      `SELECT * FROM wms.flow_step WHERE operation_flow_id = $1 ORDER BY sequence_order ASC`,
      [flow.id]
    );

    return { flow, steps: this.annotateCurrentStep(stepsResult.rows) };
  }

  /** RG-002: marca DONE/PENDENTE (verde/vermelho) e sinaliza qual é a única etapa clicável. */
  private annotateCurrentStep(steps: any[]) {
    let currentAssigned = false;
    return steps.map((step) => {
      if (step.status === 'DONE') return { ...step, is_current: false };
      if (!currentAssigned) {
        currentAssigned = true;
        return { ...step, is_current: true };
      }
      return { ...step, is_current: false };
    });
  }

  /**
   * "Divergências" (RF-REC-020) intercalada dinamicamente entre duas
   * etapas existentes. Insere no ponto médio de sequence_order — o gap de
   * 100 entre etapas fixas garante espaço para 1 inserção dinâmica sem
   * precisar renumerar as demais.
   */
  async insertDynamicStep(client: PoolClient, flowId: string, tenantId: string, newStepCode: string, afterStepCode: string, actorUserId: string) {
    const afterResult = await client.query(
      `SELECT * FROM wms.flow_step WHERE operation_flow_id = $1 AND step_code = $2`,
      [flowId, afterStepCode]
    );
    if (afterResult.rows.length === 0) {
      throw new NotFoundException(`flow_step ${afterStepCode} not found in flow ${flowId}`);
    }
    const after = afterResult.rows[0];

    const existing = await client.query(
      `SELECT id FROM wms.flow_step WHERE operation_flow_id = $1 AND step_code = $2`,
      [flowId, newStepCode]
    );
    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const nextResult = await client.query(
      `SELECT sequence_order FROM wms.flow_step WHERE operation_flow_id = $1 AND sequence_order > $2 ORDER BY sequence_order ASC LIMIT 1`,
      [flowId, after.sequence_order]
    );
    const nextOrder = nextResult.rows[0]?.sequence_order ?? after.sequence_order + SEQUENCE_STEP_GAP;
    const newOrder = Math.floor((after.sequence_order + nextOrder) / 2);
    if (newOrder <= after.sequence_order || newOrder >= nextOrder) {
      throw new BadRequestException('operation_flow: no room left to insert dynamic step (should not happen with a single dynamic insertion)');
    }

    const result = await client.query(
      `INSERT INTO wms.flow_step (tenant_id, operation_flow_id, step_code, sequence_order, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, flowId, newStepCode, newOrder, actorUserId]
    );
    return result.rows[0];
  }

  /**
   * RG-002 [INVIOLÁVEL]: só a primeira etapa PENDING (menor sequence_order)
   * pode ser concluída. Qualquer outro step_code -> FLOW_STEP_ORDER_VIOLATION,
   * inclusive se vier direto de uma chamada de API (não só da UI).
   */
  async completeStep(client: PoolClient, flowId: string, stepCode: string, actorUserId: string) {
    const currentResult = await client.query(
      `SELECT * FROM wms.flow_step WHERE operation_flow_id = $1 AND status = 'PENDING' ORDER BY sequence_order ASC LIMIT 1`,
      [flowId]
    );
    if (currentResult.rows.length === 0) {
      throw new BadRequestException({ error: 'FLOW_STEP_ORDER_VIOLATION', detail: `RG-002: fluxo ${flowId} não tem etapa pendente` });
    }
    const current = currentResult.rows[0];
    if (current.step_code !== stepCode) {
      throw new BadRequestException({
        error: 'FLOW_STEP_ORDER_VIOLATION',
        detail: `RG-002: a próxima etapa pendente é "${current.step_code}", não "${stepCode}" — é PROIBIDO pular etapas`,
      });
    }

    const result = await client.query(
      `UPDATE wms.flow_step SET status = 'DONE', completed_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [current.id, actorUserId]
    );

    const remaining = await client.query(
      `SELECT COUNT(*) AS count FROM wms.flow_step WHERE operation_flow_id = $1 AND status = 'PENDING'`,
      [flowId]
    );
    if (Number(remaining.rows[0].count) === 0) {
      await client.query(`UPDATE wms.operation_flow SET status = 'COMPLETED', updated_at = now(), updated_by = $2 WHERE id = $1`, [flowId, actorUserId]);
    }

    return result.rows[0];
  }

  async cancelFlow(client: PoolClient, flowId: string, actorUserId: string) {
    await client.query(`UPDATE wms.operation_flow SET status = 'CANCELLED', updated_at = now(), updated_by = $2 WHERE id = $1`, [flowId, actorUserId]);
  }
}
