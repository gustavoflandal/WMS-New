// DOC-17 §5 (Parte A) — RF-TEL-001 (contrato único de detalhe), RN-TEL-002
// (modos), RF-TEL-004 (navegação por document_number). Ver
// docs/PROMPT-SESSAO-10A-doc17-detalhe-etapa.md para as decisões.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { OperationFlowService } from '../../../core/operation-flow/operation-flow.service.js';
import { STEP_CONTENT_RESOLVERS } from './step-content.resolvers.js';

export type StepDetailMode = 'CONSULTA' | 'EXECUCAO' | 'PREVISAO' | 'BLOQUEADA';

export interface StepDetailAction {
  action: string;
  permission: string;
}

export interface GetStepDetailInput {
  tenantId: string;
  warehouseId: string;
  entity: string;
  entityId: string;
  stepCode: string;
  /** RF-PAI-020 — Portal do Cliente não vê executantes internos. Sem chamador ainda nesta sessão (DOC-16 não existe). */
  hideExecutors?: boolean;
}

// RN-TEL-011/RF-TEL-013 mapeadas para os step_codes reais dos 3 fluxos hoje
// existentes — "ações disponíveis" é CONSULTIVO (decisão 4 do prompt): a
// guarda de verdade continua no serviço de mutação correspondente.
// ESTORNAR só é oferecido para outbound_order: é a ÚNICA entidade com
// serviço de reversão confirmado (`OutboundReversalService`, DOC-06 6B) —
// oferecer a mesma dica para inbound_order/return_order seria uma promessa
// de UI sem serviço real por trás.
const OUTBOUND_REVERSIBLE_STEPS = new Set(['PICKING', 'EMBALAGEM', 'PESAGEM']);
const EXECUTION_ACTIONS: Record<string, StepDetailAction> = {
  CONFERENCIA: { action: 'REGISTRAR_CONFERENCIA', permission: 'REC.CONFERIR' },
  ETIQUETAGEM: { action: 'FORMAR_PALETE', permission: 'REC.CONFERIR' },
  PUTAWAY: { action: 'REGISTRAR_PUTAWAY', permission: 'REC.EXECUTAR_PUTAWAY' },
  PICKING: { action: 'REGISTRAR_PICKING', permission: 'EXP.PICKING_EXECUTAR' },
  EMBALAGEM: { action: 'REGISTRAR_EMBALAGEM', permission: 'EXP.PACKING_EXECUTAR' },
  PESAGEM: { action: 'REGISTRAR_PESAGEM', permission: 'EXP.PESAGEM_EXECUTAR' },
  EXPEDICAO: { action: 'CONFIRMAR_DOCUMENTOS_FISCAIS', permission: 'EXP.EXPEDICAO_LIBERAR' },
  CARREGAMENTO: { action: 'REGISTRAR_CARREGAMENTO', permission: 'EXP.CARREGAMENTO_EXECUTAR' },
  TRIAGEM: { action: 'REGISTRAR_TRIAGEM', permission: 'REV.TRIAGEM' },
  DESTINACAO: { action: 'CONFIRMAR_DESTINACAO', permission: 'REV.DESTINACAO' },
};

@Injectable()
export class StepDetailService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OperationFlowService) private readonly operationFlowService: OperationFlowService
  ) {}

  async getStepDetail(input: GetStepDetailInput, actorUserId: string) {
    const { flow, steps } = await this.operationFlowService.getFlowState(input.tenantId, actorUserId, input.entity, input.entityId);
    const step = steps.find((s) => s.step_code === input.stepCode);
    if (!step) {
      throw new NotFoundException(`step ${input.stepCode} not found in flow ${input.entity}/${input.entityId}`);
    }

    const mode = this.resolveMode(step);
    const hideExecutors = input.hideExecutors ?? false;
    const ctx = { tenant_id: input.tenantId, user_id: actorUserId, warehouse_id: input.warehouseId };

    const resolver = STEP_CONTENT_RESOLVERS[input.entity]?.[input.stepCode];
    const content = resolver ? await resolver(this.db, ctx, input.entityId, hideExecutors) : {};

    const documentNumber = await this.loadDocumentNumber(ctx, input.entity, input.entityId);

    return {
      entity: input.entity,
      entity_id: input.entityId,
      document_number: documentNumber,
      flow_type: flow.flow_type,
      flow_status: flow.status,
      step_code: step.step_code,
      mode,
      status: step.status,
      started_at: step.started_at,
      completed_at: step.completed_at,
      completed_by: hideExecutors ? null : step.completed_by,
      blocking_exception: step.blocking_exception,
      content,
      actions: this.resolveActions(input.entity, input.stepCode, mode),
    };
  }

  /** RN-TEL-002 — deriva 100% de getFlowState(), nenhuma lógica de ordem/bloqueio duplicada. */
  private resolveMode(step: { opens_read_only: boolean; is_blocked: boolean; is_actionable: boolean }): StepDetailMode {
    if (step.opens_read_only) return 'CONSULTA';
    if (step.is_blocked) return 'BLOQUEADA';
    if (step.is_actionable) return 'EXECUCAO';
    return 'PREVISAO';
  }

  /**
   * RF-TEL-004 (navegação) — mesmo padrão polimórfico de
   * `operations-board.service.ts` (CTE `documents`), mas resolvido por
   * entidade em vez de UNION (aqui já sabemos o tipo exato).
   */
  private async loadDocumentNumber(ctx: { tenant_id: string; user_id: string; warehouse_id?: string }, entity: string, entityId: string): Promise<string | null> {
    const table = entity === 'inbound_order' ? 'wms.inbound_order' : entity === 'outbound_order' ? 'wms.outbound_order' : entity === 'return_order' ? 'wms.return_order' : null;
    if (!table) return null;
    const result = await this.db.query<{ number: string }>(ctx, `SELECT number FROM ${table} WHERE id = $1`, [entityId]);
    return result.rows[0]?.number ?? null;
  }

  /** RN-TEL-002/DOC-17 §2 — lista CONSULTIVA, nunca autoritativa (a guarda real está no serviço de mutação). */
  private resolveActions(entity: string, stepCode: string, mode: StepDetailMode): StepDetailAction[] {
    if (mode === 'EXECUCAO') {
      const action = EXECUTION_ACTIONS[stepCode];
      return action ? [action] : [];
    }
    if (mode === 'CONSULTA' && entity === 'outbound_order' && OUTBOUND_REVERSIBLE_STEPS.has(stepCode)) {
      return [{ action: 'ESTORNAR', permission: 'EXP.ESTORNO' }];
    }
    // PREVISAO: "nenhuma — aviso de etapa anterior pendente" (RN-TEL-002).
    // BLOQUEADA: decidir a exceção é uma ação do módulo de workflow (DOC-12),
    // não deste contrato — o campo `blocking_exception` já expõe o necessário.
    return [];
  }
}
