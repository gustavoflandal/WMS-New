// DOC-03 §5.1 — máquina de estados de vehicle_visit. Tabela de transições
// EXATA do documento (origem, evento, destino) — "Transição não prevista no
// diagrama DEVE ser rejeitada com erro determinístico. não implemente
// setStatus() livre" (instrução da sessão). Nenhum outro caminho é válido.
export type VehicleVisitStatus =
  | 'CHEGADA_REGISTRADA'
  | 'AGUARDANDO_AUTORIZACAO'
  | 'NO_PATIO'
  | 'EM_DESLOCAMENTO_DOCA'
  | 'EM_DOCA'
  | 'LIBERADO_SAIDA'
  | 'ENCERRADA'
  | 'RECUSADO';

export type VehicleVisitEvent =
  | 'BLOQUEIO_AUTORIZACAO' // sem agenda / fora da janela / sem vaga HAZMAT
  | 'GATE_IN_OK' // gate-in OK + vaga alocada
  | 'EXCECAO_APROVADA'
  | 'EXCECAO_REJEITADA_OU_EXPIRADA'
  | 'CHAMADA_CONFIRMADA'
  | 'ATRACACAO_REGISTRADA' // DOC-04, fora de escopo desta sessão — transição exposta, sem chamador ainda
  | 'RETORNO_PATIO'
  | 'OPERACAO_DOCA_CONCLUIDA' // DOC-04/06, idem
  | 'LIBERACAO_SEM_DOCA'
  | 'GATE_OUT';

export class InvalidVehicleVisitTransitionError extends Error {
  constructor(
    public readonly from: VehicleVisitStatus,
    public readonly event: VehicleVisitEvent
  ) {
    super(`DOC-03 §5.1: transição não prevista no diagrama — não existe (${from}, ${event}) na máquina de estados de vehicle_visit`);
  }
}

const TRANSITIONS: Record<string, VehicleVisitStatus> = {
  'CHEGADA_REGISTRADA:BLOQUEIO_AUTORIZACAO': 'AGUARDANDO_AUTORIZACAO',
  'CHEGADA_REGISTRADA:GATE_IN_OK': 'NO_PATIO',
  'AGUARDANDO_AUTORIZACAO:EXCECAO_APROVADA': 'NO_PATIO',
  'AGUARDANDO_AUTORIZACAO:GATE_IN_OK': 'NO_PATIO', // vaga HAZMAT liberada em retry (sem exceção envolvida)
  'AGUARDANDO_AUTORIZACAO:EXCECAO_REJEITADA_OU_EXPIRADA': 'RECUSADO',
  'NO_PATIO:CHAMADA_CONFIRMADA': 'EM_DESLOCAMENTO_DOCA',
  'EM_DESLOCAMENTO_DOCA:ATRACACAO_REGISTRADA': 'EM_DOCA',
  'EM_DOCA:RETORNO_PATIO': 'NO_PATIO',
  'EM_DOCA:OPERACAO_DOCA_CONCLUIDA': 'LIBERADO_SAIDA',
  'NO_PATIO:LIBERACAO_SEM_DOCA': 'LIBERADO_SAIDA',
  'LIBERADO_SAIDA:GATE_OUT': 'ENCERRADA',
};

/** Resolve a transição (origem, evento) -> destino, ou lança erro determinístico se não prevista. */
export function resolveVehicleVisitTransition(from: VehicleVisitStatus, event: VehicleVisitEvent): VehicleVisitStatus {
  const key = `${from}:${event}`;
  const to = TRANSITIONS[key];
  if (!to) {
    throw new InvalidVehicleVisitTransitionError(from, event);
  }
  return to;
}
