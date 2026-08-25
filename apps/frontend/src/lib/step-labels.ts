// Rótulos de exibição por etapa do Fluxo Operacional (FlowTrail espera um
// dicionário do CHAMADOR — RF-PAI-005 — o contrato genérico
// GET /fluxo-operacional/:entity/:entityId só devolve o step_code). Os
// valores aqui são copiados das tabelas normativas que já existem no
// backend (não inventados): OUTBOUND_FLOW_STEPS/STEP_DISPLAY_LABEL em
// apps/backend/.../expedicao/order/outbound-flow.util.ts (DOC-06 §4.2,
// RN-EXP-010), RECEIVING_FLOW_STEPS em
// apps/backend/.../recebimento/inbound-order/inbound-order.service.ts
// (DOC-04), e RETURN_FLOW_STEPS em
// apps/backend/.../reversa/return-order/return-order.service.ts (DOC-07,
// desde a Sessão 9A — reversa já abre operation_flow; transferência
// inter-armazém e inventário ainda não têm etapas fixas, ver
// operations-board.service.ts). O fallback humaniza o step_code cru em vez
// de inventar um rótulo.
const OUTBOUND_ORDER_LABELS: Record<string, string> = {
  PEDIDO: 'Pedido',
  PICKING: 'Picking',
  EMBALAGEM: 'Embalagem',
  PESAGEM: 'Pesagem',
  EXPEDICAO: 'Expedição',
  CARREGAMENTO: 'Carregamento',
  SAIDA: 'Saída',
  FIM: 'Fim',
};

const INBOUND_ORDER_LABELS: Record<string, string> = {
  CHEGADA: 'Chegada',
  DOCA: 'Doca',
  DESCARGA: 'Descarga',
  CONFERENCIA: 'Conferência',
  ETIQUETAGEM: 'Etiquetagem',
  PUTAWAY: 'Putaway',
  FIM: 'Fim',
};

const RETURN_ORDER_LABELS: Record<string, string> = {
  CHEGADA: 'Chegada',
  DOCA: 'Doca',
  DESCARGA: 'Descarga',
  TRIAGEM: 'Triagem',
  DESTINACAO: 'Destinação',
  FIM: 'Fim',
};

const LABELS_BY_ENTITY: Record<string, Record<string, string>> = {
  outbound_order: OUTBOUND_ORDER_LABELS,
  inbound_order: INBOUND_ORDER_LABELS,
  return_order: RETURN_ORDER_LABELS,
};

/** Entidade sem dicionário próprio: FlowTrail cai para o step_code cru (mesmo comportamento do fallback `?? step.step_code`). */
export function getStepLabels(entity: string): Record<string, string> {
  return LABELS_BY_ENTITY[entity] ?? {};
}
