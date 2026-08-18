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

  /**
   * RG-002 / DOC-06 RN-EXP-011 — CONTRATO ÚNICO de leitura do fluxo, que o
   * painel do DOC-10 consumirá. Devolve, por etapa, tudo que as 6 regras de
   * navegação exigem para renderizar sem que o cliente precise re-derivar
   * nada:
   *   - `status` DONE/PENDING            → regra 1 (verde/vermelho)
   *   - `is_actionable`                  → regra 2 (única etapa acionável)
   *   - `opens_read_only`                → regra 4 (DONE abre em consulta)
   *   - `is_blocked` + `blocking_exception` → regra 5 (exceção pendente)
   *
   * A regra 3 (violação de ordem) não é um campo: é o erro
   * FLOW_STEP_ORDER_VIOLATION que completeStep() lança — a guarda vive no
   * SERVIÇO, para que nenhum caminho de API a contorne.
   */
  async getFlowState(tenantId: string, actorUserId: string, entity: string, entityId: string) {
    const flowResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId },
      `SELECT * FROM wms.operation_flow WHERE entity = $1 AND entity_id = $2`,
      [entity, entityId]
    );
    if (flowResult.rows.length === 0) throw new NotFoundException(`operation_flow for ${entity}/${entityId} not found`);
    const flow = flowResult.rows[0];

    // A exceção bloqueante é lida junto: sem ela não há como distinguir
    // "vermelha porque ainda não chegou a vez" de "vermelha porque está
    // bloqueada" (regra 5), e o painel precisa das duas.
    const stepsResult = await this.db.query(
      { tenant_id: tenantId, user_id: actorUserId },
      `SELECT fs.*, oe.status AS exception_status, oe.exception_type
       FROM wms.flow_step fs
       LEFT JOIN wms.operational_exception oe ON oe.id = fs.blocking_exception_id
       WHERE fs.operation_flow_id = $1
       ORDER BY fs.sequence_order ASC`,
      [flow.id]
    );

    let actionableAssigned = false;
    const steps = stepsResult.rows.map((step: any) => {
      const isBlocked = step.blocking_exception_id !== null && ['PENDING', 'ESCALATED'].includes(step.exception_status);
      const isDone = step.status === 'DONE';

      // Regra 2: a única acionável é a PRIMEIRA pendente. Regra 5: se essa
      // primeira pendente está bloqueada por exceção, ela NÃO é acionável —
      // permanece vermelha com indicador — e nenhuma posterior assume o
      // lugar dela (o fluxo trava ali, que é o efeito suspensivo RN-SEG-042).
      let isActionable = false;
      if (!isDone && !actionableAssigned) {
        actionableAssigned = true;
        isActionable = !isBlocked;
      }

      return {
        step_code: step.step_code,
        sequence_order: step.sequence_order,
        status: step.status,
        started_at: step.started_at,
        completed_at: step.completed_at,
        is_actionable: isActionable,
        opens_read_only: isDone,
        is_blocked: isBlocked,
        blocking_exception: isBlocked ? { id: step.blocking_exception_id, type: step.exception_type, status: step.exception_status } : null,
      };
    });

    return { flow, steps };
  }

  /**
   * RN-EXP-011 regra 5 / RN-SEG-042 — vincula a exceção que bloqueia a etapa.
   * Enquanto ela estiver PENDING/ESCALATED, a etapa fica vermelha com
   * indicador e completeStep() a recusa.
   */
  async linkBlockingException(client: PoolClient, flowId: string, stepCode: string, exceptionId: string, actorUserId: string) {
    const result = await client.query(
      `UPDATE wms.flow_step SET blocking_exception_id = $3, updated_at = now(), updated_by = $4
       WHERE operation_flow_id = $1 AND step_code = $2 RETURNING *`,
      [flowId, stepCode, exceptionId, actorUserId]
    );
    if (result.rows.length === 0) throw new NotFoundException(`flow_step ${stepCode} not found in flow ${flowId}`);
    return result.rows[0];
  }

  /** Desvincula a exceção (decidida): a etapa volta a poder concluir. */
  async clearBlockingException(client: PoolClient, flowId: string, stepCode: string, actorUserId: string) {
    const result = await client.query(
      `UPDATE wms.flow_step SET blocking_exception_id = NULL, updated_at = now(), updated_by = $3
       WHERE operation_flow_id = $1 AND step_code = $2 RETURNING *`,
      [flowId, stepCode, actorUserId]
    );
    return result.rows[0] ?? null;
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

    // DOC-06 RN-EXP-011 regra 5 / DOC-12 RN-SEG-042 (efeito suspensivo):
    // etapa com exceção PENDING/ESCALATED vinculada permanece vermelha e NÃO
    // conclui. A guarda vive aqui, junto da guarda de ordem, para que nenhum
    // caminho de API a contorne.
    if (current.blocking_exception_id !== null) {
      const exceptionResult = await client.query(`SELECT status, exception_type FROM wms.operational_exception WHERE id = $1`, [current.blocking_exception_id]);
      const blocking = exceptionResult.rows[0];
      if (blocking && ['PENDING', 'ESCALATED'].includes(blocking.status)) {
        throw new BadRequestException({
          error: 'STEP_BLOCKED_BY_EXCEPTION',
          detail:
            `RN-EXP-011 (regra 5) / RN-SEG-042: a etapa "${stepCode}" está bloqueada pela exceção ` +
            `${blocking.exception_type} (status ${blocking.status}) — decida a exceção antes de concluir a etapa`,
        });
      }
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
