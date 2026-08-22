// DOC-05 §4.7 RN-EST-062 [INVIOLÁVEL] — Rodadas de contagem. Lógica PURA
// (sem I/O), mesmo espírito de stock-selection.util.ts/putaway-ranking.util.ts:
// o service carrega os dados (rodadas já registradas, saldo do sistema) e
// chama isto para decidir o próximo passo — testável linha a linha contra os
// 2 cenários normativos do DOC-05 §6 sem depender de banco.
//
// Texto exato da regra: "1ª contagem cega (sem exibir saldo do sistema). SE
// 1ª = saldo do sistema -> endereço concluído. SE divergente -> 2ª contagem
// cega por operador DIFERENTE. SE 2ª = sistema -> concluído sem ajuste. SE
// 2ª = 1ª -> divergência confirmada. SE 2ª != 1ª != sistema -> 3ª contagem
// por LIDER_TURNO, cujo resultado prevalece."

export interface CountRound {
  roundNumber: 1 | 2 | 3;
  countedQty: number;
  countedBy: string;
}

export type RoundOutcome =
  | { status: 'AWAITING_ROUND'; nextRound: 1 | 2 | 3; requiresDifferentOperatorThan?: string; requiresRole?: 'LIDER_TURNO' }
  | { status: 'COMPLETED' }
  | { status: 'DIVERGENCE_CONFIRMED'; divergence: number };

/**
 * Decide o próximo passo (ou o desfecho) dado o saldo do sistema e as
 * rodadas JÁ registradas para a célula, na ordem em que ocorreram (1..3).
 * Não valida quem pode contar (permissão/papel) nem grava nada — puramente
 * a árvore de decisão do texto normativo acima.
 */
export function evaluateCountRounds(systemQty: number, rounds: CountRound[]): RoundOutcome {
  if (rounds.length === 0) {
    return { status: 'AWAITING_ROUND', nextRound: 1 };
  }

  if (rounds.length === 1) {
    const [first] = rounds;
    if (first.countedQty === systemQty) {
      return { status: 'COMPLETED' };
    }
    return { status: 'AWAITING_ROUND', nextRound: 2, requiresDifferentOperatorThan: first.countedBy };
  }

  if (rounds.length === 2) {
    const [first, second] = rounds;
    if (second.countedQty === systemQty) {
      return { status: 'COMPLETED' };
    }
    if (second.countedQty === first.countedQty) {
      return { status: 'DIVERGENCE_CONFIRMED', divergence: second.countedQty - systemQty };
    }
    return { status: 'AWAITING_ROUND', nextRound: 3, requiresRole: 'LIDER_TURNO' };
  }

  // 3ª rodada: "cujo resultado prevalece" — decide sozinha, mesmo se bater
  // com a 1ª ou a 2ª (nenhuma delas tem prioridade sobre o resultado final).
  const third = rounds[2];
  const divergence = third.countedQty - systemQty;
  if (divergence === 0) {
    return { status: 'COMPLETED' };
  }
  return { status: 'DIVERGENCE_CONFIRMED', divergence };
}

/**
 * Validações de FORMATO da próxima rodada — número em sequência e (RN-EST-062)
 * operador diferente na 2ª rodada. Não inclui a checagem de papel LIDER_TURNO
 * da 3ª rodada (essa exige consulta a wms.user_role_assignment, I/O — fica no
 * service, mesmo padrão de GESTOR_ARMAZEM em operational-exception.service.ts).
 */
export function assertRoundIsExpected(systemQty: number, rounds: CountRound[], newRoundNumber: number, newCountedBy: string): void {
  const outcome = evaluateCountRounds(systemQty, rounds);
  if (outcome.status !== 'AWAITING_ROUND') {
    throw new Error('CELL_ALREADY_RESOLVED');
  }
  if (outcome.nextRound !== newRoundNumber) {
    throw new Error(`UNEXPECTED_ROUND_NUMBER:${outcome.nextRound}`);
  }
  if (outcome.requiresDifferentOperatorThan && outcome.requiresDifferentOperatorThan === newCountedBy) {
    throw new Error('SAME_OPERATOR_ROUND2');
  }
}
