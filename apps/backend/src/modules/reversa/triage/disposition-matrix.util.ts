// DOC-07 RN-REV-021 [INVIOLÁVEL] — matriz de destinação da Triagem. Função
// pura: nenhuma I/O, todo dado de entrada já resolvido pelo chamador
// (elegibilidade de shelf life via stock-selection.util.ts::meetsMinimumShelfLife,
// espécie MEDICAMENTO via join product/product_species).
export type PhysicalState = 'INTEGRO' | 'EMBALAGEM_VIOLADA' | 'DANIFICADO' | 'VENCIDO';
export type Disposition = 'REINTEGRAR' | 'AVARIA' | 'QUARENTENA' | 'DESCARTE' | 'RETORNO_CLIENTE';

export interface SuggestDispositionInput {
  physicalState: PhysicalState;
  /** RN-EST-012, já resolvido pelo chamador — só relevante quando physicalState === 'INTEGRO'. */
  meetsMinimumShelfLife: boolean;
  /** RN-REV-021: espécie MEDICAMENTO reintegra SEMPRE via QUARENTENA, independente do estado. */
  isMedicamento: boolean;
}

/**
 * Tabela EXATA de DOC-07 §4.3 RN-REV-021:
 *   Íntegro + dentro do shelf life mínimo -> REINTEGRAR (QUARENTENA se MEDICAMENTO)
 *   Íntegro + abaixo do mínimo, não vencido -> QUARENTENA
 *   Embalagem violada (qualquer validade) -> QUARENTENA
 *   Danificado (qualquer validade) -> AVARIA
 *   Vencido -> DESCARTE
 */
export function suggestDisposition(input: SuggestDispositionInput): Disposition {
  switch (input.physicalState) {
    case 'VENCIDO':
      return 'DESCARTE';
    case 'DANIFICADO':
      return 'AVARIA';
    case 'EMBALAGEM_VIOLADA':
      return 'QUARENTENA';
    case 'INTEGRO':
      if (input.isMedicamento) return 'QUARENTENA';
      return input.meetsMinimumShelfLife ? 'REINTEGRAR' : 'QUARENTENA';
  }
}

/** Ordem de restritividade — usada só para validar override manual (mais restritiva, nunca menos). */
const RESTRICTIVENESS_RANK: Record<Disposition, number> = {
  REINTEGRAR: 0,
  QUARENTENA: 1,
  AVARIA: 2,
  RETORNO_CLIENTE: 2,
  DESCARTE: 3,
};

export class ReintegrationOfExpiredItemDeniedError extends Error {
  constructor() {
    super('DOC-07 RN-REV-021/REV.REINTEGRACAO_VENCIDO: reintegração de item vencido ou fora do shelf life mínimo é PROIBIDA, sem exceção possível');
  }
}

export class LessRestrictiveDispositionOverrideError extends Error {
  constructor(
    public readonly suggested: Disposition,
    public readonly attempted: Disposition
  ) {
    super(
      `DOC-07 RN-REV-021: destinação confirmada (${attempted}) é MENOS restritiva que a sugerida (${suggested}) — só permitido por decisão formal do cliente (clientDecision=true)`
    );
  }
}

export interface ValidateDispositionOverrideInput {
  suggested: Disposition;
  confirmed: Disposition;
  /** Estado físico que originou a sugestão — vencido/abaixo do shelf life mínimo bloqueia REINTEGRAR mesmo com decisão do cliente. */
  physicalState: PhysicalState;
  suggestionMetShelfLife: boolean;
  /** RN-REV-021: "exceto decisão formal do cliente" — bypassa a regra de restritividade, NUNCA o bloqueio absoluto de reintegração vencida. */
  clientDecision?: boolean;
}

/** Valida a confirmação de destinação contra a sugerida. Lança erro determinístico quando a regra [INVIOLÁVEL] é violada. */
export function validateDispositionOverride(input: ValidateDispositionOverrideInput): void {
  const expiredOrBelowMinimum = input.physicalState === 'VENCIDO' || (input.physicalState === 'INTEGRO' && !input.suggestionMetShelfLife);
  if (input.confirmed === 'REINTEGRAR' && expiredOrBelowMinimum) {
    throw new ReintegrationOfExpiredItemDeniedError();
  }
  if (input.clientDecision) return;
  if (RESTRICTIVENESS_RANK[input.confirmed] < RESTRICTIVENESS_RANK[input.suggested]) {
    throw new LessRestrictiveDispositionOverrideError(input.suggested, input.confirmed);
  }
}
