// DOC-06 §4.2 RN-EXP-010 [INVIOLÁVEL] — as 8 etapas fixas do Fluxo
// Operacional do pedido, na ORDEM do documento, com a condição exata de
// conclusão e o estado correspondente do pedido.
//
// Lógica PURA (sem I/O), no mesmo espírito de putaway-filters.util.ts (4B) e
// stock-selection.util.ts (5B): a tabela normativa vive isolada, auditável e
// testável linha a linha, sem depender de banco. É a RG-002 — o requisito que
// originou o projeto — então a ordem é parte da regra, não configuração.

/** Etapas do §4.2, na ordem EXATA da tabela RN-EXP-010. */
export const OUTBOUND_FLOW_STEPS = ['PEDIDO', 'PICKING', 'EMBALAGEM', 'PESAGEM', 'EXPEDICAO', 'CARREGAMENTO', 'SAIDA', 'FIM'] as const;
export type OutboundFlowStep = (typeof OUTBOUND_FLOW_STEPS)[number];

/** `flow_type` de wms.operation_flow para pedidos de saída. */
export const OUTBOUND_FLOW_TYPE = 'OUTBOUND_ORDER';
/** `entity` de wms.operation_flow para pedidos de saída. */
export const OUTBOUND_FLOW_ENTITY = 'outbound_order';

/**
 * Estados canônicos do pedido (§5.1, diagrama). REG-GLO-004 [INVIOLÁVEL]:
 * "a IA geradora NÃO PODE criar estados ausentes" — esta lista é exatamente
 * a do diagrama, nada além.
 *
 * `RELEASED_EXPIRED` NÃO está aqui de propósito: o §5.1 diz que ele é
 * "substado de RELEASED exibido como alerta", e não aparece no diagrama.
 * Persistido como (status='RELEASED', reservation_expired=true) e exposto
 * como estado DERIVADO — ver deriveDisplayStatus() abaixo.
 */
export const OUTBOUND_ORDER_STATUSES = [
  'DRAFT',
  'RELEASED',
  'IN_PICKING',
  'PICKED',
  'IN_PACKING',
  'PACKED',
  'WEIGHED',
  'IN_DISPATCH',
  'IN_LOADING',
  'LOADED',
  'GATE_OUT',
  'COMPLETED',
  'CANCELLED',
] as const;
export type OutboundOrderStatus = (typeof OUTBOUND_ORDER_STATUSES)[number];

/**
 * RN-EXP-010 — "Estado do pedido ao concluir" de cada etapa (última coluna
 * da tabela §4.2).
 *
 * [LACUNA: a linha 5 da tabela diz "`IN_DISPATCH` concluída = `DISPATCH_OK`",
 * mas `DISPATCH_OK` não existe no diagrama de estados do §5.1 nem no
 * glossário. REG-GLO-004 proíbe criar o estado. Adotado `IN_DISPATCH` como
 * o estado do pedido ao concluir a etapa Expedição — que é o que o diagrama
 * comporta; a distinção "concluída" já está representada pela própria etapa
 * EXPEDICAO estar DONE no fluxo.]
 */
export const STEP_COMPLETION_STATUS: Record<OutboundFlowStep, OutboundOrderStatus> = {
  PEDIDO: 'RELEASED',
  PICKING: 'PICKED',
  EMBALAGEM: 'PACKED',
  PESAGEM: 'WEIGHED',
  EXPEDICAO: 'IN_DISPATCH',
  CARREGAMENTO: 'LOADED',
  SAIDA: 'GATE_OUT',
  FIM: 'COMPLETED',
};

/** Rótulo de exibição de cada etapa (coluna "Etapa (exibição)" do §4.2). */
export const STEP_DISPLAY_LABEL: Record<OutboundFlowStep, string> = {
  PEDIDO: 'Pedido',
  PICKING: 'Picking',
  EMBALAGEM: 'Embalagem',
  PESAGEM: 'Pesagem',
  EXPEDICAO: 'Expedição',
  CARREGAMENTO: 'Carregamento',
  SAIDA: 'Saída',
  FIM: 'Fim',
};

/**
 * §5.1 — `RELEASED_EXPIRED` é substado de `RELEASED`. Derivado na leitura,
 * nunca persistido: o banco guarda o estado canônico do diagrama e a flag.
 */
export function deriveDisplayStatus(status: string, reservationExpired: boolean): string {
  return status === 'RELEASED' && reservationExpired ? 'RELEASED_EXPIRED' : status;
}

/**
 * RN-EXP-070 [INVIOLÁVEL] — estorno devolve o fluxo à etapa ANTERIOR.
 * Mapa etapa → exceção exigida (tabela §4.8). `null` = não exige exceção.
 *
 * A etapa `PEDIDO` não aparece na tabela do §4.8: estornar a liberação
 * (desfazer a reserva) é o caso que o §4.8 não tabela porque a RN-EXP-071
 * já o cobre pelo cancelamento em `RELEASED`. Implementado nesta sessão como
 * estorno sem exceção exigida — é o único cujo efeito (liberar reserva) é
 * integralmente reversível sem movimento físico.
 */
export const STEP_REVERSAL_EXCEPTION: Record<OutboundFlowStep, string | null> = {
  PEDIDO: null,
  PICKING: 'EXP.ESTORNO_PICKING',
  EMBALAGEM: 'EXP.ESTORNO_PICKING',
  PESAGEM: null, // §4.8: "não exige exceção"
  EXPEDICAO: 'EXP.ESTORNO_POS_FISCAL',
  CARREGAMENTO: 'EXP.ESTORNO_POS_FISCAL',
  SAIDA: null, // nunca alcançável: estorno após gate-out é PROIBIDO (ver isReversalForbidden)
  FIM: null, // idem
};

/**
 * RN-EXP-070: "Estorno após gate-out é PROIBIDO — o retorno de mercadoria
 * expedida é Logística Reversa (DOC-07)". Vale para as etapas SAIDA e FIM e
 * para qualquer pedido que já esteja em GATE_OUT/COMPLETED.
 */
export function isReversalForbidden(step: OutboundFlowStep, orderStatus: string): boolean {
  return step === 'SAIDA' || step === 'FIM' || orderStatus === 'GATE_OUT' || orderStatus === 'COMPLETED';
}

/** Etapa imediatamente anterior (o estorno devolve o fluxo a ela). */
export function previousStep(step: OutboundFlowStep): OutboundFlowStep | null {
  const index = OUTBOUND_FLOW_STEPS.indexOf(step);
  return index <= 0 ? null : OUTBOUND_FLOW_STEPS[index - 1];
}

/**
 * RN-EXP-071 — janelas de cancelamento:
 *  - `DRAFT`/`RELEASED` (sem picking iniciado): direto, com EXP.PEDIDO_CANCELAR;
 *  - do picking iniciado até ANTES da emissão fiscal: exige
 *    EXP.CANCELAMENTO_TARDIO (2 passos) + estornos em cascata;
 *  - após emissão fiscal (IN_DISPATCH em diante): só via estorno pós-fiscal;
 *  - após gate-out: PROIBIDO (DOC-07).
 */
export type CancellationWindow = 'DIRECT' | 'LATE_REQUIRES_EXCEPTION' | 'POST_FISCAL_REQUIRES_REVERSAL' | 'FORBIDDEN';

export function cancellationWindow(orderStatus: string): CancellationWindow {
  if (orderStatus === 'DRAFT' || orderStatus === 'RELEASED') return 'DIRECT';
  if (['IN_PICKING', 'PICKED', 'IN_PACKING', 'PACKED', 'WEIGHED'].includes(orderStatus)) return 'LATE_REQUIRES_EXCEPTION';
  if (['IN_DISPATCH', 'IN_LOADING', 'LOADED'].includes(orderStatus)) return 'POST_FISCAL_REQUIRES_REVERSAL';
  // GATE_OUT, COMPLETED, CANCELLED
  return 'FORBIDDEN';
}
