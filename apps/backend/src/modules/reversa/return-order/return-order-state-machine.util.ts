// DOC-07 §5.1 — máquina de estados de return_order. Tabela de transições
// EXATA do diagrama — mesmo padrão de
// portaria/vehicle-visit/vehicle-visit-state-machine.util.ts: transição não
// prevista é rejeitada com erro determinístico, nunca setStatus() livre.
export type ReturnOrderStatus =
  | 'REQUESTED'
  | 'AUTHORIZED'
  | 'IN_RECEIPT'
  | 'IN_TRIAGE'
  | 'IN_DISPOSITION'
  | 'COMPLETED'
  | 'DENIED'
  | 'CANCELLED';

export type ReturnOrderEvent =
  | 'AUTORIZAR'
  | 'NEGAR'
  | 'CANCELAR'
  | 'CHEGADA_VINCULADA'
  | 'DESCARGA_CONCLUIDA'
  | 'TRIAGEM_COMPLETA'
  | 'DESTINACOES_EFETIVADAS';

export class InvalidReturnOrderTransitionError extends Error {
  constructor(
    public readonly from: ReturnOrderStatus,
    public readonly event: ReturnOrderEvent
  ) {
    super(`DOC-07 §5.1: transição não prevista no diagrama — não existe (${from}, ${event}) na máquina de estados de return_order`);
  }
}

const TRANSITIONS: Record<string, ReturnOrderStatus> = {
  'REQUESTED:AUTORIZAR': 'AUTHORIZED',
  'REQUESTED:NEGAR': 'DENIED',
  'AUTHORIZED:CANCELAR': 'CANCELLED',
  'AUTHORIZED:CHEGADA_VINCULADA': 'IN_RECEIPT',
  'IN_RECEIPT:DESCARGA_CONCLUIDA': 'IN_TRIAGE',
  'IN_TRIAGE:TRIAGEM_COMPLETA': 'IN_DISPOSITION',
  'IN_DISPOSITION:DESTINACOES_EFETIVADAS': 'COMPLETED',
};

/** Resolve a transição (origem, evento) -> destino, ou lança erro determinístico se não prevista. */
export function resolveReturnOrderTransition(from: ReturnOrderStatus, event: ReturnOrderEvent): ReturnOrderStatus {
  const key = `${from}:${event}`;
  const to = TRANSITIONS[key];
  if (!to) {
    throw new InvalidReturnOrderTransitionError(from, event);
  }
  return to;
}
